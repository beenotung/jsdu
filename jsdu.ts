import { existsSync, lstat, readdir, readdirSync, stat } from 'fs'
import { join } from 'path'

let pkg = require(__dirname + '/package.json')
let name = `jsdu ${pkg.version}`

function show_help() {
  console.log(
    `
${name}

usage: jsdu [options] [dir]

arguments:
  options: optional, details see below
  dir:     optional, default is current directory

options:
  -h | --help:        show help messages
  -l | --follow-link: follow symbolic links
  -n | --no-link:     skip symbolic links
  -i | --interval:    interval of report, default is 1000ms

examples:
  jsdu
  jsdu .
  jsdu --follow-link .
  jsdu --no-link .
  jsdu --help
`.trim(),
  )
}

let dir = '.'
let link = false
let interval = 1000
for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i]
  switch (arg) {
    case '-h':
    case '--help':
      show_help()
      process.exit()
      break
    case '-l':
    case '--follow-link':
      link = true
      break
    case '-n':
    case '--no-link':
      link = false
      break
    case '-i':
    case '--interval':
      i++
      arg = process.argv[i]
      interval = parseInt(arg)
      if (isNaN(interval)) {
        die(`Error: invalid interval: ${arg}`)
      }
      break
    default:
      if (dir !== '.') {
        die(`Error: invalid argument: ${JSON.stringify(arg)}`)
      }
      dir = arg
      if (!existsSync(dir)) {
        die(`Error: directory not found: ${dir}`)
      }
  }
}
let statFn = link ? stat : lstat

if (typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', () => {
    process.stdout.write('\r')
    process.exit()
  })
}

function die(err: string): never {
  console.error(err)
  process.exit(1)
}

/**
 * Copied from @beenotung/tslib/buffered-cli
 * - Print the buffer to cli output stream.
 * - Reset the cursor to the beginning without using `console.clear()` to avoid flickering.
 * - Not accurate, when tab (`\t`) is used without `writeln()` nor newline (`\n`).
 */
class BufferedCli {
  private buffer = ''
  private lastBuffer = ''
  constructor(private out = process.stdout) {}
  write(message: string) {
    this.buffer += message
  }
  writeln(message: string) {
    this.write(message + '\n')
  }
  private render(buffer: string, lastLines: number[]) {
    const columns = this.out.columns
    let x = 0
    let y = 0
    let output = ''
    const lines: number[] = []
    for (const char of buffer) {
      if (char == '\n') {
        // early jump to next line, may need to fill extra spaces
        const lastX = lastLines[y]
        if (lastX > x) {
          output += ' '.repeat(lastX - x)
        }
        output += '\n'
        lines.push(x)
        x = 0
        y++
        continue
      }
      // add new char to the current line
      output += char
      x++
      if (x == columns) {
        // used full line, move to next line
        lines.push(x)
        x = 0
        y++
      }
    }
    lines.push(x)
    return { output, x, y, lines }
  }
  flush() {
    const { out, buffer, lastBuffer } = this

    const last = this.render(lastBuffer, [])
    const current = this.render(buffer, last.lines)

    if (last.y == 0) {
      out.moveCursor(-last.x, 0)
    } else {
      out.moveCursor(0, -last.y)
      out.cursorTo(0)
    }

    let output = current.output
    let extra = 0

    if (!output.endsWith('\n')) {
      const currentTail = getTailLength(output)
      const lastTail = getTailLength(last.output)
      extra = lastTail - currentTail
      if (extra > 0) {
        output += ' '.repeat(extra)
      }
    }

    out.write(output)

    if (extra > 0) {
      out.moveCursor(-extra, 0)
    }

    this.lastBuffer = buffer
    this.buffer = ''
  }
  end() {
    const { out, lastBuffer } = this
    if (!lastBuffer.endsWith('\n')) {
      out.write('\n')
    }
  }
}
function getTailLength(text: string): number {
  const index = text.lastIndexOf('\n')
  if (index === -1) {
    return text.length
  } else {
    return text.length - index - 1
  }
}

let rootFiles = readdirSync(dir).map(filename => {
  let file = dir === '.' ? filename : join(dir, filename)
  return { file, size: 0 }
})

type RootFile = (typeof rootFiles)[number]

let pending = 0
function checkFile(rootFile: RootFile, file: string) {
  pending++
  statFn(file, (err, stat) => {
    pending--
    if (
      err &&
      /* e.g. when scanning '/lost+found' */
      err.code !== 'EACCES' &&
      /* e.g. when scanning '/proc/2275821/fd/21' */
      err.code !== 'ENOENT'
    ) {
      die(String(err))
    }
    if (err) {
      report()
      return
    }
    if (stat.isFile()) {
      rootFile.size += stat.size
      report()
      return
    }
    if (stat.isDirectory()) {
      pending++
      let dir = file
      readdir(dir, (err, filenames) => {
        pending--
        if (
          err &&
          /* e.g. when scanning '/lost+found' */
          err.code !== 'EACCES' &&
          /* e.g. when scanning '/proc/2275821/fd/21' */
          err.code !== 'ENOENT'
        ) {
          die(String(err))
        }
        if (err) {
          report()
          return
        }
        for (let filename of filenames) {
          let file = join(dir, filename)
          checkFile(rootFile, file)
        }
      })
    }
    report()
  })
}

let running = false
let nextReport = 0
let cli = new BufferedCli()

let sizeUnits = ['B', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']

function formatSize(bytes: number): string {
  let threshold = 1024
  for (let i = 0; i < sizeUnits.length; i++) {
    if (bytes < threshold) {
      let size = (bytes / (threshold / 1024)).toFixed(1)
      let unit = sizeUnits[i]
      return size + unit
    }
    threshold *= 1024
  }
  return 'Inf'
}

let minHeading = `== ${name} ==`.length
let stopMessage = `[Press any key to exit]`
let doneMessage = `done.`

function doReport() {
  let { columns, rows } = process.stdout

  if (!running) {
    pending = rootFiles.length
  }

  let maxItemCount =
    pending === 0
      ? rows -
        /* reduce two lines for separators */
        2 -
        /* reduce one line for done message */
        1 -
        /* reduce one line for next cli command */
        1
      : rows -
        /* reduce two lines for separators */
        2 -
        /* reduce one line for pending count */
        1 -
        /* reduce one blank line before stop message */
        1 -
        /* reduce one line for stop message */
        1

  let maxSizeWidth = 0
  let maxFileWidth = 0
  let items = rootFiles
    .sort((a, b) => a.size - b.size)
    .slice(-maxItemCount)
    .map(item => {
      let size = formatSize(item.size)
      maxSizeWidth = Math.max(maxSizeWidth, size.length)

      let file = item.file
      maxFileWidth = Math.max(maxFileWidth, file.length)

      return { size, file }
    })

  let pendingMessage = `pending: ${pending}`

  let maxLineWidth =
    pending === 0
      ? Math.max(
          minHeading,
          1 + maxSizeWidth + 2 + maxFileWidth,
          doneMessage.length,
        )
      : Math.max(
          minHeading,
          1 + maxSizeWidth + 2 + maxFileWidth,
          pendingMessage.length,
          stopMessage.length,
        )
  if (maxLineWidth % 2 == 1) {
    maxLineWidth++
  }
  maxLineWidth = Math.min(maxLineWidth, columns)

  let headingSeparators = maxLineWidth - name.length - 2
  let heading =
    '='.repeat(Math.floor(headingSeparators / 2)) +
    ` ${name} ` +
    '='.repeat(Math.floor(headingSeparators / 2))

  let separator = '='.repeat(maxLineWidth)

  cli.writeln(heading)
  for (let item of items) {
    let { size, file } = item
    let extra = maxSizeWidth - size.length
    if (extra > 0) {
      size = ' '.repeat(extra) + size
    }
    cli.writeln(` ${size}  ${file}`)
  }
  cli.writeln(separator)
  if (pending === 0) {
    cli.writeln(doneMessage)
  } else {
    cli.writeln(pendingMessage)
    cli.writeln('')
    cli.write(stopMessage)
  }
  cli.flush()

  if (!running) {
    pending = 0
  }
}

function report() {
  let now = Date.now()
  let needReport = now >= nextReport
  if (needReport) {
    doReport()
    nextReport = now + interval
  }
  if (running && pending === 0) {
    if (!needReport) {
      doReport()
    }
    process.exit()
  }
}

report()

running = true
rootFiles.forEach(rootFile => {
  checkFile(rootFile, rootFile.file)
})

import { BufferedCli } from '@beenotung/tslib/buffered-cli'
import { existsSync, lstat, readdir, readdirSync, stat } from 'fs'
import { join } from 'path'

let pkg = require('./package.json')
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
    // process.stdout.write('  [aborted]')
    process.exit()
  })
}

function die(err: string): never {
  console.error(err)
  process.exit(1)
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

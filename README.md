# jsdu

like ncdu but show progressive result asap\*

asap\*: as soon as possible

[![npm Package Version](https://img.shields.io/npm/v/jsdu.svg?maxAge=2592000)](https://www.npmjs.com/package/jsdu)

## Installation

```shell
npm i -g jsdu
```

## Usage

```
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
```

## License

[BSD-2-Clause](./LICENSE) (Free Open Source Project)

#!/bin/bash
set -e
set -o pipefail

npx esbuild \
  --bundle \
  --minify-whitespace \
  --platform=node \
  --outfile=jsdu \
  jsdu.ts
echo "#!/usr/bin/env node" > out
cat jsdu >> out
chmod +x out
mv out jsdu

#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';

function readArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '') : '';
}

const entrypointArg = readArg('--entrypoint');
const outfileArg = readArg('--outfile');
const target = readArg('--target');
const external = process.argv
  .slice(2)
  .filter((value) => value.startsWith('--external='))
  .map((value) => value.slice('--external='.length))
  .filter(Boolean);

if (!entrypointArg || !outfileArg || !target) {
  throw new Error('Expected --entrypoint, --outfile, and --target');
}
const entrypoint = resolve(entrypointArg);
const outfile = resolve(outfileArg);

const result = await Bun.build({
  entrypoints: [entrypoint],
  external,
  compile: {
    target,
    outfile,
  },
  plugins: [{
    name: 'load-packaged-sharp-addon',
    setup(build) {
      // Sharp selects its native binding through an opaque computed require.
      // Compiled Bun executables cannot discover that addon, while embedding it
      // extracts the file away from its libvips sidecar. Keep Sharp's public JS
      // implementation bundled and replace only its binding loader so dlopen
      // uses the target-filtered sidecar tree packaged beside the executable.
      build.onLoad(
        { filter: /[/\\]node_modules[/\\]sharp[/\\]lib[/\\]sharp\.js$/ },
        (args) => ({
          contents: `
            const { dirname, join } = require('node:path');
            const { runtimePlatformArch } = require('./libvips');
            const runtimePlatform = runtimePlatformArch();
            const bindingModule = { exports: {} };
            process.dlopen(
              bindingModule,
              join(
                dirname(process.execPath),
                'node_modules',
                '@img',
                'sharp-' + runtimePlatform,
                'lib',
                'sharp-' + runtimePlatform + '.node',
              ),
            );
            module.exports = bindingModule.exports;
          `,
          loader: 'js',
          resolveDir: dirname(args.path),
        }),
      );
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

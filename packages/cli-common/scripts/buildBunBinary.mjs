#!/usr/bin/env bun

import { DEFAULT_BUN_COMPILE_OPTIONS } from '../src/componentArtifacts/commands.ts';

import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    ...DEFAULT_BUN_COMPILE_OPTIONS,
    target,
    outfile,
    ...(process.argv.includes('--no-compile-autoload-dotenv') ? { autoloadDotenv: false }
      : process.argv.includes('--compile-autoload-dotenv') ? { autoloadDotenv: true } : {}),
    ...(process.argv.includes('--no-compile-autoload-bunfig') ? { autoloadBunfig: false }
      : process.argv.includes('--compile-autoload-bunfig') ? { autoloadBunfig: true } : {}),
  },
  plugins: [{
    name: 'load-packaged-ps-list',
    setup(build) {
      // ps-list finds Windows fastlist relative to import.meta.url. Its real
      // package already ships in the payload; a bundled copy points into bunfs.
      build.onResolve({ filter: /^ps-list$/ }, () => ({ path: 'ps-list', namespace: 'ps-list-sidecar' }));
      build.onLoad({ filter: /.*/, namespace: 'ps-list-sidecar' }, () => ({
        contents: `
          import process from 'node:process';
          import { createRequire } from 'node:module';
          import { join } from 'node:path';
          import { pathToFileURL } from 'node:url';
          import { resolveSelfContainedCliRuntimeRootPath } from ${JSON.stringify(fileURLToPath(new URL('../src/firstPartyRuntime/resolveSelfContainedCliRuntimeRoot.ts', import.meta.url)))};
          export default async function psList(options) {
            // POSIX needs only the embedded JS and system ps, including when an
            // installer runs a detached copy without a dependency payload.
            if (process.platform !== 'win32') {
              const { default: list } = await import(${JSON.stringify(createRequire(entrypoint).resolve('ps-list'))});
              return list(options);
            }
            const root = resolveSelfContainedCliRuntimeRootPath();
            if (!root) throw new Error('Expected a self-contained process-discovery runtime');
            const require = createRequire(join(root, 'package.json'));
            const { default: list } = await import(pathToFileURL(require.resolve('ps-list')).href);
            return list(options);
          }
        `,
        loader: 'js',
      }));
    },
  }, {
    name: 'load-packaged-sharp-addon',
    setup(build) {
      // Sharp's public CJS entry uses static native imports. Its ESM entry uses
      // createRequire(import.meta.url), whose compiled Bun referrer is virtual.
      // Keep Sharp's own platform selection, CPU checks and error reporting.
      build.onResolve({ filter: /^sharp$/ }, (args) => ({
        path: createRequire(args.importer).resolve('sharp'),
      }));
      // Sharp's platform shims call require.resolve('@img/sharp-libvips-*/binary')
      // only as a guarded hint. Bun would embed every installed platform's libvips;
      // the selected one already ships as a sidecar beside the executable.
      build.onResolve({ filter: /^@img\/sharp-libvips-[^/]+\/binary$/ }, (args) => {
        if (!/[/\\]node_modules[/\\]@img[/\\]sharp-[^/\\]+[/\\]/.test(args.importer)) return;
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /\.node$/ }, (args) => {
        if (!/[/\\]node_modules[/\\]@img[/\\]sharp-[^/\\]+[/\\]/.test(args.importer)
          || !args.path.startsWith('./lib/')) return;
        const path = resolve(dirname(args.importer), args.path);
        // Bun visits optional foreign-platform imports too. Their addon may
        // not exist; Sharp selects the actual staged addon at runtime.
        return { path, namespace: 'sharp-sidecar' };
      });
      build.onLoad({ filter: /.*/, namespace: 'sharp-sidecar' }, (args) => {
        const nativePackage = args.path.match(/^(.*[/\\]node_modules[/\\]@img[/\\](sharp-[^/\\]+))[/\\]/);
        if (!nativePackage) throw new Error(`Invalid Sharp native addon path: ${args.path}`);
        const segments = ['node_modules', '@img', nativePackage[2], ...relative(nativePackage[1], args.path).split(/[/\\]/)];
        // Load the actual imported addon beside its packaged libvips libraries.
        // Embedded Bun assets are renamed and lose that native library layout.
        return {
          contents: `
            const { dirname, join } = require('node:path');
            const binding = { exports: {} };
            process.dlopen(binding, join(dirname(process.execPath), ...${JSON.stringify(segments)}));
            module.exports = binding.exports;
          `,
          loader: 'js',
        };
      });
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

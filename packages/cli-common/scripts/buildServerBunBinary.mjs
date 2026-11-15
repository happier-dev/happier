#!/usr/bin/env bun

import { DEFAULT_BUN_COMPILE_OPTIONS, resolveBunCompilerCommand } from '../src/componentArtifacts/commands.ts';

import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SOURCE_CONDITION, createWorkspaceSourceResolver, readWorkspacePackages } from '../sourceRuntimeEntries.mjs';

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
const repoRoot = process.cwd();
resolveBunCompilerCommand({ bunCommand: process.execPath });
const workspacePackages = await readWorkspacePackages(repoRoot);
const requireFromProject = createRequire(pathToFileURL(join(repoRoot, 'apps/server/package.json')));

const result = await Bun.build({
  entrypoints: [entrypoint],
  define: { __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify('public-release') },
  conditions: [SOURCE_CONDITION],
  external,
  compile: {
    ...DEFAULT_BUN_COMPILE_OPTIONS,
    target,
    outfile,
    ...(process.argv.includes('--no-compile-autoload-bunfig') ? { autoloadBunfig: false }
      : process.argv.includes('--compile-autoload-bunfig') ? { autoloadBunfig: true } : {}),
  },
  plugins: [createWorkspaceSourceResolver({ workspacePackages, requireFromProject, externalPackages: [] }), {
    name: 'load-packaged-sharp-addon',
    setup(build) {
      // Sharp's public CJS entry uses static native imports. Its ESM entry uses
      // createRequire(import.meta.url), whose compiled Bun referrer is virtual.
      // Keep Sharp's own platform selection, CPU checks and error reporting.
      build.onResolve({ filter: /^sharp$/ }, (args) => ({
        path: createRequire(args.importer).resolve('sharp'),
      }));
      // Sharp's guarded platform hint must not embed every installed libvips.
      // The selected library is already staged beside its native addon.
      build.onResolve({ filter: /^@img\/sharp-libvips-[^/]+\/binary$/ }, (args) => {
        if (!/[/\\]node_modules[/\\]@img[/\\]sharp-[^/\\]+[/\\]/.test(args.importer)) return;
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /\.node$/ }, (args) => {
        if (!/[/\\]node_modules[/\\]@img[/\\]sharp-[^/\\]+[/\\]/.test(args.importer)
          || !args.path.startsWith('./lib/')) return;
        const path = resolve(dirname(args.importer), args.path);
        // Optional foreign-platform addons may be absent at build time.
        // Sharp selects the actual staged binding at runtime.
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

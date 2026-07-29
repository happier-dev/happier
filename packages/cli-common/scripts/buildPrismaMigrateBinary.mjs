#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
  if (!value) throw new Error(`[component-artifacts] missing ${name}`);
  return value;
}

const repoRoot = resolve(readOption('--repo-root'));
const target = readOption('--target');
const outfile = resolve(readOption('--outfile'));
const prismaPackageJsonPath = join(repoRoot, 'node_modules', 'prisma', 'package.json');
const prismaEntrypoint = join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
const proxyStubPath = join(repoRoot, 'node_modules', 'node-fetch-native', 'dist', 'proxy-stub.mjs');
const prismaPackageJson = JSON.parse(await readFile(prismaPackageJsonPath, 'utf8'));

if (prismaPackageJson.version !== '6.19.2') {
  throw new Error(`[component-artifacts] unsupported Prisma CLI bundle version: ${String(prismaPackageJson.version ?? '<missing>')}`);
}

const packageMetadataAnchor = 'eval("require(\'../package.json\')")';
const mainModuleAnchor = 'eval("require.main === module")';
const schemaWasmAnchor = '`${__dirname}/prisma_schema_build_bg.wasm`';
const prismaSource = await readFile(prismaEntrypoint, 'utf8');
if (
  prismaSource.split(packageMetadataAnchor).length !== 2
  || prismaSource.split(mainModuleAnchor).length !== 2
  || prismaSource.split(schemaWasmAnchor).length !== 2
) {
  throw new Error('[component-artifacts] Prisma CLI bundle layout changed; refusing unchecked runtime rewrite');
}
const transformedPrismaSource = prismaSource
  .replace(packageMetadataAnchor, JSON.stringify(prismaPackageJson))
  .replace(mainModuleAnchor, 'true')
  .replace(
    schemaWasmAnchor,
    'require("node:path").join(require("node:path").dirname(process.execPath), "prisma_schema_build_bg.wasm")',
  );

const result = await Bun.build({
  entrypoints: [prismaEntrypoint],
  target: 'bun',
  compile: { target, outfile },
  plugins: [{
    name: 'happier-prisma-runtime-bundle',
    setup(build) {
      build.onResolve({ filter: /^node-fetch-native\/proxy$/ }, () => ({ path: proxyStubPath }));
      build.onLoad({ filter: /node_modules\/prisma\/build\/index\.js$/ }, () => ({
        contents: transformedPrismaSource,
        loader: 'js',
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}

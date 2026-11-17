#!/usr/bin/env bun

import { DEFAULT_BUN_COMPILE_OPTIONS, resolveBunCompilerCommand } from '../src/componentArtifacts/commands.ts';

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
  if (!value) throw new Error(`[component-artifacts] missing ${name}`);
  return value;
}

const repoRoot = resolve(readOption('--repo-root'));
resolveBunCompilerCommand({ repoRoot, bunCommand: process.execPath });
const target = readOption('--target');
const outfile = resolve(readOption('--outfile'));
// The packaged migration tool stays on the Prisma 6.19.2 CLI and its schema engine: the 7.x schema
// engine runs a PostgreSQL migration.sql statement by statement, which breaks migrations that rely on
// one implicit transaction (ON COMMIT DROP temp tables) and loses whole-file atomicity. The server
// owns where that CLI is installed (apps/server/scripts/prismaInstallLayout.mjs).
const { resolveServerPrismaMigrationToolLayout } = await import(
  pathToFileURL(join(repoRoot, 'apps', 'server', 'scripts', 'prismaInstallLayout.mjs')).href
);
const migrationTool = resolveServerPrismaMigrationToolLayout({ serverRoot: join(repoRoot, 'apps', 'server') });
const prismaPackageJsonPath = migrationTool.cliPackageJsonPath;
const prismaEntrypoint = migrationTool.cliEntrypoint;
const proxyStubPath = migrationTool.proxyStubPath;
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
  compile: { ...DEFAULT_BUN_COMPILE_OPTIONS, target, outfile },
  plugins: [{
    name: 'happier-prisma-runtime-bundle',
    setup(build) {
      build.onResolve({ filter: /^node-fetch-native\/proxy$/ }, () => ({ path: proxyStubPath }));
      build.onLoad({ filter: /[/\\]build[/\\]index\.js$/ }, (args) => (
        args.path === prismaEntrypoint ? { contents: transformedPrismaSource, loader: 'js' } : undefined
      ));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}

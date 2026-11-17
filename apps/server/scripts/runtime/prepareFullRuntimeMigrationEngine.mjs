#!/usr/bin/env node

import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServerPrismaMigrationToolLayout } from '../prismaInstallLayout.mjs';

// The schema engine must be the one the packaged migration CLI was released with, so it is
// resolved through that CLI's own `@prisma/engines` dependency rather than pinned separately.
const migrationTool = resolveServerPrismaMigrationToolLayout({
    serverRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
});
const requireFromCli = createRequire(migrationTool.cliPackageJsonPath);
const requireFromEngines = createRequire(requireFromCli.resolve('@prisma/engines/package.json'));
const { BinaryType, download } = requireFromEngines('@prisma/fetch-engine');
const { enginesVersion } = requireFromEngines('@prisma/engines-version');

function readOption(name) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
    if (!value) throw new Error(`[server-runtime] missing ${name}`);
    return value;
}

const binaryTarget = readOption('--binary-target');
const outDir = resolve(readOption('--out-dir'));
await mkdir(outDir, { recursive: true });
const paths = await download({
    binaries: { [BinaryType.SchemaEngineBinary]: outDir },
    binaryTargets: [binaryTarget],
    version: enginesVersion,
    showProgress: false,
});
const enginePath = paths[BinaryType.SchemaEngineBinary]?.[binaryTarget];
const info = enginePath ? await stat(enginePath).catch(() => null) : null;
if (!enginePath || !info?.isFile()) {
    throw new Error(`[server-runtime] Prisma schema engine was not materialized for ${binaryTarget}`);
}

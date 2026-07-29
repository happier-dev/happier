#!/usr/bin/env node

import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import fetchEngine from '@prisma/fetch-engine';
import enginesVersionPackage from '@prisma/engines-version';

const { BinaryType, download } = fetchEngine;
const { enginesVersion } = enginesVersionPackage;

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

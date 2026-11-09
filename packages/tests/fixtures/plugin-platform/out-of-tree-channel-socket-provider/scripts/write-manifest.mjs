#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { manifest } = await import('../src/index.mjs');
const manifestPath = join(fixtureRoot, '.happier-plugin', 'plugin.json');
const temporaryPath = `${manifestPath}.tmp`;
await writeFile(
  temporaryPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await rename(temporaryPath, manifestPath);

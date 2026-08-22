#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { manifest } = await import('../src/index.mjs');
await writeFile(
  join(fixtureRoot, '.happier-plugin', 'plugin.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

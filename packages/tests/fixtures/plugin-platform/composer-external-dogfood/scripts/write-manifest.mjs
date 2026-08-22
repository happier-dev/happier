import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { manifest } = await import('../src/index.mjs');

if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
  throw new Error('Composer dogfood source must export one manifest object.');
}

const manifestPath = resolve(fixtureRoot, '.happier-plugin', 'plugin.json');
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

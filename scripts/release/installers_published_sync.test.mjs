import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceRoot = join(repoRoot, 'scripts', 'release', 'installers');
const websiteRoot = join(repoRoot, 'apps', 'website', 'public');
const installerFiles = [
  'install.sh',
  'self-host.sh',
  'install.ps1',
  'happier-release.pub',
];

test('published website installers stay in sync with release-owned installer sources', async () => {
  for (const file of installerFiles) {
    const source = await readFile(join(sourceRoot, file), 'utf8');
    const published = await readFile(join(websiteRoot, file), 'utf8');
    assert.equal(published, source, `${file} is out of sync with scripts/release/installers`);
  }
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceRoot = join(repoRoot, 'scripts', 'release', 'installers');
const websiteRoot = join(repoRoot, 'apps', 'website', 'public');
const { INSTALLER_PUBLISH_SPECS } = await import('./sync-installers.mjs');

function applyTransform({ source, transform }) {
  if (transform === 'preview-default-channel') {
    return source
      .replace('HAPPIER_CHANNEL:-stable', 'HAPPIER_CHANNEL:-preview')
      .replace('$Channel = "stable"', '$Channel = "preview"');
  }
  return source;
}

test('published website installers stay in sync with release-owned installer sources', async () => {
  for (const spec of INSTALLER_PUBLISH_SPECS) {
    const rawSource = await readFile(join(sourceRoot, spec.source), 'utf8');
    const source = applyTransform({ source: rawSource, transform: spec.transform });
    for (const target of spec.targets) {
      const published = await readFile(join(websiteRoot, target), 'utf8');
      assert.equal(published, source, `${target} is out of sync with scripts/release/installers/${spec.source}`);
    }
  }
});

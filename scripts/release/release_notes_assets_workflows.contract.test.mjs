import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

for (const workflow of ['promote-ui.yml', 'build-ui-mobile-local.yml', 'publish-ui-web.yml', 'publish-ui-mobile-dev.yml']) {
  test(`${workflow} builds and publishes release notes assets to the dedicated assets repo`, async () => {
    const raw = await loadWorkflow(workflow);

    assert.match(raw, /Build release notes assets/);
    assert.match(raw, /Publish release notes assets/);
    assert.match(raw, /sources\/scripts\/parseReleaseNotes\.ts/);
    assert.match(raw, /scripts\/pipeline\/release\/release-notes\/build-release-notes-assets\.mjs/);
    assert.match(raw, /scripts\/pipeline\/release\/release-notes\/publish-release-notes-assets\.mjs/);
    assert.match(raw, /GH_REPO:\s*happier-dev\/happier-assets/);
    assert.match(raw, /--repo\s+"?happier-dev\/happier-assets"?/);
    assert.match(raw, /--tag\s+"?release-notes"?/);
  });
}

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

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

test('GitHub release titles are prefixed with Happier', async () => {
  const publishUiWeb = await loadFile('scripts/pipeline/release/publish-ui-web.mjs');
  assert.match(publishUiWeb, /Happier UI Web Bundle Preview/);
  assert.match(publishUiWeb, /Happier UI Web Bundle Stable/);

  const publishServerRuntime = await loadFile('scripts/pipeline/release/publish-server-runtime.mjs');
  assert.match(publishServerRuntime, /Happier Server Preview/);
  assert.match(publishServerRuntime, /Happier Server Stable/);

  const releaseNpm = await loadWorkflow('release-npm.yml');
  assert.match(releaseNpm, /title: Happier CLI v/);
  assert.match(releaseNpm, /title: Happier CLI Stable/);
  assert.match(releaseNpm, /title: Happier CLI Preview/);
  assert.match(releaseNpm, /title: Happier Stack v/);
  assert.match(releaseNpm, /title: Happier Stack Stable/);
  assert.match(releaseNpm, /title: Happier Stack Preview/);

  const buildTauri = await loadWorkflow('build-tauri.yml');
  assert.match(buildTauri, /title: Happier UI Desktop Preview/);
  assert.match(buildTauri, /title: Happier UI Desktop v/);
  assert.match(buildTauri, /title: Happier UI Desktop Stable/);
});

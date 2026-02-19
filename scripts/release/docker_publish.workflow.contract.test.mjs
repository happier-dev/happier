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

test('publish-docker supports workflow_call and is wired from release workflow', async () => {
  const publishDocker = await loadWorkflow('publish-docker.yml');
  assert.match(publishDocker, /\n\s*workflow_call:\n/);
  assert.match(publishDocker, /\n\s*source_ref:\n/);
  assert.match(publishDocker, /\n\s*build_relay:\n/);
  assert.match(publishDocker, /\n\s*build_devcontainer:\n/);
  assert.match(
    publishDocker,
    /node scripts\/pipeline\/docker\/publish-images\.mjs/,
    'publish-docker should delegate docker build+push to the pipeline script',
  );

  const release = await loadWorkflow('release.yml');
  assert.match(release, /publish_docker:/);
  assert.match(release, /uses:\s+\.\/\.github\/workflows\/publish-docker\.yml/);
  assert.match(release, /build_relay:/);
  assert.match(release, /build_devcontainer:/);
});

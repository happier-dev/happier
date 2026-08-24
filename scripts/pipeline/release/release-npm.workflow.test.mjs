import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('npm publication workflow is reusable-only and receives its exact source identity from release admission', async () => {
  const [npmWorkflow, releaseWorkflow] = await Promise.all([
    readFile(resolve(repositoryRoot, '.github/workflows/release-npm.yml'), 'utf8'),
    readFile(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
  ]);

  assert.match(npmWorkflow, /^on:\n  workflow_call:/mu);
  assert.doesNotMatch(npmWorkflow, /^  workflow_dispatch:/mu);
  assert.match(npmWorkflow, /authorized_sha:\n        description: "Release-admitted exact source SHA"\n        required: true/mu);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/release-npm\.yml/mu);
  assert.match(releaseWorkflow, /authorized_sha: \$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/mu);
});

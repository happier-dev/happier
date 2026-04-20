import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow exposes a thin docker release-assets job through release-validate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /run_release_assets_docker:\n\s+required: false\n\s+default: false\n\s+type: boolean/,
    'tests workflow should expose a dedicated workflow_call input for the Docker release-assets lane',
  );

  assert.match(
    raw,
    /release-assets-docker:[\s\S]*?node scripts\/pipeline\/run\.mjs release-validate \\\n[\s\S]*?--suite docker-release-assets \\\n[\s\S]*?--platform linux \\\n[\s\S]*?--source local-build \\\n[\s\S]*?--ref "\."/,
    'release-assets-docker job should call the unified release-validation runner against the local-build Docker suite',
  );
});

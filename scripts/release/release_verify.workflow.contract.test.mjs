import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-verify workflow exposes and forwards continuity/update release-validation inputs', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  for (const inputName of [
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
  ]) {
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+description: "Verify — .*"\\n\\s+required: true\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_dispatch should expose ${inputName} with a release-verification default`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+required: false\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_call should expose ${inputName}`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\s*\\$\\{\\{ inputs\\.${inputName} \\}\\}`),
      `release-verify should forward ${inputName} into tests.yml`,
    );
  }
});

test('release-verify workflow supports dev channel and maps installer channel per release lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  assert.match(
    raw,
    /options:\n(?:\s+- .*\n)*\s+- dev\n(?:\s+- .*\n)*\s+- preview\n(?:\s+- .*\n)*\s+- production/m,
    'release-verify workflow_dispatch should allow dev/preview/production channels',
  );
  assert.match(
    raw,
    /installers_channel:\s*\$\{\{\s*inputs\.channel == 'production' && 'stable' \|\| inputs\.channel == 'dev' && 'dev' \|\| 'preview'\s*\}\}/,
    'release-verify should map production->stable, dev->dev, preview->preview when forwarding installer channel',
  );
});

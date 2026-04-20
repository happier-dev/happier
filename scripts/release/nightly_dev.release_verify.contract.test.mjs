import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('nightly-dev workflow runs reusable release verification against the dev channel', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[cli, hstack, server_runtime, ui_web, ui_mobile, ui_desktop, docker\][\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'nightly-dev should invoke the reusable release-verify workflow after publish lanes finish',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*dev/,
    'nightly-dev should validate the dev channel through release-verify',
  );
  assert.match(
    raw,
    /permissions:\s*[\s\S]*?actions:\s*read/,
    'nightly-dev should grant actions: read because the reusable release-verify workflow requires it',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?secrets:\s*inherit/,
    'nightly-dev should inherit secrets for the reusable release-verify workflow',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?run_installers_smoke:\s*true[\s\S]*?run_binary_smoke:\s*true[\s\S]*?run_cli_update_continuity:\s*true[\s\S]*?run_daemon_continuity:\s*true[\s\S]*?run_session_continuity:\s*true/,
    'nightly-dev should explicitly enable the release validation toggles for the reusable workflow',
  );
});

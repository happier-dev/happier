import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release workflow runs reusable release verification after publish lanes finish during full checks', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[plan, publish_server_runtime, publish_ui_web, publish_docker, publish_npm\][\s\S]*?if:\s*\$\{\{\s*always\(\) && inputs\.checks_profile == 'full'[\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'release.yml should call the reusable release-verify workflow after the publish lanes finish when full checks are requested',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'production' \|\| 'preview'\s*\}\}/,
    'release.yml should map production releases to production verification and preview releases to preview verification',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, ci\][\s\S]*?\(needs\.ci\.result == 'success' \|\| needs\.ci\.result == 'skipped'\)/,
    'release.yml planning should only wait for the pre-release CI gate before continuing',
  );
  assert.match(
    raw,
    /sync_dev:[\s\S]*?\(needs\.release_verify\.result == 'success' \|\| needs\.release_verify\.result == 'skipped'\)[\s\S]*?needs:\s*\[plan, bump_versions_dev, promote_main, release_verify\]/,
    'release.yml should gate the final production sync on release verification succeeding or being skipped',
  );
});

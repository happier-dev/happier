import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow exposes thin release-validation continuity/update jobs through release-validate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  for (const inputName of [
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
  ]) {
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+required: false\\n\\s+default: false\\n\\s+type: boolean`),
      `tests workflow should expose workflow_call input ${inputName}`,
    );
    assert.doesNotMatch(
      raw,
      new RegExp(`if:\\s*\\$\\{\\{\\s*github\\.event_name == 'workflow_call' && inputs\\.${inputName}\\s*\\}\\}`),
      `tests workflow should not require github.event_name == workflow_call to run ${inputName}`,
    );
  }

  assert.match(
    raw,
    /cli-update-continuity:[\s\S]*?node scripts\/pipeline\/run\.mjs release-validate \\\n[\s\S]*?--suite cli-update \\\n[\s\S]*?--platform linux \\\n[\s\S]*?--from-source published-channel \\\n[\s\S]*?--from-ref "\$\{CLI_UPDATE_FROM_CHANNEL\}" \\\n[\s\S]*?--to-source local-build \\\n[\s\S]*?--to-ref "\."/,
    'tests workflow should run cli-update continuity through the unified release-validation runner',
  );
  assert.doesNotMatch(
    raw.match(/cli-update-continuity:[\s\S]*?(?=\n  [a-z0-9-]+:|\n$)/)?.[0] ?? '',
    /Install Sapling|Verify Sapling CLI/,
    'cli-update continuity should stay a thin release-validation lane and must not depend on Sapling bootstrap',
  );

  assert.match(
    raw,
    /daemon-continuity:[\s\S]*?node scripts\/pipeline\/run\.mjs release-validate \\\n[\s\S]*?--suite daemon-continuity \\\n[\s\S]*?--platform linux \\\n[\s\S]*?--source local-build \\\n[\s\S]*?--ref "\."/,
    'tests workflow should run daemon continuity through the unified release-validation runner',
  );
  assert.doesNotMatch(
    raw.match(/daemon-continuity:[\s\S]*?(?=\n  [a-z0-9-]+:|\n$)/)?.[0] ?? '',
    /Install Sapling|Verify Sapling CLI/,
    'daemon continuity should stay a thin release-validation lane and must not depend on Sapling bootstrap',
  );

  assert.match(
    raw,
    /session-continuity:[\s\S]*?node scripts\/pipeline\/run\.mjs release-validate \\\n[\s\S]*?--suite session-continuity \\\n[\s\S]*?--platform linux \\\n[\s\S]*?--source local-build \\\n[\s\S]*?--ref "\."/,
    'tests workflow should run session continuity through the unified release-validation runner',
  );
  assert.doesNotMatch(
    raw.match(/session-continuity:[\s\S]*?(?=\n  [a-z0-9-]+:|\n$)/)?.[0] ?? '',
    /Install Sapling|Verify Sapling CLI/,
    'session continuity should stay a thin release-validation lane and must not depend on Sapling bootstrap',
  );
});

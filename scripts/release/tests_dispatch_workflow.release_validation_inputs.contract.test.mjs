import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('manual tests dispatch exposes and forwards release-validation custom checks', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8');

  for (const checkName of [
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
    'run_release_assets_docker',
  ]) {
    assert.match(
      raw,
      new RegExp(`${checkName}:\\s*\\$\\{\\{ steps\\.flags\\.outputs\\.${checkName} \\}\\}`),
      `tests-dispatch.yml should expose ${checkName} as a resolve output`,
    );
    assert.match(
      raw,
      new RegExp(`echo "${checkName}=\\$\\{${checkName}\\}"`),
      `tests-dispatch.yml should publish ${checkName} from the flag resolver`,
    );
    assert.match(
      raw,
      new RegExp(`${checkName}:\\s*\\$\\{\\{ needs\\.resolve\\.outputs\\.${checkName} == 'true' \\}\\}`),
      `tests-dispatch.yml should forward ${checkName} into tests.yml`,
    );
  }

  assert.match(
    raw,
    /custom_checks:[\s\S]*?run_release_assets_docker/,
    'tests-dispatch.yml should document the docker release-assets lane in custom_checks',
  );
  assert.match(
    raw,
    /if has cli_update_continuity; then run_cli_update_continuity=true; fi/,
    'tests-dispatch.yml should let operators request the cli update continuity lane',
  );
  assert.match(
    raw,
    /if has daemon_continuity; then run_daemon_continuity=true; fi/,
    'tests-dispatch.yml should let operators request the daemon continuity lane',
  );
  assert.match(
    raw,
    /if has session_continuity; then run_session_continuity=true; fi/,
    'tests-dispatch.yml should let operators request the session continuity lane',
  );
  assert.match(
    raw,
    /if has release_assets_docker; then run_release_assets_docker=true; fi/,
    'tests-dispatch.yml should let operators request the docker release-assets lane',
  );
});

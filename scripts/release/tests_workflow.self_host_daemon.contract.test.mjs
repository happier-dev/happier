import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow includes self-host + daemon E2E gate and runs real integration harness', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(raw, /run_self_host_daemon:/, 'tests.yml should define run_self_host_daemon input');
  // The explicit-selection gate of self-host-daemon-e2e is owned by
  // tests_workflow.reusable_run_flags.contract.test.mjs (exact parsed `if`).
  assert.match(
    raw,
    /node\s+--test\s+apps\/stack\/scripts\/self_host_daemon\.real\.integration\.test\.mjs/,
    'self-host daemon e2e should execute the real integration test harness',
  );
});

test('Windows self-host prepares and validates the native launcher before packaging HStack', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const jobStart = workflow.indexOf('  self-host-schtasks-e2e:');
  const nextJob = workflow.indexOf('\n  self-host-daemon-e2e:', jobStart);
  assert.ok(jobStart >= 0 && nextJob > jobStart);
  const job = workflow.slice(jobStart, nextJob);
  const compile = job.indexOf('node scripts\\pipeline\\release\\build-windows-service-launcher.mjs');
  const lifecycle = job.indexOf('-File packages/cli-common/native/windows/service-launcher.test.ps1');
  const integration = job.indexOf('node --test apps/stack/scripts/self_host_schtasks.real.integration.test.mjs');
  const install = job.indexOf('uses: ./.github/actions/install-pnpm-dependencies');
  const workspaceBuild = job.indexOf('node scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs @happier-dev/cli-common');

  assert.ok(workspaceBuild > install && workspaceBuild < integration,
    'build cli-common service exports after dependency installation and before importing the self-host harness');
  assert.ok(compile >= 0, 'the clean Windows checkout must produce the packaged launcher');
  assert.match(job.slice(0, compile), /VsDevCmd\.bat" -arch=x64/);
  assert.ok(lifecycle > compile, 'validate the launcher built in this job');
  assert.ok(integration > lifecycle, 'HStack packaging requires the validated launcher');
});

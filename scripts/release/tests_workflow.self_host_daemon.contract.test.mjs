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
  assert.match(
    raw,
    /if:\s*\$\{\{\s*inputs\.select_jobs_explicitly\s*&&\s*inputs\.run_self_host_daemon\s*\}\}/,
    'self-host daemon E2E must honor the reusable caller flag even when GitHub preserves the schedule event name',
  );
  assert.match(
    raw,
    /node\s+--test\s+apps\/stack\/scripts\/self_host_daemon\.real\.integration\.test\.mjs/,
    'self-host daemon e2e should execute the real integration test harness',
  );
});

test('daemon integration owns its provider fixture instead of relying on workflow-installed CLIs', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const daemonSuite = await readFile(join(repoRoot, 'apps', 'cli', 'src', 'daemon', 'daemon.integration.test.ts'), 'utf8');

  assert.doesNotMatch(
    workflow,
    /Install provider CLI stubs \(CI only\)/,
    'the reusable daemon suite should not depend on setup owned only by one workflow lane',
  );
  assert.match(
    daemonSuite,
    /HAPPIER_CLAUDE_PATH:\s*daemonClaudeCliStubPath/,
    'the daemon suite should bind its own deterministic Claude fixture',
  );
});

test('Windows self-host checkout verification explicitly uses bash', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const jobStart = workflow.indexOf('  self-host-schtasks-e2e:');
  const nextJob = workflow.indexOf('\n  self-host-daemon-e2e:', jobStart);
  assert.ok(jobStart >= 0 && nextJob > jobStart, 'expected Windows self-host job boundaries');
  const job = workflow.slice(jobStart, nextJob);
  const verificationStart = job.indexOf('- name: Verify exact requested checkout SHA');
  const setupNodeStart = job.indexOf('- name: Setup Node', verificationStart);
  assert.ok(verificationStart >= 0 && setupNodeStart > verificationStart, 'expected checkout verification step');
  const verification = job.slice(verificationStart, setupNodeStart);

  assert.match(
    verification,
    /shell:\s*bash/,
    'bash syntax must not run under the Windows PowerShell default',
  );
});

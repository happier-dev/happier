import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('reusable tests calls make their run flags authoritative regardless of the caller event', async () => {
  const testsRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const testsWorkflow = YAML.parse(testsRaw, { prettyErrors: true });

  assert.equal(testsWorkflow.on.workflow_call.inputs.select_jobs_explicitly.type, 'boolean');
  assert.equal(testsWorkflow.on.workflow_call.inputs.select_jobs_explicitly.default, false);

  const defaultSuiteInputs = new Map([
    ['ui-e2e', 'run_ui_e2e'],
    ['ui', 'run_ui'],
    ['shared-packages-unit', 'run_ui'],
    ['server', 'run_server'],
    ['server-db-contract', 'run_server_db_contract'],
    ['cli', 'run_cli'],
    ['stack', 'run_stack'],
    ['release-contracts', 'run_release_contracts'],
    ['installers-smoke-macos', 'run_installers_smoke'],
    ['installers-smoke-linux', 'run_installers_smoke'],
    ['installers-smoke-windows', 'run_installers_smoke'],
    ['binary-smoke', 'run_binary_smoke'],
    ['typecheck', 'run_typecheck'],
    ['cli-daemon-e2e', 'run_cli_daemon_e2e'],
    ['e2e-core', 'run_e2e_core'],
  ]);

  for (const [jobName, inputName] of defaultSuiteInputs) {
    assert.equal(
      testsWorkflow.jobs[jobName].if,
      `\${{ !inputs.select_jobs_explicitly || inputs.${inputName} }}`,
      `${jobName} must honor an explicit false input even when a scheduled caller invokes tests.yml`,
    );
  }

  for (const workflowName of [
    'self-host-e2e.yml',
    'stress-tests.yml',
    'release.yml',
    'release-verify.yml',
    'providers-contracts.yml',
    'tests-dispatch.yml',
  ]) {
    const raw = await readFile(join(repoRoot, '.github', 'workflows', workflowName), 'utf8');
    const reusableCallCount = (raw.match(/uses:\s*\.\/\.github\/workflows\/tests\.yml/g) ?? []).length;
    const explicitSelectionCount = (raw.match(/select_jobs_explicitly:\s*true/g) ?? []).length;
    assert.equal(
      explicitSelectionCount,
      reusableCallCount,
      `${workflowName} must opt every tests.yml call into explicit job selection`,
    );
  }
});

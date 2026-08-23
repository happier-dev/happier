import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

const root = new URL('../../', import.meta.url);

async function readWorkflow(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('reusable tests callers explicitly select jobs without inheriting caller event defaults', async () => {
  const testsSource = await readWorkflow('.github/workflows/tests.yml');
  const parsed = YAML.parse(testsSource);
  const workflowCall = parsed?.on?.workflow_call ?? parsed?.true?.workflow_call;

  assert.deepEqual(workflowCall?.inputs?.select_jobs_explicitly, {
    description: 'Honor run_* inputs instead of running the ordinary CI defaults',
    required: false,
    default: false,
    type: 'boolean',
  });
  assert.equal(
    parsed?.concurrency?.group,
    'tests-${{ github.workflow }}-${{ github.ref }}',
    'the reusable tests workflow must not share its caller concurrency group and cancel the caller',
  );
  assert.equal(parsed?.concurrency?.['cancel-in-progress'], true);

  const defaultJobs = {
    'ui-e2e': 'run_ui_e2e',
    ui: 'run_ui',
    'shared-packages-unit': 'run_ui',
    'plugin-workspaces-unit': 'run_plugin_workspaces',
    server: 'run_server',
    'server-db-contract': 'run_server_db_contract',
    cli: 'run_cli',
    stack: 'run_stack',
    'release-contracts': 'run_release_contracts',
    'installers-smoke-macos': 'run_installers_smoke',
    'installers-smoke-linux': 'run_installers_smoke',
    'installers-smoke-windows': 'run_installers_smoke',
    'binary-smoke': 'run_binary_smoke',
    typecheck: 'run_typecheck',
    'cli-daemon-e2e': 'run_cli_daemon_e2e',
    'e2e-core': 'run_e2e_core',
  };

  for (const [job, input] of Object.entries(defaultJobs)) {
    assert.equal(
      parsed?.jobs?.[job]?.if,
      `\${{ !inputs.select_jobs_explicitly || inputs.${input} }}`,
      `${job} must obey the explicit reusable-workflow selection boundary`,
    );
  }

  assert.equal(
    parsed?.jobs?.stress?.if,
    '${{ inputs.run_stress }}',
    'scheduled reusable callers must be able to enable the stress job through its authoritative run flag',
  );

  for (const path of [
    '.github/workflows/self-host-e2e.yml',
    '.github/workflows/stress-tests.yml',
    '.github/workflows/release.yml',
    '.github/workflows/release-verify.yml',
    '.github/workflows/providers-contracts.yml',
    '.github/workflows/tests-dispatch.yml',
  ]) {
    const source = await readWorkflow(path);
    const workflow = YAML.parse(source);
    const calls = Object.values(workflow?.jobs ?? {}).filter(
      (job) => job?.uses === './.github/workflows/tests.yml',
    );
    assert.ok(calls.length > 0, `${path} must still call tests.yml`);
    for (const call of calls) {
      assert.equal(call?.with?.select_jobs_explicitly, true, `${path} must explicitly select reusable jobs`);
    }
  }

  const stressWorkflow = YAML.parse(await readWorkflow('.github/workflows/stress-tests.yml'));
  const stressCall = Object.values(stressWorkflow?.jobs ?? {}).find(
    (job) => job?.uses === './.github/workflows/tests.yml',
  );
  assert.equal(stressCall?.with?.run_stress, true);
  for (const input of ['run_server_db_contract', 'run_installers_smoke', 'run_binary_smoke']) {
    assert.equal(stressCall?.with?.[input], false, `stress workflow must disable the unrelated true-default ${input} lane`);
  }
});

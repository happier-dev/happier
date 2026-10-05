import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

const root = new URL('../../', import.meta.url);

async function readWorkflow(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('setup-package changes select the composed real-hsetup UI E2E suite', async () => {
  const workflow = YAML.parse(await readWorkflow('.github/workflows/tests.yml'));
  const job = workflow.jobs['ui-e2e'];
  const changes = job.steps.find((step) => step.id === 'changes');
  const filters = YAML.parse(changes.with.filters);
  for (const owner of ['apps/bootstrap/**', 'packages/cli-common/**']) {
    assert.ok(filters.ui_e2e.includes(owner), `${owner} must select the real-hsetup browser lane`);
  }
  const run = job.steps.find((step) => step.name === 'Run UI E2E');
  assert.match(run.if, /steps\.changes\.outputs\.ui_e2e == 'true'/);
  assert.match(run.run, /select-ui-e2e-shard\.mjs/);
  const { partitionUiE2eSpecs } = await import('../ci/select-ui-e2e-shard.mjs');
  const { readdir } = await import('node:fs/promises');
  const specs = (await readdir(new URL('packages/tests/suites/ui-e2e/', root)))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `packages/tests/suites/ui-e2e/${name}`);
  const composedSpec = 'packages/tests/suites/ui-e2e/desktop.personalHome.realHsetup.spec.ts';
  assert.equal(partitionUiE2eSpecs({ specs, shardTotal: 18 }).flat().filter((spec) => spec === composedSpec).length, 1);
});

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
  assert.equal(
    parsed?.concurrency?.['cancel-in-progress'],
    false,
    'an active full collector must finish; GitHub may replace the single pending run, but a later push must not discard in-flight evidence',
  );

  const defaultJobs = {
    'ui-e2e': 'run_ui_e2e',
    ui: 'run_ui',
    'shared-packages-unit': 'run_shared_packages',
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
    'build-smoke': 'run_build_smoke',
    typecheck: 'run_typecheck',
    'cli-daemon-e2e': 'run_cli_daemon_e2e',
    'e2e-core': 'run_e2e_core',
  };

  for (const [job, input] of Object.entries(defaultJobs)) {
    const expected = job === 'ui'
      ? `\${{ always() && (!inputs.select_jobs_explicitly || inputs.${input}) }}`
      : `\${{ !inputs.select_jobs_explicitly || inputs.${input} }}`;
    assert.equal(
      parsed?.jobs?.[job]?.if,
      expected,
      `${job} must obey the explicit reusable-workflow selection boundary`,
    );
  }

  for (const [job, input] of [
    ['mobile-e2e-android', 'run_mobile_e2e_android'],
    ['mobile-e2e-ios', 'run_mobile_e2e_ios'],
    ['release-assets-docker', 'run_release_assets_docker'],
    ['self-host-systemd-e2e', 'run_self_host_systemd'],
    ['self-host-launchd-e2e', 'run_self_host_launchd'],
    ['self-host-schtasks-e2e', 'run_self_host_schtasks'],
    ['self-host-daemon-e2e', 'run_self_host_daemon'],
    ['e2e-core-slow', 'run_e2e_core_slow'],
    ['release_actor_guard', 'run_providers'],
    ['providers', 'run_providers'],
  ]) {
    assert.equal(
      parsed?.jobs?.[job]?.if,
      `\${{ inputs.select_jobs_explicitly && inputs.${input} }}`,
      `${job} must honor explicit reusable inputs even when GitHub preserves the caller event`,
    );
  }

  for (const job of ['ui-e2e', 'workspace-sync-real']) {
    assert.doesNotMatch(
      JSON.stringify(parsed?.jobs?.[job]),
      /github\.event_name\s*[!=]=\s*'workflow_call'/u,
      `${job} must use the explicit-selection boundary rather than the caller event to bypass path filtering`,
    );
  }

  for (const job of ['installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows']) {
    const env = parsed?.jobs?.[job]?.env ?? {};
    for (const key of ['INSTALLERS_CHANNEL', 'INSTALLERS_SOURCE', 'INSTALLERS_REF', 'INSTALLERS_RELEASE_CHANNEL']) {
      assert.match(String(env[key] ?? ''), /inputs\.select_jobs_explicitly/u);
      assert.doesNotMatch(String(env[key] ?? ''), /github\.event_name == 'workflow_call'/u);
    }
  }

  assert.equal(
    parsed?.jobs?.stress?.if,
    '${{ inputs.run_stress }}',
    'scheduled reusable callers must be able to enable the stress job through its authoritative run flag',
  );

  for (const path of [
    '.github/workflows/self-host-e2e.yml',
    '.github/workflows/stress-tests.yml',
    '.github/workflows/release-source-validation.yml',
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

test('real workspace sync obeys the explicit reusable-workflow selection boundary', async () => {
  const parsed = YAML.parse(await readWorkflow('.github/workflows/tests.yml'));
  assert.equal(
    parsed?.jobs?.['workspace-sync-real']?.if,
    '${{ !inputs.select_jobs_explicitly || inputs.run_workspace_sync_real || inputs.run_workspace_sync_performance }}',
  );
});

test('the existing Home Iroh real lane runs native, Chromium, and Docker relay journeys', async () => {
  const parsed = YAML.parse(await readWorkflow('.github/workflows/tests.yml'));
  const dispatch = YAML.parse(await readWorkflow('.github/workflows/tests-dispatch.yml'));
  const uiPackage = JSON.parse(await readWorkflow('apps/ui/package.json'));
  const irohPackage = JSON.parse(await readWorkflow('packages/iroh-native/package.json'));
  const job = parsed?.jobs?.['home-iroh-real'];
  assert.equal(job?.if, '${{ !inputs.select_jobs_explicitly || inputs.run_home_iroh_real }}');
  assert.equal(job?.name, 'Iroh real transport (native + Chromium + Docker relay)');

  const dispatchCall = Object.values(dispatch?.jobs ?? {}).find(
    (candidate) => candidate?.uses === './.github/workflows/tests.yml',
  );
  assert.match(
    dispatch?.on?.workflow_dispatch?.inputs?.custom_checks?.description ?? '',
    /home_iroh_real/u,
    'the existing manual dispatch must advertise the Home Iroh real selector',
  );
  assert.equal(
    dispatchCall?.with?.run_home_iroh_real,
    "${{ needs.resolve.outputs.run_home_iroh_real == 'true' }}",
    'the existing manual dispatch selector must forward to the reusable Home Iroh real lane',
  );
  const resolveStep = dispatch?.jobs?.resolve?.steps?.find((step) => step?.id === 'flags');
  assert.equal(
    resolveStep?.run,
    'node scripts/pipeline/checks/resolve-checks-plan.mjs --target hosted',
    'manual dispatch must invoke the canonical hosted checks resolver',
  );

  const steps = job?.steps ?? [];
  const nativeBuildStepIndex = steps.findIndex((step) => /test:home-iroh:real/u.test(step?.run ?? ''));
  const ownerTestStepIndex = steps.findIndex((step) => /@happier-dev\/iroh-native test$/u.test(step?.run ?? ''));
  assert.ok(nativeBuildStepIndex >= 0 && ownerTestStepIndex > nativeBuildStepIndex,
    'Iroh owner tests must run after the real lane builds the native addon');
  assert.equal(
    steps[ownerTestStepIndex]?.env?.HAPPIER_IROH_REQUIRE_NODE_ADDON,
    '1',
    'Iroh owner tests must fail instead of skipping addon-backed lifecycle coverage',
  );
  assert.ok(
    steps.some((step) => /playwright install --with-deps chromium/u.test(step?.run ?? '')),
    'the existing lane must provision real Chromium',
  );
  assert.ok(
    steps.some((step) => /proof:browser-iroh-real-verticals/u.test(step?.run ?? '')),
    'the existing lane must invoke the combined browser completion command',
  );
  const dockerStepIndex = steps.findIndex((step) => /test:home-iroh:docker/u.test(step?.run ?? ''));
  assert.ok(dockerStepIndex > nativeBuildStepIndex,
    'the Docker relay journey must run after the native addon is built',
  );
  assert.match(
    irohPackage?.scripts?.['test:home-iroh:docker'] ?? '',
    /hstack-exec/u,
    'the Docker relay journey must use the existing remote execution owner',
  );
  assert.equal(
    uiPackage?.scripts?.['proof:browser-iroh-real-verticals'],
    'node --test ./tools/iroh/browserMachineTransferJourney.test.mjs && node ./tools/iroh/runBrowserIrohSharedEndpointProof.mjs --real-home-vertical --machine-transfer-vertical',
    'the real lane must run the Machine contract test before both completion verticals',
  );
});

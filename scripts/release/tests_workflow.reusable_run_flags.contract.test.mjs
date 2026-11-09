import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

import { withoutV03GateSkip } from './testsWorkflowTestkit.mjs';

const root = new URL('../../', import.meta.url);

test('reusable release validations isolate artifacts while retaining canonical source CI evidence', async () => {
  const read = async (name) => YAML.parse(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const workflow = await read('tests');
  assert.equal(workflow.on.workflow_call.inputs.artifact_namespace?.default, '', 'ordinary source CI retains its public artifact names');
  assert.match(workflow.concurrency.group, /inputs\.artifact_namespace/, 'sibling validations must not replace pending invocations');
  const uploads = [];
  const downloads = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    // The v0.3 source gate and its artifact consumers never run in explicit reusable calls.
    if (id === 'gate' || id.startsWith('gate-')) continue;
    for (const step of job.steps ?? []) {
      if (!/upload-artifact|download-artifact|download-ci-cli-build/.test(step.uses ?? '')) continue;
      assert.match(step.with.name, /inputs\.artifact_namespace/, `${step.name} must isolate repeated reusable invocations`);
      (step.uses.includes('upload-artifact') ? uploads : downloads).push(step.with.name);
    }
  }
  assert.match(workflow.jobs['gate-prepare'].if, /!inputs\.select_jobs_explicitly/);
  assert.ok(uploads.some((name) => name.endsWith('ci-lane-summary')));
  for (const name of downloads) assert.ok(uploads.includes(name), `download has no matching producer: ${name}`);
  const verification = await read('release-verify');
  const namespace = verification.jobs.verify.with.artifact_namespace;
  assert.match(namespace, /inputs\.channel/);
  for (const key of Object.keys(verification.on.workflow_call.inputs).filter((key) => /^candidate_.*_version$/.test(key))) {
    assert.ok(namespace.includes(`inputs.${key}`), `${key} must distinguish sibling product verifications`);
  }
  const source = await read('release-source-validation');
  assert.equal(source.jobs.platform.with.artifact_namespace, 'source-platform');
  const render = (template, inputs) => template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    if (expression.startsWith('github.')) {
      const github = { workflow: 'Combined release', event_name: 'workflow_dispatch', ref: 'refs/heads/dev' };
      assert.ok(expression.slice(7) in github, `Unsupported GitHub fixture field: ${expression}`);
      return github[expression.slice(7)];
    }
    const optional = expression.match(/^inputs\.artifact_namespace != '' && (format\(.*\)) \|\| ''$/);
    if (optional && !inputs.artifact_namespace) return '';
    const format = (optional?.[1] ?? expression).match(/^format\('([^']*)', (inputs\.[a-z_]+(?:, inputs\.[a-z_]+)*)\)$/);
    assert.ok(format, `Unsupported workflow format expression: ${expression}`);
    const values = format[2].split(', ').map((field) => {
      assert.ok(field.slice(7) in inputs, `Missing fixture input: ${field}`);
      return inputs[field.slice(7)];
    });
    return format[1].replace(/\{(\d+)\}/g, (_, index) => {
      assert.ok(Number(index) < values.length, `Missing format argument: ${index}`);
      return values[Number(index)];
    });
  });
  const versionInputs = Object.keys(verification.on.workflow_call.inputs).filter((key) => /^candidate_.*_version$/.test(key));
  const namespaces = ['', source.jobs.platform.with.artifact_namespace];
  for (const channel of ['preview', 'production']) {
    for (const product of versionInputs) {
      const inputs = Object.fromEntries(versionInputs.map((key) => [key, key === product ? '1.2.3' : '']));
      namespaces.push(render(namespace, { ...inputs, channel }));
    }
  }
  const summaryName = uploads.find((name) => name.endsWith('ci-lane-summary'));
  const renderedNames = namespaces.map((artifact_namespace) => render(summaryName, { artifact_namespace }));
  assert.equal(renderedNames[0], 'ci-lane-summary', 'ordinary source CI keeps its canonical summary');
  assert.equal(new Set(renderedNames).size, namespaces.length, 'every channel/product invocation needs a distinct artifact name');
  const renderedGroups = namespaces.map((artifact_namespace) => render(workflow.concurrency.group, { artifact_namespace }));
  assert.equal(new Set(renderedGroups).size, namespaces.length, 'every channel/product invocation needs a distinct concurrency group');

});

async function readWorkflow(path) {
  return readFile(new URL(path, root), 'utf8');
}

// Evaluates the small `==`/`&&`/`||` GitHub expression grammar the concurrency key uses.
function evaluateWorkflowExpression(expression, context) {
  const body = String(expression).replace(/^\$\{\{\s*|\s*\}\}$/gu, '')
    .replace(/github\.(event_name|ref_name)/gu, (_, key) => JSON.stringify(context[key]))
    .replaceAll('==', '===');
  assert.match(body, /^[\s"'a-z0-9_./=|&()-]*$/iu, `unsupported concurrency expression: ${expression}`);
  return Function(`return (${body});`)();
}

test('push runs keep their complete verdict; only superseded pull request runs stop', async () => {
  const parsed = YAML.parse(await readWorkflow('.github/workflows/tests.yml'));
  assert.equal(
    parsed?.concurrency?.group,
    "tests-${{ github.workflow }}-${{ github.ref }}${{ inputs.artifact_namespace != '' && format('-{0}', inputs.artifact_namespace) || '' }}",
    'the reusable tests workflow must not share its caller concurrency group and cancel the caller',
  );
  const cancels = (event_name, ref_name) => evaluateWorkflowExpression(parsed.concurrency['cancel-in-progress'], { event_name, ref_name });

  // Every exact-SHA push verdict consumer names its branch: nightly through
  // --source-branch, release source validation through the dispatch's sourceRef.
  const nightly = await readWorkflow('.github/workflows/nightly-dev.yml');
  const dispatch = await readWorkflow('scripts/pipeline/release/validate-release-dispatch.mjs');
  const consumed = new Set([
    ...[...nightly.matchAll(/--source-branch (\w[\w.-]*)/gu)].map((match) => match[1]),
    ...[...dispatch.matchAll(/sourceRef = '([^']+)'/gu)].map((match) => match[1]),
  ]);
  assert.deepEqual([...consumed].sort(), ['dev', 'preview']);
  for (const branch of consumed) {
    assert.equal(cancels('push', branch), false, `a later ${branch} push must not discard the consumed exact-SHA verdict`);
  }
  for (const branch of parsed.on.push.branches.filter((branch) => !consumed.has(branch))) {
    assert.equal(cancels('push', branch), false, `${branch} push runs keep their complete verdict`);
  }
  assert.equal(cancels('push', 'v0.3'), false, 'v0.3 pushes arrive faster than a run lasts; cancelling would leave no completed verdict');
  assert.equal(cancels('pull_request', '42/merge'), true);
  assert.equal(cancels('workflow_dispatch', 'v0.3'), false, 'a focused manual dispatch is never cancelled by the push policy');
});

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
    const condition = parsed?.jobs?.[job]?.if;
    if (job === 'server-db-contract') {
      // The DB contract also serves the v0.3 Gate when its selection requires it.
      assert.ok(condition.includes(`(!inputs.select_jobs_explicitly || inputs.${input})`), condition);
      continue;
    }
    assert.equal(
      withoutV03GateSkip(condition),
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
      withoutV03GateSkip(parsed?.jobs?.[job]?.if),
      job === 'self-host-schtasks-e2e'
        ? "${{ (inputs.select_jobs_explicitly && inputs.run_self_host_schtasks) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs.run_self_host_schtasks == 'true') }}"
        : `\${{ inputs.select_jobs_explicitly && inputs.${input} }}`,
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
    withoutV03GateSkip(parsed?.jobs?.stress?.if),
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



test('native Windows service tests run on ordinary source CI while installer certification keeps its release selection', async () => {
  const workflow = YAML.parse(await readWorkflow('.github/workflows/tests.yml'));
  const job = workflow.jobs['installers-smoke-windows'];
  assert.equal(job.if, '${{ !inputs.select_jobs_explicitly || inputs.run_installers_smoke }}');
  assert.ok(workflow.jobs.gate.needs.includes('installers-smoke-windows'), 'Gate must fail if the native Windows service contracts fail');
  const nativeTests = job.steps.find((step) => step.run?.includes('src/service/windows.test.ts'));
  assert.ok(nativeTests, 'native PowerShell tests must execute on a Windows runner');
  assert.equal(nativeTests['working-directory'], 'packages/cli-common');
  assert.equal(nativeTests.if, undefined);
  for (const step of job.steps.filter((step) => ['Prepare release validation workspaces', 'Run unified installer smoke'].includes(step.name))) {
    assert.match(step.if, /github\.base_ref == 'v0\.3'/);
    assert.match(step.if, /inputs\.select_jobs_explicitly/);
  }
});

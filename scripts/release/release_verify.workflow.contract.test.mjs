import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-verify resolves one public profile with explicit suite refinements', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw, { prettyErrors: true });

  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.validation_profile.options,
    ['integrated', 'stable'],
    'manual verification should expose only normal public release profiles',
  );
  assert.equal(workflow.on.workflow_call.inputs.validation_profile.default, '');
  assert.ok(workflow.jobs.resolve_validation_profile, 'one resolver must own automatic suite selection');
  assert.match(String(workflow.jobs.resolve_validation_profile.steps?.at(-1)?.run ?? ''), /resolve-validation-plan\.mjs/);
  assert.ok(workflow.jobs.verify.needs.includes('resolve_validation_profile'));

  const verifyBlock = raw.slice(raw.indexOf('\n  verify:'));
  assert.equal(
    (verifyBlock.match(/^    if:/gm) ?? []).length,
    1,
    'the nested reusable verification job must have exactly one condition key',
  );

  assert.equal(workflow.on.workflow_dispatch.inputs.run_cli_update_continuity, undefined);
  assert.equal(workflow.on.workflow_call.inputs.run_cli_update_continuity, undefined);
  assert.ok(workflow.on.workflow_dispatch.inputs.include_validation_suites);
  assert.ok(workflow.on.workflow_dispatch.inputs.waive_validation_suites);

  for (const inputName of [
    'run_installers_smoke',
    'run_binary_smoke',
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
    'run_release_assets_docker',
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
  ]) {
    assert.equal(
      workflow.jobs.verify.with?.[inputName],
      '${{ fromJSON(needs.resolve_validation_profile.outputs.' + inputName + ') }}',
      `release-verify should convert resolver-owned ${inputName} to a boolean before calling tests.yml`,
    );
  }

  const resolver = workflow.jobs.resolve_validation_profile.steps.find((step) => step.id === 'profile');
  assert.doesNotMatch(String(resolver.run), /legacy-run-/);
  assert.match(String(resolver.run), /--include-suites/);
  assert.match(String(resolver.run), /--waive-suites/);
  assert.equal(resolver.env.CANDIDATE_CLI_VERSION, '${{ inputs.candidate_cli_version }}');
  assert.equal(resolver.env.CANDIDATE_SERVER_VERSION, '${{ inputs.candidate_server_version }}');
  assert.equal(resolver.env.RELEASE_CHANNEL, '${{ inputs.channel }}');
  assert.match(resolver.run, /--has-cli-candidate/);
  assert.match(resolver.run, /--has-server-candidate/);
  assert.match(resolver.run, /--has-published-relay-predecessor/);
  assert.match(resolver.run, /--risk-cli-upgrade/);
  assert.match(resolver.run, /--risk-session-continuity/);
  assert.match(resolver.run, /--risk-relay-upgrade/);

  assert.equal(
    workflow.jobs.verify.with.checkout_sha,
    '${{ inputs.candidate_source_sha }}',
    'every automatic source-built suite must run against the exact candidate checkout',
  );
});

test('release-verify workflow supports dev channel and maps installer channel per release lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  assert.match(
    raw,
    /options:\n(?:\s+- .*\n)*\s+- dev\n(?:\s+- .*\n)*\s+- preview\n(?:\s+- .*\n)*\s+- production/m,
    'release-verify workflow_dispatch should allow dev/preview/production channels',
  );
  assert.match(
    raw,
    /installers_channel:\s*\$\{\{\s*inputs\.channel == 'production' && 'stable' \|\| inputs\.channel == 'dev' && 'dev' \|\| 'preview'\s*\}\}/,
    'release-verify should map production->stable, dev->dev, preview->preview when forwarding installer channel',
  );
});

test('release candidate verification runs trusted workflow control bytes under token', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw, { prettyErrors: true });
  const job = workflow.jobs.verify_candidate;
  assert.ok(job && Array.isArray(job.steps), 'verify_candidate must remain a step-based job');

  const checkoutSteps = job.steps.filter((step) => String(step?.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkoutSteps.length, 1, 'candidate verification must have one control checkout');
  assert.equal(checkoutSteps[0].with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkoutSteps[0].with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkoutSteps[0].with?.path, '.release-control');
  assert.equal(checkoutSteps[0].with?.['persist-credentials'], false);

  assert.equal(
    job.steps.some((step) => String(step?.uses ?? '').startsWith('./.github/actions/')),
    false,
    'candidate-root local actions must not run in the verification gate',
  );
  assert.equal(
    job.steps.some((step) => /candidate source/i.test(String(step?.name ?? '')) && String(step?.uses ?? '').startsWith('actions/checkout@')),
    false,
    'candidate source must remain metadata rather than executable checkout bytes',
  );

  const delegatedVerifiers = job.steps.filter(
    (step) => step?.uses === './.release-control/.github/actions/verify-immutable-release-candidate',
  );
  assert.equal(delegatedVerifiers.length, 4, 'all candidate products must share one trusted verification owner');

  const ownerRaw = await readFile(
    join(repoRoot, '.github', 'actions', 'verify-immutable-release-candidate', 'action.yml'),
    'utf8',
  );
  const owner = YAML.parse(ownerRaw, { prettyErrors: true });
  const privilegedSteps = owner.runs.steps.filter((step) => step?.env?.GITHUB_TOKEN || step?.env?.GH_TOKEN);
  assert.equal(privilegedSteps.length, 1, 'exactly one step should receive the repository token');
  const privileged = privilegedSteps[0];
  assert.match(String(privileged.run ?? ''), /control_dir="\$GITHUB_WORKSPACE\/\.release-control"/);
  assert.match(
    String(privileged.run ?? ''),
    /\$control_dir\/scripts\/pipeline\/release\/verify-release-candidate-identity\.mjs/,
  );
  assert.doesNotMatch(String(privileged.run ?? ''), /node\s+scripts\/pipeline\//);
  assert.doesNotMatch(String(privileged.run ?? ''), /\$\{\{\s*inputs\./);

  for (const [name, expression] of Object.entries({
    REPOSITORY: '${{ inputs.repository }}',
    RELEASE_CHANNEL: '${{ inputs.channel }}',
    CANDIDATE_SOURCE_SHA: '${{ inputs.candidate_source_sha }}',
    CANDIDATE_PRODUCT: '${{ inputs.product }}',
    CANDIDATE_VERSION: '${{ inputs.version }}',
  })) {
    assert.equal(privileged.env?.[name], expression, `${name} must enter the shell through env`);
  }

  const artifactVerification = owner.runs.steps.find((step) => /Verify downloaded signed artifacts/.test(String(step?.name ?? '')));
  assert.ok(artifactVerification, 'downloaded artifacts must be verified in a separate step');
  assert.equal(artifactVerification.env?.GITHUB_TOKEN, undefined);
  assert.equal(artifactVerification.env?.GH_TOKEN, undefined);
  assert.match(
    String(artifactVerification.run ?? ''),
    /\$control_dir\/scripts\/pipeline\/release\/verify-artifacts\.mjs/,
  );
  assert.doesNotMatch(String(artifactVerification.run ?? ''), /\$\{\{\s*inputs\./);
});

test('release-verify proves a deployed server loaded the exact candidate revision', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw, { prettyErrors: true });
  assert.equal(workflow.on.workflow_call.inputs.server_api_version_url.type, 'string');
  assert.equal(workflow.on.workflow_call.inputs.verify_deploy_server.type, 'boolean');

  const step = workflow.jobs.verify_candidate.steps.find(
    (candidate) => candidate.name === 'Verify loaded server API revision',
  );
  assert.ok(step);
  assert.equal(step.if, '${{ inputs.verify_deploy_server }}');
  assert.equal(step.env.SERVER_API_VERSION_URL, '${{ inputs.server_api_version_url }}');
  assert.equal(step.env.CANDIDATE_SOURCE_SHA, '${{ inputs.candidate_source_sha }}');
  assert.match(step.run, /test -n "\$SERVER_API_VERSION_URL"/);
  assert.match(step.run, /verify-loaded-release-revision\.mjs/);
});

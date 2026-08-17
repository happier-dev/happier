import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release-verify workflow exposes and forwards continuity/update release-validation inputs', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');

  for (const inputName of [
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
    'run_release_assets_docker',
  ]) {
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+description: "Verify — .*"\\n\\s+required: true\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_dispatch should expose ${inputName} with a release-verification default`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\n\\s+required: false\\n\\s+default: true\\n\\s+type: boolean`),
      `release-verify workflow_call should expose ${inputName}`,
    );
    assert.match(
      raw,
      new RegExp(`${inputName}:\\s*\\$\\{\\{ needs\\.resolve_validation_profile\\.outputs\\.${inputName} \\}\\}`),
      `release-verify should forward the resolved profile value for ${inputName} into tests.yml`,
    );
  }
});

test('release-verify proves a deployed server loaded the exact candidate revision', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  assert.equal(workflow.on.workflow_call.inputs.server_api_version_url.type, 'string');

  const step = workflow.jobs.verify_candidate_identity.steps.find(
    (candidate) => candidate.name === 'Verify loaded server API revision',
  );
  assert.ok(step);
  assert.equal(step.if, '${{ inputs.verify_deploy_server }}');
  assert.equal(step.env.SERVER_API_VERSION_URL, '${{ inputs.server_api_version_url }}');
  assert.equal(step.env.CANDIDATE_SOURCE_SHA, '${{ inputs.candidate_source_sha }}');
  assert.match(step.run, /verify-loaded-release-revision\.mjs/);
  assert.match(step.run, /test -n "\$SERVER_API_VERSION_URL"/);
});

test('release-verify executes every automatic profile suite against the exact candidate checkout', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const profile = workflow.jobs.resolve_validation_profile;
  const verify = workflow.jobs.verify;

  assert.equal(profile.outputs.run_artifact_verify, '${{ steps.profile.outputs.run_artifact_verify }}');
  assert.match(profile.steps.find((step) => step.id === 'profile').run, /resolve-validation-plan\.mjs/);
  assert.equal(verify.with.run_artifact_verify, '${{ needs.resolve_validation_profile.outputs.run_artifact_verify }}');
  assert.equal(verify.with.checkout_sha, '${{ inputs.candidate_source_sha }}');
  assert.equal(
    verify.with.run_release_assets_docker,
    '${{ needs.resolve_validation_profile.outputs.run_release_assets_docker }}',
  );
});

test('release-verify selects expensive candidate checks only for affected immutable components', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const resolver = workflow.jobs.resolve_validation_profile.steps.find((step) => step.id === 'profile');

  assert.equal(resolver.env.CANDIDATE_CLI_VERSION, '${{ inputs.candidate_cli_version }}');
  assert.equal(resolver.env.CANDIDATE_SERVER_VERSION, '${{ inputs.candidate_server_version }}');
  assert.equal(resolver.env.RELEASE_CHANNEL, '${{ inputs.channel }}');
  assert.match(resolver.run, /resolve-validation-plan\.mjs/);
  assert.doesNotMatch(resolver.run, /resolveAutomaticReleaseValidationExecution|node --input-type=module -e/);
  assert.match(resolver.run, /--risk-cli-upgrade/);
  assert.match(resolver.run, /--risk-session-continuity/);
  assert.match(resolver.run, /--risk-relay-upgrade/);
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

test('release-verify defaults real platform and service validation on and forwards every gate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  for (const inputName of [
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
  ]) {
    assert.equal(
      workflow.on.workflow_dispatch.inputs[inputName].default,
      true,
      `manual release verification should default ${inputName} on`,
    );
    assert.equal(
      workflow.on.workflow_call.inputs[inputName].default,
      true,
      `reusable release verification should default ${inputName} on`,
    );
    assert.equal(
      workflow.jobs.verify.with[inputName],
      `\${{ needs.resolve_validation_profile.outputs.${inputName} }}`,
      `release verification should forward the resolved profile value for ${inputName} to the real tests workflow job`,
    );
  }
});

test('release-verify requires and checks the exact candidate and distinct build/publication run identities', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  for (const inputName of [
    'candidate_source_sha',
    'candidate_build_run_id',
    'publication_run_id',
  ]) {
    assert.equal(workflow.on.workflow_call.inputs[inputName].required, true);
    assert.equal(workflow.on.workflow_call.inputs[inputName].type, 'string');
  }
  assert.deepEqual(workflow.on.workflow_call.inputs.cli_candidate_build_run_id, {
    required: false,
    default: '',
    type: 'string',
  });
  assert.equal(workflow.on.workflow_dispatch.inputs.cli_candidate_build_run_id.required, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.cli_candidate_build_run_id.default, '');
  assert.equal(workflow.on.workflow_dispatch.inputs.cli_candidate_build_run_id.type, 'string');

  const identity = workflow.jobs.verify_candidate_identity;
  assert.ok(identity, 'release verification should have an explicit identity assertion job');
  assert.match(
    identity.steps.map((step) => step.run ?? '').join('\n'),
    /verify-release-candidate-identity\.mjs/,
  );
  assert.equal(
    identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).env.CANDIDATE_BUILD_RUN_ID,
    '${{ inputs.candidate_build_run_id }}',
  );
  assert.equal(
    identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).env.CLI_CANDIDATE_BUILD_RUN_ID,
    '${{ inputs.cli_candidate_build_run_id }}',
  );
  assert.equal(
    identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).env.PUBLICATION_RUN_ID,
    '${{ inputs.publication_run_id }}',
  );
  assert.equal(
    identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).env.CURRENT_RUN_ID,
    '${{ github.run_id }}',
  );
  assert.match(
    identity.steps.map((step) => step.run ?? '').join('\n'),
    /--current-run-id "\$CURRENT_RUN_ID"/,
    'release verification must bind publication identity to the workflow run actually performing verification',
  );
  assert.match(
    identity.steps.map((step) => step.run ?? '').join('\n'),
    /--cli-candidate-build-run-id "\$CLI_CANDIDATE_BUILD_RUN_ID"/,
    'release verification should pass the optional CLI-only build identity to the canonical verifier',
  );
  assert.match(
    identity.steps.map((step) => step.run ?? '').join('\n'),
    /--derive-targets true/,
    'the canonical verifier must derive refs, tags, and manifests from release facts',
  );
  assert.doesNotMatch(
    identity.steps.map((step) => step.run ?? '').join('\n'),
    /(?:source_branch|release_suffix|cli_tag|stack_tag|server_tag|ui_web_tag)=/,
    'workflow YAML must not duplicate release-channel or product target mapping',
  );
  assert.equal(workflow.on.workflow_call.inputs.verify_stack_release.default, false);
  for (const inputName of [
    'verify_cli_release',
    'verify_stack_release',
    'verify_server_release',
    'verify_ui_web_release',
  ]) {
    assert.equal(
      workflow.on.workflow_dispatch.inputs[inputName].default,
      true,
      `manual verification must explicitly select ${inputName} without leaking caller event context`,
    );
    assert.equal(
      identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).env[
        inputName.toUpperCase()
      ],
      `\${{ inputs.${inputName} }}`,
    );
    assert.match(
      identity.steps.find((step) => /verify-release-candidate-identity/.test(step.run ?? '')).run,
      new RegExp(`--${inputName.replaceAll('_', '-')} "\\$${inputName.toUpperCase()}"`),
      `${inputName} must be passed to the script-owned verification mapping`,
    );
  }
  assert.ok(workflow.jobs.verify.needs.includes('verify_candidate_identity'));
});

test('release-verify executes candidate identity verification only from trusted workflow-control bytes', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const identity = workflow.jobs.verify_candidate_identity;

  const controlCheckout = identity.steps.find(
    (step) => step.name === 'Checkout trusted workflow control bytes',
  );
  assert.equal(
    controlCheckout?.uses,
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'workflow control checkout must use the repository-approved immutable checkout identity',
  );
  assert.equal(controlCheckout.with.repository, '${{ job.workflow_repository }}');
  assert.equal(controlCheckout.with.ref, '${{ job.workflow_sha }}');
  assert.equal(controlCheckout.with.path, '.release-control');
  assert.equal(controlCheckout.with['persist-credentials'], false);
  assert.equal(
    identity.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@')).length,
    1,
    'the identity job must not materialize candidate-controlled source bytes',
  );
  assert.ok(
    identity.steps.every((step) => step.with?.ref !== '${{ inputs.candidate_source_sha }}'),
    'candidate identity is remote evidence, not a local executable checkout',
  );

  const setupNode = identity.steps.find((step) => step.name === 'Setup Node');
  assert.equal(
    setupNode?.uses,
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'verifier runtime setup must use the repository-approved immutable action identity',
  );

  const verifierStep = identity.steps.find(
    (step) => /verify-release-candidate-identity/.test(step.run ?? ''),
  );
  assert.ok(verifierStep, 'identity verification must have one executable verifier step');
  assert.match(
    verifierStep.run,
    /node "\$GITHUB_WORKSPACE\/\.release-control\/scripts\/pipeline\/release\/verify-release-candidate-identity\.mjs"/,
    'candidate-modified root verifier bytes must never select the release verification decision',
  );
  assert.doesNotMatch(
    verifierStep.run,
    /(?:^|\n)\s*node (?:\.\/)?scripts\/pipeline\/release\/verify-release-candidate-identity\.mjs/,
    'candidate source checkout must not supply the verifier entrypoint',
  );
});

test('release-verify passes candidate-controlled identity data through env without shell interpolation', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const verifierStep = workflow.jobs.verify_candidate_identity.steps.find(
    (step) => /verify-release-candidate-identity/.test(step.run ?? ''),
  );
  assert.ok(verifierStep, 'identity verification must have one executable verifier step');

  const expectedEnv = {
    RELEASE_CHANNEL: '${{ inputs.channel }}',
    CANDIDATE_SOURCE_SHA: '${{ inputs.candidate_source_sha }}',
    CANDIDATE_BUILD_RUN_ID: '${{ inputs.candidate_build_run_id }}',
    CLI_CANDIDATE_BUILD_RUN_ID: '${{ inputs.cli_candidate_build_run_id }}',
    PUBLICATION_RUN_ID: '${{ inputs.publication_run_id }}',
    CANDIDATE_CLI_VERSION: '${{ inputs.candidate_cli_version }}',
    CANDIDATE_STACK_VERSION: '${{ inputs.candidate_stack_version }}',
    CANDIDATE_SERVER_VERSION: '${{ inputs.candidate_server_version }}',
    CANDIDATE_UI_WEB_VERSION: '${{ inputs.candidate_ui_web_version }}',
  };
  for (const [key, value] of Object.entries(expectedEnv)) {
    assert.equal(verifierStep.env[key], value, `${key} must cross the workflow boundary through env`);
  }

  assert.doesNotMatch(
    verifierStep.run,
    /\$\{\{\s*inputs\./,
    'candidate-controlled workflow inputs must never be expression-interpolated into the privileged shell',
  );
  for (const [flag, variable] of [
    ['--channel', 'RELEASE_CHANNEL'],
    ['--candidate-source-sha', 'CANDIDATE_SOURCE_SHA'],
    ['--candidate-cli-version', 'CANDIDATE_CLI_VERSION'],
    ['--candidate-stack-version', 'CANDIDATE_STACK_VERSION'],
    ['--candidate-server-version', 'CANDIDATE_SERVER_VERSION'],
    ['--candidate-ui-web-version', 'CANDIDATE_UI_WEB_VERSION'],
  ]) {
    assert.match(
      verifierStep.run,
      new RegExp(`${flag} "\\$${variable}"`),
      `${flag} must consume its quoted environment value`,
    );
  }
});

test('release-verify delegates immutable bytes to one exact-download tokenless-verification owner', async () => {
  const workflow = YAML.parse(await readFile(
    join(repoRoot, '.github', 'workflows', 'release-verify.yml'),
    'utf8',
  ));
  const identity = workflow.jobs.verify_candidate_identity;
  for (const id of ['cli', 'stack', 'server', 'ui_web']) {
    const step = identity.steps.find((candidate) => candidate.id === `verify_${id}`);
    assert.ok(step, `missing shared immutable verification for ${id}`);
    assert.equal(step.uses, './.release-control/.github/actions/verify-immutable-release-candidate');
  }
  const owner = YAML.parse(await readFile(
    join(repoRoot, '.github', 'actions', 'verify-immutable-release-candidate', 'action.yml'),
    'utf8',
  ));
  const tokened = owner.runs.steps.filter((step) => step.env?.GH_TOKEN || step.env?.GITHUB_TOKEN);
  assert.equal(tokened.length, 1);
  assert.match(tokened[0].run, /gh release download/);
  const tokenless = owner.runs.steps.find((step) => step.id === 'verify');
  assert.ok(tokenless);
  assert.equal(tokenless.env?.GH_TOKEN, undefined);
  assert.equal(tokenless.env?.GITHUB_TOKEN, undefined);
  assert.match(tokenless.run, /verify-artifacts\.mjs/);
  assert.match(tokenless.run, /--checksums/);
  assert.match(tokenless.run, /--public-key/);
});

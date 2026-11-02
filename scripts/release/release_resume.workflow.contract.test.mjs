import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function workflow(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8'));
}

function action(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/actions', name, 'action.yml'), 'utf8'));
}

function needs(job) {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

test('one trusted reusable workflow resolves prior release candidates by exact run and fatal digest verification', () => {
  const parsed = workflow('resolve-release-resume.yml');
  assert.ok(parsed.on.workflow_call.inputs.origin_run_id);
  assert.ok(parsed.on.workflow_call.inputs.expected_workflow);
  assert.ok(parsed.on.workflow_call.inputs.expected_channel);
  for (const output of [
    'source_sha',
    'desktop_run_number',
    'desktop_artifacts',
    'desktop_finalized_artifacts',
    'cli_version',
    'stack_version',
    'server_version',
    'ui_web_version',
    'cli_requested',
    'stack_requested',
    'server_requested',
    'ui_web_requested',
    'deploy_ui_requested',
    'deploy_server_requested',
    'deploy_website_requested',
    'deploy_docs_requested',
    'docker_requested',
    'npm_requested',
    'deploy_ui_complete',
    'ui_ota_complete',
    'ui_native_ios_complete',
    'ui_native_android_complete',
    'ui_apk_complete',
    'deploy_server_complete',
    'deploy_website_complete',
    'deploy_docs_complete',
    'docker_complete',
    'npm_complete',
  ]) {
    assert.ok(parsed.on.workflow_call.outputs[output], `missing resume output ${output}`);
  }
  const resolveJob = parsed.jobs.resolve;
  assert.equal(resolveJob['timeout-minutes'], 15);
  assert.equal(resolveJob.permissions.actions, 'read');
  assert.equal(resolveJob.permissions.contents, 'read');
  const source = resolveJob.steps.map((step) => step.run ?? '').join('\n');
  assert.match(source, /resolve-release-resume\.mjs[\s\S]*--mode inspect/);
  assert.match(source, /resolve-release-resume\.mjs[\s\S]*--mode download/);
  assert.match(source, /--artifact-id "\$STATUS_ARTIFACT_ID"/);
  assert.match(source, /--artifact-digest "\$EXPECTED_DIGEST"/);
  assert.match(source, /resolve-release-resume\.mjs[\s\S]*--mode resolve/);
  assert.equal((source.match(/\/jobs\?filter=latest&per_page=100/g) ?? []).length, 1, 'one canonical origin retrieval owns nested completion evidence');
  assert.match(source, /--jobs-json "\$RUNNER_TEMP\/resume-jobs.json"/);

  const ui = workflow('promote-ui.yml');
  const mobile = workflow('build-ui-mobile-local.yml');
  for (const input of ['ui_ota_complete', 'ui_native_ios_complete', 'ui_native_android_complete', 'ui_apk_complete']) {
    assert.equal(ui.on.workflow_call.inputs[input]?.type, 'boolean');
    assert.equal(ui.on.workflow_call.inputs[input]?.default, false);
  }
  const evaluate = (expression, inputs) => Function('inputs', 'needs', `return ${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')};`)(
    inputs, { promote: { result: 'success' } },
  );
  const fresh = { expo_action: 'full', ui_ota_complete: false, ui_native_ios_complete: false, ui_native_android_complete: false, ui_apk_complete: false };
  const complete = { ...fresh, ui_ota_complete: true, ui_native_ios_complete: true, ui_native_android_complete: true, ui_apk_complete: true };
  assert.equal(evaluate(ui.jobs.mobile_native.if, fresh), true);
  assert.equal(evaluate(ui.jobs.mobile_native.if, complete), false);
  assert.equal(evaluate(ui.jobs.mobile_apk_release.if, fresh), true);
  assert.equal(evaluate(ui.jobs.mobile_apk_release.if, complete), false);
  assert.equal(evaluate(ui.jobs.mobile_native.with.platform, fresh), 'all');
  assert.equal(evaluate(ui.jobs.mobile_native.with.platform, { ...fresh, ui_native_ios_complete: true }), 'android');
  assert.equal(evaluate(ui.jobs.mobile_native.with.platform, { ...fresh, ui_native_android_complete: true }), 'ios');
  assert.equal(ui.jobs.mobile_native.name, 'Mobile native (local runner)');
  assert.equal(ui.jobs.mobile_apk_release.name, 'Mobile APK release (local runner)');
  assert.equal(mobile.jobs.build_ios.name, 'Build (ios)');
  assert.equal(mobile.jobs.build_android.name, 'Build (android)');
  assert.equal(mobile.jobs.publish_android_apk.name, 'Sign and publish Android APK');
  for (const [job, names] of [
    [ui.jobs.validate_candidate, ['Prepare Android OTA artifact without credentials', 'Prepare iOS OTA artifact without credentials', 'Upload prepared OTA artifacts']],
    [ui.jobs.promote, ['Enable Corepack', 'Install trusted OTA publisher dependencies', 'Download prepared OTA artifacts', 'Publish Android OTA from validated bytes', 'Publish iOS OTA from validated bytes']],
  ]) {
    for (const name of names) {
      const steps = job.steps.filter((step) => step.name === name);
      assert.equal(steps.length, 1);
      assert.equal(evaluate(steps[0].if, fresh), true);
      assert.equal(evaluate(steps[0].if, complete), false, 'satisfied OTA does not export or republish');
    }
  }
});

for (const [name, buildJobs] of [
  ['publish-cli-binaries.yml', ['prepare', 'build_candidate', 'finalize_darwin', 'finalize_publish']],
  ['publish-hstack-binaries.yml', ['prepare', 'build_candidate', 'finalize_darwin', 'finalize_publish']],
  ['publish-server-runtime.yml', ['build_candidate', 'finalize_darwin', 'finalize_publish']],
  ['publish-ui-web.yml', ['prepare', 'build_candidate', 'publish']],
]) {
  test(`${name} reuses a verified immutable candidate without rebuilding or promoting it`, () => {
    const parsed = workflow(name);
    assert.ok(parsed.on.workflow_dispatch.inputs.resume_version);
    assert.ok(parsed.on.workflow_call.inputs.resume_version);
    const guard = parsed.jobs.release_actor_guard;
    const guardSource = guard.steps.map((step) => step.run ?? '').join('\n');
    assert.match(guardSource, /verify-release-candidate-identity\.mjs/);
    assert.match(guardSource, /RESUME_VERSION/);
    for (const jobName of buildJobs) {
      assert.match(parsed.jobs[jobName].if, /inputs\.resume_version == ''/);
    }
    assert.match(parsed.jobs.promote_existing.if, /inputs\.resume_version == ''/);
    assert.match(parsed.on.workflow_call.outputs.version.value, /release_actor_guard\.outputs\.(?:resume_version|version)/);
  });
}

test('nightly resume pins the prior source, reuses completed immutable candidates, and records future resume identities', () => {
  const parsed = workflow('nightly-dev.yml');
  assert.ok(workflow('release.yml').on.workflow_dispatch.inputs.resume_run_id);
  assert.equal(parsed.jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_workflow, '.github/workflows/nightly-dev.yml');
  assert.equal(parsed.jobs.ui_desktop.with.resume_run_id, '${{ inputs.resume_run_id }}');
  assert.ok(needs(parsed.jobs.prepare_release_candidate).includes('resolve_resume'));
  const checkout = parsed.jobs.prepare_release_candidate.steps.find((step) => String(step.name).includes('Checkout requested nightly source'));
  assert.match(checkout.with.ref, /needs\.resolve_resume\.outputs\.source_sha/);
  for (const [jobName, output] of [
    ['cli', 'cli_version'],
    ['hstack', 'stack_version'],
    ['server_runtime', 'server_version'],
    ['ui_web', 'ui_web_version'],
  ]) {
    assert.equal(parsed.jobs[jobName].with.resume_version, `\${{ needs.resolve_resume.outputs.${output} }}`);
    assert.equal(parsed.jobs[jobName].with.authorized_sha, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  }
  const statusProjection = parsed.jobs.release_status.steps.find((step) => String(step.name).includes('Project nightly release status'));
  assert.match(statusProjection.run, /project-release-status\.mjs/);
  assert.equal(statusProjection.env.CLI_CANDIDATE_VERSION, '${{ needs.cli.outputs.version }}');
  assert.equal(statusProjection.env.STACK_CANDIDATE_VERSION, '${{ needs.hstack.outputs.version }}');
  assert.equal(statusProjection.env.CLI_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.cli_verified }}');
  assert.equal(statusProjection.env.IMMUTABLE_VERIFICATION_RESULT, '${{ needs.release_verify.result }}');
  assert.equal(statusProjection.env.SOURCE_SHA, "${{ needs.prepare_release_candidate.outputs.source_sha || 'unavailable' }}");
  assert.equal(statusProjection.env.DESKTOP_ORIGIN_RUN_ID, '${{ inputs.resume_run_id || github.run_id }}');
});

test('full release resume binds the prior run to the same operation and authorized source', () => {
  const parsed = workflow('release-channel.yml');
  assert.ok(workflow('release.yml').on.workflow_dispatch.inputs.resume_run_id);
  assert.equal(parsed.jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
  assert.equal(parsed.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.match(parsed.jobs.resolve_resume.with.expected_workflow, /release\.yml/);
  assert.equal(parsed.jobs.resolve_resume.with.expected_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(parsed.jobs.resolve_resume.with.expected_operation_id, '${{ inputs.hmaint_operation_id }}');
  assert.ok(needs(parsed.jobs.plan).includes('resolve_resume'));
  assert.match(parsed.jobs.plan.if, /needs\.resolve_resume\.result == 'success'/);
  const resumeResolver = workflow('resolve-release-resume.yml');
  for (const output of ['cli_rolling_complete', 'stack_rolling_complete', 'server_rolling_complete', 'ui_web_rolling_complete']) {
    assert.ok(resumeResolver.on.workflow_call.outputs[output], `expected resume output ${output}`);
  }
  const bumpPlanStep = parsed.jobs.plan.steps.find((step) => step.id === 'bump_plan');
  assert.equal(bumpPlanStep.env.RESUME_CLI_VERSION, '${{ needs.resolve_resume.outputs.cli_version }}');
  assert.equal(bumpPlanStep.env.RESUME_STACK_VERSION, '${{ needs.resolve_resume.outputs.stack_version }}');
  assert.equal(bumpPlanStep.env.RESUME_SERVER_VERSION, '${{ needs.resolve_resume.outputs.server_version }}');
  assert.match(bumpPlanStep.run, /--resume-cli-version "\$\{RESUME_CLI_VERSION\}"/);
  assert.match(bumpPlanStep.run, /--resume-stack-version "\$\{RESUME_STACK_VERSION\}"/);
  assert.match(bumpPlanStep.run, /--resume-server-version "\$\{RESUME_SERVER_VERSION\}"/);
  for (const [jobName, output] of [
    ['publish_cli_binaries', 'cli_version'],
    ['publish_hstack_binaries', 'stack_version'],
    ['publish_server_runtime', 'server_version'],
    ['publish_ui_web', 'ui_web_version'],
  ]) {
    assert.ok(needs(parsed.jobs[jobName]).includes('resolve_resume'));
    assert.equal(parsed.jobs[jobName].with.resume_version, `\${{ needs.resolve_resume.outputs.${output} }}`);
  }
  const statusProjection = parsed.jobs.release_status.steps.find((step) => String(step.name).includes('Project release status'));
  assert.match(statusProjection.run, /project-release-status\.mjs/);
  assert.equal(statusProjection.env.CLI_VERSION, '${{ needs.publish_cli_binaries.outputs.version }}');
  assert.equal(statusProjection.env.CLI_RESUME_VERIFIED, "${{ needs.verify_cli_candidate.result == 'success' }}");
  assert.equal(statusProjection.env.IMMUTABLE_VERIFICATION_RESULT, '${{ needs.verify_release_candidates.result }}');
  assert.match(String(parsed.jobs.plan.outputs.publish_docker_needed), /needs\.resolve_resume\.outputs\.docker_requested == 'true'/);
  assert.match(String(parsed.jobs.plan.outputs.publish_docker_relay_needed), /docker_requested == 'true' && needs\.resolve_resume\.outputs\.server_requested == 'true'/);
  assert.match(String(parsed.jobs.plan.outputs.publish_docker_dev_box_needed), /docker_requested == 'true' && needs\.resolve_resume\.outputs\.cli_requested == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.if), /needs\.plan\.outputs\.publish_docker_needed == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.if), /needs\.resolve_resume\.outputs\.docker_complete != 'true'/);
  assert.match(String(parsed.jobs.publish_docker.with.build_relay), /needs\.plan\.outputs\.publish_docker_relay_needed == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.with.build_dev_box), /needs\.plan\.outputs\.publish_docker_dev_box_needed == 'true'/);
  assert.match(String(statusProjection.env.REQUEST_DOCKER), /needs\.resolve_resume\.outputs\.docker_requested == 'true'/);
  for (const [jobName, output] of [
    ['promote_cli_binaries', 'cli_rolling_complete'],
    ['promote_hstack_binaries', 'stack_rolling_complete'],
    ['promote_server_runtime', 'server_rolling_complete'],
    ['promote_ui_web', 'ui_web_rolling_complete'],
  ]) {
    assert.ok(needs(parsed.jobs[jobName]).includes('resolve_resume'));
    assert.match(String(parsed.jobs[jobName].if), new RegExp(`needs\\.resolve_resume\\.outputs\\.${output} != 'true'`));
  }
  assert.equal(statusProjection.env.CLI_ROLLING_RESUME_COMPLETE, '${{ needs.resolve_resume.outputs.cli_rolling_complete }}');
  assert.ok(needs(parsed.jobs.deploy_ui).includes('resolve_resume'));
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_requested), /needs\.resolve_resume\.outputs\.deploy_ui_requested == 'true'/);
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_web), /contains\(format\(',\{0\},', inputs\.deploy_targets\), ',ui,'\)/);
  assert.match(String(parsed.jobs.deploy_ui.if), /needs\.deploy_plan\.outputs\.deploy_ui_requested == 'true'/);
  assert.match(String(parsed.jobs.deploy_ui.if), /needs\.deploy_plan\.outputs\.deploy_ui_resume_complete != 'true'/);
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_resume_complete), /needs\.resolve_resume\.outputs\.deploy_ui_complete == 'true'/);
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_resume_complete), /needs\.resolve_resume\.outputs\.deploy_ui_expo_action == inputs\.ui_expo_action/);
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_resume_complete), /needs\.resolve_resume\.outputs\.deploy_ui_desktop_mode == inputs\.desktop_mode/);
  assert.match(String(parsed.jobs.deploy_ui.with.desktop_mode), /needs\.deploy_plan\.outputs\.deploy_ui_desktop_mode/);
  const uiPromotion = workflow('promote-ui.yml');
  for (const [input, output] of [
    ['resume_desktop_artifacts', 'desktop_artifacts'],
    ['resume_desktop_finalized_artifacts', 'desktop_finalized_artifacts'],
    ['resume_desktop_run_number', 'desktop_run_number'],
    ['resume_source_sha', 'source_sha'],
  ]) {
    assert.equal(parsed.jobs.deploy_ui.with[input], `\${{ needs.resolve_resume.outputs.${output} }}`);
    assert.equal(uiPromotion.on.workflow_call.inputs[input]?.type, 'string');
    assert.equal(uiPromotion.jobs.desktop.with[input], `\${{ inputs.${input} }}`);
  }
  for (const output of ['ui_ota_complete', 'ui_native_ios_complete', 'ui_native_android_complete', 'ui_apk_complete']) {
    assert.match(String(parsed.jobs.deploy_ui.with[output]), new RegExp(`needs\\.resolve_resume\\.outputs\\.${output} == 'true'`));
    assert.match(String(parsed.jobs.deploy_ui.with[output]), /needs\.resolve_resume\.outputs\.deploy_ui_expo_action == inputs\.ui_expo_action/);
  }
  assert.match(String(statusProjection.env.REQUEST_DEPLOY_UI), /needs\.resolve_resume\.outputs\.deploy_ui_requested == 'true'/);
  assert.match(String(statusProjection.env.REQUEST_DEPLOY_UI), /needs\.deploy_plan\.outputs\.deploy_ui_requested == 'true'/);
  for (const [jobName, outputName, requestEnv] of [
    ['deploy_server', 'deploy_server_requested', 'REQUEST_DEPLOY_SERVER'],
    ['deploy_website', 'deploy_website_requested', 'REQUEST_DEPLOY_WEBSITE'],
    ['deploy_docs', 'deploy_docs_requested', 'REQUEST_DEPLOY_DOCS'],
  ]) {
    assert.ok(needs(parsed.jobs[jobName]).includes('resolve_resume'));
    assert.match(String(parsed.jobs.deploy_plan.outputs[outputName]), new RegExp(`needs\\.resolve_resume\\.outputs\\.${outputName} == 'true'`));
    assert.match(String(parsed.jobs[jobName].if), new RegExp(`needs\\.deploy_plan\\.outputs\\.${outputName} == 'true'`));
    assert.match(String(parsed.jobs[jobName].if), new RegExp(`needs\\.resolve_resume\\.outputs\\.${outputName.replace('_requested', '_complete')} != 'true'`));
    assert.match(String(statusProjection.env[requestEnv]), new RegExp(`needs\\.resolve_resume\\.outputs\\.${outputName} == 'true'`));
  }
  assert.match(String(statusProjection.env.REQUEST_NPM), /needs\.resolve_resume\.outputs\.npm_requested == 'true'/);
  assert.match(String(parsed.jobs.publish_npm.if), /needs\.resolve_resume\.outputs\.npm_complete != 'true'/);
  assert.ok(needs(parsed.jobs.publish_npm).includes('publish_cli_binaries'));
  assert.ok(needs(parsed.jobs.publish_npm).includes('publish_hstack_binaries'));
  assert.ok(needs(parsed.jobs.publish_npm).includes('publish_server_runtime'));
  assert.equal(parsed.jobs.publish_npm.with.cli_version, '${{ needs.publish_cli_binaries.outputs.version }}');
  assert.equal(parsed.jobs.publish_npm.with.stack_version, '${{ needs.publish_hstack_binaries.outputs.version }}');
  assert.equal(parsed.jobs.publish_npm.with.server_version, '${{ needs.publish_server_runtime.outputs.version }}');
  for (const name of ['DEPLOY_SERVER_RESUME_COMPLETE', 'DEPLOY_WEBSITE_RESUME_COMPLETE', 'DEPLOY_DOCS_RESUME_COMPLETE', 'DOCKER_RESUME_COMPLETE', 'NPM_RESUME_COMPLETE']) {
    assert.match(String(statusProjection.env[name]), /needs\.resolve_resume\.outputs\./, `${name} must preserve accepted resume evidence`);
  }
  assert.match(String(statusProjection.env.DEPLOY_UI_RESUME_COMPLETE), /needs\.deploy_plan\.outputs\.deploy_ui_resume_complete/);
});

test('nightly grouped verification independently certifies each successful immutable sibling for resume', () => {
  const verifier = workflow('verify-release-resume-candidates.yml');
  for (const output of ['cli_verified', 'stack_verified', 'server_verified', 'ui_web_verified']) {
    assert.ok(verifier.on.workflow_call.outputs[output], `missing per-product output ${output}`);
  }
  const verifyJob = verifier.jobs.verify;
  const productSteps = new Map(
    verifyJob.steps
      .filter((step) => String(step.id ?? '').startsWith('verify_'))
      .map((step) => [step.id, step]),
  );
  for (const id of ['verify_cli', 'verify_stack', 'verify_server', 'verify_ui_web']) {
    const step = productSteps.get(id);
    assert.ok(step, `missing independent ${id} step`);
    assert.equal(step['continue-on-error'], true);
    assert.equal(step.uses, './.release-control/.github/actions/verify-immutable-release-candidate');
    assert.match(step.if, /always\(\)/);
  }

  const owner = action('verify-immutable-release-candidate');
  const ownerSource = owner.runs.steps.map((step) => step.run ?? '').join('\n');
  assert.match(ownerSource, /verify-release-candidate-identity\.mjs/);
  assert.match(ownerSource, /releases\/assets\/\$\{asset_id\}/);
  assert.doesNotMatch(ownerSource, /gh release download/);
  assert.match(ownerSource, /verify-artifacts\.mjs/);
  const downloadStep = owner.runs.steps.find((step) => step.id === 'download');
  const verifyStep = owner.runs.steps.find((step) => step.id === 'verify');
  assert.ok(downloadStep?.env.GH_TOKEN);
  assert.ok(downloadStep?.env.GITHUB_TOKEN);
  assert.equal('GH_TOKEN' in (verifyStep?.env ?? {}), false);
  assert.equal('GITHUB_TOKEN' in (verifyStep?.env ?? {}), false);

  const grouped = workflow('release-verify.yml').jobs.verify_candidate;
  for (const id of ['cli', 'stack', 'server', 'ui_web']) {
    const step = grouped.steps.find((candidate) => candidate.id === `verify_${id}`);
    assert.ok(step, `grouped verifier must delegate ${id} to the shared owner`);
    assert.equal(step.uses, './.release-control/.github/actions/verify-immutable-release-candidate');
    assert.match(step.if, /always\(\)/);
  }

  for (const [name, groupedJob, candidates] of [
    ['nightly-dev.yml', 'release_verify', ['cli', 'hstack', 'server_runtime', 'ui_web']],
  ]) {
    const parsed = workflow(name);
    const independent = parsed.jobs.verify_resume_candidates;
    assert.ok(independent, `${name} must independently certify successful siblings`);
    assert.ok(needs(independent).includes(groupedJob));
    for (const candidate of candidates) assert.ok(needs(independent).includes(candidate));
    assert.match(independent.if, /always\(\)/);
    assert.match(independent.if, new RegExp(`needs\\.${groupedJob}\\.result != 'success'`));
    for (const input of ['candidate_cli_version', 'candidate_stack_version', 'candidate_server_version', 'candidate_ui_web_version']) {
      assert.match(independent.with[input], /\.result == 'success'/);
    }
    assert.ok(needs(parsed.jobs.release_status).includes('verify_resume_candidates'));
  }
});

test('nightly-dev replaces its singleton status artifact safely on a GitHub rerun', () => {
  const parsed = workflow('nightly-dev.yml');
  const upload = parsed.jobs.release_status.steps.find((step) => step.with?.name === 'happier-release-status');
  assert.ok(upload, 'nightly-dev.yml must upload the canonical release status artifact');
  assert.equal(upload.with.overwrite, true);
});

test('release.yml defaults its replaceable status artifact to the canonical name', () => {
  const parsed = workflow('release-channel.yml');
  assert.equal(parsed.on.workflow_call.inputs.combined_preview_production.default, false);
  const upload = parsed.jobs.release_status.steps.find(
    (step) => String(step.with?.name).includes('happier-release-status-{0}'),
  );
  assert.ok(upload, 'release.yml must upload the selected release status artifact');
  assert.equal(upload.with.overwrite, true);
});

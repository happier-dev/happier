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
  assert.match(source, /actions\/artifacts\/\$\{STATUS_ARTIFACT_ID\}\/zip/);
  assert.match(source, /sha256sum/);
  assert.match(source, /test "sha256:\$\{actual_digest\}" = "\$\{EXPECTED_DIGEST\}"/);
  assert.match(source, /resolve-release-resume\.mjs[\s\S]*--mode resolve/);
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
  assert.ok(parsed.on.workflow_dispatch.inputs.resume_run_id);
  assert.equal(parsed.jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_workflow, '.github/workflows/nightly-dev.yml');
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
});

test('full release resume binds the prior run to the same operation and authorized source', () => {
  const parsed = workflow('release.yml');
  assert.ok(parsed.on.workflow_dispatch.inputs.resume_run_id);
  assert.equal(parsed.jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_workflow, '.github/workflows/release.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(parsed.jobs.resolve_resume.with.expected_operation_id, '${{ inputs.hmaint_operation_id }}');
  assert.ok(needs(parsed.jobs.plan).includes('resolve_resume'));
  assert.match(parsed.jobs.plan.if, /needs\.resolve_resume\.result == 'success'/);
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
  assert.equal(statusProjection.env.CLI_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.cli_verified }}');
  assert.equal(statusProjection.env.IMMUTABLE_VERIFICATION_RESULT, '${{ needs.verify_release_candidates.result }}');
  assert.match(String(parsed.jobs.plan.outputs.publish_docker_needed), /needs\.resolve_resume\.outputs\.docker_requested == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.if), /needs\.plan\.outputs\.publish_docker_needed == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.if), /needs\.resolve_resume\.outputs\.docker_complete != 'true'/);
  assert.match(String(parsed.jobs.publish_docker.with.build_relay), /needs\.plan\.outputs\.publish_docker_relay_needed == 'true'/);
  assert.match(String(parsed.jobs.publish_docker.with.build_dev_box), /needs\.plan\.outputs\.publish_docker_dev_box_needed == 'true'/);
  assert.match(String(statusProjection.env.REQUEST_DOCKER), /needs\.resolve_resume\.outputs\.docker_requested == 'true'/);
  assert.ok(needs(parsed.jobs.deploy_ui).includes('resolve_resume'));
  assert.match(String(parsed.jobs.deploy_plan.outputs.deploy_ui_requested), /needs\.resolve_resume\.outputs\.deploy_ui_requested == 'true'/);
  assert.match(String(parsed.jobs.deploy_ui.if), /needs\.deploy_plan\.outputs\.deploy_ui_requested == 'true'/);
  assert.match(String(parsed.jobs.deploy_ui.if), /needs\.resolve_resume\.outputs\.deploy_ui_complete != 'true'/);
  assert.match(String(parsed.jobs.deploy_ui.with.desktop_mode), /needs\.deploy_plan\.outputs\.deploy_ui_desktop_mode/);
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
  for (const name of ['DEPLOY_UI_RESUME_COMPLETE', 'DEPLOY_SERVER_RESUME_COMPLETE', 'DEPLOY_WEBSITE_RESUME_COMPLETE', 'DEPLOY_DOCS_RESUME_COMPLETE', 'DOCKER_RESUME_COMPLETE', 'NPM_RESUME_COMPLETE']) {
    assert.match(String(statusProjection.env[name]), /needs\.resolve_resume\.outputs\./, `${name} must preserve accepted resume evidence`);
  }
});

test('failed grouped verification independently certifies each successful immutable sibling for resume', () => {
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
    ['release.yml', 'verify_release_candidates', ['publish_cli_binaries', 'publish_hstack_binaries', 'publish_server_runtime', 'publish_ui_web']],
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

for (const name of ['nightly-dev.yml', 'release.yml']) {
  test(`${name} replaces its singleton status artifact safely on a GitHub rerun`, () => {
    const parsed = workflow(name);
    const upload = parsed.jobs.release_status.steps.find((step) => step.with?.name === 'happier-release-status');
    assert.ok(upload, `${name} must upload the canonical release status artifact`);
    assert.equal(upload.with.overwrite, true);
  });
}

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
  ]) {
    assert.ok(parsed.on.workflow_call.outputs[output], `missing resume output ${output}`);
  }
  const resolveJob = parsed.jobs.resolve;
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
  ['publish-cli-binaries.yml', ['prepare', 'build_native', 'finalize_darwin', 'publish']],
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
  assert.equal(parsed.jobs.release_verify.with.verify_cli_release, "${{ needs.resolve_resume.outputs.cli_version == '' }}");
  assert.equal(parsed.jobs.release_verify.with.verify_stack_release, "${{ needs.resolve_resume.outputs.stack_version == '' }}");
  assert.equal(parsed.jobs.release_verify.with.verify_server_release, "${{ needs.resolve_resume.outputs.server_version == '' }}");
  assert.equal(parsed.jobs.release_verify.with.verify_ui_web_release, "${{ needs.resolve_resume.outputs.ui_web_version == '' }}");
  assert.equal(parsed.jobs.release_verify.with.risk_cli_upgrade, "${{ needs.resolve_validation_risk.outputs.risk_cli_upgrade == 'true' }}");
  assert.equal(parsed.jobs.release_verify.with.risk_session_continuity, "${{ needs.resolve_validation_risk.outputs.risk_session_continuity == 'true' }}");
  assert.equal(parsed.jobs.release_verify.with.risk_relay_upgrade, false);
  assert.match(
    parsed.jobs.resolve_validation_risk.steps.map((step) => step.run ?? '').join('\n'),
    /ui-web-dev\^\{commit\}[\s\S]*analyze-release-change\.mjs[\s\S]*--github-output/,
  );
  const riskStep = parsed.jobs.resolve_validation_risk.steps.find((step) => step.id === 'risk');
  assert.equal(riskStep['working-directory'], 'release-source');
  assert.match(riskStep.run, /node \.\.\/scripts\/pipeline\/release\/analyze-release-change\.mjs/);
  assert.match(riskStep.run, /--channel dev/);
  assert.doesNotMatch(riskStep.run, /node scripts\//, 'nightly candidate source must remain inert during risk selection');
  const statusSource = parsed.jobs.release_status.steps.map((step) => step.run ?? '').join('\n');
  assert.match(statusSource, /project-release-status\.mjs[\s\S]*--mode nightly/);
  const projection = parsed.jobs.release_status.steps.find((step) => String(step.name).includes('Project nightly'));
  assert.equal(projection.env.CLI_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.cli_verified }}');
  assert.equal(projection.env.HSTACK_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.stack_verified }}');
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
  assert.match(parsed.jobs.plan.outputs.publish_cli_binaries_needed, /needs\.resolve_resume\.outputs\.cli_requested/);
  assert.match(parsed.jobs.plan.outputs.publish_stack, /needs\.resolve_resume\.outputs\.stack_requested/);
  assert.match(parsed.jobs.plan.outputs.publish_server_runtime_needed, /needs\.resolve_resume\.outputs\.server_requested/);
  assert.match(parsed.jobs.publish_ui_web.if, /needs\.resolve_resume\.outputs\.ui_web_requested/);
  for (const [jobName, output] of [
    ['publish_cli_binaries', 'cli_version'],
    ['publish_hstack_binaries', 'stack_version'],
    ['publish_server_runtime', 'server_version'],
    ['publish_ui_web', 'ui_web_version'],
  ]) {
    assert.ok(needs(parsed.jobs[jobName]).includes('resolve_resume'));
    assert.equal(parsed.jobs[jobName].with.resume_version, `\${{ needs.resolve_resume.outputs.${output} }}`);
  }
  assert.equal(parsed.jobs.verify_release_candidates.with.verify_cli_release, "${{ needs.publish_cli_binaries.result == 'success' && needs.resolve_resume.outputs.cli_version == '' }}");
  assert.equal(parsed.jobs.verify_release_candidates.with.verify_stack_release, "${{ needs.publish_hstack_binaries.result == 'success' && needs.resolve_resume.outputs.stack_version == '' }}");
  assert.equal(parsed.jobs.verify_release_candidates.with.verify_server_release, "${{ needs.publish_server_runtime.result == 'success' && needs.resolve_resume.outputs.server_version == '' }}");
  assert.equal(parsed.jobs.verify_release_candidates.with.verify_ui_web_release, "${{ needs.publish_ui_web.result == 'success' && needs.resolve_resume.outputs.ui_web_version == '' }}");
  const statusSource = parsed.jobs.release_status.steps.map((step) => step.run ?? '').join('\n');
  assert.match(statusSource, /project-release-status\.mjs[\s\S]*--mode standard/);
  const projection = parsed.jobs.release_status.steps.find((step) => String(step.name).includes('Project release status facts'));
  assert.equal(projection.env.CLI_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.cli_verified }}');
  assert.equal(projection.env.SERVER_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.server_verified }}');
});

test('failed aggregate verification independently certifies successful immutable siblings for resume', () => {
  const verifier = workflow('verify-release-resume-candidates.yml');
  for (const output of ['cli_verified', 'stack_verified', 'server_verified', 'ui_web_verified']) {
    assert.ok(verifier.on.workflow_call.outputs[output], `missing per-product output ${output}`);
  }
  const verifyJob = verifier.jobs.verify;
  for (const id of ['verify_cli', 'verify_stack', 'verify_server', 'verify_ui_web']) {
    const step = verifyJob.steps.find((candidate) => candidate.id === id);
    assert.ok(step, `missing independent ${id} step`);
    assert.equal(step['continue-on-error'], true);
    assert.equal(step.uses, './.release-control/.github/actions/verify-immutable-release-candidate');
    assert.match(step.if, /always\(\)/);
  }
  const outputSource = verifyJob.steps.find((step) => step.id === 'outputs')?.run ?? '';
  for (const id of ['cli', 'stack', 'server', 'ui_web']) {
    assert.match(outputSource, new RegExp(`emit_result ${id} `));
  }

  const owner = action('verify-immutable-release-candidate');
  const ownerSource = owner.runs.steps.map((step) => step.run ?? '').join('\n');
  assert.match(ownerSource, /verify-release-candidate-identity\.mjs/);
  assert.match(ownerSource, /gh release download/);
  assert.match(ownerSource, /verify-artifacts\.mjs/);
  const downloadStep = owner.runs.steps.find((step) => step.id === 'download');
  const verifyStep = owner.runs.steps.find((step) => step.id === 'verify');
  assert.ok(downloadStep?.env.GH_TOKEN);
  assert.ok(downloadStep?.env.GITHUB_TOKEN);
  assert.equal('GH_TOKEN' in (verifyStep?.env ?? {}), false);
  assert.equal('GITHUB_TOKEN' in (verifyStep?.env ?? {}), false);

  const grouped = workflow('release-verify.yml').jobs.verify_candidate_identity;
  assert.ok(
    grouped.steps.some((step) => /--candidate-build-run-id "\$CANDIDATE_BUILD_RUN_ID"[\s\S]*--publication-run-id "\$PUBLICATION_RUN_ID"[\s\S]*--derive-targets true/.test(step.run ?? '')),
    'aggregate run provenance and release targets must remain owned by the canonical verifier',
  );
  for (const id of ['cli', 'stack', 'server', 'ui_web']) {
    const step = grouped.steps.find((candidate) => candidate.id === `verify_${id}`);
    assert.ok(step, `aggregate verifier must delegate ${id} artifact verification to the shared owner`);
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
    assert.match(independent.if, new RegExp(`needs\\.${groupedJob}\\.result != 'success'`));
    assert.ok(needs(parsed.jobs.release_status).includes('verify_resume_candidates'));
    for (const promotion of Object.values(parsed.jobs).filter((job) => String(job.name ?? '').startsWith('Promote verified') || String(job.name ?? '').startsWith('Recover rolling'))) {
      assert.equal(needs(promotion).includes('verify_resume_candidates'), false, 'independent evidence must never gate promotion');
    }
  }
});

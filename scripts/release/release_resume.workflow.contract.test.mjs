import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function workflow(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8'));
}

function needs(job) {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

test('one trusted reusable workflow resolves prior release candidates by exact run and fatal digest verification', () => {
  const parsed = workflow('resolve-release-resume.yml');
  assert.ok(parsed.on.workflow_call.inputs.origin_run_id);
  assert.ok(parsed.on.workflow_call.inputs.expected_workflow);
  assert.ok(parsed.on.workflow_call.inputs.expected_channel);
  for (const output of ['source_sha', 'cli_version', 'stack_version', 'server_version', 'ui_web_version']) {
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
  const statusSource = parsed.jobs.release_status.steps.map((step) => step.run ?? '').join('\n');
  assert.match(statusSource, /CLI_VERSION/);
  assert.match(statusSource, /\['cli', \['cli', 'CLI_VERSION'\]\]/);
  assert.match(statusSource, /\['hstack', \['stack', 'HSTACK_VERSION'\]\]/);
  assert.match(statusSource, /normalizeResult\(process\.env\.VERIFY_RESULT\) === 'success'/);
});

test('full release rejects invalid resume provenance before planning and reuses only bound candidates', () => {
  const parsed = workflow('release.yml');
  assert.ok(parsed.on.workflow_dispatch.inputs.resume_run_id);
  assert.equal(parsed.jobs.resolve_resume.uses, './.github/workflows/resolve-release-resume.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_workflow, '.github/workflows/release.yml');
  assert.equal(parsed.jobs.resolve_resume.with.expected_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.ok(needs(parsed.jobs.plan).includes('resolve_resume'));
  assert.match(parsed.jobs.plan.if, /needs\.resolve_resume\.result == 'success'/);
  for (const [jobName, output] of [
    ['publish_cli_binaries', 'cli_version'],
    ['publish_hstack_binaries', 'stack_version'],
    ['publish_server_runtime', 'server_version'],
    ['publish_ui_web', 'ui_web_version'],
  ]) {
    assert.ok(needs(parsed.jobs[jobName]).includes('resolve_resume'));
    assert.equal(parsed.jobs[jobName].with.resume_version, `\${{ needs.resolve_resume.outputs.${output} }}`);
    assert.equal(parsed.jobs[jobName].with.authorized_sha, '${{ needs.bind_server_source.outputs.authorized_sha }}');
  }
  const statusSource = parsed.jobs.release_status.steps.map((step) => step.run ?? '').join('\n');
  assert.match(statusSource, /CLI_VERSION/);
  assert.match(statusSource, /product:\s*'cli'/);
  assert.match(statusSource, /normalizeResult\(process\.env\.CANDIDATE_VERIFY_RESULT\) === 'success'/);
});

for (const name of ['nightly-dev.yml', 'release.yml']) {
  test(`${name} replaces its singleton status artifact safely on a GitHub rerun`, () => {
    const parsed = workflow(name);
    const upload = parsed.jobs.release_status.steps.find((step) => step.with?.name === 'happier-release-status');
    assert.ok(upload, `${name} must upload the canonical release status artifact`);
    assert.equal(upload.with.overwrite, true);
  });
}

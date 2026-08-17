import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('nightly-dev verifies exact immutable candidates before promoting any user-consumed dev reference', async () => {
  const [raw, releaseVerifyRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8'),
  ]);
  const workflow = YAML.parse(raw);
  const releaseVerifyWorkflow = YAML.parse(releaseVerifyRaw);

  assert.match(raw, /release_verify:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, hstack, server_runtime, ui_web, resolve_validation_risk\]/);
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*dev/,
    'nightly-dev should validate the dev channel through release-verify',
  );
  assert.match(
    raw,
    /permissions:\s*[\s\S]*?actions:\s*read/,
    'nightly-dev should grant actions: read because the reusable release-verify workflow requires it',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?secrets:\s*inherit/,
    'nightly-dev should inherit secrets for the reusable release-verify workflow',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?validation_profile:\s*integrated/,
    'nightly-dev should select the bounded integrated profile rather than a parallel toggle fleet',
  );

  const candidate = workflow.jobs.prepare_release_candidate;
  assert.ok(candidate, 'nightly must bind its requested source ref once before parallel publication');
  assert.equal(candidate.outputs.source_sha, '${{ steps.identity.outputs.source_sha }}');
  assert.equal(candidate.outputs.release_message, '${{ steps.identity.outputs.release_message }}');
  assert.doesNotMatch(
    JSON.stringify(candidate.steps),
    /project-release-notes\.mjs/,
    'automatic nightlies must not require a human-authored canonical release-note entry',
  );
  assert.match(JSON.stringify(candidate.steps), /Automated nightly dev release\./);

  const exactSha = '${{ needs.prepare_release_candidate.outputs.source_sha }}';
  for (const jobName of ['cli', 'hstack', 'server_runtime', 'ui_web']) {
    const job = workflow.jobs[jobName];
    assert.ok(job.needs.includes('prepare_release_candidate'), `${jobName} must wait for the exact nightly candidate`);
    assert.equal(job.with.source_ref, exactSha, `${jobName} must consume the exact nightly candidate SHA`);
  }
  for (const jobName of ['cli', 'hstack', 'server_runtime', 'ui_web', 'docker']) {
    assert.equal(
      workflow.jobs[jobName].with.authorized_sha,
      exactSha,
      `${jobName} must enforce the caller-authorized nightly candidate SHA`,
    );
  }
  for (const jobName of ['cli', 'hstack', 'server_runtime', 'ui_web']) {
    assert.equal(workflow.jobs[jobName].with.publish_rolling, false, `${jobName} must stop after immutable publication`);
  }

  const releaseVerify = workflow.jobs.release_verify;
  for (const [inputName, input] of Object.entries(releaseVerifyWorkflow.on.workflow_call.inputs)) {
    if (input.required === true) {
      assert.ok(
        Object.hasOwn(releaseVerify.with, inputName),
        `nightly release verification must supply required reusable input ${inputName}`,
      );
    }
  }
  assert.equal(releaseVerify.with.candidate_source_sha, exactSha);
  assert.equal(releaseVerify.with.candidate_build_run_id, '${{ github.run_id }}');
  assert.equal(releaseVerify.with.publication_run_id, '${{ github.run_id }}');
  assert.equal(releaseVerify.with.candidate_cli_version, '${{ needs.cli.outputs.version }}');
  assert.equal(releaseVerify.with.candidate_stack_version, '${{ needs.hstack.outputs.version }}');
  assert.equal(releaseVerify.with.candidate_server_version, '${{ needs.server_runtime.outputs.version }}');
  assert.equal(releaseVerify.with.candidate_ui_web_version, '${{ needs.ui_web.outputs.version }}');
  assert.equal(releaseVerify.with.verify_cli_release, "${{ needs.resolve_resume.outputs.cli_version == '' }}");
  assert.equal(releaseVerify.with.verify_stack_release, "${{ needs.resolve_resume.outputs.stack_version == '' }}");
  assert.equal(releaseVerify.with.verify_server_release, "${{ needs.resolve_resume.outputs.server_version == '' }}");
  assert.equal(releaseVerify.with.verify_ui_web_release, "${{ needs.resolve_resume.outputs.ui_web_version == '' }}");

  const orderedPromotions = ['promote_server', 'promote_hstack', 'promote_cli', 'promote_ui_web'];
  const requiredPredecessor = {
    promote_server: 'release_verify',
    promote_hstack: 'promote_server',
    promote_cli: 'promote_hstack',
    promote_ui_web: 'promote_cli',
  };
  const immutableVersionSource = {
    promote_server: '${{ needs.server_runtime.outputs.version }}',
    promote_hstack: '${{ needs.hstack.outputs.version }}',
    promote_cli: '${{ needs.cli.outputs.version }}',
    promote_ui_web: '${{ needs.ui_web.outputs.version }}',
  };
  for (const jobName of orderedPromotions) {
    const job = workflow.jobs[jobName];
    assert.ok(
      job.needs.includes('prepare_release_candidate'),
      `${jobName} must directly depend on the exact-candidate notes producer`,
    );
    assert.ok(job.needs.includes(requiredPredecessor[jobName]), `${jobName} must follow the safe promotion order`);
    assert.equal(job.with.retry_version, immutableVersionSource[jobName]);
  }

  assert.ok(workflow.jobs.ui_mobile.needs.includes('release_verify'));
  assert.ok(workflow.jobs.ui_desktop.needs.includes('release_verify'));
  assert.ok(workflow.jobs.docker.needs.includes('promote_ui_web'));
  assert.ok(workflow.jobs.verify_promoted.needs.includes('docker'));
  assert.ok(workflow.jobs.verify_promoted.needs.includes('ui_mobile'));
  assert.ok(workflow.jobs.verify_promoted.needs.includes('ui_desktop'));

  const status = workflow.jobs.release_status;
  assert.ok(status, 'nightly must project terminal release status even when upstream work fails');
  assert.equal(status.if, '${{ always() }}');
  const projection = status.steps.find((step) => step.name === 'Project nightly release status facts');
  assert.equal(projection.env.RELEASE_RUN_URL, 'https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}');
  assert.match(projection.run, /project-release-status\.mjs/);
  assert.equal(projection.env.CLI_RESUME_VERIFIED, '${{ needs.verify_resume_candidates.outputs.cli_verified }}');
  assert.equal(projection.env.IMMUTABLE_VERIFICATION_RESULT, '${{ needs.release_verify.result }}');
  assert.match(JSON.stringify(status.steps), /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.equal(
    status.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@')).with.name,
    'happier-release-status',
  );
});

test('ordinary nightlies advance the pre-bound source issue snapshot only after dev promotion is verified', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const snapshot = workflow.jobs.snapshot_source_issues;
  const advance = workflow.jobs.advance_source_issues_to_dev;

  assert.deepEqual(snapshot.needs, ['resolve_resume']);
  assert.equal(snapshot.permissions.issues, 'read');
  assert.match(JSON.stringify(snapshot.steps), /reconcile-issue-stage\.mjs snapshot/);
  assert.match(JSON.stringify(snapshot.steps), /stage:source/);
  assert.ok(workflow.jobs.prepare_release_candidate.needs.includes('snapshot_source_issues'));

  assert.deepEqual(advance.needs, ['snapshot_source_issues', 'verify_promoted']);
  assert.equal(advance.permissions.issues, 'write');
  assert.match(String(advance.if), /needs\.verify_promoted\.result == 'success'/);
  assert.match(JSON.stringify(advance.steps), /reconcile-issue-stage\.mjs advance/);
  assert.match(JSON.stringify(advance.steps), /stage:source/);
  assert.match(JSON.stringify(advance.steps), /stage:dev/);
});

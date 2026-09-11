import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('combined preview and production release validates the exact source once before concurrent channel publication', async () => {
  const [release, combined, sourceValidation, tests] = await Promise.all([
    workflow('release.yml'),
    workflow('release-preview-and-production.yml'),
    workflow('release-source-validation.yml'),
    workflow('tests.yml'),
  ]);

  assert.ok(release.on.workflow_call, 'the canonical channel workflow must be reusable');
  assert.equal(release.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.equal(release.concurrency.group, 'release-unified-${{ inputs.environment }}');
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(release.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  assert.match(String(release.jobs.source_validation.if), /inputs\.shared_source_validation != true/u);
  assert.equal(release.jobs.mysql_db_contract, undefined);
  assert.equal(release.jobs.platform_service_validation, undefined);
  assert.equal(release.jobs.trust_root_validation, undefined);
  assert.doesNotMatch(
    JSON.stringify(release.jobs.release_preflight),
    /verify-existing-ci\.mjs/u,
    'exact-SHA CI verification belongs only to the shared source-validation owner',
  );

  const preview = combined.jobs.release_preview;
  const production = combined.jobs.release_production;
  const validation = combined.jobs.source_validation;
  assert.equal(validation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(validation.with.base_refs, 'preview,main');
  assert.equal(validation.with.source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(sourceValidation.on.workflow_call.inputs.base_refs.type, 'string');
  assert.equal(preview.uses, './.github/workflows/release.yml');
  assert.equal(production.uses, './.github/workflows/release.yml');
  assert.deepEqual(preview.needs, ['snapshot_release_issues', 'source_validation']);
  assert.deepEqual(production.needs, ['snapshot_release_issues', 'source_validation']);
  assert.notEqual(preview.needs, 'release_production');
  assert.notEqual(production.needs, 'release_preview');
  assert.equal(preview.with.environment, 'preview');
  assert.equal(preview.with.confirm, 'release dev to preview');
  assert.equal(production.with.environment, 'production');
  assert.equal(production.with.confirm, 'release dev to main');
  assert.equal(preview.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(production.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(combined.on.workflow_dispatch.inputs.ci_run_id, undefined);
  assert.equal(preview.with.approve_public_sdk_release, '${{ inputs.approve_public_sdk_release }}');
  assert.equal(production.with.approve_public_sdk_release, '${{ inputs.approve_public_sdk_release }}');
  assert.equal(preview.with.public_sdk_release_approval, '${{ inputs.public_sdk_release_approval }}');
  assert.equal(production.with.public_sdk_release_approval, '${{ inputs.public_sdk_release_approval }}');
  assert.equal(preview.with.combined_preview_production, true);
  assert.equal(production.with.combined_preview_production, true);
  assert.equal(preview.with.shared_source_validation, true);
  assert.equal(production.with.shared_source_validation, true);
  assert.equal(preview.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');
  assert.equal(production.with.shared_source_validation_sha, '${{ needs.source_validation.outputs.source_sha }}');

  for (const jobName of [
    'self-host-systemd-e2e',
    'self-host-launchd-e2e',
    'self-host-schtasks-e2e',
    'self-host-daemon-e2e',
  ]) {
    const checkout = tests.jobs[jobName].steps.find((step) => step.name === 'Checkout');
    assert.equal(
      checkout.with.ref,
      "${{ inputs.checkout_sha != '' && inputs.checkout_sha || github.sha }}",
      `${jobName} must validate the exact source selected by the release gate`,
    );
  }

  const advance = combined.jobs.advance_release_issues;
  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_preview', 'release_production']);
  assert.match(String(advance.if), /needs\.release_preview\.result == 'success'/u);
  assert.match(String(advance.if), /needs\.release_production\.result == 'success'/u);
  const reconcile = advance.steps.find((step) => step.name === 'Advance the initially eligible issues directly to stable')?.run ?? '';
  assert.match(reconcile, /--from-stage "stage:source"[\s\S]*--to-stage "stage:stable"/u);
  assert.match(reconcile, /--from-stage "stage:dev"[\s\S]*--to-stage "stage:stable"/u);

  for (const forbiddenJob of ['plan', 'publish_cli_binaries', 'publish_server_runtime', 'deploy_ui']) {
    assert.equal(combined.jobs[forbiddenJob], undefined, `combined workflow must not copy the canonical ${forbiddenJob} job`);
  }
});

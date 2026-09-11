import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local resumes TestFlight distribution from trusted control without rebuilding the IPA', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'),
    'utf8',
  );
  const workflow = YAML.parse(source);
  const dispatchInputs = workflow?.on?.workflow_dispatch?.inputs;
  const callInputs = workflow?.on?.workflow_call?.inputs;

  assert.ok(dispatchInputs?.action?.options?.includes('retry_testflight_distribution'));
  assert.ok(dispatchInputs?.retry_testflight_eas_build_id);
  assert.ok(dispatchInputs?.retry_testflight_build_number);
  assert.ok(dispatchInputs?.retry_testflight_app_version);
  assert.ok(callInputs?.retry_testflight_build_number);
  assert.ok(callInputs?.retry_testflight_app_version);
  assert.ok(callInputs?.retry_testflight_eas_build_id);

  const retry = workflow?.jobs?.retry_testflight_distribution;
  assert.ok(retry, 'expected a dedicated TestFlight distribution retry job');
  assert.equal(retry.if, "${{ inputs.action == 'retry_testflight_distribution' }}");
  assert.deepEqual(retry.needs, ['release_actor_guard', 'validate_apple_api_private_key']);
  assert.equal(retry['runs-on'], 'ubuntu-latest');
  assert.equal(retry.permissions?.contents, 'read');

  const checkout = retry.steps?.find((step) => step.name === 'Checkout trusted workflow control bytes');
  assert.equal(checkout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout?.with?.['persist-credentials'], false);

  const attach = retry.steps?.find((step) => step.name === 'Attach existing processed build to TestFlight groups');
  assert.equal(attach?.env?.APPLE_API_PRIVATE_KEY, '${{ secrets.APPLE_API_PRIVATE_KEY }}');
  assert.equal(retry.env?.APPLE_API_PRIVATE_KEY, undefined, 'Apple private key must remain step-scoped');
  assert.match(attach?.run ?? '', /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(attach?.run ?? '', /--build-number "\$RETRY_TESTFLIGHT_BUILD_NUMBER"/);
  assert.match(attach?.run ?? '', /--app-version "\$RETRY_TESTFLIGHT_APP_VERSION"/);
  assert.match(attach?.run ?? '', /--eas-build-id "\$RETRY_TESTFLIGHT_EAS_BUILD_ID"/);
  assert.match(attach?.run ?? '', /--external-groups "\$external_groups"/);
  assert.match(attach?.run ?? '', /--submit-beta-review "\$submit_beta_review"/);
  assert.match(attach?.run ?? '', /--wait-processing "\$wait_processing"/);
  assert.match(attach?.run ?? '', /--processing-timeout-seconds "\$processing_timeout"/);

  const serializedRetry = JSON.stringify(retry);
  assert.doesNotMatch(serializedRetry, /Install dependencies|native-build\.mjs|ui-mobile-release/);

  const buildIos = workflow.jobs?.build_ios;
  assert.equal(buildIos?.permissions?.actions, 'write');
  assert.equal(buildIos?.permissions?.contents, 'read');
  assert.ok(buildIos?.steps?.some((step) => step.name === 'Checkout trusted deferred TestFlight control bytes'));
  const build = buildIos?.steps?.find((step) => step.name === 'EAS build (local runner) (pipeline)');
  assert.equal(build?.env?.HAPPIER_PIPELINE_REPO_ROOT, '${{ github.workspace }}');
  assert.match(build?.run ?? '', /\.testflight-control\/scripts\/pipeline\/run\.mjs/);
  assert.match(build?.run ?? '', /--testflight-distribution-mode deferred/);
  const dispatch = buildIos?.steps?.find((step) => step.name === 'Dispatch exact TestFlight reconciliation');
  assert.match(dispatch?.run ?? '', /dispatch-testflight-reconciliation\.mjs/);

  assert.match(workflow.jobs?.validate_expo_token?.if ?? '', /action != 'retry_testflight_distribution'/);
  assert.match(workflow.jobs?.validate_apple_api_private_key?.if ?? '', /action == 'retry_testflight_distribution'/);
  assert.match(workflow.jobs?.build_android?.if ?? '', /action != 'retry_testflight_distribution'/);
  assert.match(workflow.jobs?.build_ios?.if ?? '', /action != 'retry_testflight_distribution'/);

  const uploadIos = workflow.jobs?.build_ios?.steps?.find((step) => step.name === 'Upload mobile build artifact');
  const uploadAndroid = workflow.jobs?.build_android?.steps?.find((step) => step.name === 'Upload mobile build artifact');
  assert.equal(uploadAndroid?.if, '${{ always() }}');
  assert.equal(uploadIos?.if, '${{ always() }}');
});

test('build-ui-mobile-local resubmits a preserved Android store artifact from trusted control without rebuilding the AAB', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'),
    'utf8',
  );
  const workflow = YAML.parse(source);
  const dispatchInputs = workflow?.on?.workflow_dispatch?.inputs;
  const callInputs = workflow?.on?.workflow_call?.inputs;

  assert.ok(dispatchInputs?.action?.options?.includes('retry_android_store_submit'));
  assert.ok(dispatchInputs?.retry_store_run_id);
  assert.ok(dispatchInputs?.retry_store_source_sha);
  assert.ok(callInputs?.retry_store_run_id);
  assert.ok(callInputs?.retry_store_source_sha);

  const retry = workflow?.jobs?.retry_android_store_submit;
  assert.ok(retry, 'expected a dedicated Android store submission retry job');
  assert.equal(retry.if, "${{ inputs.action == 'retry_android_store_submit' }}");
  assert.deepEqual(retry.needs, ['release_actor_guard', 'validate_expo_token']);
  assert.equal(retry['runs-on'], 'ubuntu-latest');
  assert.equal(retry.permissions?.actions, 'read');
  assert.equal(retry.permissions?.contents, 'read');

  const checkout = retry.steps?.find((step) => step.name === 'Checkout trusted workflow control bytes');
  assert.equal(checkout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout?.with?.['persist-credentials'], false);

  const bind = retry.steps?.find((step) => step.name === 'Bind origin run and source identity');
  assert.equal(bind?.env?.RETRY_STORE_RUN_ID, '${{ inputs.retry_store_run_id }}');
  assert.equal(bind?.env?.RETRY_STORE_SOURCE_SHA, '${{ inputs.retry_store_source_sha }}');
  assert.match(bind?.run ?? '', /origin_status=.*actions\/runs\/\$\{RETRY_STORE_RUN_ID\}/);
  assert.match(bind?.run ?? '', /origin_status" = completed/);
  assert.match(bind?.run ?? '', /ORIGIN_HEAD_SHA/);

  const download = retry.steps?.find((step) => step.name === 'Download preserved Android build artifact');
  assert.equal(download?.with?.['run-id'], '${{ inputs.retry_store_run_id }}');
  assert.equal(download?.with?.name, 'ui-mobile-${{ inputs.environment }}-android');
  assert.equal(download?.with?.path, 'retry-artifact');

  const submit = retry.steps?.find((step) => step.name === 'Verify candidate identity and resubmit exact AAB');
  assert.match(submit?.run ?? '', /Expected exactly one preserved Android AAB/);
  assert.match(submit?.run ?? '', /candidate-identity\.json/);
  assert.match(submit?.run ?? '', /identity\.candidateSha !== process\.env\.RETRY_STORE_SOURCE_SHA/);
  assert.match(submit?.run ?? '', /ORIGIN_HEAD_SHA.*RETRY_STORE_SOURCE_SHA/);
  assert.match(submit?.run ?? '', /prepare-static-submit-workspace\.mjs/);
  assert.match(submit?.run ?? '', /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(submit?.run ?? '', /--project-dir "\$submit_workspace"/);
  assert.match(submit?.run ?? '', /--path "\$aab"/);
  assert.match(submit?.run ?? '', /--wait true/, 'recovery must report the terminal EAS submission result');
  assert.doesNotMatch(JSON.stringify(retry), /Install dependencies|native-build\.mjs|ui-mobile-release/);

  assert.match(workflow.jobs?.validate_expo_token?.if ?? '', /action == 'retry_android_store_submit'/);
  assert.match(workflow.jobs?.build_android?.if ?? '', /action != 'retry_android_store_submit'/);
  assert.match(workflow.jobs?.build_ios?.if ?? '', /action != 'retry_android_store_submit'/);

  const persistIdentity = workflow.jobs?.build_android?.steps?.find(
    (step) => step.name === 'Persist Android candidate identity for recovery',
  );
  assert.equal(persistIdentity?.if, '${{ always() }}');
  assert.equal(persistIdentity?.env?.CANDIDATE_SHA, '${{ steps.candidate.outputs.candidate_sha }}');
  assert.match(persistIdentity?.run ?? '', /candidate-identity\.json/);
});

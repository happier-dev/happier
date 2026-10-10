import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('Android source build cannot publish APKs and trusted control publishes the bound artifact', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  const build = workflow.jobs.build_android;
  assert.equal(build.permissions.contents, 'read');
  assert.doesNotMatch(JSON.stringify(build), /MINISIGN_|GH_TOKEN|RELEASE_BOT_|publish-apk-release\.mjs/);
  assert.match(build.steps.find((step) => step.name === 'EAS build (local runner) (pipeline)').run, /--publish-apk-release false/);
  assert.equal(build.outputs.candidate_sha, '${{ steps.candidate.outputs.candidate_sha }}');
  assert.equal(build.outputs.app_version, '${{ steps.candidate.outputs.app_version }}');
  const publish = workflow.jobs.publish_android_apk;
  assert.ok(publish.needs.includes('build_android'));
  const checkout = publish.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, build.steps.find((step) => step.name === 'Upload mobile build artifact').with.name);
  const write = publish.steps.find((step) => step.run?.includes('publish-apk-release.mjs'));
  assert.equal(write.env.AUTHORIZED_SHA, '${{ needs.build_android.outputs.candidate_sha }}');
  assert.equal(write.env.APP_VERSION, '${{ needs.build_android.outputs.app_version }}');
  assert.match(write.run, /--version "\$APP_VERSION"/);
});

test('Android store recovery preserves failed-submit artifacts and submits admitted AAB bytes without rebuilding', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  assert.ok(workflow.on.workflow_call.inputs.retry_store_run_id);
  assert.ok(workflow.on.workflow_call.inputs.retry_store_source_sha);
  const build = workflow.jobs.build_android;
  assert.match(build.steps.find((step) => step.name === 'Upload mobile build artifact').if, /always\(\)/);
  const identity = build.steps.find((step) => step.run?.includes('candidate-identity.json'));
  assert.match(identity.if, /always\(\)/);
  assert.match(identity.run, /profile:/);
  const retry = workflow.jobs.retry_android_store_submit;
  assert.match(retry.if, /inputs\.action == 'retry_android_store_submit'/);
  assert.doesNotMatch(JSON.stringify(retry), /native-build\.mjs|ui-mobile-release|Install dependencies/);
  const download = retry.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['run-id'], '${{ inputs.retry_store_run_id }}');
  assert.equal(download.with.name, build.steps.find((step) => step.name === 'Upload mobile build artifact').with.name);
  const submit = retry.steps.find((step) => step.run?.includes('submit.mjs'));
  assert.match(submit.run, /identity\.candidateSha !== process\.env\.RETRY_STORE_SOURCE_SHA/);
  assert.match(submit.run, /identity\.profile !== process\.env\.RELEASE_PROFILE/);
  assert.match(submit.run, /--project-dir "\$submit_workspace"/);
  assert.match(submit.run, /--path "\$aab"/);
  const validator = submit.run.match(/node --input-type=module -e '([\s\S]*?)'\n/)[1];
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'happier-aab-identity-'));
  fs.mkdirSync(path.join(dir, 'retry-artifact'));
  const expected = {
    schemaVersion: 1, candidateSha: 'a'.repeat(40), environment: 'production',
    profile: 'production', platform: 'android',
  };
  const validate = (identity) => {
    fs.writeFileSync(path.join(dir, 'retry-artifact/candidate-identity.json'), JSON.stringify(identity));
    return spawnSync(process.execPath, ['--input-type=module', '-e', validator], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, RETRY_STORE_SOURCE_SHA: expected.candidateSha, RELEASE_ENVIRONMENT: expected.environment, RELEASE_PROFILE: expected.profile },
    });
  };
  assert.equal(validate(expected).status, 0);
  for (const [key, value] of [['candidateSha', 'b'.repeat(40)], ['environment', 'preview'], ['profile', 'production-apk']]) {
    const result = validate({ ...expected, [key]: value });
    assert.equal(result.status, 1, key);
    assert.match(result.stderr, /Preserved Android artifact identity does not match/);
  }
});

test('native mobile artifact names distinguish environment, platform, and effective profile', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  for (const platform of ['android', 'ios']) {
    const upload = workflow.jobs[`build_${platform}`].steps.find((step) => step.name === 'Upload mobile build artifact');
    assert.equal(upload.with.name, `ui-mobile-\${{ inputs.environment }}-${platform}-\${{ inputs.profile == 'auto' && inputs.environment || inputs.profile }}`);
  }
});

test('build-ui-mobile-local workflow delegates local builds to ui-mobile-release pipeline command', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /node \.mobile-control\/scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(src, /--native-build-mode local/);
  assert.match(src, /--action "\$\{\{\s*inputs\.action == 'build_and_submit' && 'native_submit' \|\| 'native'\s*\}\}"/);
  assert.match(src, /--publish-apk-release false/);
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS\s*\}\}/);
  assert.match(src, /APP_STORE_CONNECT_PREVIEW_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PREVIEW_EXTERNAL_GROUPS\s*\}\}/);
  assert.match(src, /APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS\s*\}\}/);
  assert.match(src, /-\s+internaldev\b/);
  assert.match(src, /-\s+internalpreview\b/);
  assert.match(src, /-\s+dev\b/);
  assert.match(src, /-\s+internaldev-store\b/);
  assert.match(src, /-\s+internalpreview-apk\b/);
  assert.match(src, /-\s+dev-apk\b/);
  assert.match(src, /-\s+preview-apk\b/);
  assert.match(src, /-\s+production-apk\b/);
  assert.match(src, /-\s+ota\b/);
  assert.doesNotMatch(src, /inputs\.environment == 'publicdev'/);
  assert.doesNotMatch(src, /\benv_name\b[\s\S]*?"publicdev"/);
  assert.doesNotMatch(src, /-\s+production-preview\b/);
  assert.doesNotMatch(src, /-\s+production-preview-apk\b/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-submit/);
});

test('build-ui-mobile-local exposes immutable APK retry recovery as a workflow input', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /retry_version:/);
  assert.match(src, /Production version — Reproject an existing immutable APK release without rebuilding/);
  assert.match(src, /promote_existing_apk:/);
  assert.match(src, /inputs\.retry_version\s*!=\s*''/);
  assert.match(src, /resolve-authorized-release-source\.mjs/);
  assert.match(src, /refs\/tags\/ui-mobile-v\$RETRY_VERSION/);
  assert.match(src, /pipeline\/expo\/publish-apk-release\.mjs/);
  assert.match(src, /--retry-version\s+"\$RETRY_VERSION"/);
  assert.match(src, /--target-sha\s+"\$AUTHORIZED_SHA"/);
});

test('build-ui-mobile-local defers and can resume exact TestFlight distribution without rebuilding', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /- retry_testflight_distribution/);
  assert.match(src, /retry_testflight_eas_build_id:/);
  assert.match(src, /retry_testflight_build_number:/);
  assert.match(src, /retry_testflight_app_version:/);

  const iosJob = src.slice(src.indexOf('  build_ios:'), src.indexOf('  ota_update:'));
  assert.match(iosJob, /Checkout trusted deferred TestFlight control bytes/);
  assert.match(iosJob, /HAPPIER_PIPELINE_REPO_ROOT:\s*\$\{\{ github\.workspace \}\}/);
  assert.match(iosJob, /--testflight-distribution-mode deferred/);
  assert.match(iosJob, /dispatch-testflight-reconciliation\.mjs/);
  assert.match(iosJob, /actions: write/);

  const retryJob = src.slice(src.indexOf('  retry_testflight_distribution:'), src.indexOf('  ota_update:'));
  assert.match(retryJob, /if:.*inputs\.action == 'retry_testflight_distribution'/);
  assert.match(retryJob, /runs-on: ubuntu-latest/);
  assert.match(retryJob, /--eas-build-id "\$RETRY_TESTFLIGHT_EAS_BUILD_ID"/);
  assert.match(retryJob, /--build-number "\$RETRY_TESTFLIGHT_BUILD_NUMBER"/);
  assert.match(retryJob, /--app-version "\$RETRY_TESTFLIGHT_APP_VERSION"/);
  assert.doesNotMatch(retryJob, /Install dependencies|native-build\.mjs|ui-mobile-release/);

  const workflow = YAML.parse(src);
  const job = workflow.jobs.build_ios;
  const submit = job.steps.find((step) => step.run?.includes('--testflight-distribution-mode deferred'));
  const dispatch = job.steps.find((step) => step.run?.includes('dispatch-testflight-reconciliation.mjs'));
  assert.notEqual(submit['continue-on-error'], true);
  assert.match(dispatch.if, /inputs\.action == 'build_and_submit'/);
  assert.doesNotMatch(dispatch.if, /always\(|failure\(/);
  assert.ok(job.steps.indexOf(dispatch) > job.steps.indexOf(submit));
  assert.match(workflow.jobs.build_ios.if, /inputs\.action != 'retry_testflight_distribution'/);
  assert.match(workflow.jobs.build_android.if, /inputs\.action != 'retry_testflight_distribution'/);
  assert.match(workflow.jobs.ota_update.if, /inputs\.action == 'ota'/);
});

test('production APK publishing reuses an existing exact-source immutable release before rebuilding', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  const workflow = YAML.parse(src);
  const resolveExisting = workflow.jobs?.resolve_existing_apk;
  const build = workflow.jobs?.build_android;
  const promoteExisting = workflow.jobs?.promote_existing_apk;

  assert.ok(resolveExisting);
  assert.deepEqual(resolveExisting.needs, ['release_actor_guard']);
  assert.equal(resolveExisting.permissions?.contents, 'read');
  assert.equal(resolveExisting.outputs?.retry_version, '${{ steps.existing.outputs.retry_version }}');

  const applicability = resolveExisting.steps.find((step) => step.id === 'applicable');
  assert.equal(applicability?.env?.RELEASE_ENVIRONMENT, '${{ inputs.environment }}');
  assert.equal(applicability?.env?.PUBLISH_APK_RELEASE, '${{ inputs.publish_apk_release }}');
  assert.equal(applicability?.env?.RETRY_VERSION, '${{ inputs.retry_version }}');
  assert.match(applicability?.run ?? '', /RELEASE_ENVIRONMENT.*production/s);
  assert.match(applicability?.run ?? '', /PUBLISH_APK_RELEASE.*true/s);

  const candidateCheckout = resolveExisting.steps.find((step) => step.name === 'Checkout exact APK candidate source');
  assert.equal(candidateCheckout?.if, "steps.applicable.outputs.resolve == 'true'");
  assert.equal(candidateCheckout?.with?.ref, '${{ inputs.source_ref != \'\' && inputs.source_ref || github.sha }}');
  assert.equal(candidateCheckout?.with?.path, 'candidate');
  assert.equal(candidateCheckout?.with?.['persist-credentials'], false);

  const existing = resolveExisting.steps.find((step) => step.id === 'existing');
  assert.match(existing?.run ?? '', /git -C candidate ls-remote origin/);
  assert.match(existing?.run ?? '', /ui-mobile-v\$\{app_version\}/);
  assert.match(existing?.run ?? '', /tag_sha.*candidate_sha|candidate_sha.*tag_sha/s);
  assert.match(existing?.run ?? '', /gh release view/);

  assert.ok(build.needs.includes('resolve_existing_apk'));
  assert.match(build.if, /needs\.resolve_existing_apk\.outputs\.retry_version == ''/);
  assert.deepEqual(promoteExisting.needs, ['release_actor_guard', 'resolve_existing_apk']);
  assert.match(promoteExisting.if, /needs\.resolve_existing_apk\.outputs\.retry_version != ''/);
  assert.ok(
    promoteExisting.steps
      .flatMap((step) => Object.values(step.env ?? {}))
      .some((value) => String(value).includes('resolve_existing_apk.outputs.retry_version')),
  );
});

test('build-ui-mobile-local passes approved release notes and projects exact retry-candidate notes', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  const workflow = YAML.parse(src);
  const projectStep = workflow.jobs?.promote_existing_apk?.steps?.find(
    (step) => step.name === 'Project approved release notes from exact immutable candidate',
  );
  assert.match(src, /release_message:/);
  assert.match(src, /RELEASE_MESSAGE:\s*\$\{\{\s*inputs\.release_message\s*\}\}/);
  assert.match(src, /--release-message\s+"\$RELEASE_MESSAGE"/);
  assert.match(src, /Project approved release notes from exact immutable candidate/);
  assert.match(src, /release-notes\.md/);
  assert.match(src, /ref: \$\{\{ steps\.source\.outputs\.authorized_sha \}\}[\s\S]*?path: candidate/);
  assert.doesNotMatch(src, /Project approved release notes from exact immutable candidate[\s\S]*?working-directory: candidate/);
  assert.match(src, /candidate_version=.*candidate\/apps\/ui\/package\.json/);
  assert.match(src, /candidate_version.*RETRY_VERSION/);
  assert.match(src, /--changelog "\$GITHUB_WORKSPACE\/candidate\/apps\/ui\/CHANGELOG\.md"/);
  assert.match(src, /--release-message-file\s+"\$RUNNER_TEMP\/release-notes\.md"/);
  assert.doesNotMatch(src, /release_notes_github_markdown<</);
  assert.doesNotMatch(src, /RELEASE_MESSAGE:\s*\$\{\{\s*steps\.release_notes\.outputs/);
  assert.equal(projectStep?.env?.RELEASE_NOTES_ID, '${{ inputs.release_notes_id }}');
  assert.equal(projectStep?.env?.AUTHORIZED_SHA, '${{ steps.source.outputs.authorized_sha }}');
});

test('immutable APK recovery installs the release verifier runtime before promotion', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  const publish = workflow.jobs.promote_existing_apk;
  const install = publish.steps.find((step) => step.uses === './.github/actions/install-yarn-dependencies');
  assert.equal(install?.env?.HAPPIER_INSTALL_SCOPE, 'release-runtime');
  assert.ok(publish.steps.find((step) => step.run?.includes('corepack enable')));
  assert.ok(publish.steps.findIndex((step) => step.uses === './.github/actions/install-yarn-dependencies')
    < publish.steps.findIndex((step) => step.name === 'Recover rolling APK projection from immutable bytes'));
});

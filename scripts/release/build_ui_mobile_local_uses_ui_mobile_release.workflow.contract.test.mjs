import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local workflow delegates selectable cloud or local builds to ui-mobile-release pipeline command', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(src, /native_build_mode:/);
  assert.match(src, /description: "EAS build runner"/);
  assert.match(src, /default: local/);
  assert.match(src, /- cloud/);
  assert.match(src, /- local/);
  assert.match(src, /--native-build-mode "\$\{\{ inputs\.native_build_mode \}\}"/);
  assert.doesNotMatch(src, /--native-build-mode local/);
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

test('build-ui-mobile-local passes approved release notes and projects exact retry-candidate notes', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /release_message:/);
  assert.match(src, /--release-message\s+"\$\{\{\s*inputs\.release_message\s*\}\}"/);
  assert.match(src, /Project approved release notes from exact immutable candidate/);
  assert.match(src, /release-notes\.md/);
  assert.match(src, /ref: \$\{\{ steps\.source\.outputs\.authorized_sha \}\}[\s\S]*?path: candidate/);
  assert.doesNotMatch(src, /Project approved release notes from exact immutable candidate[\s\S]*?working-directory: candidate/);
  assert.match(src, /--changelog "\$GITHUB_WORKSPACE\/candidate\/apps\/ui\/CHANGELOG\.md"/);
  assert.match(src, /--release-message-file\s+"\$RUNNER_TEMP\/release-notes\.md"/);
  assert.doesNotMatch(src, /release_notes_github_markdown<</);
  assert.doesNotMatch(src, /RELEASE_MESSAGE:\s*\$\{\{\s*steps\.release_notes\.outputs/);
});

test('APK build stays on candidate bytes while trusted workflow control owns signing and publication', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  const workflow = YAML.parse(src);
  const build = workflow.jobs?.build_android;
  const publish = workflow.jobs?.publish_android_apk;
  assert.ok(build);
  assert.ok(publish);

  const buildSource = JSON.stringify(build);
  assert.match(buildSource, /inputs\.source_ref/);
  assert.match(buildSource, /--publish-apk-release false/);
  assert.doesNotMatch(buildSource, /create-github-app-token/);
  assert.ok(build.outputs?.candidate_sha);
  assert.ok(build.outputs?.app_version);
  assert.equal(build.outputs?.has_apk, '${{ steps.apk.outputs.has_apk }}');

  assert.deepEqual(publish.needs, ['release_actor_guard', 'build_android']);
  assert.match(publish.if, /needs\.build_android\.outputs\.has_apk == 'true'/);
  assert.equal(publish.permissions?.contents, 'write');
  const checkout = publish.steps.find((step) => step.name === 'Checkout trusted workflow control bytes');
  assert.equal(checkout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout?.with?.['persist-credentials'], false);
  assert.ok(publish.steps.some((step) => step.name === 'Download built APK candidate'));

  const publishStep = publish.steps.find((step) => step.name === 'Sign and publish APK with trusted control');
  assert.equal(publishStep?.env?.AUTHORIZED_SHA, '${{ needs.build_android.outputs.candidate_sha }}');
  assert.equal(publishStep?.env?.APP_VERSION, '${{ needs.build_android.outputs.app_version }}');
  assert.equal(publishStep?.env?.RELEASE_MESSAGE, '${{ inputs.release_message }}');
  assert.match(publishStep?.run ?? '', /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
  assert.match(publishStep?.run ?? '', /--version "\$APP_VERSION"/);
  assert.match(publishStep?.run ?? '', /--target-sha "\$AUTHORIZED_SHA"/);
  assert.match(publishStep?.run ?? '', /--release-message "\$RELEASE_MESSAGE"/);

  const publishSource = JSON.stringify(publish);
  assert.doesNotMatch(publishSource, /install-yarn-dependencies|enable-corepack-yarn/);
});

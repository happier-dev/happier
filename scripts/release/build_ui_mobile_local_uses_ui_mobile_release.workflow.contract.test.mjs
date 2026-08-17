import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local workflow delegates local builds to ui-mobile-release pipeline command', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
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

test('build-ui-mobile-local passes approved release notes and projects exact retry-candidate notes', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  assert.match(src, /release_message:/);
  assert.match(src, /RELEASE_MESSAGE:\s*\$\{\{\s*inputs\.release_message\s*\}\}/);
  assert.match(src, /--release-message\s+"\$RELEASE_MESSAGE"/);
  assert.match(src, /Project approved release notes from exact immutable candidate/);
  assert.match(src, /release_notes_github_markdown/);
  assert.match(src, /ref: \$\{\{ steps\.source\.outputs\.authorized_sha \}\}[\s\S]*?path: candidate/);
  assert.doesNotMatch(src, /Project approved release notes from exact immutable candidate[\s\S]*?working-directory: candidate/);
  assert.match(src, /candidate_version=.*candidate\/apps\/ui\/package\.json/);
  assert.match(src, /candidate_version.*RETRY_VERSION/);
  assert.match(src, /--changelog "\$GITHUB_WORKSPACE\/candidate\/apps\/ui\/CHANGELOG\.md"/);
  assert.match(src, /release_notes_github_markdown<<\$\{delimiter\}\\n\$\{value\}\\n\$\{delimiter\}\\n/);
  assert.match(src, /--release-message\s+"\$RELEASE_MESSAGE"/);
});

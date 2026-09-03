import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local can resume TestFlight distribution without rebuilding the IPA', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');

  assert.match(src, /- retry_testflight_distribution/);
  assert.match(src, /retry_testflight_build_number:/);
  assert.match(src, /retry_testflight_app_version:/);

  const retryJob = src.slice(src.indexOf('  retry_testflight_distribution:'), src.indexOf('  ota_update:'));
  assert.notEqual(retryJob.trim(), '', 'expected a dedicated TestFlight distribution retry job');
  assert.match(retryJob, /if:.*inputs\.action == 'retry_testflight_distribution'/);
  assert.match(retryJob, /runs-on: ubuntu-latest/);
  assert.match(retryJob, /repository: \$\{\{ job\.workflow_repository \}\}/);
  assert.match(retryJob, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(retryJob, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(retryJob, /--build-number "\$RETRY_TESTFLIGHT_BUILD_NUMBER"/);
  assert.match(retryJob, /--app-version "\$RETRY_TESTFLIGHT_APP_VERSION"/);
  assert.doesNotMatch(retryJob, /Install dependencies|native-build\.mjs|ui-mobile-release/);

  const appleGuard = src.slice(src.indexOf('  validate_apple_api_private_key:'), src.indexOf('  build_android:'));
  assert.match(appleGuard, /inputs\.action == 'retry_testflight_distribution'/);

  const androidJob = src.slice(src.indexOf('  build_android:'), src.indexOf('  publish_android_apk:'));
  const iosJob = src.slice(src.indexOf('  build_ios:'), src.indexOf('  retry_testflight_distribution:'));
  assert.match(androidJob, /inputs\.action != 'retry_testflight_distribution'/);
  assert.match(androidJob, /if: \$\{\{ always\(\) && \(inputs\.native_build_mode == 'local' \|\| steps\.apk\.outputs\.has_apk == 'true'\) \}\}/);
  assert.match(iosJob, /inputs\.action != 'retry_testflight_distribution'/);
  assert.match(iosJob, /if: \$\{\{ always\(\) && inputs\.native_build_mode == 'local' \}\}/);
});

test('build-ui-mobile-local can resubmit a preserved Android store artifact without rebuilding it', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');

  assert.match(src, /- retry_android_store_submit/);
  assert.match(src, /retry_store_run_id:/);
  assert.match(src, /retry_store_source_sha:/);

  const retryJob = src.slice(src.indexOf('  retry_android_store_submit:'), src.indexOf('  retry_testflight_distribution:'));
  assert.notEqual(retryJob.trim(), '', 'expected a dedicated Android store submission retry job');
  assert.match(retryJob, /if:.*inputs\.action == 'retry_android_store_submit'/);
  assert.match(retryJob, /actions: read/);
  assert.match(retryJob, /ref: \$\{\{ job\.workflow_sha \}\}/);
  assert.match(retryJob, /run-id: \$\{\{ inputs\.retry_store_run_id \}\}/);
  assert.match(retryJob, /name: ui-mobile-\$\{\{ inputs\.environment \}\}-android/);
  assert.match(retryJob, /candidate-identity\.json/);
  assert.match(retryJob, /identity\.candidateSha !== process\.env\.RETRY_STORE_SOURCE_SHA/);
  assert.match(retryJob, /ORIGIN_HEAD_SHA.*RETRY_STORE_SOURCE_SHA/);
  assert.match(retryJob, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(retryJob, /--path "\$aab"/);
  assert.doesNotMatch(retryJob, /Install dependencies|native-build\.mjs|ui-mobile-release/);

  const androidJob = src.slice(src.indexOf('  build_android:'), src.indexOf('  publish_android_apk:'));
  const iosJob = src.slice(src.indexOf('  build_ios:'), src.indexOf('  retry_android_store_submit:'));
  assert.match(androidJob, /inputs\.action != 'retry_android_store_submit'/);
  assert.match(iosJob, /inputs\.action != 'retry_android_store_submit'/);
});

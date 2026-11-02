import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local can resume TestFlight distribution without rebuilding the IPA', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');

  assert.match(src, /- retry_testflight_distribution/);
  assert.match(src, /retry_testflight_build_number:/);
  assert.match(src, /retry_testflight_app_version:/);

  const retryJob = src.slice(src.indexOf('  retry_testflight_distribution:'), src.indexOf('  ota_update:'));
  assert.notEqual(retryJob.trim(), '', 'expected a dedicated TestFlight distribution retry job');
  assert.match(retryJob, /if:.*inputs\.action == 'retry_testflight_distribution'/);
  assert.match(retryJob, /runs-on: ubuntu-24.04/);
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
  assert.match(retryJob, /actions\/runs\/\$\{RETRY_STORE_RUN_ID\}\/artifacts/);
  assert.match(retryJob, /downloadReleaseResumeArtifact/);
  assert.match(retryJob, /candidate-identity\.json/);
  assert.match(retryJob, /identity\.candidateSha !== process\.env\.RETRY_STORE_SOURCE_SHA/);
  assert.match(retryJob, /ORIGIN_HEAD_SHA.*RETRY_STORE_SOURCE_SHA/);
  assert.match(retryJob, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(retryJob, /prepare-static-submit-workspace\.mjs/);
  assert.match(retryJob, /--project-dir "\$submit_workspace"/);
  assert.match(retryJob, /--path "\$aab"/);
  assert.match(retryJob, /--wait true/, 'recovery must report the terminal EAS submission result');
  assert.doesNotMatch(retryJob, /Install dependencies|native-build\.mjs|ui-mobile-release/);

  const androidJob = src.slice(src.indexOf('  build_android:'), src.indexOf('  publish_android_apk:'));
  const iosJob = src.slice(src.indexOf('  build_ios:'), src.indexOf('  retry_android_store_submit:'));
  assert.match(androidJob, /inputs\.action != 'retry_android_store_submit'/);
  assert.match(iosJob, /inputs\.action != 'retry_android_store_submit'/);
});

test('mobile build profiles have distinct artifacts and APK publication uses the exact producer ID', () => {
  const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  for (const platform of ['android', 'ios']) {
    const upload = workflow.jobs[`build_${platform}`].steps.find((step) => step.name === 'Upload mobile build artifact');
    assert.equal(upload.with.name, `ui-mobile-\${{ inputs.environment }}-${platform}-\${{ inputs.profile == 'auto' && inputs.environment || inputs.profile }}`);
  }
  const android = workflow.jobs.build_android;
  const upload = android.steps.find((step) => step.name === 'Upload mobile build artifact');
  assert.equal(upload.id, 'mobile_artifact');
  assert.equal(android.outputs.artifact_id, '${{ steps.mobile_artifact.outputs.artifact-id }}');
  const download = workflow.jobs.publish_android_apk.steps.find((step) => step.name === 'Download built APK candidate');
  assert.equal(download.with['artifact-ids'], '${{ needs.build_android.outputs.artifact_id }}');
  assert.equal(download.with.name, undefined);
});

test('Android recovery selects the exact profile or retains all legacy IDs without merging duplicate names', () => {
  const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  const steps = workflow.jobs.retry_android_store_submit.steps;
  const bind = steps.find((step) => step.name === 'Bind origin run and source identity');
  const script = bind.run.match(/node --input-type=module -e '([\s\S]*?)'\s*$/)?.[1];
  assert.ok(script, 'origin binding must select preserved artifacts before downloading them');
  const sourceSha = 'a'.repeat(40);
  const artifact = (id, name, overrides = {}) => ({
    id, name, expired: false, digest: `sha256:${'b'.repeat(64)}`,
    workflow_run: { id: 36669196783, head_sha: sourceSha }, ...overrides,
  });
  const legacy = [artifact(10, 'ui-mobile-production-android'), artifact(11, 'ui-mobile-production-android')];
  const scoped = artifact(12, 'ui-mobile-production-android-production');
  const apk = artifact(13, 'ui-mobile-production-android-production-apk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-mobile-retry-'));
  try {
    function select(artifacts) {
      fs.writeFileSync(path.join(root, 'mobile-retry-artifacts.json'), JSON.stringify([{ artifacts }]));
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: root,
          RELEASE_ENVIRONMENT: 'production', RELEASE_PROFILE: 'production',
          RETRY_STORE_RUN_ID: '36669196783', ORIGIN_HEAD_SHA: sourceSha,
        },
      });
      return { result, selected: result.status === 0 ? JSON.parse(fs.readFileSync(path.join(root, 'mobile-retry-selected.json'), 'utf8')) : null };
    }
    assert.deepEqual(select([...legacy, scoped, apk]).selected.map((entry) => entry.id), [12]);
    assert.deepEqual(select([...legacy, apk]).selected.map((entry) => entry.id), [10, 11]);
    for (const artifacts of [[apk], [scoped, scoped], [artifact(12, scoped.name, { expired: true })],
      [artifact(12, scoped.name, { workflow_run: { id: 1, head_sha: sourceSha } })]]) {
      assert.notEqual(select(artifacts).result.status, 0, 'missing, duplicate, expired, or foreign artifact must fail closed');
    }
    const download = steps.find((step) => step.name === 'Download preserved Android build artifact');
    assert.match(download.run, /retry-artifact\/\$artifact_id/);
    assert.doesNotMatch(download.run, /merge-multiple/);
    const verify = steps.find((step) => step.name === 'Verify candidate identity and resubmit exact AAB');
    assert.match(verify.run, /dirname "\$\{aabs\[0\]\}"/);
    assert.match(verify.run, /identity\.profile.*RELEASE_PROFILE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy duplicate-name Android archives recover the AAB with its own identity and reject drift', {
  skip: process.platform !== 'linux' ? 'The preserved-AAB job runs on Ubuntu and uses its Bash/zip tools.' : false,
}, () => {
  const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/build-ui-mobile-local.yml'), 'utf8'));
  const steps = workflow.jobs.retry_android_store_submit.steps;
  const download = steps.find((step) => step.name === 'Download preserved Android build artifact');
  const verify = steps.find((step) => step.name === 'Verify candidate identity and resubmit exact AAB');
  assert.ok(download.run, 'preserved archives must download by selected ID into separate directories');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-mobile-retry-archives-'));
  const sourceSha = 'a'.repeat(40);
  const identity = { schemaVersion: 1, candidateSha: sourceSha, environment: 'production', platform: 'android' };
  try {
    fs.symlinkSync(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), 'dir');
    const selected = [];
    for (const [id, extension, candidateSha] of [[10, 'aab', sourceSha], [11, 'apk', 'c'.repeat(40)]]) {
      const input = path.join(root, `input-${id}`);
      fs.mkdirSync(input);
      fs.writeFileSync(path.join(input, `candidate.${extension}`), `preserved-${extension}`);
      fs.writeFileSync(path.join(input, 'candidate-identity.json'), JSON.stringify({ ...identity, candidateSha }));
      const archive = path.join(root, `fixture-${id}.zip`);
      const zipped = spawnSync('zip', ['-q', archive, `candidate.${extension}`, 'candidate-identity.json'], { cwd: input, encoding: 'utf8' });
      assert.equal(zipped.status, 0, zipped.stderr);
      selected.push({ id, digest: `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}` });
    }
    fs.writeFileSync(path.join(root, 'mobile-retry-selected.json'), JSON.stringify(selected));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // GitHub CLI is the external transport boundary; run the real digest-verified downloader beneath it.
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst id = process.argv[3].match(/artifacts\\/(\\d+)\\/zip$/)?.[1];\nif (!id) process.exit(1);\nprocess.stdout.write(fs.readFileSync(process.env.RUNNER_TEMP + '/fixture-' + id + '.zip'));\n`, { mode: 0o755 });
    const environment = { ...process.env, RUNNER_TEMP: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: 'happier-dev/happier', RELEASE_ENVIRONMENT: 'production', RELEASE_PROFILE: 'production',
      RETRY_STORE_SOURCE_SHA: sourceSha, ORIGIN_HEAD_SHA: sourceSha,
    };
    const downloaded = spawnSync('bash', ['-c', download.run], { cwd: root, encoding: 'utf8', env: environment });
    assert.equal(downloaded.status, 0, downloaded.stderr);
    const verifyOnly = verify.run.slice(0, verify.run.indexOf('aab="${aabs[0]}"'));
    const check = () => spawnSync('bash', ['-c', verifyOnly], { cwd: root, encoding: 'utf8', env: environment });
    assert.equal(check().status, 0, 'APK identity must not overwrite the adjacent AAB identity');
    const extraAab = path.join(root, 'retry-artifact/11/unexpected.aab');
    fs.writeFileSync(extraAab, 'second-AAB');
    assert.notEqual(check().status, 0, 'ambiguous saved AABs must not submit');
    fs.rmSync(extraAab);
    const identityPath = path.join(root, 'retry-artifact/10/candidate-identity.json');
    for (const drift of [{ candidateSha: 'd'.repeat(40) }, { environment: 'preview' }, { platform: 'ios' }, { profile: 'production-apk' }]) {
      fs.writeFileSync(identityPath, JSON.stringify({ ...identity, ...drift }));
      assert.notEqual(check().status, 0, 'candidate, environment, platform, or profile drift must fail');
    }
    fs.rmSync(identityPath);
    assert.equal(check().status, 0, 'legacy AAB without identity retains exact-origin SHA fallback');
    environment.ORIGIN_HEAD_SHA = 'e'.repeat(40);
    assert.notEqual(check().status, 0, 'legacy AAB without identity rejects a different origin SHA');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const releasePackagesPath = fileURLToPath(new URL('./release-packages.mjs', import.meta.url));

function checkedOutSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('public SDK release packing schedules one exact-tarball validation phase before publication', () => {
  const version = '0.1.0-preview.777';
  const result = spawnSync(process.execPath, [
    releasePackagesPath,
    '--channel', 'preview',
    '--publish-plugin-sdk', 'true',
    '--publish-sdk', 'true',
    '--plugin-sdk-version', version,
    '--sdk-version', version,
    '--mode', 'pack+publish',
    '--dry-run',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const validationMatch = new RegExp(
    `validate-public-sdk-tarballs\\.mjs --plugin-sdk-tarball .*plugin_sdk-${version}\\.tgz --plugin-ui-tarball .*plugin_ui-${version}\\.tgz --sdk-tarball .*sdk-${version}\\.tgz`,
    'u',
  );
  assert.match(result.stdout, validationMatch);
  const validationIndex = result.stdout.search(validationMatch);
  const firstPublishIndex = result.stdout.indexOf('publish-tarball.mjs');
  assert.ok(validationIndex >= 0);
  assert.ok(firstPublishIndex > validationIndex, 'publication must follow exact-tarball validation');
});

test('the generic npm release orchestration owns the public Channels protocol package', () => {
  const version = '0.1.0-preview.778';
  const result = spawnSync(process.execPath, [
    releasePackagesPath,
    '--channel', 'preview',
    '--publish-channels-protocol', 'true',
    '--channels-protocol-version', version,
    '--mode', 'pack+publish',
    '--dry-run',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
        github: {},
        npm: { '@happier-dev/channels-protocol': [] },
      }),
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /packages\/channels-protocol \(channels_protocol\)/u);

  // The lockstep pair publisher is observable by its two-phase staging protocol:
  // it publishes each member twice, first under the `-staging` dist-tag. One
  // untagged publish line is the discriminating evidence that the Channels
  // protocol went through the single generic tarball publisher instead.
  const publishLines = result.stdout.split('\n').filter((line) => line.includes('publish-tarball.mjs'));
  assert.deepEqual(
    publishLines.map((line) => line.replace(/^.*publish-tarball\.mjs /u, '').replace(/[^ ]*\//gu, '')),
    [`--channel preview --tarball channels_protocol-${version}.tgz`],
    'the Channels protocol candidate publishes exactly once, through the one generic tarball publisher',
  );
});

test('Channels protocol publication is refused by the canonical public-package readiness owner', () => {
  const result = spawnSync(process.execPath, [
    releasePackagesPath,
    '--channel', 'preview',
    '--publish-channels-protocol', 'true',
    '--mode', 'pack+publish',
    '--authorized-sha', checkedOutSha(),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PUBLIC_SDK_READINESS_OWNER_UNAVAILABLE/u);
});

test('real package publication rejects a missing release-admitted candidate before package work', () => {
  const result = spawnSync(process.execPath, [
    releasePackagesPath,
    '--channel', 'preview',
    '--publish-plugin-sdk', 'true',
    '--mode', 'pack+publish',
    '--authorized-sha', '',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /release-admitted exact source SHA/);
});

test('direct real package publication rejects a dirty candidate before package work', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-release-packages-dirty-'));
  try {
    execFileSync('git', ['init'], { cwd: temporaryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: temporaryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: temporaryRoot, stdio: 'ignore' });
    await writeFile(join(temporaryRoot, 'tracked.txt'), 'initial\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: temporaryRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: temporaryRoot, stdio: 'ignore' });
    const admittedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temporaryRoot, encoding: 'utf8' }).trim();
    await writeFile(join(temporaryRoot, 'tracked.txt'), 'dirty candidate\n', 'utf8');

    const result = spawnSync(process.execPath, [
      releasePackagesPath,
      '--channel', 'preview',
      '--publish-cli', 'true',
      '--mode', 'pack+publish',
      '--authorized-sha', admittedSha,
    ], {
      cwd: temporaryRoot,
      encoding: 'utf8',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /git worktree is dirty/);
    assert.doesNotMatch(output, /Expected package\.json missing/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

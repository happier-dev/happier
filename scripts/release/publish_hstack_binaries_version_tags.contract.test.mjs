import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sharedPublishScriptPath = resolve(
  repoRoot,
  'scripts',
  'pipeline',
  'release',
  'publishing',
  'publish-binary-release.mjs',
);

for (const { channel, rollingTag, versionSuffix } of [
  { channel: 'preview', rollingTag: 'stack-preview', versionSuffix: '-preview.' },
  { channel: 'publicdev', rollingTag: 'stack-dev', versionSuffix: '-dev.' },
]) {
  test(`publish-hstack-binaries pipeline publishes stack-v* version tags alongside rolling tags for ${channel} (dry-run)`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        sharedPublishScriptPath,
        '--product',
        'hstack',
        '--channel',
        channel,
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GH_TOKEN: '',
          GH_REPO: '',
          GITHUB_REPOSITORY: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`promote-rolling-release\\.mjs[^\\n]*--rolling-tag\\s+${rollingTag}\\b`));
    assert.match(out, /--tag\s+stack-v/);
    assert.match(out, new RegExp(`stack-v[^\\s"]*${versionSuffix.replace('.', '\\.')}[^\\s"]*`));
    assert.match(out, /--tag\s+stack-v[^\s"]+[^\n]*--generate-notes\s+false\b/);
    assert.ok(
      out.search(/publish-release\.mjs\s+--tag\s+stack-v/) < out.search(/promote-rolling-release\.mjs/),
      'immutable version publication must complete before rolling promotion',
    );
    assert.match(out, /clean artifacts dir: dist\/release-assets\/stack|ensure clean artifacts dir: dist\/release-assets\/stack/i);
  });
}

test('publish-hstack-binaries rejects an invalid MINISIGN_SECRET_KEY before build without disclosing it', async () => {
  const invalidSecret = 'RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1';
  const result = spawnSync(
    process.execPath,
    [
      sharedPublishScriptPath,
      '--product',
      'hstack',
      '--channel',
      'preview',
      '--allow-stable',
      'false',
      '--run-contracts',
      'false',
      '--check-installers',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MINISIGN_SECRET_KEY: invalidSecret,
        MINISIGN_PASSPHRASE: 'x',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.equal(result.status, 1);
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  assert.doesNotMatch(output, new RegExp(invalidSecret));
  assert.doesNotMatch(output, /build-hstack-binaries\.mjs/i, 'should fail before running the heavy build');
});

for (const { channel, version, allowStable } of [
  { channel: 'preview', version: '0.2.1-preview.41', allowStable: 'false' },
  { channel: 'stable', version: '0.2.1', allowStable: 'true' },
]) {
  test(`publish-hstack-binaries recovers exact ${channel} immutable bytes after the control package base advances`, () => {
    const authorizedSha = '0123456789abcdef0123456789abcdef01234567';
    const out = execFileSync(
      process.execPath,
      [
        sharedPublishScriptPath,
        '--product', 'hstack',
        '--phase', 'promote-rolling',
        '--channel', channel,
        '--version', version,
        '--base-version', '0.2.2',
        '--authorized-sha', authorizedSha,
        '--allow-stable', allowStable,
        '--run-contracts', 'false',
        '--check-installers', 'false',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GH_REPO: 'example/fork',
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
            github: { hstack: [`stack-v${version}`] },
            npm: {},
          }),
          MINISIGN_SECRET_KEY: '',
          MINISIGN_PASSPHRASE: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`--source-tag\\s+stack-v${version.replaceAll('.', '\\.')}`));
    assert.match(out, new RegExp(`--target-sha\\s+${authorizedSha}`));
    assert.doesNotMatch(out, /build-hstack-binaries\.mjs|publish-release\.mjs/);
  });
}

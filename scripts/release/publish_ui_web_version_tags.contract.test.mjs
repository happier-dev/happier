import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag, versionSuffix } of [
  { channel: 'preview', rollingTag: 'ui-web-preview', versionSuffix: '-preview.' },
  { channel: 'publicdev', rollingTag: 'ui-web-dev', versionSuffix: '-dev.' },
]) {
  test(`publish-ui-web pipeline publishes ui-web-v* version tags alongside rolling tags for ${channel} (dry-run)`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs'),
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
    assert.match(out, /--tag\s+ui-web-v/);
    assert.match(out, new RegExp(`ui-web-v[^\\s"]*${versionSuffix.replace('.', '\\.')}[^\\s"]*`));
    assert.match(out, /--tag\s+ui-web-v[^\s"]+[^\n]*--generate-notes\s+false\b/);
    assert.ok(
      out.indexOf('publish-release.mjs --tag ui-web-v') < out.indexOf('promote-rolling-release.mjs'),
      'immutable release must be published before rolling projection',
    );
    assert.doesNotMatch(out, /-preview\.0\.1\b/, 'local preview ui-web version must be non-trivial to avoid collisions');
  });
}

test('publish-ui-web rejects an invalid MINISIGN_SECRET_KEY before Metro without disclosing it', async () => {
  const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs');
  const invalidSecret = 'RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1';
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
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
  assert.doesNotMatch(output, /Starting Metro Bundler/i, 'should fail before running the heavy build');
});

test('trusted UI-web publication consumes prepared source/version-bound bytes without rebuilding candidate code', () => {
  const version = '1.2.3-preview.41';
  const authorizedSha = '0123456789abcdef0123456789abcdef01234567';
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs'),
      '--channel', 'preview',
      '--allow-stable', 'false',
      '--base-version', '1.2.3',
      '--version', version,
      '--authorized-sha', authorizedSha,
      '--prepared-artifacts',
      '--run-contracts', 'false',
      '--check-installers', 'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GH_REPO: 'example/happier' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.doesNotMatch(out, /build-ui-web-bundle\.mjs/);
  assert.match(out, new RegExp(`happier-ui-web-v${version.replaceAll('.', '\\.')}\\-web-any\\.tar\\.gz`));
  assert.match(out, new RegExp(`--target-sha\\s+${authorizedSha}`));
  assert.match(out, /publish-release\.mjs/);
});

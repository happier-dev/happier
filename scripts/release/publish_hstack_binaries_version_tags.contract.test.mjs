import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag, versionSuffix } of [
  { channel: 'preview', rollingTag: 'stack-preview', versionSuffix: '-preview.' },
  { channel: 'publicdev', rollingTag: 'stack-dev', versionSuffix: '-dev.' },
]) {
  test(`publish-hstack-binaries pipeline publishes stack-v* version tags alongside rolling tags for ${channel} (dry-run)`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-hstack-binaries.mjs'),
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
      out.indexOf('publish-release.mjs --tag stack-v') < out.indexOf('promote-rolling-release.mjs'),
      'immutable release must be published before rolling projection',
    );
    assert.match(out, /clean artifacts dir: dist\/release-assets\/stack|ensure clean artifacts dir: dist\/release-assets\/stack/i);
  });
}

test('publish-hstack-binaries rejects an invalid MINISIGN_SECRET_KEY before build without disclosing it', async () => {
  const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-hstack-binaries.mjs');
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
  assert.doesNotMatch(output, /build-hstack-binaries\.mjs/i, 'should fail before running the heavy build');
});

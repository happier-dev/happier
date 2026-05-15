import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function readPackageVersion(relativePackageJsonPath) {
  const raw = readFileSync(resolve(repoRoot, relativePackageJsonPath), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.version, 'string');
  return parsed.version;
}

for (const { channel, rollingTag, versionSuffix } of [
  { channel: 'preview', rollingTag: 'cli-preview', versionSuffix: '-preview.' },
  { channel: 'publicdev', rollingTag: 'cli-dev', versionSuffix: '-dev.' },
]) {
  test(`publish-cli-binaries pipeline publishes cli-v* version tags alongside rolling tags for ${channel} (dry-run)`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        sharedPublishScriptPath,
        '--product',
        'cli',
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
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`--tag\\s+${rollingTag}\\b`));
    assert.match(out, new RegExp(`--tag\\s+${rollingTag}\\b[^\\n]*--generate-notes\\s+false\\b`));
    assert.match(out, /--tag\s+cli-v/);
    assert.match(out, new RegExp(`cli-v[^\\s"]*${versionSuffix.replace('.', '\\.')}[^\\s"]*`));
    assert.match(out, /--tag\s+cli-v[^\s"]+[^\n]*--generate-notes\s+true\b/);
    assert.match(out, /clean artifacts dir: dist\/release-assets\/cli|ensure clean artifacts dir: dist\/release-assets\/cli/i);
  });
}

test('publish-cli-binaries fails fast with helpful message when MINISIGN_SECRET_KEY is invalid', async () => {
  const result = spawnSync(
    process.execPath,
    [
      sharedPublishScriptPath,
      '--product',
      'cli',
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
        MINISIGN_SECRET_KEY: 'RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1',
        MINISIGN_PASSPHRASE: 'x',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0, 'expected publish-cli-binaries to fail for invalid minisign key');
  const stderr = String(result.stderr ?? '');
  assert.match(stderr, /MINISIGN_SECRET_KEY/i);
  assert.match(stderr, /truncated|dotenv|multiline|file|path/i);
  assert.doesNotMatch(String(result.stdout ?? ''), /build-cli-binaries\.mjs/i, 'should fail before running the heavy build');
});

test('publish-cli-binaries allocates dev versions from the published CLI channel instead of workflow run number', async () => {
  const cliBaseVersion = readPackageVersion('apps/cli/package.json');

  const out = execFileSync(
    process.execPath,
    [
      sharedPublishScriptPath,
      '--product',
      'cli',
      '--channel',
      'dev',
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
        GITHUB_RUN_NUMBER: '16',
        GITHUB_RUN_ATTEMPT: '1',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
          github: {
            cli: [`${cliBaseVersion}-dev.125.1`],
          },
          npm: {
            '@happier-dev/cli': [`${cliBaseVersion}-dev.124.1`],
          },
        }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, new RegExp(`cli-v${cliBaseVersion.replaceAll('.', '\\.')}-dev\\.126\\b`));
  assert.doesNotMatch(out, new RegExp(`cli-v${cliBaseVersion.replaceAll('.', '\\.')}-dev\\.16\\.1\\b`));
});

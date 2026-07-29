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

    assert.match(out, new RegExp(`promote-rolling-release\\.mjs[^\\n]*--rolling-tag\\s+${rollingTag}\\b`));
    assert.match(out, /--tag\s+cli-v/);
    assert.match(out, new RegExp(`cli-v[^\\s"]*${versionSuffix.replace('.', '\\.')}[^\\s"]*`));
    assert.match(out, /--tag\s+cli-v[^\s"]+[^\n]*--generate-notes\s+true\b/);
    assert.ok(
      out.indexOf('publish-release.mjs --tag cli-v') < out.indexOf('promote-rolling-release.mjs'),
      'immutable release must be published before rolling projection',
    );
    assert.match(out, /clean artifacts dir: dist\/release-assets\/cli|ensure clean artifacts dir: dist\/release-assets\/cli/i);
  });
}

test('publish-cli-binaries rejects an invalid MINISIGN_SECRET_KEY before build without disclosing it', async () => {
  const invalidSecret = 'RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1';
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
  assert.doesNotMatch(output, /build-cli-binaries\.mjs/i, 'should fail before running the heavy build');
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

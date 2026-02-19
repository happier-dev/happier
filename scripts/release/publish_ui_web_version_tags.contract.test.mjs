import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('publish-ui-web pipeline publishes ui-web-v* version tags alongside rolling tags (dry-run)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs'),
      '--channel',
      'preview',
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

  assert.match(out, /--tag\s+ui-web-preview\b/);
  assert.match(out, /--tag\s+ui-web-v/);
  assert.doesNotMatch(out, /-preview\.0\.1\b/, 'local preview ui-web version must be non-trivial to avoid collisions');
});

test('publish-ui-web fails fast with helpful message when MINISIGN_SECRET_KEY is invalid', async () => {
  const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs');
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
        MINISIGN_SECRET_KEY: 'RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1',
        MINISIGN_PASSPHRASE: 'x',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.notEqual(result.status, 0, 'expected publish-ui-web to fail for invalid minisign key');
  const stderr = String(result.stderr ?? '');
  assert.match(stderr, /MINISIGN_SECRET_KEY/i);
  assert.match(stderr, /truncated|dotenv|multiline|file|path/i);
  assert.doesNotMatch(String(result.stdout ?? ''), /Starting Metro Bundler/i, 'should fail before running the heavy build');
});

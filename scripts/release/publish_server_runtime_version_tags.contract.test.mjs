import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('publish-server-runtime pipeline publishes server-v* version tags alongside rolling tags (dry-run)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'),
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

  assert.match(out, /--tag\s+server-preview\b/);
  assert.match(out, /--tag\s+server-v/);
  assert.match(out, /clean artifacts dir: dist\/release-assets\/server|ensure clean artifacts dir: dist\/release-assets\/server/i);
});

test('publish-server-runtime fails fast with helpful message when MINISIGN_SECRET_KEY is invalid', async () => {
  const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs');
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

  assert.notEqual(result.status, 0, 'expected publish-server-runtime to fail for invalid minisign key');
  const stderr = String(result.stderr ?? '');
  assert.match(stderr, /MINISIGN_SECRET_KEY/i);
  assert.match(stderr, /truncated|dotenv|multiline|file|path/i);
  assert.doesNotMatch(String(result.stdout ?? ''), /build-server-binaries\.mjs/i, 'should fail before running the heavy build');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('run.mjs forwards unknown flags to wrapped release scripts (dry-run)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-build-cli-binaries',
      '--dry-run',
      '--channel',
      'preview',
      '--version',
      '0.0.0-preview.test.1',
      '--targets',
      'linux-arm64',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /build-cli-binaries\.mjs/);
  assert.match(out, /"--channel"/);
  assert.match(out, /"preview"/);
  assert.match(out, /"--version"/);
  assert.match(out, /0\.0\.0-preview\.test\.1/);
});

test('run.mjs forwards the prepared CLI matrix version handoff', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'happier-publish-version-'));
  const githubOutput = join(tempDir, 'github-output');
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'publish-cli-binaries',
        '--channel',
        'preview',
        '--allow-dirty',
        'true',
        '--resolve-version-only',
        '--github-output',
        githubOutput,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
            github: { cli: ['cli-v0.2.10-preview.10'] },
            npm: {},
          }),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /"version": "0\.2\.10-preview\.11"/);
    assert.equal(readFileSync(githubOutput, 'utf8'), 'version=0.2.10-preview.11\n');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

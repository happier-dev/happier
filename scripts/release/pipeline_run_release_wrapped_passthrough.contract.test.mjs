import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

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

test('release-validate profile dry-run executes the deterministic planner without loading secrets', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-validate',
      '--profile',
      'integrated',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.deepEqual(JSON.parse(out), {
    ok: true,
    dryRun: true,
    profile: 'integrated',
    dispatch: 'suite-specific',
    automaticSuiteIds: [
      'artifact-verify',
      'binary-smoke',
      'session-continuity',
      'cli-update',
      'docker-release-assets',
    ],
  });
  assert.doesNotMatch(out, /loaded secrets|Keychain|env sources/i);
});

test('argument-less release-validate dry-run describes the wrapper without executing an invalid target request', () => {
  const out = execFileSync(
    process.execPath,
    [resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'), 'release-validate', '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] exec: node .*validate-release\.mjs.*"--dry-run"/);
  assert.doesNotMatch(out, /loaded secrets|Keychain|env sources/i);
});

test('release-analyze permits unrelated product dirt and inspects source changes without loading release secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-analyze-clean-control-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ]; then printf ' M packages/sdk/src/connect.ts\\n'; exit 0; fi
exec "$HAPPIER_TEST_REAL_GIT" "$@"
`);

  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release-analyze',
        '--base',
        'HEAD',
        '--head',
        'HEAD',
        '--channel',
        'preview',
        '--profile',
        'integrated',
        '--has-cli-candidate',
        'false',
        '--has-server-candidate',
        'false',
        '--has-published-relay-predecessor',
        'false',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HAPPIER_TEST_REAL_GIT: realGit,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.equal(JSON.parse(out).kind, 'happier.release-change-analysis.v1');
    assert.doesNotMatch(out, /loaded secrets|Keychain|env sources/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release-analyze rejects dirty release-control before inspecting source changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-analyze-control-dirty-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'git'), `#!/bin/sh
set -eu
if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then printf 'true\\n'; exit 0; fi
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ]; then printf ' M scripts/pipeline/release/analyze-release-change.mjs\\n'; exit 0; fi
echo "unexpected git call: $*" >> ${JSON.stringify(log)}
exit 2
`);

  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release-analyze',
        '--base',
        'HEAD',
        '--head',
        'HEAD',
        '--channel',
        'preview',
        '--profile',
        'integrated',
        '--has-cli-candidate',
        'false',
        '--has-server-candidate',
        'false',
        '--has-published-relay-predecessor',
        'false',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELEASE_CONTROL_WORKTREE_DIRTY/);
    assert.equal(readFileSync(log, 'utf8'), '', 'dirty release control must reject before source analysis invokes git');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

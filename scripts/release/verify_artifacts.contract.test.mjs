import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const verifyArtifactsPath = resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs');

function normalizeArchivePlatform(platform) {
  return platform === 'win32' ? 'windows' : platform;
}

function normalizeArchiveArch(arch) {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

test('verify-artifacts smoke-runs packaged server binaries with isolated startup env instead of --help', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'server-smoke-marker.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "${1-}" == "--help" ]]; then',
        '  echo "server smoke should not use --help"',
        '  exit 1',
        'fi',
        '[[ "${PORT-}" == "0" ]] || { echo "expected PORT=0 but got ${PORT-}"; exit 1; }',
        '[[ "${METRICS_PORT-}" == "0" ]] || { echo "expected METRICS_PORT=0 but got ${METRICS_PORT-}"; exit 1; }',
        '[[ -n "${HAPPIER_SERVER_LIGHT_DATA_DIR-}" ]] || { echo "missing HAPPIER_SERVER_LIGHT_DATA_DIR"; exit 1; }',
        `printf 'PORT=%s\\nMETRICS_PORT=%s\\nDATA=%s\\n' "$PORT" "$METRICS_PORT" "$HAPPIER_SERVER_LIGHT_DATA_DIR" > "${markerPath}"`,
        'exit 0',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_SERVER_LIGHT_DATA_DIR: '',
          PORT: '',
          METRICS_PORT: '',
        },
        stdio: 'pipe',
      },
    );

    const marker = await readFile(markerPath, 'utf-8');
    assert.match(marker, /^PORT=0$/m);
    assert.match(marker, /^METRICS_PORT=0$/m);
    assert.match(marker, /^DATA=.+$/m);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts selects the packaged binary instead of a sibling sidecar directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-server-layout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-layout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const markerPath = join(workspace, 'selected-binary.txt');
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-layout.txt');

    await mkdir(join(stageDir, 'generated', 'sqlite-client'), { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(stageDir, 'generated', 'sqlite-client', 'placeholder.txt'), 'placeholder\n', 'utf-8');
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `printf 'selected-binary\\n' > "${markerPath}"`,
        'exit 0',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );

    assert.equal(await readFile(markerPath, 'utf-8'), 'selected-binary\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts includes stdout in smoke failures when stderr is empty', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-stdout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-v0.0.0-test-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-v0.0.0-test.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier'),
      '#!/usr/bin/env bash\necho "stdout-only smoke failure"\nexit 1\n',
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            verifyArtifactsPath,
            '--artifacts-dir',
            artifactsDir,
            '--checksums',
            checksumsPath,
          ],
          { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
        ),
      /stdout-only smoke failure/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts hard-times-out packaged server binaries that ignore SIGTERM', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-timeout-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-timeout-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-timeout.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        "trap '' TERM",
        "printf 'ready\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    const startedAt = Date.now();
    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    assert.ok(
      Date.now() - startedAt < 28_000,
      'verify-artifacts should stop hung packaged server binaries on its internal smoke timeout',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('verify-artifacts honors the packaged server smoke timeout override', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'happier-verify-artifacts-timeout-override-'));
  try {
    const artifactsDir = join(workspace, 'artifacts');
    const stageRoot = join(workspace, 'stage');
    const archivePlatform = normalizeArchivePlatform(process.platform);
    const archiveArch = normalizeArchiveArch(process.arch);
    const archiveStem = `happier-server-v0.0.0-timeout-override-${archivePlatform}-${archiveArch}`;
    const stageDir = join(stageRoot, archiveStem);
    const archivePath = join(artifactsDir, `${archiveStem}.tar.gz`);
    const checksumsPath = join(artifactsDir, 'checksums-happier-server-v0.0.0-timeout-override.txt');

    await mkdir(stageDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(stageDir, 'happier-server'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        "trap '' TERM",
        "printf 'ready\\n'",
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );

    execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, archiveStem], { cwd: repoRoot });
    await writeFile(
      checksumsPath,
      `${await sha256(archivePath)}  ${archiveStem}.tar.gz\n`,
      'utf-8',
    );

    const startedAt = Date.now();
    execFileSync(
      process.execPath,
      [
        verifyArtifactsPath,
        '--artifacts-dir',
        artifactsDir,
        '--checksums',
        checksumsPath,
      ],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        env: {
          ...process.env,
          HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS: '200',
        },
        timeout: 5_000,
      },
    );
    assert.ok(
      Date.now() - startedAt < 4_000,
      'verify-artifacts should respect the shorter packaged server smoke timeout override',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS,
  probeCliDistRuntimeImport,
  readCliDistBuildManifest,
  readCliDistClosureFingerprint,
  resolveCliDistEntrypointFromBin,
  writeCliDistBuildManifest,
} from './cliDistIntegrity.mjs';

test('runtime import probe default budget covers source daemon startup verification', () => {
  assert.equal(DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS, 120_000);
});

async function writeCliBinFixture(root) {
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin', 'happier.mjs'), [
    '#!/usr/bin/env node',
    "import '../dist/index.mjs';",
    '',
  ].join('\n'), 'utf-8');
}

function writeManifest(distDir) {
  return writeCliDistBuildManifest(join(distDir, 'index.mjs'), {
    builtAt: '2026-07-09T00:00:00.000Z',
  });
}

test('readCliDistBuildManifest requires an entrypoint and build manifest', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-manifest-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    assert.deepEqual(readCliDistBuildManifest(entrypoint), {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath: join(distDir, '.build-manifest.json'),
    });

    writeManifest(distDir);
    const manifest = readCliDistBuildManifest(entrypoint);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.reason, 'manifest');
    assert.match(manifest.fingerprint, /^[a-f0-9]{16}$/);
    assert.equal(manifest.fileCount, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveCliDistEntrypointFromBin prefers manifest-complete dist before package-dist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-entrypoint-manifest-'));
  try {
    await writeCliBinFixture(tmp);
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'package-dist'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'index.mjs'), 'export const value = "dist";\n', 'utf-8');
    await writeFile(join(tmp, 'package-dist', 'index.mjs'), 'export const value = "package";\n', 'utf-8');
    writeManifest(join(tmp, 'dist'));
    writeManifest(join(tmp, 'package-dist'));

    assert.equal(
      resolveCliDistEntrypointFromBin(join(tmp, 'bin', 'happier.mjs')),
      join(tmp, 'dist', 'index.mjs'),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveCliDistEntrypointFromBin falls back to package-dist when dist lacks a manifest', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-package-dist-entrypoint-manifest-'));
  try {
    await writeCliBinFixture(tmp);
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'package-dist'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'index.mjs'), 'export const value = "dist";\n', 'utf-8');
    await writeFile(join(tmp, 'package-dist', 'index.mjs'), 'export const value = "package";\n', 'utf-8');
    writeManifest(join(tmp, 'package-dist'));

    assert.equal(
      resolveCliDistEntrypointFromBin(join(tmp, 'bin', 'happier.mjs')),
      join(tmp, 'package-dist', 'index.mjs'),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest returns the promoted identity without rehashing changed payload bytes', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-stale-manifest-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');
    const written = writeCliDistBuildManifest(entrypoint, {
      builtAt: '2026-07-09T00:00:00.000Z',
    });

    await writeFile(entrypoint, "import './missing-chunk.mjs';\n", 'utf-8');

    const integrity = readCliDistBuildManifest(entrypoint);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.reason, 'manifest');
    assert.equal(integrity.fingerprint, written.manifest.fingerprint);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest rejects a blank executable entrypoint even when its manifest matches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-empty-entrypoint-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, '', 'utf-8');
    const closure = readCliDistClosureFingerprint(entrypoint);
    assert.equal(closure.ok, true);
    await writeFile(join(tmp, '.build-manifest.json'), `${JSON.stringify({
      fingerprint: closure.fingerprint,
      builtAt: '2026-07-11T00:00:00.000Z',
      fileCount: closure.fileCount,
      toolVersion: '2',
    }, null, 2)}\n`, 'utf-8');

    const integrity = readCliDistBuildManifest(entrypoint);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.reason, 'empty_entrypoint');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport resolves a valid ESM entrypoint', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-ok-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    await probeCliDistRuntimeImport(entrypoint);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects ESM link failures', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-fail-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, "import { A } from './chunk.mjs'; export const value = A;\n", 'utf-8');
    await writeFile(join(tmp, 'chunk.mjs'), 'export const B = true;\n', 'utf-8');

    await assert.rejects(
      () => probeCliDistRuntimeImport(entrypoint),
      /does not provide an export named|runtime import probe failed/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport validates the daemon command lazy import closure', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-daemon-probe-fail-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(
      entrypoint,
      "if (process.argv.includes('daemon')) await import('./daemon.mjs');\n",
      'utf-8',
    );
    await writeFile(join(tmp, 'daemon.mjs'), "import './missing-daemon-dependency.mjs';\n", 'utf-8');

    await assert.rejects(
      () => probeCliDistRuntimeImport(entrypoint),
      /missing-daemon-dependency|runtime import probe failed/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects when the import process stays alive past the timeout', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-timeout-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    const pidPath = join(tmp, 'probe.pid');
    const pipeHolderPidPath = join(tmp, 'pipe-holder.pid');
    await writeFile(
      entrypoint,
      [
        `import { spawn } from 'node:child_process';`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `const pipeHolder = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 5500)'], { stdio: ['ignore', 'ignore', 'inherit'] });`,
        `writeFileSync(${JSON.stringify(pipeHolderPidPath)}, String(pipeHolder.pid));`,
        `setInterval(() => {}, 1000);`,
        '',
      ].join('\n'),
      'utf-8',
    );

    let watchdog;
    const result = await Promise.race([
      probeCliDistRuntimeImport(entrypoint, { timeoutMs: 5000 }).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve('timed-out'), 30_000);
      }),
    ]);
    clearTimeout(watchdog);

    assert.match(result instanceof Error ? result.message : String(result), /timed out/i);
    const probePid = Number(await readFile(pidPath, 'utf-8'));
    assert.throws(
      () => process.kill(probePid, 0),
      (error) => error?.code === 'ESRCH',
      'expected the timed-out import probe process to be reaped before rejection',
    );
    const pipeHolderPid = Number(await readFile(pipeHolderPidPath, 'utf-8'));
    assert.throws(
      () => process.kill(pipeHolderPid, 0),
      (error) => error?.code === 'ESRCH',
      'expected the timed-out import probe stderr pipe to be closed before rejection',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

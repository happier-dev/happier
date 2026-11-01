import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import {
  DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS,
  probeCliDistRuntimeImport,
  readCliDistBuildManifest,
  readCliDistIntegrity,
} from './cliDistIntegrity.mjs';

test('runtime import probe default budget covers source daemon startup verification', () => {
  assert.equal(DEFAULT_CLI_DIST_RUNTIME_IMPORT_TIMEOUT_MS, 120_000);
});

test('readCliDistIntegrity requires a build manifest next to the entrypoint', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-integrity-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    assert.deepEqual(readCliDistIntegrity(entrypoint), {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      fileCount: 0,
      manifestPath: join(distDir, '.build-manifest.json'),
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest reads the manifest fingerprint without rehashing dist files', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-fingerprint-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, "import './missing.mjs';\n", 'utf-8');
    await writeFile(
      join(distDir, '.build-manifest.json'),
      JSON.stringify({
        fingerprint: 'abcdef1234567890',
        builtAt: '2026-07-09T00:00:00.000Z',
        fileCount: 7,
        toolVersion: '1',
      }) + '\n',
      'utf-8',
    );

    const manifest = readCliDistBuildManifest(entrypoint);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.fingerprint, 'abcdef1234567890');
    assert.equal(manifest.fileCount, 7);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport resolves a valid ESM entrypoint without opening a Windows console', async (t) => {
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(options.windowsHide, true);
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
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
      /does not provide an export named|runtime import probe failed/
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
        `const pipeHolder = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 350)'], { stdio: ['ignore', 'ignore', 'inherit'] });`,
        `writeFileSync(${JSON.stringify(pipeHolderPidPath)}, String(pipeHolder.pid));`,
        `setInterval(() => {}, 1000);`,
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await Promise.race([
      probeCliDistRuntimeImport(entrypoint, { timeoutMs: 150 }).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
    ]);

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

import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

describe('ensureBuildArtifactsReadyOnce', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('reclaims a stale legacy lock file and runs the build', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-build-lock-'));
    tempDirs.push(tempDir);

    const lockPath = join(tempDir, 'shared-deps.lock');
    const markerPath = join(tempDir, 'protocol.marker');

    await writeFile(lockPath, '', 'utf8');
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    let buildCount = 0;

    const { ensureBuildArtifactsReadyOnce } = await import('./testSetupBuildCoordinator');

    await ensureBuildArtifactsReadyOnce({
      lockPath,
      markerPaths: [markerPath],
      lockLabel: 'CLI shared deps build',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      staleAfterMs: 5_000,
      runBuild: async () => {
        buildCount += 1;
        await writeFile(markerPath, 'built', 'utf8');
      },
    });

    await expect(access(markerPath)).resolves.toBeUndefined();
    await expect(access(lockPath)).rejects.toThrow();
    expect(buildCount).toBe(1);
  });

  it('reclaims a live but stale lock owner and runs the build', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-build-lock-live-stale-'));
    tempDirs.push(tempDir);

    const lockPath = join(tempDir, 'shared-deps.lock');
    const markerPath = join(tempDir, 'protocol.marker');
    const staleOwner = {
      pid: process.pid,
      createdAtMs: Date.now() - 120_000,
    };

    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, 'utf8');

    let buildCount = 0;

    const { ensureBuildArtifactsReadyOnce } = await import('./testSetupBuildCoordinator');

    await ensureBuildArtifactsReadyOnce({
      lockPath,
      markerPaths: [markerPath],
      lockLabel: 'CLI shared deps build',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      staleAfterMs: 5_000,
      isProcessAlive: () => true,
      runBuild: async () => {
        buildCount += 1;
        await writeFile(markerPath, 'built', 'utf8');
      },
    });

    await expect(access(markerPath)).resolves.toBeUndefined();
    await expect(access(lockPath)).rejects.toThrow();
    expect(buildCount).toBe(1);
  });

  it('runs the build when markers exist but the readiness predicate reports stale outputs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-build-ready-'));
    tempDirs.push(tempDir);

    const lockPath = join(tempDir, 'shared-deps.lock');
    const markerPath = join(tempDir, 'protocol.marker');

    await writeFile(markerPath, 'already-present', 'utf8');

    let buildCount = 0;
    let ready = false;

    const { ensureBuildArtifactsReadyOnce } = await import('./testSetupBuildCoordinator');

    await ensureBuildArtifactsReadyOnce({
      lockPath,
      markerPaths: [markerPath],
      lockLabel: 'CLI shared deps build',
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      staleAfterMs: 5_000,
      isReady: () => ready,
      runBuild: async () => {
        buildCount += 1;
        await writeFile(markerPath, 'rebuilt', 'utf8');
        ready = true;
      },
    });

    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(buildCount).toBe(1);
  });

  it('waits for an active lock even when the expected outputs already exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-cli-test-setup-build-lock-live-ready-'));
    tempDirs.push(tempDir);

    const lockPath = join(tempDir, 'shared-deps.lock');
    const markerPath = join(tempDir, 'protocol.marker');
    const activeOwner = {
      pid: process.pid,
      createdAtMs: Date.now(),
    };

    await writeFile(lockPath, `${JSON.stringify(activeOwner)}\n`, 'utf8');
    await writeFile(markerPath, 'already-present', 'utf8');

    const { ensureBuildArtifactsReadyOnce } = await import('./testSetupBuildCoordinator');

    await expect(
      ensureBuildArtifactsReadyOnce({
        lockPath,
        markerPaths: [markerPath],
        lockLabel: 'CLI shared deps build',
        pollIntervalMs: 1,
        timeoutMs: 20,
        staleAfterMs: 5_000,
        isProcessAlive: () => true,
        runBuild: async () => {
          throw new Error('runBuild should not be reached while an active lock remains');
        },
      }),
    ).rejects.toThrow(/Timed out waiting for CLI shared deps build lock/);

    await expect(access(markerPath)).resolves.toBeUndefined();
  });
});

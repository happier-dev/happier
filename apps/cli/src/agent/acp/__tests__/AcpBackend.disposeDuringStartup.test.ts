import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

describe('AcpBackend dispose during startup', () => {
  afterEach(() => {
    vi.doUnmock('@agentclientprotocol/sdk');
    vi.resetModules();
  });

  it('does not begin launch preparation when disposed during SDK loading', async () => {
    let releaseSdk!: () => void;
    const sdkReady = new Promise<void>((resolve) => { releaseSdk = resolve; });
    let noteSdkLoading!: () => void;
    const sdkLoading = new Promise<void>((resolve) => { noteSdkLoading = resolve; });
    // The third-party module is the boundary: keep the backend and loader real.
    vi.doMock('@agentclientprotocol/sdk', async (importOriginal) => {
      noteSdkLoading();
      await sdkReady;
      return importOriginal();
    });
    const { AcpBackend } = await import('../AcpBackend');
    let preparationStarted = false;
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: tmpdir(),
      command: 'unused',
      prepareProcessLaunch: async () => {
        preparationStarted = true;
        return {};
      },
    });

    try {
      const started = backend.startSession();
      started.catch(() => {});
      await sdkLoading;
      await backend.dispose();
      releaseSdk();

      await expect(started).rejects.toThrow(/disposed/);
      expect(preparationStarted).toBe(false);
    } finally {
      releaseSdk();
      await backend.dispose();
    }
  });

  it('does not spawn the agent when disposed before the launch is ready', async () => {
    const { AcpBackend } = await import('../AcpBackend');
    const dir = mkdtempSync(join(tmpdir(), 'acp-dispose-startup-'));
    const marker = join(dir, 'spawned');
    let releaseLaunch!: () => void;
    const launchReady = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let noteLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => { noteLaunchStarted = resolve; });
    let launchCleanups = 0;

    const backend = new AcpBackend({
      agentName: 'test',
      cwd: dir,
      command: 'unused',
      prepareProcessLaunch: async () => {
        noteLaunchStarted();
        await launchReady;
        return {
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000)`],
          cleanup: () => { launchCleanups += 1; },
        };
      },
    });

    try {
      const started = backend.startSession();
      started.catch(() => {});
      await launchStarted;

      await backend.dispose();
      releaseLaunch();

      await expect(started).rejects.toThrow(/disposed/);
      expect(existsSync(marker)).toBe(false);
      expect(launchCleanups).toBe(1);
    } finally {
      const leaked = (backend as unknown as { process: Parameters<typeof killProcessTree>[0] | null }).process;
      if (leaked) await killProcessTree(leaked, { graceMs: 250 });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

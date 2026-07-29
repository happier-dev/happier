import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  installVersionedPayload,
  resolveFirstPartyInstallLayout,
  uninstallManagedFirstPartyComponent,
} from './index.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';

const uninstallRemovalGate = vi.hoisted(() => ({
  targetPath: null as string | null,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      if (
        uninstallRemovalGate.targetPath !== null
        && String(path) === uninstallRemovalGate.targetPath
        && uninstallRemovalGate.release
      ) {
        uninstallRemovalGate.entered?.();
        await uninstallRemovalGate.release;
      }
      return await actual.rm(path, options);
    },
  };
});

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(settled).toBe(false);
}

describe('uninstallManagedFirstPartyComponent', () => {
  it('removes the install root and shim paths for a managed CLI install', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-first-party-uninstall-'));
    try {
      const installRoot = join(happyHomeDir, 'cli');
      const currentPath = join(installRoot, 'current');
      const shimDir = join(happyHomeDir, 'bin');
      const shimPath = join(shimDir, 'happier');

      await mkdir(join(currentPath, 'bin'), { recursive: true });
      await writeFile(join(currentPath, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(currentPath, 'bin', 'happier'), '#!/bin/sh\n', 'utf8');
      await mkdir(shimDir, { recursive: true });
      await symlink('../cli/current/bin/happier', shimPath);

      const result = await uninstallManagedFirstPartyComponent({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
      });

      expect(result.removedPaths).toContain(installRoot);
      expect(result.removedPaths).toContain(shimPath);
      await expect(stat(installRoot)).rejects.toThrow();
      await expect(stat(shimPath)).rejects.toThrow();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight payload update before removing the complete managed install', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-first-party-uninstall-after-update-'));
    const processEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: happyHomeDir,
    };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'stable',
      processEnv,
    });
    const updateEntered = createDeferred();
    const releaseUpdate = createDeferred();

    try {
      await mkdir(layout.currentPath, { recursive: true });
      await mkdir(layout.shimDir, { recursive: true });
      await writeFile(join(layout.currentPath, 'happier'), 'current\n', 'utf8');
      await symlink('../cli/current/happier', join(layout.shimDir, 'happier'));

      const update = withFirstPartyPayloadMutationLock({
        layout,
        operation: async () => {
          updateEntered.resolve();
          await releaseUpdate.promise;
        },
      });
      await updateEntered.promise;

      const uninstall = uninstallManagedFirstPartyComponent({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv,
      });

      await expectStillPending(uninstall);
      expect((await stat(layout.installRoot)).isDirectory()).toBe(true);
      expect((await stat(join(layout.shimDir, 'happier'))).isFile()).toBe(true);

      releaseUpdate.resolve();
      await update;
      await uninstall;

      await expect(stat(layout.installRoot)).rejects.toThrow();
      await expect(stat(join(layout.shimDir, 'happier'))).rejects.toThrow();
    } finally {
      releaseUpdate.resolve();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('holds the payload mutation lock until uninstall finishes before a later update installs', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-first-party-update-after-uninstall-'));
    const stagedPayloadPath = join(happyHomeDir, 'staged-next');
    const processEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: happyHomeDir,
    };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'stable',
      processEnv,
    });
    const uninstallEntered = createDeferred();
    const releaseUninstall = createDeferred();

    try {
      await mkdir(layout.currentPath, { recursive: true });
      await mkdir(layout.shimDir, { recursive: true });
      await writeFile(join(layout.currentPath, 'happier'), 'current\n', 'utf8');
      await symlink('../cli/current/happier', join(layout.shimDir, 'happier'));
      await mkdir(stagedPayloadPath, { recursive: true });
      await writeFile(join(stagedPayloadPath, 'happier'), 'next\n', 'utf8');
      await chmod(join(stagedPayloadPath, 'happier'), 0o755);

      uninstallRemovalGate.targetPath = layout.installRoot;
      uninstallRemovalGate.entered = uninstallEntered.resolve;
      uninstallRemovalGate.release = releaseUninstall.promise;
      const uninstall = uninstallManagedFirstPartyComponent({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv,
      });
      await uninstallEntered.promise;

      const update = installVersionedPayload({
        componentId: 'happier-cli',
        versionId: '2.0.0',
        payloadRoot: stagedPayloadPath,
        channel: 'stable',
        processEnv,
      });

      await expectStillPending(update);
      releaseUninstall.resolve();
      await uninstall;
      await update;

      expect(await stat(join(layout.currentPath, 'happier'))).toMatchObject({
        mode: expect.any(Number),
      });
      expect((await stat(join(layout.shimDir, 'happier'))).isFile()).toBe(true);
    } finally {
      uninstallRemovalGate.targetPath = null;
      uninstallRemovalGate.entered = null;
      uninstallRemovalGate.release = null;
      releaseUninstall.resolve();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('does not deadlock when the managed install root is already absent', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-first-party-uninstall-absent-'));
    const processEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: happyHomeDir,
    };
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'stable',
      processEnv,
    });

    try {
      await uninstallManagedFirstPartyComponent({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv,
      });

      await expect(stat(layout.installRoot)).rejects.toThrow();
      await expect(stat(`${layout.installRoot}.mutation.lock`)).rejects.toThrow();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});

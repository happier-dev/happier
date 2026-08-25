import { lstat, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

export async function loadSyncCodexConnectedServiceHome() {
  const module = await import('./syncCodexConnectedServiceHome');
  return module.syncCodexConnectedServiceHome;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function createCodexHomePair(): Promise<{
  root: string;
  sourceCodexHome: string;
  destinationCodexHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-home-sync-test-'));
  const sourceCodexHome = join(root, 'source-codex-home');
  const destinationCodexHome = join(root, 'connected-codex-home');
  await mkdir(sourceCodexHome, { recursive: true });
  return { root, sourceCodexHome, destinationCodexHome };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition');
}

export function settings(configMode: 'linked' | 'copied' | 'isolated', stateMode: 'shared' | 'isolated') {
  return {
    connectedServicesProviderStateSharingSettingsV1: {
      v: 1,
      defaults: {
        configMode: 'linked',
        stateMode: 'isolated',
      },
      byAgentId: {
        codex: {
          configMode,
          stateMode,
        },
      },
      acknowledgedRisksByAgentId: {},
    },
  };
}

export function mockSymlinkFailureForTempLink(destinationPathFragment: string): void {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
      ...actual,
      symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
        const [, destinationPath] = args;
        if (String(destinationPath).includes(destinationPathFragment)) {
          const error = new Error('file symlink unavailable') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return actual.symlink(...args);
      }),
    };
  });
}

export function mockAllSymlinksFail(): void {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
      ...actual,
      symlink: vi.fn(async () => {
        const error = new Error('symlink unavailable') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }),
    };
  });
}

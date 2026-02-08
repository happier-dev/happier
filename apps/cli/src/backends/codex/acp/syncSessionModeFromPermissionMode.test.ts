import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { Metadata } from '@/api/types';
import type { AcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';

import { syncCodexAcpSessionModeFromPermissionMode } from './syncSessionModeFromPermissionMode';

function makeMetadata(params: {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}): Metadata {
  return {
    path: '/tmp',
    host: 'host',
    homeDir: '/home',
    happyHomeDir: '/happy',
    happyLibDir: '/lib',
    happyToolsDir: '/tools',
    acpSessionModesV1: {
      v: 1 as const,
      provider: 'codex',
      updatedAt: 1,
      currentModeId: params.currentModeId,
      availableModes: params.availableModes,
    },
  } as unknown as Metadata;
}

describe('syncCodexAcpSessionModeFromPermissionMode', () => {
  function createRuntimeRecorder() {
    const calls: string[] = [];
    const runtime: Pick<AcpRuntime, 'setSessionMode'> = {
      setSessionMode: async (modeId: string) => {
        calls.push(modeId);
      },
    };
    return { runtime, calls };
  }

  it('switches to read-only preset when permissionMode=read-only and preset id is available', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'read-only' satisfies PermissionMode,
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'read-only', name: 'Read-only' },
        ],
      }),
    });

    expect(calls).toEqual(['read-only']);
  });

  it('switches to workspace-write preset when permissionMode=safe-yolo and preset id is available', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'safe-yolo',
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'workspace-write', name: 'Workspace write' },
        ],
      }),
    });

    expect(calls).toEqual(['workspace-write']);
  });

  it('switches to danger-full-access preset when permissionMode=yolo and preset id is available', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'yolo',
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'danger-full-access', name: 'Danger' },
        ],
      }),
    });

    expect(calls).toEqual(['danger-full-access']);
  });

  it('does not call setSessionMode when already in the desired mode', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'read-only',
      metadata: makeMetadata({
        currentModeId: 'read-only',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'read-only', name: 'Read-only' },
        ],
      }),
    });

    expect(calls).toEqual([]);
  });

  it('does not call setSessionMode when metadata is null', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'read-only',
      metadata: null,
    });

    expect(calls).toEqual([]);
  });

  it('does not call setSessionMode when desired preset is unavailable', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'safe-yolo',
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [{ id: 'default', name: 'Default' }],
      }),
    });

    expect(calls).toEqual([]);
  });

  it('does not call setSessionMode for plan mode', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'plan',
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'read-only', name: 'Read-only' },
        ],
      }),
    });

    expect(calls).toEqual([]);
  });

  it('matches fallback by mode name token when preferred id is absent', async () => {
    const { runtime, calls } = createRuntimeRecorder();

    await syncCodexAcpSessionModeFromPermissionMode({
      runtime: runtime as AcpRuntime,
      permissionMode: 'safe-yolo',
      metadata: makeMetadata({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'mode_untrusted', name: 'Untrusted' },
        ],
      }),
    });

    expect(calls).toEqual(['mode_untrusted']);
  });
});

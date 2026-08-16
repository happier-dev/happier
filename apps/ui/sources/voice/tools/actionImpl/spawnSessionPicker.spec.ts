import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const modalShow = vi.fn();
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patcher: unknown) => {});
const submitMessage = vi.fn(async (..._args: unknown[]) => {});
const followUpSpawnedSessionWithServerScope = vi.fn(async (..._args: unknown[]) => {});
const state: any = {
  settings: {
    ...settingsDefaults,
    lastUsedAgent: 'claude',
  },
  machines: {
    m2: {
      id: 'm2',
      active: true,
      activeAt: Date.now(),
      spawnReadinessStatus: 'ready',
      metadata: {},
      daemonState: { startedWithCliVersion: '0.2.10-dev.41' },
    },
  },
};

installVoiceToolActionImplCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (cfg: any) => modalShow(cfg),
            },
        }).module;
    },

    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    },
});

vi.mock('@/voice/pickers/VoiceSessionSpawnPickerModal', () => ({
  VoiceSessionSpawnPickerModal: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (opts: any) => machineSpawnNewSession(opts),
  machineSpawnNewSessionUntilResolved: (opts: any) => machineSpawnNewSession(opts),
  completeMachineSpawnAttemptCustody: vi.fn(async () => true),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: () => refreshSessions(),
    patchSessionMetadataWithRetry: (sessionId: string, patcher: any) => patchSessionMetadataWithRetry(sessionId, patcher),
    submitMessage: (sessionId: string, message: string, displayText?: string, metaOverrides?: unknown, options?: unknown) =>
      submitMessage(sessionId, message, displayText, metaOverrides, options),
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
  followUpSpawnedSessionWithServerScope: (params: unknown) => followUpSpawnedSessionWithServerScope(params),
}));

describe('spawnSessionWithPickerForVoiceTool', () => {
  beforeEach(() => {
    modalShow.mockReset();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    submitMessage.mockClear();
    followUpSpawnedSessionWithServerScope.mockClear();
    state.machines = {
      m2: {
        id: 'm2',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: {},
        daemonState: { startedWithCliVersion: '0.2.10-dev.41' },
      },
    };
  });

  it('opens a picker and spawns a session from the user-selected machine + directory', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockImplementation(async (params: any) => ({
      type: 'success',
      sessionId: 's_new',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: params.userAttemptId,
        spawnNonce: 'nonce-s-new',
        targetFingerprint: 'target-s-new',
      },
    }));

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    expect(res).toMatchObject({ type: 'success', sessionId: 's_new' });
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm2',
      directory: '/tmp/s2',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-a',
      pendingFirstInput: {
        text: 'Hi',
        localId: expect.stringMatching(/^voice-spawn-first-turn:/),
      },
    }));
    expect(refreshSessions).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_new', expect.any(Function));
    expect(followUpSpawnedSessionWithServerScope).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('does not apply tag or first input to a session rejoined from a different spawn attempt', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_existing',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'different-attempt',
        spawnNonce: 'different-nonce',
        targetFingerprint: 'target-a',
      },
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ tag: 'must-not-apply', initialMessage: 'must not send' });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      userAttemptId: expect.stringMatching(/^ui-session-attempt-/),
    }));
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('does not spawn when the picker returns a machine whose exact readiness is unknown', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    state.machines = {
      m2: {
        id: 'm2',
        active: true,
        activeAt: Date.now(),
        metadata: {},
      },
    };

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({});

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'spawn_target_unavailable',
      readinessStatus: 'unknown',
    });
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const modalShow = vi.fn();
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patcher: unknown) => {});
const sendMessage = vi.fn(async (_sessionId: string, _message: string) => {});
const state: any = {
  settings: {
    ...settingsDefaults,
    lastUsedAgent: 'claude',
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
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: () => refreshSessions(),
    patchSessionMetadataWithRetry: (sessionId: string, patcher: any) => patchSessionMetadataWithRetry(sessionId, patcher),
    sendMessage: (sessionId: string, message: string) => sendMessage(sessionId, message),
  },
}));

describe('spawnSessionWithPickerForVoiceTool', () => {
  beforeEach(() => {
    state.settings = {
      ...settingsDefaults,
      lastUsedAgent: 'claude',
    };
    modalShow.mockReset();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    sendMessage.mockClear();
  });

  it('opens a picker and spawns a session from the user-selected machine + directory', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    expect(res).toMatchObject({ type: 'success', sessionId: 's_new' });
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm2',
      directory: '/tmp/s2',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-a',
    }));
    expect(refreshSessions).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_new', expect.any(Function));
    expect(sendMessage).toHaveBeenCalledWith('s_new', 'Hi');
  });

  it('uses the configured last-used backend target when there is no explicit voice tool agent override', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    }));
  });

  it('falls back to the built-in last-used target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }));
  });

  it('uses an explicit backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ backendTargetKey: 'acpBackend:review-bot' } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    }));
  });
});

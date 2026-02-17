import { describe, expect, it, vi } from 'vitest';

const modalShow = vi.fn();
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patcher: unknown) => {});
const sendMessage = vi.fn(async (_sessionId: string, _message: string) => {});

vi.mock('@/modal', () => ({
  Modal: {
    show: (cfg: any) => modalShow(cfg),
  },
}));

vi.mock('@/voice/pickers/VoiceSessionSpawnPickerModal', () => ({
  VoiceSessionSpawnPickerModal: () => null,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({ settings: { lastUsedAgent: 'claude' } }),
  },
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
  it('opens a picker and spawns a session from the user-selected machine + directory', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    expect(res).toMatchObject({ type: 'success', sessionId: 's_new' });
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm2', directory: '/tmp/s2', agent: 'claude', serverId: 'server-a' }));
    expect(refreshSessions).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_new', expect.any(Function));
    expect(sendMessage).toHaveBeenCalledWith('s_new', 'Hi');
  });
});

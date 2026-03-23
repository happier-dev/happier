import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const setActiveServerAndSwitch = vi.fn(async (_params: any) => true);
const routerNavigate = vi.fn();
const refreshFromActiveServer = vi.fn(async () => {});
const setPrimaryActionSessionForVoiceTool = vi.fn(async (_params: any) => ({
  ok: true,
  status: 'ok',
  sessionId: 's_default',
}));

const state: any = {
  sessions: {
    s_setup: {
      id: 's_setup',
      metadata: {
        summary: { text: 'Session Setup' },
      },
    },
    s_matrix: {
      id: 's_matrix',
      metadata: {
        name: 'leeroy',
      },
    },
  },
  sessionListViewData: [
    {
      type: 'session',
      session: {
        id: 's_visible',
        updatedAt: 321,
        metadata: {
          summaryText: 'Visible only in current list',
        },
      },
    },
    {
      type: 'session',
      session: {
        id: 's_matrix',
        updatedAt: 322,
        metadata: {
          summaryText: 'Session QA Voice Matrix',
        },
      },
    },
  ],
  sessionListViewDataByServerId: {
    'server-b': [
      {
        type: 'session',
        serverId: 'server-b',
        serverName: 'Server B',
        session: {
          id: 's_other',
          metadata: {
            summary: { text: 'Other summary' },
          },
        },
      },
    ],
  },
};

installVoiceToolActionImplCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: {
        navigate: (path: any, options: any) => routerNavigate(path, options),
      },
    }).module;
  },
});

vi.mock('@/auth/context/AuthContext', () => ({
  getCurrentAuth: () => ({
    refreshFromActiveServer,
  }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
  setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('./sessionTargets', () => ({
  setPrimaryActionSessionId: (params: any) => setPrimaryActionSessionForVoiceTool(params),
}));

describe('openSessionForVoiceTool', () => {
  beforeEach(() => {
    setActiveServerAndSwitch.mockClear();
    routerNavigate.mockClear();
    refreshFromActiveServer.mockClear();
    setPrimaryActionSessionForVoiceTool.mockClear();
  });

  it('returns a human-readable session reference for cached cross-server sessions', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionId: 's_other',
      resolveServerIdForSessionId: () => 'server-b',
      resolveServerNameForSessionId: () => 'Server B',
    });

    expect(setActiveServerAndSwitch).toHaveBeenCalledWith({
      serverId: 'server-b',
      scope: 'device',
      refreshAuth: refreshFromActiveServer,
    });
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_other', expect.any(Object));
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_other',
      session: {
        id: 's_other',
        title: 'Other summary',
        serverId: 'server-b',
        serverName: 'Server B',
      },
    });
  });

  it('fails without mutating voice targets when cross-server switching fails', async () => {
    setActiveServerAndSwitch.mockRejectedValueOnce(new Error('switch_failed'));

    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionId: 's_other',
      resolveServerIdForSessionId: () => 'server-b',
      resolveServerNameForSessionId: () => 'Server B',
    });

    expect(setActiveServerAndSwitch).toHaveBeenCalledWith({
      serverId: 'server-b',
      scope: 'device',
      refreshAuth: refreshFromActiveServer,
    });
    expect(routerNavigate).not.toHaveBeenCalled();
    expect(setPrimaryActionSessionForVoiceTool).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      status: 'server_switch_failed',
      error: {
        code: 'server_switch_failed',
        message: 'server_switch_failed',
        serverId: 'server-b',
        serverName: 'Server B',
      },
    });
  });

  it('opens a session by human title and ignores trailing sentence punctuation', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Session Setup.',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(setActiveServerAndSwitch).not.toHaveBeenCalled();
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_setup', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_setup', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_setup',
      session: {
        id: 's_setup',
        title: 'Session Setup',
      },
    });
  });

  it('opens a session by title when the cached title lives on metadata.summaryText', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Session QA Voice Matrix',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_matrix', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_matrix',
      session: {
        id: 's_matrix',
        title: 'Session QA Voice Matrix',
      },
    });
  });

  it('prefers the current visible session title over a stale raw session title for the same session id', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Session QA Voice Matrix',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_matrix', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_matrix',
      session: {
        id: 's_matrix',
        title: 'Session QA Voice Matrix',
      },
    });
  });

  it('opens a session by title when the session only exists in sessionListViewData', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Visible only in current list',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_visible', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_visible', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_visible',
      session: {
        id: 's_visible',
        title: 'Visible only in current list',
      },
    });
  });

  it('routes session target updates through the canonical synced helper', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    await openSessionForVoiceTool({
      sessionId: 's_setup',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({
      sessionId: 's_setup',
      updateLastFocused: true,
    });
  });
});

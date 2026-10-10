import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';
import type { ActiveServerSwitchResult } from '@/sync/domains/server/activeServerSwitch';

const setActiveServerAndSwitch = vi.fn(async (_params: any): Promise<ActiveServerSwitchResult> => 'switched');
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
  sessionListRowsByServerId: {
    'server-a': {
      s_visible: {
        id: 's_visible',
        updatedAt: 321,
        metadata: {
          summaryText: 'Visible only in current list',
        },
      },
      s_matrix: {
        id: 's_matrix',
        updatedAt: 322,
        metadata: {
          summaryText: 'Session QA Voice Matrix',
        },
      },
    },
    'server-b': {
      s_other: {
        id: 's_other',
        metadata: { summary: { text: 'Other summary' } },
      },
    },
  },
  ordinarySessionListMembershipByServerId: {
    'server-a': ['s_visible', 's_matrix'],
    'server-b': ['s_other'],
  },
  sessionListIndexByServerId: {
    'server-a': [
      { type: 'session', sessionId: 's_visible', serverId: 'server-a', serverName: 'Server A' },
      { type: 'session', sessionId: 's_matrix', serverId: 'server-a', serverName: 'Server A' },
    ],
  },
  concurrentSessionListCacheByServerId: {
    'server-b': {
      serverName: 'Server B',
    },
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

const authFixture = {
  isAuthenticated: true,
  credentials: { token: 'account-token' },
  credentialAuthorityKind: 'account',
  login: async () => ({ kind: 'completed' as const }),
  loginWithCredentials: async () => ({ kind: 'completed' as const }),
  logout: async () => ({ kind: 'completed' as const }),
  refreshFromActiveServer,
} satisfies AuthContextType;
let previousAuth: AuthContextType | null;

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
    previousAuth = getCurrentAuth();
    setCurrentAuth(authFixture);
    setActiveServerAndSwitch.mockReset();
    setActiveServerAndSwitch.mockResolvedValue('switched');
    routerNavigate.mockClear();
    refreshFromActiveServer.mockClear();
    setPrimaryActionSessionForVoiceTool.mockClear();
  });

  afterEach(() => {
    setCurrentAuth(previousAuth);
  });

  it('opens the exact session through the mounted workspace owner for an imperative Voice tool', async () => {
    const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
    const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
    const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
    const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
    const { openSessionForVoiceTool } = await import('./openSession');
    let workspace = createWorkspaceState({ id: 'voice-tool-tab', target: { kind: 'voice', params: {} }, pinned: false, preview: false });
    const navigation = createWorkspaceNavigationAdapter({
      getState: () => workspace, getCatalog: () => [],
      dispatch: (action) => { workspace = reduceWorkspaceState(workspace, action); },
      transport: { commit: () => {} }, createId: () => 'voice-session-tab', onChange: () => {},
    });
    const execute = createWorkspaceActionAdapter({
      getState: () => workspace, navigation, readCanvas: () => null, createId: () => 'voice-session-tab',
    });
    const unregister = registerMountedWorkspaceAction(async ({ actionId, input }) => execute(actionId, input));
    try {
      expect(await openSessionForVoiceTool({ sessionId: 's_setup', serverId: 'server-a', query: { jumpSeq: '42' } }))
        .toMatchObject({ ok: true, address: { serverId: 'server-a', sessionId: 's_setup' } });
      const group = workspace.groups[workspace.focusedGroupId];
      expect(workspace.tabs[group.activeTabId].target).toMatchObject({
        kind: 'session', params: { id: 's_setup', serverId: 'server-a', jumpSeq: '42' },
      });
      expect(routerNavigate).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
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
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_other?serverId=server-b', expect.any(Object));
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
    setActiveServerAndSwitch.mockResolvedValueOnce('blocked');

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
      corpus: { activeServerId: 'server-a', knownServerIds: ['server-a'], coverage: 'complete' },
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(setActiveServerAndSwitch).not.toHaveBeenCalled();
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_setup?serverId=server-a', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_setup', serverId: 'server-a', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_setup',
      session: {
        id: 's_setup',
        title: 'Session Setup',
      },
    });
  });

  it('opens a session by title when the lookup title lives on metadata.summaryText', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Session QA Voice Matrix',
      corpus: { activeServerId: 'server-a', knownServerIds: ['server-a'], coverage: 'complete' },
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix?serverId=server-a', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_matrix', serverId: 'server-a', updateLastFocused: true });
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
      corpus: { activeServerId: 'server-a', knownServerIds: ['server-a'], coverage: 'complete' },
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix?serverId=server-a', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_matrix', serverId: 'server-a', updateLastFocused: true });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's_matrix',
      session: {
        id: 's_matrix',
        title: 'Session QA Voice Matrix',
      },
    });
  });

  it('opens a session by title when the session only exists in the active session lookup index', async () => {
    const { openSessionForVoiceTool } = await import('./openSession');

    const result = await openSessionForVoiceTool({
      sessionTitle: 'Visible only in current list',
      corpus: { activeServerId: 'server-a', knownServerIds: ['server-a'], coverage: 'complete' },
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(routerNavigate).toHaveBeenCalledWith('/session/s_visible?serverId=server-a', expect.any(Object));
    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({ sessionId: 's_visible', serverId: 'server-a', updateLastFocused: true });
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
      serverId: 'server-a',
      resolveServerIdForSessionId: () => null,
      resolveServerNameForSessionId: () => null,
    });

    expect(setPrimaryActionSessionForVoiceTool).toHaveBeenCalledWith({
      sessionId: 's_setup',
      serverId: 'server-a',
      updateLastFocused: true,
    });
  });
});

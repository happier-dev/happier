import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import {
  installSessionActionsCommonModuleMocks,
  resetSessionActionsCommonModuleMockState,
  sessionActionsModuleState,
} from './sessionActionsTestHelpers';
import {
  SESSION_ACTION_ARCHIVE_ID,
  SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
  SESSION_ACTION_MARK_READ_ID,
  SESSION_ACTION_MARK_UNREAD_ID,
  SESSION_ACTION_PIN_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_RESUME_ID,
  SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
  SESSION_ACTION_SET_ATTENTION_STANDING_ID,
  SESSION_ACTION_STOP_ID,
  SESSION_ACTION_UNARCHIVE_ID,
  SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runSessionHandoffPickerFlowMock = vi.hoisted(() => vi.fn());
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn<(options: unknown) => unknown>());
const resolveServerIdForSessionIdFromLocalCacheMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const usePreferredServerIdForSessionMock = vi.hoisted(() => vi.fn());
const fireAndForgetMock = vi.hoisted(() => vi.fn());
const realStorageRef = vi.hoisted(() => ({ current: null as typeof import('@/sync/domains/state/storageStore')['storage'] | null }));

/**
 * `fireAndForget` is an app-wide utility, so a suite cannot assume its own work is the only
 * caller. Production tags every call; select by that tag rather than by position.
 */
function findFireAndForgetByTag(tag: string): Promise<void> {
    const call = fireAndForgetMock.mock.calls.find(
        (candidate) => (candidate[1] as { tag?: string } | undefined)?.tag === tag,
    );
    if (!call) {
        throw new Error(`no fireAndForget call tagged ${tag}; saw: ${fireAndForgetMock.mock.calls
            .map((candidate) => (candidate[1] as { tag?: string } | undefined)?.tag ?? '<untagged>')
            .join(', ')}`);
    }
    return call[0] as Promise<void>;
}
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const buildActionDraftInputMock = vi.hoisted(() => vi.fn());
const teleportVoiceAgentToSessionRootMock = vi.hoisted(() => vi.fn());
const resolveSessionActionDefaultBackendMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const archiveSessionMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const renameSessionMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _title: string,
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const stopSessionMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const unarchiveSessionMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const setAttentionStandingMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _standing: boolean,
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const setManualReadStateMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _readState: 'read' | 'unread',
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
const completeSessionForkNavigationMock = vi.hoisted(() =>
  vi.fn<(params: unknown) => Promise<void>>(async () => undefined),
);
const modalAlertMock = vi.hoisted(() => vi.fn());
const pinRequestMock = vi.hoisted(() => vi.fn());
const appearanceRequestMock = vi.hoisted(() => vi.fn(async () => ({ appearance: null })));
const clipboardMock = vi.hoisted(() => vi.fn(async () => true));

// Network and platform clipboard boundaries; pin orchestration and formatting stay real.
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>(),
  setSessionPin: pinRequestMock,
  setSessionAppearance: appearanceRequestMock,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboardMock }));
// The account encryption-mode HTTP adapter is a network boundary; a plain account writes plain display envelopes.
vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>(),
  fetchAccountEncryptionMode: async () => ({ mode: 'plain' }),
}));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const modalPromptMock = vi.hoisted(() => vi.fn(async () => 'Renamed from header'));
const dropdownRenderCount = vi.hoisted(() => ({
  current: 0,
}));
const voiceSettingState = vi.hoisted(() => ({
  current: null as any,
}));
const serverSnapshotState = vi.hoisted(() => ({
  current: { status: 'ready', features: { features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } } }, capabilities: {} } } as any,
}));
const voiceSessionSnapshotState = vi.hoisted(() => ({
  current: {
    adapterId: null,
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
  } as any,
}));
const actionsSettingsState = vi.hoisted(() => ({
  current: { v: 1, actions: {} } as any,
}));
const buildOrganizationProjectionFixture = (
  attentionStandingsBySessionId: Record<string, { sessionId: string; standing: boolean; updatedAt: number }>,
) => ({
  schemaVersion: 1,
  version: 3,
  pinnedSessionIds: [] as string[],
  pinsBySessionId: {},
  foldersById: {},
  folderAssignmentsBySessionId: {},
  tagsById: {},
  tagAssignmentsBySessionId: {},
  attentionStandingsBySessionId,
  orderEntriesByScopeKey: {},
  labelsByLabelKey: {},
});
const organizationProjectionState = vi.hoisted(() => ({
  current: null as any,
}));
const attentionStandingSettingsState = vi.hoisted(() => ({
  promotionMode: null as string | null,
  defaultStanding: null as boolean | null,
}));
const storageState = vi.hoisted(() => ({
  current: {
    settings: { voice: null as any } as any,
    sessionOrganizationSchemaVersionByServerId: {} as Record<string, number>,
    sessionOrganizationSnapshotVersionByServerId: {} as Record<string, number>,
    sessionOrganizationPinsBySessionKey: {} as Record<string, any>,
    sessionOrganizationFoldersByFolderKey: {} as Record<string, any>,
    sessionOrganizationFolderAssignmentsBySessionKey: {} as Record<string, any>,
    sessionOrganizationTagsByTagKey: {} as Record<string, any>,
    sessionOrganizationTagAssignmentsBySessionKey: {} as Record<string, any>,
    sessionOrganizationAttentionStandingsBySessionKey: {} as Record<string, any>,
    sessionOrganizationOrderEntriesByScopeKey: {} as Record<string, any>,
    sessionOrganizationLabelsByLabelKey: {} as Record<string, any>,
    sessions: {} as Record<string, any>,
    sessionListRenderables: {} as Record<string, any>,
    sessionMessages: {} as Record<string, any>,
    createSessionActionDraft: createSessionActionDraftMock,
  },
}));

installSessionActionsCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Pressable: (props: any) =>
        React.createElement(
          'Pressable',
          props,
          typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
        ),
      View: (props: any) => React.createElement('View', props, props.children),
      Platform: {
        OS: 'web',
      },
      AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      },
    });
  },
  storage: async () => {
    const { createStorageModuleStub, createStorageStoreStub } = await import('@/dev/testkit/mocks/storage');
    const storageStore = createStorageStoreStub(() => {
      if (!realStorageRef.current) throw new Error('Real storage must be initialized before rendering');
      return { ...realStorageRef.current.getState(), ...storageState.current };
    });
    return createStorageModuleStub({
      storage: storageStore,
      getStorage: () => storageStore,
      useSessionOrganizationProjection: () => organizationProjectionState.current,
      useSettings: () => storageState.current.settings,
      useSetting: (key: string) => {
        if (key === 'actionsSettingsV1') return actionsSettingsState.current;
        if (key === 'sessionReplayEnabled') return true;
        if (key === 'voice') return voiceSettingState.current;
        if (key === 'sessionListAttentionPromotionModeV1') return attentionStandingSettingsState.promotionMode;
        if (key === 'sessionListAttentionStandingDefaultV1') return attentionStandingSettingsState.defaultStanding;
        return null;
      },
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        colors: {
          header: { tint: '#fff' },
        },
      },
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertMock,
        confirm: modalConfirmMock,
        prompt: modalPromptMock,
      },
    }).module;
  },
});

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useMemo: actual.useMemo,
    useState: actual.useState,
  };
});

vi.mock('@happier-dev/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
  return {
    ...actual,
    listActionSpecs: () => [
      {
        id: 'session.handoff',
        title: 'Hand off session',
        description: 'Move the current session',
        surfaces: { ui_button: true },
        placements: ['session_action_menu'],
      },
      {
        id: 'subagents.plan.start',
        title: 'Start plan run',
        description: 'Plan changes',
        surfaces: { ui_button: true },
        placements: ['session_action_menu'],
      },
    ],
  };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => {
    dropdownRenderCount.current += 1;
    return React.createElement('DropdownMenu', props);
  },
}));

vi.mock('@/sync/domains/settings/actionsSettings', () => ({
  isActionEnabledInState: (state: any, actionId: string) => {
    const executionRunsEnabled =
      state?.settings?.experiments === true &&
      state?.settings?.featureToggles?.['execution.runs'] === true;
    if (actionId === 'review.start' || actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start') {
      return executionRunsEnabled;
    }
    return true;
  },
}));

vi.mock('@/sync/domains/actions/buildActionDraftInput', () => ({
  buildActionDraftInput: buildActionDraftInputMock,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>, opts?: { onError?: (error: unknown) => void }) => {
    fireAndForgetMock(promise, opts);
    void promise.catch((error: unknown) => {
      opts?.onError?.(error);
    });
  },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: (options: unknown) => createDefaultActionExecutorMock(options),
}));

vi.mock('@/components/sessions/transcript/forkContext/completeSessionForkNavigation', () => ({
  completeSessionForkNavigation: (params: unknown) => completeSessionForkNavigationMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
  resolveServerIdForSessionIdFromLocalCache: (...args: unknown[]) => resolveServerIdForSessionIdFromLocalCacheMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionIdMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: (...args: unknown[]) => usePreferredServerIdForSessionMock(...args),
}));

vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({
  canForkConversation: () => false,
}));

vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => ({
  openSessionForkStrategyFlow: vi.fn(),
}));

vi.mock('@/sync/domains/sessionHandoff/handoffUiSupport', () => ({
  canHandoffConversation: () => true,
}));

vi.mock('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow', () => ({
  runSessionHandoffPickerFlow: (...args: unknown[]) => runSessionHandoffPickerFlowMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/sessionMachineTarget')>();
  return {
    ...actual,
    readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
    resolveMachineTargetForSessionFromState: (_state: unknown, sessionId: string) =>
      readMachineTargetForSessionMock(sessionId),
  };
});

vi.mock('@/sync/ops', () => ({
  sessionArchiveWithServerScope: (
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
  ) => archiveSessionMock(sessionId, opts),
  sessionRename: (
    sessionId: string,
    title: string,
    opts?: Readonly<{ serverId?: string | null }>,
  ) => renameSessionMock(sessionId, title, opts),
  sessionStopWithServerScope: (
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
  ) => stopSessionMock(sessionId, opts),
  sessionUnarchiveWithServerScope: (
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
  ) => unarchiveSessionMock(sessionId, opts),
  sessionSetManualReadStateWithServerScope: (
    sessionId: string,
    readState: 'read' | 'unread',
    opts?: Readonly<{ serverId?: string | null }>,
  ) => setManualReadStateMock(sessionId, readState, opts),
}));

// The op boundary the header menu's attention-standing action resolves by default. Everything
// between the menu item and this call — target build, availability, dropdown item, dispatch,
// `executeSessionAction` — stays real.
vi.mock('@/sync/ops/sessionOrganization', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/ops/sessionOrganization')>(),
  sessionSetAttentionStandingWithServerScope: (
    sessionId: string,
    standing: boolean,
    opts?: Readonly<{ serverId?: string | null }>,
  ) => setAttentionStandingMock(sessionId, standing, opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesSnapshotForServerId: () => serverSnapshotState.current,
}));

vi.mock('@/sync/domains/session/resolveSessionActionDefaultBackend', () => ({
  resolveSessionActionDefaultBackend: (...args: unknown[]) => resolveSessionActionDefaultBackendMock(...args),
}));

vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => voiceSessionSnapshotState.current,
}));

vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
  teleportVoiceAgentToSessionRoot: (args: any) => teleportVoiceAgentToSessionRootMock(args),
}));

const { storage: realStorage } = await import('@/sync/domains/state/storageStore');
realStorageRef.current = realStorage;
const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

describe('SessionHeaderActionMenu handoff', () => {
  it('disables stop and archive when another surface already committed an archive', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createSessionFixture } = await import('@/dev/testkit');
    const session = createSessionFixture({ id: 'pending-header', active: true, owner: 'user_1' });
    const operation = storage.getState().beginSessionArchive(session.id, 'server_a');
    if (!operation) throw new Error('Expected archive admission');
    try {
      const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
      const items = screen.findByType('DropdownMenu' as any).props.items as Array<{ id: string; disabled?: boolean }>;
      expect(items.find((item) => item.id === SESSION_ACTION_ARCHIVE_ID)?.disabled).toBe(true);
      expect(items.find((item) => item.id === SESSION_ACTION_STOP_ID)?.disabled).toBe(true);
    } finally {
      storage.getState().finishSessionArchive(operation);
    }
  });

  beforeEach(async () => {
    realStorage.setState(realStorage.getInitialState(), true);
    resetSessionActionsCommonModuleMockState();
    runSessionHandoffPickerFlowMock.mockReset();
    createDefaultActionExecutorMock.mockReset();
    resolveServerIdForSessionIdFromLocalCacheMock.mockReset();
    resolvePreferredServerIdForSessionIdMock.mockReset();
    usePreferredServerIdForSessionMock.mockReset();
    fireAndForgetMock.mockReset();
    createSessionActionDraftMock.mockReset();
    buildActionDraftInputMock.mockReset();
    teleportVoiceAgentToSessionRootMock.mockReset();
    resolveSessionActionDefaultBackendMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    archiveSessionMock.mockClear();
    renameSessionMock.mockClear();
    stopSessionMock.mockClear();
    unarchiveSessionMock.mockClear();
    setManualReadStateMock.mockReset();
    setAttentionStandingMock.mockReset();
    setAttentionStandingMock.mockResolvedValue({ success: true });
    attentionStandingSettingsState.promotionMode = null;
    attentionStandingSettingsState.defaultStanding = null;
    storageState.current.sessionOrganizationSnapshotVersionByServerId = {};
    storageState.current.sessionOrganizationAttentionStandingsBySessionKey = {};
    organizationProjectionState.current = buildOrganizationProjectionFixture({});
    completeSessionForkNavigationMock.mockReset();
    modalAlertMock.mockClear();
    pinRequestMock.mockReset();
    clipboardMock.mockReset();
    clipboardMock.mockResolvedValue(true);
    modalConfirmMock.mockClear();
    modalPromptMock.mockClear();
    dropdownRenderCount.current = 0;
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockRejectedValue(new Error('unreachable'));
    serverSnapshotState.current = { status: 'ready', features: { features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } } }, capabilities: {} } } as any;

    createDefaultActionExecutorMock.mockReturnValue({
      execute: vi.fn(),
    });
    buildActionDraftInputMock.mockReturnValue({ draft: true });
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_a');
    resolvePreferredServerIdForSessionIdMock.mockImplementation((sessionId: string) =>
      resolveServerIdForSessionIdFromLocalCacheMock(sessionId),
    );
    usePreferredServerIdForSessionMock.mockImplementation((sessionId: string) =>
      resolveServerIdForSessionIdFromLocalCacheMock(sessionId),
    );
    runSessionHandoffPickerFlowMock.mockResolvedValue({ ok: true, handoffId: 'handoff_1' });
    resolveSessionActionDefaultBackendMock.mockReturnValue({
      backendTarget: { kind: 'agent', agentId: 'claude' },
      defaultBackendId: 'claude',
    });
    voiceSettingState.current = null;
    storageState.current = {
      ...storageState.current,
      settings: {
        voice: null,
        experiments: true,
        featureToggles: { 'execution.runs': true },
      },
      sessions: {},
      sessionListRenderables: {},
      sessionMessages: {},
      createSessionActionDraft: createSessionActionDraftMock,
    };
    voiceSessionSnapshotState.current = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState.current as any);
    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
    for (const binding of voiceSessionBindingStore.getState().list()) {
      voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
    }
  });

  it.each([false, true])('offers the current pin direction and updates the session organization (pinned=%s)', async (pinned) => {
    const profile = upsertServerProfile({
      serverUrl: 'https://header-pins.example',
      name: 'Header pin test',
    });
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue(profile.id);
    const session = createSessionFixture({ id: 'header-pin', active: false });
    organizationProjectionState.current = {
      ...buildOrganizationProjectionFixture({}),
      pinnedSessionIds: pinned ? [session.id] : [],
    };
    const pin = { sessionId: session.id, sortKey: null, pinnedAt: 99 };
    realStorage.getState().setSessionPinOptimistic(profile.id, session.id, pinned ? pin : null);
    pinRequestMock.mockResolvedValue({ pin: pinned ? null : pin });
    const credentialsSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
      .mockResolvedValue({ token: 'header-token', secret: 'header-secret' });
    try {
      const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
      const dropdown = screen.findByType('DropdownMenu' as React.ElementType);
      const actionId = pinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID;
      expect(dropdown.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: actionId })]));
      expect(dropdown.props.items.some((item: { id: string }) => item.id === (pinned ? SESSION_ACTION_PIN_ID : SESSION_ACTION_UNPIN_ID))).toBe(false);
      await act(async () => {
        dropdown.props.onSelect(actionId);
        await findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionPin');
      });
      expect(pinRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        serverUrl: profile.serverUrl,
        sessionId: session.id,
        request: { pinned: !pinned, sortKey: undefined },
      }));
      expect(realStorage.getState().sessionOrganizationPinsBySessionKey[`${profile.id}:${session.id}`])
        .toEqual(pinned ? undefined : pin);
    } finally {
      credentialsSpy.mockRestore();
    }
  });

  it('offers Set color only where the server stores session colours, and writes the chosen colour for this session', async () => {
    const profile = upsertServerProfile({ serverUrl: 'https://header-colours.example', name: 'Header colour test' });
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue(profile.id);
    resolvePreferredServerIdForSessionIdMock.mockReturnValue(profile.id);
    usePreferredServerIdForSessionMock.mockReturnValue(profile.id);
    const session = createSessionFixture({ id: 'header-colour', active: false });
    const credentialsSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
      .mockResolvedValue({ token: 'header-token', secret: 'header-secret' });
    const openMenu = async (screen: Awaited<ReturnType<typeof renderScreen>>) => {
      await act(async () => {
        screen.findByType('DropdownMenu' as React.ElementType).props.onOpenChange(true);
      });
      return screen.findByType('DropdownMenu' as React.ElementType);
    };
    try {
      const unsupported = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
      expect(((await openMenu(unsupported)).props.items as Array<{ id: string }>).map((item) => item.id))
        .not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
      await unsupported.unmount();

      realStorage.setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { [profile.id]: true } } as any);
      const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
      const dropdown = await openMenu(screen);
      const colorItem = (dropdown.props.items as any[]).find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
      expect(colorItem?.submenu?.items.some((item: { swatch?: unknown }) => item.swatch)).toBe(true);
      const green = (colorItem.submenu.items as Array<{ id: string }>).find((item) => item.id.endsWith(':accent:green'))!;
      await act(async () => {
        dropdown.props.onSelect(green.id);
        await findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionAppearance');
      });
      expect(appearanceRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        serverUrl: profile.serverUrl,
        sessionId: session.id,
      }));
    } finally {
      credentialsSpy.mockRestore();
    }
  });

  it('copies session information from the header with developer mode disabled', async () => {
    const session = createSessionFixture({
      id: 'header-copy',
      metadata: { path: '/workspace', host: 'test-host', flavor: 'claude', claudeSessionId: 'vendor-session', sessionLogPath: '/tmp/session.log' },
    });
    const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
    await act(async () => { screen.findByType('DropdownMenu' as React.ElementType).props.onOpenChange(true); });
    storageState.current.sessions = {
      [session.id]: { ...session, metadata: { ...session.metadata, claudeSessionId: 'current-vendor-session' } },
    };
    const dropdown = screen.findByType('DropdownMenu' as React.ElementType);
    expect(dropdown.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session.copy' }),
    ]));
    expect(dropdown.props.items.at(-1)?.id).toBe('session.copy');
    await act(async () => {
      dropdown.props.onSelect('session.copyDebugInformation');
      await findFireAndForgetByTag('SessionHeaderActionMenu.execute.copyInformation');
    });
    expect(clipboardMock).toHaveBeenCalledWith([
      'Happier session ID: header-copy',
      'agentInput.agent.claude session ID: current-vendor-session',
      'Happier logs: /tmp/session.log',
    ].join('\n'));
    for (const [itemId, expected] of [
      ['session.copySessionId', session.id],
      ['session.copyProviderSessionId', 'current-vendor-session'],
    ]) {
      await act(async () => { dropdown.props.onOpenChange(true); });
      await act(async () => {
        dropdown.props.onSelect(itemId);
        await findFireAndForgetByTag('SessionHeaderActionMenu.execute.copyInformation');
      });
      expect(clipboardMock).toHaveBeenLastCalledWith(expected);
    }

  });

  it('omits the provider ID choice when no provider session ID is available', async () => {
    const session = createSessionFixture({ id: 'header-no-provider-id' });
    const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
    await act(async () => { screen.findByType('DropdownMenu' as React.ElementType).props.onOpenChange(true); });
    const copyMenu = screen.findByType('DropdownMenu' as React.ElementType).props.items
      .find((item: { id: string }) => item.id === 'session.copy');
    expect(copyMenu.submenu.items.map((item: { id: string }) => item.id)).toEqual([
      'session.copyDebugInformation', 'session.copySessionId',
    ]);
  });

  it.each(['session.copyDebugInformation', 'session.copySessionId', 'session.copyProviderSessionId'])('reports clipboard refusal for %s from the header', async (actionId) => {
    clipboardMock.mockResolvedValue(false);
    const session = createSessionFixture({ id: 'header-copy-failure', metadata: { path: '/workspace', host: 'host', flavor: 'claude', claudeSessionId: 'vendor-session' } });
    const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
    await act(async () => { screen.findByType('DropdownMenu' as React.ElementType).props.onOpenChange(true); });
    await act(async () => {
      screen.findByType('DropdownMenu' as React.ElementType).props.onSelect(actionId);
      await findFireAndForgetByTag('SessionHeaderActionMenu.execute.copyInformation');
    });
    expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'sessionInfo.failedToCopyMetadata');
  });

  it('delivers an inactive session header resume request to its session listener and awaits completion', async () => {
    const { useSessionResumeRequestListener } = await import('@/components/sessions/model/sessionResumeRequests');
    const session = {
      id: 'sess_resumable',
      active: false,
      owner: 'user_1',
      accessLevel: undefined,
      seq: 4,
      metadata: {
        flavor: 'claude',
        claudeSessionId: 'claude_vendor_session',
      },
    } as any;
    const resumeCompletion = createDeferred<boolean>();
    const resumeListener = vi.fn(() => resumeCompletion.promise);
    const otherSessionListener = vi.fn(async () => true);

    function ResumeRequestListener(props: Readonly<{ children: React.ReactNode }>) {
      useSessionResumeRequestListener(session.id, resumeListener);
      useSessionResumeRequestListener('other-session', otherSessionListener);
      return props.children;
    }

    const screen = await renderScreen(
      <ResumeRequestListener>
        <SessionHeaderActionMenu
          sessionId={session.id}
          session={session}
        />
      </ResumeRequestListener>,
    );

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.map((item: { id: string }) => item.id)).toContain(SESSION_ACTION_RESUME_ID);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_RESUME_ID);
    });

    expect(resumeListener).toHaveBeenCalledTimes(1);
    expect(otherSessionListener).not.toHaveBeenCalled();
    // Selected by the tag production already stamps, not by call index: `fireAndForget` is a
    // shared utility and unrelated background work (e.g. `Sync.pruneStaleInstanceChangesCursors`)
    // legitimately shares it, so an index or a total-count assertion is a false contract.
    const resumeAction = findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionResume');
    let settled = false;
    void resumeAction.then(
      () => {
        settled = true;
      },
    );
    await flushHookEffects();
    expect(settled).toBe(false);

    resumeCompletion.resolve(false);
    await act(async () => {
      await resumeAction;
    });
    expect(settled).toBe(true);
    expect(modalAlertMock).not.toHaveBeenCalled();
  });

  it('shows a resume failure when the header request has no mounted session listener', async () => {
    const session = {
      id: 'sess_without_listener',
      active: false,
      owner: 'user_1',
      accessLevel: undefined,
      seq: 4,
      metadata: {
        flavor: 'claude',
        claudeSessionId: 'claude_vendor_session',
      },
    } as any;

    const screen = await renderScreen(
      <SessionHeaderActionMenu sessionId={session.id} session={session} />,
    );
    const dropdown = screen.findByType('DropdownMenu' as any);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_RESUME_ID);
      await flushHookEffects();
    });

    const resumeAction = findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionResume');
    await expect(resumeAction).rejects.toThrow();
    expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'session.resumeFailed');
  });

  it.each([
    ['active', { active: true, metadata: { flavor: 'claude', claudeSessionId: 'claude_vendor_session' } }],
    ['non-resumable', { active: false, metadata: { flavor: 'unknown-provider' } }],
  ])('does not offer standalone resume for a %s session', async (_label, overrides) => {
    const session = {
      id: 'sess_without_resume',
      owner: 'user_1',
      accessLevel: undefined,
      seq: 4,
      ...overrides,
    } as any;

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId={session.id}
      session={session}
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.map((item: { id: string }) => item.id)).not.toContain(SESSION_ACTION_RESUME_ID);
  });

  it('routes forked child session opens through the shared fork completion helper', async () => {

    await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
    />);

    const executorOptions = createDefaultActionExecutorMock.mock.calls[0]?.[0] as any;
    expect(executorOptions?.openSession).toEqual(expect.any(Function));

    await executorOptions.openSession('sess_child');

    expect(completeSessionForkNavigationMock).toHaveBeenCalledWith({
      childSessionId: 'sess_child',
      parentSessionId: 'sess_1',
      serverId: 'server_a',
      navigate: expect.any(Function),
    });

    const helperParams = completeSessionForkNavigationMock.mock.calls[0]?.[0] as any;
    helperParams.navigate('sess_next');
    // The canonical opener now carries the resolved server scope in the href; asserting the bare
    // path would pin the pre-migration shape.
    expect(String(sessionActionsModuleState.routerNavigateSpy.mock.calls[0]?.[0])).toContain('/session/sess_next');
    expect(String(sessionActionsModuleState.routerNavigateSpy.mock.calls[0]?.[0])).toContain('serverId=');
    expect(sessionActionsModuleState.routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular?.()).toBe('session');
  });

  it('keeps the closed trigger stable when only the session sequence changes', async () => {
    const metadata = {
      machineId: 'machine_source',
      flavor: 'claude',
    };

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata,
      } as any}
    />);

    const initialRenderCount = dropdownRenderCount.current;
    expect(initialRenderCount).toBeGreaterThan(0);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 11,
        metadata,
      } as any}
    />);

    expect(dropdownRenderCount.current).toBe(initialRenderCount);
  });

  it('keeps the closed trigger stable when metadata only changes freshness timestamps', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
          summary: { text: 'same summary', updatedAt: 100 },
          sessionModesV1: {
            v: 1,
            provider: 'claude',
            updatedAt: 100,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            provider: 'claude',
            updatedAt: 100,
            currentModelId: 'model-a',
            availableModels: [{ id: 'model-a', name: 'Model A' }],
          },
        },
      } as any}
    />);

    const initialRenderCount = dropdownRenderCount.current;
    expect(initialRenderCount).toBeGreaterThan(0);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
          summary: { text: 'same summary', updatedAt: 200 },
          sessionModesV1: {
            v: 1,
            provider: 'claude',
            updatedAt: 200,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            provider: 'claude',
            updatedAt: 200,
            currentModelId: 'model-a',
            availableModels: [{ id: 'model-a', name: 'Model A' }],
          },
        },
      } as any}
    />);

    expect(dropdownRenderCount.current).toBe(initialRenderCount);
  });

  it('refreshes lifecycle action items when session active state changes', async () => {
    const metadata = {
      machineId: 'machine_source',
      flavor: 'claude',
    };

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        active: true,
        archivedAt: null,
        owner: 'user_1',
        accessLevel: undefined,
        metadata,
      } as any}
    />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_STOP_ID)).toBe(true);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        active: false,
        archivedAt: null,
        owner: 'user_1',
        accessLevel: undefined,
        metadata,
      } as any}
    />);

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_STOP_ID)).toBe(false);
  });

  it('prefers the reachable source machine id for handoff gating and flow context when session metadata is stale', async () => {
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    });
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_rebound',
    });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
    vi.useFakeTimers();
    try {
      await act(async () => {
        dropdown.props.onSelect('session.handoff');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }
    await flushHookEffects({ cycles: 1 });

    expect(runSessionHandoffPickerFlowMock).toHaveBeenCalledWith({
      execute: expect.any(Function),
      sessionId: 'sess_1',
      sourceMachineId: 'machine_rebound',
      serverId: 'server_a',
      placement: 'session_action_menu',
    });
  });

  it('shows mark-unread for a read session and uses the selected server scope', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_read"
          session={{
            id: 'sess_read',
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_MARK_UNREAD_ID);
    });

    expect(setManualReadStateMock).toHaveBeenCalledWith('sess_read', 'unread', { serverId: 'server_a' });
  });

  it('shows mark-read for an unread session and uses the selected server scope', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_unread"
          session={{
            id: 'sess_unread',
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_MARK_READ_ID);
    });

    expect(setManualReadStateMock).toHaveBeenCalledWith('sess_unread', 'read', { serverId: 'server_a' });
  });

  it('refreshes header read-state actions from row renderable state when the session shell is stable', async () => {
    const session = {
      id: 'sess_stable_read_state',
      seq: 7,
      lastViewedSessionSeq: 7,
      latestReadyEventSeq: 7,
      latestTurnStatus: 'completed',
      archivedAt: null,
      metadata: null,
    };
    storageState.current.sessions = {
      sess_stable_read_state: session,
    };


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_stable_read_state"
          session={session as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

    storageState.current = {
      ...storageState.current,
      sessionListRenderables: {
        sess_stable_read_state: {
          id: 'sess_stable_read_state',
          seq: 7,
          lastViewedSessionSeq: 6,
          hasUnreadMessages: true,
        },
      },
    };

    await act(async () => {
      dropdown.props.onOpenChange(true);
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(false);
  });

  it('keeps a session in Needs attention from the header menu and reaches the standing op', async () => {
    attentionStandingSettingsState.promotionMode = 'global';
    storageState.current.sessionOrganizationSnapshotVersionByServerId = { server_a: 3 };


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_standing"
          session={{
            id: 'sess_standing',
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const ids = dropdown.props.items.map((item: any) => item?.id);
    expect(ids).toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    });
    await findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionAttentionStanding');

    expect(setAttentionStandingMock).toHaveBeenCalledWith('sess_standing', true, { serverId: 'server_a' });
  });

  it('offers the remove direction once the session is already kept in Needs attention', async () => {
    attentionStandingSettingsState.promotionMode = 'global';
    storageState.current.sessionOrganizationSnapshotVersionByServerId = { server_a: 3 };
    organizationProjectionState.current = buildOrganizationProjectionFixture({
      'sess_standing': { sessionId: 'sess_standing', standing: true, updatedAt: 1 },
    });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_standing"
          session={{
            id: 'sess_standing',
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const ids = dropdown.props.items.map((item: any) => item?.id);
    expect(ids).toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
    expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
    });
    await findFireAndForgetByTag('SessionHeaderActionMenu.execute.sessionAttentionStanding');

    expect(setAttentionStandingMock).toHaveBeenCalledWith('sess_standing', false, { serverId: 'server_a' });
  });

  it('hides the attention-standing action while the attention band is off', async () => {
    attentionStandingSettingsState.promotionMode = 'off';
    storageState.current.sessionOrganizationSnapshotVersionByServerId = { server_a: 3 };


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_standing"
          session={{
            id: 'sess_standing',
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const ids = dropdown.props.items.map((item: any) => item?.id);
    expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
  });

  it('surfaces central lifecycle actions in the header menu', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_active"
          session={{
            id: 'sess_active',
            seq: 2,
            active: true,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const ids = dropdown.props.items.map((item: any) => item?.id);
    expect(ids).toContain(SESSION_ACTION_RENAME_ID);
    expect(ids).toContain(SESSION_ACTION_STOP_ID);
    expect(ids).toContain(SESSION_ACTION_ARCHIVE_ID);
  });

  it('executes archive from the header menu through the central action seam', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_archive"
          session={{
            id: 'sess_archive',
            seq: 2,
            active: false,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_ARCHIVE_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_ARCHIVE_ID);
    });
    const pending = fireAndForgetMock.mock.calls[fireAndForgetMock.mock.calls.length - 1]?.[0] as Promise<unknown> | undefined;
    expect(pending).toBeDefined();
    await act(async () => {
      await pending;
    });

    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(archiveSessionMock).toHaveBeenCalledWith('sess_archive', { serverId: 'server_a' });
  });

  it('uses the unarchive failure fallback when header unarchive receives a non-error rejection', async () => {
    unarchiveSessionMock.mockRejectedValueOnce('failed');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_archived"
          session={{
            id: 'sess_archived',
            seq: 2,
            active: false,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: 123,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_UNARCHIVE_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_UNARCHIVE_ID);
    });
    const pending = fireAndForgetMock.mock.calls[fireAndForgetMock.mock.calls.length - 1]?.[0] as Promise<unknown> | undefined;
    expect(pending).toBeDefined();
    await act(async () => {
      await pending;
    });

    expect(modalAlertMock).toHaveBeenCalledWith(
      'common.error',
      'sessionInfo.failedToUnarchiveSession',
    );
  });

  it('does not show mark-read for non-terminal raw session seq', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_non_terminal_raw"
          session={{
            id: 'sess_non_terminal_raw',
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID || item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(false);
  });

  it('does not show read-state actions for archived sessions', async () => {

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_archived"
          session={{
            id: 'sess_archived',
            seq: 2,
            lastViewedSessionSeq: 2,
            archivedAt: 123,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID || item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(false);
  });

  it('fails closed (does not surface session.handoff) when machine transfer is disabled on the selected server', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: false,
              directPeer: { enabled: false },
              serverRouted: { enabled: false },
            },
          },
        },
        capabilities: {},
      }),
    } as any;


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
  });

  it('fails closed when direct peer is runtime-unknown and the selected server only exposes direct-peer handoff transport', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: true },
              serverRouted: { enabled: false },
            },
          },
        },
        capabilities: {},
      }),
    } as any;


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
  });

  it('fails closed when direct peer viability is runtime-unknown and the selected server would otherwise downgrade through server-routed fallback', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: true },
              serverRouted: { enabled: true },
            },
          },
        },
        capabilities: {},
      }),
    } as any;


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
  });

  it('offers handoff when the selected server supports server-routed transport', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: false },
              serverRouted: { enabled: true },
            },
          },
        },
        capabilities: {},
      }),
    } as any;


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('reacts when machine-rpc direct-peer viability becomes available after mount', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_reactive_header');


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);

    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    await act(async () => {
      recordCachedMachineRpcDirectRouteViable({
        serverId: 'server_reactive_header',
        remoteMachineId: 'machine_source',
      });
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('surfaces session.handoff when source reachability is proven through server-scoped rpc even without a cached direct route', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_scoped_only');
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_scoped',
      basePath: '/workspace/repo',
    });
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    await flushHookEffects({ cycles: 2 });

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('surfaces session.handoff when the local session cache misses but the preferred server resolver falls back to the active server', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue(null);
    resolvePreferredServerIdForSessionIdMock.mockReturnValue('server_preferred_header');
    usePreferredServerIdForSessionMock.mockReturnValue('server_preferred_header');
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_scoped',
      basePath: '/workspace/repo',
    });
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    await flushHookEffects({ cycles: 2 });

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('seeds configured ACP backend targets into non-handoff action drafts', async () => {
    resolveSessionActionDefaultBackendMock.mockReturnValue({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'acp-backend' },
      defaultBackendId: 'claude',
    });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              flavor: 'customAcp',
              acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 1,
                backendId: 'acp-backend',
                title: 'Review Bot',
              },
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onSelect('subagents.plan.start');
    });
    await flushHookEffects({ cycles: 1 });

    expect(buildActionDraftInputMock).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'subagents.plan.start',
      sessionId: 'sess_1',
      defaultBackendTarget: { kind: 'configuredAcpBackend', backendId: 'acp-backend' },
      defaultBackendId: 'claude',
      instructions: '',
    }));
    expect(createSessionActionDraftMock).toHaveBeenCalledWith('sess_1', {
      actionId: 'subagents.plan.start',
      input: { draft: true },
    });
  });

  it('adds a teleport action for session menus when a daemon voice agent conversation already exists', async () => {
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { scopeDefault: 'global', surfaceLocation: 'auto', activityFeedEnabled: false },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
      },
    };
    storageState.current.settings.voice = voiceSettingState.current;
    voiceSessionSnapshotState.current = {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 'sess_1',
      updatedAt: 1,
    });


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'codex',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'voice.teleport',
          title: 'voiceSurface.a11y.teleport',
        }),
      ]),
    );

    teleportVoiceAgentToSessionRootMock.mockResolvedValue({ ok: true });
    await act(async () => {
      dropdown.props.onSelect('voice.teleport');
    });
    await flushHookEffects({ cycles: 1 });

    expect(teleportVoiceAgentToSessionRootMock).toHaveBeenCalledWith({ sessionId: 'sess_1' });
  });

  it('adds a teleport action when the global daemon voice conversation exists only in shared session state', async () => {
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { scopeDefault: 'global', surfaceLocation: 'auto', activityFeedEnabled: false },
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
      },
    };
    storageState.current.settings.voice = voiceSettingState.current;
    storageState.current.sessions = {
      sys_voice: {
        id: 'sys_voice',
        active: true,
        updatedAt: 10,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
    };
    voiceSessionSnapshotState.current = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };


    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'codex',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'voice.teleport',
          title: 'voiceSurface.a11y.teleport',
        }),
      ]),
    );
  });

  it('drops execution-run menu items after execution runs are disabled in settings', async () => {
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_source',
    });

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subagents.plan.start',
          title: 'Start plan run',
        }),
      ]),
    );

    storageState.current = {
      ...storageState.current,
      settings: {
        ...storageState.current.settings,
        experiments: false,
        featureToggles: {},
      },
    };

    await act(async () => {
      dropdown.props.onOpenChange(true);
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subagents.plan.start',
        }),
      ]),
    );
  });
});

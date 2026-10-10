import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import type { ReactTestInstance } from 'react-test-renderer';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { pressTestInstance, pressTestInstanceAsync, renderScreen as renderCanonicalScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  EMPTY_PLUGIN_UI_PROJECTION,
  isPluginUiDestinationSurfacePlacementProjection,
  type PluginUiProjectionModel,
  type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { createPluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import 'fake-indexeddb/auto';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildRealmQualifiedSessionCompanionPreferenceKey } from '@/components/sessions/companion/state/sessionCompanionPreferenceKey';
import type { SessionCompanionPreferencesV1 } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionConnectedServicesAuthSwitchResult } from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());
const attachedTerminalState = vi.hoisted(() => ({ available: false, open: vi.fn() }));
const chatHeaderSpy = vi.hoisted(() => vi.fn());
const agentInputSpy = vi.hoisted(() => vi.fn());
const connectedServicesAuthSwitchSpy = vi.hoisted(() => vi.fn());
const connectedServicesAuthSwitchResultSpy = vi.hoisted(() => vi.fn<(result: SessionConnectedServicesAuthSwitchResult) => void>());
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
  (globalThis as any).location.href = 'http://localhost/session/s1/previous';
  (globalThis as any).location.pathname = '/session/s1/previous';
}));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const keyboardDismissSpy = vi.hoisted(() => vi.fn());
let ensureSidechainMessagesLoadedSpy: MockInstance<typeof import('@/sync/sync')['sync']['ensureSidechainMessagesLoaded']>;
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));
const paneOpenRightSpy = vi.hoisted(() => vi.fn());
const paneSetRightTabSpy = vi.hoisted(() => vi.fn());
const paneOpenDetailsTabSpy = vi.hoisted(() => vi.fn());
const paneSelectRightDestinationSpy = vi.hoisted(() => vi.fn());
const paneScopeState = vi.hoisted(() => ({
  value: null as null | {
    details: { isOpen: boolean; activeTabKey: string | null; tabs: readonly unknown[]; groups: readonly unknown[] };
    right: { isOpen: boolean };
    bottom: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
  },
}));
const appPaneSurfaceOpenSpy = vi.hoisted(() => vi.fn<PluginSurfaceOpenHandler>(async () => ({ ok: true as const })));
const freshPaneBridgeFixture = vi.hoisted(() => ({ enabled: false }));
const scopedPluginProjectionState = vi.hoisted(() => ({
  projection: null as PluginUiProjectionModel | null,
}));
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android' }));
const responsiveState = vi.hoisted(() => ({ deviceType: 'phone' as 'phone' | 'tablet', isLandscape: false }));
const windowDimensionsState = vi.hoisted(() => ({ width: 800, height: 600 }));
const executionRunsFeatureState = vi.hoisted(() => ({ enabled: false }));
const backendCatalogEntriesState = vi.hoisted(() => ({
  entries: [] as ResolvedBackendCatalogEntry[],
}));
const teamCredentialCatalogState = vi.hoisted(() => ({
  resources: [] as TeamCredentialResourceCatalogEntryV1[],
  teamNameById: {} as Record<string, string>,
  currentResourceKeys: new Set<string>(),
}));
const boardFeatureState = vi.hoisted(() => ({
  enabled: false,
  itemCount: 0,
  /** When set, only these Homes answer `enabled` for `sessions.board`. */
  enabledServerIds: null as readonly string[] | null,
}));
const companionPreferenceState = vi.hoisted(() => ({
  stored: undefined as undefined | SessionCompanionPreferencesV1[string],
}));
const companionPreferenceMutateSpy = vi.hoisted(() => vi.fn());
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: false }));
const executionRunsBackendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const sessionMessagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const automationsSupportState = vi.hoisted(() => ({ enabled: false }));
const automationsState = vi.hoisted(() => ({ enabledCount: 0 }));
const localSettingsState = vi.hoisted(() => ({
  mobileWorkspaceExperienceV1: 'classic' as 'classic' | 'cockpit',
}));
const sessionMachineControlTargetState = vi.hoisted(() => ({
    target: null as { machineId: string; basePath: string; confidence: 'reachable' | 'metadata_direct' } | null,
}));
const createEditableSessionAccessFixture = vi.hoisted(() => () => ({
  role: 'recipient' as const,
  level: 'edit' as const,
  capabilities: {
    readTranscript: true,
    submitAgentInput: true,
    editSessionRecords: true,
    approveRuntimePermissions: true,
    manageAccess: false,
    managePermissionDelegation: false,
    managePublicLink: false,
    archiveSession: false,
    renameSession: false,
    assignResponsibility: false,
    stopSession: false,
    deleteSession: false,
  },
}));
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    serverId: 'server-1',
    metadata: null,
    accessLevel: 'edit',
    access: createEditableSessionAccessFixture(),
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));
sessionState.session = createSessionFixture({
  id: 's1', serverId: 'server-1', metadata: { path: '/Users/tester/project', host: 'tester.local', flavor: 'codex' },
  accessLevel: 'edit', access: createEditableSessionAccessFixture(),
  canApprovePermissions: true, agentState: { controlledByUser: true },
});

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
  const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
  return createBrowserRecordStorageModuleMock();
});
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
}));

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: () => null,
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => {
    const projection = scopedPluginProjectionState.projection;
    const binding = React.useMemo(() => createPluginSurfaceDestinationNavigationBinding({
      placements: projection
        ? Object.values(projection.surfacePlacementsById).filter(isPluginUiDestinationSurfacePlacementProjection)
        : [],
      targetKind: 'session',
      scopedLaunchFacts: {
        serverId: 'server-1',
        machineId: 'machine-1',
        interactionEnabled: true,
      },
    }), [projection]);
    React.useEffect(() => {
      const disposeRight = binding.registerOwner({
        container: 'rightPane',
        handler: (resolution) => appPaneSurfaceOpenSpy(resolution.request),
      });
      const disposeBottom = binding.registerOwner({
        container: 'bottomPane',
        handler: (resolution) => appPaneSurfaceOpenSpy(resolution.request),
      });
      const disposeDetails = binding.registerOwner({
        container: 'detailsTab',
        handler: (resolution) => appPaneSurfaceOpenSpy(resolution.request),
      });
      return () => {
        disposeRight();
        disposeBottom();
        disposeDetails();
      };
    }, [binding]);
    React.useEffect(() => {
      if (!freshPaneBridgeFixture.enabled) return;
      props.onPluginSurfaceNavigationBindingChange?.(binding);
      return () => props.onPluginSurfaceNavigationBindingChange?.(undefined);
    }, [binding, props.onPluginSurfaceNavigationBindingChange]);
    return React.createElement('AppPaneScopeHost', props, props.main ?? null);
  },
}));
// Leaf Companion surfaces are stubbed so the shell's admission decision — mount
// or do not mount — stays observable; the decision itself runs for real.
vi.mock('@/components/sessions/companion/SessionCompanionHost', () => ({
  SessionCompanionHost: (props: any) => React.createElement('SessionCompanionHost', props),
}));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionPresentationBridge', () => ({
  SessionCompanionPresentationBridge: (props: any) => React.createElement('SessionCompanionPresentationBridge', props),
}));
vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/plugins/projection/useScopedPluginUiProjection')>();
  return {
    ...actual,
    useScopedPluginUiProjection: (...args: Parameters<typeof actual.useScopedPluginUiProjection>) => (
      freshPaneBridgeFixture.enabled
        ? {
          pluginUiProjection: scopedPluginProjectionState.projection,
          pluginBrowserProjection: null,
          machineId: 'machine-1',
          serverId: 'server-1',
          interactionEnabled: true,
          platform: 'web',
        }
        : actual.useScopedPluginUiProjection(...args)
    ),
  };
});
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
  SessionBoardControllerProvider: ({ children }: React.PropsWithChildren) => children,
  useMountedSessionBoardController: (address: { serverId: string; sessionId: string } | null) => (
    boardFeatureState.enabled && address
      ? {
        address,
        binding: {
          status: 'ready',
          snapshot: {
            itemsById: new Map(Array.from(
              { length: boardFeatureState.itemCount },
              (_, index) => [`item-${index}`, {
                itemId: `item-${index}`,
                revision: `revision-${index}`,
                state: {
                  kind: 'ready',
                  item: {
                    v: 1,
                    itemId: `item-${index}`,
                    title: '',
                    source: {
                      kind: 'installedSurface',
                      surface: { pluginId: 'acme.board', localId: `item-${index}` },
                    },
                  },
                },
              }],
            )),
            layoutState: { kind: 'ready' },
            loading: 'idle',
            freshness: 'fresh',
            incomplete: false,
            reachability: 'reachable',
            canEdit: true,
          },
        },
        pluginRuntime: {
          pluginUiProjection: null,
          pluginBrowserProjection: null,
          phase: 'unavailable',
          interactionEnabled: false,
          machineId: null,
          serverId: address.serverId,
          platform: 'web',
        },
        // The mounted Board controller the Session shell reads for item
        // affordances and source availability.
        controller: {
          supports: () => false,
          run: () => undefined,
          resolveSourceAvailability: () => undefined,
        },
        resolvePrimaryHost: () => null,
        callerHostedHtmlRuntime: null,
      }
      : null
  ),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: (props: any) => {
    chatHeaderSpy(props);
    return React.createElement('ChatHeaderView', props, props.rightElement ?? null);
  },
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
  SessionHeaderActionMenu: (props: any) => {
    headerActionMenuSpy(props);
    return React.createElement('SessionHeaderActionMenu');
  },
}));
vi.mock('@/components/sessions/terminal/openAttachedSessionTerminal', () => ({
  useOpenAttachedSessionTerminal: () => attachedTerminalState,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string, scope?: Readonly<{ serverId?: string | null }>) => {
    if (featureId !== 'sessions.board') return executionRunsFeatureState.enabled;
    // The exact Home decides. A same-id Session on another Home must never
    // borrow this Home's answer.
    if (boardFeatureState.enabledServerIds) {
      return boardFeatureState.enabledServerIds.includes(scope?.serverId ?? '');
    }
    return boardFeatureState.enabled;
  },
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
  useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedState.supported,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => executionRunsBackendsState.backends,
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));
vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  getResolvedBackendCatalogEntries: () => backendCatalogEntriesState.entries,
}));
vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
  useHomeTeamCredentialModelCatalog: () => ({
    resources: teamCredentialCatalogState.resources,
    teamNameById: teamCredentialCatalogState.teamNameById,
    homeNameByTeamId: {},
    currentResourceKeys: teamCredentialCatalogState.currentResourceKeys,
    current: true,
    condition: null,
  }),
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));
vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['codex'],
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
  useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: {} }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canResumeSessionWithOptions: () => true,
}));
vi.mock('@/agents/catalog/agentUniverse', () => ({
  buildAgentUniverseBackendTargetKey: (providerId: string) => `provider:${providerId}`,
  listAgentUniverseIds: () => ['codex'],
}));
vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
  navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => responsiveState.deviceType,
  useHeaderHeight: () => 0,
  useIsLandscape: () => responsiveState.isLandscape,
  useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
  useSessionReachableMachineTarget: () => null,
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineTarget: () => null,
  useSessionMachineControlTarget: () => sessionMachineControlTargetState.target,
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => {
    agentInputSpy(props);
    return null;
  },
}));
vi.mock('@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch')>();
  return { ...actual, useSessionConnectedServicesAuthSwitch: (props: Parameters<typeof actual.useSessionConnectedServicesAuthSwitch>[0]) => {
    connectedServicesAuthSwitchSpy(props);
    const result = actual.useSessionConnectedServicesAuthSwitch(props);
    connectedServicesAuthSwitchResultSpy(result);
    return result;
  } };
});
vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

installSessionShellCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const module = await createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      useWindowDimensions: () => ({ width: windowDimensionsState.width, height: windowDimensionsState.height }),
    });
    Object.defineProperty(module.Platform, 'OS', {
      configurable: true,
      get: () => platformState.os,
    });
    module.Platform.select = (spec: Record<string, unknown>) =>
      spec && Object.prototype.hasOwnProperty.call(spec, platformState.os)
        ? (spec as any)[platformState.os]
        : (spec as any).default;
    Object.assign(module.Keyboard, {
      dismiss: keyboardDismissSpy,
    });
    return module;
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        text: '#000',
        textSecondary: '#666',
        textLink: '#00f',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        surfaceSelected: '#eef4ff',
        divider: '#ddd',
        border: '#ddd',
        indigo: '#5856D6',
        radio: { active: '#007AFF' },
        accent: {
          blue: '#007AFF',
          green: '#34C759',
          orange: '#FF9500',
          yellow: '#FFCC00',
          red: '#FF3B30',
          indigo: '#5856D6',
          purple: '#AF52DE',
        },
        modal: { border: '#ddd' },
        input: { background: '#f5f5f5' },
        header: { tint: '#000' },
        status: { error: '#f00' },
        shadow: { color: '#000', opacity: 0.2 },
        groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
      },
    });
  },
  text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, values) => key === 'sessionWork.strip.stillWorking'
      ? `${key}:${values?.count}` : key,
  }),
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: vi.fn(),
        confirm: modalConfirmSpy,
        prompt: vi.fn(),
      },
    }).module;
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
      },
    }).module;
  },
  storage: async importOriginal => importOriginal(),
});

vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
  shouldRenderChatTimelineForSession: () => true,
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));


installDisconnectedServerSocketBoundary();
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
const { storage: canonicalStorage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousStorage: ReturnType<typeof canonicalStorage.getState>;
let pane: ReturnType<typeof useAppPaneScope>;

function applyShellFixtures() {
  canonicalStorage.getState().applySessions([createSessionFixture({ ...sessionState.session, active: sessionState.session.active ?? true })]);
  const messages = sessionMessagesState.messages.map((message, index) => message.kind === 'tool-call'
    ? createToolCallMessageFixture({ ...message, id: message.id ?? `tool-${index}`, tool: { ...createToolCallMessageFixture().tool, ...message.tool } })
    : { localId: null, createdAt: 1, ...message });
  const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
  canonicalStorage.setState({ isDataReady: true, sessionMessages: { s1: createSessionMessagesFixture({
    isLoaded: true, messagesById, messageIdsOldestFirst: messages.map(message => message.id),
  }) } });
  canonicalStorage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: localSettingsState.mobileWorkspaceExperienceV1 });
  const key = buildRealmQualifiedSessionCompanionPreferenceKey({ serverId: account.home.id, accountId: 'account-a' }, 's1');
  canonicalStorage.getState().applyLocalSettings({
    uiMultiPanePanelsEnabled: false, acknowledgedCliVersions: {},
    sessionCompanionPreferencesBySessionV1: key && companionPreferenceState.stored ? { [key]: companionPreferenceState.stored } : {},
  }, { persist: false });
  canonicalStorage.getState().applyAutomations(Array.from({ length: automationsState.enabledCount }, (_, index) => createAutomationDefinitionSummary({
    id: `automation-${index}`, name: 'Session task', description: null, enabled: true,
    targetType: 'existingSession', existingSessionId: 's1', templateVersion: 1, lastRunAt: null,
    createdAt: 1, updatedAt: 1, assignments: [], triggers: [],
  })));
}

function PaneProbe() {
  pane = useAppPaneScope(createSessionPaneScopeId('s1', account.home.id));
  React.useEffect(() => {
    if (paneScopeState.value?.details.isOpen) pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' });
  }, []);
  return null;
}

async function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
  applyShellFixtures();
  const screen = await renderCanonicalScreen(...args);
  return { ...screen, update: async (element: React.ReactElement) => { applyShellFixtures(); await screen.update(element); } };
}

beforeEach(async () => {
  previousStorage = canonicalStorage.getState();
  await loadSyncSingletonForTests();
  const { sync } = await import('@/sync/sync');
  ensureSidechainMessagesLoadedSpy = vi.spyOn(sync, 'ensureSidechainMessagesLoaded');
  account = await restoreServerAccountForTest({ serverUrl: 'https://server-1', request: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
    if (path.endsWith('/pending')) return Response.json({ pending: [] });
    if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
    return new Response('{}', { status: 404 });
  } });
  canonicalStorage.getState().applyLocalSettings({ appPaneScopesV1: {} }, { persist: false });
});
afterEach(async () => {
  await standardCleanup();
  const { scmStatusSync } = await import('@/scm/scmStatusSync');
  scmStatusSync.stop('s1', account.home.id);
  ensureSidechainMessagesLoadedSpy.mockRestore();
  await account.dispose();
  canonicalStorage.setState(previousStorage, true);
});

const { SessionView } = await import('./SessionView');
const { SelectionList } = await import('@/components/ui/selectionList');

const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
  <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider><PaneProbe />{children ?? null}</AppPaneProvider></InjectedAuthProvider>
);

function findPressableByAccessibilityLabel(screen: RenderScreenResult, label: string) {
  return screen.findAll((node) => (node.type as unknown) === 'Pressable' && node.props?.accessibilityLabel === label)[0];
}

async function renderSessionView(routeServerId: string = 'server-1', options: Pick<RenderWithAppProvidersOptions, 'createNodeMock'> = {}) {
  return renderScreen(
    <SessionView id="s1" routeServerId={routeServerId} />,
    {
      wrapper: AppPaneProviderWrapper,
      ...options,
    },
  );
}

const VISIBLE_COMPANION_PREFERENCE = Object.freeze({
  v: 1,
  visible: true,
  collapsed: false,
  edge: 'trailing',
  density: 'compact',
  items: [{ kind: 'builtin', id: 'session_summary' }],
} satisfies SessionCompanionPreferencesV1[string]);

function readCompanionRevealAddress(screen: RenderScreenResult): unknown {
  const paneHost = screen.findAll((node) => (node.type as unknown) === 'AppPaneScopeHost')[0];
  const wrapScopeContent = paneHost?.props?.wrapScopeContent;
  if (typeof wrapScopeContent !== 'function') return null;
  const wrapped = wrapScopeContent(React.createElement(React.Fragment, null));
  return (wrapped as React.ReactElement<{ address?: unknown }>)?.props?.address ?? null;
}

function findCompanionMounts(screen: RenderScreenResult) {
  return {
    hosts: screen.findAll((node) => (node.type as unknown) === 'SessionCompanionHost'),
    bridges: screen.findAll((node) => (node.type as unknown) === 'SessionCompanionPresentationBridge'),
    // The shell publishes its Companion reveal port by wrapping the pane
    // scope content; reading that wrapper's address needs no extra render.
    revealAddress: readCompanionRevealAddress(screen),
  };
}

function createSessionSurfacePlacement(input: Readonly<{
  descriptorId: string;
  container: 'rightPane' | 'rightSidebarTab' | 'bottomPane' | 'detailsTab' | 'detailsPane';
}>): PluginUiSurfacePlacementProjection {
  const binding = normalizePluginUiDestinationBindingV1({
    pluginId: 'acme.preview',
    destinationId: input.descriptorId,
    rendererId: `${input.descriptorId}-renderer`,
    container: input.container,
    target: { kind: 'session' },
  });
  if (!binding) throw new Error('test fixture must use an admitted Session destination binding');

  return {
    id: `surfacePlacement:acme.preview:${input.descriptorId}`,
    pluginId: 'acme.preview',
    occurrenceId: 'acme-preview-occurrence',
    contributionKind: 'surfacePlacement',
    descriptorId: input.descriptorId,
    binding,
    target: { kind: 'session' },
    renderer: { kind: 'hostedWeb', contributionId: `${input.descriptorId}-renderer` },
    display: { developerFallback: input.descriptorId },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    ...({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        pluginId: 'acme.preview',
        machineId: 'machine-1',
        materializationId: `${input.descriptorId}-install-a`,
      },
    } satisfies PluginMachineExecutionOriginV1),
  };
}

function projectionWith(...placements: readonly PluginUiSurfacePlacementProjection[]): PluginUiProjectionModel {
  return {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    generation: 1,
    surfacePlacementsById: Object.fromEntries(placements.map((placement) => [placement.id, placement])),
  };
}

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

describe('SessionView header action menu visibility', () => {
  beforeEach(async () => {
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
  });
  afterEach(() => {
    vi.useRealTimers();
    standardCleanup();
    vi.unstubAllGlobals();
    sessionState.session = createSessionFixture({
      id: 's1',
      serverId: 'server-1',
      metadata: { path: '/Users/tester/project', host: 'tester.local', flavor: 'codex' },
      accessLevel: 'edit',
      access: createEditableSessionAccessFixture(),
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
    });
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    backendCatalogEntriesState.entries = [];
    teamCredentialCatalogState.resources = [];
    teamCredentialCatalogState.teamNameById = {};
    teamCredentialCatalogState.currentResourceKeys = new Set();
    boardFeatureState.enabled = false;
    boardFeatureState.itemCount = 0;
    boardFeatureState.enabledServerIds = null;
    companionPreferenceState.stored = undefined;
    companionPreferenceMutateSpy.mockClear();
    paneScopeState.value = null;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = false;
    automationsState.enabledCount = 0;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';
    sessionMachineControlTargetState.target = null;
    keyboardDismissSpy.mockReset();
    headerActionMenuSpy.mockClear();
    attachedTerminalState.available = false;
    attachedTerminalState.open.mockReset();
    chatHeaderSpy.mockClear();
    agentInputSpy.mockClear();
    connectedServicesAuthSwitchSpy.mockClear();
    connectedServicesAuthSwitchResultSpy.mockClear();
    modalConfirmSpy.mockClear();
    ensureSidechainMessagesLoadedSpy.mockClear();
    paneOpenRightSpy.mockClear();
    paneSetRightTabSpy.mockClear();
    paneOpenDetailsTabSpy.mockClear();
    paneSelectRightDestinationSpy.mockClear();
    appPaneSurfaceOpenSpy.mockClear();
    freshPaneBridgeFixture.enabled = false;
    scopedPluginProjectionState.projection = null;
    routerPushSpy.mockReset();
    routerBackSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();
    windowDimensionsState.width = 800;
    windowDimensionsState.height = 600;
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
      writable: true,
      configurable: true,
    });
  });

  it('seats the session header in the transcript column, not across the side panes and rail', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'tablet';
    windowDimensionsState.width = 1440;
    const screen = await renderSessionView();
    const header = screen.findAll((node) => (node.type as unknown) === 'ChatHeaderView')[0];
    expect(header).toBeTruthy();
    const paneHost = screen.findAll((node) => (node.type as unknown) === 'AppPaneScopeHost')[0];
    expect(paneHost).toBeTruthy();
    // The header is part of the pane host's main column, so its width is the transcript's width.
    let ancestor = header?.parent ?? null;
    while (ancestor && (ancestor.type as unknown) !== 'AppPaneScopeHost') ancestor = ancestor.parent;
    expect(ancestor).toBe(paneHost);
    expect(screen.findAll((node) => (node.type as unknown) === 'ChatHeaderView')).toHaveLength(1);
  });

  it('hides the open runs button when execution runs are unsupported for the session', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    const screen = await renderSessionView();
    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');

    expect(openRunsButton).toBeUndefined();
  });

  it('forwards fresh Session pane and Details destinations to the current AppPane owner', async () => {
    freshPaneBridgeFixture.enabled = true;
    const rightPlacement = createSessionSurfacePlacement({ descriptorId: 'right', container: 'rightPane' });
    const bottomPlacement = createSessionSurfacePlacement({ descriptorId: 'activity', container: 'bottomPane' });
    const detailsPlacement = createSessionSurfacePlacement({ descriptorId: 'details', container: 'detailsTab' });
    const rightSidebarPlacement = createSessionSurfacePlacement({ descriptorId: 'sidebar', container: 'rightSidebarTab' });
    scopedPluginProjectionState.projection = projectionWith(
      rightPlacement,
      bottomPlacement,
      detailsPlacement,
      rightSidebarPlacement,
    );

    await renderSessionView();
    await flushHookEffects();

    const headerProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as Readonly<{
      onOpenPluginSurface?: PluginSurfaceOpenHandler;
    }> | undefined;
    const openSurface = headerProps?.onOpenPluginSurface;
    expect(openSurface).toBeTypeOf('function');
    if (!openSurface) throw new Error('Session header did not receive its openSurface handler');

    const rightRequest = {
      destination: rightPlacement.binding.destination,
      input: { source: 'session-header' },
    } as const;
    const bottomRequest = {
      destination: bottomPlacement.binding.destination,
      input: { source: 'session-header' },
    } as const;
    const detailsRequest = {
      destination: detailsPlacement.binding.destination,
      input: { source: 'session-header' },
    } as const;

    await expect(openSurface(rightRequest)).resolves.toMatchObject({ ok: true });
    await expect(openSurface(bottomRequest)).resolves.toMatchObject({ ok: true });
    await expect(openSurface(detailsRequest)).resolves.toMatchObject({ ok: true });
    expect(appPaneSurfaceOpenSpy).toHaveBeenNthCalledWith(1, rightRequest);
    expect(appPaneSurfaceOpenSpy).toHaveBeenNthCalledWith(2, bottomRequest);
    expect(appPaneSurfaceOpenSpy).toHaveBeenNthCalledWith(3, detailsRequest);

    const rightSidebarRequest = {
      destination: rightSidebarPlacement.binding.destination,
      input: { source: 'session-header' },
    } as const;
    await expect(openSurface(rightSidebarRequest)).resolves.toEqual({ ok: true });
    expect(pane.scopeState?.right.selectedDestination).toEqual({
      kind: 'plugin',
      destination: rightSidebarPlacement.binding.destination,
    });
    expect(appPaneSurfaceOpenSpy).toHaveBeenCalledTimes(3);
  });

  it('keeps background activity out of the header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      encryptionMode: 'plain',
      encryptedContentAvailability: 'ready',
      active: true,
      presence: 'online',
      thinking: false,
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: 999_000,
      runtimeActivityState: 'active',
      runtimeActivityRevision: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 999_000,
    };

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-background-activity-status')).toBeNull();
  });

  it('routes to session automations through blur-safe navigation', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    automationsSupportState.enabled = true;
    automationsState.enabledCount = 1;
    routerPushSpy.mockReset();
    navigateWithBlurOnWebSpy.mockClear();

    const screen = await renderSessionView();
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');

    expect(openAutomationsButton).toBeDefined();

    pressTestInstance(openAutomationsButton, 'session.openAutomations');

    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/automations?serverId=server-1');
  });

  it('folds runs and automations buttons into the header action menu when the header is narrow', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    automationsSupportState.enabled = true;

    const screen = await renderSessionView();
    const firstHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;

    const openRunsButton = findPressableByAccessibilityLabel(screen, 'session.openRuns');
    const openAutomationsButton = findPressableByAccessibilityLabel(screen, 'session.openAutomations');
    const openSubagentsButton = findPressableByAccessibilityLabel(screen, 'session.openSubagents');
    expect(openRunsButton).toBeUndefined();
    expect(openAutomationsButton).toBeUndefined();
    expect(openSubagentsButton).toBeUndefined();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(0)?.[0] as any;
    const extraItems = props?.extraItems ?? [];
    const extraIds = extraItems.map((it: any) => it?.id).filter(Boolean);
    // Runs are listed by the Agents roster; there is no second "Runs" entry.
    expect(extraIds).not.toContain('header.openRuns');
    expect(extraIds).toContain('header.openAutomations');
    expect(extraIds).toContain('header.openSubagents');

    const firstBadges = firstHeaderProps?.badges;

    sessionState.session = {
      ...sessionState.session,
      metadata: {
        ...sessionState.session.metadata,
        host: 'alternate-host',
      },
    } as any;

    await renderSessionView();

    const rerenderedProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedProps?.extraItems).toBe(extraItems);
    const rerenderedHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderProps?.badges).toEqual(firstBadges);
  });

  it('routes folded automations menu action through the scoped session href', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    windowDimensionsState.width = 420;
    automationsSupportState.enabled = true;

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const handled = props?.onSelectExtraItem?.('header.openAutomations');

    expect(handled).toBe(true);
    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/triggers?serverId=server-1');
  });

  it('offers “When this turn finishes…” only for an exact active parent turn and preserves its identity in navigation', async () => {
    automationsSupportState.enabled = true;
    sessionState.session = {
      ...sessionState.session,
      serverId: 'server-1',
      latestTurnId: 'turn-exact',
      latestTurnStatus: 'in_progress',
    } as any;

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const exactTurnItem = (props?.extraItems ?? []).find(
      (item: any) => item?.id === 'header.automateExactTurnCompletion',
    );
    expect(exactTurnItem?.title).toBe('automations.exactTurn.actionTitle');
    expect(props?.onSelectExtraItem?.('header.automateExactTurnCompletion')).toBe(true);
    expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
    expect(routerPushSpy).toHaveBeenCalledWith({
      pathname: '/session/s1/triggers',
      params: {
        sourceSessionId: 's1',
        sourceTurnId: 'turn-exact',
        sourceServerId: 'server-1',
        serverId: 'server-1',
        sessionLifecycleEvents: 'parentTurnCompleted',
      },
    });
  });

  it('withholds the exact-turn Automation action after the parent turn becomes terminal', async () => {
    automationsSupportState.enabled = true;
    sessionState.session = {
      ...sessionState.session,
      serverId: 'server-1',
      latestTurnId: 'turn-completed',
      latestTurnStatus: 'completed',
    } as any;

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).not.toContain(
      'header.automateExactTurnCompletion',
    );
  });

  it('preserves the visible header props when rerendered with identical session values', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [];
    headerActionMenuSpy.mockClear();
    chatHeaderSpy.mockClear();

    const screen = await renderSessionView();
    const firstHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;

    sessionState.session = {
      ...sessionState.session,
      metadata: sessionState.session.metadata,
      updatedAt: (sessionState.session.updatedAt ?? 0) + 1,
    } as any;

    await screen.update(<SessionView id="s1" routeServerId="server-1" />);

    const rerenderedHeaderProps = chatHeaderSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderProps).toMatchObject({
      title: firstHeaderProps?.title,
      subtitle: firstHeaderProps?.subtitle,
      badges: firstHeaderProps?.badges,
      avatarId: firstHeaderProps?.avatarId,
      isConnected: firstHeaderProps?.isConnected,
      flavor: firstHeaderProps?.flavor,
    });
    expect(rerenderedHeaderProps.badges).toBe(firstHeaderProps?.badges);
    expect(rerenderedHeaderProps.rightElement).toBe(firstHeaderProps?.rightElement);
  });

  it('refreshes the header action menu when the mounted session gains a new machine target', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    headerActionMenuSpy.mockClear();
    chatHeaderSpy.mockClear();

    sessionState.session = {
      ...sessionState.session,
      updatedAt: 1,
      metadata: null,
    } as any;

    const screen = await renderSessionView();
    const firstHeaderActionMenuProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(firstHeaderActionMenuProps?.session?.metadata?.machineId ?? null).toBeNull();

    sessionState.session = {
      ...sessionState.session,
      updatedAt: 2,
      metadata: {
        ...(sessionState.session.metadata ?? {}),
        machineId: 'machine-rebound',
        flavor: 'codex',
        version: '0.0.0',
        path: '/tmp',
        homeDir: '/tmp',
      },
    } as any;

    await screen.update(<SessionView id="s1" routeServerId="server-1" jumpToSeq={1} />);

    const rerenderedHeaderActionMenuProps = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(rerenderedHeaderActionMenuProps?.session?.updatedAt).toBe(2);
    expect(rerenderedHeaderActionMenuProps?.session?.metadata?.machineId).toBe('machine-rebound');
    expect(rerenderedHeaderActionMenuProps?.session).not.toBe(firstHeaderActionMenuProps?.session);
  });

  it('passes the session control target to connected-services auth switching', async () => {
    sessionMachineControlTargetState.target = {
      machineId: 'machine-origin',
      basePath: '/repo/origin',
      confidence: 'metadata_direct',
    };

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 's1',
      machineId: 'machine-origin',
    });
  });

  it('passes the current qualified Agent and current Team Connected Service choices to auth switching', async () => {
    sessionMachineControlTargetState.target = { machineId: 'machine-1', basePath: '/repo', confidence: 'reachable' };
    const connectedAccount = {
      purpose: 'primary',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      required: false,
    } as const;
    backendCatalogEntriesState.entries = [{
      agentCatalogEntry: {
        agentId: 'codex',
        qualifiedId: 'happier.agent.codex/codex',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        installedPackage: null,
        projectionGeneration: 3,
        catalogAgentId: 'codex',
        iconAgentId: 'codex',
        backendTargetKey: 'agent:happier.agent.codex/codex',
        title: 'Codex',
        subtitle: null,
        iconName: 'terminal',
        channel: 'stable',
        enabled: true,
        isBuiltIn: true,
        descriptor: null,
        behavior: null,
        authPlugin: null,
        cli: null,
        cliAuthBackgroundCheckSafe: true,
        connectedAccounts: [connectedAccount],
      },
      backendTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      backendTargetKey: 'agent:happier.agent.codex/codex',
      kind: 'builtInAgent',
      backendId: 'codex',
      agentId: 'codex',
      catalogAgentId: 'codex',
      builtInAgentId: 'codex',
      iconAgentId: 'codex',
      title: 'Codex',
      subtitle: null,
      cliAuthBackgroundCheckSafe: true,
    } satisfies ResolvedBackendCatalogEntry];
    const currentResource = {
      id: 'resource-current',
      teamId: 'team-current',
      displayName: 'Current Team account',
      resourceRevision: 7,
      readiness: { kind: 'available' },
      recoveryAction: null,
      mayBroker: false,
      mayReceiveDirect: true,
      directMaterialState: 'current',
      sessionUsePolicy: 'personal_allowed',
      providerModels: [],
      connectedServiceSelections: [{
        source: 'team_resource',
        resourceId: 'resource-current',
        deliveryMode: 'direct',
        disclosedMember: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'member-account',
        },
      }],
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      },
    } satisfies TeamCredentialResourceCatalogEntryV1;
    const staleResource = {
      ...currentResource,
      id: 'resource-stale',
      displayName: 'Stale Team account',
      connectedServiceSelections: [{
        ...currentResource.connectedServiceSelections[0],
        resourceId: 'resource-stale',
      }],
    } satisfies TeamCredentialResourceCatalogEntryV1;
    const currentWithoutConnectedServiceChoice = {
      ...currentResource,
      id: 'resource-provider-only',
      displayName: 'Provider-only Team resource',
      connectedServiceSelections: [],
    } satisfies TeamCredentialResourceCatalogEntryV1;
    teamCredentialCatalogState.resources = [
      currentResource,
      staleResource,
      currentWithoutConnectedServiceChoice,
    ];
    teamCredentialCatalogState.currentResourceKeys = new Set([
      'team-current:resource-current',
      'team-current:resource-provider-only',
    ]);
    teamCredentialCatalogState.teamNameById = { 'team-current': 'Current Team' };

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      serverId: 'server-1',
      connectedAccounts: [connectedAccount],
      agentIdentity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      teamNameById: teamCredentialCatalogState.teamNameById,
    });
    const chip = connectedServicesAuthSwitchResultSpy.mock.calls.at(-1)?.[0].connectedServicesAuthChip;
    const renderContent = chip?.collapsedContentPopover?.renderContent;
    if (typeof renderContent !== 'function') throw new Error('Expected the real Connected Account picker');
    const picker = await renderScreen(<>{renderContent({ requestClose: vi.fn(), maxHeight: 500 })}</>);
    const rootStep = picker.findByType(SelectionList)?.props.rootStep as React.ComponentProps<typeof SelectionList>['rootStep'];
    const options = rootStep.sections.flatMap((section) => section.kind === 'static' ? section.options : []);
    const currentOption = options.find((option) => option.label === 'Current Team account');
    const staleOption = options.find((option) => option.label === 'Stale Team account');
    expect(currentOption).toBeDefined();
    expect(currentOption?.disabled).toBe(false);
    expect(staleOption).toBeDefined();
    expect(staleOption?.subtitle).toContain('teams.unavailable.retry');
    expect(options.some((option) => option.label === 'Provider-only Team resource')).toBe(false);
    modalConfirmSpy.mockClear();
    currentOption?.onSelect?.();
    await flushHookEffects();
    expect(modalConfirmSpy).toHaveBeenCalledWith('teams.credentials.directUse.title',
      'teams.credentials.directUse.body', expect.objectContaining({ confirmText: 'common.continue' }));
    // Cancel at the genuine consent boundary; no auth mutation leaves this fixture.
    modalConfirmSpy.mockClear();
    routerPushSpy.mockClear();
    staleOption?.onSelect?.();
    expect(routerPushSpy).toHaveBeenCalledWith('/settings/teams/server-1/team-current/credentials/resource-stale');
    expect(modalConfirmSpy).not.toHaveBeenCalled();
    expect(connectedServicesAuthSwitchResultSpy.mock.calls.at(-1)?.[0].connectedServicesAuthChip?.collapsedContentPopover?.label)
      .toBe(chip?.collapsedContentPopover?.label);
  });

  it('does not pass stale metadata machine id to connected-services auth switching without a control target', async () => {
    sessionState.session = {
      ...sessionState.session,
      metadata: {
        machineId: 'stale-machine',
        path: '/repo/stale',
      },
    } as any;
    sessionMachineControlTargetState.target = null;

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 's1',
      machineId: null,
    });
  });

  it('passes restart-resume switch events to connected-services auth switching and supersedes them with newer session evidence', async () => {
    sessionMessagesState.messages = [{
      id: 'event-1',
      kind: 'agent-event',
      createdAt: 2_000,
      event: {
        type: 'connected-service-account-switch',
        serviceId: 'openai-codex',
        groupId: 'primary',
        fromProfileId: 'work',
        toProfileId: 'backup',
        reason: 'usage_limit',
        mode: 'restart_resume',
      },
    }];

    const screen = await renderSessionView();

    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.intentionalRestartSignals).toEqual([{
      status: 'restarting',
      attemptId: 'connected-service-account-switch:usage_limit:2000',
      reason: 'usage_limit_account_switch',
      startedAtMs: 2_000,
    }]);

    sessionState.session = {
      ...sessionState.session,
      latestReadyEventAt: 2_500,
    } as any;

    await screen.update(<SessionView id="s1" routeServerId="server-1" jumpToSeq={1} />);

    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.intentionalRestartSignals).toEqual([]);
  });

  it('keeps the runs destination in the compact header when the transcript already contains execution-run signals', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = null;
    windowDimensionsState.width = 420;
    sessionMessagesState.messages = [
      {
        kind: 'tool-call',
        tool: { name: 'SubAgentRun', input: { runId: 'run_1' }, result: { runId: 'run_1' } },
      },
    ];

    await renderSessionView();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const ids = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(ids).toContain('header.openSubagents');
    expect(ids).not.toContain('header.openRuns');
  });

  it('opens active subagent work in the Agents sidebar through the accessible header Work strip', async () => {
    // This renderer has no browser window; the real popover owns resize/scroll subscriptions.
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout,
      innerWidth: 800, innerHeight: 600,
    });
    sessionState.session = createSessionFixture({ id: 's1', serverId: 'server-1', active: true,
      activeAt: Date.now(), metadata: { path: '/Users/tester/project', host: 'tester.local', flavor: 'claude' } });
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        id: 'tool-msg-1',
        kind: 'tool-call',
        createdAt: 1,
        tool: {
          name: 'Task',
          id: 'toolu_task_1',
          input: { name: 'Investigate regression', team_name: 'qa-team', agent_id: 'alpha@qa-team' },
          result: { tool_use_result: { team_name: 'qa-team', agent_id: 'alpha@qa-team', name: 'alpha' } },
          state: 'running',
        },
      },
    ];

    const screen = await renderSessionView('server-1', {
      // The platform view measurement is the boundary; popover admission and rendering stay real.
      createNodeMock: (element) => element.type === 'View' ? {
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 20, 280, 32),
      } : null,
    });
    const workButton = findPressableByAccessibilityLabel(screen, 'sessionWork.strip.a11y');
    expect(workButton?.props.role ?? workButton?.props.accessibilityRole).toBe('button');
    expect(screen.getTextContent()).toContain('sessionWork.strip.stillWorking:1');
    await pressTestInstanceAsync(workButton, 'header Work strip');
    await flushHookEffects();
    const workPopover = screen.findAll((node) => typeof node.props.onOpenInSidebar === 'function')[0];
    expect(workPopover?.props).toMatchObject({ sessionId: 's1', serverId: 'server-1' });
    const openInSidebar = screen.findHostByTestId('session-work-strip-open-sidebar');
    expect(openInSidebar?.props.role ?? openInSidebar?.props.accessibilityRole).toBe('button');
    await pressTestInstanceAsync(openInSidebar, 'Work strip open in sidebar');
    expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'agents' });
  });

  it('does not hydrate discovered sidechains from the session shell or header', async () => {
    sessionState.session = createSessionFixture({ id: 's1', serverId: 'server-1', active: true,
      activeAt: Date.now(), metadata: { path: '/Users/tester/project', host: 'tester.local', flavor: 'claude' } });
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    sessionMessagesState.messages = [
      {
        id: 'tool-msg-1',
        kind: 'tool-call',
        createdAt: 1,
        tool: {
          name: 'Task',
          id: 'toolu_task_1',
          input: { name: 'Investigate regression', team_name: 'qa-team', agent_id: 'alpha@qa-team' },
          result: { tool_use_result: { team_name: 'qa-team', agent_id: 'alpha@qa-team', name: 'alpha' } },
          state: 'running',
        },
      },
    ];

    const screen = await renderSessionView();
    const workButton = findPressableByAccessibilityLabel(screen, 'sessionWork.strip.a11y');
    await flushHookEffects();

    expect(workButton?.props.role ?? workButton?.props.accessibilityRole).toBe('button');
    expect(screen.getTextContent()).toContain('sessionWork.strip.stillWorking:1');
    expect(ensureSidechainMessagesLoadedSpy).not.toHaveBeenCalled();
  });

  it('keeps the subagents destination in the compact header when launch surfaces are available before any subagents exist', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = true;
    sessionExecutionRunsSupportedState.supported = true;
    executionRunsBackendsState.backends = {
      codex: {
        available: true,
        intents: ['review', 'plan', 'delegate'],
      },
    };
    sessionMessagesState.messages = [];
    windowDimensionsState.width = 420;

    await renderSessionView();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).toContain('header.openSubagents');
  });

  it('renders SessionHeaderActionMenu even when automations and execution runs are disabled', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    executionRunsFeatureState.enabled = false;
    sessionExecutionRunsSupportedState.supported = false;
    executionRunsBackendsState.backends = null;
    headerActionMenuSpy.mockClear();
    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
  });

  it('offers and handles the provider-neutral attached terminal action when supported', async () => {
    attachedTerminalState.available = true;
    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openAttachedSessionTerminal');
    expect(props?.onSelectExtraItem?.('header.openAttachedSessionTerminal')).toBe(true);
    expect(attachedTerminalState.open).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty Board reachable from overflow without spending a direct header slot', async () => {
    boardFeatureState.enabled = true;
    boardFeatureState.itemCount = 0;
    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-board-button')).toBeNull();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).toContain('header.openBoard');
  });

  it('promotes a populated Board to one accessible direct header action and opens the canonical Details tab', async () => {
    boardFeatureState.enabled = true;
    boardFeatureState.itemCount = 1;
    windowDimensionsState.width = 800;
    const screen = await renderSessionView();

    const boardButton = screen.findByTestId('session-header-board-button');
    expect(boardButton?.props.accessibilityRole).toBe('button');
    expect(boardButton?.props.accessibilityLabel).toBeTruthy();
    pressTestInstance(boardButton);

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).not.toContain('header.openBoard');
    expect(pane.scopeState?.details.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'board', kind: 'board', isPinned: true }),
    ]));
  });

  it('folds a populated Board back into overflow when the incumbent header budget is compact', async () => {
    boardFeatureState.enabled = true;
    boardFeatureState.itemCount = 1;
    windowDimensionsState.width = 420;
    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-board-button')).toBeNull();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).toContain('header.openBoard');
  });

  it('keeps the active Board directly reachable even while its content projection is empty', async () => {
    boardFeatureState.enabled = true;
    boardFeatureState.itemCount = 0;
    paneScopeState.value = {
      bottom: { isOpen: false, activeTabId: null, tabState: {} },
      right: { isOpen: false },
      details: { isOpen: true, activeTabKey: 'board', tabs: [], groups: [] },
    };
    windowDimensionsState.width = 800;
    const screen = await renderSessionView();

    expect(screen.findByTestId('session-header-board-button')).not.toBeNull();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect((props?.extraItems ?? []).map((item: any) => item?.id)).not.toContain('header.openBoard');
  });

  describe('Lane 08 Companion admission', () => {
    beforeEach(() => {
      // A deliberate, already saved Companion preference on this device: the
      // only thing that may change below is the exact Home's Board decision.
      companionPreferenceState.stored = VISIBLE_COMPANION_PREFERENCE;
      responsiveState.deviceType = 'tablet';
      windowDimensionsState.width = 1200;
    });

    it('keeps every Companion entry point when the exact Home does not enable sessions.board', async () => {
      // Companion is not a Board placement gate: its first-party Session Summary
      // is composed from Session facts alone. Only the Board entry point follows
      // the exact Home's `sessions.board` decision.
      boardFeatureState.enabled = false;
      const screen = await renderSessionView();

      const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
      expect(props?.companionHeaderActionPlacement).not.toBeNull();
      expect(props?.companionHeaderIntent).not.toBeNull();
      expect(props?.boardHeaderAction ?? null).toBeNull();
      const mounts = findCompanionMounts(screen);
      expect(mounts.hosts).toHaveLength(1);
      expect(mounts.bridges).toHaveLength(1);
      expect(mounts.revealAddress).toEqual({ serverId: 'server-1', sessionId: 's1' });
      // Admission is not a reason to rewrite this device's saved choices.
      const key = buildRealmQualifiedSessionCompanionPreferenceKey({ serverId: account.home.id, accountId: 'account-a' }, 's1');
      expect(canonicalStorage.getState().localSettings.sessionCompanionPreferencesBySessionV1[key!]).toEqual(VISIBLE_COMPANION_PREFERENCE);
    });

    it('keeps the Companion header entry, rail host and presentation bridge when that Home enables Board', async () => {
      boardFeatureState.enabled = true;
      const screen = await renderSessionView();

      const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
      expect(props?.companionHeaderActionPlacement).not.toBeNull();
      expect(props?.companionHeaderIntent).not.toBeNull();
      const mounts = findCompanionMounts(screen);
      expect(mounts.hosts).toHaveLength(1);
      expect(mounts.bridges).toHaveLength(1);
      expect(mounts.revealAddress).toEqual({ serverId: 'server-1', sessionId: 's1' });
    });

    it('binds the Companion host to the exact Session address of the Home being viewed', async () => {
      boardFeatureState.enabledServerIds = ['server-1'];

      const enabledHome = await renderSessionView('server-1');
      expect(findCompanionMounts(enabledHome).hosts).toHaveLength(1);
      expect(findCompanionMounts(enabledHome).revealAddress)
        .toEqual({ serverId: 'server-1', sessionId: 's1' });

      standardCleanup();
      headerActionMenuSpy.mockClear();
      const otherHome = await renderSessionView('server-2');
      // Another Home's route never borrows this Home's Companion binding.
      expect(findCompanionMounts(otherHome).hosts.map((host) => host.props.address))
        .not.toContainEqual({ serverId: 'server-1', sessionId: 's1' });
      expect(findCompanionMounts(otherHome).revealAddress)
        .not.toEqual({ serverId: 'server-1', sessionId: 's1' });
    });

  });

  it('adds an open cockpit menu item on phone when classic mode is active', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';

    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openMobileWorkspaceCockpit');
  });

  it('dismisses the keyboard before opening cockpit from the session header toggle', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'classic';

    await renderSessionView();

    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    expect(props?.onSelectExtraItem?.('header.openMobileWorkspaceCockpit')).toBe(true);

    expect(keyboardDismissSpy).toHaveBeenCalledTimes(1);
  });

  it('adds an open classic view menu item on phone when cockpit mode is active', async () => {
    platformState.os = 'web';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = false;
    localSettingsState.mobileWorkspaceExperienceV1 = 'cockpit';

    await renderSessionView();

    expect(headerActionMenuSpy).toHaveBeenCalled();
    const props = headerActionMenuSpy.mock.calls.at(-1)?.[0] as any;
    const extraIds = (props?.extraItems ?? []).map((item: any) => item?.id);
    expect(extraIds).toContain('header.openMobileWorkspaceClassic');
  });

  it('renders a raised landscape back button on Android phones when the top header is hidden', async () => {
    platformState.os = 'android';
    responsiveState.deviceType = 'phone';
    responsiveState.isLandscape = true;
    const screen = await renderSessionView();
    const landscapeBackButton = screen.findByTestId('session-view-landscape-back-button');
    pressTestInstance(landscapeBackButton);

    expect(landscapeBackButton).toBeTruthy();
    expect(landscapeBackButton?.props.hitSlop).toBe(15);
    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(routerBackSpy).toHaveBeenCalledTimes(1);
  });

  it('disables connected-services auth switching until an in-progress turn reaches terminal projection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    sessionState.session = {
      ...sessionState.session,
      encryptionMode: 'plain',
      encryptedContentAvailability: 'ready',
      active: true,
      activeAt: 999_000,
      presence: 'online',
      thinking: false,
      thinkingAt: 0,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 999_000,
    } as any;

    await renderSessionView();

    expect(connectedServicesAuthSwitchSpy).toHaveBeenCalled();
    expect(connectedServicesAuthSwitchSpy.mock.calls.at(-1)?.[0]?.switchingDisabledReason).toBe('active_turn');
  });
});

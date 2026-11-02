import 'fake-indexeddb/auto';
import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
        serverId: 'server-1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));
sessionState.session = createSessionFixture({
  id: 's1', serverId: 'server-1', metadata: null, accessLevel: 'edit',
  canApprovePermissions: true, agentState: { controlledByUser: true },
});

const attachmentsTransferAvailableState = vi.hoisted(() => ({ value: true }));
const attachmentsFeatureScopeState = vi.hoisted(() => ({ enabledForServerId: null as string | null }));
const modalAlertSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      Easing: {
        bezier: vi.fn(() => ({})),
      },
      AccessibilityInfo: {
        isReduceMotionEnabled: vi.fn(async () => false),
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      },
      Dimensions: {
        get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
      },
      useWindowDimensions: () => ({ width: 1200, height: 800 }),
      Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) =>
          spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
      },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
      },
    }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { push: vi.fn(), back: vi.fn() },
      pathname: '/',
    }).module;
});

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
  EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
  SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
  useSessionFileUploadAvailability: () => attachmentsTransferAvailableState.value,
}));

const featureEnabledState: Record<string, boolean> = {
  voice: false,
  'files.reviewComments': false,
  'execution.runs': false,
  'attachments.uploads': false,
};
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
    if (featureId === 'attachments.uploads' && attachmentsFeatureScopeState.enabledForServerId != null) {
      return scope?.scopeKind === 'spawn' && scope.serverId === attachmentsFeatureScopeState.enabledForServerId;
    }
    return featureEnabledState[featureId] === true;
  },
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
  getDeviceType: () => 'phone',
  useDeviceType: () => 'phone',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
  resolveSessionMachineReachability: () => true,
}));
vi.mock(
  '@/components/sessions/model/useSessionMachineReachability',
  async (importOriginal) => {
    const {
      createReachableSessionMachineReachability,
      createSessionMachineReachabilityModuleMock,
    } = await import('@/dev/testkit/mocks/sessionMachineReachability');
    return createSessionMachineReachabilityModuleMock({
      importOriginal,
      overrides: {
        useSessionMachineReachability: createReachableSessionMachineReachability,
        useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
      },
    });
  },
);

vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', props),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useSessionStatus: () => ({ statusText: '', statusColor: '#000', statusDotColor: '#000' }),
    shouldShowAbortButtonForSessionState: () => false,
    getSessionAvatarId: () => '1',
    getSessionName: () => 'Session',
    listPendingPermissionRequests: () => [],
    listPendingUserActionRequests: () => [],
    formatPathRelativeToHome: () => '',
    getSessionSubtitle: () => '',
  };
});
vi.mock('@/utils/platform/platform', () => ({
  isRunningOnMac: () => false,
}));
vi.mock('@/sync/domains/session/control/submitMode', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/domains/session/control/submitMode')>(),
  chooseSubmitMode: () => 'direct',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
  shouldRenderChatTimelineForSession: () => true,
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
  countEnabledAutomationDefinitionsLinkedToSession: () => 0,
}));
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const { storage: shellStorage } = await import('@/sync/domains/state/storage');
const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const accountRuntime = installSessionPaneRuntimeTestHarness();
const { SessionView } = await import('./SessionView');
const {
  createComposerPresentationHostHandlers,
  readComposerPresentationSnapshot,
  readSessionComposerPresentationTargetAtAddress,
} = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');

const sessionRef = { kind: 'session', sessionId: 's1' } as const;

function createForeignSurfaceHandlers() {
  return createComposerPresentationHostHandlers({
    owner: {
      identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
      occurrenceId: 'generation-1',
      surfaceInstanceKey: 'foreign-surface-1',
    },
  });
}

// The canonical envelope a foreign mounted plugin surface sends, so this test
// exercises the real host-API contract rather than a shape the handlers ignore.
function hostRequest(
  method: PluginUiHostApiRequestEnvelopeV1['method'],
  payload?: unknown,
): PluginUiHostApiRequestEnvelopeV1 {
  return {
    version: 1,
    requestId: `request:${method}`,
    surface: {
      pluginId: 'acme.fixture',
      contributionId: 'composer-tools',
      surfaceId: 'composer-tools:foreign-surface-1',
      placement: 'composerSurface',
      platform: 'web',
      channel: 'internal',
      resourceScope: [],
      diagnostics: [],
    },
    method,
    ...(payload === undefined
      ? {}
      : { payload: payload as PluginUiHostApiRequestEnvelopeV1['payload'] }),
  };
}

async function renderSessionSurface(input: Readonly<{ surfaceFocused: boolean }>) {
  return await renderScreen(surfaceElement(input));
}

function surfaceElement(input: Readonly<{ surfaceFocused: boolean }>) {
  return <SessionView id="s1" routeServerId={accountRuntime.serverId} surfaceFocusedOverride={input.surfaceFocused} surfaceVisibleOverride />;
}

async function renderScreen(element: Parameters<typeof renderCanonicalScreen>[0]) {
  return renderCanonicalScreen(element, { wrapper: accountRuntime.Wrapper });
}

describe('SessionView composer surface focus', () => {
  beforeEach(async () => {
    sessionState.session = createSessionFixture({
      id: 's1', serverId: accountRuntime.serverId, active: true,
      metadata: { machineId: 'm1', host: 'test-home', flavor: 'codex', path: '/tmp', homeDir: '/tmp' },
      agentState: { controlledByUser: true },
    });
    shellStorage.setState({
      settings: { ...settingsDefaults, experiments: true },
      localSettings: { ...shellStorage.getState().localSettings, uiMultiPanePanelsEnabled: false },
    });
    shellStorage.getState().applySessions([sessionState.session]);
    shellStorage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })], true, { sourceServerId: accountRuntime.serverId });
    const { sync } = await import('@/sync/sync');
    expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
      serverId: accountRuntime.serverId, forceRefresh: true, hydrateMessages: false,
    })).kind).toBe('available');
  });
  it.each([
    ['available', true, true, true],
    ['uploads disabled', false, true, false],
    ['transport unavailable', true, false, false],
  ] as const)('admits Browser annotation only when the composer upload path is available (%s)', async (_label, featureEnabled, available, shouldStart) => {
    const { SessionBrowserContextRuntimeProvider } = await import('@/components/sessions/browser/sessionBrowserContextRuntime');
    const { createBrowserContextAnnotationAdapter } = await import('@/sync/domains/browser/context/annotationAdapter');
    const { createBrowserAnnotationCaptureProvider } = await import('@/sync/domains/browser/context/captureProvider');
    const { applyBrowserControlEvent, createBrowserControlState } = await import('@/sync/domains/browser/control');
    const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
    const oldContext = featureEnabledState['browser.context'];
    const oldUploads = featureEnabledState['attachments.uploads'];
    const oldTransfer = attachmentsTransferAvailableState.value;
    featureEnabledState['browser.context'] = true;
    featureEnabledState['attachments.uploads'] = featureEnabled;
    attachmentsTransferAvailableState.value = available;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      // This production root entry retains the Browser provider while a caller supplies the
      // body; the unrelated loaded composer does not own the Browser runtime binding.
      screen = await renderScreen(
        <SessionView id="s1" routeServerId={accountRuntime.serverId} surfaceFocusedOverride surfaceVisibleOverride
          contentOverride={<React.Fragment />} />
      );
      const runtime = screen.tree.findByType(SessionBrowserContextRuntimeProvider).props.runtime as
        import('@/components/sessions/browser/sessionBrowserContextRuntime').SessionBrowserContextRuntime | null;
      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error('Session Browser runtime did not mount');
      const state = applyBrowserControlEvent(createBrowserControlState(), {
        kind: 'viewOpened', eventId: 'opened', occurredAt: 1, browserSessionId: 's1', viewId: 'view',
        platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://fixture.test/' },
        adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
          supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'] }),
      });
      const shell = runtime.browserShellContext;
      const captureScreenshot = vi.fn(() => ({ ok: true as const, snapshot: {
        bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 100, height: 100, scale: 1, sizeBytes: 1,
      } }));
      const adapter = createBrowserContextAnnotationAdapter({
        resolveBinding: () => ({ ...shell, view: state.viewsById.view ?? null, browserContextEnabled: shell.enabled === true,
          captureProvider: createBrowserAnnotationCaptureProvider({ captureScreenshot }) }),
        onStateChange: shell.onStateChange,
      });
      let result: Awaited<ReturnType<typeof adapter.dispatch>> | undefined;
      await renderer.act(async () => { result = await adapter.dispatch({ kind: 'start' }); });
      expect(result).toMatchObject(shouldStart
        ? { status: 'started' }
        : { status: 'unavailable', reason: { reasonCode: 'browser_context_attachment_uploads_disabled' } });
      expect(captureScreenshot).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    } finally {
      await screen?.unmount();
      featureEnabledState['browser.context'] = oldContext;
      featureEnabledState['attachments.uploads'] = oldUploads;
      attachmentsTransferAvailableState.value = oldTransfer;
    }
  });

  it('keeps a full same-address composer targeted while a later transcript-only view is mounted', async () => {
    const full = await renderSessionSurface({ surfaceFocused: true });
    const address = { serverId: accountRuntime.serverId, sessionId: 's1' };
    const target = readSessionComposerPresentationTargetAtAddress(address);
    expect(target).not.toBeNull();
    expect(target?.readSnapshot).toBeTypeOf('function');
    const transcript = await renderScreen(
      <SessionView id="s1" routeServerId={accountRuntime.serverId} surfaceFocusedOverride surfaceVisibleOverride
        presentation={{ kind: 'embedded', composer: 'none' }} />
    );
    // Reads allocate an invocation projection; its snapshot reader belongs to
    // the mounted composer and must still be the original owner's reader.
    expect(readSessionComposerPresentationTargetAtAddress(address)?.readSnapshot).toBe(target?.readSnapshot);
    await transcript.unmount();
    expect(readSessionComposerPresentationTargetAtAddress(address)?.readSnapshot).toBe(target?.readSnapshot);
    await full.unmount();
    expect(readSessionComposerPresentationTargetAtAddress(address)).toBeNull();
  });
  it('stops being the active composer once its mounted surface is no longer focused', async () => {
    const screen = await renderSessionSurface({ surfaceFocused: true });
    await renderer.act(async () => {
      screen.tree.findByType('AgentInput' as any).props.onComposerFocusChange(true);
    });

    const handlers = createForeignSurfaceHandlers();
    expect(readComposerPresentationSnapshot(sessionRef)?.state.focused).toBe(true);
    expect(handlers.activeComposer!(hostRequest('activeComposer'))).toEqual(sessionRef);

    await screen.update(surfaceElement({ surfaceFocused: false }));

    expect(readComposerPresentationSnapshot(sessionRef)?.state.focused).toBe(false);
    expect(handlers.activeComposer!(hostRequest('activeComposer'))).toBeNull();

    await screen.update(surfaceElement({ surfaceFocused: true }));

    // The retained draft owner is unchanged: refocusing the surface restores it.
    expect(handlers.activeComposer!(hostRequest('activeComposer'))).toEqual(sessionRef);
    handlers.dispose();
    await screen.unmount();
  });

  it('refuses semantic focus while the mounted surface is not focused', async () => {
    const focusVisualInput = vi.fn();
    const screen = await renderSessionSurface({ surfaceFocused: true });
    await renderer.act(async () => {
      screen.tree.findByType('AgentInput' as any).props.onComposerFocusRequestChange(focusVisualInput);
    });

    const handlers = createForeignSurfaceHandlers();
    expect(handlers.focusComposer!(hostRequest('focusComposer', { ref: sessionRef })))
      .toEqual({ status: 'focused' });
    expect(focusVisualInput).toHaveBeenCalledTimes(1);

    await screen.update(surfaceElement({ surfaceFocused: false }));

    expect(handlers.focusComposer!(hostRequest('focusComposer', { ref: sessionRef })))
      .not.toEqual({ status: 'focused' });
    expect(focusVisualInput).toHaveBeenCalledTimes(1);
    handlers.dispose();
    await screen.unmount();
  });
});

import * as React from 'react';
import type {
  BrowserCommandV1} from '@happier-dev/protocol/browser/control/v1';
import type {
  BrowserContextCapabilities,
  BrowserRecordingCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
  BrowserDiagnosticEventV1,
  BrowserDiagnosticsSnapshotV1} from '@happier-dev/protocol/browser/diagnostics/v1';
import type {
  BrowserEventV1} from '@happier-dev/protocol/browser/events/v1';
import type {
  BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type {
  DaemonLocalServicePreviewOpenOrCreateResponseV1,
} from '@happier-dev/protocol/local/services/preview/v1';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findTestInstanceByTypeContainingText,
  createDeferred,
  flushHookEffects,
  waitForTestEvent,
  renderHook,
  renderScreen,
  type RenderScreenResult,
} from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
  createBrowserContextState,
  selectBrowserContextComposerAttachments,
  type BrowserContextState,
} from '@/sync/domains/browser/context';
import type { BrowserShellContextState } from './BrowserShell';
import {
  applyBrowserDiagnosticEvents,
  createBrowserDiagnosticsUiStore,
} from '@/sync/domains/browser/diagnostics';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { RightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createPluginUiTranslationRuntime, PluginUiTranslationRuntimeProvider } from '@/sync/domains/plugins/ui/i18n';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { browserControlActionId } from '@/sync/domains/browser/actions/controlActionId';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRegisteredBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/runtimeAnnotationRegistry';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isAgentInitiatedApprovalRequiredByDefault, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { createBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context';
import { setBrowserAnnotationDraftComment, startBrowserAnnotationDraft } from '@/sync/domains/browser/context/annotationDraft';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonLocalServicePreviewSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import type { ImageAnnotator } from '@/components/ui/media/annotation';
import type { BrowserAnnotationCommitInput } from '@/components/sessions/browser/commitBrowserAnnotation';

// Vitest does not choose the platform suffix; exercise the actual web canvas used by this host.
vi.mock('@/components/ui/media/annotation/AnnotatorCanvas', async () => await import('@/components/ui/media/annotation/AnnotatorCanvas.web'));

const testState = vi.hoisted(() => ({
  fetchBrowserDiagnosticsSnapshotViaMachineRpc: vi.fn(),
  machineRpc: vi.fn(),
  previewOpen: vi.fn<(input: unknown) => Promise<unknown>>(),
  previewFetch: vi.fn<RuntimeFetch>(),
  previewToken: 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature',
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } =
    await import('@/dev/testkit/mocks/tokenStorage');
  return createTokenStorageModuleMock({ importOriginal });
});

const homes = createHomeGovernanceHarness();
const previewBoundaries = new Map<string, Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>>();

async function addBrowserHome(serverUrl: string) {
  const serverIdentityId = `browser-shell:${new URL(serverUrl).hostname}`;
  const boundary = await createExternalActionAccountHttpBoundary({
    serverUrl, serverIdentityId, accountId: 'viewer-account', machineId: 'machine_1',
    actionId: 'localServices.preview.openOrCreate', tokenEpoch: 0, requesterInvocation: 'none',
    execute: input => testState.previewOpen(input),
    failure: result => {
      const parsed = ActionExecuteFailureSchema.safeParse(result);
      return parsed.success ? parsed.data : null;
    },
  });
  previewBoundaries.set(new URL(serverUrl).origin, boundary);
  const id = await homes.addHome({
    name: 'Browser Home', serverUrl, serverIdentityId, accountId: 'viewer-account', currentAccount: true,
    credentials: { token: testState.previewToken },
  });
  return { id };
}

afterEach(async () => { await homes.reset(); });

function stubCryptoRandomUuid(): void {
  let sequence = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => {
      sequence += 1;
      return `uuid_${sequence}`;
    }),
  });
}

function stubBrowserDiagnosticsWebEnvironment(): void {
  stubCryptoRandomUuid();
  vi.stubGlobal('window', {
    location: {
      origin: 'https://app.happier.test',
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

function findBrowserIframe(
  screen: RenderScreenResult,
): ReturnType<RenderScreenResult['findByType']> {
  return screen.findByType('iframe');
}

// The diagnostics drawer now renders the canonical `SegmentedTabBar`, which reads the app's motion
// preferences from the settings store. The canonical testkit stub is the boundary owner — without it
// the store initialisation never settles and the drawer cases time out.
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

// The renderer has no measured portal anchors; keep the real menu and row path inside the host tree.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('@/sync/domains/browser/diagnostics/machineRpc', () => ({
  fetchBrowserDiagnosticsSnapshotViaMachineRpc: (...args: readonly unknown[]) =>
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc(...args),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery', () => ({
  subscribeMachineRpcRecovery: () => () => {},
}));

vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(testState.machineRpc),
);

const target = {
  kind: 'localServicePreview',
  targetId: 'preview_1',
  sessionId: 'session_1',
  machineId: 'machine_1',
  display: {
    title: 'Preview',
    addressLabel: 'localhost:5173',
  },
} as const;

const simulatorPreviewTarget = {
  kind: 'simulatorPreview',
  targetId: 'simulator_preview_1',
  deviceId: 'simulator_1',
  sourceId: 'simulator_capture_source_1',
  display: {
    title: 'Simulator Preview',
    addressLabel: 'Pixel 8',
  },
} as const;

const contextCapabilities = {
  enabled: true,
  available: true,
  supportedContextKinds: ['browserPageReference'],
  supportedAdapterKinds: ['localPreview'],
  screenshot: {
    supported: false,
    requiresAttachmentUploads: true,
  },
  text: {
    maxSelectionChars: 2048,
    maxSummaryChars: 8192,
  },
  disabledReasons: [],
  policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const unavailableRecordingCapabilities = {
  enabled: true,
  attachmentsEnabled: false,
  available: false,
  supportedCaptureKinds: [],
  supportedMimeTypes: [],
  supportedAdapterKinds: [],
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: false,
  actionTimelineChaptersSupported: false,
  supportedRetentionClasses: [],
  disabledReasons: ['capture_unavailable'],
  policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const availableRecordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: ['simulatorPreview'],
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: true,
  actionTimelineChaptersSupported: true,
  supportedRetentionClasses: ['preSend', 'attached'],
  disabledReasons: [],
  policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const secondTarget = {
  ...target,
  targetId: 'preview_2',
  display: {
    title: 'Second Preview',
    addressLabel: 'localhost:5174',
  },
} as const;

function createDaemonDiagnosticsEvent(
  overrides: Partial<BrowserDiagnosticEventV1> = {},
): BrowserDiagnosticEventV1 {
  return {
    v: 1,
    eventId: 'evt_daemon_console_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 0,
    capturedAtMs: 3_000,
    family: 'console',
    kind: 'console.entry',
    fidelity: 'cdp',
    trusted: true,
    data: {
      level: 'log',
      textPreview: 'daemon console entry',
    },
    redaction: {
      level: 'metadataOnly',
      queryRedacted: true,
      headersRedacted: true,
      truncated: false,
    },
    ...overrides,
  };
}

function createDaemonDiagnosticsSnapshot(
  events: readonly BrowserDiagnosticEventV1[],
): BrowserDiagnosticsSnapshotV1 {
  return {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 3_100,
    refreshState: 'idle',
    events: [...events],
    diagnostics: [
      {
        code: 'daemon_browser_diagnostics_snapshot_ready',
      },
    ],
  };
}

async function createShellState() {
  const reducer = await import('@/sync/domains/browser/control/reducer');
  const events: readonly BrowserEventV1[] = [
    {
      kind: 'sessionCreated',
      eventId: 'event_session',
      browserSessionId: 'browser_session_1',
      profileId: 'profile_1',
      occurredAt: 1_000,
    },
    {
      kind: 'viewOpened',
      eventId: 'event_view',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      target,
      platform: 'web',
      currentUrl: 'https://preview.happier.test/',
      adapterKind: 'localPreview',
      engineKind: 'webIframe',
      adapterCapabilities: {
        ...buildBrowserAdapterCapabilities({
          adapterKind: 'localPreview',
          supportedTargetKinds: ['localServicePreview'],
          supportedRenderEngines: ['webIframe'],
        }),
        navigation: {
          canNavigate: true,
          canGoBack: false,
          canGoForward: false,
          canReload: true,
          canStop: false,
        },
      },
      occurredAt: 1_001,
    },
    {
      kind: 'viewFocused',
      eventId: 'event_focus',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      occurredAt: 1_002,
    },
    {
      // B-2 cause-1: a URL-bearing open on a client-rendered (webIframe) engine now seeds
      // `loading`; the engine's load-end is what reaches `ready`. This shared fixture models a
      // SETTLED (loaded) view — the precondition for the reload affordance — by finishing the
      // load, exactly as the in-app engine lifecycle wiring does in product (B-2 cause-2).
      kind: 'navigationFinished',
      eventId: 'event_loaded',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      currentUrl: 'https://preview.happier.test/',
      occurredAt: 1_003,
    },
  ];

  return events.reduce(
    (state, event) => reducer.applyBrowserControlEvent(state, event),
    reducer.createBrowserControlState(),
  );
}

async function createAnnotationCapableShellState(): Promise<
  Awaited<ReturnType<typeof createShellState>>
> {
  const state = await createShellState();
  const activeView = state.viewsById.view_1;
  if (!activeView) {
    throw new Error('expected test browser view');
  }
  return {
    ...state,
    viewsById: {
      ...state.viewsById,
      view_1: {
        ...activeView,
        adapterCapabilities: {
          ...activeView.adapterCapabilities,
          diagnosticsFidelityByFamily: {
            ...activeView.adapterCapabilities.diagnosticsFidelityByFamily,
            screenshot: 'injectedPage',
          },
          contextKinds: ['browserPageReference', 'browserAnnotation'],
        },
      },
    },
  };
}

async function createTwoTabShellState() {
  const reducer = await import('@/sync/domains/browser/control/reducer');
  const base = await createShellState();
  return [
    {
      kind: 'viewOpened',
      eventId: 'event_view_2',
      browserSessionId: 'browser_session_1',
      viewId: 'view_2',
      target: secondTarget,
      platform: 'web',
      currentUrl: 'https://second-preview.happier.test/',
      adapterKind: 'localPreview',
      engineKind: 'webIframe',
      adapterCapabilities: {
        ...buildBrowserAdapterCapabilities({
          adapterKind: 'localPreview',
          supportedTargetKinds: ['localServicePreview'],
          supportedRenderEngines: ['webIframe'],
        }),
        navigation: {
          canNavigate: true,
          canGoBack: false,
          canGoForward: false,
          canReload: true,
          canStop: false,
        },
      },
      occurredAt: 1_003,
    } satisfies BrowserEventV1,
  ].reduce(
    (state, event) => reducer.applyBrowserControlEvent(state, event),
    base,
  );
}

async function createSimulatorPreviewShellState(): Promise<
  Awaited<ReturnType<typeof createShellState>>
> {
  const reducer = await import('@/sync/domains/browser/control/reducer');
  const events: readonly BrowserEventV1[] = [
    {
      kind: 'sessionCreated',
      eventId: 'event_session',
      browserSessionId: 'browser_session_1',
      profileId: 'profile_1',
      occurredAt: 1_000,
    },
    {
      kind: 'viewOpened',
      eventId: 'event_simulator_view',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      target: simulatorPreviewTarget,
      platform: 'web',
      adapterKind: 'simulatorPreview',
      engineKind: 'streamedSurface',
      adapterCapabilities: buildBrowserAdapterCapabilities({
        adapterKind: 'simulatorPreview',
        supportedTargetKinds: ['simulatorPreview'],
        supportedRenderEngines: ['streamedSurface'],
      }),
      occurredAt: 1_001,
    },
    {
      kind: 'viewFocused',
      eventId: 'event_focus',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      occurredAt: 1_002,
    },
  ];

  return events.reduce(
    (state, event) => reducer.applyBrowserControlEvent(state, event),
    reducer.createBrowserControlState(),
  );
}

// Load the real browser graph during collection, not inside Account reset's hook lifetime.
await import('./BrowserShell');
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();

describe('BrowserShell', () => {
  it('routes native DevTools from overflow through the surface Action callback', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const view = { ...state.viewsById.view_1!, engineKind: 'desktopWebView' as const };
    const onOpenDevtools = vi.fn();
    const screen = await renderScreen(<BrowserShell browserSessionId={view.browserSessionId} platform="desktop"
      state={{ ...state, viewsById: { ...state.viewsById, [view.viewId]: view } }} onCommand={vi.fn()}
      onOpenDevtools={onOpenDevtools} testID="browser-shell" desktopWebViewAvailability={{
        available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView',
        producer: 'tauriWryNativeChildView', privilegedIpc: false, disabledReasons: [],
        supports: { navigation: true, goBackForward: true, reload: true, stop: true,
          pageInfoDiagnostics: true, nativeDevtools: true, capture: true, recording: false, automation: true },
      }} />);
    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync('browser-shell-overflow-item-open-devtools');
    expect(onOpenDevtools).toHaveBeenCalledWith({ browserSessionId: view.browserSessionId, viewId: view.viewId });
  });

  it("folds its tools into the pane header's one ⋯ when a header owns the pane (N4)", async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
    const state = await createShellState();
    const view = { ...state.viewsById.view_1!, engineKind: 'desktopWebView' as const };
    const onOpenDevtools = vi.fn();
    const published: { current: ReturnType<typeof usePublishedPaneHeaderContent> } = { current: null };
    function HeaderProbe() { published.current = usePublishedPaneHeaderContent('browser'); return null; }
    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <HeaderProbe />
        <PaneHeaderSlotScope slotKey="browser">
          <BrowserShell browserSessionId={view.browserSessionId} platform="desktop"
            state={{ ...state, viewsById: { ...state.viewsById, [view.viewId]: view } }} onCommand={vi.fn()}
            onOpenDevtools={onOpenDevtools} testID="browser-shell" desktopWebViewAvailability={{
              available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView',
              producer: 'tauriWryNativeChildView', privilegedIpc: false, disabledReasons: [],
              supports: { navigation: true, goBackForward: true, reload: true, stop: true,
                pageInfoDiagnostics: true, nativeDevtools: true, capture: true, recording: false, automation: true },
            }} />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    expect(screen.findHostByTestId('browser-shell-overflow')).toBeNull();
    const devtools = published.current?.menuActions?.find(action => action.id === 'open-devtools');
    expect(devtools).toBeDefined();
    await act(async () => { devtools?.onPress?.(); });
    expect(onOpenDevtools).toHaveBeenCalledWith({ browserSessionId: view.browserSessionId, viewId: view.viewId });
  });

  it('offers Float in the page menu while the Session viewer docks the Browser, as the Computer pane does', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { SessionViewerControllerProvider } = await import('@/components/sessions/viewer/SessionViewerControllerProvider');
    const { useOptionalSessionViewerController } = await import('@/components/sessions/viewer/SessionViewerController');
    const state = await createShellState();
    let controller: ReturnType<typeof useOptionalSessionViewerController> = null;
    function Probe() { controller = useOptionalSessionViewerController(); return null; }
    const screen = await renderScreen(
      <SessionViewerControllerProvider sessionId="session_1" serverId="server_1" phone={false}
        canPresentSource={() => true} openDocked={() => {}}>
        <Probe />
        <BrowserShell browserSessionId="browser_session_1" platform="web" state={state} onCommand={vi.fn()} testID="browser-shell" />
      </SessionViewerControllerProvider>,
    );
    const itemIds = () => {
      const menu = screen.root.findAll((node) => node.props?.testID === 'browser-shell-overflow' && Array.isArray(node.props.items))[0];
      return ((menu?.props.items ?? []) as ReadonlyArray<{ id: string }>).map((item) => item.id);
    };
    try {
      expect(itemIds()).not.toContain('float-view');
      await act(async () => { controller!.port.apply({ kind: 'viewer.open', source: 'browser' }); });
      await act(async () => { controller!.apply({ kind: 'viewer.dock' }); });
      expect(controller!.state.mode).toBe('docked');
      await screen.pressByTestIdAsync('browser-shell-overflow');
      await screen.pressByTestIdAsync('browser-shell-overflow-item-float-view');
      expect(controller!.state).toMatchObject({ mode: 'floating', source: 'browser' });
      expect(itemIds()).not.toContain('float-view');
    } finally { await screen.unmount(); }
  });

  it('lists Close tab in the page menu only when the tab strip is absent', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const menuItemIds = async (stripless: boolean) => {
      const screen = await renderScreen(
        <BrowserShell browserSessionId="browser_session_1" platform="web" state={state} onCommand={vi.fn()}
          onCloseTab={vi.fn()} onOpenNewTab={stripless ? vi.fn() : undefined} testID="browser-shell" />,
      );
      const menu = screen.root.findAll((node) => node.props?.testID === 'browser-shell-overflow' && Array.isArray(node.props.items))[0];
      const ids = (menu?.props.items as ReadonlyArray<{ id: string }>).map((item) => item.id);
      await screen.unmount();
      return ids;
    };
    // The strip's × closes the tab with a strip; the menu carries + and × only where the strip is absent.
    expect(await menuItemIds(false)).not.toContain('close-tab');
    expect(await menuItemIds(true)).toEqual(expect.arrayContaining(['new-tab', 'close-tab']));
  });

  it('keeps the Session annotation owner after a second Browser panel for the same page closes', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { useSessionBrowserContextRuntime } = await import('@/components/sessions/browser/sessionBrowserContextRuntime');
    const scope = { serverId: (await addBrowserHome('https://browser-panel-context.example.test')).id, accountId: 'viewer-account' };
    const shellState = await createAnnotationCapableShellState();
    const view = shellState.viewsById.view_1!;
    const captureScreenshot = vi.fn(async () => ({ ok: true as const,
      snapshot: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 3 } }));
    const captureProvider = createBrowserAnnotationCaptureProvider({ captureScreenshot });
    installImageAnnotationCanvasBoundary();
    let runtime: ReturnType<typeof useSessionBrowserContextRuntime>;
    function Harness({ panelOpen }: { panelOpen: boolean }) {
      runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 'session_1', accountScope: scope,
        attachmentsUploadsEnabled: true, annotationCaptureProvider: captureProvider });
      return <>
        <BrowserShell browserSessionId={view.browserSessionId} platform="web" state={shellState}
          onCommand={vi.fn()} testID="browser-main" browserContext={runtime?.browserShellContext} />
        {panelOpen ? <BrowserShell browserSessionId={view.browserSessionId} platform="web" state={shellState}
          onCommand={vi.fn()} testID="browser-panel" browserContext={runtime?.browserShellContext} /> : null}
      </>;
    }
    const screen = await renderScreen(<Harness panelOpen={false} />);
    try {
      await screen.update(<Harness panelOpen />);
      await screen.update(<Harness panelOpen={false} />);
      await screen.pressByTestIdAsync('browser-main-attach-page');
      await flushHookEffects();
      expect(runtime!.state.attachmentOrder).toHaveLength(1);
      expect(runtime!.state.itemsById[runtime!.state.itemOrder[0]!]).toMatchObject({
        kind: 'browserPageReference', sourceViewId: view.viewId,
      });
      await screen.pressByTestIdAsync('browser-main-mark-up');
      await flushHookEffects();
      expect(runtime!.state.annotationDraftByViewId[view.viewId]?.document.image).toMatchObject({ width: 40, height: 30 });
      expect(captureScreenshot).toHaveBeenCalledOnce();
      const result = await runtime!.browserShellContext.annotationRuntimeActionExecute!({
        actionId: 'browser.context.annotation.cancel', input: { browserSessionId: view.browserSessionId, viewId: view.viewId },
        context: { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId },
      });
      expect(result).toMatchObject({ status: 'cancelled' });
      expect(runtime!.browserShellContext.readState!().annotationDraftByViewId[view.viewId]).toBeUndefined();
    } finally { await screen.unmount(); }
  });

  it('composes shared browser marks through the mounted Action owner into one flattened annotation and badge', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { BrowserAnnotatorBar } = await import('./annotation/BrowserAnnotator');
    const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
    const { createBrowserContextActionChip } = await import('@/components/sessions/agentInput/definitions/createBrowserContextActionChip');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const home = await addBrowserHome('https://browser-shell-annotation.example.test');
    const scope = { serverId: home.id, accountId: 'viewer-account' };
    const shellState = await createAnnotationCapableShellState();
    const view = shellState.viewsById.view_1!;
    const capabilities = { ...contextCapabilities, supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
      screenshot: { supported: true, requiresAttachmentUploads: true } } satisfies BrowserContextCapabilities;
    const canvas = installImageAnnotationCanvasBoundary();
    const captureScreenshot = vi.fn(async () => ({ ok: true as const,
      snapshot: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 3 } }));
    const sourceLocation = { file: 'src/Checkout.tsx', line: 24, column: 8 };
    // The browser's diagnostics transport and composer delivery callback are the external host ports.
    const queryElementAtPoint = vi.fn(async () => ({ v: 1 as const, pickerRequestId: 'picker_shell', viewId: view.viewId,
      navigationGeneration: view.navigationGeneration, tier: 'injectedPage' as const, status: 'selected' as const,
      audited: true as const, selectorPath: '#checkout', accessibleName: 'Checkout', componentName: 'Checkout', sourceLocation,
      rect: { x: 2, y: 3, width: 20, height: 10 } }));
    const delivered: BrowserAnnotationCommitInput[] = [];
    const attached = createDeferred<void>();
    const commitAnnotation = vi.fn(async (input: BrowserAnnotationCommitInput) => {
      delivered.push(input);
      return { ok: true as const, imageRef: { mediaId: 'flattened_shell', mediaKind: 'image' as const,
        width: input.width, height: input.height, sizeBytes: input.png.length } };
    });
    let contextState = createBrowserContextState();
    let startEnabled = false;
    let commentEnabled = false;
    const onAttachUnavailable = vi.fn();
    const executor = createDefaultActionExecutor({
      isActionEnabled: id => id === 'browser.context.annotation.start' ? startEnabled
        : id !== 'browser.context.annotation.setDraftComment' || commentEnabled,
    });
    const execute = createFrontDoorRuntimeActionExecutor(executor);
    function Harness() {
      const [state, publish] = React.useState(contextState);
      return <BrowserShell browserSessionId={view.browserSessionId} platform="web" state={shellState}
        onCommand={vi.fn()} testID="browser-shell" browserContext={{ accountScope: scope,
          state, readState: () => contextState, contextCapabilities: capabilities, attachmentsUploadsEnabled: true,
          annotationCaptureProvider: createBrowserAnnotationCaptureProvider({ captureScreenshot }),
          commitAnnotation, queryElementAtPoint,
          annotationRuntimeActionExecute: execute, onAttachUnavailable, onStateChange: next => {
            contextState = next; publish(next); if (next.attachmentOrder.length === 1) attached.resolve();
          } }} />;
    }
    const screen = await renderScreen(<Harness />);
    try {
      await screen.pressByTestIdAsync('browser-shell-mark-up');
      expect(captureScreenshot).not.toHaveBeenCalled();
      expect(onAttachUnavailable).toHaveBeenCalledWith(expect.objectContaining({
        ok: false, errorCode: 'action_disabled',
      }));
      startEnabled = true;
      await screen.pressByTestIdAsync('browser-shell-mark-up');
      await flushHookEffects();
      expect(captureScreenshot).toHaveBeenCalledTimes(1);
      const annotator: ImageAnnotator = screen.tree.root.findByType(BrowserAnnotatorBar).props.annotator;
      // The host renderer has no layout phase, so activate the actual Element tool as its canvas does.
      const deactivate = annotator.tools?.element?.activate(() => {});
      try { await act(async () => { await annotator.pickElement({ x: 4, y: 5 }); }); }
      finally { deactivate?.(); }
      await act(async () => { annotator.apply([{ kind: 'mark.add', mark: {
        id: 'blur_shell', kind: 'blur', rect: { x: 24, y: 12, width: 8, height: 8 }, size: 'm',
      } }]); });
      const draft = contextState.annotationDraftByViewId[view.viewId]!;
      expect(draft.document?.marks.map(mark => mark.kind)).toEqual(['element', 'blur']);
      expect(queryElementAtPoint).toHaveBeenCalledTimes(1);
      const read = await executor.execute('media.annotation.read', { scope,
        target: { kind: 'browserView', browserSessionId: view.browserSessionId, viewId: view.viewId } },
      { surface: 'agent', serverId: scope.serverId, expectedAccountId: scope.accountId });
      expect(read).toMatchObject({ ok: true, result: { document: draft.document, hasBlur: true } });
      const comment = screen.tree.root.findByType(MultiTextInput);
      await act(async () => { comment.props.onChangeText('Please align Checkout.'); });
      await screen.pressByTestIdAsync('browser-annotator-attach');
      await waitForTestEvent(notify => screen.tree.subscribe(notify),
        () => screen.tree.root.findAllByType(BrowserAnnotatorBar)[0]?.props.attach.busy ?? false,
        busy => busy === false);
      expect(delivered).toHaveLength(0);
      expect(contextState.annotationDraftByViewId[view.viewId]?.source).toBe(draft.source);
      expect(screen.tree.root.findByType(MultiTextInput).props.value).toBe('Please align Checkout.');
      commentEnabled = true;
      await screen.pressByTestIdAsync('browser-annotator-attach');
      await act(async () => { await attached.promise; });
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ png: new Uint8Array([9, 8, 7]), comment: 'Please align Checkout.', document: draft.document });
      expect(canvas.encodeCount()).toBe(1);
      expect(canvas.events).toEqual(expect.arrayContaining(['burnBlur', 'text']));
      expect(captureScreenshot).toHaveBeenCalledTimes(1);
      expect(contextState.itemOrder).toHaveLength(1);
      const item = contextState.itemsById[contextState.itemOrder[0]!]!;
      expect(item).toMatchObject({ kind: 'browserAnnotation', imageRef: { mediaId: 'flattened_shell' }, marks: draft.document,
        elements: [{ selectorPath: '#checkout', componentName: 'Checkout', sourceLocation }] });
      expect(item).not.toHaveProperty('comment');
      expect(item).not.toHaveProperty('media');
      expect(selectBrowserContextComposerAttachments(contextState)[0]?.structuredBlock?.kind).toBe('browser.annotation.v2');
      expect(createBrowserContextActionChip({ state: contextState, onAttachPageReference: () => {} }).attachmentRowItem?.label)
        // One annotated element is named in the badge, after the page title.
        .toBe('Preview · Checkout');
    } finally { await screen.unmount(); vi.unstubAllGlobals(); }
  });

  it.each(['ui', 'agent'] as const)('admits mounted page and draft attachments from %s before capture, media or composer effects', async (surface) => {
    const { BrowserShell } = await import('./BrowserShell');
    const { BrowserAnnotatorBar } = await import('./annotation/BrowserAnnotator');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const home = await addBrowserHome(`https://browser-shell-approval-${surface}.example.test`);
    const scope = { serverId: home.id, accountId: 'viewer-account' };
    const shellState = await createAnnotationCapableShellState();
    const view = shellState.viewsById.view_1!;
    const capabilities = { ...contextCapabilities, supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
      screenshot: { supported: true, requiresAttachmentUploads: true } } satisfies BrowserContextCapabilities;
    let contextState = startBrowserAnnotationDraft(createBrowserContextState(), {
      browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration, nowMs: 1,
      source: { uri: 'data:image/png;base64,AQ==', width: 20, height: 20, scale: 1 },
      capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 20, height: 20, sizeBytes: 1 },
    });
    contextState = setBrowserAnnotationDraftComment(contextState, { viewId: view.viewId, comment: 'Keep the original caption.' });
    installImageAnnotationCanvasBoundary();
    const captureScreenshot = vi.fn(async () => ({ ok: true as const,
      snapshot: { bytes: new Uint8Array([1]), mimeType: 'image/png' as const, width: 20, height: 20, sizeBytes: 1 } }));
    const commitAnnotation = vi.fn(async () => ({ ok: true as const, imageRef: {
      mediaId: 'flattened_approved', mediaKind: 'image' as const, width: 20, height: 20, sizeBytes: 3,
    } }));
    const attached = createDeferred<void>();
    const machine = vi.fn(async () => ({ ok: false as const, errorCode: 'unexpected_machine', error: 'unexpected_machine' }));
    let settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'browser.context.attachToComposer': { enabled: false }, 'browser.context.annotation.attachDraft': { enabled: false },
    } });
    const runtimeActionExecute = createBrowserRuntimeActionExecutor({ resolveAnnotation: readRegisteredBrowserContextAnnotationAdapter, executeOnMachine: machine });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      runtimeActionExecute,
      isActionEnabled: (actionId, context) => isActionEnabledByActionsSettings(actionId, settings, context),
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
    }));
    const admittedExecute = createFrontDoorRuntimeActionExecutor(surface === 'ui' ? createDefaultActionExecutor({
      isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings, context),
    }) : executor);
    let execute = admittedExecute;
    function Harness() {
      const [state, publish] = React.useState(contextState);
      return <BrowserShell browserSessionId={view.browserSessionId} platform="web" state={shellState}
        onCommand={vi.fn()} testID="browser-shell" browserContext={{ accountScope: scope, state, readState: () => contextState,
          contextCapabilities: capabilities, attachmentsUploadsEnabled: true,
          annotationCaptureProvider: createBrowserAnnotationCaptureProvider({ captureScreenshot }), commitAnnotation,
          annotationRuntimeActionExecute: args => execute(args), onStateChange: next => {
            contextState = next; publish(next);
            if (next.itemOrder.some(id => next.itemsById[id]?.kind === 'browserAnnotation')) attached.resolve();
          }, nowMs: () => 2 }} />;
    }
    const screen = await renderScreen(<Harness />);
    const waitForAttachIdle = () => waitForTestEvent(notify => screen.tree.subscribe(notify),
      () => screen.tree.root.findAllByType(BrowserAnnotatorBar)[0]?.props.attach.busy ?? false,
      busy => busy === false);
    const initial = contextState;
    const operations = [
      ...(surface === 'agent' ? [{ actionId: 'browser.context.attachToComposer' as const, input: { browserSessionId: view.browserSessionId, viewId: view.viewId,
          navigationGeneration: view.navigationGeneration, source: 'activePage' as const }, button: 'browser-shell-attach-page' }] : []),
      { actionId: 'browser.context.annotation.attachDraft', input: { browserSessionId: view.browserSessionId, viewId: view.viewId,
          navigationGeneration: view.navigationGeneration }, button: 'browser-annotator-attach' },
    ] as const;
    for (const operation of operations) {
      if (surface === 'ui') { await screen.pressByTestIdAsync(operation.button); await waitForAttachIdle(); }
      else expect(await executor.execute(operation.actionId, operation.input, { surface, serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: false });
      expect(contextState).toBe(initial);
      expect(captureScreenshot).not.toHaveBeenCalled();
      expect(commitAnnotation).not.toHaveBeenCalled();
    }
    settings = ActionsSettingsV1Schema.parse({ v: 1 });
    if (surface === 'ui') {
      const { BrowserAnnotatorMount } = await import('./annotation/BrowserAnnotator');
      let pending: unknown;
      await homes.requireUiApproval(scope.serverId, 'browser.context.annotation.attachDraft');
      execute = Object.assign(async (...args: Parameters<typeof admittedExecute>) => {
        pending = await admittedExecute(...args); return pending;
      }, { actionExecute: admittedExecute.actionExecute });
      await act(async () => {
        const result = await screen.tree.root.findByType(BrowserAnnotatorMount).props.session.onAttach();
        expect(getActionSpec('browser.context.annotation.attachDraft').outputSchema?.safeParse(pending).success).toBe(true);
        expect(pending).toMatchObject({ actionId: 'browser.context.annotation.attachDraft', status: 'committed' });
        expect(result).toEqual({ ok: true });
      });
      expect(contextState.annotationDraftByViewId[view.viewId]).toBeUndefined();
      expect(contextState.itemOrder.map(id => contextState.itemsById[id]!.kind)).toEqual(['browserAnnotation']);
      expect(commitAnnotation).toHaveBeenCalledTimes(1);
      expect(captureScreenshot).not.toHaveBeenCalled();
      await screen.unmount();
      return;
    }
    if (surface === 'agent') {
      const approvalsCreate = vi.fn(async () => ({ artifactId: 'browser-approval' }));
      const approvalDeps = createActionExecutorBoundaryFixture({
        runtimeActionExecute,
        isActionApprovalRequired: () => true,
        isApprovalExecutionOriginCurrent: async () => true,
        approvalsCreate,
        approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request: {
          ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 3 },
        } }),
        approvalsUpdate: async () => ({ ok: true }),
      });
      const approvalExecutor = createActionExecutor(approvalDeps);
      const beforeApproval = contextState;
      for (const operation of operations) {
        const pending = await approvalExecutor.execute(operation.actionId, operation.input, { surface, serverId: scope.serverId, runtimeAccountId: scope.accountId,
          actionRequestId: `browser-request:${operation.actionId}`, defaultSessionId: 'session_1', defaultSessionMachineId: 'machine_1' });
        expect(pending.ok && ActionApprovalRequestCreatedResultSchema.safeParse(pending.result).success).toBe(true);
        const lifetime = new AbortController();
        const retained = createActionExecutor({ ...approvalDeps, hostActionApprovalLifetime: {
          actionId: operation.actionId, surface: 'ui', signal: lifetime.signal,
        } });
        expect(await retained.execute(operation.actionId, operation.input, { surface: 'ui', serverId: scope.serverId,
          runtimeAccountId: scope.accountId, actionCaller: { kind: 'host' }, authority: 'present_user', signal: lifetime.signal,
          actionRequestId: `browser-retained:${operation.actionId}`, defaultSessionId: 'session_1', defaultSessionMachineId: 'machine_1' }))
          .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      }
      expect(approvalsCreate).toHaveBeenCalledTimes(4);
      expect(contextState).toBe(beforeApproval);
      expect(captureScreenshot).not.toHaveBeenCalled();
      expect(commitAnnotation).not.toHaveBeenCalled();
    }
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'browser.context.attachToComposer': ['agent'], 'browser.context.annotation.attachDraft': ['agent'],
    } });
    for (const operation of operations) {
      expect(resolveActionExecutionPlacementForInput(getActionSpec(operation.actionId), operation.input)).toBe('client');
      expect(isAgentInitiatedApprovalRequiredByDefault(operation.actionId)).toBe(true);
      await act(async () => {
        const result = await executor.execute(operation.actionId, operation.input, { surface, serverId: scope.serverId, runtimeAccountId: scope.accountId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (result.ok) expect(getActionSpec(operation.actionId).outputSchema?.safeParse(result.result).success).toBe(true);
      });
    }
    await act(async () => { await attached.promise; });
    expect(selectBrowserContextComposerAttachments(contextState)).toHaveLength(2);
    expect(contextState.itemOrder.map(id => contextState.itemsById[id]!.kind)).toEqual(['browserPageReference', 'browserAnnotation']);
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(commitAnnotation).toHaveBeenCalledTimes(1);
    expect(machine).not.toHaveBeenCalled();
  });

  it('recovers an ended agent stream through the existing current-tab open and close intents', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const original = state.viewsById.view_1!;
    const view = {
      ...original,
      target: {
        kind: 'externalUrl' as const,
        targetId: 'external_1',
        url: 'https://example.com/',
        display: { title: 'Example' },
      },
      currentUrl: 'https://example.com/latest',
      adapterKind: 'chromiumSidecar' as const,
      engineKind: 'streamedSurface' as const,
      adapterCapabilities: buildBrowserAdapterCapabilities({
        adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['streamedSurface'],
      }),
    };
    const open = vi.fn();
    const command = vi.fn();
    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={{ ...state, viewsById: { ...state.viewsById, view_1: view } }}
        onCommand={command}
        onNavigateInPlace={open}
        testID="ended-shell"
        streamedBrowserRuntime={{
          machineName: 'Remote',
          playerState: {
            phase: 'stopped',
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            decodedFrames: 0,
            droppedFrames: 0,
            bufferedBytes: 0,
          },
        }}
      />,
    );
    await screen.pressByTestIdAsync('ended-shell-view-streamed-ended-open');
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'externalUrl',
        url: 'https://example.com/latest',
      }),
      { platform: 'web' },
    );
    expect(command).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('ended-shell-view-streamed-ended-close');
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'closeView',
        viewId: 'view_1',
        browserSessionId: 'browser_session_1',
      }),
    );
    await screen.unmount();
  });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    await homes.reset();
    previewBoundaries.clear();
    const { resetBrowserDiagnosticsDrawerStateForTests } =
      await import('./diagnostics/BrowserDiagnosticsDrawer');
    resetBrowserDiagnosticsDrawerStateForTests();
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockReset();
    testState.machineRpc.mockReset();
    testState.machineRpc.mockImplementation(async ({ machineId }: { machineId: string }) => ({
      protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 0,
        refreshState: 'idle', resources: [], previews: [], diagnostics: [] },
    }));
    testState.previewFetch.mockReset();
    testState.previewOpen.mockReset();
    testState.previewOpen.mockRejectedValue(new Error('Unexpected preview Action at the Home HTTP boundary'));
    testState.previewFetch.mockImplementation(async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : url);
      return await previewBoundaries.get(target.origin)?.handle(target, init) ?? homes.request(url, init);
    });
    setRuntimeFetch(testState.previewFetch);
    testState.previewToken = createAccountTokenForTests('viewer-account', { currentAccount: true });
    await addBrowserHome('https://browser-shell-home.example.test');
    const { resetLocalServicePreviewStoreForTests } =
      await import('@/sync/domains/local/services/preview/sharedStore');
    resetLocalServicePreviewStoreForTests();
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('says on the ended card why Open again was refused, and leads to Services once nothing runs it', async () => {
    const home = await addBrowserHome('https://shell-ended-home.example.test');
    const { BrowserShell } = await import('./BrowserShell');
    const { buildBrowserLaunchpadRows, buildBrowserLaunchpadModel } =
      await import('@/sync/domains/browser/targets');
    const { RightSidebarActionsContext } =
      await import('@/components/appShell/rightSidebar/rightSidebarActions');
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (href: string) =>
        Object.defineProperty(
          new Response(
            JSON.stringify({
              error: 'preview_not_found',
              reasonCode: 'preview_not_found',
            }),
            { status: 404 },
          ),
          'url',
          { value: href },
        ),
      ),
    );
    const base = await createShellState();
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const ended = {
      ...base,
      viewsById: {
        ...base.viewsById,
        view_1: {
          ...base.viewsById.view_1!,
          target: {
            ...target,
            serviceTarget: {
              kind: 'managed_service', managedServiceId: 'instance_old',
              machineId: 'machine_1', cwd: '/repo', declaration,
            },
          } satisfies BrowserViewTargetV1,
          loadingState: 'failed' as const,
          lastError: 'preview_ended',
        },
      },
    };
    const running = buildBrowserLaunchpadRows({
      nowMs: 2_000,
      launcherSnapshot: {
        v: 1,
        machineId: 'machine_1',
        sessionId: 'session_1',
        updatedAt: 1_000,
        targets: [
          {
            id: 'managed:instance_new',
            source: 'managed_service',
            machineId: 'machine_1',
            sessionId: 'session_1',
            title: 'vite',
            subtitle: '127.0.0.1:5173',
            sourceClass: {
              kind: 'managed_service',
              managedServiceId: 'instance_new',
            },
            cwd: '/repo',
            declaration,
            serviceState: 'running',
            endpointUrl: 'http://127.0.0.1:5173/',
            confidence: 'high',
            state: 'available',
            actions: ['register_preview'],
          },
        ],
      },
    });
    // The daemon refuses the reopen (a typed lifecycle refusal through the real opener).
    testState.machineRpc.mockRejectedValue(
      new Error(
        'local_service_preview_lifecycle_refused:service_not_listening',
      ),
    );
    testState.previewOpen.mockResolvedValue({
      ok: false, errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:localServices:local_services_preview_refused:service_not_listening',
    });
    const selectTab = vi.fn();
    const sideActions = { current: { tabs: ['files', 'services'], selectTab } };
    const render = (
      rows: readonly BrowserLaunchpadRow[],
      previewTarget: BrowserViewTargetV1 = ended.viewsById.view_1.target,
      localServiceTargets?: React.ComponentProps<typeof BrowserShell>['localServiceTargets'],
    ) => (
      <RightSidebarActionsContext.Provider value={sideActions}>
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={{ ...ended, viewsById: { ...ended.viewsById, view_1: { ...ended.viewsById.view_1, target: previewTarget } } }}
          onCommand={vi.fn()}
          launchpadRows={rows}
          localServiceTargets={localServiceTargets}
          localServicePreviewServerId={home.id}
          onOpenTarget={vi.fn()}
          testID="ended-local"
        />
      </RightSidebarActionsContext.Provider>
    );
    const screen = await renderScreen(render(running), {
      createNodeMock: (element) =>
        element.type === 'iframe' ? { contentWindow: { document: { addEventListener: vi.fn(), removeEventListener: vi.fn() } } } : null,
    });
    const { BrowserViewHost: RecoveryHost } = await import('./BrowserViewHost');
    expect(screen.findByType(RecoveryHost).props.recovery.serviceName).toBe('vite');
    await act(async () => findBrowserIframe(screen).props.onLoad());
    await vi.waitFor(() => expect(testState.machineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT, accountId: 'viewer-account', serverId: home.id,
    })));
    const openAgain = 'ended-local-view-frame-ended-open-again';
    await screen.pressByTestIdAsync(openAgain);
    expect(screen.findByTestId(openAgain)).toBeTruthy();
    await vi.waitFor(() => expect(
      findTestInstanceByTypeContainingText(
        screen,
        'Text',
        'localServices.actions.failure.namedServiceNotRunning',
      ),
    ).toBeDefined());

    // A different scanned application reuses the port: recover through Services, never Open again.
    const replacement = buildBrowserLaunchpadRows({
      launcherSnapshot: {
        v: 1, machineId: 'machine_1', sessionId: 'session_1', updatedAt: 3_000,
        targets: [{
          id: 'inventory:replacement', source: 'inventory_entry', machineId: 'machine_1', sessionId: 'session_1',
          sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'replacement' },
          title: 'Another app', cwd: '/another-project', subtitle: '127.0.0.1:5173',
          endpointUrl: 'http://127.0.0.1:5173/', confidence: 'high', state: 'available', actions: ['register_preview'],
        }],
      },
    });
    await screen.update(render(replacement, target));
    expect(screen.findByTestId(openAgain)).toBeNull();
    // The refusal still says why once Open again has gone with the Service.
    expect(
      findTestInstanceByTypeContainingText(
        screen,
        'Text',
        'localServices.actions.failure.namedServiceNotRunning',
      ),
    ).toBeDefined();
    await screen.pressByTestIdAsync(
      'ended-local-view-frame-ended-services',
    );
    expect(selectTab).toHaveBeenCalledWith('services');
    // The same recovery remains available after the listener disappears.
    await screen.update(render([], target));
    expect(screen.findByType(RecoveryHost).props.recovery.serviceName).toBe(target.display.title);
    expect(screen.findByTestId(openAgain)).toBeNull();
    expect(screen.findByTestId('ended-local-view-frame-ended-services')).toBeTruthy();
    // The same declared Service fails on its next Start. The launchpad now lists it under Couldn't
    // start (never as a running preview), and the existing feed retains the failure and its output.
    const failedModel = buildBrowserLaunchpadModel({ launcherSnapshot: {
      v: 1, machineId: 'machine_1', updatedAt: 4_000,
      targets: [{ ...running[0]!.serviceRow!.target, sessionId: undefined,
        serviceState: 'failed', endpointUrl: undefined, actions: ['manage'],
        diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'Address already in use' }] }],
    } });
    expect(failedModel.rows.map((row) => [row.section, row.target])).toEqual([['failed', null]]);
    await screen.update(render(failedModel.rows, ended.viewsById.view_1.target, failedModel.localServiceTargets));
    const { BrowserViewHost } = await import('./BrowserViewHost');
    expect(screen.findByType(BrowserViewHost).props.recovery).toMatchObject({
      serviceStartFailure: {
        reasonCode: 'plugin_managed_service_establishment_failed',
        title: 'localServices.actions.failure.startFailedTitle',
        recovery: { kind: 'reviewOutput', lines: ['Address already in use'] },
      },
    });
    expect(screen.getTextContent()).toContain('localServices.actions.failure.startFailedTitle');
    expect(screen.getTextContent()).not.toContain('browserShell.unavailable.previewEndedTitle');
    expect(screen.findByTestId(openAgain)).toBeNull();
    // A new attempt supersedes the old output without another Open or local recovery owner.
    await screen.update(render([], ended.viewsById.view_1.target, [{ ...failedModel.localServiceTargets[0]!, serviceState: 'starting' }]));
    expect(screen.findByType(BrowserViewHost).props.recovery.serviceStartFailure).toBeUndefined();
    // The typed Action result can beat the Services publication: do not discard its title
    // while the retained feed still describes the previously running occurrence.
    await screen.update(render(running));
    testState.machineRpc.mockRejectedValue(new Error(
      'local_service_preview_lifecycle_refused:plugin_managed_service_establishment_failed',
    ));
    testState.previewOpen.mockResolvedValue({
      ok: false, errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:localServices:local_services_preview_refused:plugin_managed_service_establishment_failed',
    });
    await screen.pressByTestIdAsync(openAgain);
    await vi.waitFor(() => expect(screen.findByType(BrowserViewHost).props.recovery.serviceStartFailure).toMatchObject({
      reasonCode: 'plugin_managed_service_establishment_failed',
      title: 'localServices.actions.failure.startFailedTitle',
    }));
    expect(screen.getTextContent()).toContain('localServices.actions.failure.startFailedTitle');
    // A new Start supersedes even a typed refusal retained before its failed feed arrived.
    await screen.update(render([], ended.viewsById.view_1.target, [{ ...failedModel.localServiceTargets[0]!, serviceState: 'starting' }]));
    expect(screen.findByType(BrowserViewHost).props.recovery.serviceStartFailure).toBeUndefined();
    expect(screen.findByType(BrowserViewHost).props.recovery.openAgainFailure).toBeNull();
    await screen.unmount();
  });

  it('supplies the preview Machine display name from retained Machine rows without fetching it', async () => {
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { buildMachineDisplayRenderableFromMachine } = await import('@/sync/domains/machines/machineDisplayRenderable');
    const { BrowserShell } = await import('./BrowserShell');
    const { BrowserViewHost } = await import('./BrowserViewHost');
    const store = getStorage();
    const previousState = store.getState();
    const machine = createMachineFixture({ id: target.machineId });
    const display = buildMachineDisplayRenderableFromMachine({ ...machine,
      metadata: { ...machine.metadata!, displayName: 'Studio' } });
    const base = await createShellState();
    const failed = { ...base, viewsById: { ...base.viewsById, view_1: {
      ...base.viewsById.view_1!, loadingState: 'failed' as const, lastError: 'preview_transport_unavailable' } } };
    const onCommand = vi.fn();
    try {
      store.getState().replaceMachineDisplays([display], { replace: true });
      const screen = await renderScreen(<BrowserShell browserSessionId="browser_session_1" platform="web"
        state={failed} localServicePreviewState={null} onCommand={onCommand} testID="preview-machine" />);
      const recovery = () => screen.findByType(BrowserViewHost).props.recovery;
      expect(recovery().machineName).toBe('Studio');
      const before = recovery();
      // Irrelevant Machine publications retain the recovery data and issue no metadata read.
      await act(async () => store.getState().replaceMachineDisplays([
        { ...display, activeAt: display.activeAt + 1 },
        { ...display, id: 'another-machine', metadata: { displayName: 'Other computer' } },
      ]));
      expect(recovery()).toBe(before);
      await act(async () => store.getState().replaceMachineDisplays([
        { ...display, metadata: { ...display.metadata, displayName: 'Studio renamed' } },
      ]));
      expect(recovery().machineName).toBe('Studio renamed');
      await act(async () => store.getState().replaceMachineDisplays([], { replace: true }));
      expect(recovery().machineName).toBeNull();
      expect(testState.previewFetch.mock.calls.filter(([url]) => new URL(url instanceof Request ? url.url : url).pathname.startsWith('/v1/machines'))).toHaveLength(0);
      recovery().onTryAgain();
      expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reload', viewId: 'view_1' }));
      await screen.unmount();
    } finally { store.setState(previousState); }
  });

  it('exposes the stopped Service Start recovery without a visible Services rail, including Project scope', async () => {
    const home = await addBrowserHome('https://shell-ended-start.example.test');
    const { BrowserShell } = await import('./BrowserShell');
    const { LocalServiceLaunchTargetV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
    const { RightSidebarActionsContext } =
      await import('@/components/appShell/rightSidebar/rightSidebarActions');
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('fetch', vi.fn(async (href: string) => Object.defineProperty(
      new Response(JSON.stringify({ error: 'preview_not_found', reasonCode: 'preview_not_found' }), { status: 404 }),
      'url', { value: href })));
    const base = await createShellState();
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const endedTarget = {
      ...target,
      serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old', machineId: 'machine_1', cwd: '/repo', declaration },
    } satisfies BrowserViewTargetV1;
    const ended = { ...base, viewsById: { ...base.viewsById, view_1: {
      ...base.viewsById.view_1!, target: endedTarget, loadingState: 'failed' as const, lastError: 'preview_ended' } } };
    // The declared Service has stopped and can start again (no live lifetime).
    const stopped = [LocalServiceLaunchTargetV1Schema.parse({
      id: 'managed:web', source: 'managed_service', machineId: 'machine_1', sessionId: 'session_1', title: 'Lumen web',
      subtitle: '127.0.0.1:5173', cwd: '/repo', declaration,
      workspace: { serverId: home.id, machineId: 'machine_1', workspaceId: 'ws_1', rootPath: '/repo' },
      serviceState: 'stopped', confidence: 'high', state: 'available', actions: ['start'],
    })];
    const render = (activeTab: string, railPublished = true, tabs = ['files', 'services'], targets = stopped) => (
      <RightSidebarActionsContext.Provider value={{ current: railPublished ? { tabs, activeTab, selectTab: vi.fn() } : null }}>
        <BrowserShell browserSessionId="browser_session_1" platform="web" state={ended} onCommand={vi.fn()}
          launchpadRows={[]} localServiceTargets={targets} localServicePreviewServerId={home.id}
          onOpenTarget={vi.fn()} testID="ended-start" />
      </RightSidebarActionsContext.Provider>
    );
    const screen = await renderScreen(render('services'), {
      createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: { document: { addEventListener: vi.fn(), removeEventListener: vi.fn() } } } : null,
    });
    await act(async () => findBrowserIframe(screen).props.onLoad());
    await flushHookEffects();
    expect(screen.findByTestId('ended-start-view-frame-ended-start-again')).toBeTruthy();
    expect(screen.getTextContent()).toContain('browserShell.unavailable.startService');
    expect(screen.findByTestId('ended-start-view-frame-ended-services')).toBeNull();
    const { BrowserViewHost } = await import('./BrowserViewHost');
    expect(screen.findByType(BrowserViewHost).props.recovery.startAgain.target).toBe(stopped[0]);
    // Start consumes the same Service facts regardless of the rail's presentation.
    await screen.update(render('files'));
    await flushHookEffects();
    expect(screen.findByType(BrowserViewHost).props.recovery.startAgain.target).toBe(stopped[0]);
    await screen.update(render('services', false));
    await flushHookEffects();
    expect(screen.findByType(BrowserViewHost).props.recovery.startAgain.target).toBe(stopped[0]);
    await screen.update(render('files', true, ['files']));
    await flushHookEffects();
    expect(screen.findByType(BrowserViewHost).props.recovery).toMatchObject({
      serviceName: 'Lumen web', stoppedServiceName: 'Lumen web', startAgain: { target: stopped[0], serverId: home.id },
    });
    expect(screen.findByType(BrowserViewHost).props.recovery.onOpenServices).toBeUndefined();
    // Neither a different Machine nor a stale Service gains Start from this recovery surface.
    await screen.update(render('files', true, ['files'], [{ ...stopped[0]!, machineId: 'another-machine' }]));
    expect(screen.findByType(BrowserViewHost).props.recovery.startAgain).toBeUndefined();
    await screen.update(render('files', true, ['files'], [{ ...stopped[0]!, state: 'stale' }]));
    expect(screen.findByType(BrowserViewHost).props.recovery.startAgain).toBeUndefined();
    await screen.unmount();
  });

  it.each(['before', 'after'] as const)('settles an unknown preview Start when the matching Service runs %s the acknowledgement', async (publicationOrder) => {
    const { useBrowserPreviewRecovery } = await import('./useBrowserPreviewRecovery');
    const { LocalServiceLaunchTargetV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
    const base = await createShellState();
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const stopped = LocalServiceLaunchTargetV1Schema.parse({
      id: 'managed:web', source: 'managed_service', machineId: 'machine_1', title: 'Lumen web',
      subtitle: 'web', cwd: '/repo', declaration, serviceState: 'stopped',
      confidence: 'high', state: 'available', actions: ['start'],
    });
    const activeView = {
      ...base.viewsById.view_1!, loadingState: 'failed' as const, lastError: 'preview_ended',
      target: { ...target, serviceTarget: {
        kind: 'managed_service' as const, managedServiceId: 'instance_old', machineId: 'machine_1', cwd: '/repo', declaration,
      } },
    };
    const input: Parameters<typeof useBrowserPreviewRecovery>[0] = {
      activeView, launchpadRows: [], localServiceTargets: [stopped], platform: 'web', accountLifetime: null,
      onClose: vi.fn(), canReload: false, onCommand: vi.fn(),
    };
    const readsBefore = { rpc: testState.machineRpc.mock.calls.length, http: testState.previewFetch.mock.calls.length };
    const hook = await renderHook(useBrowserPreviewRecovery, { initialProps: input });
    const acknowledgement = createDeferred<unknown>();
    let pending: Promise<boolean> | undefined;
    await act(async () => {
      pending = hook.getCurrent().startAgain!.run(() => acknowledgement.promise);
    });
    const running = { ...stopped, serviceState: 'running' as const, actions: [] };
    if (publicationOrder === 'before') {
      await hook.rerender({ ...input, localServiceTargets: [running] });
    }
    await act(async () => {
      acknowledgement.resolve({ ok: false, errorCode: 'action_outcome_unknown' });
      await pending;
    });
    if (publicationOrder === 'after') {
      expect(hook.getCurrent().openAgainFailure).toBeTruthy();
      // An unrelated Service running does not settle this preview's Start.
      await hook.rerender({ ...input, localServiceTargets: [stopped, { ...running, machineId: 'another-machine' }] });
      expect(hook.getCurrent().openAgainFailure).toBeTruthy();
      // An unhealthy projection can explicitly say its native lifetime is still unknown.
      await hook.rerender({ ...input, localServiceTargets: [{ ...running,
        serviceState: 'unhealthy', unavailableReason: 'managed_service_native_state_unknown' }] });
      expect(hook.getCurrent().openAgainFailure).toBeTruthy();
      await hook.rerender({ ...input, localServiceTargets: [running] });
    }
    expect(hook.getCurrent().openAgainFailure).toBeNull();
    expect(hook.getCurrent().startAgain).toBeUndefined();
    expect({ rpc: testState.machineRpc.mock.calls.length, http: testState.previewFetch.mock.calls.length }).toEqual(readsBefore);
    await hook.unmount();
  });

  it('reads the published scope recovery from the owning preview hook after the rail mounts', async () => {
    const { useBrowserPreviewRecovery } = await import('./useBrowserPreviewRecovery');
    const { RightSidebarActionsContext, usePublishRightSidebarActions } =
      await import('@/components/appShell/rightSidebar/rightSidebarActions');
    const publication: React.MutableRefObject<RightSidebarActions | null> = { current: null };
    const selectTab = vi.fn();
    let publishTabs: React.Dispatch<React.SetStateAction<string[]>> | undefined;
    function Rail() {
      const [tabs, setTabs] = React.useState(['files', 'services']);
      publishTabs = setTabs;
      usePublishRightSidebarActions({ tabs, activeTab: 'services', selectTab });
      return null;
    }
    const input = {
      activeView: null, launchpadRows: [], platform: 'web', accountLifetime: null,
      onClose: vi.fn(), canReload: false, onCommand: vi.fn(),
    } as const;
    let renders = 0;
    const hook = await renderHook(() => { renders += 1; return useBrowserPreviewRecovery(input); }, {
      wrapper: ({ children }) => <RightSidebarActionsContext.Provider value={publication}><Rail />{children}</RightSidebarActionsContext.Provider>,
    });
    expect(hook.getCurrent().onOpenServices).toBeTypeOf('function');
    hook.getCurrent().onOpenServices?.();
    expect(selectTab).toHaveBeenCalledWith('services');
    const before = renders;
    await act(async () => publishTabs!(['files', 'services']));
    expect(renders).toBe(before);
    await act(async () => publishTabs!(['files']));
    expect(hook.getCurrent().onOpenServices).toBeUndefined();
    await act(async () => publishTabs!(['files', 'services']));
    expect(hook.getCurrent().onOpenServices).toBeTypeOf('function');
    await hook.unmount();
  });

  it('keeps Start recovery stable when the Services rail opens and closes', async () => {
    const home = await addBrowserHome('https://shell-ended-toggle.example.test');
    const { BrowserShell } = await import('./BrowserShell');
    const { LocalServiceLaunchTargetV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
    const { RightSidebarActionsContext, usePublishRightSidebarActions } =
      await import('@/components/appShell/rightSidebar/rightSidebarActions');
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('fetch', vi.fn(async (href: string) => Object.defineProperty(
      new Response(JSON.stringify({ error: 'preview_not_found', reasonCode: 'preview_not_found' }), { status: 404 }),
      'url', { value: href })));
    const base = await createShellState();
    const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
    const endedTarget = {
      ...target,
      serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old', machineId: 'machine_1', cwd: '/repo', declaration },
    } satisfies BrowserViewTargetV1;
    const ended = { ...base, viewsById: { ...base.viewsById, view_1: {
      ...base.viewsById.view_1!, target: endedTarget, loadingState: 'failed' as const, lastError: 'preview_ended' } } };
    const stopped = [LocalServiceLaunchTargetV1Schema.parse({
      id: 'managed:web', source: 'managed_service', machineId: 'machine_1', sessionId: 'session_1', title: 'Lumen web',
      subtitle: '127.0.0.1:5173', cwd: '/repo', declaration,
      workspace: { serverId: home.id, machineId: 'machine_1', workspaceId: 'ws_1', rootPath: '/repo' },
      serviceState: 'stopped', confidence: 'high', state: 'available', actions: ['start'],
    })];
    // The shell element is created once: only the rail's publication changes between renders, never the shell's props.
    const shell = (
      <BrowserShell browserSessionId="browser_session_1" platform="web" state={ended} onCommand={vi.fn()}
        launchpadRows={[]} localServiceTargets={stopped} localServicePreviewServerId={home.id}
        onOpenTarget={vi.fn()} testID="ended-toggle" />
    );
    const owner = { current: null };
    function Rail() {
      usePublishRightSidebarActions({ tabs: ['files', 'services'], activeTab: 'services', selectTab: vi.fn() });
      return null;
    }
    const render = (shown: boolean) => (
      <RightSidebarActionsContext.Provider value={owner}>{shown ? <Rail /> : null}{shell}</RightSidebarActionsContext.Provider>
    );
    const screen = await renderScreen(render(true), {
      createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: { document: { addEventListener: vi.fn(), removeEventListener: vi.fn() } } } : null,
    });
    await act(async () => findBrowserIframe(screen).props.onLoad());
    await flushHookEffects();
    expect(screen.findByTestId('ended-toggle-view-frame-ended-start-again')).toBeTruthy();
    await screen.update(render(false));
    await flushHookEffects();
    expect(screen.findByTestId('ended-toggle-view-frame-ended-start-again')).toBeTruthy();
    expect(screen.findByTestId('ended-toggle-view-frame-ended-services')).toBeNull();
    await screen.update(render(true));
    await flushHookEffects();
    expect(screen.findByTestId('ended-toggle-view-frame-ended-start-again')).toBeTruthy();
    await screen.unmount();
  });

  it('renders capability-conditioned chrome and dispatches navigate commands without touching frame engines directly', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={onCommand}
        testID="browser-shell"
      />,
    );

    // No inner tab strip — the shell is a single-active-view renderer; tab order/active live on
    // the details-workspace engine. The sole view's content/address renders directly.
    expect(screen.findByTestId('browser-shell-tab-view_1')).toBeNull();
    // Blurred address field names a relay preview by the service it exposes, not its isolated host.
    expect(screen.findByTestId('browser-shell-address')?.props.value).toBe(
      'localhost:5173',
    );
    // The `webIframe` engine in this fixture declares no history capability, and a control the
    // active engine can NEVER fulfil is HIDDEN, not shipped permanently disabled
    // (`selectBrowserToolbarModel`'s `showBackForward`). `disabled` is reserved for the
    // transient case — the engine supports history but there is nowhere to go yet.
    expect(screen.findByTestId('browser-shell-back')).toBeNull();
    expect(screen.findByTestId('browser-shell-forward')).toBeNull();
    expect(
      screen.findByTestId('browser-shell-reload')?.props.accessibilityState
        ?.disabled,
    ).toBe(false);
    expect(findBrowserIframe(screen).props.src).toBe(
      'https://preview.happier.test/',
    );

    await act(async () => {
      screen.changeTextByTestId(
        'browser-shell-address',
        'https://preview.happier.test/dashboard',
      );
    });
    await act(async () => {
      screen.findByTestId('browser-shell-address')?.props.onSubmitEditing?.();
    });

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://preview.happier.test/dashboard',
      }),
    );
  });

  it.each(['toolbar', 'contextMenu'] as const)('loads a %s action locale only when its menu is presented', async (placement) => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
      'acme.preview': { id: 'translations:acme.preview', pluginId: 'acme.preview', contributionKind: 'translations',
        locales: ['en', 'fr'], resourceIdsByLocale: { en: 'copy.en', fr: 'copy.fr' } },
    } };
    const readResourceBytes = vi.fn<Parameters<typeof createPluginUiTranslationRuntime>[0]['readResourceBytes']>(async () => (
      new TextEncoder().encode(JSON.stringify({ 'preview.action': 'Translated action' }))
    ));
    const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes });
    const pluginBrowserProjection: PluginBrowserProjectionModel = { generation: 14, targetsById: {}, unknownEntriesById: {}, actionsById: {
      'browserAction:acme.preview:open-preview': {
        id: 'browserAction:acme.preview:open-preview', pluginId: 'acme.preview', contributionKind: 'browserAction', contributionId: 'open-preview',
        actionIdentity: { pluginId: 'acme.preview', localId: 'open-preview' }, qualifiedActionId: 'acme.preview/open-preview',
        targetId: 'preview_1', placement, display: { title: { key: 'preview.action', fallback: 'Author action' } },
      },
    } };
    const screen = await renderScreen(<PluginUiTranslationRuntimeProvider runtime={runtime}>
      <BrowserShell browserSessionId="browser_session_1" platform="web" state={state} onCommand={vi.fn()}
        pluginUiProjection={projection} pluginBrowserProjection={pluginBrowserProjection} onPluginBrowserAction={vi.fn()} testID="browser-shell" />
    </PluginUiTranslationRuntimeProvider>);
    expect(readResourceBytes).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync(placement === 'toolbar' ? 'browser-shell-overflow' : 'browser-shell-plugin-action-contextMenu-trigger');
    await flushHookEffects();
    expect(readResourceBytes.mock.calls.map(call => call[2])).toEqual(['copy.en']);
    expect(screen.getTextContent()).toContain('Translated action');
    await screen.unmount();
    runtime.dispose();
  });

  it('surfaces target-bound plugin browser actions in the live toolbar overflow', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const onPluginBrowserAction = vi.fn();
    const pluginBrowserProjection = {
      generation: 14,
      targetsById: {},
      actionsById: {
        'browserAction:acme.preview:open-preview': {
          id: 'browserAction:acme.preview:open-preview',
          pluginId: 'acme.preview',
          contributionKind: 'browserAction',
          contributionId: 'open-preview',
          actionIdentity: { pluginId: 'acme.preview', localId: 'open-preview' },
          qualifiedActionId: 'acme.preview/open-preview',
          targetId: 'preview_1',
          placement: 'toolbar',
          display: { title: 'Open preview', iconToken: 'browser' },
          order: 10,
        },
      },
      unknownEntriesById: {},
    } satisfies PluginBrowserProjectionModel;

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        pluginBrowserProjection={pluginBrowserProjection}
        onPluginBrowserAction={onPluginBrowserAction}
        testID="browser-shell"
      />,
    );

    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync(
      'browser-shell-overflow-item-browserAction:acme.preview:open-preview',
    );

    expect(onPluginBrowserAction).toHaveBeenCalledWith(
      pluginBrowserProjection.actionsById[
        'browserAction:acme.preview:open-preview'
      ],
      {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        targetId: 'preview_1',
        currentUrl: 'https://preview.happier.test/',
      },
    );
  });

  it('surfaces target-bound plugin browser actions in the live details panel and context menu', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const onPluginBrowserAction = vi.fn();
    const pluginBrowserProjection = {
      generation: 14,
      targetsById: {},
      actionsById: {
        'browserAction:acme.preview:inspect-preview': {
          id: 'browserAction:acme.preview:inspect-preview',
          pluginId: 'acme.preview',
          contributionKind: 'browserAction',
          contributionId: 'inspect-preview',
          actionIdentity: {
            pluginId: 'acme.preview',
            localId: 'inspect-preview',
          },
          qualifiedActionId: 'acme.preview/inspect-preview',
          targetId: 'preview_1',
          placement: 'detailsPanel',
          display: { title: 'Inspect preview', iconToken: 'search' },
          order: 10,
        },
        'browserAction:acme.preview:copy-preview-url': {
          id: 'browserAction:acme.preview:copy-preview-url',
          pluginId: 'acme.preview',
          contributionKind: 'browserAction',
          contributionId: 'copy-preview-url',
          actionIdentity: {
            pluginId: 'acme.preview',
            localId: 'copy-preview-url',
          },
          qualifiedActionId: 'acme.preview/copy-preview-url',
          targetId: 'preview_1',
          placement: 'contextMenu',
          display: { title: 'Copy preview URL', iconToken: 'copy' },
          order: 20,
        },
      },
      unknownEntriesById: {},
    } satisfies PluginBrowserProjectionModel;

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        pluginBrowserProjection={pluginBrowserProjection}
        onPluginBrowserAction={onPluginBrowserAction}
        testID="browser-shell"
      />,
    );

    await screen.pressByTestIdAsync(
      'browser-shell-plugin-action-detailsPanel-browserAction:acme.preview:inspect-preview',
    );
    await screen.pressByTestIdAsync(
      'browser-shell-plugin-action-contextMenu-trigger',
    );
    await screen.pressByTestIdAsync(
      'browser-shell-plugin-action-contextMenu-browserAction:acme.preview:copy-preview-url',
    );

    expect(onPluginBrowserAction).toHaveBeenNthCalledWith(
      1,
      pluginBrowserProjection.actionsById[
        'browserAction:acme.preview:inspect-preview'
      ],
      {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        targetId: 'preview_1',
        currentUrl: 'https://preview.happier.test/',
      },
    );
    await vi.waitFor(() =>
      expect(onPluginBrowserAction).toHaveBeenNthCalledWith(
        2,
        pluginBrowserProjection.actionsById[
          'browserAction:acme.preview:copy-preview-url'
        ],
        {
          browserSessionId: 'browser_session_1',
          viewId: 'view_1',
          targetId: 'preview_1',
          currentUrl: 'https://preview.happier.test/',
        },
      ),
    );
  });

  it('keeps a policy-disabled plugin browser action visible with its authored unavailable reason', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const pluginBrowserProjection = {
      generation: 14,
      targetsById: {},
      actionsById: {
        'browserAction:acme.preview:open-preview': {
          id: 'browserAction:acme.preview:open-preview',
          pluginId: 'acme.preview',
          contributionKind: 'browserAction',
          contributionId: 'open-preview',
          actionIdentity: { pluginId: 'acme.preview', localId: 'open-preview' },
          qualifiedActionId: 'acme.preview/open-preview',
          targetId: 'preview_1',
          placement: 'toolbar',
          display: { title: 'Open preview', iconToken: 'browser' },
          availability: {
            disabledWhen: {
              fact: 'host.platform',
              operator: 'equals',
              value: 'web',
            },
            disabledReason: 'Open preview is available on desktop only.',
          },
        },
      },
      unknownEntriesById: {},
    } satisfies PluginBrowserProjectionModel;
    const onPluginBrowserAction = vi.fn();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        pluginBrowserProjection={pluginBrowserProjection}
        pluginBrowserPolicyContext={{ platform: 'web' }}
        onPluginBrowserAction={onPluginBrowserAction}
        testID="browser-shell"
      />,
    );

    await screen.pressByTestIdAsync('browser-shell-overflow');
    const action = screen.findHostByTestId(
      'browser-shell-overflow-item-browserAction:acme.preview:open-preview',
    );
    expect(action?.props.accessibilityState).toMatchObject({ disabled: true });
    // A disabled menu row keeps its reason on screen, not only in the accessibility tree.
    expect(screen.getTextContent()).toContain(
      'Open preview is available on desktop only.',
    );
    await screen.pressByTestIdAsync(
      'browser-shell-overflow-item-browserAction:acme.preview:open-preview',
    );
    expect(onPluginBrowserAction).not.toHaveBeenCalled();
  });

  it('B-RC5: surfaces a compact privacy trigger (not an always-on triad) for an actionable profile, and reveals the detail on open', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserProfile={{
          profile: {
            profileId: 'profile_1',
            storageMode: 'session',
            owner: { kind: 'session', id: 'session_1' },
            displayName: 'Session preview',
            lifecycleState: 'active',
            cleanupOnSessionClose: true,
          },
          storagePartition: {
            partitionId: 'partition_1',
            profileId: 'profile_1',
            originKey: 'https://preview.happier.test',
            targetKind: 'localServicePreview',
            persistence: 'session',
            state: 'active',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
          activePermissionGrantCount: 2,
        }}
        testID="browser-shell"
      />,
    );

    // The always-on Mode/Storage/Permissions triad is gone from the toolbar.
    expect(screen.findAllByTestId('browser-shell-profile-status')).toHaveLength(
      0,
    );
    // A single compact privacy/security trigger is present instead.
    expect(screen.findByTestId('browser-shell-privacy')).toBeTruthy();

    // Opening the popover reveals the profile/permission/storage detail.
    await act(async () => {
      screen.pressByTestId('browser-shell-privacy');
    });
    expect(screen.findByTestId('browser-shell-privacy-status')).toBeTruthy();
    expect(
      screen.findByTestId('browser-shell-privacy-status-mode-session'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('browser-shell-privacy-status-storage-session'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('browser-shell-privacy-status-permissions-active'),
    ).toBeTruthy();
  });

  it('9.2: renders a security-origin indicator and consolidates secondary tools into an overflow menu', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();

    const annotationCapabilities = {
      ...contextCapabilities,
      supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    } satisfies BrowserContextCapabilities;

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserContext={{
          state: createBrowserContextState(),
          contextCapabilities: annotationCapabilities,
          enabled: true,
          onStateChange: vi.fn(),
        }}
        testID="browser-shell"
      />,
    );

    // The security posture is now RENDERED (it was tracked but never shown) and the origin chip stays.
    expect(screen.findByTestId('browser-shell-security')).toBeTruthy();
    // The origin-kind pill and the in-toolbar page title were MERGED AWAY: the workspace tab
    // strip already owns the title, and the origin kind is now this chip's fallback label.
    // One identity chip, not three near-identical grey pills.
    expect(screen.findByTestId('browser-shell-origin')).toBeNull();
    expect(screen.findByTestId('browser-shell-title')).toBeNull();
    expect(screen.findByTestId('browser-shell-security')).toBeTruthy();

    // Lab W: Attach page is visible chrome, not buried in `⋯`.
    expect(screen.findByTestId('browser-shell-attach-page')).toBeTruthy();
    // This embedded page can never be captured, so Mark up is not offered (like Start recording).
    expect(screen.findByTestId('browser-shell-mark-up')).toBeNull();

    // A page that ended, can't be reached or was refused shows a card, not a page: nothing to attach
    // or mark up.
    await screen.update(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={{ ...state, viewsById: { ...state.viewsById,
          view_1: { ...state.viewsById.view_1!, loadingState: 'failed' as const, lastError: 'preview_ended' } } }}
        onCommand={vi.fn()}
        browserContext={{
          state: createBrowserContextState(),
          contextCapabilities: annotationCapabilities,
          enabled: true,
          onStateChange: vi.fn(),
        }}
        testID="browser-shell"
      />,
    );
    expect(screen.findByTestId('browser-shell-attach-page')).toBeNull();
    expect(screen.findByTestId('browser-shell-mark-up')).toBeNull();
  });

  it('B-RC5: renders no profile chrome for the host-local default profile (clean browser)', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { LOCAL_BROWSER_PROFILE } =
      await import('@/sync/domains/browser/profiles/localBrowserProfile');
    const state = await createShellState();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserProfile={{ profile: LOCAL_BROWSER_PROFILE }}
        testID="browser-shell"
      />,
    );

    expect(screen.findAllByTestId('browser-shell-privacy')).toHaveLength(0);
    expect(screen.findAllByTestId('browser-shell-profile-status')).toHaveLength(
      0,
    );
  });

  it('uses live local preview state and viewer Home admission for browser views without a current URL', async () => {
    const home = await addBrowserHome('https://shell-viewer-home.example.test');
    const viewerUrl = 'https://preview.happier.test/live/?previewToken=viewer';
    testState.previewFetch.mockImplementation(async (url, init) => {
      if (
        url ===
          'https://shell-viewer-home.example.test/v1/local-services/preview/preview_1/access' &&
        new Headers(init?.headers).get('Authorization') ===
          `Bearer ${testState.previewToken}`
      ) {
        return Response.json({
          v: 1,
          kind: 'server_preview',
          previewId: 'preview_1',
          machineId: 'machine_1',
          accessUrl: viewerUrl,
          expiresAt: 2_000_000_000_000,
        });
      }
      return homes.request(url, init);
    });
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } =
      await import('@/sync/domains/local/services/preview/store');
    const livePreviewState = applyLocalServicePreviewSnapshot(
      createLocalServicePreviewState(),
      {
        generatedAt: 1_000,
        refreshState: 'idle',
        previews: [
          {
            previewId: 'preview_1',
            accessUrl:
              'https://preview.happier.test/live/?previewToken=custodian',
            expiresAt: 2_000,
            diagnostics: [],
            resource: {
              previewId: 'preview_1',
              sessionId: 'session_1',
              machineId: 'machine_1',
              owner: { kind: 'session', id: 'session_1' },
              target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
              initialPath: { pathname: '/', search: '' },
              display: { title: 'Preview', addressLabel: 'localhost:5173' },
              originMode: 'host',
              browserTarget: target,
            },
          },
        ],
        diagnostics: [],
      },
    );
    const previews = [...livePreviewState.previewsById.values()];
    testState.machineRpc.mockResolvedValue(DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({
      protocolVersion: 1, snapshot: { v: 1, machineId: target.machineId,
        generatedAt: livePreviewState.generatedAt, refreshState: livePreviewState.refreshState,
        resources: previews.map(preview => preview.resource), previews, diagnostics: [] },
    }));
    const state = [
      {
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: 'browser_session_1',
        profileId: 'profile_1',
        occurredAt: 1_000,
      },
      {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target,
        platform: 'web',
        currentUrl: null,
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
          adapterKind: 'localPreview',
          supportedTargetKinds: ['localServicePreview'],
          supportedRenderEngines: ['webIframe'],
        }),
        occurredAt: 1_001,
      },
      {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
      } satisfies BrowserEventV1,
    ].reduce(
      (currentState, event) =>
        reducer.applyBrowserControlEvent(currentState, event as BrowserEventV1),
      reducer.createBrowserControlState(),
    );
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={onCommand}
        localServicePreviewServerId={home.id}
        testID="browser-shell"
      />,
    );

    await flushHookEffects({ cycles: 40 });
    expect(testState.machineRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine_1',
        serverId: home.id,
        accountId: 'viewer-account',
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
      }),
    );
    expect(findBrowserIframe(screen).props.src).toBe(viewerUrl);
  });

  it('mounts the browser launchpad when no browser view is focused', async () => {
    const home = await addBrowserHome('https://shell-launchpad-home.example.test');
    // Open re-admits the preview through the actual registration owner. Substitute only RPC.
    const resource = {
      previewId: target.targetId,
      machineId: target.machineId,
      sessionId: target.sessionId,
      owner: { kind: 'session' as const, id: target.sessionId },
      target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 },
      initialPath: { pathname: '/app/', search: '' },
      display: target.display,
      originMode: 'host' as const,
      browserTarget: target,
    };
    const preview = {
      previewId: resource.previewId,
      resource,
      accessUrl: 'https://preview.happier.test/app/?previewToken=renewed',
      expiresAt: 1_700_000_000_000,
      diagnostics: [],
    };
    const admittedPreview = {
      protocolVersion: 1,
      status: 'existing',
      preview,
      snapshot: {
        v: 1,
        machineId: target.machineId,
        generatedAt: 1_000,
        refreshState: 'idle',
        resources: [resource],
        previews: [preview],
        diagnostics: [],
      },
    } satisfies DaemonLocalServicePreviewOpenOrCreateResponseV1;
    testState.machineRpc.mockResolvedValue(admittedPreview);
    testState.previewOpen.mockResolvedValue(admittedPreview);
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
    const onOpenTarget = vi.fn();
    const launchpadRows: readonly BrowserLaunchpadRow[] = [
      {
        id: 'localService:launcher_preview',
        section: 'running',
        sourceKind: 'localService',
        title: 'Preview',
        subtitle: 'localhost:5173',
        detail: 'vite',
        target,
        currentUrl: 'https://preview.happier.test/app/',
        currentUrlExpiresAt: 1_700_000_000_000,
        disabledReason: null,
        lastSeenAt: 1_000,
      },
    ];

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="ios"
        state={reducer.createBrowserControlState()}
        onCommand={onCommand}
        launchpadRows={launchpadRows}
        localServicePreviewServerId={home.id}
        launchpadRefreshStatus="idle"
        onOpenTarget={onOpenTarget}
        testID="browser-shell"
      />,
    );

    expect(screen.findByTestId('browser-shell-launchpad')).toBeTruthy();
    await flushHookEffects({ cycles: 40 });

    await screen.pressByTestIdAsync(
      'browser-shell-launchpad-card:localService:launcher_preview',
    );

    await vi.waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith(target, {
      platform: 'ios',
      currentUrl: 'https://preview.happier.test/app/?previewToken=renewed',
    }));
    // Admission expiry does not expire an already admitted viewer. Cached row URLs are not reused.
    expect(onOpenTarget.mock.calls[0]?.[1]).not.toHaveProperty(
      'currentUrlExpiresAt',
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('B-1: enables the toolbar address bar with no active view and opens the first view in place', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
    const onNavigateInPlace = vi.fn();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="desktop"
        state={reducer.createBrowserControlState()}
        onCommand={onCommand}
        onNavigateInPlace={onNavigateInPlace}
        launchpadRows={[]}
        launchpadRefreshStatus="idle"
        testID="browser-shell"
      />,
    );

    // The address field is editable even with no active view (it is the new-tab entry point).
    const address = screen.findByTestId('browser-shell-address');
    expect((address?.props as { editable?: boolean }).editable).toBe(true);

    // Type then submit in separate flushes so the address field's editable draft commits before
    // the submit handler reads it (a single act batches the `setRawDraft` and submit would see an
    // empty draft).
    await act(async () => {
      screen.changeTextByTestId(
        'browser-shell-address',
        'https://example.test/start',
      );
    });
    await act(async () => {
      screen.findByTestId('browser-shell-address')?.props.onSubmitEditing?.();
    });

    // The toolbar routes a typed address through the in-place open seam (NOT a navigate command,
    // which has no view to target), opening the first view in place.
    expect(onCommand).not.toHaveBeenCalled();
    expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
    const [openedTarget, options] = onNavigateInPlace.mock.calls[0] as [
      BrowserViewTargetV1,
      { platform?: string } | undefined,
    ];
    expect(openedTarget.kind).toBe('externalUrl');
    expect(openedTarget.kind === 'externalUrl' ? openedTarget.url : null).toBe(
      'https://example.test/start',
    );
    expect(options?.platform).toBe('desktop');
  });

  it('B-1: keeps the toolbar address bar disabled with no active view when no in-place seam is provided', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="desktop"
        state={reducer.createBrowserControlState()}
        onCommand={vi.fn()}
        launchpadRows={[]}
        launchpadRefreshStatus="idle"
        testID="browser-shell"
      />,
    );

    const address = screen.findByTestId('browser-shell-address');
    expect((address?.props as { editable?: boolean }).editable).toBe(false);
  });

  it('mounts the browser launchpad workspace launcher (URL entry + guidance) when no view or target suggestions exist', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={reducer.createBrowserControlState()}
        onCommand={onCommand}
        launchpadRows={[]}
        launchpadRefreshStatus="idle"
        testID="browser-shell"
      />,
    );

    // FP-BRW-LAUNCHER-1: the empty state is now the live workspace launcher (URL entry +
    // guidance), not the inert "No browser targets" banner. On desktop the shell's own address
    // bar is that entry: the launchpad never draws a second one under it (DA3 D13).
    expect(screen.findByTestId('browser-shell-address')).toBeTruthy();
    expect(screen.findByTestId('browser-shell-launchpad-url-entry')).toBeNull();
    expect(
      screen.findByTestId('browser-shell-launchpad-guidance'),
    ).toBeTruthy();
    expect(screen.findByTestId('browser-shell-launchpad-empty')).toBeNull();
    expect(screen.findByTestId('browser-shell-view-unavailable')).toBeNull();
  });

  it('offers no page tools beside the launchpad, so having no page never reads as an unopenable target', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={reducer.createBrowserControlState()}
        onCommand={vi.fn()}
        browserContext={{
          state: createBrowserContextState(),
          contextCapabilities: {
            ...contextCapabilities,
            supportedContextKinds: [
              'browserPageReference',
              'browserAnnotation',
            ],
          } satisfies BrowserContextCapabilities,
          enabled: true,
          onStateChange: vi.fn(),
        }}
        launchpadRows={[]}
        launchpadRefreshStatus="idle"
        testID="browser-shell"
      />,
    );

    expect(screen.findByTestId('browser-shell-launchpad')).toBeTruthy();
    expect(screen.findByTestId('browser-shell-mark-up')).toBeNull();
    expect(screen.findByTestId('browser-shell-attach-page')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'browserShell.unavailable.targetKindUnavailable',
    );
  });

  it.each(['preparing', 'opening'] as const)(
    'shows the Connecting state instead of the launchpad while the first open is %s',
    async (firstUse) => {
      const { BrowserShell } = await import('./BrowserShell');
      const reducer = await import('@/sync/domains/browser/control/reducer');

      const screen = await renderScreen(
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={reducer.createBrowserControlState()}
          onCommand={vi.fn()}
          launchpadRows={[]}
          launchpadRefreshStatus="idle"
          streamedBrowserRuntime={{
            machineName: 'Remote',
            playerState: null,
            firstUse,
          }}
          testID="browser-shell"
        />,
      );

      expect(screen.findByTestId('browser-shell-first-use')).toBeTruthy();
      expect(screen.findByTestId('browser-shell-launchpad')).toBeNull();
    },
  );

  it('shows the page the agent asked for in the chrome while its browser is preparing or opening', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const render = (
      runtime: Parameters<typeof BrowserShell>[0]['streamedBrowserRuntime'],
    ) =>
      renderScreen(
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={reducer.createBrowserControlState()}
          onCommand={vi.fn()}
          launchpadRows={[]}
          launchpadRefreshStatus="idle"
          streamedBrowserRuntime={runtime}
          testID="browser-shell"
        />,
      );
    const opening = await render({
      machineName: 'Remote',
      playerState: null,
      firstUse: 'opening',
      firstUseTargetUrl: 'http://localhost:5173/login',
    });
    expect(opening.findByTestId('browser-shell-address')?.props.value).toBe(
      'localhost:5173/login',
    );
    // Without a first-use open the empty chrome stays empty.
    const idle = await render({ machineName: 'Remote', playerState: null });
    expect(idle.findByTestId('browser-shell-address')?.props.value).toBe('');
  });

  it('keeps the launchpad beside a failed first open and hands the sandbox action to its card', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const onAllowBrowserSandbox = vi.fn(async () => ({
      status: 'installed' as const,
    }));

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={reducer.createBrowserControlState()}
        onCommand={vi.fn()}
        launchpadRows={[]}
        launchpadRefreshStatus="idle"
        onAllowBrowserSandbox={onAllowBrowserSandbox}
        streamedBrowserRuntime={{
          machineName: 'Remote',
          playerState: null,
          firstUse: 'sandboxUnavailable',
        }}
        testID="browser-shell"
      />,
    );

    expect(screen.findByTestId('browser-shell-first-use')).toBeNull();
    expect(screen.findByTestId('browser-shell-address')).toBeTruthy();
    expect(screen.findByTestId('browser-shell-launchpad-url-entry')).toBeNull();
    await act(async () => {
      screen.pressByTestId(
        'browser-shell-launchpad-agent-browser-allow-sandbox',
      );
    });
    expect(onAllowBrowserSandbox).toHaveBeenCalledTimes(1);
  });

  it('disables launchpad target rows when no open-target handler is available', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
    const launchpadRows: readonly BrowserLaunchpadRow[] = [
      {
        id: 'localService:launcher_preview',
        section: 'running',
        sourceKind: 'localService',
        title: 'Preview',
        subtitle: 'localhost:5173',
        detail: 'vite',
        target,
        disabledReason: null,
        lastSeenAt: 1_000,
      },
    ];

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={reducer.createBrowserControlState()}
        onCommand={onCommand}
        launchpadRows={launchpadRows}
        launchpadRefreshStatus="idle"
        testID="browser-shell"
      />,
    );

    expect(
      screen.findByTestId(
        'browser-shell-launchpad-card:localService:launcher_preview-disabled',
      ),
    ).toBeTruthy();
  });

  it('renders the workspace-selected active view (driven by the viewId prop), not an inner tab strip', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createTwoTabShellState();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        viewId="view_2"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        testID="browser-shell"
      />,
    );

    // The active content is the view the workspace selected (view_2), and there is no bespoke
    // inner browser tab strip — the details-workspace strip is the single tab system.
    expect(findBrowserIframe(screen).props.src).toBe(
      'https://second-preview.happier.test/',
    );
    expect(screen.findByTestId('browser-shell-tab-view_1')).toBeNull();
    expect(screen.findByTestId('browser-shell-tab-view_2')).toBeNull();
  });

  it('captures the focused browser page into browser context state from shell chrome', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
    const onAttachUnavailable =
      vi.fn<NonNullable<BrowserShellContextState['onAttachUnavailable']>>();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserContext={{
          state: createBrowserContextState(),
          contextCapabilities,
          onStateChange: onContextStateChange,
          onAttachUnavailable,
          nowMs: () => 7_000,
        }}
        testID="browser-shell"
      />,
    );

    await screen.pressByTestIdAsync('browser-shell-attach-page');

    expect(onAttachUnavailable).not.toHaveBeenCalled();
    expect(onContextStateChange).toHaveBeenCalledTimes(1);
    const nextState = onContextStateChange.mock.calls[0]?.[0];
    expect(nextState).toBeDefined();
    if (!nextState) return;
    const [attachment] = selectBrowserContextComposerAttachments(nextState);
    expect(attachment).toEqual(
      expect.objectContaining({
        sourceViewId: 'view_1',
        capturedNavigationGeneration: 0,
        state: 'available',
      }),
    );
    const item = nextState.itemsById[attachment!.contextId];
    expect(item).toEqual(
      expect.objectContaining({
        kind: 'browserPageReference',
        url: 'https://preview.happier.test/',
        title: 'Preview',
        capturedAtMs: 7_000,
      }),
    );
  });

  it('does not re-register the composer page attachment handler when only browser context state changes', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const onAttachPageReferenceChange =
      vi.fn<(handler: (() => void) | null) => void>();
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
    const initialContextState = createBrowserContextState();
    const renderShell = (contextState: BrowserContextState) => (
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserContext={{
          state: contextState,
          contextCapabilities,
          onStateChange: onContextStateChange,
          onAttachPageReferenceChange,
          nowMs: () => 7_000,
        }}
        testID="browser-shell"
      />
    );

    const screen = await renderScreen(renderShell(initialContextState));
    await flushHookEffects({ cycles: 2, turns: 2 });

    expect(onAttachPageReferenceChange).toHaveBeenCalledTimes(1);
    expect(onAttachPageReferenceChange).toHaveBeenLastCalledWith(
      expect.any(Function),
    );

    await screen.update(
      renderShell({
        ...initialContextState,
        navigationGenerationByViewId: {
          ...initialContextState.navigationGenerationByViewId,
          view_1: 0,
        },
      }),
    );
    await flushHookEffects({ cycles: 2, turns: 2 });

    expect(onAttachPageReferenceChange).toHaveBeenCalledTimes(1);
  });

  it('marks attached browser context stale when the focused view navigates', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const {
      attachActiveBrowserPageReference,
      selectBrowserContextComposerAttachments: selectAttachments,
    } = await import('@/sync/domains/browser/context');
    const initialState = await createShellState();
    const initialView = initialState.viewsById.view_1;
    expect(initialView).toBeDefined();
    if (!initialView) return;
    const attached = attachActiveBrowserPageReference({
      state: createBrowserContextState(),
      browserContextEnabled: true,
      contextCapabilities,
      view: initialView,
      capturedAtMs: 7_000,
    });
    expect(attached.status).toBe('attached');
    if (attached.status !== 'attached') return;
    expect(selectAttachments(attached.state)[0]?.state).toBe('available');
    const navigatedState = reducer.applyBrowserControlEvent(initialState, {
      kind: 'navigationCommitted',
      eventId: 'event_navigation_committed',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      currentUrl: 'https://preview.happier.test/next',
      occurredAt: 8_000,
    } satisfies BrowserEventV1);
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

    await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={navigatedState}
        onCommand={vi.fn()}
        browserContext={{
          state: attached.state,
          contextCapabilities,
          onStateChange: onContextStateChange,
        }}
        testID="browser-shell"
      />,
    );

    expect(onContextStateChange).toHaveBeenCalledTimes(1);
    const [staleState] = onContextStateChange.mock.calls[0] ?? [];
    expect(staleState).toBeDefined();
    if (!staleState) return;
    const [attachment] = selectAttachments(staleState);
    expect(attachment).toEqual(
      expect.objectContaining({
        sourceViewId: 'view_1',
        capturedNavigationGeneration: 0,
        currentNavigationGeneration: 1,
        state: 'navigationStale',
        requiresReconfirmBeforeSend: true,
      }),
    );
  });

  it('marks attached browser context stale when a non-focused source view navigates', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const {
      attachActiveBrowserPageReference,
      selectBrowserContextComposerAttachments: selectAttachments,
    } = await import('@/sync/domains/browser/context');
    const twoTabState = await createTwoTabShellState();
    const initialView = twoTabState.viewsById.view_1;
    expect(initialView).toBeDefined();
    if (!initialView) return;
    const attached = attachActiveBrowserPageReference({
      state: createBrowserContextState(),
      browserContextEnabled: true,
      contextCapabilities,
      view: initialView,
      capturedAtMs: 7_000,
    });
    expect(attached.status).toBe('attached');
    if (attached.status !== 'attached') return;
    const focusedSecond = reducer.applyBrowserControlEvent(twoTabState, {
      kind: 'viewFocused',
      eventId: 'event_focus_second',
      browserSessionId: 'browser_session_1',
      viewId: 'view_2',
      occurredAt: 7_500,
    } satisfies BrowserEventV1);
    const navigatedFirst = reducer.applyBrowserControlEvent(focusedSecond, {
      kind: 'navigationCommitted',
      eventId: 'event_navigation_first',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      currentUrl: 'https://preview.happier.test/background',
      occurredAt: 8_000,
    } satisfies BrowserEventV1);
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

    await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={navigatedFirst}
        onCommand={vi.fn()}
        browserContext={{
          state: attached.state,
          contextCapabilities,
          onStateChange: onContextStateChange,
        }}
        testID="browser-shell"
      />,
    );

    expect(onContextStateChange).toHaveBeenCalledTimes(1);
    const [staleState] = onContextStateChange.mock.calls[0] ?? [];
    expect(staleState).toBeDefined();
    if (!staleState) return;
    const [attachment] = selectAttachments(staleState);
    expect(attachment).toEqual(
      expect.objectContaining({
        sourceViewId: 'view_1',
        capturedNavigationGeneration: 0,
        currentNavigationGeneration: 1,
        state: 'navigationStale',
        requiresReconfirmBeforeSend: true,
      }),
    );
  });

  it('mounts browser diagnostics for the focused view from the shared diagnostics store', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const diagnosticsState = applyBrowserDiagnosticEvents(
      createBrowserDiagnosticsUiStore(),
      {
        events: [
          {
            v: 1,
            eventId: 'evt_page_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            capturedAtMs: 2_000,
            family: 'pageInfo',
            kind: 'pageInfo.snapshot',
            fidelity: 'nativeCallback',
            trusted: true,
            data: {
              url: 'https://preview.happier.test/',
              loading: false,
            },
            redaction: {
              level: 'metadataOnly',
              queryRedacted: true,
              headersRedacted: true,
              truncated: false,
            },
          },
        ],
      },
    );

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserDiagnostics={{
          state: diagnosticsState,
          requestEval: vi.fn(() => false),
          requestGetProperties: vi.fn(() => false),
          requestReleaseObjectGroup: vi.fn(() => false),
        }}
        testID="browser-shell"
      />,
    );

    // Lab Q: idle Diagnostics live in `⋯` on every width; no bar sits under the page until it is
    // opened from there. Once opened, the drawer speaks once per section and draws no mechanism chip.
    expect(
      screen.findByTestId('browser-shell-diagnostics-container-closed'),
    ).toBeNull();
    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync('browser-shell-overflow-item-open-diagnostics');
    expect(screen.findByTestId('browser-shell-diagnostics-body')).toBeTruthy();
    // The drawer's one state line speaks; the mechanism is not a chip.
    expect(screen.findByTestId('browser-shell-diagnostics-body-fidelity-nativeCallback')).toBeNull();

    // The drawer shows one family at a time; select the pageInfo section to
    // reveal its family panel + event row.
    await screen.pressByTestIdAsync('browser-shell-diagnostics-tab:pageInfo');
    expect(
      screen.findByTestId('browser-shell-diagnostics-body-family-pageInfo'),
    ).toBeTruthy();
    expect(
      screen.findByTestId(
        'browser-shell-diagnostics-body-pageInfo-fields-url',
      ),
    ).toBeTruthy();
  });

  it('keeps iframe Diagnostics reachable and explains the reported cross-origin refusal', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const screen = await renderScreen(<BrowserShell browserSessionId="browser_session_1" platform="web"
      state={state} onCommand={vi.fn()} browserDiagnostics={{
        state: createBrowserDiagnosticsUiStore(),
        diagnosticsAvailability: { status: 'unavailable', reasonCode: 'cross_origin_frame_unavailable' },
        requestEval: () => false, requestGetProperties: () => false, requestReleaseObjectGroup: () => false,
      }} testID="browser-shell" />);

    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync('browser-shell-overflow-item-open-diagnostics');
    expect(screen.getTextContent()).toContain('browserDiagnostics.host.devtools.unavailable.directPage');
    expect(screen.findByTestId('browser-shell-diagnostics-body-family-console')).toBeNull();
    expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).not.toHaveBeenCalled();
  });

  it("keeps the address its room in a narrow pane by folding the page size into the pane header's ⋯", async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
    const state = await createShellState();
    const view = { ...state.viewsById.view_1!, adapterKind: 'chromiumSidecar' as const, engineKind: 'streamedSurface' as const,
      adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['streamedSurface'] }) };
    const managedState = { ...state, viewsById: { ...state.viewsById, [view.viewId]: view } };
    const onCommand = vi.fn();
    const published: { current: ReturnType<typeof usePublishedPaneHeaderContent> } = { current: null };
    function HeaderProbe() { published.current = usePublishedPaneHeaderContent('browser'); return null; }
    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <HeaderProbe />
        <PaneHeaderSlotScope slotKey="browser">
          <BrowserShell browserSessionId="browser_session_1" platform="web" state={managedState} onCommand={onCommand}
            streamedBrowserRuntime={{ machineName: 'Remote', playerState: null, input: {
              sourceId: 'source_1', streamId: 'stream_1',
              viewport: { width: 800, height: 600, deviceScaleFactor: 1, emulation: { kind: 'fitViewer' } }, send: () => {},
            } }} testID="browser-shell" />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    await act(async () => {
      screen.findHostByTestId('browser-shell')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 380, height: 700 } } });
    });
    expect(screen.findHostByTestId('browser-shell-viewport')).toBeNull();
    const sizes = (published.current?.menuActions ?? []).filter(action => action.group?.id === 'browser-viewport');
    expect(sizes.find(action => action.id === 'browser-viewport:fitViewer')?.selected).toBe(true);
    await act(async () => { sizes.find(action => action.id === 'browser-viewport:phone')?.onPress?.(); });
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'setViewport',
      emulation: { kind: 'preset', presetId: 'phone' } }));
  });

  it('offers canonical managed viewport presets and waits for the daemon selection projection', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { BROWSER_VIEWPORT_PRESETS } = await import('@happier-dev/protocol/browser/input/v1');
    const state = await createShellState();
    const view = { ...state.viewsById.view_1!, adapterKind: 'chromiumSidecar' as const, engineKind: 'streamedSurface' as const,
      adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['streamedSurface'] }) };
    const managedState = { ...state, viewsById: { ...state.viewsById, [view.viewId]: view } };
    // The network peer is the boundary; keep command-to-Action selection and dispatch real.
    const sendDaemonCommand = vi.fn(async (command: BrowserCommandV1) => ({
      ok: true as const, result: { v: 1 as const, commandId: command.commandId,
        status: 'dispatched' as const, adapterKind: 'chromiumSidecar' as const, events: [] },
    }));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      runtimeActionExecute: createBrowserRuntimeActionExecutor({ control: {
        readState: () => managedState, applyDispatchResult: () => {}, sendDaemonCommand,
      } }),
    }));
    const outcomes: unknown[] = [];
    const onCommand = vi.fn((command: BrowserCommandV1) => {
      void executor.execute(browserControlActionId(command), command, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      }).then(result => { outcomes.push(result); }, error => { outcomes.push(error); });
    });
    const render = (emulation: import('@happier-dev/protocol/browser/input/v1').BrowserViewportEmulationV1) =>
      <BrowserShell browserSessionId="browser_session_1" platform="web" state={managedState} onCommand={onCommand}
        streamedBrowserRuntime={{ machineName: 'Remote', playerState: null, input: {
          sourceId: 'source_1', streamId: 'stream_1',
          viewport: { width: 800, height: 600, deviceScaleFactor: 1, emulation }, send: () => {},
        } }} testID="browser-shell" />;
    const screen = await renderScreen(render({ kind: 'fitViewer' }));
    const openPicker = async () => {
      await screen.pressByTestIdAsync('browser-shell-viewport');
      // DropdownMenu defers opening until after the activating pointer has settled.
      await vi.waitFor(() => expect(screen.findHostByTestId('browser-shell-viewport-fitViewer')).toBeTruthy());
    };
    await openPicker();
    expect(screen.findHostByTestId('browser-shell-viewport-fitViewer')?.props.accessibilityState).toMatchObject({ checked: true });
    for (const presetId of Object.keys(BROWSER_VIEWPORT_PRESETS)) {
      expect(screen.findByTestId(`browser-shell-viewport-${presetId}`)).toBeTruthy();
    }
    await screen.pressByTestIdAsync('browser-shell-viewport-phone');
    // Selection commits after the shared menu closes and restores focus.
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'setViewport',
      browserSessionId: 'browser_session_1', viewId: 'view_1', emulation: { kind: 'preset', presetId: 'phone' } })));
    await vi.waitFor(() => expect(sendDaemonCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'setViewport', emulation: { kind: 'preset', presetId: 'phone' },
    })));
    expect(outcomes).toEqual([expect.objectContaining({ ok: true })]);
    await openPicker();
    expect(screen.findHostByTestId('browser-shell-viewport-fitViewer')?.props.accessibilityState).toMatchObject({ checked: true });
    await screen.update(render({ kind: 'preset', presetId: 'phone' }));
    expect(screen.findHostByTestId('browser-shell-viewport-phone')?.props.accessibilityState).toMatchObject({ checked: true });
    for (const presetId of Object.keys(BROWSER_VIEWPORT_PRESETS) as (keyof typeof BROWSER_VIEWPORT_PRESETS)[]) {
      await screen.pressByTestIdAsync(`browser-shell-viewport-${presetId}`);
      await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'setViewport',
        emulation: { kind: 'preset', presetId } })));
      await screen.update(render({ kind: 'preset', presetId }));
      await openPicker();
      expect(screen.findHostByTestId(`browser-shell-viewport-${presetId}`)?.props.accessibilityState).toMatchObject({ checked: true });
    }
    await screen.pressByTestIdAsync('browser-shell-viewport-fitViewer');
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'setViewport', emulation: { kind: 'fitViewer' } })));
  });

  it('fails closed for browser diagnostics when no explicit diagnostics state is provided', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    stubBrowserDiagnosticsWebEnvironment();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        testID="browser-shell"
      />,
    );

    expect(screen.findByTestId('browser-shell-diagnostics')).toBeNull();
    expect(screen.findByTestId('browser-shell-diagnostics-status')).toBeNull();
    expect(
      testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc,
    ).not.toHaveBeenCalled();
  });

  it('renders explicit disabled browser recording states for capture and permission failures', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { createBrowserRecordingState } =
      await import('@/sync/domains/browser/recording');
    const state = await createShellState();

    const captureUnavailable = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserRecording={{
          state: createBrowserRecordingState(),
          recordingCapabilities: unavailableRecordingCapabilities,
          enabled: true,
          onStartRecording: vi.fn(),
          onStopRecording: vi.fn(),
          onCancelRecording: vi.fn(),
        }}
        testID="browser-shell"
      />,
    );

    // Idle recording is a `⋯` tool, never a pill in the chrome.
    expect(
      captureUnavailable.findHostByTestId(
        'browser-shell-recording-status-recording',
      ),
    ).toBeNull();
    // An engine that can never record does not offer a recording at all; with nothing else in it,
    // the `⋯` itself is not drawn.
    expect(captureUnavailable.findHostByTestId('browser-shell-overflow')).toBeNull();
    expect(captureUnavailable.findHostByTestId(
      'browser-shell-overflow-item-start-recording',
    )).toBeNull();

    const permissionDenied = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserRecording={{
          state: createBrowserRecordingState(),
          recordingCapabilities: availableRecordingCapabilities,
          enabled: true,
          policyState: 'permissionDenied',
          onStartRecording: vi.fn(),
          onStopRecording: vi.fn(),
          onCancelRecording: vi.fn(),
        }}
        testID="browser-shell-permission"
      />,
    );

    await permissionDenied.pressByTestIdAsync(
      'browser-shell-permission-overflow',
    );
    const permissionStartButton = permissionDenied.findHostByTestId(
      'browser-shell-permission-overflow-item-start-recording',
    );
    expect(permissionStartButton?.props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // Recordable but blocked: a plain, translated reason, never the mechanism's own message.
    expect(permissionDenied.getTextContent()).toContain('browserRecording.status.notAllowed');
    expect(permissionDenied.getTextContent()).not.toContain('Browser recording is denied by policy.');
  });

  it('delegates recording starts with the focused browser target for source resolution', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { createBrowserRecordingState } =
      await import('@/sync/domains/browser/recording');
    const state = await createSimulatorPreviewShellState();
    const onStartRecording = vi.fn();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserRecording={{
          state: createBrowserRecordingState(),
          recordingCapabilities: availableRecordingCapabilities,
          enabled: true,
          nowMs: () => 10_000,
          isCaptureSourceAvailable: () => true,
          onStartRecording,
        }}
        testID="browser-shell"
      />,
    );

    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync(
      'browser-shell-overflow-item-start-recording',
    );

    expect(onStartRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: simulatorPreviewTarget,
        targetKind: simulatorPreviewTarget.kind,
        adapterKind: 'simulatorPreview',
        renderEngineKind: 'streamedSurface',
        captureKind: 'streamFrameCapture',
        navigationGeneration: 0,
      }),
    );
  });

  it('renders active browser recording status and delegates stop or cancel actions', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { applyBrowserRecordingSessionSnapshot, createBrowserRecordingState } =
      await import('@/sync/domains/browser/recording');
    const state = await createSimulatorPreviewShellState();
    const activeRecording = {
      v: 1,
      recordingId: 'recording_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'simulatorPreview',
      adapterKind: 'simulatorPreview',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      startedAtMs: 10_000,
      navigationGenerationStart: 0,
      status: 'recording',
      durationMs: 0,
      byteSize: 0,
      frameCount: 0,
      fps: availableRecordingCapabilities.maxFps,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      redactionLevel: 'metadataOnly',
      policyState: 'allowed',
      actionChapters: [],
      relatedReferences: [],
    } satisfies import('@happier-dev/protocol/browser/recording/v1').BrowserRecordingSessionV1;
    const recordingState = applyBrowserRecordingSessionSnapshot(createBrowserRecordingState(), activeRecording);
    const onStopRecording = vi.fn();
    const onCancelRecording = vi.fn();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserRecording={{
          state: recordingState,
          recordingCapabilities: availableRecordingCapabilities,
          enabled: true,
          nowMs: () => 12_300,
          onStartRecording: vi.fn(),
          onStopRecording,
          onCancelRecording,
        }}
        testID="browser-shell"
      />,
    );

    // A running recording is one capsule in the chrome: elapsed time and Stop, nothing else.
    expect(
      screen.findByTestId('browser-shell-recording-status-recording'),
    ).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('browserRecording.fidelity');

    await screen.pressByTestIdAsync('browser-shell-recording-stop');
    await screen.pressByTestIdAsync('browser-shell-overflow');
    await screen.pressByTestIdAsync(
      'browser-shell-overflow-item-discard-recording',
    );

    expect(onStopRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: activeRecording.recordingId,
      }),
    );
    expect(onCancelRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: activeRecording.recordingId,
      }),
    );
    expect(onStopRecording.mock.calls[0]?.[0]).not.toHaveProperty('mediaRef');
    expect(onCancelRecording.mock.calls[0]?.[0]).not.toHaveProperty('mediaRef');
  });

  it('keeps idle chrome to one quiet row: no recording or automation pills while nothing runs (H-UX F-5)', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { createBrowserRecordingState } =
      await import('@/sync/domains/browser/recording');
    const { createBrowserAutomationControlService } =
      await import('@/sync/domains/browser/automation');
    const state = await createShellState();
    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserRecording={{
          state: createBrowserRecordingState(),
          recordingCapabilities: availableRecordingCapabilities,
          enabled: true,
          onStartRecording: vi.fn(),
        }}
        browserAutomation={{
          controlService: createBrowserAutomationControlService({
            nowMs: () => 1_000,
          }),
          enabled: true,
        }}
        testID="browser-shell"
      />,
    );

    expect(
      screen.findHostByTestId('browser-shell-recording-status-recording'),
    ).toBeNull();
    expect(screen.findHostByTestId('browser-shell-presence')).toBeNull();
    const text = screen.getTextContent();
    expect(text).not.toContain('browserRecording.status');
    expect(text).not.toContain('browserRecording.fidelity');
    expect(text).not.toContain('browserAutomation.status');
  });

  it('shows who drives the page and lets the person take control from the agent (lab browser A/H)', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { createBrowserAutomationControlService } =
      await import('@/sync/domains/browser/automation');
    const state = await createShellState();
    const controlService = createBrowserAutomationControlService({
      nowMs: () => 20_000,
    });
    let resolvePending: (result: { status: 'succeeded' }) => void = () =>
      undefined;
    const pending = new Promise<{ status: 'succeeded' }>((resolve) => {
      resolvePending = resolve;
    });

    expect(
      controlService.registerOwner({
        ownerId: 'owner_ui_1',
        authority: 'uiLocal',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        adapterKind: 'localPreview',
        fidelity: 'injectedPage',
        trustedInput: false,
        supportedActions: ['click'],
        executeAction: async () => pending,
      }),
    ).toEqual({ ok: true });
    const action = controlService.executeAction({
      v: 1,
      automationRequestId: 'automation_request_click_sign_in',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 0,
      requestedBy: 'agent',
      requesterRef: {
        kind: 'session',
        id: 'session_1',
      },
      actionKind: 'click',
      timeoutMs: 10_000,
    });
    await Promise.resolve();

    const executor = createActionExecutor(
      createActionExecutorBoundaryFixture({
        runtimeActionExecute: createBrowserRuntimeActionExecutor({
          control: { readState: () => state, applyDispatchResult: () => {} },
          automation: { controlService },
        }),
      }),
    );
    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={(command) =>
          executor.execute(browserControlActionId(command), command, {
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
          })
        }
        browserAutomation={{
          controlService,
          enabled: true,
        }}
        testID="browser-shell"
      />,
    );

    // The agent is acting: one presence capsule names it and what it is doing.
    expect(screen.findByTestId('browser-shell-presence-agent')).toBeTruthy();
    expect(screen.getTextContent()).toContain('browserPresence.doing.click');
    // No mechanism copy on primary chrome: no request ids, no "automation" status pills.
    expect(screen.getTextContent()).not.toContain(
      'automation_request_click_sign_in',
    );
    expect(screen.getTextContent()).not.toContain('browserAutomation.status');

    await screen.pressByTestIdAsync('browser-shell-presence-take-control');
    // The engine's interrupted work settles; the owner then answers the takeover.
    resolvePending({ status: 'succeeded' });
    await expect(action).resolves.toMatchObject({
      status: 'interrupted',
      errorCode: 'human_interrupted',
    });
    await flushHookEffects();

    expect(screen.findByTestId('browser-shell-presence-human')).toBeTruthy();
    await screen.pressByTestIdAsync('browser-shell-presence-hand-back');
    await flushHookEffects();
    expect(screen.findHostByTestId('browser-shell-presence')).toBeNull();
  });

  it('offers hand back through the session model for a daemon-held view', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();
    const view = state.viewsById.view_1;
    const onCommand = vi.fn(); // The shell's admitted host callback, not a daemon transport.
    const sendCommand = vi.fn(); // Machine RPC transport boundary must not be called by chrome.
    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={{
          ...state,
          viewsById: {
            ...state.viewsById,
            view_1: {
              ...view,
              adapterKind: 'chromiumSidecar',
              automationController: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                controller: 'human',
                controlEpoch: 1,
              },
            },
          },
        }}
        onCommand={onCommand}
        testID="browser-shell"
        browserContext={{
          state: createBrowserContextState(),
          contextCapabilities,
          onStateChange: vi.fn(),
          daemonControl: { sendCommand },
        }}
      />,
    );
    expect(
      screen.findByTestId('browser-shell-presence-hand-back'),
    ).toBeTruthy();
    await screen.pressByTestIdAsync('browser-shell-presence-hand-back');
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'handBack',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
      }),
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('acquires daemon ring history only while the Diagnostics drawer is open', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { useBrowserDiagnosticsRuntime } = await import('./diagnostics');
    const { selectActiveBrowserView } =
      await import('@/sync/domains/browser/shell');
    const state = await createShellState();
    stubBrowserDiagnosticsWebEnvironment();
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue(
      {
        ok: true,
        snapshot: createDaemonDiagnosticsSnapshot([
          createDaemonDiagnosticsEvent(),
        ]),
      },
    );
    function BrowserShellWithExplicitDiagnostics(): React.ReactElement {
      const diagnostics = useBrowserDiagnosticsRuntime({
        view: selectActiveBrowserView(state, 'browser_session_1'),
        enabled: true,
        daemonSnapshotServerId: 'server_1',
      });
      return (
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={state}
          onCommand={vi.fn()}
          localServicePreviewServerId="server_1"
          browserDiagnostics={diagnostics}
          testID="browser-shell"
        />
      );
    }

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const screen = await renderScreen(<BrowserShellWithExplicitDiagnostics />);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(0);
      expect(screen.findByTestId('browser-shell-diagnostics-container-closed')).toBeNull();

      await screen.pressByTestIdAsync('browser-shell-overflow');
      await screen.pressByTestIdAsync('browser-shell-overflow-item-open-diagnostics');
      await flushHookEffects();
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(1);
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 'machine_1', serverId: 'server_1' }),
      );
      const firstSignal = testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mock.calls[0][0].signal;
      // This event predates opening: the daemon's existing ring supplies history on demand.
      expect(screen.findByTestId('browser-shell-diagnostics-body-fidelity-cdp')).toBeNull();
      expect(screen.findByTestId('browser-shell-diagnostics-body-console-available')).toBeTruthy();
      expect(screen.findByTestId('browser-shell-diagnostics-body-console-row-evt_daemon_console_1')).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(1);
      await screen.pressByTestIdAsync('browser-shell-diagnostics-close');
      expect(firstSignal.aborted).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(1);

      testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue({
        ok: true,
        snapshot: createDaemonDiagnosticsSnapshot([createDaemonDiagnosticsEvent({ eventId: 'evt_while_closed' })]),
      });
      await screen.pressByTestIdAsync('browser-shell-overflow');
      await screen.pressByTestIdAsync('browser-shell-overflow-item-open-diagnostics');
      await flushHookEffects();
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(2);
      expect(screen.findByTestId('browser-shell-diagnostics-body-console-row-evt_while_closed')).toBeTruthy();
    } finally {
      await screen.unmount();
      vi.useRealTimers();
    }
  });

  it('refuses iframe Markup through both the chrome and the registered agent Action with the capture-specific reason', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const scope = { serverId: (await addBrowserHome('https://browser-shell-no-capture.example.test')).id, accountId: 'viewer-account' };
    const state = await createAnnotationCapableShellState();
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

    const screen = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        browserContext={{
          accountScope: scope,
          state: createBrowserContextState(),
          contextCapabilities: {
            ...contextCapabilities,
            supportedContextKinds: [
              'browserPageReference',
              'browserAnnotation',
            ],
            screenshot: {
              supported: true,
              requiresAttachmentUploads: true,
              maxBytes: 5_000_000,
            },
          },
          attachmentsUploadsEnabled: true,
          onStateChange: onContextStateChange,
          nowMs: () => 8_000,
        }}
        testID="browser-shell"
      />,
    );

    const executor = createActionExecutor(
      createActionExecutorBoundaryFixture({
        runtimeActionExecute: createBrowserRuntimeActionExecutor({
          resolveAnnotation: readRegisteredBrowserContextAnnotationAdapter,
        }),
      }),
    );
    const result = await executor.execute(
      'browser.context.annotation.start',
      {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
      },
      { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId },
    );
    expect(result).toMatchObject({
      ok: false,
      error:
        'runtime_action_disabled:browser:browser_context_annotation_iframe_capture_unavailable',
    });
    // A page that can never be captured does not offer Mark up at all (like Start recording).
    expect(screen.findByTestId('browser-shell-mark-up')).toBeNull();
    expect(onContextStateChange).not.toHaveBeenCalled();
  });

  it('keeps Attach page in the chrome row at a 390px mobile width and offers no Mark up it cannot fulfil', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createAnnotationCapableShellState();
    const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

    const screen = await renderScreen(
      <View style={{ width: 390, height: 844 }}>
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={state}
          onCommand={vi.fn()}
          browserContext={{
            state: createBrowserContextState(),
            contextCapabilities: {
              ...contextCapabilities,
              supportedContextKinds: [
                'browserPageReference',
                'browserAnnotation',
              ],
              screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
                maxBytes: 5_000_000,
              },
            },
            attachmentsUploadsEnabled: true,
            onStateChange: onContextStateChange,
            nowMs: () => 8_000,
          }}
          testID="browser-shell"
        />
      </View>,
    );

    // At phone width Attach page folds to its glyph; Mark up is absent because this page can never be captured.
    expect(screen.findByTestId('browser-shell-attach-page')).toBeTruthy();
    expect(screen.findByTestId('browser-shell-mark-up')).toBeNull();
    expect(onContextStateChange).not.toHaveBeenCalled();
  });

});

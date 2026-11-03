import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { afterEach } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import type { ImageAnnotator } from '@/components/ui/media/annotation';
import type { BrowserAnnotationCommitInput } from '@/components/sessions/browser/commitBrowserAnnotation';
import { setBrowserAnnotationDraftComment, startBrowserAnnotationDraft } from '@/sync/domains/browser/context/annotationDraft';
import * as React from 'react';
import type {
  BrowserCommandV1,
  BrowserContextCapabilities,
  BrowserDiagnosticEventV1,
  BrowserDiagnosticsSnapshotV1,
  BrowserEventV1,
  BrowserRecordingCapabilities,
  BrowserViewTargetV1,
  DaemonLocalServicePreviewOpenOrCreateResponseV1,
} from '@happier-dev/protocol';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findTestInstanceByTypeContainingText,
  flushHookEffects,
  renderScreen,
  type RenderScreenResult,
} from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
  createBrowserContextState,
  selectBrowserContextComposerAttachments,
  type BrowserContextState,
  type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import {
  applyBrowserDiagnosticEvents,
  createBrowserDiagnosticsUiStore,
} from '@/sync/domains/browser/diagnostics';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { browserControlActionId } from '@/sync/domains/browser/actions/controlActionId';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { readRegisteredBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/runtimeAnnotationRegistry';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isAgentInitiatedApprovalRequiredByDefault, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { createBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context';

const testState = vi.hoisted(() => ({
  useLocalServicePreviewState: vi.fn(),
  fetchBrowserDiagnosticsSnapshotViaMachineRpc: vi.fn(),
  machineRpc: vi.fn(),
  previewFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  previewToken: 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature',
}));

// Substitute only Home HTTP and credential storage; preview admission and URL selection stay real.
vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: (...args: Parameters<typeof testState.previewFetch>) =>
    testState.previewFetch(...args),
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } =
    await import('@/dev/testkit/mocks/tokenStorage');
  return createTokenStorageModuleMock({
    importOriginal,
    tokenStorage: {
      getCredentialsForServerUrl: async () => ({
        token: testState.previewToken,
      }),
    },
  });
});

const homes = createHomeGovernanceHarness();
async function addBrowserHome(serverUrl: string) {
  const serverIdentityId = `browser-shell:${new URL(serverUrl).hostname}`;
  testState.previewToken = createAccountTokenForTests('viewer-account', { currentAccount: true });
  const id = await homes.addHome({
    name: 'Browser Home', serverUrl, serverIdentityId, accountId: 'viewer-account', currentAccount: true,
    credentials: { token: testState.previewToken },
  });
  return { id };
}
afterEach(async () => { await homes.reset(); });
// Vitest needs the web canvas at this browser-host boundary.
vi.mock('@/components/ui/media/annotation/AnnotatorCanvas', async () => await import('@/components/ui/media/annotation/AnnotatorCanvas.web'));

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

vi.mock(
  '@/sync/domains/local/services/preview/useLocalServicePreviewState',
  () => ({
    useLocalServicePreviewState: (...args: readonly unknown[]) =>
      testState.useLocalServicePreviewState(...args),
  }),
);

vi.mock('@/sync/domains/browser/diagnostics/machineRpc', () => ({
  fetchBrowserDiagnosticsSnapshotViaMachineRpc: (...args: readonly unknown[]) =>
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc(...args),
}));

vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
      testState.machineRpc(...args),
  }),
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

describe('BrowserShell', () => {

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
      execute = async args => { pending = await admittedExecute(args); return pending; };
      await act(async () => {
        const result = await screen.tree.root.findByType(BrowserAnnotatorMount).props.session.onAttach();
        expect(pending).toMatchObject({ kind: 'approval_request_created', actionId: 'browser.context.annotation.attachDraft' });
        expect(ActionApprovalRequestCreatedResultSchema.safeParse(pending).success).toBe(true);
        expect(result).toEqual({ ok: false });
      });
      await screen.pressByTestIdAsync('browser-annotator-attach');
      await waitForAttachIdle();
      expect(contextState).toBe(initial);
      expect(screen.findByTestId('browser-annotator-stage')).toBeTruthy();
      expect(contextState.annotationDraftByViewId[view.viewId]?.comment).toBe('Keep the original caption.');
      expect(commitAnnotation).not.toHaveBeenCalled();
      // Successful UI delivery is covered by the composed marks-and-badge case above.
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
    const { resetBrowserDiagnosticsDrawerStateForTests } =
      await import('./diagnostics/BrowserDiagnosticsDrawer');
    resetBrowserDiagnosticsDrawerStateForTests();
    testState.useLocalServicePreviewState.mockReset();
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockReset();
    testState.machineRpc.mockReset();
    testState.previewFetch.mockReset();
    testState.previewFetch.mockResolvedValue(
      Response.json({ error: 'preview_access_denied' }, { status: 403 }),
    );
    const { createLocalServicePreviewState } =
      await import('@/sync/domains/local/services/preview/store');
    testState.useLocalServicePreviewState.mockReturnValue(
      createLocalServicePreviewState(),
    );
    testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('says on the ended card why Open again was refused, and leads to Services once nothing runs it', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const { buildBrowserLaunchpadRows } =
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
    const selectTab = vi.fn();
    const sideActions = { current: { tabs: ['files', 'services'], selectTab } };
    const render = (
      rows: readonly BrowserLaunchpadRow[],
      previewTarget: BrowserViewTargetV1 = ended.viewsById.view_1.target,
    ) => (
      <RightSidebarActionsContext.Provider value={sideActions}>
        <BrowserShell
          browserSessionId="browser_session_1"
          platform="web"
          state={{ ...ended, viewsById: { ...ended.viewsById, view_1: { ...ended.viewsById.view_1, target: previewTarget } } }}
          onCommand={vi.fn()}
          launchpadRows={rows}
          onOpenTarget={vi.fn()}
          testID="ended-local"
        />
      </RightSidebarActionsContext.Provider>
    );
    const screen = await renderScreen(render(running), {
      createNodeMock: (element) =>
        element.type === 'iframe' ? { contentWindow: {} } : null,
    });
    await act(async () => findBrowserIframe(screen).props.onLoad());
    const openAgain = 'ended-local-view-frame-ended-open-again';
    await screen.pressByTestIdAsync(openAgain);
    await flushHookEffects();
    expect(screen.findByTestId(openAgain)).toBeTruthy();
    expect(
      findTestInstanceByTypeContainingText(
        screen,
        'Text',
        'localServices.actions.failure.incomplete',
      ),
    ).toBeDefined();

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
    await screen.pressByTestIdAsync(
      'ended-local-view-frame-ended-services',
    );
    expect(selectTab).toHaveBeenCalledWith('services');
    // The same recovery remains available after the listener disappears.
    await screen.update(render([], target));
    expect(screen.findByTestId(openAgain)).toBeNull();
    expect(screen.findByTestId('ended-local-view-frame-ended-services')).toBeTruthy();
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

    // Lab W: Attach page and Mark up are visible chrome, not buried in `⋯`.
    expect(screen.findByTestId('browser-shell-attach-page')).toBeTruthy();
    expect(screen.findByTestId('browser-shell-mark-up')).toBeTruthy();
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

  it('says the Session\u2019s Machine once in the docked bar, and nothing for a browser that is not a Session\u2019s', async () => {
    const { BrowserShell } = await import('./BrowserShell');
    const state = await createShellState();

    const withMachine = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        machine={{ name: 'NLDW3-5-36-33', online: true }}
        testID="browser-shell"
      />,
    );
    expect(withMachine.getTextContent()).toContain('NLDW3-5-36-33');
    expect(withMachine.findByTestId('browser-shell-machine')).not.toBeNull();

    const without = await renderScreen(
      <BrowserShell
        browserSessionId="browser_session_1"
        platform="web"
        state={state}
        onCommand={vi.fn()}
        testID="browser-shell"
      />,
    );
    expect(without.findByTestId('browser-shell-machine')).toBeNull();
  });

  it('uses live local preview state and viewer Home admission for browser views without a current URL', async () => {
    const home = await upsertServerProfile({
      serverUrl: 'https://shell-viewer-home.example.test',
    });
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
      return Response.json({ error: 'preview_access_denied' }, { status: 403 });
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
    testState.useLocalServicePreviewState.mockReturnValue(livePreviewState);
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

    expect(testState.useLocalServicePreviewState).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine_1',
        enabled: true,
      }),
    );
    await flushHookEffects({ cycles: 40 });
    expect(findBrowserIframe(screen).props.src).toBe(viewerUrl);
  });

  it('mounts the browser launchpad when no browser view is focused', async () => {
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
    testState.machineRpc.mockResolvedValue({
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
    } satisfies DaemonLocalServicePreviewOpenOrCreateResponseV1);
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
        launchpadRefreshStatus="idle"
        onOpenTarget={onOpenTarget}
        testID="browser-shell"
      />,
    );

    expect(screen.findByTestId('browser-shell-launchpad')).toBeTruthy();

    await screen.pressByTestIdAsync(
      'browser-shell-launchpad-card:localService:launcher_preview',
    );

    expect(onOpenTarget).toHaveBeenCalledWith(target, {
      platform: 'ios',
      currentUrl: 'https://preview.happier.test/app/?previewToken=renewed',
    });
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
      vi.fn<(reason: BrowserContextUnavailableReason) => void>();

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

    // Diagnostics render inside the bottom drawer, which opens closed (the page leads); once
    // opened, the host-owned fidelity/trust badge stays on the active section.
    expect(
      screen.findByTestId('browser-shell-diagnostics-container-closed'),
    ).toBeTruthy();
    await screen.pressByTestIdAsync('browser-shell-diagnostics-open');
    expect(screen.findByTestId('browser-shell-diagnostics-body')).toBeTruthy();
    expect(
      screen.findByTestId(
        'browser-shell-diagnostics-body-fidelity-nativeCallback',
      ),
    ).toBeTruthy();

    // The drawer shows one family at a time; select the pageInfo section to
    // reveal its family panel + event row.
    await screen.pressByTestIdAsync('browser-shell-diagnostics-tab:pageInfo');
    expect(
      screen.findByTestId('browser-shell-diagnostics-body-family-pageInfo'),
    ).toBeTruthy();
    expect(
      screen.findByTestId(
        'browser-shell-diagnostics-body-pageInfo-row-evt_page_1',
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
    await captureUnavailable.pressByTestIdAsync('browser-shell-overflow');
    const captureStartButton = captureUnavailable.findHostByTestId(
      'browser-shell-overflow-item-start-recording',
    );
    expect(captureStartButton?.props.accessibilityState).toMatchObject({
      disabled: true,
    });

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
      expect(screen.findByTestId('browser-shell-diagnostics-container-closed')).toBeTruthy();

      await screen.pressByTestIdAsync('browser-shell-diagnostics-open');
      await flushHookEffects();
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(1);
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 'machine_1', serverId: 'server_1' }),
      );
      const firstSignal = testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mock.calls[0][0].signal;
      // This event predates opening: the daemon's existing ring supplies history on demand.
      expect(screen.findByTestId('browser-shell-diagnostics-body-fidelity-cdp')).toBeTruthy();
      expect(screen.findByTestId('browser-shell-diagnostics-body-console-row-evt_daemon_console_1')).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(2);
      await screen.pressByTestIdAsync('browser-shell-diagnostics-close');
      expect(firstSignal.aborted).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(2);

      testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue({
        ok: true,
        snapshot: createDaemonDiagnosticsSnapshot([createDaemonDiagnosticsEvent({ eventId: 'evt_while_closed' })]),
      });
      await screen.pressByTestIdAsync('browser-shell-diagnostics-open');
      await flushHookEffects();
      expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledTimes(3);
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

  it('keeps Attach page and a disabled Mark up in the chrome row at a 390px mobile width', async () => {
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

    // At phone width both stay in the chrome row: Attach page folds to its glyph, Mark up keeps
    // its disabled state and says why.
    expect(screen.findByTestId('browser-shell-attach-page')).toBeTruthy();
    const markUp = screen.findByTestId('browser-shell-mark-up');
    expect(markUp?.props.accessibilityState).toMatchObject({ disabled: true });
    expect(markUp?.props.accessibilityHint).toBeTruthy();

    await screen.pressByTestIdAsync('browser-shell-mark-up');
    expect(onContextStateChange).not.toHaveBeenCalled();
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
          annotationRuntimeActionExecute: execute, onStateChange: next => {
            contextState = next; publish(next); if (next.attachmentOrder.length === 1) attached.resolve();
          } }} />;
    }
    const screen = await renderScreen(<Harness />);
    try {
      await screen.pressByTestIdAsync('browser-shell-mark-up');
      expect(captureScreenshot).not.toHaveBeenCalled();
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
});

import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { snapshotReadBoundaryFixture } from '../context/cdp/snapshotMasking.testkit';
import type {
  BrowserCommandV1,
  BrowserEventV1,
  RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserDaemonControlRoutes } from '../control/routes';
import type { BrowserContextRoutes } from '../context/routes';
import type { BrowserAutomationRoutes } from '../automation/routes';
import type { BrowserDaemonFeatureGate, BrowserDaemonFeatureGateId } from '../featureGate';
import { createBrowserAutomationRoutes } from '../automation/routes';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createBrowserDiagnosticsDaemonStore, type BrowserDiagnosticsDaemonStore } from '../diagnostics/store';
import { createBrowserContextRoutes } from '../context/routes';
import { createCdpBrowserContextSource } from '../context/cdp/source';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '../../../../../../packages/tests/src/testkit/actionExecutorBoundary';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createDaemonControlApp } from '../../controlServer';
import { ActionIdSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DaemonBrowserViewListResponseV1Schema } from '@happier-dev/protocol/browser/control/v1';

type BrowserDaemonRuntimeActionExecutorModule = Readonly<{
  createBrowserDaemonRuntimeActionExecutor?: (input: Readonly<{
    control?: Readonly<{
      dispatchCommand?: (command: BrowserCommandV1) => Promise<unknown> | unknown;
    }>;
    context?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    automation?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    diagnostics?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    recording?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    recordingAttach?: (input: Readonly<{ recordingId: string; sessionId?: string }>) => Promise<unknown> | unknown;
    featureGate: BrowserDaemonFeatureGate;
  }>) => (args: RuntimeActionExecuteArgs) => Promise<unknown>;
}>;

function runtimeArgs(
  args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
  return {
    context: {},
    ...args,
  };
}

it('refuses capture of another Session browser at the daemon Action boundary', async () => {
  const execute = createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });
  expect(await execute(runtimeArgs({ actionId: 'browser.context.captureScreenshot',
    context: { defaultSessionId: 'owning_session' },
    input: { browserSessionId: 'another_session', viewId: 'view', navigationGeneration: 0, contextId: 'capture' },
  }))).toMatchObject({ ok: false, errorCode: 'permission_denied' });
});

async function loadRuntimeActionExecutor(): Promise<BrowserDaemonRuntimeActionExecutorModule | null> {
  const path = './runtimeActionExecutor';
  return import(path) as Promise<BrowserDaemonRuntimeActionExecutorModule | null>;
}

const recordingStartInput = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  profileId: 'profile_1',
  targetKind: 'simulatorPreview',
  adapterKind: 'simulatorPreview',
  renderEngineKind: 'streamedSurface',
  captureKind: 'streamFrameCapture',
  fidelity: 'streamFrame',
  navigationGeneration: 1,
  mimeType: 'video/webm',
  retentionClass: 'preSend',
  captureSource: {
    kind: 'machineLiveStream',
    streamFamily: 'simulator.preview',
    sourceId: 'source_1',
  },
} as const;

const browserAutomationView = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
} as const;

const browserAutomationAgentRef = { kind: 'agent', id: 'agent_1' } as const;

const allBrowserGateIds: readonly BrowserDaemonFeatureGateId[] = [
  'browser.sidecar',
  'browser.context',
  'browser.diagnostics',
  'browser.recording',
  'browser.recording.attachments',
  'attachments.uploads',
  'browser.automation',
];
const allBrowserGateIdSet: ReadonlySet<BrowserDaemonFeatureGateId> = new Set(allBrowserGateIds);

function allowAllBrowserGate(): BrowserDaemonFeatureGate {
  return {
    isEnabled: (id) => allBrowserGateIdSet.has(id),
    refresh: async () => {},
  };
}

function gateWith(enabled: Partial<Record<BrowserDaemonFeatureGateId, boolean>>): BrowserDaemonFeatureGate {
  return {
    isEnabled: (id) => enabled[id] === true,
    refresh: async () => {},
  };
}

function emptyDiagnosticsSnapshot() {
  return { v: 1 as const, machineId: 'm', generatedAt: 0, refreshState: 'idle' as const, events: [], diagnostics: [] };
}

function createDiagnosticsStoreStub(
  overrides: Partial<Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>> = {},
) {
  const getSnapshot = () => emptyDiagnosticsSnapshot();
  return {
    getSnapshot,
    getViewSnapshot: getSnapshot,
    clearView: vi.fn(),
    clearSession: vi.fn(),
    ...overrides,
  } satisfies Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>;
}

function automationRequest(actionKind: string, payload: Record<string, unknown> = {}) {
  return {
    v: 1,
    automationRequestId: `req_${actionKind}`,
    ...browserAutomationView,
    navigationGeneration: 3,
    requestedBy: 'agent',
    requesterRef: browserAutomationAgentRef,
    actionKind,
    payload,
    timeoutMs: 5_000,
  };
}

it.each([
  { actionKind: 'type', changed: false }, { actionKind: 'type', changed: true },
  { actionKind: 'click', changed: false }, { actionKind: 'click', changed: true },
] as const)('binds approved $actionKind to the listed page after navigation (changed while pending: $changed)', async ({ actionKind, changed }) => {
  const path = await createRealAutomationPath('Submit');
  try {
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(path.control);
    const records = new Map<string, ApprovalRequest>();
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      runtimeActionExecute: createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate(),
        automation: createBrowserAutomationRoutes({ service: path.service }),
        control: createBrowserDaemonControlRoutes({ broker, automation: () => path.service }) }),
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionKind === 'type' ? 'browser.automation.type' : 'browser.automation.click']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { records.set('approval', request); return { artifactId: 'approval' }; },
      approvalsGet: async ({ artifactId }) => records.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => { records.set(artifactId, request); return { ok: true }; },
    }));
    const context = { surface: 'agent', authority: 'account_automation', serverId: 'home',
      defaultSessionId: browserAutomationView.browserSessionId, defaultSessionMachineId: 'machine',
      actionRequestId: 'navigation-type', actionCaller: { kind: 'host' } } as const;
    expect(await executor.execute('browser.automation.navigate', {
      ...automationRequest('navigate', { url: 'https://example.test/second' }), navigationGeneration: path.navigationGeneration,
    }, { ...context, bypassApprovals: true })).toMatchObject({ ok: true, result: { status: 'succeeded' } });
    path.notify({ method: 'Page.frameNavigated', sessionId: 'session_1',
      params: { frame: { id: 'frame', loaderId: 'second', url: 'https://example.test/second' } } });
    const listed = await executor.execute('browser.view.list', { browserSessionId: browserAutomationView.browserSessionId }, context);
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    const observed = DaemonBrowserViewListResponseV1Schema.parse(listed.result).views[0]!.events
      .filter(event => event.kind === 'navigationStateChanged').at(-1);
    expect(observed).toMatchObject({ navigationGeneration: 1 });
    expect(await executor.execute(actionKind === 'type' ? 'browser.automation.type' : 'browser.automation.click', {
      ...automationRequest(actionKind, { selector: '#submit', ...(actionKind === 'type' ? { text: 'agent65' } : {}) }), navigationGeneration: observed?.navigationGeneration,
    }, context)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    if (changed) path.notify({ method: 'Page.navigatedWithinDocument', sessionId: 'session_1',
      params: { frameId: 'frame', url: 'https://example.test/second#changed' } });
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user' });
    expect(records.get('approval'), JSON.stringify(records.get('approval'))).toMatchObject({ status: changed ? 'failed' : 'executed', execution: changed
      ? { ok: false, errorCode: 'stale_navigation' } : { ok: true } });
    expect(path.calls.filter(call => actionKind === 'type' ? call.method === 'Input.insertText'
      : call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed'))
      .toHaveLength(changed ? 0 : 1);
  } finally { path.service.dispose(); path.control.dispose(); }
});

async function createRealAutomationPath(name: string, featureGate: BrowserDaemonFeatureGate = allowAllBrowserGate()) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
  const element = { id: 'submit', nodeType: 1, tagName: 'BUTTON', textContent: name, children: [], parentElement: null,
    getAttribute: () => null, getBoundingClientRect: () => ({ left: 20, top: 14, width: 40, height: 20 }),
    getClientRects: () => [{ left: 20, top: 14, width: 40, height: 20 }], scrollIntoView: () => {}, focus: () => { document.activeElement = element; } };
  const document = { activeElement: null as object | null, body: { innerText: 'Welcome back' }, querySelectorAll: (selector: string) => selector.startsWith('#') && selector !== '#submit' ? [] : [element], querySelector: (selector: string) => selector === '#submit' ? element : null };
  // Chromium's page realm and screenshot persistence are the only mocked system boundaries.
  const boundary = { openPage: async () => ({ targetId: 'target_1', sessionId: 'session_1' }), dispatchBrowserCommand: async () => ({}),
    subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatchPageCommand: async (input: { method: string; params?: Record<string, unknown> }) => {
      calls.push(input);
      const snapshotRead = snapshotReadBoundaryFixture(input);
      if (snapshotRead !== undefined) return snapshotRead;
      if (input.method === 'Runtime.evaluate') {
        const value: unknown = Function('document', 'window', 'CSS', `return ${String(input.params?.expression)};`)(document, { CSS: true }, { escape: String });
        return { result: { type: typeof value, value } };
      }
      if (input.method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'https://example.test/welcome', title: 'Welcome' }] };
      if (input.method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'node_1', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: name } }] };
      if (input.method === 'Page.captureScreenshot') return { data: 'AQID' };
      return {};
    } };
  const control = createBrowserSidecarCdpControlAdapter({ browserSessionId: browserAutomationView.browserSessionId, sidecarId: 'sidecar', transport: boundary });
  await control.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...browserAutomationView, platform: 'web', target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test' } });
  const context = createBrowserContextRoutes({ ownerAccountId: 'owner', resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
    source: createCdpBrowserContextSource({ transport: boundary, resolveView: control.resolvePageHandle,
      screenshotMediaWriter: { write: async () => ({ ok: true, media: { mediaId: 'media_snapshot', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4096 } }) } }) });
  const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter: control, browserContext: context,
    contextCapture: { transport: boundary, resolvePageHandle: control.resolvePageHandle, getNavigationState: control.getNavigationState } }) }) });
  const { createBrowserDaemonRuntimeActionExecutor } = await import('./runtimeActionExecutor');
  return { control, calls, service, notify: (event: Parameters<BrowserSidecarCdpEventSubscriber>[0]) => { for (const listener of listeners) listener(event); },
    navigationGeneration: control.getNavigationState(browserAutomationView)?.navigationGeneration ?? 0,
    execute: createBrowserDaemonRuntimeActionExecutor({ automation: createBrowserAutomationRoutes({ service }), featureGate }) };
}

describe('daemon browser runtime action executor', () => {
  it('allows explicit agent navigation after its snapshot even when the page changes at the public Action entry', async () => {
    const path = await createRealAutomationPath('Submit');
    try {
      const broker = createBrowserDaemonControlBroker();
      broker.registerAdapter(path.control);
      const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate(),
        automation: createBrowserAutomationRoutes({ service: path.service }),
        control: createBrowserDaemonControlRoutes({ broker, automation: () => path.service }) });
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
      const context = { surface: 'mcp', authority: 'account_automation', bypassApprovals: true } as const;
      expect(await executor.execute('browser.view.open', { kind: 'openView', commandId: 'agent-open',
        ...browserAutomationView, platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test' } }, context))
        .toMatchObject({ ok: true, result: { status: 'dispatched' } });
      path.notify({ method: 'Page.frameNavigated', sessionId: 'session_1',
        params: { frame: { id: 'frame', loaderId: 'document', url: 'https://example.test/' } } });
      expect(await executor.execute('browser.automation.snapshot', {
        ...automationRequest('snapshot'), navigationGeneration: path.control.getNavigationState(browserAutomationView)?.navigationGeneration,
      }, context)).toMatchObject({ ok: true, result: { status: 'succeeded' } });
      // A page can change after a successful read (including same-document script navigation).
      // An explicit URL has no locator or coordinates from that observation to invalidate.
      path.notify({ method: 'Page.navigatedWithinDocument', sessionId: 'session_1',
        params: { frameId: 'frame', url: 'https://example.test/#changed' } });
      expect(await executor.execute('browser.navigate', { kind: 'navigate', commandId: 'agent-nav',
        ...browserAutomationView, url: 'https://example.test/next' }, context))
        .toMatchObject({ ok: true, result: { status: 'dispatched' } });
    } finally { path.service.dispose(); path.control.dispose(); }
  });

  it('reads a populated timeline through the public Action executor and MCP tool', async () => {
    const path = await createRealAutomationPath('Submit');
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-token', runtimeActionExecute: path.execute });
    try {
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: async args => {
        const response = await app.inject({ method: 'POST', url: '/browser/runtime-actions/execute',
          headers: { 'x-happier-daemon-token': 'control-token' }, payload: { actionId: args.actionId,
            input: args.input, sessionId: browserAutomationView.browserSessionId, approvalAdmitted: true } });
        expect(response.statusCode).toBe(200);
        return response.json().result;
      } }));
      const context = { surface: 'mcp', authority: 'account_automation', bypassApprovals: true } as const;
      const request = { ...automationRequest('snapshot'), navigationGeneration: path.navigationGeneration };
      expect(await executor.execute('browser.automation.snapshot', request, context)).toMatchObject({ ok: true });
      expect(await executor.execute('browser.automation.click', {
        ...request, automationRequestId: 'stale-click', actionKind: 'click', navigationGeneration: path.navigationGeneration + 1,
      }, context)).toMatchObject({ ok: true, result: { status: 'failed', errorCode: 'stale_navigation' } });
      expect(await executor.execute('browser.automation.timeline.get', {
        ...request, automationRequestId: 'read-timeline', actionKind: 'getActionTimeline',
      }, context)).toMatchObject({ ok: true, result: { entries: [
        expect.objectContaining({ actionKind: 'snapshot' }), expect.objectContaining({ actionKind: 'click', reasonCode: 'stale_navigation' }),
      ] } });
      const { createSessionDaemonAuthorityFixture } = await import('@/mcp/runtime/sessionDaemonAuthority.testkit');
      const daemon = await createSessionDaemonAuthorityFixture({ sessionId: browserAutomationView.browserSessionId,
        execute: operation => executor.execute(ActionIdSchema.parse(operation.actionId), operation.input, context) });
      try {
        const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
        const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
        const mcp = createHappierMcpServer({ sessionId: browserAutomationView.browserSessionId,
          rpcHandlerManager: new RpcHandlerManager({ scopePrefix: browserAutomationView.browserSessionId, encryptionMode: 'plain' }),
          updateMetadata: () => undefined,
          getServerBinding: () => ({ serverId: 'browser_home', serverUrl: 'https://browser-home.example.test' }),
          getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
            features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, automation: { enabled: true } } },
          }) }),
          getPermissionMode: () => 'yolo', getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
          getActiveTurnAdmissionWitness: () => ({ turnId: 'browser-turn', inputId: 'browser-input', userMessageSeq: 1, userMessageSeqs: [1] }),
          getActiveTurnPermissionWitness: () => ({ turnId: 'browser-turn', workDepth: 0, causalPermissionAuthority: {
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo',
          } }),
        }, { authorityScope: 'session', sessionCredentials: { token: 'session-fixture', encryption: null } });
        try {
          const result = await mcp.executeTool({ toolName: 'action_execute', args: { actionId: 'browser.automation.timeline.get',
            input: { ...request, automationRequestId: 'mcp-timeline', actionKind: 'getActionTimeline' } } });
          expect(result, JSON.stringify(result))
            .toMatchObject({ ok: true, result: { entries: [
              expect.objectContaining({ actionKind: 'snapshot' }), expect.objectContaining({ actionKind: 'click', reasonCode: 'stale_navigation' }),
            ] } });
        } finally { await mcp.mcp.close(); }
      } finally { await daemon.close(); }
    } finally {
      path.service.dispose();
      path.control.dispose();
      await app.close();
    }
  });

  it('sets an existing sidecar target through the public Action and retains its native page', async () => {
    const path = await createRealAutomationPath('Submit');
    try {
      const broker = createBrowserDaemonControlBroker();
      broker.registerAdapter(path.control);
      const execute = createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate(),
        control: createBrowserDaemonControlRoutes({ broker, automation: () => path.service }) });
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: execute }));
      const target = { kind: 'externalUrl', targetId: 'changed', url: 'https://example.test/changed' } as const;
      const before = path.control.resolvePageHandle(browserAutomationView);
      const events: BrowserEventV1[] = [];
      path.control.subscribeBrowserEvents(event => events.push(event));
      expect(await executor.execute('browser.target.set', { kind: 'setTarget', commandId: 'set-target',
        ...browserAutomationView, target }, { surface: 'mcp', authority: 'account_automation', bypassApprovals: true }))
        .toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(path.calls).toContainEqual(expect.objectContaining({ method: 'Page.navigate', params: { url: target.url } }));
      expect(path.control.resolvePageHandle(browserAutomationView)).toEqual(before);
      expect(path.control.listViews?.(browserAutomationView.browserSessionId)[0]?.events)
        .toContainEqual(expect.objectContaining({ kind: 'viewOpened', target }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'targetChanged', target }));
      await path.service.getInputControl(browserAutomationView).beginConfidentialityHold();
      expect(await executor.execute('browser.target.set', { kind: 'setTarget', commandId: 'held-target',
        ...browserAutomationView, target }, { surface: 'mcp', authority: 'account_automation', bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'permission_denied' });
      expect(path.calls.filter(call => call.method === 'Page.navigate')).toHaveLength(1);
    } finally {
      path.service.dispose();
      path.control.dispose();
    }
  });

  it('fails closed before daemon dispatch when a browser Action id carries another command kind', async () => {
    const mod = await loadRuntimeActionExecutor();

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const dispatchCommand = vi.fn(async () => ({
      v: 1,
      accepted: true,
      commandId: 'command_mismatched',
    }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      control: { dispatchCommand },
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.view.focus',
      input: {
        kind: 'navigate',
        commandId: 'command_mismatched',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/escaped-navigation',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('fails closed instead of no-oping browser control when no command route is available', async () => {
    const mod = await loadRuntimeActionExecutor();

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_missing_route',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
      details: { cause: 'browser_control_route_unavailable', phase: 'browser.control.route_resolution', retryable: false },
      failureCause: { phase: 'browser.control.route_resolution', errorClass: 'Error', errorCode: null, httpStatus: null },
    });
  });

  it('routes browser.context.capturePage to the context route when available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const dispatch = vi.fn(async () => ({ v: 1, kind: 'browserPageReference', contextId: 'context_1' }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      context: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const input = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 2 };
    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input,
    }))).resolves.toEqual({ v: 1, kind: 'browserPageReference', contextId: 'context_1' });
    expect(dispatch).toHaveBeenCalledWith('browser.context.capturePage', input);
  });

  it('returns rich snapshot selectors through the real browser automation action path', async () => {
    const path = await createRealAutomationPath('Submit');

    const result = await path.execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: { ...automationRequest('snapshot'), navigationGeneration: path.navigationGeneration },
      context: { authority: 'present_user', actionCaller: { kind: 'host' } },
    }));

    expect(result).toMatchObject({
      v: 1,
      status: 'succeeded',
      resultSummary: {
        visibleText: 'Welcome back',
        axNodes: [{ role: 'button', name: 'Submit' }],
        interactiveElements: [
          { role: 'button', name: 'Submit', selector: '#submit' },
        ],
        media: { mediaId: 'media_snapshot' },
      },
    });
    expect(path.service.getTimeline(browserAutomationView).entries)
      .toMatchObject([{ actionKind: 'snapshot', requesterKind: 'user', status: 'succeeded' }]);
    path.service.dispose();
    path.control.dispose();
  });

  it('resolves semantic locators through the real automation input action path', async () => {
    const path = await createRealAutomationPath('Save');
    // Input requires a fresh observation from the actual current navigation owner.
    expect(await path.execute(runtimeArgs({ actionId: 'browser.automation.snapshot', input: { ...automationRequest('snapshot'), navigationGeneration: path.navigationGeneration } }))).toMatchObject({ status: 'succeeded' });

    const result = await path.execute(runtimeArgs({
      actionId: 'browser.automation.click',
      input: { ...automationRequest('click', { selector: 'role=button[name="Save"]' }), navigationGeneration: path.navigationGeneration },
    }));

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded' });
    const pressed = path.calls.find((call) => (
      call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed'
    ));
    expect(pressed?.params).toMatchObject({ x: 40, y: 24, button: 'left' });
    path.control.dispose();
  });

  it('fails closed for browser.context actions when no context route is available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_context_route_unavailable',
    });
  });

  it('fails closed for browser.automation actions when no automation route is available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: automationRequest('snapshot'),
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
    });
  });

  /**
   * Managed-Chromium provisioning is triggered by an agent ASKING for automation, never at daemon
   * startup. A ~150MB third-party download is legible as the consequence of a browser action and is
   * not legible as a silent cost on every daemon, including machines that never touch the browser.
   *
   * These four cases pin that placement. If provisioning is moved back to daemon startup, or
   * dropped, the provisioner is never invoked from dispatch and the first one goes RED.
   */
  it('provisions the managed browser runtime on the first browser.automation dispatch', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const provisionAutomationRuntime = vi.fn(async () => 'unavailable' as const);

    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      provisionAutomationRuntime,
    });

    // No automation route: on an unprovisioned host the sidecar adapter fails closed with
    // `managed_package_missing`, so nothing is registered and this is the ONLY seam an agent reaches.
    await expect(execute(runtimeArgs({
      actionId: 'browser.automation.click',
      input: automationRequest('click', { selector: '#go' }),
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
    });

    expect(provisionAutomationRuntime).toHaveBeenCalledOnce();
  });

  it('reports a provisioning failure distinguishably from an absent runtime', async () => {
    const realMod = await import('./runtimeActionExecutor');

    const failed = realMod.createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      provisionAutomationRuntime: async () => 'failed' as const,
    });
    await expect(failed(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: automationRequest('snapshot'),
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'browser_runtime_provisioning_failed',
      error: expect.stringMatching(/connection|disk/i),
    });

    // `unavailable` means nothing CAN be provisioned here (unsupported platform, unpinned asset).
    // That keeps the pre-existing honest answer rather than inventing a new one.
    const unavailable = realMod.createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      provisionAutomationRuntime: async () => 'unavailable' as const,
    });
    await expect(unavailable(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: automationRequest('snapshot'),
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
    });
  });

  it('never provisions when an automation route already exists', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const provisionAutomationRuntime = vi.fn(async () => 'unavailable' as const);
    const dispatch = vi.fn(async () => ({ v: 1, status: 'succeeded' }));

    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      automation: { dispatch } as unknown as BrowserAutomationRoutes,
      provisionAutomationRuntime,
    });

    await execute(runtimeArgs({
      actionId: 'browser.automation.status',
      input: automationRequest('getStatus'),
    }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(provisionAutomationRuntime).not.toHaveBeenCalled();
  });

  it('provisions from browser.view.open but rejects malformed open commands before acquisition', async () => {
    const { createBrowserDaemonRuntimeActionExecutor } = await import('./runtimeActionExecutor');
    const execute = createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      provisionAutomationRuntime: async () => 'unavailable',
    });
    const input = {
      commandId: 'open-session-view',
      browserSessionId: 'real-session',
      viewId: 'first-view',
      kind: 'openView',
      platform: 'desktop',
      target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test/' },
    };
    await expect(execute(runtimeArgs({ actionId: 'browser.view.open', input }))).resolves.toMatchObject({
      ok: false,
      error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
    });
    await expect(execute(runtimeArgs({ actionId: 'browser.view.open', input: { ...input, target: null } })))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('never provisions from a browser context capture', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const provisionAutomationRuntime = vi.fn(async () => 'unavailable' as const);

    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      featureGate: allowAllBrowserGate(),
      provisionAutomationRuntime,
    });

    // A context or control action must not trigger a 150MB download.
    await execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }));

    expect(provisionAutomationRuntime).not.toHaveBeenCalled();
  });

  it('dispatches browser.recording.attachToComposer to the recording-attach executor', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async (input: Readonly<{ recordingId: string; sessionId?: string }>) => ({
      ok: true as const,
      attachmentId: `attachment_${input.recordingId}`,
    }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1', sessionId: 'session_1' },
    }))).resolves.toEqual({ ok: true, attachmentId: 'attachment_browser_recording_1' });
    expect(recordingAttach).toHaveBeenCalledWith({ recordingId: 'browser_recording_1', sessionId: 'session_1' });
  });

  it('fails closed for browser.recording.attachToComposer when no attach executor is available', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
  });

  // OWNER-GATE action-execution chokepoint. The gate refuses each dispatchable family on
  // server-disable even when the route owner is present.
  it('refuses browser automation actions when browser.automation is server-disabled', async () => {
    const path = await createRealAutomationPath('Submit', gateWith({ 'browser.automation': false }));
    const callsBefore = [...path.calls];
    try {
      await expect(path.execute(runtimeArgs({
        actionId: 'browser.automation.snapshot',
        input: { ...automationRequest('snapshot'), navigationGeneration: path.navigationGeneration },
      }))).resolves.toEqual({
        ok: false,
        errorCode: 'runtime_action_disabled',
        error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
      });
      expect(path.calls).toEqual(callsBefore);
      expect(path.service.getTimeline(browserAutomationView).entries).toEqual([]);
    } finally {
      path.service.dispose();
      path.control.dispose();
    }
  });

  it('refuses browser context actions when browser.context is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn<BrowserContextRoutes['dispatch']>();
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      context: { dispatch },
      featureGate: gateWith({ 'browser.context': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_context_route_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses browser control actions when browser.sidecar is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatchCommand = vi.fn<BrowserDaemonControlRoutes['dispatchCommand']>();
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker: { dispatchCommand, listViews: () => [] } }),
      featureGate: gateWith({ 'browser.sidecar': false, 'browser.automation': true }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_sidecar_disabled',
      details: { cause: 'browser_sidecar_disabled', phase: 'browser.control.feature_decision', retryable: false },
      failureCause: { phase: 'browser.control.feature_decision', errorClass: 'Error', errorCode: null, httpStatus: null },
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('refuses browser.recording.attachToComposer when browser.recording is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: gateWith({ 'browser.recording': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
    expect(recordingAttach).not.toHaveBeenCalled();
  });

  it('refuses browser.recording.attachToComposer when browser.recording.attachments is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: gateWith({
        'browser.recording': true,
        'browser.context': true,
        'attachments.uploads': true,
        'browser.recording.attachments': false,
      }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_attachments_unavailable',
    });
    expect(recordingAttach).not.toHaveBeenCalled();
  });

  it('still dispatches each family when the gate is enabled and a route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatchCommand = vi.fn<BrowserDaemonControlRoutes['dispatchCommand']>();
    const contextDispatch = vi.fn<BrowserContextRoutes['dispatch']>();
    const automationDispatch = vi.fn<BrowserAutomationRoutes['dispatch']>();
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'attachment_x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker: { dispatchCommand, listViews: () => [] } }),
      context: { dispatch: contextDispatch },
      automation: { dispatch: automationDispatch, prepareConfidentialFill: async () => { throw new Error('Unexpected confidential fill'); } },
      recordingAttach,
      featureGate: gateWith({
        'browser.sidecar': true,
        'browser.context': true,
        'browser.automation': true,
        'browser.recording': true,
        'browser.recording.attachments': true,
      }),
    });

    await execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }));
    await execute(runtimeArgs({ actionId: 'browser.context.capturePage', input: { browserSessionId: 'browser_session_1', viewId: 'view_1' } }));
    await execute(runtimeArgs({ actionId: 'browser.automation.snapshot', input: automationRequest('snapshot') }));
    await execute(runtimeArgs({ actionId: 'browser.recording.attachToComposer', input: { recordingId: 'browser_recording_1' } }));

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(contextDispatch).toHaveBeenCalledOnce();
    expect(automationDispatch).toHaveBeenCalledOnce();
    expect(recordingAttach).toHaveBeenCalledOnce();
  });

  // DEV-5: the diagnostics family executor. The route-contract gate is that a dispatched
  // `browser.diagnostics.snapshot` REACHES the route end-to-end (not `*_route_unavailable`).
  it('DEV-5 route contract: browser.diagnostics.snapshot reaches the diagnostics route, not *_route_unavailable', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const storeMod = await import('../diagnostics/store');

    const store = storeMod.createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 1000 });
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const result = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }));

    // The contract: the snapshot reaches the store-backed route and returns a real snapshot
    // envelope — NOT the `browser_diagnostics_route_unavailable` hard failure.
    expect(result).not.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(result).toMatchObject({ v: 1, machineId: 'machine_1', events: [] });
  });

  it('DEV-5: browser.diagnostics.clear routes to the store clearView', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const clearView = vi.fn();
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub({ clearView }),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.clear',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({ ok: true });
    expect(clearView).toHaveBeenCalledWith({ browserSessionId: 'browser_session_1', viewId: 'view_1' });
  });

  it('DEV-5: interaction verbs reach the live interaction transport when present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const interactionDispatch = vi.fn(async () => ({ ok: true as const, kind: 'paused' }));
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
      interaction: { dispatch: interactionDispatch, dispose: vi.fn() },
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await execute(runtimeArgs({
      actionId: 'browser.diagnostics.pause',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }));
    expect(interactionDispatch).toHaveBeenCalledOnce();
  });

  it('DEV-5: interaction verbs fail closed when no live transport is wired', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1,
        evalRequestId: 'eval_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'injectedPage',
        expression: 'document.title',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
  });

  // DIAG-INTERACTION (H1 execution-crossing DONE gate): the interaction verbs reach a LIVE CDP result
  // through the production-assembled route owner — the REAL interaction transport bound to a
  // TEST-DOUBLE sidecar CDP transport — not a fake interaction dispatch. Without the transport the
  // same assembled owner fails closed honestly.
  const PICKER_HANDLE = { targetId: 'target_1', sessionId: 'cdp_session_1' } as const;

  const buildLiveInteraction = async () => {
    const interactionMod = await import('../diagnostics/interactionTransport');
    const lifecycle = {
      current: null as ((event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void) | null,
    };
    let cdpListener: ((notification: { method: string; params?: Record<string, unknown>; sessionId?: string }) => void) | null = null;
    const dispatchPageCommand = vi.fn(async ({ method, params }: { method: string; params?: Record<string, unknown> }) => {
      if (method === 'Overlay.setInspectMode' && params?.mode === 'searchForNode') {
        cdpListener?.({ method: 'Overlay.inspectNodeRequested', params: { backendNodeId: 7 }, sessionId: 'cdp_session_1' });
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'live', description: 'live' } };
      if (method === 'Runtime.getProperties') {
        return { result: [{ name: 'len', value: { type: 'number', value: 3 }, enumerable: true }] };
      }
      return {};
    });
    const interaction = interactionMod.createBrowserDiagnosticsInteractionTransport({
      contextCapture: {
        transport: { dispatchPageCommand },
        resolvePageHandle: (view) =>
          view.viewId === 'view_1' && view.browserSessionId === 'browser_session_1' ? PICKER_HANDLE : null,
        subscribeViewLifecycle: (listener) => {
          lifecycle.current = listener;
          return () => undefined;
        },
        subscribeCdpEvents: (listener) => {
          cdpListener = listener;
          return () => undefined;
        },
      },
    });
    // The control adapter emits this binding when the sidecar opens the page.
    lifecycle.current?.({ type: 'bound', browserSessionId: 'browser_session_1', viewId: 'view_1' });
    return interaction;
  };

  const createDiagnosticsStore = () => createBrowserDiagnosticsDaemonStore({ machineId: 'm', now: () => 0 });

  it('DIAG-INTERACTION (H1): eval/getProperties/elementPicker reach a LIVE CDP result through the assembled route owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const interaction = await buildLiveInteraction();
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store: createDiagnosticsStore(), interaction });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const evalResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1,
        evalRequestId: 'eval_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        browserSessionId: 'browser_session_1',
        expression: 'location.href',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(evalResult).toMatchObject({ status: 'completed', result: { type: 'string', value: 'live' } });

    const propertiesResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.getProperties',
      input: {
        v: 1,
        propertyRequestId: 'prop_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        objectId: 'object_1',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(propertiesResult).toMatchObject({ status: 'completed', objectId: 'object_1', properties: [{ name: 'len' }] });

    const pickerResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.elementPicker.start',
      input: {
        v: 1,
        pickerRequestId: 'picker_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        action: 'start',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(pickerResult).toMatchObject({ status: 'selected', backendNodeRef: '7' });
  });

  it('DIAG-INTERACTION (H1): eval/getProperties/elementPicker fail closed when no interaction transport is bound', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store: createDiagnosticsStore() });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const unavailable = {
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    };
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1, evalRequestId: 'eval_1', browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        expression: 'location.href', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.getProperties',
      input: {
        v: 1, propertyRequestId: 'prop_1', browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        objectId: 'object_1', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.elementPicker.start',
      input: {
        v: 1, pickerRequestId: 'picker_1', browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        action: 'start', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
  });

  it('DEV-5: fails closed for browser.diagnostics when no diagnostics route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
  });

  it('DEV-5: refuses browser.diagnostics when browser.diagnostics is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
    });
    // Wrap dispatch so we can assert it is never reached when gated off.
    const gatedDiagnostics = { dispatch };
    void diagnostics;
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics: gatedDiagnostics,
      featureGate: gateWith({ 'browser.diagnostics': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // BA-5: the non-attach recording lifecycle reaches the service-backed recording route owner.
  it('BA-5: browser.recording.start routes to the recording action route owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn(async () => ({ status: 'started' as const, recording: { recordingId: 'browser_recording_1' } }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const input = recordingStartInput;
    const args = runtimeArgs({ actionId: 'browser.recording.start', input });
    await expect(execute(args))
      .resolves.toEqual({ status: 'started', recording: { recordingId: 'browser_recording_1' } });
  });

  it('BA-5: browser.recording.stop/cancel/status/listForView/discard/cleanupExpired all route to the owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' };
    for (const [actionId, input] of [
      ['browser.recording.stop', { recordingId: 'browser_recording_1', navigationGenerationEnd: 0 }],
      ['browser.recording.cancel', { recordingId: 'browser_recording_1', reason: 'user_canceled' }],
      ['browser.recording.status', { recordingId: 'browser_recording_1' }],
      ['browser.recording.listForView', view],
      ['browser.recording.discard', { recordingId: 'browser_recording_1', reason: 'user_discarded' }],
      ['browser.recording.cleanupExpired', {}],
    ] as const) {
      await execute(runtimeArgs({ actionId, input }));
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
  });

  it('BA-5: browser.recording.start fails closed when no recording route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach: vi.fn(async () => ({ ok: true as const, attachmentId: 'x' })),
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.start',
      input: recordingStartInput,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
  });

  it('BA-5: attachToComposer still routes to the dedicated attach executor (not the lifecycle owner)', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingDispatch = vi.fn(async () => ({ ok: true as const }));
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'attachment_1' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch: recordingDispatch },
      recordingAttach,
      featureGate: allowAllBrowserGate(),
    });

    await execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }));
    expect(recordingAttach).toHaveBeenCalledOnce();
    expect(recordingDispatch).not.toHaveBeenCalled();
  });
});

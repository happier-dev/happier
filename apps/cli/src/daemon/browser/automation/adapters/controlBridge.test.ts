import { access, readFile } from 'node:fs/promises';
import type { BrowserAutomationActionRequestV1, BrowserCommandV1 } from '@happier-dev/protocol';
import type { BrowserAutomationSecretFillRequestV1 } from '@happier-dev/protocol/browser/automation/v1';
import { BrowserAutomationActionResultV1Schema, BrowserAutomationJavaScriptDialogSummaryV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserDaemonControlAdapter } from '../../control/types';
import type {
  BrowserSidecarCdpPageHandle,
  BrowserSidecarCdpEventSubscriber,
  BrowserSidecarContextCaptureSurface,
} from '../../sidecar/controlAdapter';
import { createControlAdapterAutomationTransport } from './controlBridge';
import { createBrowserAutomationCdpAdapter } from './cdp';
import { createBrowserAutomationDaemonService } from '../service';
import { createBrowserAutomationRoutes } from '../routes';
import { createBrowserSidecarCdpControlAdapter } from '../../sidecar/controlAdapter';
import { createBrowserDaemonControlBroker } from '../../control/broker';
import { createBrowserDaemonControlRoutes } from '../../control/routes';
import { BrowserSidecarCdpTransportError, createBrowserSidecarCdpTransport } from '../../sidecar/cdpTransport';
import type { LoopbackWebSocketJsonClientV1 } from '@/plugins/runtime/exec/privateContract';
import { createBrowserContextRoutes } from '../../context/routes';
import { createCdpBrowserContextSource } from '../../context/cdp/source';
import { createSnapshotMaskingFixture, createSnapshotCaptureTestRoutes as contextRoutes } from '../../context/cdp/snapshotMasking.testkit';
import { browserContextSensitiveFieldsExpression } from '@happier-dev/protocol/browser/context/privacy';
import { BrowserContextSnapshotV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { createSurfaceInputControl } from '../../../surfaces/inputControl';
import { dispatchRuntimeAction } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createBrowserDaemonRuntimeActionExecutor } from '../../actions/runtimeActionExecutor';

function controlAdapter(overrides: Partial<BrowserDaemonControlAdapter> = {}): BrowserDaemonControlAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    ownsView: vi.fn(() => true),
    supportsOpenView: vi.fn(() => false),
    dispatchCommand: vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    })),
    ...overrides,
  };
}

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const HANDLE: BrowserSidecarCdpPageHandle = { targetId: 'target_1', sessionId: 'cdp_1' };

// Only the websocket/CDP peer is substituted. Controller, page binding, input adapter and
// settlement remain the production path, including known pre-send boundary failures.
async function inputSettlementBoundary(
  evaluatePage?: (expression: string) => unknown,
  applyInput?: (method: string, params?: Record<string, unknown>) => void,
  dialogs: readonly Readonly<{ type: string; message: string }>[] = [],
) {
  const listeners = new Set<(message: unknown) => void | Promise<void>>();
  let closePeer: () => void = () => undefined;
  const state = { loseAck: false, loseDialogAck: false, holdDialogAck: false, disposedBeforeInput: false, failedRead: false, dialogOnRead: false, dialogRaised: false };
  const effects: string[] = [];
  const dialogResponses: Record<string, unknown>[] = [];
  const client: LoopbackWebSocketJsonClientV1 = {
    closed: new Promise<void>(resolve => { closePeer = resolve; }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async sendJson(message) {
      const command = message as { id: number; method: string; params?: Record<string, unknown> };
      const mutatingExpression = command.method === 'Runtime.evaluate' && String(command.params?.expression).includes('el.value');
      if (command.method === 'Page.handleJavaScriptDialog') dialogResponses.push(command.params ?? {});
      if (command.method.startsWith('Input.') || command.method === 'Page.navigate'
        || command.method === 'Page.handleJavaScriptDialog' || mutatingExpression) {
        effects.push(command.method);
        if (state.loseAck || command.method === 'Page.handleJavaScriptDialog' && state.loseDialogAck) { closePeer(); return; }
        if (command.method.startsWith('Input.')) applyInput?.(command.method, command.params);
      }
      if (command.method === 'Input.insertText') {
        for (const dialog of dialogs) {
          for (const listener of [...listeners]) await listener({ method: 'Page.javascriptDialogOpening',
            sessionId: HANDLE.sessionId, params: { ...dialog, defaultPrompt: 'unshared default' } });
        }
      }
      if (command.method === 'Page.handleJavaScriptDialog' && state.holdDialogAck) return;
      const result = command.method === 'Target.createTarget' ? { targetId: HANDLE.targetId }
        : command.method === 'Target.attachToTarget' ? { sessionId: HANDLE.sessionId }
        : command.method === 'DOMSnapshot.captureSnapshot' ? createSnapshotMaskingFixture()
        : command.method === 'Runtime.evaluate' ? cdpEvaluateValue(command.params?.expression === browserContextSensitiveFieldsExpression
          ? false : evaluatePage ? evaluatePage(String(command.params?.expression)) : 'safe page') : {};
      if (command.method === 'Runtime.evaluate' && state.failedRead) throw new Error('read unavailable');
      if (command.method === 'Runtime.evaluate' && state.dialogOnRead && !state.dialogRaised) {
        state.dialogRaised = true;
        for (const listener of [...listeners]) await listener({ method: 'Page.javascriptDialogOpening',
          sessionId: HANDLE.sessionId, params: { type: 'alert' } });
      }
      for (const listener of [...listeners]) await listener({ id: command.id, result });
    },
  };
  const transport = createBrowserSidecarCdpTransport({ client });
  const boundaryTransport = {
    ...transport,
    dispatchPageCommand: (command: Parameters<typeof transport.dispatchPageCommand>[0]) => {
      if (state.disposedBeforeInput && (command.method.startsWith('Input.') || command.method === 'Page.navigate'
        || command.method === 'Page.handleJavaScriptDialog')) transport.dispose();
      return transport.dispatchPageCommand(command);
    },
  };
  const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport: boundaryTransport });
  await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web', focus: false,
    target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
  const contextCapture: BrowserSidecarContextCaptureSurface = {
    transport: boundaryTransport,
    resolvePageHandle: adapter.resolvePageHandle,
    getNavigationState: adapter.getNavigationState,
    subscribeCdpEvents: transport.subscribeCdpEvents,
  };
  const bridge = createControlAdapterAutomationTransport({ adapter, contextCapture, browserContext: contextRoutes(contextCapture) });
  const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
  const broker = createBrowserDaemonControlBroker();
  broker.registerAdapter(adapter);
  const routes = createBrowserDaemonControlRoutes({ broker, automation: () => service });
  const execute = (actionKind: BrowserAutomationActionRequestV1['actionKind'], payload: Record<string, unknown> = {}) => service.execute({
    v: 1, ...view, automationRequestId: `request:${actionKind}:${service.getTimeline(view).entries.length}`,
    requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' },
    navigationGeneration: adapter.getNavigationState(view)?.navigationGeneration ?? 0, actionKind, payload, timeoutMs: 10_000,
  });
  return { state, effects, dialogResponses, service, routes, execute, dispose() { service.dispose(); adapter.dispose(); transport.dispose(); } };
}

const confidentialRequest: BrowserAutomationSecretFillRequestV1 = {
  serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in', ...view,
  tabId: HANDLE.targetId, frameId: 'frame', documentId: 'document', navigationGeneration: 3,
  origin: 'https://example.test', field: { fieldId: '41', focusId: '41', locator: '#password' },
};

function confidentialBoundary(nativeObservation?: 'not_observable' | 'unknown') {
  const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
  const state = { generation: 3, documentId: 'document', origin: 'https://example.test', fieldId: 41,
    focused: true, inserted: false, failInsert: false, submitted: false, controlId: 51, stableLocator: '#password', viewOpen: true,
    empty: false, originalConnected: true,
    beforeCommand: (_method: string, _params?: Record<string, unknown>) => {} };
  // The network boundary executes the actual isolated-world function; no internal target proof
  // or fill implementation is mocked. Instance overrides model hostile page-world hooks.
  class NativeElement extends EventTarget {
    get isConnected() { return state.originalConnected; }
    get ownerDocument(): object { return documentValue; }
    getAttribute(name: string) { return name === 'id' ? this.id : null; }
    id = '';
    tagName = 'INPUT';
    textContent = '';
  }
  class NativeHTMLElement extends NativeElement {
    click() { state.submitted = true; }
  }
  class NativeInput extends NativeHTMLElement {
    disabled = false;
    readOnly = false;
    type = 'password';
  }
  class NativeTextarea extends NativeInput {}
  class NativeButton extends NativeHTMLElement { disabled = false; tagName = 'BUTTON'; }
  const field = new NativeInput(); field.id = 'password';
  const control = new NativeButton(); control.id = 'submit';
  const other = new NativeInput(); other.id = 'other';
  const body = new NativeHTMLElement(); body.tagName = 'BODY';
  const documentValue = {
    get activeElement() { return state.focused ? field : body; },
    hasFocus: () => true,
    querySelector: (selector: string) => selector === '#password' || selector === 'input[type="password"]'
      ? field : selector === '#submit' ? control : selector === '#other' ? other : null,
    querySelectorAll: (selector: string) => selector === state.stableLocator ? [field]
      : selector === '#submit' ? [control] : selector === '#other' ? [other] : [],
  };
  Object.defineProperty(field, 'value', { get() { throw new Error('Page value getter must not run'); },
    set() { throw new Error('Page value setter must not run'); } });
  Object.defineProperty(field, 'dispatchEvent', { value: () => { throw new Error('Page dispatch hook must not run'); } });
  Object.defineProperty(control, 'click', { value: () => { throw new Error('Page click hook must not run'); } });
  const nodes: Record<string, NativeElement> = { field, control, other, active: field };
  function executeFunction(params: Record<string, unknown> | undefined): unknown {
    const args = Array.isArray(params?.arguments) ? params.arguments.map(argument => {
      const entry = argument as { objectId?: string; value?: unknown };
      return entry.objectId ? nodes[entry.objectId] : entry.value;
    }) : [];
    return Function('document', 'location', 'Element', 'HTMLElement', 'HTMLInputElement',
      'HTMLTextAreaElement', 'HTMLButtonElement', 'Event', 'EventTarget', 'CSS', 'receiver', 'args',
      `return (${String(params?.functionDeclaration)}).apply(receiver, args);`)(documentValue,
      { get origin() { return state.origin; } }, NativeElement, NativeHTMLElement, NativeInput,
      NativeTextarea, NativeButton, Event, EventTarget, { escape: (value: string) => value }, nodes[String(params?.objectId)], args);
  }
  const { surface, calls } = fakeContextCapture((method, params) => {
    state.beforeCommand(method, params);
    if (method === 'DOMSnapshot.captureSnapshot') return createSnapshotMaskingFixture([{ type: 'password', value: state.empty ? '' : 'fixture-password' }]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: state.documentId, securityOrigin: state.origin } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') {
      if (params?.returnByValue === true) {
        return cdpEvaluateValue(Function('document', `return ${String(params.expression)};`)(documentValue));
      }
      const expression = String(params?.expression);
      const element: unknown = Function('document', `return ${expression};`)(documentValue);
      nodes.active = documentValue.activeElement;
      const objectId = expression === 'document.activeElement' ? 'active'
        : element === field ? 'field' : element === control ? 'control' : element === other ? 'other' : undefined;
      return { result: objectId ? { type: 'object', subtype: 'node', objectId } : { type: 'object', subtype: 'null', value: null } };
    }
    if (method === 'DOM.describeNode') {
      const element = nodes[String(params?.objectId)];
      return { node: { backendNodeId: element === control ? state.controlId : element === field ? state.fieldId : element === other ? 42 : 43,
        nodeName: element?.tagName, nodeType: 1 } };
    }
    if (method === 'Runtime.callFunctionOn') {
      try { return cdpEvaluateValue(executeFunction(params)); }
      catch (error) {
        return { result: { type: 'undefined' }, exceptionDetails: { text: error instanceof Error ? error.message : 'Page exception' } };
      }
    }
    if (method === 'Input.insertText') {
      state.inserted = true;
      if (state.failInsert) throw new Error(String(params?.text));
      return { echoed: params?.text };
    }
    return {};
  });
  const contextCapture: BrowserSidecarContextCaptureSurface = { ...surface,
    subscribeCdpEvents: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resolvePageHandle: () => state.viewOpen ? HANDLE : null,
    getNavigationState: () => ({ navigationGeneration: state.generation, loadingState: 'ready', canGoBack: false, canGoForward: false }) };
  // Malformed source facts are a boundary fixture, not a widening of the production carrier type.
  if (nativeObservation) Object.defineProperty(contextCapture, 'resolveNativeObservation', {
    value: (requestedView: typeof view) => requestedView?.browserSessionId === view.browserSessionId
      && requestedView.viewId === view.viewId && state.viewOpen ? nativeObservation : undefined,
    enumerable: true,
  });
  return { state, calls, contextCapture,
    notify(event: Parameters<BrowserSidecarCdpEventSubscriber>[0]) {
      for (const listener of listeners) listener(event);
    },
    destroyTarget(targetId = HANDLE.targetId) {
      for (const listener of listeners) listener({ method: 'Target.targetDestroyed', params: { targetId } });
    },
    bridge: createControlAdapterAutomationTransport({ adapter: controlAdapter({ ownsView: () => state.viewOpen }), contextCapture }) };
}

type Responder = (method: string, params: Record<string, unknown> | undefined) => unknown;

async function confidentialServiceBoundary() {
  const boundary = confidentialBoundary();
  const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar',
    transport: { ...boundary.contextCapture.transport, openPage: async () => HANDLE,
      dispatchBrowserCommand: async () => ({ success: true }) } });
  await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web', focus: true,
    target: { kind: 'externalUrl', targetId: 'external', url: confidentialRequest.origin } });
  const bridge = createControlAdapterAutomationTransport({ adapter, contextCapture: {
    ...boundary.contextCapture, resolvePageHandle: adapter.resolvePageHandle,
  } });
  const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
  return { state: boundary.state, service, dispose() { service.dispose(); adapter.dispose(); } };
}

function fakeContextCapture(
  responder: Responder,
  resolveHandle: () => BrowserSidecarCdpPageHandle | null = () => HANDLE,
): {
  surface: BrowserSidecarContextCaptureSurface;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    surface: {
      transport: {
        dispatchPageCommand: vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
          calls.push({ method: input.method, ...(input.params ? { params: structuredClone(input.params) } : {}) });
          const result = await responder(input.method, input.params);
          return input.method === 'DOMSnapshot.captureSnapshot' && result && typeof result === 'object'
            && Object.keys(result).length === 0 ? createSnapshotMaskingFixture() : result;
        }),
      },
      resolvePageHandle: resolveHandle,
    },
  };
}

type FakeBridgeElement = Readonly<{
  tagName: string;
  textContent: string;
  children: readonly FakeBridgeElement[];
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Readonly<{ left: number; top: number; width: number; height: number }>;
  scrollIntoView(): void;
  focus(): void;
}>;

function bridgeElement(input: Readonly<{
  tagName: string;
  textContent: string;
  attributes?: Readonly<Record<string, string>>;
  rect: Readonly<{ left: number; top: number; width: number; height: number }>;
  children?: readonly FakeBridgeElement[];
}>): FakeBridgeElement {
  return {
    tagName: input.tagName.toUpperCase(),
    textContent: input.textContent,
    children: input.children ?? [],
    getAttribute(name) {
      return input.attributes?.[name] ?? null;
    },
    getBoundingClientRect() {
      return input.rect;
    },
    scrollIntoView() {
      return undefined;
    },
    focus() {
      return undefined;
    },
  };
}

function evaluateBridgeExpression(expression: string, documentValue: Readonly<{ querySelectorAll(selector: string): readonly FakeBridgeElement[] }>): unknown {
  return Function('document', `return ${expression};`)(documentValue);
}

function cdpEvaluateValue(value: unknown): Readonly<{ result: { type: string; value: unknown } }> {
  return {
    result: {
      type: typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'object',
      value,
    },
  };
}

function createLocatorBridgeDocument() {
  const rect = { left: 20, top: 14, width: 40, height: 20 };
  const save = bridgeElement({ tagName: 'button', textContent: 'Save', attributes: { id: 'save' }, rect });
  const next = bridgeElement({ tagName: 'a', textContent: 'Continue', rect });
  const email = bridgeElement({ tagName: 'input', textContent: '',
    attributes: { 'data-testid': 'email-field', 'aria-label': 'Email' }, rect });
  return {
    querySelectorAll(selector: string) {
      return selector === '*' ? [save, next, email]
        : selector === '#save' ? [save]
          : selector === '[data-testid]' || selector === '[data-testid="email-field"]' ? [email] : [];
    },
  };
}

function createAggregateTextDocument(): Readonly<{
  button: FakeBridgeElement;
  documentValue: Readonly<{ querySelectorAll(selector: string): readonly FakeBridgeElement[] }>;
}> {
  const button = bridgeElement({
    tagName: 'button',
    textContent: 'Continue',
    attributes: { id: 'continue' },
    rect: { left: 20, top: 10, width: 50, height: 20 },
  });
  const main = bridgeElement({
    tagName: 'main',
    textContent: 'Choose an action Continue',
    rect: { left: 0, top: 0, width: 300, height: 200 },
    children: [button],
  });
  const body = bridgeElement({
    tagName: 'body',
    textContent: 'Welcome Choose an action Continue',
    rect: { left: 0, top: 0, width: 800, height: 600 },
    children: [main],
  });
  const html = bridgeElement({
    tagName: 'html',
    textContent: 'Welcome Choose an action Continue',
    rect: { left: 0, top: 0, width: 1000, height: 800 },
    children: [body],
  });
  return {
    button,
    documentValue: {
      querySelectorAll(selector) {
        return selector === '*' ? [html, body, main, button] : [];
      },
    },
  };
}

describe('control adapter automation transport bridge', () => {
  it.each(['focused', 'missing', 'unfocusable'] as const)('press targets the requested element and refuses unresolved focus (%s)', async state => {
    const received = { previous: [] as string[], target: [] as string[] };
    const previous = bridgeElement({ tagName: 'input', textContent: '', rect: { left: 0, top: 0, width: 80, height: 20 } });
    let activeElement: FakeBridgeElement = previous;
    const target: FakeBridgeElement = {
      ...bridgeElement({ tagName: 'input', textContent: '', rect: { left: 100, top: 0, width: 80, height: 20 } }),
      focus() { if (state === 'focused') activeElement = target; },
    };
    const documentValue = {
      get activeElement() { return activeElement; },
      querySelector: (selector: string) => selector === '#target' && state !== 'missing' ? target : null,
      querySelectorAll: (selector: string) => selector === '#target' && state !== 'missing' ? [target] : [],
    };
    const boundary = await inputSettlementBoundary(expression => evaluateBridgeExpression(expression, documentValue), (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') {
        received[activeElement === target ? 'target' : 'previous'].push(String(params.key));
      }
    });
    try {
      const result = await boundary.execute('press', { selector: '#target', key: 'Enter' });
      expect(received.previous).toEqual([]);
      expect(received.target).toEqual(state === 'focused' ? ['Enter'] : []);
      expect(result).toMatchObject(state === 'focused'
        ? { status: 'succeeded' }
        : { status: 'failed', errorCode: 'selector_not_found' });
    } finally { boundary.dispose(); }
  });

  it.each(['type', 'focus'] as const)('refuses %s when the requested element cannot take focus', async actionKind => {
    const previous = bridgeElement({ tagName: 'input', textContent: '', rect: { left: 0, top: 0, width: 80, height: 20 } });
    const target = bridgeElement({ tagName: 'input', textContent: '', rect: { left: 100, top: 0, width: 80, height: 20 } });
    const documentValue = { activeElement: previous, querySelector: () => target, querySelectorAll: () => [target] };
    let inserted = '';
    const boundary = await inputSettlementBoundary(expression => evaluateBridgeExpression(expression, documentValue), (method, params) => {
      if (method === 'Input.insertText') inserted += String(params?.text);
    });
    try {
      expect(await boundary.execute(actionKind, { selector: '#target', text: 'wrong field' }))
        .toMatchObject({ status: 'failed', errorCode: 'selector_not_found' });
      expect(inserted).toBe('');
    } finally { boundary.dispose(); }
  });

  it.each([true, false])('retains credential proof in the masked snapshot through the real context routes (focused=%s)', async focused => {
    const boundary = confidentialBoundary();
    boundary.state.focused = focused;
    const control = createSurfaceInputControl();
    let policyAllowed = true;
    const routes = createBrowserContextRoutes({
      ownerAccountId: 'owner',
      resolveGate: () => ({ featureEnabled: true, policyAllowed, runtimeAvailable: true }),
      resolveInputControl: () => control,
      source: createCdpBrowserContextSource({
        transport: boundary.contextCapture.transport,
        resolveView: boundary.contextCapture.resolvePageHandle,
        resolveInputControl: () => control,
        readFocusedCredentialTarget: view => boundary.bridge.readFocusedCredentialTarget!(view),
        screenshotMediaWriter: { write: async () => { throw new Error('Password pixels must not be persisted'); } },
      }),
    });
    const bridge = createControlAdapterAutomationTransport({ adapter: controlAdapter(),
      contextCapture: boundary.contextCapture, browserContext: routes });
    const controller = new AbortController();
    const query = () => bridge.dispatchPageQuery({ ...view, actionKind: 'semanticSnapshot', navigationGeneration: 3, payload: {},
      signal: controller.signal, deadlineMs: Date.now() + 60_000 });
    const observed = await query();
    expect(observed).toMatchObject({ ok: true, data: { visibleText: '', axNodes: [], interactiveElements: [], elements: [] } });
    if (!observed.ok) throw new Error('Missing credential observation');
    if (focused) expect(observed.data?.focusedCredentialTarget).toEqual({ ...view, tabId: HANDLE.targetId,
      frameId: 'frame', documentId: 'document', navigationGeneration: 3, origin: 'https://example.test', field: confidentialRequest.field });
    else expect(observed.data).not.toHaveProperty('focusedCredentialTarget');
    const { elements: _elements, ...snapshot } = observed.data ?? {};
    expect(BrowserContextSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).not.toHaveProperty('media');
    expect(snapshot).not.toHaveProperty('title');
    expect(snapshot).not.toHaveProperty('url');
    expect(boundary.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
    // Admission and egress now use the same census as the two snapshot boundaries.
    expect(boundary.calls.filter(call => call.method === 'DOMSnapshot.captureSnapshot')).toHaveLength(4);
    expect(JSON.stringify(observed)).not.toContain('fixture-password');
    policyAllowed = false;
    const count = boundary.calls.length;
    expect(await query()).toMatchObject({ ok: false });
    expect(boundary.calls).toHaveLength(count);
    policyAllowed = true;
    await control.beginConfidentialityHold();
    expect(await query()).toMatchObject({ ok: false });
    expect(boundary.calls).toHaveLength(count);
  });
  it.each(['snapshot', 'semanticSnapshot'] as const)('settles unfocused sensitive %s through the real automation service', async actionKind => {
    const boundary = confidentialBoundary();
    boundary.state.focused = false;
    const control = createSurfaceInputControl();
    const context = createBrowserContextRoutes({ ownerAccountId: 'owner',
      resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
      resolveInputControl: () => control,
      source: createCdpBrowserContextSource({ transport: boundary.contextCapture.transport,
        resolveView: boundary.contextCapture.resolvePageHandle, resolveInputControl: () => control,
        readFocusedCredentialTarget: view => boundary.bridge.readFocusedCredentialTarget!(view),
        screenshotMediaWriter: { write: async () => { throw new Error('Sensitive pixels must not be persisted'); } },
      }),
    });
    const bridge = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: boundary.contextCapture, browserContext: context });
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    try {
      const result = await service.execute({ v: 1, ...view, automationRequestId: 'unfocused-observation', requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' }, navigationGeneration: 3, actionKind, payload: {}, timeoutMs: 10_000 });
      expect(result).toMatchObject({ status: 'succeeded', resultSummary: { visibleText: '', axNodes: [], interactiveElements: [] } });
      expect(result.resultSummary).not.toHaveProperty('focusedCredentialTarget');
      expect(boundary.calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(0);
    } finally { service.dispose(); }
  });

  it('returns complete daemon query and context Action results while timelines stay compact', async () => {
    const name = 'Accessible label '.repeat(30).trim();
    const nodes = Array.from({ length: 513 }, (_, index) => ({
      ...bridgeElement({ tagName: 'button', textContent: name, attributes: { 'aria-label': name },
        rect: { left: 0, top: 0, width: 40, height: 20 } }),
      id: `button-${index}`, nodeType: 1, parentElement: null,
    }));
    const documentValue = { querySelectorAll: (selector: string) => selector.startsWith('#')
      ? nodes.filter(node => `#${node.id}` === selector) : nodes };
    const boundary = await inputSettlementBoundary(expression => Function('document', 'window', 'CSS',
      `return ${expression};`)(documentValue, { CSS: true }, { escape: String }));
    const routes = createBrowserAutomationRoutes({ service: boundary.service });
    const query = (selector: string, automationRequestId: string) => routes.dispatch('browser.automation.queryElements', {
      v: 1, ...view, automationRequestId, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' }, navigationGeneration: 0,
      actionKind: 'queryElements', payload: { selector }, timeoutMs: 10_000,
    }, { authority: 'account_automation' });
    try {
      const full = await query('button', 'full-query');
      expect(full).toMatchObject({ status: 'succeeded', resultSummary: { count: nodes.length, truncated: false } });
      expect('resultSummary' in full && full.resultSummary?.elements).toHaveLength(nodes.length);
      expect('resultSummary' in full && full.resultSummary?.elements).toEqual(nodes.map(() => ({ tag: 'button', name })));
      const semantic = await query(`role=button[name="${name}"]`, 'semantic-query');
      expect(semantic).toMatchObject({ status: 'succeeded', resultSummary: { count: nodes.length, truncated: false } });
      expect('resultSummary' in semantic && semantic.resultSummary?.elements).toEqual(nodes.map(() => ({ tag: 'button', name })));
      const snapshot = await boundary.execute('semanticSnapshot');
      expect(snapshot).toMatchObject({ status: 'succeeded', resultSummary: { interactiveElementsTruncated: false } });
      expect(snapshot.resultSummary?.elements).toHaveLength(nodes.length);
      expect(snapshot.resultSummary?.elements).toEqual(expect.arrayContaining([expect.objectContaining({ name })]));
      const timeline = boundary.service.getTimeline(view).entries.find(entry => entry.automationRequestId === 'full-query');
      expect(timeline).toMatchObject({ status: 'succeeded', resultSummary: { truncated: true } });
      const timelineElements = timeline?.resultSummary?.elements;
      expect(Array.isArray(timelineElements)).toBe(true);
      if (Array.isArray(timelineElements)) expect(timelineElements.length).toBeLessThan(nodes.length);
      if (Array.isArray(timelineElements)) {
        expect(timelineElements.every(element => typeof element === 'object' && element !== null
          && typeof element.name === 'string' && element.name.length < name.length)).toBe(true);
      }
    } finally { boundary.dispose(); }
  });
  it.each([
    ['type', { text: 'ordinary text' }, 'Input.insertText'],
    ['scroll', { deltaY: 120 }, 'Input.dispatchMouseEvent'],
    ['setValue', { selector: '#field', value: 'ordinary value' }, 'Runtime.evaluate'],
    ['navigate', { url: 'https://example.test/next' }, 'Page.navigate'],
  ] as const)('quarantines %s after its physical effect loses the CDP acknowledgement', async (actionKind, payload, method) => {
    const boundary = await inputSettlementBoundary();
    try {
      expect(await boundary.execute('snapshot')).toMatchObject({ status: 'succeeded' });
      boundary.state.loseAck = true;
      expect(await boundary.execute(actionKind, payload)).toMatchObject({ status: 'failed' });
      expect(boundary.service.getStatus(view).uncertain).toBe(true);
      expect(boundary.effects).toEqual([method]);
      expect(await boundary.execute('type', { text: 'next' })).toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
      expect(boundary.effects).toEqual([method]);
    } finally { boundary.dispose(); }
  });

  it.each(['type', 'navigate'] as const)('keeps a proven pre-dispatch %s refusal known without physical effects', async actionKind => {
    const boundary = await inputSettlementBoundary();
    try {
      expect(await boundary.execute('snapshot')).toMatchObject({ status: 'succeeded' });
      boundary.state.disposedBeforeInput = true;
      expect(await boundary.execute(actionKind, actionKind === 'type' ? { text: 'ordinary text' } : { url: 'https://example.test/next' }))
        .toMatchObject({ status: 'failed' });
      expect(boundary.service.getStatus(view).uncertain).toBe(false);
      expect(boundary.effects).toEqual([]);
      expect(boundary.service.getInputControl(view).getAdmissionFailure('agent')).toBeUndefined();
    } finally { boundary.dispose(); }
  });

  it('does not treat a failed read-only snapshot as uncertain physical input', async () => {
    const boundary = await inputSettlementBoundary();
    try {
      boundary.state.failedRead = true;
      expect(await boundary.execute('snapshot')).toMatchObject({ status: 'failed' });
      expect(boundary.service.getStatus(view).uncertain).toBe(false);
      expect(boundary.effects).toEqual([]);
    } finally { boundary.dispose(); }
  });

  it('preserves proven navigation nondispatch through the real control broker and input owner', async () => {
    const boundary = await inputSettlementBoundary();
    try {
      boundary.state.disposedBeforeInput = true;
      expect(await boundary.routes.dispatchCommand({ kind: 'navigate', commandId: 'navigate', ...view,
        url: 'https://example.test/next' }, { authority: 'present_user' }))
        .toMatchObject({ status: 'failed', completion: 'known' });
      expect(boundary.service.getStatus(view).uncertain).toBe(false);
      expect(boundary.effects).toEqual([]);
    } finally { boundary.dispose(); }
  });

  it.each(['ack_lost', 'pre_send_refused'] as const)('settles read-triggered dialog dismissal honestly (%s)', async failure => {
    const boundary = await inputSettlementBoundary();
    try {
      expect(await boundary.execute('snapshot')).toMatchObject({ status: 'succeeded' });
      boundary.state.dialogOnRead = true;
      boundary.state.loseAck = failure === 'ack_lost';
      boundary.state.disposedBeforeInput = failure === 'pre_send_refused';
      expect(await boundary.execute('snapshot')).toMatchObject({ status: 'failed' });
      expect(boundary.service.getStatus(view).uncertain).toBe(failure === 'ack_lost');
      expect(boundary.effects).toEqual(failure === 'ack_lost' ? ['Page.handleJavaScriptDialog'] : []);
      if (failure === 'ack_lost') {
        expect(await boundary.execute('type', { text: 'next' }))
          .toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
        expect(boundary.effects).toEqual(['Page.handleJavaScriptDialog']);
      }
    } finally { boundary.dispose(); }
  });

  it.each([undefined, 'unknown', 'not_observable'] as const)('retains only producer native-observation provenance through the real private route (fact=%s)', async nativeObservation => {
    const { bridge } = confidentialBoundary(nativeObservation);
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    const routes = createBrowserAutomationRoutes({ service });
    const target = await routes.prepareConfidentialFill(confidentialRequest, { authority: 'present_user' });
    if ('status' in target) throw new Error('Expected supported confidential target');
    expect(target.nativeObservation).toBe(nativeObservation === 'not_observable' ? nativeObservation : undefined);
    await target.finish();
    service.dispose();
  });

  it('rejects caller-supplied native-observation provenance without contacting CDP', async () => {
    const { bridge, calls } = confidentialBoundary();
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    const routes = createBrowserAutomationRoutes({ service });
    expect(await routes.prepareConfidentialFill({ ...confidentialRequest, nativeObservation: 'not_observable' }, { authority: 'present_user' }))
      .toEqual({ status: 'refused', code: 'target_changed' });
    expect(calls).toEqual([]);
    service.dispose();
  });

  it('publishes the existing confidential hold and known nondelivery release through controller events', async () => {
    const boundary = await confidentialServiceBoundary();
    const { service } = boundary;
    const states: Array<{ confidentialityHeld?: boolean }> = [];
    service.subscribeBrowserEvents(event => { if (event.kind === 'controllerChanged') states.push(event.state); });
    try {
      const target = await service.prepareConfidentialFill(confidentialRequest, { authority: 'present_user' });
      if ('status' in target) throw new Error('Expected supported confidential target');
      expect(service.getStatus(view).confidentialityHeld).toBe(true);
      expect(states.at(-1)?.confidentialityHeld).toBe(true);
      await target.finish();
      expect(service.getStatus(view).confidentialityHeld).toBeUndefined();
      expect(states.at(-1)?.confidentialityHeld).toBeUndefined();
    } finally { boundary.dispose(); }
  });

  it.each(['fill', 'submit'] as const)('keeps proven pre-dispatch confidential %s refusal known without clearing an older delivered hold', async effect => {
    const boundary = await confidentialServiceBoundary();
    try {
      const request = effect === 'submit' ? { ...confidentialRequest, submit: {
        controlId: '51', locator: '#submit', label: 'Sign in', consequence: 'Submit credentials',
      } } : confidentialRequest;
      const target = await boundary.service.prepareConfidentialFill(request, { authority: 'present_user' });
      if ('status' in target) throw new Error('Expected supported confidential target');
      const value = new TextEncoder().encode('fixture-credential');
      if (effect === 'submit') expect(await target.fill(value)).toEqual({ status: 'filled', code: 'filled' });
      boundary.state.beforeCommand = (method, params) => {
        if (effect === 'fill' && method === 'Input.insertText' || effect === 'submit'
          && method === 'Runtime.callFunctionOn' && String(params?.functionDeclaration).includes('HTMLElement.prototype.click')) {
          throw new BrowserSidecarCdpTransportError('cdp_transport_disposed', 'Not sent', 'not_dispatched');
        }
      };
      expect(effect === 'fill' ? await target.fill(value) : await target.submit?.())
        .toEqual(effect === 'fill' ? { status: 'refused', code: 'target_changed' } : { status: 'refused', code: 'submit_refused' });
      expect(value.every(byte => byte === 0)).toBe(true);
      expect(boundary.state.inserted).toBe(effect === 'submit');
      expect(boundary.state.submitted).toBe(false);
      expect(boundary.service.getStatus(view).uncertain).toBe(false);
      await target.finish();
      expect(boundary.service.getStatus(view).confidentialityHeld).toBe(effect === 'submit' ? true : undefined);
    } finally { boundary.dispose(); }
  });

  it('refuses unsupported confidential verification without issuing native input', async () => {
    const { surface, calls } = fakeContextCapture(() => ({}));
    const bridge = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
    expect(await bridge.prepareConfidentialFill?.(confidentialRequest))
      .toEqual({ status: 'refused', code: 'field_verification_unsupported' });
    expect(calls).toEqual([]);
  });

  it('fills the approved current field with native input immediately after fresh CDP proof without echoing results', async () => {
    const { bridge, calls, state } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    expect(target).toBeDefined();
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    const value = new TextEncoder().encode('fixture-credential-unique');
    expect(await target.fill(value)).toEqual({ status: 'filled', code: 'filled' });
    expect(state.inserted).toBe(true);
    const effectIndex = calls.findIndex(call => call.method === 'Input.insertText');
    expect(calls[effectIndex]).toEqual({ method: 'Input.insertText', params: { text: 'fixture-credential-unique' } });
    expect(calls[effectIndex - 1]).toMatchObject({ method: 'Runtime.callFunctionOn', params: { objectId: 'field' } });
    expect(calls.filter(call => call.method === 'Runtime.evaluate' || call.method === 'Runtime.callFunctionOn')
      .every(call => !JSON.stringify(call.params).includes('fixture-credential-unique'))).toBe(true);
    expect(value.every(byte => byte === 0)).toBe(true);
    await target.finish();
  });

  it.each(['tab', 'frame', 'document', 'origin', 'field', 'focus', 'navigation'] as const)('refuses changed %s before confidential delivery', async changed => {
    const { bridge, calls, state } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    expect(target).toBeDefined();
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    if (changed === 'field') state.fieldId = 42;
    if (changed === 'focus') state.focused = false;
    if (changed === 'document') state.documentId = 'replacement';
    if (changed === 'origin') state.origin = 'https://other.test';
    if (changed === 'navigation') state.generation += 1;
    const request = changed === 'tab' ? { ...confidentialRequest, tabId: 'wrong' }
      : changed === 'frame' ? { ...confidentialRequest, frameId: 'wrong' } : undefined;
    if (request) expect(await bridge.prepareConfidentialFill?.(request)).toEqual({ status: 'refused', code: 'target_changed' });
    else expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'refused', code: 'target_changed' });
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    await target.finish();
  });

  it('rechecks navigation during proof and never retries ambiguous confidential delivery', async () => {
    const { bridge, calls, state } = confidentialBoundary();
    state.beforeCommand = method => { if (method === 'DOM.describeNode') state.generation += 1; };
    expect(await bridge.prepareConfidentialFill?.(confidentialRequest)).toEqual({ status: 'refused', code: 'target_changed' });
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    state.beforeCommand = () => {};
    state.generation = 3;
    state.failInsert = true;
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    const result = await target.fill(new TextEncoder().encode('fixture-credential-unique'));
    expect(result).toEqual({ status: 'unknown', code: 'delivery_unknown' });
    expect(JSON.stringify(result)).not.toContain('fixture-credential-unique');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'unknown', code: 'delivery_unknown' });
    expect(calls.filter(call => call.method === 'Input.insertText')).toHaveLength(1);
    await target.finish();
  });

  it('cancels before delivery without issuing native input', async () => {
    const { bridge, calls } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    expect(target).toBeDefined();
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    const abort = new AbortController(); abort.abort();
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'), abort.signal)).toEqual({ status: 'canceled', code: 'canceled' });
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    await target.finish();
  });

  it('publishes a value-free focused target only when it has a stable locator and exact node proof', async () => {
    const { bridge, state } = confidentialBoundary();
    const expected = { ...view, tabId: HANDLE.targetId, frameId: 'frame', documentId: 'document',
      navigationGeneration: 3, origin: 'https://example.test', field: confidentialRequest.field };
    expect(await bridge.readFocusedCredentialTarget?.(view)).toEqual(expected);
    state.stableLocator = '';
    expect(await bridge.readFocusedCredentialTarget?.(view)).toBeUndefined();
  });

  it('keeps observation unsafe across clearing, navigation, raw destruction events and generic retirement', async () => {
    const { bridge, state, destroyTarget } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    await target.fill(new TextEncoder().encode('fixture-credential-unique'));
    await target.finish();
    expect(await target.isSafe?.()).toBe(false);
    state.generation += 1;
    expect(await target.isSafe?.()).toBe(false);
    state.documentId = 'new-document';
    expect(await target.isSafe?.()).toBe(false);
    state.empty = true;
    state.originalConnected = false;
    expect(await target.isSafe?.()).toBe(false);
    state.originalConnected = true;
    expect(await target.isSafe?.()).toBe(false);
    destroyTarget('other-target');
    expect(await target.isSafe?.()).toBe(false);
    destroyTarget();
    expect(await target.isSafe?.()).toBe(false);
    state.viewOpen = false;
    expect(await target.isSafe?.()).toBe(false);
  });

  it('does not permit observation while a confidential invocation is live and permits release only after known nondelivery', async () => {
    const { bridge } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.isSafe?.()).toBe(false);
    const abort = new AbortController(); abort.abort();
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'), abort.signal))
      .toEqual({ status: 'canceled', code: 'canceled' });
    expect(await target.isSafe?.()).toBe(false);
    await target.finish();
    expect(await target.isSafe?.()).toBe(true);
  });

  it('refuses a real focus mismatch observed by the final CDP verification before native input', async () => {
    const { bridge, state } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    state.beforeCommand = method => { if (method === 'Runtime.callFunctionOn') state.focused = false; };
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'refused', code: 'target_changed' });
    expect(state.inserted).toBe(false);
    await target.finish();
  });

  it('reverifies focus after the human authority callback and before inserting text', async () => {
    const { bridge, state, calls } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'), undefined, async () => {
      state.focused = false; return true;
    })).toEqual({ status: 'refused', code: 'target_changed' });
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    await target.finish();
  });

  it('refuses confidential delivery when the authority callback before fresh target proof rejects it', async () => {
    const { bridge, calls, state } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'), undefined, async () => false))
      .toEqual({ status: 'refused', code: 'approval_changed' });
    expect(state.inserted).toBe(false);
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    await target.finish();
  });

  it('refuses confidential delivery when authority is withdrawn during awaited field identity resolution', async () => {
    const { bridge, calls, state } = confidentialBoundary();
    const target = await bridge.prepareConfidentialFill?.(confidentialRequest);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    let approved = true;
    // Revoke at the CDP network boundary after preparation, while fill awaits its identity proof.
    state.beforeCommand = method => { if (method === 'DOM.describeNode') approved = false; };
    const value = new TextEncoder().encode('fixture-credential-unique');
    expect(await target.fill(value, undefined, async () => approved))
      .toEqual({ status: 'refused', code: 'approval_changed' });
    expect(state.inserted).toBe(false);
    expect(calls.some(call => call.method === 'Input.insertText')).toBe(false);
    expect(value.every(byte => byte === 0)).toBe(true);
    await target.finish();
  });

  it.each([false, true])('composes confidential delivery and observation hold through the real route/service/CDP owners (ambiguous=%s)', async ambiguous => {
    const { bridge, state, calls } = confidentialBoundary();
    state.failInsert = ambiguous;
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    const routes = createBrowserAutomationRoutes({ service });
    const request = { ...confidentialRequest, submit: { controlId: '51', locator: '#submit', label: 'Sign in', consequence: 'Send credential' } };
    const target = await routes.prepareConfidentialFill(request, { authority: 'present_user' });
    if ('status' in target) throw new Error('Expected supported confidential target');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual(ambiguous
      ? { status: 'unknown', code: 'delivery_unknown' } : { status: 'filled', code: 'filled' });
    if (ambiguous) {
      expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'refused', code: 'approval_changed' });
      expect(await target.submit?.()).toEqual({ status: 'refused', code: 'submit_refused' });
    }
    expect(service.getTimeline(view).entries).toEqual([]);
    await target.finish();
    const before = calls.length;
    const readback = await routes.dispatch('browser.automation.snapshot', { v: 1, ...view,
      automationRequestId: 'held-read', actionKind: 'snapshot', navigationGeneration: 3, requestedBy: 'agent',
      requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 5000, payload: {} }, { authority: 'account_automation' });
    expect(readback).toMatchObject({ status: 'failed', errorCode: 'policy_denied' });
    expect(calls.length).toBe(before);
    expect(JSON.stringify([readback, service.getTimeline(view)])).not.toContain('fixture-credential-unique');
    expect(state.submitted).toBe(false);
    service.dispose();
  });

  it.each([false, true])('uses the real sidecar binding and navigation owner for confidential fill (stale=%s)', async stale => {
    const boundary = confidentialBoundary();
    const sidecar = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar',
      transport: { ...boundary.contextCapture.transport, openPage: async () => HANDLE,
        dispatchBrowserCommand: async () => ({}), subscribeCdpEvents: boundary.contextCapture.subscribeCdpEvents },
    });
    await sidecar.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web', focus: true,
      target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
    boundary.notify({ method: 'Page.frameStoppedLoading', sessionId: HANDLE.sessionId, params: { frameId: 'frame' } });
    const bridge = createControlAdapterAutomationTransport({ adapter: sidecar, contextCapture: {
      transport: boundary.contextCapture.transport, resolvePageHandle: sidecar.resolvePageHandle,
      getNavigationState: sidecar.getNavigationState,
    } });
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: bridge }) });
    const routes = createBrowserAutomationRoutes({ service });
    const request = { ...confidentialRequest, navigationGeneration: 0 };
    const target = await routes.prepareConfidentialFill(request, { authority: 'present_user' });
    if ('status' in target) throw new Error('Expected supported confidential target');
    if (stale) boundary.state.beforeCommand = method => {
      if (method === 'DOM.describeNode') boundary.notify({ method: 'Page.frameNavigated', sessionId: HANDLE.sessionId,
        params: { frame: { id: 'frame', loaderId: 'replacement', url: 'https://example.test/next' } } });
    };
    const result = await target.fill(new TextEncoder().encode('fixture-credential-unique'));
    expect(result).toEqual(stale ? { status: 'refused', code: 'target_changed' } : { status: 'filled', code: 'filled' });
    expect(boundary.state.inserted).toBe(!stale);
    expect(service.getTimeline(view).entries).toEqual([]);
    await target.finish();
    service.dispose();
    sidecar.dispose();
  });

  it('submits only the separate reviewed control after a known fill and refuses its replacement', async () => {
    const { bridge, state } = confidentialBoundary();
    const request = { ...confidentialRequest, submit: { controlId: '51', locator: '#submit', label: 'Sign in', consequence: 'Send credential' } };
    const target = await bridge.prepareConfidentialFill?.(request);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.submit?.()).toEqual({ status: 'refused', code: 'submit_refused' });
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'filled', code: 'filled' });
    state.controlId = 52;
    expect(await target.submit?.()).toEqual({ status: 'refused', code: 'submit_refused' });
    expect(state.submitted).toBe(false);
    await target.finish();
    const next = await bridge.prepareConfidentialFill?.(request);
    if (!next || 'status' in next) throw new Error('Expected supported confidential target');
    state.controlId = 51;
    await next.fill(new TextEncoder().encode('fixture-credential-unique'));
    expect(await next.submit?.()).toEqual({ status: 'submitted', code: 'submitted' });
    expect(state.submitted).toBe(true);
    await next.finish();
  });
  it('rechecks human authority at the separate submit boundary and never clicks after approval withdrawal', async () => {
    const { bridge, state } = confidentialBoundary();
    const request = { ...confidentialRequest, submit: { controlId: '51', locator: '#submit', label: 'Sign in', consequence: 'Send credential' } };
    const target = await bridge.prepareConfidentialFill?.(request);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'filled', code: 'filled' });
    expect(await target.submit?.(undefined, async () => false)).toEqual({ status: 'refused', code: 'submit_refused' });
    expect(state.submitted).toBe(false);
    await target.finish();
  });

  it('retains known fill and refuses submit when authority is withdrawn during awaited control identity resolution', async () => {
    const { bridge, state } = confidentialBoundary();
    const request = { ...confidentialRequest, submit: { controlId: '51', locator: '#submit', label: 'Sign in', consequence: 'Send credential' } };
    const target = await bridge.prepareConfidentialFill?.(request);
    if (!target || 'status' in target) throw new Error('Expected supported confidential target');
    expect(await target.fill(new TextEncoder().encode('fixture-credential-unique'))).toEqual({ status: 'filled', code: 'filled' });
    let approved = true;
    // The separate approved action can be withdrawn while its exact control is resolved.
    state.beforeCommand = (method, params) => {
      if (method === 'DOM.describeNode' && params?.objectId === 'control') approved = false;
    };
    expect(await target.submit?.(undefined, async () => approved)).toEqual({ status: 'refused', code: 'submit_refused' });
    expect(state.inserted).toBe(true);
    expect(state.submitted).toBe(false);
    await target.finish();
  });
  it('dispatches streamed-view coordinates without requiring a DOM selector', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const transport = { openPage: async () => HANDLE, dispatchBrowserCommand: async () => ({}),
      dispatchPageCommand: async (command: (typeof calls)[number]) => { calls.push(command); return {}; } };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport });
    await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
      target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
    const bridge = createControlAdapterAutomationTransport({ adapter,
      contextCapture: { transport, resolvePageHandle: adapter.resolvePageHandle } });
    expect(await bridge.dispatchInputCommand?.({ ...view, actionKind: 'tap', navigationGeneration: 0, payload: { x: 200, y: 100 } })).toEqual({ ok: true });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: expect.objectContaining({ type: 'mousePressed', x: 200, y: 100 }) }),
      expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: expect.objectContaining({ type: 'mouseReleased', x: 200, y: 100 }) }),
    ]));
    adapter.dispose();
  });
  it('auto-dismisses navigation dialogs for the whole adapter operation', async () => {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const { surface, calls } = fakeContextCapture(method => {
      if (method === 'Page.navigate') for (const listener of listeners) listener({ method: 'Page.javascriptDialogOpening', sessionId: HANDLE.sessionId, params: { type: 'alert', message: 'private' } });
      return {};
    });
    const boundary = { ...surface.transport, openPage: async () => HANDLE, dispatchBrowserCommand: async () => ({}), subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const control = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport: boundary });
    await control.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web', target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/start' } });
    const listenerCount = listeners.size;
    const adapter = createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({
      adapter: control,
      contextCapture: { transport: boundary, resolvePageHandle: control.resolvePageHandle, subscribeCdpEvents: boundary.subscribeCdpEvents },
    }) });
    const result = await adapter.execute({ v: 1, ...view, automationRequestId: 'navigation_dialog', actionKind: 'navigate', navigationGeneration: 1, requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent_1' }, timeoutMs: 5000, payload: { url: 'https://example.test' } });
    expect(result).toMatchObject({ status: 'succeeded', resultSummary: { javascriptDialogs: { count: 1, kinds: ['alert'], handling: 'dismissed' } } });
    expect(calls).toContainEqual({ method: 'Page.navigate', params: { url: 'https://example.test' } });
    expect(calls).toContainEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: false } });
    expect(listeners.size).toBe(listenerCount);
    control.dispose();
  });
  it.each(['alert', 'confirm', 'prompt'] as const)('responds to an approved %s through the real Browser Action and CDP path', async kind => {
    const boundary = await inputSettlementBoundary(undefined, undefined, [{ type: kind, message: 'Continue?' }]);
    try {
      const request = { v: 1, ...view, automationRequestId: `dialog:${kind}`, requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 10_000, actionKind: 'type', navigationGeneration: 0,
        payload: { text: 'hello' }, dialogResponse: { kind, message: 'Continue?', accept: true,
          ...(kind === 'prompt' ? { promptText: 'my answer' } : {}) } };
      const actionId = 'browser.automation.type';
      const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({
        automation: createBrowserAutomationRoutes({ service: boundary.service }),
        featureGate: { isEnabled: () => true, refresh: async () => {} },
      });
      const result = await dispatchRuntimeAction({ actionId, input: getActionSpec(actionId).inputSchema.parse(request),
        context: { surface: 'agent', authority: 'account_automation' }, runtimeActionExecute });
      expect(getActionSpec(actionId).outputSchema?.parse(result)).toMatchObject({ status: 'succeeded',
        resultSummary: { javascriptDialogs: { count: 1, kinds: [kind], handling: 'accepted',
          dialogs: [{ kind, message: 'Continue?', handling: 'accepted' }] } } });
      expect(BrowserAutomationJavaScriptDialogSummaryV1Schema.parse(
        BrowserAutomationActionResultV1Schema.parse(result).resultSummary.javascriptDialogs,
      ).dialogs).toEqual([{ kind, message: 'Continue?', handling: 'accepted' }]);
      expect(boundary.dialogResponses).toEqual([{ accept: true, ...(kind === 'prompt' ? { promptText: 'my answer' } : {}) }]);
      expect(JSON.stringify(result)).not.toContain('my answer');
      expect(JSON.stringify(result)).not.toContain('unshared default');
    } finally { boundary.dispose(); }
  });

  it('dismisses mismatched dialogs and consumes the approved response only once', async () => {
    const boundary = await inputSettlementBoundary(undefined, undefined, [
      { type: 'confirm', message: 'Other question' }, { type: 'prompt', message: 'Continue?' },
      { type: 'confirm', message: 'Continue?' },
      { type: 'confirm', message: 'Continue?' },
    ]);
    try {
      const request = { v: 1, ...view, automationRequestId: 'one-response', requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 10_000, actionKind: 'type', navigationGeneration: 0,
        payload: { text: 'hello' }, dialogResponse: { kind: 'confirm', message: 'Continue?', accept: true } };
      const routes = createBrowserAutomationRoutes({ service: boundary.service });
      expect(await routes.dispatch('browser.automation.type', request, { authority: 'account_automation' }))
        .toMatchObject({ status: 'succeeded', resultSummary: { javascriptDialogs: { count: 4, handling: 'mixed',
          dialogs: [{ kind: 'confirm', message: 'Other question', handling: 'dismissed' },
            { kind: 'prompt', message: 'Continue?', handling: 'dismissed' },
            { kind: 'confirm', message: 'Continue?', handling: 'accepted' },
            { kind: 'confirm', message: 'Continue?', handling: 'dismissed' }] } } });
      expect(boundary.dialogResponses).toEqual([{ accept: false }, { accept: false }, { accept: true }, { accept: false }]);
    } finally { boundary.dispose(); }
  });

  it('keeps a lost response acknowledgement uncertain without claiming the dialog was accepted', async () => {
    const boundary = await inputSettlementBoundary(undefined, undefined, [{ type: 'prompt', message: 'Continue?' }]);
    try {
      boundary.state.loseDialogAck = true;
      const routes = createBrowserAutomationRoutes({ service: boundary.service });
      const result = await routes.dispatch('browser.automation.type', { v: 1, ...view, automationRequestId: 'dialog-ack-lost',
        requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 10_000, actionKind: 'type',
        navigationGeneration: 0, payload: { text: 'hello' },
        dialogResponse: { kind: 'prompt', message: 'Continue?', accept: true, promptText: 'my answer' },
      }, { authority: 'account_automation' });
      expect(result).toMatchObject({ status: 'failed' });
      expect(boundary.service.getStatus(view).uncertain).toBe(true);
      expect(boundary.dialogResponses).toEqual([{ accept: true, promptText: 'my answer' }]);
      expect('resultSummary' in result && result.resultSummary?.javascriptDialogs).toBeUndefined();
    } finally { boundary.dispose(); }
  });

  it('settles an unacknowledged dialog response at the containing action deadline', async () => {
    const boundary = await inputSettlementBoundary(undefined, undefined, [{ type: 'confirm', message: 'Continue?' }]);
    vi.useFakeTimers();
    try {
      boundary.state.holdDialogAck = true;
      const pending = createBrowserAutomationRoutes({ service: boundary.service }).dispatch('browser.automation.type', {
        v: 1, ...view, automationRequestId: 'dialog-deadline', requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 1000, actionKind: 'type',
        navigationGeneration: 0, payload: { text: 'hello' },
        dialogResponse: { kind: 'confirm', message: 'Continue?', accept: true },
      }, { authority: 'account_automation' });
      await vi.advanceTimersByTimeAsync(999);
      expect(boundary.service.getStatus(view).activeAutomationRequestId).toBe('dialog-deadline');
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ status: 'timed_out', errorCode: 'timed_out' });
      expect(boundary.service.getStatus(view).activeAutomationRequestId).toBeUndefined();
      expect(boundary.dialogResponses).toEqual([{ accept: true }]);
    } finally { boundary.dispose(); vi.useRealTimers(); }
  });

  it('dismisses page dialogs by default and reports the question without its prompt default', async () => {
    const boundary = await inputSettlementBoundary(undefined, undefined, [{ type: 'prompt', message: 'private dialog content' }]);
    try {
      const result = await boundary.execute('type', { text: 'hello' });
      expect(result).toMatchObject({ status: 'succeeded', resultSummary: { javascriptDialogs: { count: 1,
        kinds: ['prompt'], handling: 'dismissed', dialogs: [
          { kind: 'prompt', message: 'private dialog content', handling: 'dismissed' },
        ] } } });
      expect(boundary.dialogResponses).toEqual([{ accept: false }]);
      expect(JSON.stringify(result)).not.toContain('unshared default');
    } finally { boundary.dispose(); }
  });
  it('waits for a later matching element within the containing deadline', async () => {
    vi.useFakeTimers();
    try {
      let present = false;
      const { surface } = fakeContextCapture(() => cdpEvaluateValue(present));
      const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
      const pending = transport.dispatchPageQuery({ ...view, actionKind: 'waitFor', navigationGeneration: 1, payload: { selector: '#later' }, deadlineMs: Date.now() + 1000 });
      await vi.advanceTimersByTimeAsync(200);
      present = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toMatchObject({ ok: true, data: { present: true } });
    } finally { vi.useRealTimers(); }
  });

  it('reports deadline expiry and cancellation without evaluating again', async () => {
    vi.useFakeTimers();
    try {
      const { surface, calls } = fakeContextCapture(() => cdpEvaluateValue(false));
      const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
      const controller = new AbortController();
      const canceled = transport.dispatchPageQuery({ ...view, actionKind: 'waitFor', navigationGeneration: 1, payload: { selector: '#later' }, deadlineMs: Date.now() + 1000, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      expect(await canceled).toMatchObject({ ok: false, errorCode: 'user_canceled' });
      const count = calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(count);
      const expired = transport.dispatchPageQuery({ ...view, actionKind: 'waitFor', navigationGeneration: 1, payload: { selector: '#later' }, deadlineMs: Date.now() + 300 });
      await vi.advanceTimersByTimeAsync(300);
      expect(await expired).toMatchObject({ ok: false, errorCode: 'timed_out' });
    } finally { vi.useRealTimers(); }
  });

  it('uploads file descriptors to the resolved DOM file input and cleans request-owned bytes', async () => {
    let uploadedFiles: string[] = [];
    const { surface } = fakeContextCapture(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input' } };
      if (method === 'DOM.setFileInputFiles') {
        uploadedFiles = params?.files as string[];
        expect(params?.objectId).toBe('file-input');
        expect(await readFile(uploadedFiles[0], 'utf8')).toBe('Hello upload');
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
    const result = await transport.dispatchInputCommand?.({ ...view, actionKind: 'upload', navigationGeneration: 1, payload: { selector: '#files', files: [{ name: 'example.txt', mimeType: 'text/plain', text: 'Hello upload' }] } });
    expect(result).toMatchObject({ ok: true, data: { fileCount: 1 } });
    expect(uploadedFiles).toHaveLength(1);
    await expect(access(uploadedFiles[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drags between locator centres through trusted mouse events', async () => {
    const { surface, calls } = fakeContextCapture((method, params) => method === 'Runtime.evaluate' ? cdpEvaluateValue(String(params?.expression).includes('#target') ? { x: 100, y: 200 } : { x: 10, y: 20 }) : {});
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
    const result = await transport.dispatchInputCommand?.({ ...view, actionKind: 'drag', navigationGeneration: 1, payload: { from: '#source', to: '#target' } });
    expect(result).toMatchObject({ ok: true });
    expect(calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params)).toEqual([
      { type: 'mouseMoved', x: 10, y: 20 },
      { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseMoved', x: 100, y: 200, button: 'left', buttons: 1 },
      { type: 'mouseReleased', x: 100, y: 200, button: 'left', buttons: 0, clickCount: 1 },
    ]);
  });
  it('cleans duplicate-name binary uploads even when Chromium rejects selection', async () => {
    let uploadedFiles: string[] = [];
    const bytes = Buffer.from([0, 255, 128, 10]);
    const { surface } = fakeContextCapture(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input' } };
      if (method === 'DOM.setFileInputFiles') {
        uploadedFiles = params?.files as string[];
        expect(uploadedFiles[0]).not.toBe(uploadedFiles[1]);
        for (const file of uploadedFiles) expect(await readFile(file)).toEqual(bytes);
        throw new Error('CDP selection rejected');
      }
      return {};
    });
    const descriptor = { name: 'same.bin', mimeType: 'application/octet-stream', text: bytes.toString('base64'), base64: true };
    const result = await createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }).dispatchInputCommand?.({ ...view, actionKind: 'upload', navigationGeneration: 1, payload: { selector: '#files', files: [descriptor, descriptor] } });
    expect(result).toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });
    expect(uploadedFiles).toHaveLength(2);
    for (const file of uploadedFiles) await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['click', 'press', 'drag'] as const)('drains canceled %s and releases held input before the route acknowledges', async (actionKind) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') return cdpEvaluateValue({ x: 60, y: 40 });
      if (params?.type === 'mousePressed' || params?.type === 'keyDown') {
        entered();
        return blocked;
      }
      return {};
    });
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }),
      }),
    });
    const routes = createBrowserAutomationRoutes({ service });
    const pending = service.execute({
      v: 1, ...view, automationRequestId: 'cancel_input', actionKind,
      navigationGeneration: 0, timeoutMs: 5000,
      requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent_1' },
      payload: actionKind === 'drag' ? { from: '#source', to: '#target' } : { selector: '#submit', key: 'Enter' },
    });
    await started;
    let acknowledged = false;
    const cancel = routes.dispatch('browser.automation.cancelActive', view, { authority: 'present_user' })
      .then((result) => { acknowledged = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acknowledged).toBe(false);
    expect(service.getStatus(view).activeAutomationRequestId).toBe('cancel_input');
    release();
    expect(await cancel).toMatchObject({ outcome: 'canceled', completion: 'stopped' });
    expect(await pending).toMatchObject({ status: 'canceled', resultSummary: { completion: 'stopped' } });
    const effectsAtAck = calls.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(effectsAtAck);
    expect(calls.at(-1)?.params?.type).toBe(actionKind === 'press' ? 'keyUp' : 'mouseReleased');
    expect(service.getStatus(view).controller).toBe('human');
  });

  it('does not insert text after cancellation during selector resolution', async () => {
    const controller = new AbortController();
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        controller.abort('user_canceled');
        return cdpEvaluateValue({ x: 10, y: 10 });
      }
      return {};
    });
    const adapter = createBrowserAutomationCdpAdapter({
      transport: createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }),
    });
    const result = await adapter.execute({
      v: 1, ...view, automationRequestId: 'cancel_type', actionKind: 'type',
      navigationGeneration: 0, timeoutMs: 5000,
      requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent_1' },
      payload: { selector: '#name', text: 'must not land' },
    }, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'canceled', interruptionCompletion: 'stopped' });
    expect(calls.some((call) => call.method === 'Input.insertText')).toBe(false);
  });
  it('reports uncertain interruption when Chromium cannot confirm held-input release', async () => {
    const controller = new AbortController();
    const { surface } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') return cdpEvaluateValue({ x: 10, y: 10 });
      if (params?.type === 'mousePressed') controller.abort('user_canceled');
      if (params?.type === 'mouseReleased') throw new Error('CDP disconnected');
      return {};
    });
    const adapter = createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }) });
    expect(await adapter.execute({ v: 1, ...view, automationRequestId: 'uncertain', actionKind: 'click', navigationGeneration: 0, timeoutMs: 5000,
      requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'agent_1' }, payload: { selector: '#go' },
    }, { signal: controller.signal })).toMatchObject({ status: 'canceled', interruptionCompletion: 'uncertain' });
  });
  it('requires explicit hand back and a fresh observation before agent input resumes', async () => {
    const { surface } = fakeContextCapture((method, params) => method === 'Runtime.evaluate'
      ? cdpEvaluateValue(params?.expression === browserContextSensitiveFieldsExpression ? false : { x: 10, y: 10 }) : {});
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
      transport: createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface, browserContext: contextRoutes(surface) }),
    }) });
    const action = { v: 1 as const, ...view, automationRequestId: 'held', actionKind: 'click' as const,
      navigationGeneration: 0, timeoutMs: 5000, requestedBy: 'agent' as const,
      requesterRef: { kind: 'agent' as const, id: 'agent_1' }, payload: { selector: '#go' } };
    await service.cancelActive({ ...view, authority: 'present_user' });
    expect(service.getStatus(view).controller).toBe('human');
    expect(await service.execute(action)).toMatchObject({ errorCode: 'human_interrupted' });
    await service.handBack({ ...view, authority: 'present_user' });
    expect(await service.execute(action)).toMatchObject({ errorCode: 'stale_navigation' });
    expect(await service.execute({ ...action, actionKind: 'snapshot', payload: {} })).toMatchObject({ status: 'succeeded' });
    expect(await service.execute(action)).toMatchObject({ status: 'succeeded' });
    expect(await service.execute({ ...action, navigationGeneration: 9 })).toMatchObject({ errorCode: 'stale_navigation' });
  });
  it('delegates ownsView to the control adapter', () => {
    const adapter = controlAdapter({ ownsView: vi.fn(() => false) });
    const transport = createControlAdapterAutomationTransport({ adapter });
    expect(transport.ownsView(view)).toBe(false);
  });

  it('fails page queries closed because the control adapter exposes no CDP query producer', async () => {
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter() });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'snapshot',
      navigationGeneration: 1,
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('runtime_unavailable');
  });

  // MCH-3: read-only page queries ride the live CDP transport the control adapter opened.
  it.each(['snapshot', 'semanticSnapshot'] as const)('refuses %s without the canonical context owner rather than exposing raw page text', async actionKind => {
    const text = `Hello ${'page '.repeat(4_000)}`.trim();
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'string', value: `  ${text}  ` } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind,
      navigationGeneration: 1,
      payload: {},
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'runtime_unavailable' });
    expect(calls).toEqual([]);
  });

  it('routes the production snapshot verb through the rich browser-context snapshot producer', async () => {
    // Keep route/capture/source logic real; only Chromium and screenshot persistence are boundaries.
    const { surface } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') {
        if (String(params?.expression).includes('input[type="password"]')) return cdpEvaluateValue(false);
        if (String(params?.expression).includes('getBoundingClientRect')) return cdpEvaluateValue([
          { role: 'button', name: 'Submit', selector: '#submit', rect: { x: 10, y: 20, width: 80, height: 32 } },
        ]);
        return cdpEvaluateValue('Welcome back');
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'https://example.test/welcome', title: 'Welcome' }] };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'node_1', ignored: false, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Submit' } }] };
      if (method === 'Page.captureScreenshot') return { data: 'AQID' };
      return {};
    });
    const transport = createControlAdapterAutomationTransport({
      adapter: controlAdapter(),
      contextCapture: surface,
      browserContext: createBrowserContextRoutes({
        ownerAccountId: 'owner',
        resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        source: createCdpBrowserContextSource({
          transport: surface.transport,
          resolveView: () => HANDLE,
          screenshotMediaWriter: { write: async () => ({ ok: true, media: { mediaId: 'media_snapshot', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4096 } }) },
        }),
      }),
    });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'snapshot',
      navigationGeneration: 7,
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      navigationGeneration: 7,
      visibleText: 'Welcome back',
      axNodes: [{ role: 'button', name: 'Submit' }],
      interactiveElements: [
        { role: 'button', name: 'Submit', selector: '#submit' },
      ],
    });
    expect((result.data as { media?: { mediaId?: string } }).media?.mediaId).toBe('media_snapshot');
  });

  // BA-2: the rich semantic snapshot returns interactiveElements[{role,name,selector,rect}] with
  // synthesized stable selectors so the agent can act by resilient locator, not coordinates.
  it('returns interactive elements with synthesized selector + rect for semanticSnapshot', async () => {
    const elements = [
      { role: 'button', name: 'Save', tag: 'button', selector: '#save', rect: { x: 10, y: 20, width: 80, height: 30 } },
      {
        role: 'textbox',
        name: 'Email',
        tag: 'input',
        selector: '[data-testid="email"]',
        rect: { x: 0, y: 60, width: 200, height: 24 },
      },
    ];
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = typeof params?.expression === 'string' ? params.expression : '';
        if (expression === browserContextSensitiveFieldsExpression) return cdpEvaluateValue(false);
        if (expression.includes('innerText')) return cdpEvaluateValue('');
        return { result: { type: 'object', value: elements } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface, browserContext: contextRoutes(surface) });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'semanticSnapshot',
      navigationGeneration: 1,
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { elements?: ReadonlyArray<Record<string, unknown>> };
    expect(data.elements).toHaveLength(2);
    expect(data.elements?.[0]).toMatchObject({ role: 'button', name: 'Save', selector: '#save' });
    expect(data.elements?.[0]?.rect).toMatchObject({ x: 10, y: 20, width: 80, height: 30 });
    expect(data.elements?.[1]?.selector).toBe('[data-testid="email"]');
    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(true);
  });

  it.each([
    { url: 'https://example.test/reset-password?token=8f3a#access_token=private', expectedUrl: 'https://example.test/reset-password' },
    { url: 'https://example.test/search?q=private#private', expectedUrl: 'https://example.test/search?q' },
    { url: 'https://example.test/welcome', expectedUrl: 'https://example.test/welcome' },
    { url: 'not a URL?token=private', expectedUrl: undefined },
    { url: undefined, expectedUrl: undefined },
  ])('redacts secrets from the getStatus URL while preserving public status ($url)', async ({ url, expectedUrl }) => {
    const { surface } = fakeContextCapture(method => method === 'Page.getNavigationHistory'
      ? { currentIndex: 1, entries: [{ id: 1, url: 'https://example.test/previous' }, { id: 2, url, title: 'Current page' }] }
      : {});
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'getStatus',
      navigationGeneration: 7,
      payload: {},
    });

    expect(result).toEqual({ ok: true, data: {
      ...(expectedUrl ? { url: expectedUrl } : {}),
      title: 'Current page',
      navigationGeneration: 7,
    } });
  });

  it('fails a query view_closed when the page handle cannot be resolved', async () => {
    const { surface } = fakeContextCapture(() => ({}), () => null);
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'getStatus',
      navigationGeneration: 0,
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('view_closed');
  });

  it('resolves semantic and CSS locators through the production query and wait paths', async () => {
    const documentValue = createLocatorBridgeDocument();
    const { surface } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      return cdpEvaluateValue(evaluateBridgeExpression(expression, documentValue));
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    for (const selector of ['role=button[name="Save"]', 'text=Continue', 'data-testid=email-field', '#save']) {
      const result = await transport.dispatchPageQuery({
        ...view,
        actionKind: 'queryElements',
        navigationGeneration: 1,
        payload: { selector },
      });
      expect(result.ok, selector).toBe(true);
      if (!result.ok) continue;
      expect((result.data as { count?: number }).count, selector).toBe(1);
    }

    const waitResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'waitFor',
      navigationGeneration: 1,
      payload: { selector: 'role=button[name="Save"]' },
    });
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    expect(waitResult.data).toMatchObject({ present: true });
  });

  it.each(['role=button', 'text=Continue'])('queries every matching element for a semantic locator (%s)', async selector => {
    const elements = [10, 50].map(left => bridgeElement({ tagName: 'button', textContent: 'Continue',
      rect: { left, top: 10, width: 20, height: 20 } }));
    const documentValue = { querySelectorAll: () => elements };
    const { surface } = fakeContextCapture((method, params) => method === 'Runtime.evaluate'
      ? cdpEvaluateValue(evaluateBridgeExpression(String(params?.expression), documentValue)) : {});
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });
    expect(await transport.dispatchPageQuery({ ...view, actionKind: 'queryElements', navigationGeneration: 1, payload: { selector } }))
      .toMatchObject({ ok: true, data: { count: 2, elements: [{ tag: 'button', name: 'Continue' }, { tag: 'button', name: 'Continue' }], truncated: false } });
  });

  it('executes text locators against aggregate DOM text without targeting structural ancestors', async () => {
    const { documentValue } = createAggregateTextDocument();
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      return cdpEvaluateValue(evaluateBridgeExpression(expression, documentValue));
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const queryResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'queryElements',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;
    expect(queryResult.data).toMatchObject({
      count: 1,
      elements: [{ tag: 'button', name: 'Continue' }],
    });

    const waitResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'waitFor',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    expect(waitResult.data).toMatchObject({ present: true });

    const clickResult = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(clickResult?.ok).toBe(true);
    const pressed = calls.find((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(pressed?.params).toMatchObject({ x: 45, y: 20, button: 'left' });
  });

  // MCH-4: mutating input verbs dispatch CDP Input.* over the same transport.
  it('exposes dispatchInputCommand only when a context-capture surface is present', () => {
    expect(createControlAdapterAutomationTransport({ adapter: controlAdapter() }).dispatchInputCommand).toBeUndefined();
    const { surface } = fakeContextCapture(() => ({}));
    expect(
      createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }).dispatchInputCommand,
    ).toBeTypeOf('function');
  });

  it.each<Readonly<{
    tagName: string;
    textContent: string;
    attributes: Readonly<Record<string, string>>;
    selector: string;
    label: string | undefined;
  }>>([
    { tagName: 'button', textContent: 'Submit', attributes: {}, selector: '#submit', label: 'Submit' },
    { tagName: 'button', textContent: 'Continue', attributes: { 'aria-label': 'Sign in' }, selector: 'role=button[name="Sign in"]', label: 'Sign in' },
    { tagName: 'button', textContent: 'Open https://example.test/?token=private-value', attributes: {}, selector: '#submit', label: 'Open https://example.test/' },
    { tagName: 'input', textContent: 'password-value', attributes: { type: 'password', value: 'password-value' }, selector: '#submit', label: undefined },
    { tagName: 'textarea', textContent: 'typed-secret', attributes: {}, selector: '#submit', label: undefined },
    { tagName: 'div', textContent: 'typed-secret', attributes: { contenteditable: 'true' }, selector: '#submit', label: undefined },
  ])('dispatches a click to CDP Input.dispatchMouseEvent at the resolved element center ($tagName, $selector)', async ({ tagName, textContent, attributes, selector, label }) => {
    const element = bridgeElement({ tagName, textContent, attributes, rect: { left: 40, top: 20, width: 40, height: 40 } });
    const documentValue = { querySelector: () => element, querySelectorAll: () => [element] };
    const targets: unknown[] = [];
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression);
        // CDP is the boundary; execute the production page expression with its viewport.
        return cdpEvaluateValue(Function('document', 'innerWidth', 'innerHeight', `return ${expression};`)(documentValue, 200, 100));
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector },
      onActiveTarget: (target) => targets.push(target),
    });

    expect(result?.ok).toBe(true);
    const pressed = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
    expect(pressed?.params).toMatchObject({ x: 60, y: 40, button: 'left' });
    expect(targets).toEqual([{ x: 0.3, y: 0.4, width: 0.2, height: 0.4, ...(label ? { label } : {}) }]);
  });

  it('resolves semantic and CSS locators before dispatching input commands', async () => {
    const documentValue = createLocatorBridgeDocument();
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      return cdpEvaluateValue(evaluateBridgeExpression(expression, documentValue));
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    for (const selector of ['role=button[name="Save"]', 'text=Continue', 'data-testid=email-field', '#save']) {
      const result = await transport.dispatchInputCommand?.({
        ...view,
        actionKind: 'click',
        navigationGeneration: 1,
        payload: { selector },
      });
      expect(result?.ok, selector).toBe(true);
    }

    const pressEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(pressEvents).toHaveLength(4);
    for (const event of pressEvents) {
      expect(event.params).toMatchObject({ x: 40, y: 24, button: 'left' });
    }
  });

  it('inserts text via CDP Input.insertText for a type verb', async () => {
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'object', value: { x: 10, y: 10 } } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'type',
      navigationGeneration: 1,
      payload: { selector: '#name', text: 'hello' },
    });

    expect(result?.ok).toBe(true);
    const insert = calls.find((c) => c.method === 'Input.insertText');
    expect(insert?.params).toMatchObject({ text: 'hello' });
  });

  it('reports selector_not_found when a click target cannot be resolved', async () => {
    const { surface } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: null } };
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector: '#missing' },
    });

    expect(result?.ok).toBe(false);
    if (result?.ok) return;
    expect(result?.errorCode).toBe('selector_not_found');
  });
});

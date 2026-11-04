import {
  BrowserDiagnosticsElementPickerResultV1Schema,
  BrowserDiagnosticsEvalResultV1Schema,
  BrowserDiagnosticsGetPropertiesResultV1Schema,
  BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
} from '@happier-dev/protocol/browser/diagnostics/v1';
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceInputControl } from '../../surfaces/inputControl';
import { createBrowserSidecarCdpTransport } from '../sidecar/cdpTransport';
import type { LoopbackWebSocketJsonClientV1 } from '@/plugins/runtime/exec/privateContract';

import {
  createBrowserDiagnosticsInteractionTransport,
  type BrowserDiagnosticsInteractionContextCapture,
} from './interactionTransport';
import type {
  BrowserSidecarCdpEventNotification,
  BrowserSidecarCdpEventSubscriber,
  BrowserSidecarCdpPageHandle,
  BrowserSidecarViewLifecycleSubscriber,
} from '../sidecar/controlAdapter';

const BROWSER_SESSION_ID = 'browser_session_1';
const VIEW_ID = 'view_1';
const HANDLE: BrowserSidecarCdpPageHandle = { targetId: 'target_1', sessionId: 'cdp_session_1' };

type DispatchPageCommand = BrowserDiagnosticsInteractionContextCapture['transport']['dispatchPageCommand'];

type Harness = {
  contextCapture: BrowserDiagnosticsInteractionContextCapture;
  bindView: (view?: { browserSessionId?: string; viewId?: string }) => void;
  unbindView: (view?: { browserSessionId?: string; viewId?: string }) => void;
  emitCdpEvent: (notification: BrowserSidecarCdpEventNotification) => void;
  dispatchPageCommand: ReturnType<typeof vi.fn>;
  hasLifecycleListener: () => boolean;
  hasCdpListener: () => boolean;
  cdpListenerCount: () => number;
};

function createHarness(options: {
  responses?: Record<string, unknown>;
  resolveHandle?: (view: { browserSessionId: string; viewId: string }) => BrowserSidecarCdpPageHandle | null;
  withEvents?: boolean;
  onSetInspectMode?: (emit: (n: BrowserSidecarCdpEventNotification) => void) => void;
} = {}): Harness {
  const withEvents = options.withEvents ?? true;
  let lifecycleListener: BrowserSidecarViewLifecycleSubscriber | null = null;
  const cdpListeners = new Set<BrowserSidecarCdpEventSubscriber>();

  const emitCdpEvent = (notification: BrowserSidecarCdpEventNotification): void => {
    for (const listener of [...cdpListeners]) listener(notification);
  };

  const dispatchPageCommand = vi.fn<DispatchPageCommand>(async ({ method, params }) => {
    if (method === 'Overlay.setInspectMode' && params?.mode === 'searchForNode') {
      options.onSetInspectMode?.(emitCdpEvent);
    }
    if (options.responses && method in options.responses) {
      return options.responses[method];
    }
    return {};
  });

  const resolvePageHandle = options.resolveHandle
    ?? ((view) => (view.viewId === VIEW_ID && view.browserSessionId === BROWSER_SESSION_ID ? HANDLE : null));

  const contextCapture: BrowserDiagnosticsInteractionContextCapture = {
    transport: { dispatchPageCommand },
    resolvePageHandle,
    subscribeViewLifecycle: (listener) => {
      lifecycleListener = listener;
      return () => {
        lifecycleListener = null;
      };
    },
    ...(withEvents
      ? {
          subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
            cdpListeners.add(listener);
            return () => {
              cdpListeners.delete(listener);
            };
          },
        }
      : {}),
  };

  return {
    contextCapture,
    bindView: (view) =>
      lifecycleListener?.({
        type: 'bound',
        browserSessionId: view?.browserSessionId ?? BROWSER_SESSION_ID,
        viewId: view?.viewId ?? VIEW_ID,
      }),
    unbindView: (view) =>
      lifecycleListener?.({
        type: 'unbound',
        browserSessionId: view?.browserSessionId ?? BROWSER_SESSION_ID,
        viewId: view?.viewId ?? VIEW_ID,
      }),
    emitCdpEvent,
    dispatchPageCommand,
    hasLifecycleListener: () => lifecycleListener !== null,
    hasCdpListener: () => cdpListeners.size > 0,
    cdpListenerCount: () => cdpListeners.size,
  };
}

function evalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    evalRequestId: 'eval_1',
    viewId: VIEW_ID,
    navigationGeneration: 0,
    tier: 'cdp',
    expression: '1 + 1',

    objectGroupId: 'group_1',
    diagnosticsInteractionEnabled: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('browser diagnostics interaction transport (DIAG-INTERACTION)', () => {
  it('keeps same-name picker selection and confidentiality drains isolated by Session', async () => {
    const controls = { session_a: createSurfaceInputControl(), session_b: createSurfaceInputControl() };
    const harness = createHarness({ resolveHandle: view => ({ targetId: view.browserSessionId, sessionId: view.browserSessionId }) });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture,
      resolveInputControl: view => controls[view.browserSessionId as keyof typeof controls] });
    harness.bindView({ browserSessionId: 'session_a' });
    harness.bindView({ browserSessionId: 'session_b' });
    const request = { v: 1, pickerRequestId: 'picker', viewId: VIEW_ID, navigationGeneration: 0,
      tier: 'cdp', action: 'start', diagnosticsInteractionEnabled: true };
    let siblingSettled = false;
    const first = transport.dispatch('browser.diagnostics.elementPicker.start', request, 'session_a');
    const second = transport.dispatch('browser.diagnostics.elementPicker.start', request, 'session_b')
      .then(result => { siblingSettled = true; return result; });
    try {
      await vi.waitFor(() => expect(harness.dispatchPageCommand.mock.calls.filter(([command]) =>
        command.method === 'Overlay.setInspectMode' && command.params?.mode === 'searchForNode')).toHaveLength(2));
      await controls.session_a.beginConfidentialityHold();
      await expect(first).resolves.toMatchObject({ status: 'cancelled' });
      expect(siblingSettled).toBe(false);
      harness.emitCdpEvent({ sessionId: 'session_b', method: 'Overlay.inspectNodeRequested', params: { backendNodeId: 42 } });
      await expect(second).resolves.toMatchObject({ status: 'selected', backendNodeRef: '42' });
    } finally { await transport.dispose(); await Promise.all([first, second]); }
  });

  it('keeps scalar values and all expanded properties, and marks partial previews', async () => {
    const longValue = 'x'.repeat(70_000);
    const responses = {
      'Runtime.evaluate': { result: { type: 'string', value: longValue } },
      'Runtime.getProperties': { result: Array.from({ length: 101 }, (_, i) => ({
        name: `property_${i}`, enumerable: true, value: { type: 'string', value: longValue },
      })) },
    };
    const harness = createHarness({ responses });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    try {
      const scalar = BrowserDiagnosticsEvalResultV1Schema.parse(await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID));
      expect(scalar).toMatchObject({ status: 'completed', result: { type: 'string' } });
      expect(scalar.result?.value).toHaveLength(longValue.length);
      const expanded = BrowserDiagnosticsGetPropertiesResultV1Schema.parse(await transport.dispatch('browser.diagnostics.getProperties', {
        v: 1, propertyRequestId: 'properties', viewId: VIEW_ID, navigationGeneration: 0, tier: 'cdp',
        objectId: 'object', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
      }, BROWSER_SESSION_ID));
      expect(expanded.properties).toHaveLength(101);
      expect(expanded.properties[100]?.value.value).toHaveLength(longValue.length);
    } finally { await transport.dispose(); }
  });

  it('preserves every CDP preview property and marks engine overflow', async () => {
    const harness = createHarness({ responses: { 'Runtime.evaluate': { result: {
      type: 'object', objectId: 'object', preview: { overflow: true,
        properties: Array.from({ length: 12 }, (_, i) => ({ name: `property_${i}`, value: 'x'.repeat(1_500) })) },
    } } } });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    try {
      const result = BrowserDiagnosticsEvalResultV1Schema.parse(await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID));
      expect(result.result).toMatchObject({ previewTruncated: true });
      expect(result.result?.preview).toHaveLength(12);
      expect(result.result?.preview[11]?.valuePreview).toHaveLength(1_500);
    } finally { await transport.dispose(); }
  });

  it('runs long expressions without a deadline and cancels a pending eval at the engine', async () => {
    const harness = createHarness();
    const response = deferred<unknown>();
    const executing = deferred<void>();
    harness.dispatchPageCommand.mockImplementation(async ({ method }) => {
      if (method === 'Runtime.evaluate') { executing.resolve(); return response.promise; }
      return {};
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    const request = evalRequest({ expression: ' '.repeat(5_000) + 'new Promise(() => {})' });
    const pending = transport.dispatch('browser.diagnostics.eval', request, BROWSER_SESSION_ID);
    try {
      await executing.promise;
      const command = harness.dispatchPageCommand.mock.calls.find(([entry]) => entry.method === 'Runtime.evaluate')?.[0];
      expect(command?.params).not.toHaveProperty('timeout');
      const cancelled = await transport.dispatch('browser.diagnostics.eval', { ...request, action: 'cancel' }, BROWSER_SESSION_ID);
      expect(cancelled).toMatchObject({ status: 'cancelled' });
      await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
      expect(command?.signal?.aborted).toBe(true);
      expect(harness.dispatchPageCommand).toHaveBeenCalledWith(expect.objectContaining({ method: 'Runtime.terminateExecution' }));
    } finally { response.resolve({ result: { type: 'number', value: 1 } }); await pending; await transport.dispose(); }
  });

  it('honors cancellation while the engine is enabling before evaluation starts', async () => {
    const harness = createHarness();
    const enable = deferred<unknown>();
    const enabling = deferred<void>();
    harness.dispatchPageCommand.mockImplementation(async ({ method }) => {
      if (method === 'Runtime.enable') { enabling.resolve(); return enable.promise; }
      return { result: { type: 'number', value: 42 } };
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    const request = evalRequest();
    const pending = transport.dispatch('browser.diagnostics.eval', request, BROWSER_SESSION_ID);
    try {
      await enabling.promise;
      await transport.dispatch('browser.diagnostics.eval', { ...request, action: 'cancel' }, BROWSER_SESSION_ID);
      await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
      expect(harness.dispatchPageCommand.mock.calls.some(([command]) => command.method === 'Runtime.terminateExecution')).toBe(false);
      enable.resolve({});
      expect(harness.dispatchPageCommand.mock.calls.some(([command]) => command.method === 'Runtime.evaluate')).toBe(false);
    } finally { enable.resolve({}); await pending; await transport.dispose(); }
  });

  it('aborts the real CDP transport await when a pending evaluation is cancelled', async () => {
    const listeners = new Set<(message: unknown) => void | Promise<void>>();
    const evaluating = deferred<void>();
    // Only the JSON connection to Chromium is replaced; CDP request ownership stays real.
    const client: LoopbackWebSocketJsonClientV1 = {
      closed: new Promise<void>(() => {}),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async sendJson(message) {
        if (!message || typeof message !== 'object' || !('id' in message) || !('method' in message)) return;
        if (message.method === 'Runtime.evaluate') { evaluating.resolve(); return; }
        for (const listener of listeners) await listener({ id: message.id, result: {} });
      },
    };
    const cdp = createBrowserSidecarCdpTransport({ client });
    const harness = createHarness();
    let wireOutcome = 'pending';
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: {
      ...harness.contextCapture,
      transport: { dispatchPageCommand(command) {
        const pending = cdp.dispatchPageCommand(command);
        if (command.method === 'Runtime.evaluate') void pending.then(
          () => { wireOutcome = 'completed'; }, error => { wireOutcome = error instanceof Error ? error.name : 'unknown'; });
        return pending;
      } },
    } });
    harness.bindView();
    const request = evalRequest();
    const pending = transport.dispatch('browser.diagnostics.eval', request, BROWSER_SESSION_ID);
    try {
      await evaluating.promise;
      await transport.dispatch('browser.diagnostics.eval', { ...request, action: 'cancel' }, BROWSER_SESSION_ID);
      await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
      await vi.waitFor(() => expect(wireOutcome).toBe('AbortError'));
    } finally { await transport.dispose(); cdp.dispose(); await pending; }
  });

  it('refuses injected-page eval at the CDP-only engine without executing a Machine effect', async () => {
    const harness = createHarness({ responses: {
      'Runtime.evaluate': { result: { type: 'number', value: 2 } },
    } });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    try {
      const result = BrowserDiagnosticsEvalResultV1Schema.parse(await transport.dispatch(
        'browser.diagnostics.eval', evalRequest({ tier: 'injectedPage' }), BROWSER_SESSION_ID,
      ));
      expect(result).toMatchObject({ status: 'blocked', errorCode: 'adapter_unavailable', tier: 'injectedPage' });
      expect(harness.dispatchPageCommand).not.toHaveBeenCalled();
    } finally { await transport.dispose(); }
  });

  it('drains a queued debugger mutation and refuses further held debugger input', async () => {
    const control = createSurfaceInputControl();
    const entered = deferred<void>();
    const response = deferred<unknown>();
    const harness = createHarness();
    harness.dispatchPageCommand.mockImplementation(async input => {
      if (input.method === 'Debugger.pause') { entered.resolve(); return response.promise; }
      return {};
    });
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture, resolveInputControl: () => control,
    });
    harness.bindView();
    const read = transport.dispatch('browser.diagnostics.pause', { viewId: VIEW_ID, browserSessionId: BROWSER_SESSION_ID }, BROWSER_SESSION_ID);
    await entered.promise;
    let drained = false;
    const hold = control.beginConfidentialityHold().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    response.resolve({});
    expect(await read).toMatchObject({ ok: false });
    await hold;
    const count = harness.dispatchPageCommand.mock.calls.length;
    expect(await transport.dispatch('browser.diagnostics.pause', { viewId: VIEW_ID }, BROWSER_SESSION_ID)).toMatchObject({ ok: false });
    expect(await transport.dispatch('browser.diagnostics.resume', { viewId: VIEW_ID }, BROWSER_SESSION_ID)).toMatchObject({ ok: false });
    expect(harness.dispatchPageCommand.mock.calls).toHaveLength(count);
    await transport.dispose();
  });

  it('drains and suppresses queued eval output then refuses held eval and property reads', async () => {
    const harness = createHarness();
    const control = createSurfaceInputControl();
    const value = deferred<unknown>();
    const entered = deferred<void>();
    harness.dispatchPageCommand.mockImplementation(async input => {
      if (input.method === 'Runtime.evaluate') { entered.resolve(); return value.promise; }
      return {};
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture,
      resolveInputControl: () => control });
    harness.bindView();
    const read = transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID);
    await entered.promise;
    let drained = false;
    const hold = control.beginConfidentialityHold().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    value.resolve({ result: { type: 'string', value: 'fixture-secret' } });
    const result = await read;
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result).toMatchObject({ status: 'failed' });
    await hold;
    const count = harness.dispatchPageCommand.mock.calls.length;
    expect(await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID)).toMatchObject({ status: 'failed' });
    expect(await transport.dispatch('browser.diagnostics.getProperties', {
      v: 1, propertyRequestId: 'property_held', viewId: VIEW_ID, navigationGeneration: 0,
      tier: 'cdp', objectId: 'field', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)).toMatchObject({ status: 'failed', properties: [] });
    expect(harness.dispatchPageCommand.mock.calls).toHaveLength(count);
    await transport.dispose?.();
  });

  it('does not publish credential-echoing boundary errors after observation was held', async () => {
    const control = createSurfaceInputControl();
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const harness = createHarness();
    harness.dispatchPageCommand.mockImplementation(async input => {
      if (input.method === 'Runtime.evaluate') { entered.resolve(); return response.promise; }
      return {};
    });
    const onError = vi.fn();
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture, resolveInputControl: () => control, onError,
    });
    harness.bindView();
    const read = transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID);
    await entered.promise;
    const hold = control.beginConfidentialityHold();
    response.reject(new Error('fixture-secret'));
    expect(await read).toMatchObject({ status: 'failed' });
    await hold;
    expect(onError).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('cancels a pending element picker before confidentiality drain settles', async () => {
    const control = createSurfaceInputControl();
    const entered = deferred<void>();
    const harness = createHarness({ onSetInspectMode: () => { entered.resolve(); } });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture,
      resolveInputControl: () => control });
    harness.bindView();
    const picker = transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1, pickerRequestId: 'picker_held', viewId: VIEW_ID, navigationGeneration: 0,
      tier: 'cdp', action: 'start', diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID);
    await entered.promise;
    try {
      await control.beginConfidentialityHold();
      expect(harness.dispatchPageCommand).toHaveBeenCalledWith(expect.objectContaining({
        method: 'Overlay.setInspectMode', params: { mode: 'none' },
      }));
      expect(await picker).toMatchObject({ status: 'cancelled' });
    } finally { await transport.dispose?.(); }
  });

  it('maps eval to Runtime.evaluate and returns a completed remote-object result', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': { result: { type: 'number', value: 2, description: '2' } },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID);

    // The live result must strictly satisfy the canonical output contract the front door enforces.
    expect(() => BrowserDiagnosticsEvalResultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({
      v: 1,
      evalRequestId: 'eval_1',
      viewId: VIEW_ID,
      status: 'completed',
      tier: 'cdp',
      audited: true,
      result: { type: 'number', value: 2 },
    });
    const evaluateCall = harness.dispatchPageCommand.mock.calls.find(([arg]) => arg.method === 'Runtime.evaluate');
    expect(evaluateCall?.[0]).toMatchObject({
      targetId: 'target_1',
      sessionId: 'cdp_session_1',
      params: { expression: '1 + 1', objectGroup: 'group_1', returnByValue: false },
    });
  });

  it('reports a failed eval when CDP returns exceptionDetails (no fake completion)', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': {
          exceptionDetails: { exception: { type: 'object', objectId: 'err_1', className: 'TypeError' } },
        },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = (await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID)) as { status: string; result?: unknown };
    expect(result.status).toBe('failed');
    expect(result.result).toMatchObject({ type: 'object', objectId: 'err_1' });
  });

  it('fails closed with target_detached when no live page handle resolves for the view', async () => {
    const harness = createHarness({ resolveHandle: () => null });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });

    const result = (await transport.dispatch('browser.diagnostics.eval', evalRequest(), BROWSER_SESSION_ID)) as { status: string; errorCode?: string };
    expect(result).toMatchObject({ status: 'failed', errorCode: 'target_detached' });
    expect(harness.dispatchPageCommand).not.toHaveBeenCalled();
  });

  it('maps getProperties to Runtime.getProperties and projects own enumerable properties', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.getProperties': {
          result: [
            { name: 'count', value: { type: 'number', value: 42 }, enumerable: true },
            { name: 'label', value: { type: 'string', value: 'hello' }, enumerable: false },
            { name: 'accessor', enumerable: true }, // no value descriptor → skipped
          ],
        },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = (await transport.dispatch('browser.diagnostics.getProperties', {
      v: 1,
      propertyRequestId: 'prop_1',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      objectId: 'object_1',
      objectGroupId: 'group_1',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)) as { status: string; objectId: string; properties: ReadonlyArray<{ name: string }> };

    expect(() => BrowserDiagnosticsGetPropertiesResultV1Schema.parse(result)).not.toThrow();
    expect(result.status).toBe('completed');
    expect(result.objectId).toBe('object_1');
    expect(result.properties.map((property) => property.name)).toEqual(['count', 'label']);
  });

  it('maps releaseObjectGroup to Runtime.releaseObjectGroup', async () => {
    const harness = createHarness({ responses: { 'Runtime.releaseObjectGroup': {} } });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = (await transport.dispatch('browser.diagnostics.releaseObjectGroup', {
      v: 1,
      releaseRequestId: 'release_1',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      objectGroupId: 'group_1',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)) as { status: string; objectGroupId: string };

    expect(() => BrowserDiagnosticsReleaseObjectGroupResultV1Schema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ status: 'completed', objectGroupId: 'group_1' });
    expect(harness.dispatchPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'Runtime.releaseObjectGroup', params: { objectGroup: 'group_1' } }),
    );
  });

  it('releases tracked object groups on CDP navigation events and view close', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': { result: { type: 'object', objectId: 'object_1', className: 'Object' } },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const releasedGroups = () => harness.dispatchPageCommand.mock.calls
      .filter(([arg]) => arg.method === 'Runtime.releaseObjectGroup')
      .map(([arg]) => String(arg.params?.objectGroup ?? ''));

    await transport.dispatch('browser.diagnostics.eval', evalRequest({ objectGroupId: 'group_same_document' }), BROWSER_SESSION_ID);
    harness.emitCdpEvent({
      method: 'Page.navigatedWithinDocument',
      params: { url: 'https://browser.example.test/#next' },
      sessionId: 'cdp_session_1',
    });
    await vi.waitFor(() => {
      expect(releasedGroups()).toContain('group_same_document');
    });
    await expect(transport.dispatch('browser.diagnostics.getProperties', {
      v: 1,
      propertyRequestId: 'prop_stale_same_document',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      objectId: 'object_1',
      objectGroupId: 'group_same_document',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'navigation_stale',
      properties: [],
    });

    await transport.dispatch('browser.diagnostics.eval', evalRequest({
      evalRequestId: 'eval_full_navigation',
      objectGroupId: 'group_full_navigation',
    }), BROWSER_SESSION_ID);
    harness.emitCdpEvent({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'frame_1', parentId: undefined, url: 'https://browser.example.test/next' } },
      sessionId: 'cdp_session_1',
    });
    await vi.waitFor(() => {
      expect(releasedGroups()).toContain('group_full_navigation');
    });

    await transport.dispatch('browser.diagnostics.eval', evalRequest({
      evalRequestId: 'eval_close',
      objectGroupId: 'group_view_close',
    }), BROWSER_SESSION_ID);
    harness.unbindView();
    await vi.waitFor(() => {
      expect(releasedGroups()).toContain('group_view_close');
    });
  });

  it('preserves live object groups until their lifecycle owner releases them', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': { result: { type: 'object', objectId: 'object_1', className: 'Object' } },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    for (let index = 0; index < 520; index += 1) {
      await transport.dispatch('browser.diagnostics.eval', evalRequest({
        evalRequestId: `eval_${index}`,
        objectGroupId: `group_${index}`,
      }), BROWSER_SESSION_ID);
    }

    const releasedGroups = () => harness.dispatchPageCommand.mock.calls
      .filter(([arg]) => arg.method === 'Runtime.releaseObjectGroup')
      .map(([arg]) => String(arg.params?.objectGroup ?? ''));
    expect(releasedGroups()).toEqual([]);
    await transport.dispose();
    expect(new Set(releasedGroups())).toEqual(new Set(Array.from({ length: 520 }, (_, index) => `group_${index}`)));
  });

  it('maps pause to Debugger.pause and resume to Debugger.resume using the input browserSessionId', async () => {
    const harness = createHarness();
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });

    const paused = await transport.dispatch('browser.diagnostics.pause', {
      browserSessionId: BROWSER_SESSION_ID,
      viewId: VIEW_ID,
    }, BROWSER_SESSION_ID);
    const resumed = await transport.dispatch('browser.diagnostics.resume', {
      browserSessionId: BROWSER_SESSION_ID,
      viewId: VIEW_ID,
    }, BROWSER_SESSION_ID);

    expect(paused).toMatchObject({ ok: true, status: 'paused' });
    expect(resumed).toMatchObject({ ok: true, status: 'resumed' });
    const methods = harness.dispatchPageCommand.mock.calls.map(([arg]) => arg.method);
    expect(methods).toContain('Debugger.pause');
    expect(methods).toContain('Debugger.resume');
  });

  it('drives the element picker via Overlay and resolves the selected backend node', async () => {
    const harness = createHarness({
      onSetInspectMode: (emit) =>
        emit({ method: 'Overlay.inspectNodeRequested', params: { backendNodeId: 99 }, sessionId: 'cdp_session_1' }),
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = (await transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1,
      pickerRequestId: 'picker_1',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)) as { status: string; backendNodeRef?: string };

    expect(() => BrowserDiagnosticsElementPickerResultV1Schema.parse(result)).not.toThrow();
    expect(result.status).toBe('selected');
    expect(result.backendNodeRef).toBe('99');
    const methods = harness.dispatchPageCommand.mock.calls.map(([arg]) => arg.method);
    expect(methods).toContain('Overlay.setInspectMode');
    // Inspect mode is disengaged after selection.
    expect(
      harness.dispatchPageCommand.mock.calls.some(([arg]) => arg.method === 'Overlay.setInspectMode' && arg.params?.mode === 'none'),
    ).toBe(true);
  });

  it('cancels the element picker (and interrupts a standing start)', async () => {
    const harness = createHarness();
    // A generous picker timeout proves the start resolves via the cancel interrupt, not a timeout.
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture,

    });
    harness.bindView();

    const startPromise = transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1,
      pickerRequestId: 'picker_1',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID);
    // Allow the start dispatch to engage inspect mode (register the pending picker) before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelResult = (await transport.dispatch('browser.diagnostics.elementPicker.cancel', {
      v: 1,
      pickerRequestId: 'picker_2',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'cancel',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)) as { status: string };

    const startResult = (await startPromise) as { status: string };
    expect(cancelResult.status).toBe('cancelled');
    expect(startResult.status).toBe('cancelled');
  });

  it('keeps a picker pending beyond sixty seconds until the person cancels', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    let settled = false;
    const request = { v: 1, pickerRequestId: 'long-picker', viewId: VIEW_ID, navigationGeneration: 0,
      tier: 'cdp', action: 'start', diagnosticsInteractionEnabled: true };
    const pending = transport.dispatch('browser.diagnostics.elementPicker.start', request, BROWSER_SESSION_ID)
      .then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled).toBe(false);
      await transport.dispatch('browser.diagnostics.elementPicker.cancel', { ...request, action: 'cancel' }, BROWSER_SESSION_ID);
      expect(await pending).toMatchObject({ status: 'cancelled' });
    } finally { await transport.dispose(); vi.useRealTimers(); }
  });

  it('fails the picker closed when the sidecar exposes no CDP event stream', async () => {
    const harness = createHarness({ withEvents: false });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = (await transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1,
      pickerRequestId: 'picker_1',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID)) as { status: string; errorCode?: string };

    expect(result).toMatchObject({ status: 'failed', errorCode: 'collector_unavailable' });
  });

  it('disposes lifecycle/event subscriptions, pending pickers, and tracked object groups', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': { result: { type: 'object', objectId: 'object_1', className: 'Object' } },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture,

    });
    harness.bindView();

    await transport.dispatch('browser.diagnostics.eval', evalRequest({ objectGroupId: 'group_dispose' }), BROWSER_SESSION_ID);
    const pickerStart = transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1,
      pickerRequestId: 'picker_dispose',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    }, BROWSER_SESSION_ID);
    await vi.waitFor(() => {
      expect(harness.hasLifecycleListener()).toBe(true);
      expect(harness.hasCdpListener()).toBe(true);
    });

    const dispose = (transport as { dispose?: () => void | Promise<void> }).dispose;
    expect(dispose).toBeTypeOf('function');
    await dispose?.();

    await expect(pickerStart).resolves.toMatchObject({ status: 'cancelled' });
    expect(harness.hasLifecycleListener()).toBe(false);
    expect(harness.hasCdpListener()).toBe(false);
    expect(harness.dispatchPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'Runtime.releaseObjectGroup',
        params: { objectGroup: 'group_dispose' },
      }),
    );
    expect(
      harness.dispatchPageCommand.mock.calls.some(
        ([arg]) => arg.method === 'Overlay.setInspectMode' && arg.params?.mode === 'none',
      ),
    ).toBe(true);

    const afterDispose = await transport.dispatch(
      'browser.diagnostics.eval',
      evalRequest({ evalRequestId: 'eval_after_dispose' }), BROWSER_SESSION_ID,
    );
    expect(afterDispose).toMatchObject({ status: 'failed', errorCode: 'target_detached' });
  });

  it('cancels replaced pending pickers so dispose cannot leave stale event subscriptions', async () => {
    const harness = createHarness();
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture,

    });
    harness.bindView();
    const baselineCdpListenerCount = harness.cdpListenerCount();

    let firstStart: Promise<unknown> | null = null;
    let secondStart: Promise<unknown> | null = null;
    try {
      firstStart = transport.dispatch('browser.diagnostics.elementPicker.start', {
        v: 1,
        pickerRequestId: 'picker_first',
        viewId: VIEW_ID,
        navigationGeneration: 0,
        tier: 'cdp',
        action: 'start',
        diagnosticsInteractionEnabled: true,
      }, BROWSER_SESSION_ID);
      await vi.waitFor(() => expect(harness.cdpListenerCount()).toBe(baselineCdpListenerCount + 1));

      secondStart = transport.dispatch('browser.diagnostics.elementPicker.start', {
        v: 1,
        pickerRequestId: 'picker_second',
        viewId: VIEW_ID,
        navigationGeneration: 0,
        tier: 'cdp',
        action: 'start',
        diagnosticsInteractionEnabled: true,
      }, BROWSER_SESSION_ID);
      await vi.waitFor(() => {
        const inspectStarts = harness.dispatchPageCommand.mock.calls.filter(
          ([arg]) => arg.method === 'Overlay.setInspectMode' && arg.params?.mode === 'searchForNode',
        );
        expect(inspectStarts).toHaveLength(2);
      });

      expect(harness.cdpListenerCount()).toBe(baselineCdpListenerCount + 1);
    } finally {
      await transport.dispose();
      await firstStart;
      await secondStart;
    }

    expect(harness.cdpListenerCount()).toBe(0);
  });

  it('cancels in-flight evaluation and releases its group before disposal completes', async () => {
    const evalResponse = deferred<unknown>();
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': evalResponse.promise,
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture,
    });
    harness.bindView();

    const evalPromise = transport.dispatch(
      'browser.diagnostics.eval',
      evalRequest({ objectGroupId: 'group_inflight' }), BROWSER_SESSION_ID,
    );
    await vi.waitFor(() => {
      expect(harness.dispatchPageCommand.mock.calls.some(([arg]) => arg.method === 'Runtime.evaluate')).toBe(true);
    });

    let disposeCompleted = false;
    const disposePromise = Promise.resolve(transport.dispose()).then(() => {
      disposeCompleted = true;
    });
    await Promise.resolve();
    expect(disposeCompleted).toBe(false);

    await disposePromise;
    await expect(evalPromise).resolves.toMatchObject({ status: 'cancelled' });
    evalResponse.resolve({ result: { type: 'object', objectId: 'object_inflight', className: 'Object' } });
    expect(harness.dispatchPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'Runtime.releaseObjectGroup',
        params: { objectGroup: 'group_inflight' },
      }),
    );
  });

  it('terminates each affected runtime once when disposal cancels several pending evaluations', async () => {
    const response = deferred<unknown>();
    const harness = createHarness({ responses: { 'Runtime.evaluate': response.promise } });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();
    const pending = ['first', 'second'].map(evalRequestId => transport.dispatch('browser.diagnostics.eval',
      evalRequest({ evalRequestId, objectGroupId: evalRequestId }), BROWSER_SESSION_ID));
    try {
      await vi.waitFor(() => expect(harness.dispatchPageCommand.mock.calls.filter(([command]) => command.method === 'Runtime.evaluate')).toHaveLength(2));
      await transport.dispose();
      expect(await Promise.all(pending)).toEqual([expect.objectContaining({ status: 'cancelled' }), expect.objectContaining({ status: 'cancelled' })]);
      expect(harness.dispatchPageCommand.mock.calls.filter(([command]) => command.method === 'Runtime.terminateExecution')).toHaveLength(1);
    } finally { response.resolve({}); await transport.dispose(); await Promise.all(pending); }
  });
});

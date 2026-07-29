import {
  BrowserDiagnosticsElementPickerResultV1Schema,
  BrowserDiagnosticsEvalResultV1Schema,
  BrowserDiagnosticsGetPropertiesResultV1Schema,
  BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

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

type DispatchPageCommand = (
  input: BrowserSidecarCdpPageHandle & Readonly<{ method: string; params?: Record<string, unknown> }>,
) => Promise<unknown>;

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
    timeoutMs: 2000,
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
  it('maps eval to Runtime.evaluate and returns a completed remote-object result', async () => {
    const harness = createHarness({
      responses: {
        'Runtime.evaluate': { result: { type: 'number', value: 2, description: '2' } },
      },
    });
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });
    harness.bindView();

    const result = await transport.dispatch('browser.diagnostics.eval', evalRequest());

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

    const result = (await transport.dispatch('browser.diagnostics.eval', evalRequest())) as { status: string; result?: unknown };
    expect(result.status).toBe('failed');
    expect(result.result).toMatchObject({ type: 'object', objectId: 'err_1' });
  });

  it('fails closed with target_detached when no live page handle resolves for the view', async () => {
    const harness = createHarness();
    // No bindView() ⇒ the viewId cannot resolve a browserSessionId.
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });

    const result = (await transport.dispatch('browser.diagnostics.eval', evalRequest())) as { status: string; errorCode?: string };
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
    })) as { status: string; objectId: string; properties: ReadonlyArray<{ name: string }> };

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
    })) as { status: string; objectGroupId: string };

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

    await transport.dispatch('browser.diagnostics.eval', evalRequest({ objectGroupId: 'group_same_document' }));
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
    })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'navigation_stale',
      properties: [],
    });

    await transport.dispatch('browser.diagnostics.eval', evalRequest({
      evalRequestId: 'eval_full_navigation',
      objectGroupId: 'group_full_navigation',
    }));
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
    }));
    harness.unbindView();
    await vi.waitFor(() => {
      expect(releasedGroups()).toContain('group_view_close');
    });
  });

  it('auto-releases least-recently tracked object groups when a client never releases them', async () => {
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
      }));
    }

    await vi.waitFor(() => {
      const releasedGroups = harness.dispatchPageCommand.mock.calls
        .filter(([arg]) => arg.method === 'Runtime.releaseObjectGroup')
        .map(([arg]) => String(arg.params?.objectGroup ?? ''));
      expect(releasedGroups).toEqual([
        'group_0',
        'group_1',
        'group_2',
        'group_3',
        'group_4',
        'group_5',
        'group_6',
        'group_7',
      ]);
    });
  });

  it('maps pause to Debugger.pause and resume to Debugger.resume using the input browserSessionId', async () => {
    const harness = createHarness();
    const transport = createBrowserDiagnosticsInteractionTransport({ contextCapture: harness.contextCapture });

    const paused = await transport.dispatch('browser.diagnostics.pause', {
      browserSessionId: BROWSER_SESSION_ID,
      viewId: VIEW_ID,
    });
    const resumed = await transport.dispatch('browser.diagnostics.resume', {
      browserSessionId: BROWSER_SESSION_ID,
      viewId: VIEW_ID,
    });

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
    })) as { status: string; backendNodeRef?: string };

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
      pickerTimeoutMs: 5000,
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
    });
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
    })) as { status: string };

    const startResult = (await startPromise) as { status: string };
    expect(cancelResult.status).toBe('cancelled');
    expect(startResult.status).toBe('cancelled');
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
    })) as { status: string; errorCode?: string };

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
      pickerTimeoutMs: 60_000,
    });
    harness.bindView();

    await transport.dispatch('browser.diagnostics.eval', evalRequest({ objectGroupId: 'group_dispose' }));
    const pickerStart = transport.dispatch('browser.diagnostics.elementPicker.start', {
      v: 1,
      pickerRequestId: 'picker_dispose',
      viewId: VIEW_ID,
      navigationGeneration: 0,
      tier: 'cdp',
      action: 'start',
      diagnosticsInteractionEnabled: true,
    });
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
      evalRequest({ evalRequestId: 'eval_after_dispose' }),
    );
    expect(afterDispose).toMatchObject({ status: 'failed', errorCode: 'target_detached' });
  });

  it('cancels replaced pending pickers so dispose cannot leave stale event subscriptions', async () => {
    const harness = createHarness();
    const transport = createBrowserDiagnosticsInteractionTransport({
      contextCapture: harness.contextCapture,
      pickerTimeoutMs: 200,
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
      });
      await vi.waitFor(() => expect(harness.cdpListenerCount()).toBe(baselineCdpListenerCount + 1));

      secondStart = transport.dispatch('browser.diagnostics.elementPicker.start', {
        v: 1,
        pickerRequestId: 'picker_second',
        viewId: VIEW_ID,
        navigationGeneration: 0,
        tier: 'cdp',
        action: 'start',
        diagnosticsInteractionEnabled: true,
      });
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

  it('waits for in-flight eval cleanup before disposal completes', async () => {
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
      evalRequest({ objectGroupId: 'group_inflight' }),
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

    evalResponse.resolve({ result: { type: 'object', objectId: 'object_inflight', className: 'Object' } });

    await disposePromise;
    await evalPromise;
    expect(harness.dispatchPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'Runtime.releaseObjectGroup',
        params: { objectGroup: 'group_inflight' },
      }),
    );
  });
});

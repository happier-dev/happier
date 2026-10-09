import {
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  type BrowserAutomationActionRequestV1,
} from '@happier-dev/protocol/browser/automation/v1';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationDaemonService } from './service';
import type { BrowserAutomationAdapter } from './adapters/types';
import { createBrowserAutomationCdpAdapter } from './adapters/cdp';
import { createBrowserAutomationOwnerRegistry } from './owners';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const agentRef = { kind: 'agent', id: 'agent_1' } as const;
const pluginRef = { kind: 'plugin', id: 'plugin_1' } as const;
type ViewLifecycleEvent = Readonly<{
  type: 'bound' | 'unbound';
  browserSessionId: string;
  viewId: string;
  sourceDestroyed?: boolean;
}>;

function readOnlyAdapter(): BrowserAutomationAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    execute: vi.fn(async () => ({
      status: 'succeeded' as const,
      fidelity: 'cdp' as const,
      trustedInput: true,
      resultSummary: { nodes: 3 },
    })),
  };
}

function request(
  overrides: Partial<BrowserAutomationActionRequestV1> = {},
): BrowserAutomationActionRequestV1 {
  return {
    v: 1,
    automationRequestId: `req_${Math.random().toString(36).slice(2)}`,
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 0,
    requestedBy: 'agent',
    requesterRef: agentRef,
    actionKind: 'snapshot',
    payload: {},
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation daemon service', () => {
  it('preserves the physical producer native observation qualification on a prepared target', async () => {
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: () => true,
      dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
      dispatchPageQuery: async () => ({ ok: true }),
      // This is the physical CDP transport boundary; the service and shared input owner remain real.
      prepareConfidentialFill: async () => ({ nativeObservation: 'not_observable',
        recheck: async () => true, fill: async () => ({ status: 'filled', code: 'filled' }),
        finish: async () => undefined,
      }),
    } }) });
    const target = await service.prepareConfidentialFill({
      serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in', ...view,
      tabId: 'tab', frameId: 'frame', documentId: 'document', navigationGeneration: 0,
      origin: 'https://example.test', field: { fieldId: '1', focusId: '1', locator: '#password' },
    }, { authority: 'present_user', actionCaller: { kind: 'host' } });
    try {
      expect(target).toMatchObject({ nativeObservation: 'not_observable' });
    } finally { if (!('status' in target)) await target.finish(); service.dispose(); }
  });
  it('refuses another confidential preparation while one is still active', async () => {
    const owners = createBrowserAutomationOwnerRegistry();
    const physicalPreparation: string[] = [];
    let releasePreparation: () => void = () => undefined;
    const preparing = new Promise<void>(resolve => { releasePreparation = resolve; });
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const service = createBrowserAutomationDaemonService({ owners, adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: () => true,
      dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
      dispatchPageQuery: async () => ({ ok: true }),
      prepareConfidentialFill: async () => {
        physicalPreparation.push('prepare');
        resolveStarted();
        await preparing;
        return { recheck: async () => true, fill: async () => ({ status: 'filled', code: 'filled' }),
          finish: async () => undefined };
      },
    } }) });
    const confidentialRequest = {
        serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in', ...view,
        tabId: 'tab', frameId: 'frame', documentId: 'document', navigationGeneration: 0,
        origin: 'https://example.test', field: { fieldId: '1', focusId: '1', locator: '#password' },
    };
    const firstPreparation = service.prepareConfidentialFill(confidentialRequest, { authority: 'present_user', actionCaller: { kind: 'host' } });
    await started;
    const overlapping = service.prepareConfidentialFill(confidentialRequest,
      { authority: 'present_user', actionCaller: { kind: 'host' } });
    releasePreparation();
    const first = await firstPreparation;
    try {
      expect(await overlapping).toEqual({ status: 'refused', code: 'observation_unavailable' });
      expect('status' in first).toBe(false);
      expect(await service.prepareConfidentialFill(confidentialRequest,
        { authority: 'present_user', actionCaller: { kind: 'host' } })).toEqual({ status: 'refused', code: 'observation_unavailable' });
      expect(physicalPreparation).toEqual(['prepare']);
      expect(owners.isObservationHeld(view)).toBe(true);
    } finally { if (!('status' in first)) await first.finish(); service.dispose(); }
  });

  it.each(['filled', 'unknown'] as const)('preserves older confidentiality and admits fresh human input only after known %s settlement', async firstStatus => {
    const owners = createBrowserAutomationOwnerRegistry();
    let preparation = 0;
    let physicalFills = 0;
    const service = createBrowserAutomationDaemonService({ owners, adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: () => true,
      dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
      dispatchPageQuery: async () => ({ ok: true }),
      prepareConfidentialFill: async () => {
        const ordinal = ++preparation;
        return { recheck: async () => true,
          isSafe: async () => ordinal === 3,
          fill: async () => { physicalFills += 1; return ordinal === 3 ? { status: 'refused', code: 'target_changed' }
            : ordinal === 1 && firstStatus === 'unknown' ? { status: 'unknown', code: 'delivery_unknown' }
              : { status: 'filled', code: 'filled' }; },
          finish: async () => undefined,
        };
      },
    } }) });
    try {
      for (const [index, locator] of ['#username', '#password', '#declined'].entries()) {
        const target = await service.prepareConfidentialFill({
          serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in', ...view,
          tabId: 'tab', frameId: 'frame', documentId: 'document', navigationGeneration: 0,
          origin: 'https://example.test', field: { fieldId: String(index + 1), focusId: String(index + 1), locator },
        }, { authority: 'present_user', actionCaller: { kind: 'host' } });
        expect('status' in target).toBe(false);
        if ('status' in target) throw new Error('expected independently approved physical target');
        try {
          expect(await target.fill(new Uint8Array([1]))).toMatchObject({
            status: index === 0 ? firstStatus : firstStatus === 'unknown' ? 'refused' : index === 1 ? 'filled' : 'refused',
          });
        } finally { await target.finish(); }
        expect(owners.isObservationHeld(view)).toBe(true);
      }
      expect(preparation).toBe(3);
      expect(physicalFills).toBe(firstStatus === 'unknown' ? 1 : 3);
      expect(service.getStatus(view).uncertain).toBe(firstStatus === 'unknown');
      if (firstStatus === 'unknown') {
        expect(owners.getInputControl(view).observe(owners.getControlEpoch(view))).toBe(false);
        expect(service.getInputControl(view).getAdmissionFailure('human')).toBe('uncertain');
      }
      expect(await service.execute(request())).toMatchObject({ status: 'failed', errorCode: 'policy_denied' });
    } finally { service.dispose(); }
  });
  it('publishes the active target only while its admitted action owns the page', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const target = { x: 0.5, y: 0.5, width: 0.2, height: 0.1 };
    const service = createBrowserAutomationDaemonService({ adapter: { adapterKind: 'chromiumSidecar',
      execute: async (_request, context) => {
        context?.onActiveTarget?.(target);
        await pending;
        context?.onActiveTarget?.(target); // A late native callback after takeover must not revive it.
        return { status: 'succeeded', fidelity: 'cdp', trustedInput: true };
      } } });
    const events: unknown[] = [];
    service.subscribeBrowserEvents(event => events.push(event));
    try {
      const action = service.execute(request({ actionKind: 'click', payload: { selector: '#go' } }));
      expect(service.getStatus(view)).toMatchObject({ activeActionKind: 'click', activeTarget: target });
      const takeover = service.recordHumanInput({ ...view, authority: 'present_user' });
      expect(service.getStatus(view).activeTarget).toBeUndefined();
      release(); await action; await takeover;
      expect(service.getStatus(view).activeTarget).toBeUndefined();
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'controllerChanged', state: expect.objectContaining({ activeTarget: target }) })]));
    } finally { release(); service.dispose(); }
  });
  it('executes a read-only snapshot without a lease and records a timeline entry', async () => {
    const service = createBrowserAutomationDaemonService({ adapter: readOnlyAdapter() });

    const result = await service.execute(request({ actionKind: 'snapshot' }));

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('succeeded');

    const timeline = service.getTimeline(view);
    expect(BrowserAutomationTimelineV1Schema.safeParse(timeline).success).toBe(true);
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]?.actionKind).toBe('snapshot');
  });

  it('executes a mutating action with nothing to acquire first', async () => {
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      execute: vi.fn(async () => ({ status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false })),
    };
    const service = createBrowserAutomationDaemonService({ adapter });

    const result = await service.execute(
      request({ actionKind: 'navigate', payload: { url: 'https://x.test/' } }),
    );

    expect(result.status).toBe('succeeded');
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it('refuses a second concurrent mutating action while one is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      execute: vi.fn(async () => {
        await gate;
        return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false };
      }),
    };
    const service = createBrowserAutomationDaemonService({ adapter });

    const first = service.execute(request({ actionKind: 'click', payload: { selector: '#go' } }));
    const second = await service.execute(request({ actionKind: 'type', payload: { text: 'hi' } }));

    expect(second.status).toBe('failed');
    expect(second.errorCode).toBe('automation_busy');

    release();
    await first;

    // Single-flight releases when the first action settles: the view is dispatchable again.
    const third = await service.execute(request({ actionKind: 'type', payload: { text: 'hi' } }));
    expect(third.status).toBe('succeeded');
  });

  it('projects an active plugin automation request as the agent controller', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false };
        }),
      },
    });

    const pending = service.execute(request({
      automationRequestId: 'plugin_request_1',
      requestedBy: 'plugin',
      requesterRef: pluginRef,
      actionKind: 'click',
      payload: { locator: { kind: 'css', value: '#go' } },
    }));

    expect(service.getStatus(view)).toMatchObject({
      controller: 'agent',
      activeAutomationRequestId: 'plugin_request_1',
    });

    release();
    await pending;
  });

  it('lets a present user take over an in-flight action and advances control epoch', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      execute: vi.fn(async () => {
        await gate;
        return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false };
      }),
    };
    const service = createBrowserAutomationDaemonService({ adapter });

    const pending = service.execute(
      request({ actionKind: 'navigate', payload: { url: 'https://x.test/' } }),
    );

    const canceled = service.cancelActive({ ...view, authority: 'present_user' });
    expect(service.getStatus(view).activeAutomationRequestId).toBeDefined();
    release();
    expect(await canceled).toEqual({ ok: true, completion: 'uncertain' });

    const result = await pending;
    expect(result.status).toBe('canceled');
    expect(result.errorCode).toBe('user_canceled');
    expect(result.controlEpochBefore).toBe(0);
    expect(result.controlEpochAfter).toBe(1);

    release();

    const timeline = service.getTimeline(view);
    expect(timeline.entries.some((entry) => entry.status === 'canceled')).toBe(true);
  });

  it('lets a present user take over a differently-provenanced in-flight action', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false };
        }),
      },
    });

    const pending = service.execute(request({
      requestedBy: 'plugin',
      requesterRef: pluginRef,
      actionKind: 'navigate',
      payload: { url: 'https://x.test/' },
    }));

    const canceled = service.cancelActive({ ...view, authority: 'present_user' });

    release();
    expect(await canceled).toEqual({ ok: true, completion: 'uncertain' });
    expect((await pending).status).toBe('canceled');
    release();
  });

  it('negotiates supportedOperations: fails closed up-front for an unsupported op without dispatching (BA-6)', async () => {
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false }));
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      // Host version that supports navigation + snapshot but NOT type (engine skew).
      supportedOperations: new Set(['snapshot', 'navigate']),
      execute,
    };
    const service = createBrowserAutomationDaemonService({ adapter });

    const result = await service.execute(request({ actionKind: 'type', payload: { text: 'hi' } }));

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('unsupported_action');
    // Negotiated UP-FRONT: the adapter was never asked to dispatch the unsupported verb.
    expect(execute).not.toHaveBeenCalled();
  });

  it('distinguishes never-implemented automation verbs from host-version unsupported operations', async () => {
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false }));
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        supportedOperations: new Set(['snapshot', 'navigate']),
        execute,
      },
    });
    const result = await service.execute(
      request({
        actionKind: 'evaluate',
        payload: {
          diagnosticsEvalRequest: {
            v: 1,
            evalRequestId: 'eval_1',
            viewId: view.viewId,
            navigationGeneration: 0,
            tier: 'cdp',
            expression: 'document.title',
            objectGroupId: 'automation_eval_1',
            diagnosticsInteractionEnabled: true,
          },
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('not_implemented');
    expect(execute).not.toHaveBeenCalled();
  });

  it('still dispatches a supported op when supportedOperations is declared (BA-6)', async () => {
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      supportedOperations: new Set(['snapshot', 'navigate']),
      execute: vi.fn(async () => ({
        status: 'succeeded' as const,
        fidelity: 'cdp' as const,
        trustedInput: true,
        resultSummary: { nodes: 1 },
      })),
    };
    const service = createBrowserAutomationDaemonService({ adapter });

    const result = await service.execute(request({ actionKind: 'snapshot' }));

    expect(result.status).toBe('succeeded');
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it('exposes the supported operations for host/agent negotiation, null when undeclared (BA-6)', () => {
    const declared = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        supportedOperations: new Set(['snapshot', 'navigate']),
        execute: vi.fn(async () => ({ status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: true })),
      },
    });
    expect(declared.getSupportedOperations()).toEqual(new Set(['snapshot', 'navigate']));

    const undeclared = createBrowserAutomationDaemonService({ adapter: readOnlyAdapter() });
    expect(undeclared.getSupportedOperations()).toBeNull();
  });

  it('returns the view to an uncontrolled status once the in-flight action settles', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false };
        }),
      },
    });

    expect(service.getStatus(view).controller).toBe('none');

    const pending = service.execute(request({ automationRequestId: 'req_status', actionKind: 'click' }));
    expect(service.getStatus(view)).toMatchObject({
      controller: 'agent',
      activeAutomationRequestId: 'req_status',
    });

    release();
    await pending;

    const settled = service.getStatus(view);
    expect(settled.controller).toBe('none');
    expect(settled.activeAutomationRequestId).toBeUndefined();
  });

  it('evicts view runtimes when the sidecar lifecycle reports views closed', async () => {
    let lifecycleListener: ((event: ViewLifecycleEvent) => void) | null = null;
    const service = createBrowserAutomationDaemonService({
      adapter: readOnlyAdapter(),
      subscribeViewLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      },
    });
    const emitLifecycle = (event: ViewLifecycleEvent): void => {
      if (!lifecycleListener) throw new Error('expected lifecycle listener');
      lifecycleListener(event);
    };
    const baseline = service.getRuntimeStats().runtimeCount;

    for (let index = 0; index < 6; index += 1) {
      await service.execute(request({
        automationRequestId: `runtime_req_${index}`,
        viewId: `view_${index}`,
      }));
    }
    expect(service.getRuntimeStats().runtimeCount).toBe(baseline + 6);

    for (let index = 0; index < 6; index += 1) {
      emitLifecycle({
        type: 'unbound',
        browserSessionId: 'browser_session_1',
        viewId: `view_${index}`,
      });
    }

    expect(service.getRuntimeStats().runtimeCount).toBe(baseline);
  });

  it('does not leave an ordinary closed view holding observation admission', () => {
    const owners = createBrowserAutomationOwnerRegistry();
    const service = createBrowserAutomationDaemonService({ adapter: readOnlyAdapter(), owners });
    service.getStatus(view);
    service.closeView(view);
    expect(owners.isObservationHeld(view)).toBe(false);
    expect(owners.getInputControl(view).isClosed()).toBe(false);
    service.dispose();
  });

  it('releases a destroyed confidential source while its native input is still draining', async () => {
    const owners = createBrowserAutomationOwnerRegistry();
    let lifecycleListener: ((event: ViewLifecycleEvent) => void) | undefined;
    let enter: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = createBrowserAutomationDaemonService({ owners,
      adapter: { adapterKind: 'chromiumSidecar', execute: async () => {
        enter();
        await gate;
        return { status: 'succeeded', fidelity: 'cdp', trustedInput: true };
      } },
      subscribeViewLifecycle: listener => { lifecycleListener = listener; return () => undefined; },
    });
    await owners.acquireConfidentiality(view);
    const pending = service.execute(request({ requestedBy: 'user', actionKind: 'click' }));
    try {
      await entered;
      lifecycleListener?.({ type: 'unbound', ...view, sourceDestroyed: true });
      release();
      await pending;
      expect(owners.isObservationHeld(view)).toBe(false);
    } finally { release(); await pending; service.dispose(); }
  });

  it('keeps still-bound view runtimes when one lifecycle view closes', async () => {
    let lifecycleListener: ((event: ViewLifecycleEvent) => void) | null = null;
    const service = createBrowserAutomationDaemonService({
      adapter: readOnlyAdapter(),
      subscribeViewLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      },
    });
    const emitLifecycle = (event: ViewLifecycleEvent): void => {
      if (!lifecycleListener) throw new Error('expected lifecycle listener');
      lifecycleListener(event);
    };

    await service.execute(request({ automationRequestId: 'runtime_req_active_1', viewId: 'view_active_1' }));
    await service.execute(request({ automationRequestId: 'runtime_req_closed', viewId: 'view_closed' }));
    await service.execute(request({ automationRequestId: 'runtime_req_active_2', viewId: 'view_active_2' }));
    expect(service.getRuntimeStats().runtimeCount).toBe(3);

    emitLifecycle({
      type: 'unbound',
      browserSessionId: 'browser_session_1',
      viewId: 'view_closed',
    });

    expect(service.getRuntimeStats().runtimeCount).toBe(2);
    expect(service.getTimeline({ browserSessionId: 'browser_session_1', viewId: 'view_active_1' }).entries).toHaveLength(1);
    expect(service.getTimeline({ browserSessionId: 'browser_session_1', viewId: 'view_active_2' }).entries).toHaveLength(1);
    expect(service.getRuntimeStats().runtimeCount).toBe(2);
  });
});

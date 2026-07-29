import {
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  type BrowserAutomationActionRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationDaemonService } from './service';
import type { BrowserAutomationAdapter } from './adapters/types';

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const agentRef = { kind: 'agent', id: 'agent_1' } as const;
type ViewLifecycleEvent = Readonly<{
  type: 'bound' | 'unbound';
  browserSessionId: string;
  viewId: string;
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
    navigationGeneration: 1,
    requestedBy: 'agent',
    requesterRef: agentRef,
    actionKind: 'snapshot',
    payload: {},
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation daemon service', () => {
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

  it('rejects a mutating action whose lease id does not match an active lease', async () => {
    const service = createBrowserAutomationDaemonService({ adapter: readOnlyAdapter() });

    const result = await service.execute(
      request({ actionKind: 'navigate', leaseId: 'lease_missing', payload: { url: 'https://x.test/' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('lease_required');
  });

  it('executes a mutating action with a valid lease held by the requester', async () => {
    const adapter: BrowserAutomationAdapter = {
      adapterKind: 'chromiumSidecar',
      execute: vi.fn(async () => ({ status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: false })),
    };
    const service = createBrowserAutomationDaemonService({ adapter });
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const result = await service.execute(
      request({
        actionKind: 'navigate',
        leaseId: lease.lease.leaseId,
        payload: { url: 'https://x.test/' },
      }),
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
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const first = service.execute(
      request({ actionKind: 'click', leaseId: lease.lease.leaseId, payload: { selector: '#go' } }),
    );
    const second = await service.execute(
      request({ actionKind: 'type', leaseId: lease.lease.leaseId, payload: { text: 'hi' } }),
    );

    expect(second.status).toBe('failed');
    expect(second.errorCode).toBe('lease_conflict');

    release();
    await first;
  });

  it('cancels an in-flight action when cancelActive is called by the lease owner', async () => {
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
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const pending = service.execute(
      request({ actionKind: 'navigate', leaseId: lease.lease.leaseId, payload: { url: 'https://x.test/' } }),
    );

    const canceled = service.cancelActive({ ...view, requesterRef: agentRef });
    expect(canceled.ok).toBe(true);

    const result = await pending;
    expect(result.status).toBe('canceled');
    expect(result.errorCode).toBe('user_canceled');

    release();

    const timeline = service.getTimeline(view);
    expect(timeline.entries.some((entry) => entry.status === 'canceled')).toBe(true);
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
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const result = await service.execute(
      request({ actionKind: 'type', leaseId: lease.lease.leaseId, payload: { text: 'hi' } }),
    );

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
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const result = await service.execute(
      request({
        actionKind: 'evaluate',
        leaseId: lease.lease.leaseId,
        payload: {
          diagnosticsEvalRequest: {
            v: 1,
            evalRequestId: 'eval_1',
            viewId: view.viewId,
            navigationGeneration: 1,
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

  it('returns controller state via getStatus reflecting the active lease', async () => {
    const service = createBrowserAutomationDaemonService({ adapter: readOnlyAdapter() });
    const lease = service.acquireLease({ ...view, holder: 'agent', requesterRef: agentRef, leaseTtlMs: 5_000 });
    if (!lease.ok) throw new Error('expected lease');

    const state = service.getStatus(view);
    expect(state.controller).toBe('agent');
    expect(state.activeLease?.leaseId).toBe(lease.lease.leaseId);
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

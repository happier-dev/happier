import {
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationCancelActiveResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  type BrowserAutomationActionRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationRoutes } from './routes';
import { createBrowserAutomationDaemonService } from './service';
import { createBrowserAutomationCdpAdapter } from './adapters/cdp';
import type { BrowserAutomationAdapterExecutionContext } from './adapters/types';
import type { BrowserAutomationAdapter } from './adapters/types';

const agentRef = { kind: 'agent', id: 'agent_1' } as const;
const presentUserContext = {
  authority: 'present_user',
  actionCaller: { kind: 'host' },
} as const;
const accountAutomationContext = {
  authority: 'account_automation',
  actionCaller: { kind: 'host' },
} as const;

function adapter(): BrowserAutomationAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    execute: vi.fn(async () => ({
      status: 'succeeded' as const,
      fidelity: 'cdp' as const,
      trustedInput: true,
      resultSummary: { nodes: 2 },
    })),
  };
}

function routes(service = createBrowserAutomationDaemonService({ adapter: adapter() })) {
  return { routes: createBrowserAutomationRoutes({ service }), service };
}

function snapshotRequest(): BrowserAutomationActionRequestV1 {
  return {
    v: 1,
    automationRequestId: 'req_snapshot',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 0,
    requestedBy: 'agent',
    requesterRef: agentRef,
    actionKind: 'snapshot',
    payload: {},
    timeoutMs: 5_000,
  } as BrowserAutomationActionRequestV1;
}

function clickRequest(
  overrides: Partial<BrowserAutomationActionRequestV1> = {},
): BrowserAutomationActionRequestV1 {
  return {
    v: 1,
    automationRequestId: 'req_click',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 0,
    requestedBy: 'agent',
    requesterRef: agentRef,
    actionKind: 'click',
    payload: { locator: { kind: 'css', value: '#submit' } },
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation routes', () => {
  it('refuses confidential entry when the actual adapter cannot prove a focused field', async () => {
    const { routes: r, service } = routes();
    try {
      const target = await r.prepareConfidentialFill({
        serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
        browserSessionId: 'browser_session_1', viewId: 'view_1', tabId: 'tab', frameId: 'frame',
        documentId: 'document', navigationGeneration: 0, origin: 'https://example.test',
        field: { fieldId: '1', focusId: '1', locator: '#password' },
      }, presentUserContext);
      expect(target).toEqual({ status: 'refused', code: 'field_verification_unsupported' });
      expect(service.getTimeline({ browserSessionId: 'browser_session_1', viewId: 'view_1' }).entries).toEqual([]);
    } finally { service.dispose(); }
  });

  it('never admits an Agent confidential continuation or a value-bearing request', async () => {
    const { routes: r, service } = routes();
    const request = {
      serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
      browserSessionId: 'browser_session_1', viewId: 'view_1', tabId: 'tab', frameId: 'frame',
      documentId: 'document', navigationGeneration: 0, origin: 'https://example.test',
      field: { fieldId: '1', focusId: '1', locator: '#password' },
    };
    try {
      expect(await r.prepareConfidentialFill(request, accountAutomationContext))
        .toEqual({ status: 'refused', code: 'approval_required' });
      expect(await r.prepareConfidentialFill({ ...request, value: 'private-fixture' }, presentUserContext))
        .toEqual({ status: 'refused', code: 'target_changed' });
    } finally { service.dispose(); }
  });
  it('rejects a forged human requester and derives admitted requester from trusted Action authority', async () => {
    const inputRequests: string[] = [];
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: {
      ownsView: () => true,
      dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
      dispatchPageQuery: async () => ({ ok: true }),
      dispatchInputCommand: async context => { inputRequests.push(context.actionKind); return { ok: true }; },
    } }) });
    const r = createBrowserAutomationRoutes({ service });
    const request = clickRequest();
    await service.recordHumanInput({ ...request, authority: 'present_user' });
    expect(await r.dispatch('browser.automation.click', request, accountAutomationContext))
      .toMatchObject({ status: 'failed', errorCode: 'human_interrupted' });
    expect(await r.dispatch('browser.automation.click', clickRequest({ requestedBy: 'user' }), accountAutomationContext))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(inputRequests).toEqual([]);
    expect(await r.dispatch('browser.automation.click', request, presentUserContext)).toMatchObject({ status: 'succeeded' });
    expect(inputRequests).toEqual(['click']);
  });
  it.each([
    ['browser.automation.click', clickRequest()],
    ['browser.automation.snapshot', snapshotRequest()],
  ] as const)('cancels %s from its caller without releasing admission before native completion', async (actionId, request) => {
    let enterNative: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enterNative = resolve; });
    let releaseNative: () => void = () => undefined;
    const released = new Promise<void>(resolve => { releaseNative = resolve; });
    let nativeSignal: AbortSignal | undefined;
    // Chromium is the external boundary. The route, service, action runtime, and CDP adapter
    // remain real; the held acknowledgement models input that must drain before admission clears.
    const dispatchNative = async (context: BrowserAutomationAdapterExecutionContext) => {
      nativeSignal = context.signal;
      enterNative();
      await released;
      return context.signal?.aborted
        ? { ok: false as const, errorCode: 'user_canceled' as const, interruptionCompletion: 'stopped' as const }
        : { ok: true as const };
    };
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: {
          ownsView: () => true,
          dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
          dispatchPageQuery: dispatchNative,
          dispatchInputCommand: dispatchNative,
        },
      }),
    });
    const r = createBrowserAutomationRoutes({ service });
    const caller = new AbortController();
    const pending = r.dispatch(actionId, request, { ...accountAutomationContext, signal: caller.signal });

    try {
      await entered;
      caller.abort();
      expect(nativeSignal?.aborted).toBe(true);
      expect(service.getTimeline(request).entries).toEqual([]);
      if (request.actionKind === 'click') {
        expect(service.getStatus(request).activeAutomationRequestId).toBe(request.automationRequestId);
        expect(await r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'blocked_during_drain' })))
          .toMatchObject({ status: 'failed', errorCode: 'automation_busy' });
      }
      releaseNative();
      expect(await pending).toMatchObject({ status: 'canceled', errorCode: 'user_canceled' });
      expect(service.getTimeline(request).entries.find(entry => entry.automationRequestId === request.automationRequestId))
        .toMatchObject({ status: 'canceled', reasonCode: 'user_canceled' });
      expect(service.getStatus(request).activeAutomationRequestId).toBeUndefined();
      expect(service.getStatus(request).controlEpoch).toBe(0);
    } finally {
      releaseNative();
      await pending;
    }
  });

  it('detaches caller cancellation after the native operation has completed', async () => {
    let nativeSignal: AbortSignal | undefined;
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: {
          ownsView: () => true,
          dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
          dispatchPageQuery: async context => {
            nativeSignal = context.signal;
            return { ok: true };
          },
        },
      }),
    });
    const caller = new AbortController();
    const result = await createBrowserAutomationRoutes({ service }).dispatch(
      'browser.automation.snapshot', snapshotRequest(), { ...accountAutomationContext, signal: caller.signal },
    );

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(nativeSignal).toBeDefined();
    caller.abort();
    expect(nativeSignal?.aborted).toBe(false);
  });

  it('requires human takeover and fresh observations to recover uncertain caller-aborted input', async () => {
    let enterNative: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enterNative = resolve; });
    let releaseNative: () => void = () => undefined;
    const released = new Promise<void>(resolve => { releaseNative = resolve; });
    let firstInput = true;
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: {
          ownsView: () => true,
          dispatchControlCommand: async () => { throw new Error('unexpected navigation'); },
          dispatchPageQuery: async () => ({ ok: true, data: { observed: true } }),
          dispatchInputCommand: async context => {
            if (!firstInput) return { ok: true };
            firstInput = false;
            enterNative();
            await released;
            return context.signal?.aborted
              ? { ok: false, errorCode: 'user_canceled', interruptionCompletion: 'uncertain' }
              : { ok: true };
          },
        },
      }),
    });
    const r = createBrowserAutomationRoutes({ service });
    const observedUncertainty: boolean[] = [];
    let handedBack = false;
    service.subscribeBrowserEvents(event => {
      if (handedBack && event.kind === 'controllerChanged') observedUncertainty.push(event.state.uncertain === true);
    });
    const caller = new AbortController();
    const request = clickRequest();
    const pending = r.dispatch('browser.automation.click', request, {
      ...accountAutomationContext, signal: caller.signal,
    });

    try {
      await entered;
      caller.abort();
      releaseNative();
      expect(await pending).toMatchObject({
        status: 'canceled', errorCode: 'user_canceled', resultSummary: { completion: 'uncertain' },
      });
      expect(await r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'needs_observation' })))
        .toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
      expect(await r.dispatch('browser.automation.snapshot', snapshotRequest())).toMatchObject({ status: 'succeeded' });
      expect(await r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'still_uncertain' })))
        .toMatchObject({ status: 'failed', errorCode: 'runtime_unavailable' });
      await service.recordHumanInput({ ...request, authority: 'present_user' });
      handedBack = true;
      expect(service.handBack({ ...request, authority: 'present_user' })).toEqual({ ok: true });
      expect(service.getStatus(request)).toMatchObject({ controller: 'none', uncertain: true });
      expect(await r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'after_handback' })))
        .toMatchObject({ status: 'failed', errorCode: 'stale_navigation' });
      expect(await r.dispatch('browser.automation.snapshot', snapshotRequest())).toMatchObject({ status: 'succeeded' });
      expect(observedUncertainty).toEqual([true, false]);
      expect(service.getStatus(request).uncertain).toBe(false);
      expect(await r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'after_observation' })))
        .toMatchObject({ status: 'succeeded' });
      expect(service.getStatus(request).controlEpoch).toBe(2);
    } finally {
      releaseNative();
      await pending;
    }
  });

  it('dispatches snapshot through the service into a BrowserAutomationActionResultV1', async () => {
    const result = await routes().routes.dispatch('browser.automation.snapshot', snapshotRequest());

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect((result as { status?: string }).status).toBe('succeeded');
  });

  // R-1 deciding check. An agent dispatching a mutating verb must cross the action-spec schema,
  // the protocol request schema, the daemon route and the service, and reach the engine adapter.
  // This failed with `invalid_parameters` while the protocol superRefine mandated a `leaseId` that
  // no production code path could mint (G3/OE-1); it must fail again if that gate is reintroduced.
  it('dispatches a mutating click through the action layer into the engine adapter', async () => {
    const engine = adapter();
    const { routes: r } = routes(createBrowserAutomationDaemonService({ adapter: engine }));

    const result = await r.dispatch('browser.automation.click', clickRequest());

    expect(engine.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.execute).mock.calls[0]?.[0]).toMatchObject({
      actionKind: 'click',
      automationRequestId: 'req_click',
    });
    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: 'succeeded', automationRequestId: 'req_click' });
  });

  it('rejects an automation request whose actionKind does not match the action id', async () => {
    const engine = adapter();
    const { routes: r } = routes(createBrowserAutomationDaemonService({ adapter: engine }));

    // `snapshot` payload dispatched at the `click` action id. The action-spec input schema pins
    // `actionKind` to a literal per id, so this must be refused before the engine is reached —
    // asserting the adapter was never called is what stops a blanket schema rejection (the old
    // lease block) from passing this test for the wrong reason.
    const result = await r.dispatch('browser.automation.click', snapshotRequest());

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(engine.execute).not.toHaveBeenCalled();
  });

  it('returns the timeline for browser.automation.timeline.get', async () => {
    const { routes: r } = routes();
    await r.dispatch('browser.automation.snapshot', snapshotRequest());

    const timeline = await r.dispatch('browser.automation.timeline.get', {
      v: 1,
      automationRequestId: 'req_timeline',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      requestedBy: 'agent',
      requesterRef: agentRef,
      actionKind: 'getActionTimeline',
      payload: {},
      timeoutMs: 5_000,
    });

    expect(BrowserAutomationTimelineV1Schema.safeParse(timeline).success).toBe(true);
    expect((timeline as { entries?: unknown[] }).entries?.length).toBeGreaterThanOrEqual(1);
  });

  it('reports the live controller and in-flight request for browser.automation.status', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: true };
        }),
      },
    });
    const { routes: r } = routes(service);

    const pending = r.dispatch('browser.automation.click', clickRequest());
    await Promise.resolve();

    const result = await r.dispatch('browser.automation.status', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    });

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'succeeded',
      resultSummary: { controller: 'agent', activeAutomationRequestId: 'req_click' },
    });

    release();
    await pending;
  });

  it('returns invalid_parameters when status input lacks a view id', async () => {
    const result = await routes().routes.dispatch('browser.automation.status', {
      browserSessionId: 'browser_session_1',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('lets a present user take over an active automation action and advances its control epoch', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: true };
        }),
      },
    });
    const { routes: r } = routes(service);
    const pending = r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'req_takeover' }));

    try {
      const canceling = r.dispatch('browser.automation.cancelActive', {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
      }, presentUserContext);
      release();
      expect(await canceling).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' });
      await expect(pending).resolves.toMatchObject({
        status: 'canceled',
        errorCode: 'user_canceled',
        controlEpochBefore: 0,
        controlEpochAfter: 1,
      });
      expect(await r.dispatch('browser.automation.status', {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
      })).toMatchObject({
        resultSummary: { controller: 'human', controlEpoch: 1 },
      });
    } finally {
      release();
    }
  });

  it('rejects public requester provenance rather than letting an automation caller spoof cancellation', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: true };
        }),
      },
    });
    const { routes: r } = routes(service);
    const pending = r.dispatch('browser.automation.click', clickRequest({ automationRequestId: 'req_spoof' }));

    try {
      const canceled = await r.dispatch('browser.automation.cancelActive', {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        requesterRef: agentRef,
      }, accountAutomationContext);

      expect(canceled).toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
      release();
      await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      release();
    }
  });

  it('does not let account automation take over an action whose requester matches the old synthetic identity', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createBrowserAutomationDaemonService({
      adapter: {
        adapterKind: 'chromiumSidecar',
        execute: vi.fn(async () => {
          await gate;
          return { status: 'succeeded' as const, fidelity: 'cdp' as const, trustedInput: true };
        }),
      },
    });
    const { routes: r } = routes(service);
    const pending = r.dispatch('browser.automation.click', clickRequest({
      automationRequestId: 'req_non_present',
      requesterRef: { kind: 'agent', id: 'browser_session_1' },
    }));

    try {
      const canceled = await r.dispatch('browser.automation.cancelActive', {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
      }, accountAutomationContext);

      expect(canceled).toEqual({ v: 1, outcome: 'owner_mismatch', canceledCount: 0 });
      release();
      await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      release();
    }
  });

  it('projects no active automation as the cancel command outcome', async () => {
    const { routes: r } = routes();
    const result = await r.dispatch('browser.automation.cancelActive', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    }, presentUserContext);

    expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(result).success).toBe(true);
    expect(result).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
  });
});

import {
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationCancelActiveResultV1Schema,
  BrowserAutomationTimelineV1Schema,
  type BrowserAutomationActionRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserAutomationRoutes } from './routes';
import { createBrowserAutomationDaemonService } from './service';
import type { BrowserAutomationAdapter } from './adapters/types';

const agentRef = { kind: 'agent', id: 'agent_1' } as const;

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
    navigationGeneration: 1,
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
    navigationGeneration: 1,
    requestedBy: 'agent',
    requesterRef: agentRef,
    actionKind: 'click',
    payload: { locator: { kind: 'css', value: '#submit' } },
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation routes', () => {
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

  it('projects no active automation as the cancel command outcome', async () => {
    const { routes: r } = routes();
    const result = await r.dispatch('browser.automation.cancelActive', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    });

    expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(result).success).toBe(true);
    expect(result).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
  });
});

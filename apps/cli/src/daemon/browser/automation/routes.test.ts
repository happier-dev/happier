import {
  BrowserAutomationActionResultV1Schema,
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

describe('browser automation routes', () => {
  it('dispatches snapshot through the service into a BrowserAutomationActionResultV1', async () => {
    const result = await routes().routes.dispatch('browser.automation.snapshot', snapshotRequest());

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect((result as { status?: string }).status).toBe('succeeded');
  });

  it('rejects an automation request whose actionKind does not match the action id', async () => {
    const result = await routes().routes.dispatch('browser.automation.click', snapshotRequest());

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
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

  it('returns a controller-state result for browser.automation.status', async () => {
    const { routes: r, service } = routes();
    service.acquireLease({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      holder: 'agent',
      requesterRef: agentRef,
      leaseTtlMs: 5_000,
    });

    const result = await r.dispatch('browser.automation.status', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    });

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect((result as { status?: string }).status).toBe('succeeded');
  });

  it('returns invalid_parameters when status input lacks a view id', async () => {
    const result = await routes().routes.dispatch('browser.automation.status', {
      browserSessionId: 'browser_session_1',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('dispatches cancelActive to the service and reports the outcome', async () => {
    const { routes: r } = routes();
    const result = await r.dispatch('browser.automation.cancelActive', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    });

    // No active action -> a typed failed automation result (not a thrown error).
    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect((result as { status?: string }).status).toBe('failed');
  });
});

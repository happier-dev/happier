import {
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineEntryV1Schema,
  type BrowserAutomationActionRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { executeBrowserAutomationAction } from './actions';
import type { BrowserAutomationAdapter } from './adapters/types';

function adapter(
  result: Awaited<ReturnType<BrowserAutomationAdapter['execute']>>,
): BrowserAutomationAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    execute: vi.fn(async () => result),
  };
}

function request(
  overrides: Partial<BrowserAutomationActionRequestV1> = {},
): BrowserAutomationActionRequestV1 {
  return {
    v: 1,
    automationRequestId: 'req_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    requestedBy: 'agent',
    requesterRef: { kind: 'agent', id: 'agent_1' },
    actionKind: 'snapshot',
    payload: {},
    timeoutMs: 5_000,
    ...overrides,
  } as BrowserAutomationActionRequestV1;
}

describe('browser automation action runtime', () => {
  it('produces a schema-valid result and timeline entry for a succeeded read-only action', async () => {
    let clock = 1_000;
    const { result, timelineEntry } = await executeBrowserAutomationAction({
      request: request(),
      adapter: adapter({
        status: 'succeeded',
        fidelity: 'cdp',
        trustedInput: true,
        resultSummary: { nodes: 4 },
      }),
      controlEpoch: 7,
      navigationGenerationBefore: 2,
      now: () => {
        const value = clock;
        clock += 25;
        return value;
      },
      generateTimelineEntryId: () => 'timeline_1',
    });

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect(BrowserAutomationTimelineEntryV1Schema.safeParse(timelineEntry).success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.adapterKind).toBe('chromiumSidecar');
    expect(result.controlEpochBefore).toBe(7);
    expect(result.controlEpochAfter).toBe(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(timelineEntry.timelineEntryId).toBe('timeline_1');
    expect(timelineEntry.actionKind).toBe('snapshot');
    expect(timelineEntry.requesterKind).toBe('agent');
  });

  it('advances navigation generation accounting for a mutating navigate action', async () => {
    const { result, timelineEntry } = await executeBrowserAutomationAction({
      request: request({ actionKind: 'navigate', payload: { url: 'https://x.test/' } }),
      adapter: adapter({ status: 'succeeded', fidelity: 'cdp', trustedInput: false }),
      controlEpoch: 3,
      navigationGenerationBefore: 5,
      navigationGenerationAfter: 6,
      now: () => 1_000,
      generateTimelineEntryId: () => 'timeline_2',
    });

    expect(result.navigationGenerationBefore).toBe(5);
    expect(result.navigationGenerationAfter).toBe(6);
    expect(timelineEntry.navigationGenerationAfter).toBe(6);
    expect(result.trustedInput).toBe(false);
  });

  it('carries the adapter error code into a failed result and timeline reason', async () => {
    const { result, timelineEntry } = await executeBrowserAutomationAction({
      request: request({ actionKind: 'snapshot' }),
      adapter: adapter({
        status: 'failed',
        fidelity: 'cdp',
        trustedInput: true,
        errorCode: 'runtime_unavailable',
      }),
      controlEpoch: 1,
      navigationGenerationBefore: 0,
      now: () => 1_000,
      generateTimelineEntryId: () => 'timeline_3',
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('runtime_unavailable');
    expect(timelineEntry.status).toBe('failed');
    expect(timelineEntry.reasonCode).toBe('runtime_unavailable');
  });

  it('redacts unsafe keys from adapter result summaries before they reach the timeline', async () => {
    const { result } = await executeBrowserAutomationAction({
      request: request(),
      adapter: adapter({
        status: 'succeeded',
        fidelity: 'cdp',
        trustedInput: true,
        resultSummary: { authorization: 'Bearer secret', safeCount: 3 },
      }),
      controlEpoch: 1,
      navigationGenerationBefore: 0,
      now: () => 1_000,
      generateTimelineEntryId: () => 'timeline_4',
    });

    expect(BrowserAutomationActionResultV1Schema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result.resultSummary ?? {})).not.toContain('secret');
  });
});

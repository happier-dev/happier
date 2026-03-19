import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureState = vi.hoisted(() => ({ enabled: true }));
const backendsState = vi.hoisted(() => ({ backends: null as Record<string, unknown> | null }));
const messagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const listRunsSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => featureState.enabled,
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => backendsState.backends,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSessionMessages: () => ({ messages: messagesState.messages, isLoaded: true }),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunList: (...args: unknown[]) => listRunsSpy(...args),
}));

import { useSessionExecutionRunsSupported } from './useSessionExecutionRunsSupported';

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderHarness(sessionId = 'session-1'): Promise<{
  getValue: () => boolean;
  rerender: (nextSessionId: string) => Promise<void>;
  rerenderSync: (nextSessionId: string) => void;
  unmount: () => void;
}> {
  let current = false;

  function Harness(props: Readonly<{ sessionId: string }>) {
    current = useSessionExecutionRunsSupported(props.sessionId);
    return null;
  }

  let root: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    root = renderer.create(React.createElement(Harness, { sessionId }));
    await flushAsync();
  });

  return {
    getValue: () => current,
    rerender: async (nextSessionId: string) => {
      await act(async () => {
        root!.update(React.createElement(Harness, { sessionId: nextSessionId }));
        await flushAsync();
      });
    },
    rerenderSync: (nextSessionId: string) => {
      act(() => {
        root!.update(React.createElement(Harness, { sessionId: nextSessionId }));
      });
    },
    unmount: () => {
      if (!root) return;
      act(() => root!.unmount());
    },
  };
}

describe('useSessionExecutionRunsSupported', () => {
  beforeEach(() => {
    featureState.enabled = true;
    backendsState.backends = null;
    messagesState.messages = [];
    listRunsSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true immediately when the loaded transcript already contains execution-run signals', async () => {
    messagesState.messages = [
      { kind: 'tool-call', tool: { name: 'SubAgentRun', input: { runId: 'run_1' }, result: {} } },
    ];

    const harness = await renderHarness();

    expect(harness.getValue()).toBe(true);
    expect(listRunsSpy).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('probes the session runs list when transcript and backend signals are absent and enables support when historical runs exist', async () => {
    listRunsSpy.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'call_1',
          intent: 'delegate',
          backendId: 'codex',
          status: 'succeeded',
          startedAtMs: 1,
        },
      ],
    });

    const harness = await renderHarness('session-historical');

    expect(listRunsSpy).toHaveBeenCalledWith('session-historical', {});
    expect(harness.getValue()).toBe(true);
    harness.unmount();
  });

  it('keeps support disabled when the historical probe returns no runs', async () => {
    listRunsSpy.mockResolvedValueOnce({ runs: [] });

    const harness = await renderHarness('session-empty');

    expect(listRunsSpy).toHaveBeenCalledWith('session-empty', {});
    expect(harness.getValue()).toBe(false);
    harness.unmount();
  });

  it('clears historical runs state immediately when sessionId changes', async () => {
    listRunsSpy
      .mockResolvedValueOnce({
        runs: [
          {
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'call_1',
            intent: 'delegate',
            backendId: 'codex',
            status: 'succeeded',
            startedAtMs: 1,
          },
        ],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ runs: [] }), 100);
          }),
      );

    const harness = await renderHarness('session-with-runs');

    expect(listRunsSpy).toHaveBeenCalledWith('session-with-runs', {});
    expect(harness.getValue()).toBe(true);

    harness.rerenderSync('session-without-runs');

    // The old state should be cleared immediately (synchronously) before the async probe completes
    expect(harness.getValue()).toBe(false);
    harness.unmount();
  });
});

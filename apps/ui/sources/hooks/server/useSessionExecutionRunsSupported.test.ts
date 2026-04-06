import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { installServerHookCommonModuleMocks } from './serverHookModuleTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureState = vi.hoisted(() => ({ enabled: true }));
const backendsState = vi.hoisted(() => ({
  backendsByServerId: new Map<string, Record<string, unknown> | null>(),
}));
const messagesState = vi.hoisted(() => ({ messages: [] as any[] }));
const sessionState = vi.hoisted(() => ({
  preferredServerId: 'server-1' as string | null,
  session: { active: true } as any,
}));
const listRunsSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => featureState.enabled,
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: (_sessionId: string, serverId?: string | null) =>
    (serverId ? backendsState.backendsByServerId.get(serverId) ?? null : null),
}));

installServerHookCommonModuleMocks({
  storage: async () => createStorageModuleStub({
    useSession: () => sessionState.session,
    useSessionMessages: () => ({ messages: messagesState.messages, isLoaded: true }),
  }),
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunList: (...args: unknown[]) => listRunsSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: () => sessionState.preferredServerId,
}));

async function renderHarness(sessionId = 'session-1', sessionServerId?: string | null): Promise<{
  getValue: () => boolean;
  rerenderSync: (nextSessionId: string) => void;
  unmount: () => void;
}> {
  let current = false;
  const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');

  function Harness(props: Readonly<{ sessionId: string }>) {
    current = (useSessionExecutionRunsSupported as unknown as (sessionId: string, serverId?: string | null) => boolean)(
      props.sessionId,
      sessionServerId,
    );
    return null;
  }

  let root: renderer.ReactTestRenderer | null = null;
  root = (await renderScreen(React.createElement(Harness, { sessionId }))).tree;

  return {
    getValue: () => current,
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
    backendsState.backendsByServerId.clear();
    messagesState.messages = [];
    sessionState.preferredServerId = 'server-1';
    sessionState.session = { active: true } as any;
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

  it('uses the session server id when preferred server resolution is unavailable', async () => {
    sessionState.preferredServerId = null;
    sessionState.session = { active: true, serverId: 'server-explicit' } as any;
    backendsState.backendsByServerId.set('server-explicit', { backend: true });

    const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');
    const harness = await renderHarness('session-with-explicit-server');

    expect(harness.getValue()).toBe(true);
    harness.unmount();
  });

  it('prefers the explicit canonical server id when provided by the caller', async () => {
    sessionState.preferredServerId = 'server-preferred';
    sessionState.session = { active: true, serverId: 'server-explicit' } as any;
    backendsState.backendsByServerId.set('server-explicit', { backend: true });

    const { useSessionExecutionRunsSupported } = await import('./useSessionExecutionRunsSupported');
    const harness = await renderHarness('session-explicit', 'server-explicit');

    expect(harness.getValue()).toBe(true);
    harness.unmount();
  });
});

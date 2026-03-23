import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({
  value: null as any,
}));

const capabilitiesState = vi.hoisted(() => ({
  lastArgs: null as null | { machineId: string | null; serverId?: string | null; enabled: boolean; request: any },
}));

const activeServerSnapshotState = vi.hoisted(() => ({
  value: { serverId: 'active-server' },
}));

const sessionServerIdStore = vi.hoisted(() => {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    set(next: string | null) {
      value = next;
      for (const listener of Array.from(listeners)) listener();
    },
    reset(next: string | null = null) {
      value = next;
      listeners.clear();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
  useSession: () => sessionState.value,
}));

vi.mock('@/sync/store/hooks', async () => {
  const React = await import('react');
  return {
    useSessionServerId: () => React.useSyncExternalStore(
      sessionServerIdStore.subscribe,
      sessionServerIdStore.getSnapshot,
      sessionServerIdStore.getSnapshot,
    ),
  };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => activeServerSnapshotState.value,
  subscribeActiveServer: () => () => {},
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  useMachineCapabilitiesCache: (args: { machineId: string | null; serverId?: string | null; enabled: boolean; request: any }) => {
    capabilitiesState.lastArgs = args;
    if (args.machineId === 'machine-direct' && args.enabled) {
      return {
        state: {
          snapshot: {
            response: {
              results: {
                'tool.executionRuns': {
                  ok: true,
                  data: {
                    backends: {
                      claude: { available: true, intents: ['review'] },
                    },
                  },
                },
              },
            },
          },
        },
      };
    }

    return { state: { status: 'idle' } };
  },
}));

import { useExecutionRunsBackendsForSession } from './useExecutionRunsBackendsForSession';

describe('useExecutionRunsBackendsForSession', () => {
  beforeEach(() => {
    sessionState.value = null;
    capabilitiesState.lastArgs = null;
    activeServerSnapshotState.value = { serverId: 'active-server' };
    sessionServerIdStore.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the linked direct-session machine id when top-level session metadata has no machine id', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderHook(
      (sessionId: string) => useExecutionRunsBackendsForSession(sessionId),
      { initialProps: 'session-1', flushOptions: { cycles: 1, turns: 1 } },
    );

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));
    expect(hook.getCurrent()).toEqual({
      claude: { available: true, intents: ['review'] },
    });

    await hook.unmount();
  });

  it('scopes the execution-run capability lookup to the session-owned server', async () => {
    sessionServerIdStore.set('server-owned');
    sessionState.value = {
      id: 'session-1',
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderHook(
      (sessionId: string) => useExecutionRunsBackendsForSession(sessionId),
      { initialProps: 'session-1', flushOptions: { cycles: 1, turns: 1 } },
    );

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      serverId: 'server-owned',
      enabled: true,
    }));

    await hook.unmount();
  });

  it('reacts when the session-owned server id hydrates after mount', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderHook(
      (sessionId: string) => useExecutionRunsBackendsForSession(sessionId),
      { initialProps: 'session-1', flushOptions: { cycles: 1, turns: 1 } },
    );

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      serverId: 'active-server',
      enabled: true,
    }));

    await act(async () => {
      sessionServerIdStore.set('server-owned');
    });

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      serverId: 'server-owned',
      enabled: true,
    }));

    await hook.unmount();
  });
});

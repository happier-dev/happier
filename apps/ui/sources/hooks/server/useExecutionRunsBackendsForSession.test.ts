import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';

import { installServerHookCommonModuleMocks } from './serverHookModuleTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({
  value: null as any,
}));

const useSessionSpy = vi.hoisted(() => vi.fn<(sessionId: string) => any>(() => sessionState.value));
const capabilitiesState = vi.hoisted(() => ({
  lastArgs: null as null | { machineId: string | null; serverId?: string | null; enabled: boolean; request: any },
}));
const machineTargetState = vi.hoisted(() => ({
  value: null as null | { machineId: string; basePath: string },
}));

installServerHookCommonModuleMocks({
  storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
    useSession: (sessionId: string) => useSessionSpy(sessionId),
  }),
});

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

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
  useSessionMachineTarget: () => machineTargetState.value,
}));

async function renderExecutionRunsBackendsHook(sessionId: string, serverId?: string | null) {
  const { useExecutionRunsBackendsForSession } = await import('./useExecutionRunsBackendsForSession');
  return renderHook(
    (props: { sessionId: string; serverId?: string | null }) =>
      useExecutionRunsBackendsForSession(props.sessionId, props.serverId),
    { initialProps: { sessionId, serverId }, flushOptions: { cycles: 1, turns: 1 } },
  );
}

describe('useExecutionRunsBackendsForSession', () => {
  beforeEach(() => {
    sessionState.value = null;
    capabilitiesState.lastArgs = null;
    machineTargetState.value = null;
    useSessionSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the linked direct-session machine id when top-level session metadata has no machine id', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderExecutionRunsBackendsHook('session-1');

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));
    expect(hook.getCurrent()).toEqual({
      claude: { available: true, intents: ['review'] },
    });

    await hook.unmount();
  });

  it('prefers the resolved session machine target over stale session metadata', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        machineId: 'machine-stale',
        path: '/tmp/stale',
      },
    };
    machineTargetState.value = { machineId: 'machine-direct', basePath: '/tmp/reachable' };

    const hook = await renderExecutionRunsBackendsHook('session-1');

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));
    expect(hook.getCurrent()).toEqual({
      claude: { available: true, intents: ['review'] },
    });

    await hook.unmount();
  });

  it('scopes the execution-run capability lookup to the canonical session server', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderExecutionRunsBackendsHook('session-1', 'server-owned');

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      serverId: 'server-owned',
      enabled: true,
    }));

    await hook.unmount();
  });

  it('updates when the caller changes the canonical server id', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderExecutionRunsBackendsHook('session-1');

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));
    expect(capabilitiesState.lastArgs?.serverId).toBeUndefined();

    await hook.rerender({ sessionId: 'session-1', serverId: 'server-canonical' });

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      serverId: 'server-canonical',
      enabled: true,
    }));

    await hook.unmount();
  });

  it('normalizes session ids before resolving execution-run backends', async () => {
    sessionState.value = {
      id: 'session-1',
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-direct',
          remoteSessionId: 'remote-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-config' },
        },
      },
    };

    const hook = await renderExecutionRunsBackendsHook('  session-1  ');

    expect(useSessionSpy).toHaveBeenCalledWith('session-1');
    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));

    await hook.unmount();
  });
});

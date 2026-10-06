import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { installServerHookCommonModuleMocks } from './serverHookModuleTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({
  value: null as (Omit<Partial<Session>, 'metadata'> & { metadata?: Partial<NonNullable<Session['metadata']>> }) | null,
}));

const capabilitiesState = vi.hoisted(() => ({
  lastArgs: null as null | { machineId: string | null; serverId?: string | null; enabled: boolean; request: any },
}));
const machineTargetState = vi.hoisted(() => ({
  value: null as null | { machineId: string; basePath: string },
}));

installServerHookCommonModuleMocks({
  storage: async (importOriginal) => importOriginal<typeof import('@/sync/domains/state/storage')>(),
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

async function renderExecutionRunsBackendsHook(sessionId: string, serverId?: string | null) {
  const { storage } = await import('@/sync/domains/state/storage');
  const session = createSessionFixture({
    ...sessionState.value,
    serverId: serverId ?? undefined,
    metadata: { ...sessionState.value?.metadata, path: sessionState.value?.metadata?.path ?? '/tmp/linked', host: sessionState.value?.metadata?.host ?? 'tester.local' },
  });
  const resolvedSession = machineTargetState.value ? createSessionFixture({
    ...session,
    metadata: { ...session.metadata, host: session.metadata?.host ?? 'tester.local', machineId: machineTargetState.value.machineId, path: machineTargetState.value.basePath },
  }) : session;
  const machine = createMachineFixture({ id: 'machine-direct', active: true });
  storage.setState({
    sessions: { [session.id]: session },
    machines: { [machine.id]: machine },
    machineListByServerId: serverId ? { [serverId]: [machine] } : {},
    sessionListRowsByServerId: serverId ? { [serverId]: { [session.id]: buildSessionListRenderableFromSession(resolvedSession) } } : {},
  });
  const { useExecutionRunsBackendsForSession } = await import('./useExecutionRunsBackendsForSession');
  return renderHook(
    (props: { sessionId: string; serverId?: string | null }) =>
      useExecutionRunsBackendsForSession(props.sessionId, props.serverId),
    { initialProps: { sessionId, serverId }, flushOptions: { cycles: 1, turns: 1 } },
  );
}

describe('useExecutionRunsBackendsForSession', () => {
  let restoreStorage = () => {};
  beforeEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { sessions, machines, machineListByServerId, sessionListRowsByServerId } = storage.getState();
    restoreStorage = () => storage.setState({ sessions, machines, machineListByServerId, sessionListRowsByServerId });
    sessionState.value = null;
    capabilitiesState.lastArgs = null;
    machineTargetState.value = null;
  });

  afterEach(async () => {
    await standardCleanup();
    restoreStorage();
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

    const hook = await renderExecutionRunsBackendsHook('session-1', 'server-resolved');

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

    const { storage } = await import('@/sync/domains/state/storage');
    const exactSession = createSessionFixture({
      ...sessionState.value,
      serverId: 'server-canonical',
      metadata: { ...sessionState.value?.metadata, path: sessionState.value?.metadata?.path ?? '/tmp/linked', host: sessionState.value?.metadata?.host ?? 'tester.local' },
    });
    storage.setState({
      machineListByServerId: { 'server-canonical': [createMachineFixture({ id: 'machine-direct', active: true })] },
      sessionListRowsByServerId: { 'server-canonical': { 'session-1': buildSessionListRenderableFromSession(exactSession) } },
    });
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

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));

    await hook.unmount();
  });
});

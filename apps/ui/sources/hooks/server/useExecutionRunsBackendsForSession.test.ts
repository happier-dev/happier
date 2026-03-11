import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({
  value: null as any,
}));

const capabilitiesState = vi.hoisted(() => ({
  lastArgs: null as null | { machineId: string | null; enabled: boolean; request: any },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => sessionState.value,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  useMachineCapabilitiesCache: (args: { machineId: string | null; enabled: boolean; request: any }) => {
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

async function renderHook(sessionId = 'session-1'): Promise<{ getValue: () => ReturnType<typeof useExecutionRunsBackendsForSession>; unmount: () => void }> {
  let current: ReturnType<typeof useExecutionRunsBackendsForSession> = null;

  function Harness(props: Readonly<{ sessionId: string }>) {
    current = useExecutionRunsBackendsForSession(props.sessionId);
    return null;
  }

  let root: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    root = renderer.create(React.createElement(Harness, { sessionId }));
    await Promise.resolve();
  });

  return {
    getValue: () => current,
    unmount: () => {
      if (!root) return;
      act(() => root!.unmount());
    },
  };
}

describe('useExecutionRunsBackendsForSession', () => {
  beforeEach(() => {
    sessionState.value = null;
    capabilitiesState.lastArgs = null;
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

    const hook = await renderHook('session-1');

    expect(capabilitiesState.lastArgs).toEqual(expect.objectContaining({
      machineId: 'machine-direct',
      enabled: true,
    }));
    expect(hook.getValue()).toEqual({
      claude: { available: true, intents: ['review'] },
    });

    hook.unmount();
  });
});

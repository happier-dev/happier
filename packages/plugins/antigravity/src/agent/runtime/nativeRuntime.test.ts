import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeContext,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createAntigravityNativeRuntime,
  type AntigravityNativeSessionFactory,
} from './nativeRuntime.js';

function configuration(mode: 'sdk' | 'cliPrint'): AgentSessionConfigurationSnapshot {
  return {
    mode: { value: mode, updatedAtMs: 1 },
    model: { value: null, updatedAtMs: 1 },
    permissionIntent: { value: null, updatedAtMs: 1 },
    options: {},
  };
}

function createNativeSession(sessionId: string): AgentSessionRuntime {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  const publish = (
    event: Omit<AgentSessionRuntimeEvent, 'sequence' | 'sessionId' | 'emittedAtMs'>,
  ): void => {
    const value = {
      ...event,
      sequence: ++sequence,
      sessionId,
      emittedAtMs: 2,
    } as AgentSessionRuntimeEvent;
    for (const listener of listeners) listener(value);
  };
  return {
    async send(request) {
      publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      publish({
        kind: 'message-delta',
        turnId: request.delivery.turnId,
        channel: 'assistant',
        text: 'provider output',
      });
      return { status: 'admitted' };
    },
    async cancel(request) {
      return { status: 'requested', turnId: request.turnId };
    },
    watch(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {},
  };
}

const context = {} as AgentRuntimeContext;

describe('createAntigravityNativeRuntime', () => {
  it('opens both structured session modes through one native runtime and preserves custody ordering', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => {
      return createNativeSession(request.sessionId);
    });
    const runtime = createAntigravityNativeRuntime({ openSession });

    const sdk = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'sdk-session',
      cwd: '/repo',
      configuration: configuration('sdk'),
    }, context);
    const cliPrint = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'cli-session',
      cwd: '/repo',
      configuration: configuration('cliPrint'),
    }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    sdk?.watch((event) => events.push(event));

    await expect(sdk?.send({
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    expect(openSession.mock.calls.map(([call]) => call.mode)).toEqual(['sdk', 'cliPrint']);
    expect(cliPrint).toBeDefined();
    expect(events.map((event) => event.kind)).toEqual(['input-accepted', 'message-delta']);
    expect(events[1]).toMatchObject({
      kind: 'message-delta',
      sessionId: 'sdk-session',
      turnId: 'turn-1',
      channel: 'assistant',
      text: 'provider output',
    });
  });

  it('opens SDK execution runs through the same native session owner', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({ openSession });

    const executionRun = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'run-1',
      cwd: '/repo',
      profile: { pluginId: 'happier.agent.antigravity', localId: 'default' },
      launchEnvironment: {
        values: { HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'sdk' },
        unset: [],
      },
      input: { text: 'review this' },
    }, context);
    const events: string[] = [];
    executionRun?.watch((event) => events.push(event.kind));

    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'sdk' }));
    expect(events).toEqual(expect.arrayContaining(['run-start', 'output-delta']));
  });

  it('keeps exact vendor resume on cliPrint even when account configuration selects SDK mode', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({
      openSession,
      resolveMode: async () => 'sdk',
    });

    await runtime.sessions?.open({
      kind: 'resume',
      sessionId: 'resumed-session',
      cwd: '/repo',
      providerSessionId: 'conversation-exact-1',
      configuration: configuration('sdk'),
    }, context);

    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'cliPrint',
      request: expect.objectContaining({
        kind: 'resume',
        providerSessionId: 'conversation-exact-1',
      }),
    }));
  });

  it('declares the data-only terminal launch surface on the same native runtime', async () => {
    const runtime = createAntigravityNativeRuntime({
      openSession: ({ request }) => createNativeSession(request.sessionId),
    });

    await expect(Promise.resolve(runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'terminal-session',
      cwd: '/repo',
      metadata: { model: 'gemini-3.1-pro-high' },
    }))).resolves.toEqual({
      argv: ['--model', 'gemini-3.1-pro-high'],
      process: { stdio: 'inherit', windowsHide: true },
      presentation: {
        onLaunch: {
          target: 'local',
          reason: 'antigravity_terminal_runtime_launcher_start',
        },
        onExit: {
          target: 'remote',
          reason: 'antigravity_terminal_runtime_launcher_exit',
        },
      },
    });
  });
});

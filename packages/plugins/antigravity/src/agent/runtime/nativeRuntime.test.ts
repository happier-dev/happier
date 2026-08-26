import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeContext,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntimeContext,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  createAntigravityNativeRuntime,
  type AntigravityNativeExecutionRunFactory,
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

function createConnectedAccountsFixture(binding: unknown = null) {
  return {
    getBinding: vi.fn(async () => binding),
    materialize: vi.fn(),
    requestSelection: vi.fn(),
    watch: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

const openExecutionRunAdapter: AntigravityNativeExecutionRunFactory = ({ request }) => (
  createNativeSession(request.sessionId)
);

function createContext(connectedAccounts = createConnectedAccountsFixture()): AgentSessionRuntimeContext {
  return {
    signal: new AbortController().signal,
    services: { connectedAccounts },
    session: { id: 'session-1', services: {} },
    workState: {},
  } as unknown as AgentRuntimeContext;
}

describe('createAntigravityNativeRuntime', () => {
  it('opens both structured session modes through one native runtime and preserves custody ordering', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => {
      return createNativeSession(request.sessionId);
    });
    const runtime = createAntigravityNativeRuntime({
      openSession,
      openExecutionRun: openExecutionRunAdapter,
    });
    const context = createContext();

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

  it('opens detached SDK execution runs through the operation-scoped entry without fabricating a Session', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const openExecutionRun = vi.fn(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({ openSession, openExecutionRun });
    const context = createContext();

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

    expect(openExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'sdk',
      context,
    }));
    expect(openSession).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining(['run-start', 'output-delta']));
  });

  it('terminalizes a rejected initial execution-run admission before disposing its session', async () => {
    const disposeSession = vi.fn();
    const disposeSubscription = vi.fn();
    const cancel = vi.fn(async () => ({ status: 'requested' as const, turnId: 'unexpected-turn' }));
    const rejectedSession: AgentSessionRuntime = {
      send: vi.fn(async () => ({
        status: 'rejected' as const,
        retryable: false,
        diagnostic: {
          code: 'antigravity_initial_admission_rejected',
          severity: 'error' as const,
        },
      })),
      cancel,
      watch: vi.fn(() => ({ dispose: disposeSubscription })),
      dispose: disposeSession,
    };
    const runtime = createAntigravityNativeRuntime({
      openSession: ({ request }) => createNativeSession(request.sessionId),
      openExecutionRun: vi.fn(async () => rejectedSession),
    });

    const execution = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'rejected-execution-run',
      cwd: '/repo',
      profile: { pluginId: 'happier.agent.antigravity', localId: 'default' },
      input: { text: 'Reject this initial prompt.' },
    }, createContext());
    if (!execution) throw new Error('Expected an execution run');

    const events: string[] = [];
    execution.watch((event) => events.push(event.kind));

    expect(events).toEqual(['run-start', 'run-failed']);
    await expect(execution.stop()).resolves.toEqual({ status: 'notRunning' });
    expect(cancel).not.toHaveBeenCalled();
    expect(disposeSubscription).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledOnce();
  });

  it('keeps exact vendor resume on cliPrint even when account configuration selects SDK mode', async () => {
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({
      openSession,
      openExecutionRun: openExecutionRunAdapter,
      resolveMode: async () => 'sdk',
    });
    const context = createContext();

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
      openExecutionRun: openExecutionRunAdapter,
    });

    await expect(Promise.resolve(runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'terminal-session',
      cwd: '/repo',
      metadata: {},
      modelSelection: {
        agentTargetKey: 'backend:antigravity',
        providerConnectionId: null,
        modelId: 'gemini-3.1-pro-high',
      },
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

  it('materializes the bound Gemini environment with the exact session cancellation signal', async () => {
    const signal = new AbortController().signal;
    const connectedAccounts = createConnectedAccountsFixture({
      purpose: 'model_upstream',
      service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
      target: { kind: 'account', displayName: 'Vertex account' },
    });
    connectedAccounts.materialize.mockResolvedValue({
      kind: 'environment',
      env: {
        GOOGLE_GENAI_USE_VERTEXAI: '1',
        GOOGLE_CLOUD_PROJECT: 'vertex-project',
        GOOGLE_CLOUD_LOCATION: 'europe-west1',
        UNDECLARED_SECRET: 'must-not-propagate',
      },
    });
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({
      openSession,
      openExecutionRun: openExecutionRunAdapter,
    });
    const context = {
      signal,
      services: { connectedAccounts },
    } as unknown as AgentRuntimeContext;

    await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'qualified-cli-session',
      cwd: '/repo',
      configuration: configuration('cliPrint'),
    }, context);

    expect(connectedAccounts.getBinding).toHaveBeenCalledWith(
      'model_upstream',
      { signal },
    );
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'model_upstream',
      {
        kind: 'environment',
        keys: [
          'GEMINI_API_KEY',
          'GOOGLE_API_KEY',
          'GOOGLE_GENAI_USE_VERTEXAI',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_LOCATION',
        ],
      },
      { signal },
    );
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      connectedAccountEnv: {
        GOOGLE_GENAI_USE_VERTEXAI: '1',
        GOOGLE_CLOUD_PROJECT: 'vertex-project',
        GOOGLE_CLOUD_LOCATION: 'europe-west1',
      },
    }));
  });

  it('keeps the native launch path unchanged when no account is bound', async () => {
    const connectedAccounts = createConnectedAccountsFixture();
    const openSession = vi.fn<AntigravityNativeSessionFactory>(({ request }) => (
      createNativeSession(request.sessionId)
    ));
    const runtime = createAntigravityNativeRuntime({
      openSession,
      openExecutionRun: openExecutionRunAdapter,
    });

    await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'native-login-session',
      cwd: '/repo',
      launchEnvironment: { values: { SAFE_NATIVE_ENV: 'kept' }, unset: [] },
      configuration: configuration('sdk'),
    }, createContext(connectedAccounts));

    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledWith(expect.not.objectContaining({
      connectedAccountEnv: expect.anything(),
      materializeAuthEnv: expect.anything(),
    }));
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        launchEnvironment: { values: { SAFE_NATIVE_ENV: 'kept' }, unset: [] },
      }),
    }));
  });

  it('turns a later purpose resync into session recovery and disposes the watch with the session', async () => {
    let resync: (() => void) | null = null;
    const disposeSubscription = vi.fn();
    const connectedAccounts = {
      ...createConnectedAccountsFixture(),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        resync = listener;
        return { dispose: disposeSubscription };
      }),
    };
    const disposeSession = vi.fn();
    const runtime = createAntigravityNativeRuntime({
      openSession: ({ request }) => ({
        ...createNativeSession(request.sessionId),
        dispose: disposeSession,
      }),
      openExecutionRun: openExecutionRunAdapter,
    });
    const session = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'watched-session',
      cwd: '/repo',
      configuration: configuration('sdk'),
    }, createContext(connectedAccounts));

    resync?.();
    expect(disposeSession).not.toHaveBeenCalled();
    resync?.();
    await vi.waitFor(() => {
      expect(disposeSession).toHaveBeenCalledWith('runtime_recovery');
    });
    expect(disposeSubscription).toHaveBeenCalledOnce();

    await session?.dispose();
    expect(disposeSession).toHaveBeenCalledTimes(1);
    expect(disposeSubscription).toHaveBeenCalledTimes(1);
  });
});

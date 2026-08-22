import type {
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartResult,
  AgentSessionRealtimeRuntime as ExperimentalAgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  AgentSessionRealtimeStartRequestV1Schema,
  type PluginContributionIdentityV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { registerAgentSessionRealtimeVoiceRpc } from './registerAgentSessionRealtimeVoiceRpc';

const agentRef = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
const providerRef = { pluginId: 'happier.agent.codex', localId: 'realtime-codex' } as const;
const alternateProviderRef = {
  pluginId: 'happier.agent.codex',
  localId: 'realtime-codex-alternate',
} as const;
const declaration = {
  id: providerRef.localId,
  title: 'Codex Realtime Voice — Experimental',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: {
    turn: { cancelResponse: false, bargeIn: false },
    tools: { effectCalls: 'none' },
  },
  execution: {
    kind: 'experimental_agent_session_realtime',
    agent: agentRef,
    supportedRuntimeVersions: ['1.2.3'],
  },
  settings: {
    schemaVersion: 2,
    fields: [],
    connectedServicesBinding: {
      id: 'globalConnectedServices',
      title: 'Codex account',
      agent: agentRef,
      serviceIds: ['openai-codex'],
    },
  },
  client: {
    artifactId: 'voice-runtime-web',
    modulePath: './ui/voice',
    exportName: 'activate',
  },
} satisfies VoiceProviderContribution;
const alternateDeclaration = {
  ...declaration,
  id: alternateProviderRef.localId,
} satisfies VoiceProviderContribution;

function resolveCanonicalSdpMaxBytes(): number {
  const accepts = (offerSdp: string) => AgentSessionRealtimeStartRequestV1Schema.safeParse({
    v: 1,
    provider: providerRef,
    applicationAttemptId: 'limit-probe',
    transport: { kind: 'webrtc', offerSdp },
  }).success;
  let upper = 1;
  while (accepts('x'.repeat(upper))) upper *= 2;
  let lower = upper / 2;
  while (lower + 1 < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (accepts('x'.repeat(midpoint))) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

function runtimeFixture() {
  const listeners = new Set<(event: AgentSessionRealtimeLifecycleEvent) => void>();
  let terminal: AgentSessionRealtimeLifecycleEvent | null = null;
  const handle: AgentSessionRealtimeHandle = {
    stop: vi.fn(async () => ({ status: 'stopped' as const })),
    watch(listener) {
      if (terminal) listener(terminal);
      else listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    dispose: vi.fn(),
  };
  const inspect = vi.fn(async (): Promise<AgentSessionRealtimeAvailability> => ({
    status: 'available',
    transport: 'webrtc',
  }));
  const start = vi.fn<AgentSessionRealtimeConversation['start']>(async (): Promise<AgentSessionRealtimeStartResult> => ({
    status: 'started',
    transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=answer\r\n' },
    handle,
  }));
  const runtime: ExperimentalAgentSessionRealtimeRuntime = {
    send: vi.fn(async () => ({ status: 'admitted' as const })),
    watch: () => ({ dispose() {} }),
    dispose() {},
    realtimeConversation: { inspect, start },
  };
  return {
    runtime,
    inspect,
    start,
    handle,
    publish(event: AgentSessionRealtimeLifecycleEvent) {
      if (terminal) return;
      terminal = event;
      for (const listener of [...listeners]) listener(event);
      listeners.clear();
    },
  };
}

function trackStopRequiredRetirement(fixture: ReturnType<typeof runtimeFixture>) {
  const operations: string[] = [];
  let upstreamActive = true;
  fixture.handle.stop = vi.fn(async () => {
    operations.push('stop:start');
    await Promise.resolve();
    upstreamActive = false;
    operations.push('stop:complete');
    return { status: 'stopped' as const };
  });
  fixture.handle.dispose = vi.fn(() => {
    operations.push(`dispose:${upstreamActive ? 'active' : 'stopped'}`);
  });
  return operations;
}

type Handler = (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>;

function register(
  runtime: unknown,
  resolveEligibleConversation: (ref: PluginContributionIdentityV1) => unknown = (ref) => (
    ref.pluginId === providerRef.pluginId && ref.localId === providerRef.localId
      ? declaration
      : null
  ),
  options?: Readonly<{
    getHappierSessionId?: () => string;
    isGenerationCurrent?: () => boolean;
    retirementSignal?: AbortSignal;
    resolveRetirementSignal?: () => AbortSignal | null;
  }>,
) {
  const handlers = new Map<string, Handler>();
  const registration = registerAgentSessionRealtimeVoiceRpc({
    rpc: {
      registerHandler: (method, handler: RpcHandler) => {
        handlers.set(method, async (raw, context) => await handler(
          raw,
          context ?? { signal: new AbortController().signal },
        ));
      },
    },
    runtime,
    getHappierSessionId: options?.getHappierSessionId ?? (() => 'session-1'),
    ownerId: 'owner-1',
    agentGeneration: 'daemon-generation-1',
    isGenerationCurrent: options?.isGenerationCurrent ?? (() => true),
    resolveProviderGeneration: () => 'provider-generation-1',
    resolveRetirementSignal: options?.resolveRetirementSignal
      ?? (() => options?.retirementSignal ?? null),
    resolveConversation: ({ runtime: candidate, provider }) => (
      resolveEligibleConversation(provider)
        ? {
            conversation:
              (candidate as ExperimentalAgentSessionRealtimeRuntime)
                .realtimeConversation,
            retirementSignal:
              options?.resolveRetirementSignal?.()
              ?? options?.retirementSignal
              ?? null,
          }
        : null
    ),
  });
  return Object.assign(handlers, { dispose: registration.dispose });
}

describe('Agent-session realtime Voice session RPC', () => {
  const canonicalSdpMaxBytes = resolveCanonicalSdpMaxBytes();
  const exactSdp = 'é'.repeat(canonicalSdpMaxBytes / 2);
  const oversizedSdp = `${exactSdp}x`;
  it('relays one declaration-gated WebRTC attachment and its retained terminal fact', async () => {
    const fixture = runtimeFixture();
    const handlers = register(fixture.runtime);

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT)?.({
      v: 1,
      provider: providerRef,
    })).resolves.toEqual({ ok: true, status: 'available', transport: 'webrtc' });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:7',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    })).resolves.toEqual({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=answer\r\n' },
    });
    expect(fixture.start).toHaveBeenCalledWith(
      { transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const watch = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:7',
    });
    fixture.publish({ kind: 'terminal', reason: 'upstream_closed' });
    await expect(watch).resolves.toEqual({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:7',
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_attempt_unavailable',
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:7',
    })).resolves.toMatchObject({ ok: true, status: 'already_stopped' });
    expect(fixture.handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('takes declaration eligibility from the Voice conversation resolver', async () => {
    const fixture = runtimeFixture();
    const handlers = new Map<string, Handler>();
    const registration = registerAgentSessionRealtimeVoiceRpc({
      rpc: {
        registerHandler: (method, handler: RpcHandler) => {
          handlers.set(method, async (raw, context) => await handler(
            raw,
            context ?? { signal: new AbortController().signal },
          ));
        },
      },
      runtime: fixture.runtime,
      getHappierSessionId: () => 'session-1',
      ownerId: 'owner-1',
      agentGeneration: 'daemon-generation-1',
      isGenerationCurrent: () => true,
      resolveProviderGeneration: () => 'provider-generation-1',
      resolveRetirementSignal: () => null,
      resolveConversation: ({ provider, runtime: candidate }) => (
        provider.pluginId === providerRef.pluginId
        && provider.localId === providerRef.localId
          ? {
              conversation:
                (candidate as ExperimentalAgentSessionRealtimeRuntime)
                  .realtimeConversation,
              retirementSignal: null,
            }
          : null
      ),
    });

    await expect(handlers.get(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
    )?.({
      v: 1,
      provider: providerRef,
    })).resolves.toEqual({
      ok: true,
      status: 'available',
      transport: 'webrtc',
    });
    registration.dispose();
  });

  it('settles a pre-aborted public WATCH without retaining a waiter or blocking RPC idle', async () => {
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const rpc = new RpcHandlerManager({
      scopePrefix: 'session-1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => {},
      authorizeRequest: async () => {
        markAuthorizationStarted();
        await authorizationGate;
        return { ok: true };
      },
    });
    const fixture = runtimeFixture();
    const registration = registerAgentSessionRealtimeVoiceRpc({
      rpc,
      runtime: fixture.runtime,
      getHappierSessionId: () => 'session-1',
      ownerId: 'owner-1',
      agentGeneration: 'daemon-generation-1',
      isGenerationCurrent: () => true,
      resolveProviderGeneration: () => 'provider-generation-1',
      resolveRetirementSignal: () => null,
      resolveConversation: ({ runtime: candidate }) => ({
        conversation:
          (candidate as ExperimentalAgentSessionRealtimeRuntime)
            .realtimeConversation,
        retirementSignal: null,
      }),
    });
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:pre-aborted-watch',
    };
    await expect(rpc.invokeLocal(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      {
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      },
    )).resolves.toMatchObject({ ok: true, status: 'started' });

    const abortedWatch = rpc.handleRequest({
      method: `session-1:${SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH}`,
      params: request,
    });
    await authorizationStarted;
    rpc.onSocketDisconnect();
    releaseAuthorization();
    const idle = rpc.waitForIdle();
    const watchOutcome = await Promise.race([
      abortedWatch.then((result) => ({ kind: 'settled' as const, result })),
      new Promise<Readonly<{ kind: 'still_pending' }>>((resolve) => {
        setTimeout(() => resolve({ kind: 'still_pending' }), 25);
      }),
    ]);
    const idleOutcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    if (watchOutcome.kind === 'still_pending' || idleOutcome === 'still_pending') {
      fixture.publish({ kind: 'terminal', reason: 'upstream_closed' });
      await Promise.allSettled([abortedWatch, idle]);
    }

    expect(watchOutcome).toEqual({
      kind: 'settled',
      result: { error: 'agent_realtime_watch_aborted' },
    });
    expect(idleOutcome).toBe('idle');

    const retainedWatch = rpc.handleRequest({
      method: `session-1:${SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH}`,
      params: request,
    });
    fixture.publish({ kind: 'terminal', reason: 'upstream_closed' });
    await expect(retainedWatch).resolves.toEqual({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await expect(rpc.waitForIdle()).resolves.toBeUndefined();
    expect(fixture.handle.dispose).toHaveBeenCalledTimes(1);
    registration.dispose();
  });

  it('returns typed busy for a repeated active attempt and retains terminal for a late watcher', async () => {
    const fixture = runtimeFixture();
    const handlers = register(fixture.runtime);
    const request = {
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:8',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    } as const;
    await handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.(request);
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.(request),
    ).resolves.toEqual({ ok: true, status: 'busy' });
    expect(fixture.start).toHaveBeenCalledTimes(1);

    fixture.publish({ kind: 'terminal', reason: 'error', diagnostic: {
      code: 'upstream_closed',
      severity: 'error',
    } });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:8',
    })).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'error' },
    });
  });

  it('fences concurrent starts before the upstream start promise settles', async () => {
    const fixture = runtimeFixture();
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
    fixture.start.mockImplementationOnce(async () => {
      await gate;
      return {
        status: 'started',
        transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
        handle: fixture.handle,
      };
    });
    const handlers = register(fixture.runtime);
    const request = {
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:concurrent',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    } as const;
    const first = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.(request);
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.(request),
    ).resolves.toEqual({ ok: true, status: 'busy' });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    releaseStart();
    await expect(first).resolves.toMatchObject({ ok: true, status: 'started' });
  });

  it('rejects a wrong provider before structurally inspecting the runtime', async () => {
    const malformedRuntime = {
      realtimeConversation: {
        inspect: vi.fn(async () => { throw new Error('must not inspect'); }),
      },
    };
    const handlers = register(malformedRuntime, () => null);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT)?.({
      v: 1,
      provider: { pluginId: 'happier.agent.other', localId: 'realtime-other' },
    })).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      code: 'agent_realtime_declaration_unavailable',
    });
    expect(malformedRuntime.realtimeConversation.inspect).not.toHaveBeenCalled();
  });

  it('binds stop and retained terminal authority to the exact declaring provider', async () => {
    const resolveBothDeclarations = (ref: Readonly<{ pluginId: string; localId: string }>) => {
      if (ref.pluginId !== providerRef.pluginId) return null;
      if (ref.localId === providerRef.localId) return declaration;
      if (ref.localId === alternateProviderRef.localId) return alternateDeclaration;
      return null;
    };
    const first = runtimeFixture();
    const firstHandlers = register(first.runtime, resolveBothDeclarations);
    await firstHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:provider-bound-stop',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });

    await expect(firstHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
      v: 1,
      provider: alternateProviderRef,
      applicationAttemptId: 'voice-attempt:provider-bound-stop',
    })).resolves.toEqual({ ok: true, status: 'already_stopped' });
    expect(first.handle.stop).not.toHaveBeenCalled();
    await expect(firstHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:provider-bound-stop',
    })).resolves.toEqual({ ok: true, status: 'stopped' });

    const second = runtimeFixture();
    const secondHandlers = register(second.runtime, resolveBothDeclarations);
    await secondHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:provider-bound-watch',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    second.publish({ kind: 'terminal', reason: 'upstream_closed' });
    await expect(secondHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: alternateProviderRef,
      applicationAttemptId: 'voice-attempt:provider-bound-watch',
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_attempt_unavailable',
    });
    await expect(secondHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:provider-bound-watch',
    })).resolves.toMatchObject({
      ok: true,
      status: 'terminal',
      event: { reason: 'upstream_closed' },
    });
  });

  it('retires an attachment when the swap-aware registrar moves to another session', async () => {
    let currentSessionId = 'session-1';
    const fixture = runtimeFixture();
    const retirementOperations = trackStopRequiredRetirement(fixture);
    const handlers = register(fixture.runtime, undefined, {
      getHappierSessionId: () => currentSessionId,
    });
    await handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-bound',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });

    currentSessionId = 'session-2';
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-bound',
    })).resolves.toEqual({ ok: true, status: 'already_stopped' });
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
    expect(retirementOperations).toEqual([
      'stop:start',
      'stop:complete',
      'dispose:stopped',
    ]);

    let watchedSessionId = 'session-1';
    const watchedFixture = runtimeFixture();
    const watchedHandlers = register(watchedFixture.runtime, undefined, {
      getHappierSessionId: () => watchedSessionId,
    });
    await watchedHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-bound-watch',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    watchedSessionId = 'session-2';
    await expect(watchedHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-bound-watch',
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_attempt_unavailable',
    });
    await vi.waitFor(() => (
      expect(watchedFixture.handle.dispose).toHaveBeenCalledTimes(1)
    ));
    expect(watchedFixture.start).toHaveBeenCalledTimes(1);
  });

  it('disposes a pending start that settles after the registrar changes session', async () => {
    let currentSessionId = 'session-1';
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const fixture = runtimeFixture();
    fixture.start.mockImplementationOnce(async () => {
      await startGate;
      return {
        status: 'started',
        transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
        handle: fixture.handle,
      };
    });
    const handlers = register(fixture.runtime, undefined, {
      getHappierSessionId: () => currentSessionId,
    });
    const starting = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:pending-session-swap',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(1));

    currentSessionId = 'session-2';
    releaseStart();
    await expect(starting).resolves.toEqual({ ok: true, status: 'aborted' });
    expect(fixture.handle.dispose).toHaveBeenCalledTimes(1);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:pending-session-swap',
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_attempt_unavailable',
    });
  });

  it('bounds a never-settling stop for a late uncommitted handle before releasing its authority', async () => {
    vi.useFakeTimers();
    try {
      let currentSessionId = 'session-1';
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const fixture = runtimeFixture();
      fixture.start.mockImplementationOnce(async () => {
        await startGate;
        return {
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
          handle: fixture.handle,
        };
      });
      fixture.handle.stop = vi.fn(
        () => new Promise<never>(() => undefined),
      );
      const handlers = register(fixture.runtime, undefined, {
        getHappierSessionId: () => currentSessionId,
      });
      const request = {
        v: 1 as const,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:late-never-settling-stop',
      };
      const starting = handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      });
      expect(fixture.start).toHaveBeenCalledOnce();

      currentSessionId = 'session-2';
      releaseStart();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.handle.stop).toHaveBeenCalledOnce();
      expect(fixture.handle.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
      await expect(starting).resolves.toEqual({ ok: true, status: 'aborted' });

      fixture.start.mockResolvedValueOnce({ status: 'aborted' });
      currentSessionId = 'session-1';
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      })).resolves.toEqual({ ok: true, status: 'aborted' });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a never-settling dispose for a late uncommitted handle before releasing its authority', async () => {
    vi.useFakeTimers();
    try {
      let currentSessionId = 'session-1';
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const fixture = runtimeFixture();
      fixture.start.mockImplementationOnce(async () => {
        await startGate;
        return {
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
          handle: fixture.handle,
        };
      });
      fixture.handle.dispose = vi.fn(
        () => new Promise<never>(() => undefined),
      );
      const handlers = register(fixture.runtime, undefined, {
        getHappierSessionId: () => currentSessionId,
      });
      const request = {
        v: 1 as const,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:late-never-settling-dispose',
      };
      let startingOutcome: unknown;
      const starting = handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      });
      void starting?.then((value) => {
        startingOutcome = value;
      });
      expect(fixture.start).toHaveBeenCalledOnce();

      currentSessionId = 'session-2';
      releaseStart();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.handle.stop).toHaveBeenCalledOnce();
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(startingOutcome).toEqual({ ok: true, status: 'aborted' });
      fixture.start.mockResolvedValueOnce({ status: 'aborted' });
      currentSessionId = 'session-1';
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      })).resolves.toEqual({ ok: true, status: 'aborted' });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and retires a pending start when stop arrives before the runtime handle', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startSignal: AbortSignal | undefined;
    const fixture = runtimeFixture();
    fixture.start.mockImplementationOnce(async (_request, options) => {
      startSignal = options?.signal;
      await startGate;
      return {
        status: 'started',
        transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
        handle: fixture.handle,
      };
    });
    const handlers = register(fixture.runtime);
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:pending-stop',
    };
    const starting = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      ...request,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    });
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(1));

    const stopped = await handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.(request);
    releaseStart();

    expect(stopped).toEqual({ ok: true, status: 'stopped' });
    expect(startSignal?.aborted).toBe(true);
    await expect(starting).resolves.toEqual({ ok: true, status: 'aborted' });
    expect(fixture.handle.stop).toHaveBeenCalledTimes(1);
    expect(fixture.handle.dispose).toHaveBeenCalledTimes(1);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.(request))
      .resolves.toMatchObject({
        ok: false,
        code: 'agent_realtime_attempt_unavailable',
      });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.(request))
      .resolves.toEqual({ ok: true, status: 'already_stopped' });
  });

  it('retains caller-aborted pending authority until the late handle completes mandatory cleanup', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const fixture = runtimeFixture();
    fixture.start.mockImplementationOnce(async () => {
      await startGate;
      return {
        status: 'started',
        transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
        handle: fixture.handle,
      };
    });
    fixture.handle.stop = vi.fn(async () => {
      await stopGate;
      return { status: 'stopped' as const };
    });
    fixture.handle.dispose = vi.fn(async () => {
      await disposeGate;
    });
    const handlers = register(fixture.runtime);
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:abort-ignoring-start',
    };
    const caller = new AbortController();
    const starting = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.(
      {
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      },
      { signal: caller.signal },
    );
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());

    caller.abort();
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.(request),
    ).resolves.toEqual({ ok: true, status: 'stopped' });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      }),
    ).resolves.toEqual({ ok: true, status: 'busy' });

    releaseStart();
    await vi.waitFor(() => expect(fixture.handle.stop).toHaveBeenCalledOnce());
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      }),
    ).resolves.toEqual({ ok: true, status: 'busy' });

    releaseStop();
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      }),
    ).resolves.toEqual({ ok: true, status: 'busy' });

    releaseDispose();
    await expect(starting).resolves.toEqual({ ok: true, status: 'aborted' });
    expect(fixture.handle.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
  });

  it('retains active authority while caller-aborted stop joins mandatory handle cleanup', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const fixture = runtimeFixture();
    fixture.handle.stop = vi.fn(async () => {
      await stopGate;
      return { status: 'stopped' as const };
    });
    fixture.handle.dispose = vi.fn(async () => {
      await stopGate;
      await disposeGate;
    });
    const handlers = register(fixture.runtime);
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:active-aborted-stop',
    };
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'started' });

    const caller = new AbortController();
    const callerStop = handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.(
      request,
      { signal: caller.signal },
    );
    await vi.waitFor(() => expect(fixture.handle.stop).toHaveBeenCalledOnce());
    caller.abort();
    const callerOutcome = await Promise.race([
      callerStop,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    expect(fixture.handle.dispose).not.toHaveBeenCalled();

    const joiningStop = handlers.get(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
    )?.(request);
    const joiningOutcomeBeforeCleanup = await Promise.race([
      joiningStop,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ]);
    const retryWhileCleanupPending = await handlers.get(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
    )?.({
      ...request,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    });

    expect(callerOutcome).toEqual({ ok: true, status: 'aborted' });
    expect(joiningOutcomeBeforeCleanup).toBe('still_pending');
    expect(retryWhileCleanupPending).toEqual({ ok: true, status: 'busy' });
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.handle.stop).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).not.toHaveBeenCalled();

    releaseStop();
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
    await expect(Promise.race([
      joiningStop,
      new Promise<'still_pending'>((resolve) => {
        setTimeout(() => resolve('still_pending'), 25);
      }),
    ])).resolves.toBe('still_pending');
    expect(fixture.handle.stop).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();

    releaseDispose();
    await expect(joiningStop).resolves.toEqual({
      ok: true,
      status: 'already_stopped',
    });
    expect(fixture.handle.stop).toHaveBeenCalledOnce();
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('retires an active attempt when its exact provider or Agent generation retires', async () => {
    let generationCurrent = true;
    const retirement = new AbortController();
    const fixture = runtimeFixture();
    const handlers = register(fixture.runtime, undefined, {
      isGenerationCurrent: () => generationCurrent,
      retirementSignal: retirement.signal,
    });
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:retired-generation',
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      ...request,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    })).resolves.toMatchObject({ ok: true, status: 'started' });

    const terminal = handlers.get(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
    )?.(request);
    generationCurrent = false;
    retirement.abort();

    await expect(terminal).resolves.toEqual({
      ok: true,
      status: 'terminal',
      event: {
        kind: 'terminal',
        reason: 'agent_session_disposed',
      },
    });
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT)?.({
      v: 1,
      provider: providerRef,
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_declaration_unavailable',
    });
  });

  it('retains an exact generation-retirement terminal when retirement wins before WATCH', async () => {
    let generationCurrent = true;
    const retirement = new AbortController();
    const fixture = runtimeFixture();
    const retirementOperations = trackStopRequiredRetirement(fixture);
    const handlers = register(fixture.runtime, undefined, {
      isGenerationCurrent: () => generationCurrent,
      retirementSignal: retirement.signal,
    });
    const request = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:retired-before-watch',
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      ...request,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    })).resolves.toMatchObject({ ok: true, status: 'started' });

    generationCurrent = false;
    retirement.abort();

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.(
      request,
    )).resolves.toEqual({
      ok: true,
      status: 'terminal',
      event: {
        kind: 'terminal',
        reason: 'agent_session_disposed',
      },
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.(
      request,
    )).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_declaration_unavailable',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      ...request,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_declaration_unavailable',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.(
      request,
    )).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_declaration_unavailable',
    });
    expect(fixture.start).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.handle.dispose).toHaveBeenCalledOnce());
    expect(retirementOperations).toEqual([
      'stop:start',
      'stop:complete',
      'dispose:stopped',
    ]);
  });

  it('bounds a never-settling stop for active host retirement before releasing its authority', async () => {
    vi.useFakeTimers();
    try {
      let currentSessionId = 'session-1';
      const fixture = runtimeFixture();
      fixture.handle.stop = vi.fn(
        () => new Promise<never>(() => undefined),
      );
      const handlers = register(fixture.runtime, undefined, {
        getHappierSessionId: () => currentSessionId,
      });
      const request = {
        v: 1 as const,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:active-never-settling-stop',
      };
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      })).resolves.toMatchObject({ ok: true, status: 'started' });
      const terminal = handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
      )?.(request);

      currentSessionId = 'session-2';
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
      )?.({
        v: 1,
        provider: providerRef,
      })).resolves.toEqual({
        ok: true,
        status: 'available',
        transport: 'webrtc',
      });
      await expect(terminal).resolves.toEqual({
        ok: true,
        status: 'terminal',
        event: {
          kind: 'terminal',
          reason: 'agent_session_disposed',
        },
      });
      expect(fixture.handle.stop).toHaveBeenCalledOnce();
      expect(fixture.handle.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
      fixture.start.mockResolvedValueOnce({ status: 'aborted' });
      currentSessionId = 'session-1';
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      })).resolves.toEqual({ ok: true, status: 'aborted' });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a never-settling dispose during active host retirement before releasing its authority', async () => {
    vi.useFakeTimers();
    try {
      const retirement = new AbortController();
      let currentRetirementSignal: AbortSignal | null = retirement.signal;
      const fixture = runtimeFixture();
      fixture.handle.dispose = vi.fn(
        () => new Promise<never>(() => undefined),
      );
      const watch = fixture.handle.watch.bind(fixture.handle);
      fixture.handle.watch = vi.fn((listener) => {
        const subscription = watch(listener);
        retirement.abort();
        return subscription;
      });
      const handlers = register(fixture.runtime, undefined, {
        resolveRetirementSignal: () => currentRetirementSignal,
      });
      const request = {
        v: 1 as const,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:active-never-settling-dispose',
      };
      let startingOutcome: unknown;
      const starting = handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      });
      void starting?.then((value) => {
        startingOutcome = value;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.handle.stop).toHaveBeenCalledOnce();
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(startingOutcome).toEqual({ ok: true, status: 'aborted' });
      currentRetirementSignal = null;
      fixture.start.mockResolvedValueOnce({ status: 'aborted' });
      await expect(handlers.get(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
      )?.({
        ...request,
        transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
      })).resolves.toEqual({ ok: true, status: 'aborted' });
      expect(fixture.start).toHaveBeenCalledTimes(2);
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires active and pending attempts when the owning host session exits', async () => {
    const activeFixture = runtimeFixture();
    const retirementOperations = trackStopRequiredRetirement(activeFixture);
    const activeHandlers = register(activeFixture.runtime);
    const activeRequest = {
      v: 1 as const,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-exit-active',
    };
    await activeHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      ...activeRequest,
      transport: { kind: 'webrtc' as const, offerSdp: 'v=0\r\n' },
    });
    const terminal = activeHandlers.get(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
    )?.(activeRequest);

    activeHandlers.dispose();

    await expect(terminal).resolves.toEqual({
      ok: true,
      status: 'terminal',
      event: {
        kind: 'terminal',
        reason: 'agent_session_disposed',
      },
    });
    await vi.waitFor(() => expect(activeFixture.handle.dispose).toHaveBeenCalledOnce());
    expect(retirementOperations).toEqual([
      'stop:start',
      'stop:complete',
      'dispose:stopped',
    ]);

    let pendingSignal: AbortSignal | undefined;
    const pendingFixture = runtimeFixture();
    pendingFixture.start.mockImplementationOnce((_request, options): Promise<AgentSessionRealtimeStartResult> => {
      pendingSignal = options?.signal;
      return new Promise<AgentSessionRealtimeStartResult>(() => {});
    });
    const pendingHandlers = register(pendingFixture.runtime);
    void pendingHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:session-exit-pending',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    await vi.waitFor(() => expect(pendingFixture.start).toHaveBeenCalledOnce());

    pendingHandlers.dispose();

    expect(pendingSignal?.aborted).toBe(true);
  });

  it('retains no unbounded history for unmatched or normally stopped attempts', async () => {
    const fixture = runtimeFixture();
    const handlers = register(fixture.runtime);
    const stoppedAttemptIds = Array.from(
      { length: 128 },
      (_, index) => `voice-attempt:unmatched:${index}`,
    );
    for (const applicationAttemptId of stoppedAttemptIds) {
      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId,
      })).resolves.toEqual({
        ok: true,
        status: 'already_stopped',
      });
    }

    const normallyStoppedAttemptIds = [
      'voice-attempt:different',
      ...Array.from(
        { length: 16 },
        (_, index) => `voice-attempt:normal:${index}`,
      ),
      stoppedAttemptIds.at(-1)!,
    ];
    for (const applicationAttemptId of normallyStoppedAttemptIds) {
      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId,
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=bounded-history\r\n' },
      })).resolves.toMatchObject({
        ok: true,
        status: 'started',
      });
      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId,
      })).resolves.toEqual({
        ok: true,
        status: 'stopped',
      });
    }
    expect(fixture.start).toHaveBeenCalledTimes(normallyStoppedAttemptIds.length);
    expect(fixture.handle.stop).toHaveBeenCalledTimes(normallyStoppedAttemptIds.length);
    handlers.dispose();
    await vi.waitFor(() => (
      expect(fixture.handle.dispose).toHaveBeenCalledTimes(normallyStoppedAttemptIds.length)
    ));
  });

  it('enforces exact UTF-8 offer and answer byte limits at the daemon RPC boundary', async () => {
    expect(new TextEncoder().encode(exactSdp).byteLength)
      .toBe(canonicalSdpMaxBytes);
    expect(new TextEncoder().encode(oversizedSdp).byteLength)
      .toBe(canonicalSdpMaxBytes + 1);
    const exactFixture = runtimeFixture();
    exactFixture.start.mockResolvedValueOnce({
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: exactSdp },
      handle: exactFixture.handle,
    });
    const exactHandlers = register(exactFixture.runtime);
    await expect(exactHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:exact-sdp',
      transport: { kind: 'webrtc', offerSdp: exactSdp },
    })).resolves.toEqual({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: exactSdp },
    });
    exactHandlers.dispose();
    await vi.waitFor(() => (
      expect(exactFixture.handle.dispose).toHaveBeenCalledTimes(1)
    ));

    const oversizedOfferFixture = runtimeFixture();
    const oversizedOfferHandlers = register(oversizedOfferFixture.runtime);
    await expect(oversizedOfferHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:oversized-offer',
      transport: { kind: 'webrtc', offerSdp: oversizedSdp },
    })).resolves.toEqual({
      ok: false,
      status: 'unavailable',
      code: 'invalid_parameters',
      message: 'Invalid Agent realtime start request.',
    });
    expect(oversizedOfferFixture.start).not.toHaveBeenCalled();

    const fixture = runtimeFixture();
    fixture.start.mockResolvedValueOnce({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: oversizedSdp,
      },
      handle: fixture.handle,
    });
    const handlers = register(fixture.runtime);

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:oversized-answer',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    })).resolves.toEqual({
      ok: false,
      status: 'failed',
      code: 'agent_realtime_answer_invalid',
      message: 'Agent realtime returned an invalid WebRTC answer.',
    });
    expect(fixture.handle.stop).toHaveBeenCalledTimes(1);
    expect(fixture.handle.dispose).toHaveBeenCalledTimes(1);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:oversized-answer',
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_realtime_attempt_unavailable',
    });
  });

  it('projects only stable diagnostic codes and static host text across the Voice provider boundary', async () => {
    const sentinels = [
      'TOKEN=sk-private-agent-runtime',
      'v=0\\r\\na=private-sdp',
      'private transcript fragment',
      'private startup instructions',
    ] as const;
    const expectSanitized = (value: unknown) => {
      const serialized = JSON.stringify(value);
      for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain('"details"');
    };

    const inspectFixture = runtimeFixture();
    inspectFixture.inspect.mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'authentication_required',
      diagnostic: {
        code: 'authentication_required',
        severity: 'error',
        message: sentinels[0],
        details: { leaked: sentinels[3] },
      },
    });
    const inspectResult = await register(inspectFixture.runtime)
      .get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT)?.({
        v: 1,
        provider: providerRef,
      });
    expect(inspectResult).toEqual({
      ok: false,
      status: 'unavailable',
      code: 'authentication_required',
      message: 'Agent realtime is unavailable.',
      reason: 'authentication_required',
    });
    expectSanitized(inspectResult);

    const thrownStartFixture = runtimeFixture();
    thrownStartFixture.start.mockRejectedValueOnce(new Error(sentinels[1]));
    const thrownStartResult = await register(thrownStartFixture.runtime)
      .get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:sanitized-throw',
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
      });
    expect(thrownStartResult).toEqual({
      ok: false,
      status: 'failed',
      code: 'agent_realtime_start_failed',
      message: 'Agent realtime start failed.',
    });
    expectSanitized(thrownStartResult);

    const failedStartFixture = runtimeFixture();
    failedStartFixture.start.mockResolvedValueOnce({
      status: 'failed',
      diagnostic: {
        code: 'upstream_rejected',
        severity: 'error',
        message: sentinels[2],
        details: { leaked: sentinels[0] },
      },
    });
    const failedStartResult = await register(failedStartFixture.runtime)
      .get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:sanitized-result',
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
      });
    expect(failedStartResult).toEqual({
      ok: false,
      status: 'failed',
      code: 'upstream_rejected',
      message: 'Agent realtime start failed.',
    });
    expectSanitized(failedStartResult);

    const terminalFixture = runtimeFixture();
    const terminalHandlers = register(terminalFixture.runtime);
    await terminalHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:sanitized-terminal',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    terminalFixture.publish({
      kind: 'terminal',
      reason: 'error',
      diagnostic: {
        code: 'upstream_closed',
        severity: 'warning',
        message: sentinels[3],
        details: { leaked: sentinels[2] },
      },
    });
    const terminalResult = await terminalHandlers
      .get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:sanitized-terminal',
      });
    expect(terminalResult).toEqual({
      ok: true,
      status: 'terminal',
      event: {
        kind: 'terminal',
        reason: 'error',
        diagnostic: {
          code: 'upstream_closed',
          severity: 'warning',
        },
      },
    });
    expectSanitized(terminalResult);

    const stoppedFixture = runtimeFixture();
    stoppedFixture.handle.stop = vi.fn(async () => ({
      status: 'unavailable' as const,
      diagnostic: {
        code: 'stop_unavailable',
        severity: 'error' as const,
        message: sentinels[0],
        details: { leaked: sentinels[1] },
      },
    }));
    const stoppedHandlers = register(stoppedFixture.runtime);
    await stoppedHandlers.get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START)?.({
      v: 1,
      provider: providerRef,
      applicationAttemptId: 'voice-attempt:sanitized-stop',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    const stoppedResult = await stoppedHandlers
      .get(SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP)?.({
        v: 1,
        provider: providerRef,
        applicationAttemptId: 'voice-attempt:sanitized-stop',
      });
    expect(stoppedResult).toEqual({
      ok: false,
      status: 'unavailable',
      code: 'stop_unavailable',
      message: 'Agent realtime stop is unavailable.',
    });
    expectSanitized(stoppedResult);
  });
});

import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_SESSION_REALTIME_SDP_MAX_BYTES } from '@happier-dev/protocol';
import type { AgentSessionRealtimeHandle } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  cleanupBoundAgentSessionRealtimeService,
  createAgentSessionRealtimeService as createAgentSessionRealtimeServiceForAddress,
} from './createAgentSessionRealtimeService';

type CreateAgentSessionRealtimeServiceInput = Parameters<
  typeof createAgentSessionRealtimeServiceForAddress
>[0];

function createAgentSessionRealtimeService(
  input: Omit<CreateAgentSessionRealtimeServiceInput, 'conversationSessionAddress'> & Readonly<{
    conversationSessionId: string;
  }>,
) {
  const { conversationSessionId, ...rest } = input;
  return createAgentSessionRealtimeServiceForAddress({
    ...rest,
    conversationSessionAddress: { serverId: 'server-a', sessionId: conversationSessionId },
  });
}

const provider = { pluginId: 'happier.agent.codex', localId: 'realtime-codex' } as const;
const sentinels = {
  inspect: 'TOKEN=sk-private-agent-runtime',
  start: 'v=0\r\na=private-sdp',
  watch: 'private transcript fragment',
  stop: 'private startup instructions',
} as const;

type DiagnosticOperation = keyof typeof sentinels;

const successfulStart = {
  ok: true,
  status: 'started',
  transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=answer\r\n' },
} as const;

function expectNoDiagnosticSentinel(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of Object.values(sentinels)) {
    expect(serialized).not.toContain(sentinel);
  }
  expect(serialized).not.toContain('"details"');
}

async function exerciseProviderFacingOperation(input: Readonly<{
  operation: DiagnosticOperation;
  result(): Promise<unknown>;
}>): Promise<unknown> {
  const terminalEntered1 = createDeferred<void>();
  const terminal = vi.fn((_event: unknown) => { if (terminal.mock.calls.length === 1) terminalEntered1.resolve(); });
  const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
    handle.watch(terminal);
  });
  const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
    if (method.endsWith(`.${input.operation}`)) return await input.result();
    if (method.endsWith('.start')) return successfulStart;
    if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
    if (method.endsWith('.stop')) return { ok: true, status: 'stopped' };
    return { ok: true, status: 'available', transport: 'webrtc' };
  });
  const service = createAgentSessionRealtimeService({
    provider,
    conversationSessionId: `session-${input.operation}`,
    applicationAttemptId: `voice:${input.operation}`,
    signal: new AbortController().signal,
    sessionRpc,
    onStarted,
  });

  if (input.operation === 'inspect') return await service.inspect();

  const started = await service.start({
    transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
  });
  if (input.operation === 'start') return started;
  expect(started.status).toBe('started');
  if (started.status !== 'started') return started;

  if (input.operation === 'stop') return await started.handle.stop();

  await terminalEntered1.promise;
  expect(terminal).toHaveBeenCalledTimes(1);
  return terminal.mock.calls[0]?.[0];
}

describe('bound Agent-session realtime service', () => {
  it.each([
    { serverId: 'server-a', sessionId: 'session-1' },
    { serverId: 'server-a', sessionId: 'other-session' },
    { serverId: 'other-home', sessionId: 'session-1' },
  ])('keeps native instruction receipts host-private and bound to the exact Session: %j', async (preparedInstructionsFor) => {
      const onStarted = vi.fn();
      const service = createAgentSessionRealtimeService({
        provider, conversationSessionId: 'session-1', applicationAttemptId: 'voice:receipt',
        signal: new AbortController().signal, onStarted,
        sessionRpc: async ({ method }) => method.endsWith('.start')
          ? { ...successfulStart, preparedInstructionsFor }
          : method.endsWith('.watch') ? await new Promise<never>(() => undefined)
            : { ok: true, status: 'stopped' },
      });
      const result = await service.start({ transport: { kind: 'webrtc', offerSdp: 'offer' } });
      expect(result.status).toBe('started');
      if (result.status !== 'started') return;
      expect(result).not.toHaveProperty('preparedInstructionsFor');
      if (preparedInstructionsFor.sessionId === 'session-1') {
        expect(onStarted).toHaveBeenCalledWith(result.handle, { serverId: 'server-a', sessionId: 'session-1' });
      }
      else expect(onStarted).toHaveBeenCalledWith(result.handle);
      await cleanupBoundAgentSessionRealtimeService(service);
    },
  );
  it('forwards an exactly-at-limit UTF-8 offer through the public attempt facade', async () => {
    const exactOfferSdp = 'é'.repeat(AGENT_SESSION_REALTIME_SDP_MAX_BYTES / 2);
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
      return { ok: true, status: 'stopped' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-exact-offer-bound',
      applicationAttemptId: 'voice:exact-offer-bound',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });

    await expect(service.start({
      transport: { kind: 'webrtc', offerSdp: exactOfferSdp },
    })).resolves.toMatchObject({ status: 'started' });

    expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.agentRealtime.start',
      payload: expect.objectContaining({
        transport: { kind: 'webrtc', offerSdp: exactOfferSdp },
      }),
    }));
  });

  it('rejects a multibyte byte-oversized offer before RPC without consuming start', async () => {
    const exactOfferSdp = 'é'.repeat(AGENT_SESSION_REALTIME_SDP_MAX_BYTES / 2);
    const oversizedOfferSdp = `${exactOfferSdp}x`;
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
      return { ok: true, status: 'stopped' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-oversized-offer-bound',
      applicationAttemptId: 'voice:oversized-offer-bound',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });

    await expect(service.start({
      transport: { kind: 'webrtc', offerSdp: oversizedOfferSdp },
    })).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'agent_realtime_invalid_start_request',
        message: 'Agent realtime start failed.',
      },
    });
    expect(sessionRpc).not.toHaveBeenCalled();

    await expect(service.start({
      transport: { kind: 'webrtc', offerSdp: exactOfferSdp },
    })).resolves.toMatchObject({ status: 'started' });
    expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.agentRealtime.start',
    }));
  });

  it('preserves authentication-required as a typed availability reason', async () => {
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-auth',
      applicationAttemptId: 'voice:auth',
      signal: new AbortController().signal,
      sessionRpc: vi.fn(async () => ({
        ok: false,
        status: 'unavailable',
        code: 'agent_realtime_authentication_required',
        message: 'Connect the selected Agent account.',
        reason: 'authentication_required',
      })),
      onStarted: vi.fn(),
    });

    await expect(service.inspect()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'authentication_required',
      diagnostic: { code: 'agent_realtime_authentication_required' },
    });
  });

  it('registers the attempt owner against the public handle before returning a successful start', async () => {
    let resolveWatch!: (value: unknown) => void;
    const calls: string[] = [];
    const ownerTerminalEntered1 = createDeferred<void>();
    const ownerTerminal = vi.fn((_event: unknown) => { if (ownerTerminal.mock.calls.length === 1) ownerTerminalEntered1.resolve(); });
    const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
      handle.watch(ownerTerminal);
    });
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      calls.push(method);
      if (method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=answer\r\n' },
        };
      }
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => { resolveWatch = resolve; });
      }
      return { ok: true, status: 'stopped' };
    });
    const serviceInput = {
      provider,
      conversationSessionId: 'session-1',
      applicationAttemptId: 'voice:1',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted,
    };
    const service = createAgentSessionRealtimeService(serviceInput);

    await expect(service.inspect()).resolves.toEqual({
      status: 'available',
      transport: 'webrtc',
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledWith(started.handle);
    expect(calls.at(-1)).toBe('session.agentRealtime.watch');

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await ownerTerminalEntered1.promise;
    expect(ownerTerminal).toHaveBeenCalledTimes(1);
    expect(ownerTerminal).toHaveBeenCalledWith({
      kind: 'terminal',
      reason: 'upstream_closed',
    });
    const late = vi.fn();
    started.handle.watch(late);
    expect(late).toHaveBeenCalledWith({ kind: 'terminal', reason: 'upstream_closed' });
  });

  it.each([
    { reason: 'upstream_closed' as const },
    { reason: 'error' as const },
  ])(
    'does not replace a retained $reason WATCH fact when STOP first reports already_stopped',
    async ({ reason }) => {
      let resolveWatch!: (value: unknown) => void;
      const ownerTerminalEntered1 = createDeferred<void>();
      const ownerTerminal = vi.fn((_event: unknown) => { if (ownerTerminal.mock.calls.length === 1) ownerTerminalEntered1.resolve(); });
      const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
        handle.watch(ownerTerminal);
      });
      const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
        if (method.endsWith('.start')) return successfulStart;
        if (method.endsWith('.watch')) {
          return await new Promise((resolve) => {
            resolveWatch = resolve;
          });
        }
        if (method.endsWith('.stop')) {
          return { ok: true, status: 'already_stopped' };
        }
        return { ok: true, status: 'available', transport: 'webrtc' };
      });
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionId: `session-retained-${reason}`,
        applicationAttemptId: `voice:retained-${reason}`,
        signal: new AbortController().signal,
        sessionRpc,
        onStarted,
      });
      const started = await service.start({
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
      });
      expect(started.status).toBe('started');
      if (started.status !== 'started') return;

      await expect(started.handle.stop()).resolves.toEqual({
        status: 'already_stopped',
      });
      expect(ownerTerminal).not.toHaveBeenCalled();

      const retainedTerminal = { kind: 'terminal' as const, reason };
      resolveWatch({
        ok: true,
        status: 'terminal',
        event: retainedTerminal,
      });
      await ownerTerminalEntered1.promise;
      expect(ownerTerminal).toHaveBeenCalledOnce();
      expect(ownerTerminal).toHaveBeenCalledWith(retainedTerminal);

      const late = vi.fn();
      started.handle.watch(late);
      expect(late).toHaveBeenCalledOnce();
      expect(late).toHaveBeenCalledWith(retainedTerminal);
    },
  );

  it('stops and disposes the remote attachment once when the attempt aborts', async () => {
    let resolveWatch!: (value: unknown) => void;
    const stopEntered1 = createDeferred<void>();
    const stop = vi.fn(async () => { if (stop.mock.calls.length === 1) stopEntered1.resolve(); return ({ ok: true, status: 'stopped' }); });
    const controller = new AbortController();
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
        };
      }
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => { resolveWatch = resolve; });
      }
      if (method.endsWith('.stop')) return await stop();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-1',
      applicationAttemptId: 'voice:2',
      signal: controller.signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    expect(started.status).toBe('started');
    controller.abort();
    await stopEntered1.promise;
    expect(stop).toHaveBeenCalledTimes(1);
    if (started.status === 'started') {
      await started.handle.stop();
      await started.handle.dispose();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });
  });

  it('settles inspect and start promptly on abort while abort-ignoring RPCs settle late', async () => {
    let rejectInspect!: (error: Error) => void;
    const pendingInspect = new Promise<never>((_resolve, reject) => {
      rejectInspect = reject;
    });
    const inspectRpcEntered = createDeferred<void>();
    const inspectAttempt = new AbortController();
    const inspectService = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-pending-inspect',
      applicationAttemptId: 'voice:pending-inspect',
      signal: inspectAttempt.signal,
      sessionRpc: vi.fn(async () => {
        inspectRpcEntered.resolve();
        return await pendingInspect;
      }),
      onStarted: vi.fn(),
    });
    const inspecting = inspectService.inspect();

    let resolveStart!: (value: unknown) => void;
    const pendingStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const startAttempt = new AbortController();
    const stopRpc = vi.fn(async () => ({ ok: true, status: 'stopped' }));
    const onStarted = vi.fn();
    const sessionRpcEntered1 = createDeferred<void>();
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => { if (sessionRpc.mock.calls.length === 1) sessionRpcEntered1.resolve();
      if (method.endsWith('.start')) return await pendingStart;
      if (method.endsWith('.stop')) return await stopRpc();
      if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const startService = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-pending-start',
      applicationAttemptId: 'voice:pending-start',
      signal: startAttempt.signal,
      sessionRpc,
      onStarted,
    });
    const starting = startService.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=pending-offer\r\n' },
    });
    await Promise.all([inspectRpcEntered.promise, sessionRpcEntered1.promise]);
    expect(sessionRpc).toHaveBeenCalledTimes(1);

    inspectAttempt.abort();
    startAttempt.abort();
    // Both RPCs remain held until the public abort results have settled.
    const [inspectOutcome, startOutcome] = await Promise.all([inspecting, starting]);

    rejectInspect(new Error('late_inspect_rejection'));
    resolveStart({ ...successfulStart, preparedInstructionsFor: { serverId: 'server-a', sessionId: 'session-pending-start' } });
    await Promise.all([inspecting, starting]);

    expect(inspectOutcome).toMatchObject({
      status: 'unavailable',
      reason: 'session_unavailable',
      diagnostic: { code: 'agent_realtime_attempt_aborted' },
    });
    expect(startOutcome).toEqual({ status: 'aborted' });
    expect(onStarted).not.toHaveBeenCalled();
    expect(stopRpc).toHaveBeenCalledOnce();
  });

  it('boundedly compensates a late started result after dual-ambiguous aborted cleanup', async () => {
    let resolveStart!: (value: unknown) => void;
    const pendingStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const stopRpcEntered2 = createDeferred<void>();
    const stopRpcEntered4 = createDeferred<void>();
    const stopRpc = vi.fn(async () => { if (stopRpc.mock.calls.length === 2) stopRpcEntered2.resolve(); if (stopRpc.mock.calls.length === 4) stopRpcEntered4.resolve();
      if (stopRpc.mock.calls.length < 4) {
        throw new Error('stop_transport_closed');
      }
      return { ok: true, status: 'stopped' };
    });
    const sessionRpcEntered1 = createDeferred<void>();
    const sessionRpc = vi.fn(async (request: Readonly<{
      sessionAddress: Readonly<{ serverId: string; sessionId: string }>;
      method: string;
      payload: unknown;
      signal: AbortSignal;
    }>) => { if (sessionRpc.mock.calls.length === 1) sessionRpcEntered1.resolve();
      if (request.method.endsWith('.start')) return await pendingStart;
      if (request.method.endsWith('.stop')) return await stopRpc();
      if (request.method.endsWith('.watch')) {
        return await new Promise<never>(() => undefined);
      }
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const attempt = new AbortController();
    const caller = new AbortController();
    const onStarted = vi.fn();
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-late-start-dual-ambiguous',
      applicationAttemptId: 'voice:late-start-dual-ambiguous',
      signal: attempt.signal,
      sessionRpc,
      onStarted,
    });
    const starting = service.start(
      {
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=pending-offer\r\n' },
      },
      { signal: caller.signal },
    );
    await sessionRpcEntered1.promise;
    expect(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
        method: 'session.agentRealtime.start',
      }));

    caller.abort();
    await expect(starting).resolves.toEqual({ status: 'aborted' });
    await stopRpcEntered2.promise;
    // Let the second transport rejection settle before admitting the late START.
    await flushHookEffects();
    expect(stopRpc).toHaveBeenCalledTimes(2);

    resolveStart(successfulStart);
    await stopRpcEntered4.promise;
    expect(stopRpc).toHaveBeenCalledTimes(4);
    await Promise.resolve();

    const stopRequests = sessionRpc.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method.endsWith('.stop'))
      .map(({ sessionAddress, method, payload }) => ({ sessionAddress, method, payload }));
    const expectedStopRequest = {
      sessionAddress: { serverId: 'server-a', sessionId: 'session-late-start-dual-ambiguous' },
      method: 'session.agentRealtime.stop',
      payload: {
        v: 1,
        provider,
        applicationAttemptId: 'voice:late-start-dual-ambiguous',
      },
    };
    expect(stopRequests).toEqual([
      expectedStopRequest,
      expectedStopRequest,
      expectedStopRequest,
      expectedStopRequest,
    ]);
    expect(stopRpc).toHaveBeenCalledTimes(4);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('keeps public abort bounded while host cleanup waits for late-start compensation', async () => {
    let resolveStart!: (value: unknown) => void;
    const pendingStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    let resolveFirstStop!: (value: unknown) => void;
    const stopRpcEntered1 = createDeferred<void>();
    const stopRpc = vi.fn(async () => { if (stopRpc.mock.calls.length === 1) stopRpcEntered1.resolve();
      if (stopRpc.mock.calls.length === 1) {
        return await new Promise((resolve) => {
          resolveFirstStop = resolve;
        });
      }
      return { ok: true, status: 'stopped' };
    });
    const sessionRpcEntered1 = createDeferred<void>();
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => { if (sessionRpc.mock.calls.length === 1) sessionRpcEntered1.resolve();
      if (method.endsWith('.start')) return await pendingStart;
      if (method.endsWith('.stop')) return await stopRpc();
      if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const attempt = new AbortController();
    const caller = new AbortController();
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-late-start-host-cleanup',
      applicationAttemptId: 'voice:late-start-host-cleanup',
      signal: attempt.signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const starting = service.start(
      { transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=pending-offer\r\n' } },
      { signal: caller.signal },
    );
    await sessionRpcEntered1.promise;
    expect(sessionRpc).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.agentRealtime.start' }),
    );

    caller.abort();
    await expect(starting).resolves.toEqual({ status: 'aborted' });
    await stopRpcEntered1.promise;
    expect(stopRpc).toHaveBeenCalledOnce();

    let cleanupSettled = false;
    const cleanup = cleanupBoundAgentSessionRealtimeService(service).then(() => {
      cleanupSettled = true;
    });
    resolveStart(successfulStart);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(stopRpc).toHaveBeenCalledOnce();

    resolveFirstStop({ ok: true, status: 'already_stopped' });
    await cleanup;

    expect(stopRpc).toHaveBeenCalledTimes(2);
    expect(cleanupSettled).toBe(true);
  });

  it('does not let a caller-aborted stop suppress mandatory disposal cleanup', async () => {
    let resolveWatch!: (value: unknown) => void;
    const stopRpc = vi.fn(async () => ({ ok: true, status: 'stopped' }));
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-aborted-stop',
      applicationAttemptId: 'voice:aborted-stop',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const caller = new AbortController();
    caller.abort();

    await expect(started.handle.stop({ signal: caller.signal }))
      .resolves.toEqual({ status: 'aborted' });
    expect(stopRpc).not.toHaveBeenCalled();
    await started.handle.dispose();

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });
    expect(stopRpc).toHaveBeenCalledTimes(1);
  });

  it('retries mandatory disposal after an in-flight caller stop is aborted', async () => {
    let resolveWatch!: (value: unknown) => void;
    let resolveFirstStop!: (value: unknown) => void;
    const stopRpcEntered1 = createDeferred<void>();
    const stopRpc = vi.fn(async () => { if (stopRpc.mock.calls.length === 1) stopRpcEntered1.resolve();
      if (stopRpc.mock.calls.length === 1) {
        return await new Promise((resolve) => {
          resolveFirstStop = resolve;
        });
      }
      return { ok: true, status: 'stopped' };
    });
    const sessionRpc = vi.fn(async ({
      method,
      signal,
    }: Readonly<{ method: string; signal: AbortSignal }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (method.endsWith('.stop')) {
        const result = stopRpc();
        return await Promise.race([
          result,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('stop_aborted')),
              { once: true },
            );
          }),
        ]);
      }
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-inflight-aborted-stop',
      applicationAttemptId: 'voice:inflight-aborted-stop',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const caller = new AbortController();
    const callerStop = started.handle.stop({ signal: caller.signal });
    await stopRpcEntered1.promise;
    expect(stopRpc).toHaveBeenCalledTimes(1);

    caller.abort();
    const disposing = started.handle.dispose();
    await expect(callerStop).resolves.toEqual({ status: 'aborted' });
    await disposing;

    resolveFirstStop({ ok: true, status: 'stopped' });
    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });
    expect(stopRpc).toHaveBeenCalledTimes(2);
  });

  it('retries an ambiguous STOP transport failure once during mandatory disposal', async () => {
    let resolveWatch!: (value: unknown) => void;
    const stopRpc = vi.fn()
      .mockRejectedValueOnce(new Error('stop_transport_closed'))
      .mockResolvedValueOnce({ ok: true, status: 'stopped' });
    const sessionRpc = vi.fn(async (request: Readonly<{
      sessionAddress: Readonly<{ serverId: string; sessionId: string }>;
      method: string;
      payload: unknown;
      signal: AbortSignal;
    }>) => {
      if (request.method.endsWith('.start')) return successfulStart;
      if (request.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (request.method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-stop-transport-retry',
      applicationAttemptId: 'voice:stop-transport-retry',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    await expect(started.handle.stop()).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'agent_realtime_stop_failed' },
    });
    await started.handle.dispose();
    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });

    const stopRequests = sessionRpc.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method.endsWith('.stop'))
      .map(({ sessionAddress, method, payload }) => ({ sessionAddress, method, payload }));
    const expectedStopRequest = {
      sessionAddress: { serverId: 'server-a', sessionId: 'session-stop-transport-retry' },
      method: 'session.agentRealtime.stop',
      payload: {
        v: 1,
        provider,
        applicationAttemptId: 'voice:stop-transport-retry',
      },
    };
    expect(stopRequests).toEqual([expectedStopRequest, expectedStopRequest]);
    expect(stopRpc).toHaveBeenCalledTimes(2);

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });
  });

  it('retries a malformed STOP response once during mandatory disposal', async () => {
    let resolveWatch!: (value: unknown) => void;
    const stopRpc = vi.fn()
      .mockResolvedValueOnce({ malformed: true })
      .mockResolvedValueOnce({ ok: true, status: 'already_stopped' });
    const sessionRpc = vi.fn(async (request: Readonly<{
      sessionAddress: Readonly<{ serverId: string; sessionId: string }>;
      method: string;
      payload: unknown;
      signal: AbortSignal;
    }>) => {
      if (request.method.endsWith('.start')) return successfulStart;
      if (request.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (request.method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-stop-malformed-retry',
      applicationAttemptId: 'voice:stop-malformed-retry',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    await expect(started.handle.stop()).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'agent_realtime_invalid_stop_response' },
    });
    await started.handle.dispose();
    await expect(started.handle.stop()).resolves.toEqual({
      status: 'already_stopped',
    });

    const stopRequests = sessionRpc.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method.endsWith('.stop'))
      .map(({ sessionAddress, method, payload }) => ({ sessionAddress, method, payload }));
    const expectedStopRequest = {
      sessionAddress: { serverId: 'server-a', sessionId: 'session-stop-malformed-retry' },
      method: 'session.agentRealtime.stop',
      payload: {
        v: 1,
        provider,
        applicationAttemptId: 'voice:stop-malformed-retry',
      },
    };
    expect(stopRequests).toEqual([expectedStopRequest, expectedStopRequest]);
    expect(stopRpc).toHaveBeenCalledTimes(2);

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
  });

  it('bounds mandatory disposal to one retry after ambiguous STOP failures', async () => {
    let resolveWatch!: (value: unknown) => void;
    const ownerTerminal = vi.fn();
    const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
      handle.watch(ownerTerminal);
    });
    const stopRpc = vi.fn(async () => {
      throw new Error('stop_transport_closed');
    });
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-stop-bounded-retry',
      applicationAttemptId: 'voice:stop-bounded-retry',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted,
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const watchingBeforeDispose = vi.fn();
    started.handle.watch(watchingBeforeDispose);

    await started.handle.dispose();
    await started.handle.dispose();
    const retainedStopResult = {
      status: 'unavailable',
      diagnostic: {
        code: 'agent_realtime_stop_failed',
        severity: 'error',
        message: 'Agent realtime stop failed.',
      },
    } as const;
    await expect(started.handle.stop()).resolves.toEqual(retainedStopResult);
    await expect(started.handle.stop()).resolves.toEqual(retainedStopResult);
    const watchingAfterDispose = vi.fn();
    started.handle.watch(watchingAfterDispose);
    await started.handle.dispose();

    expect(stopRpc).toHaveBeenCalledTimes(2);
    const retainedTerminal = {
      kind: 'terminal',
      reason: 'error',
      diagnostic: retainedStopResult.diagnostic,
    } as const;
    expect(ownerTerminal).toHaveBeenCalledOnce();
    expect(ownerTerminal).toHaveBeenCalledWith(retainedTerminal);
    expect(watchingBeforeDispose).toHaveBeenCalledOnce();
    expect(watchingBeforeDispose).toHaveBeenCalledWith(retainedTerminal);
    expect(watchingAfterDispose).toHaveBeenCalledOnce();
    expect(watchingAfterDispose).toHaveBeenCalledWith(retainedTerminal);

    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await Promise.resolve();

    expect(ownerTerminal).toHaveBeenCalledOnce();
    expect(watchingBeforeDispose).toHaveBeenCalledOnce();
    expect(watchingAfterDispose).toHaveBeenCalledOnce();
  });

  it('caches an authoritative STOP unavailable result across mandatory disposal', async () => {
    let resolveWatch!: (value: unknown) => void;
    const stopRpc = vi.fn(async () => ({
      ok: false,
      status: 'unavailable',
      code: 'agent_realtime_stop_unavailable',
      message: 'private remote diagnostic',
    }));
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-stop-authoritative-unavailable',
      applicationAttemptId: 'voice:stop-authoritative-unavailable',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    const authoritativeResult = {
      status: 'unavailable',
      diagnostic: {
        code: 'agent_realtime_stop_unavailable',
        severity: 'error',
        message: 'Agent realtime stop is unavailable.',
      },
    } as const;
    await expect(started.handle.stop()).resolves.toEqual(authoritativeResult);
    await started.handle.dispose();
    await expect(started.handle.stop()).resolves.toEqual(authoritativeResult);

    expect(stopRpc).toHaveBeenCalledOnce();
    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
  });

  it('lets a joining stop caller abort independently while shared disposal continues', async () => {
    let resolveWatch!: (value: unknown) => void;
    let resolveStop!: (value: unknown) => void;
    const pendingStop = new Promise((resolve) => {
      resolveStop = resolve;
    });
    const stopRpcEntered1 = createDeferred<void>();
    const stopRpc = vi.fn(async () => { if (stopRpc.mock.calls.length === 1) stopRpcEntered1.resolve(); return await pendingStop; });
    const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
      if (method.endsWith('.start')) return successfulStart;
      if (method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (method.endsWith('.stop')) return await stopRpc();
      return { ok: true, status: 'available', transport: 'webrtc' };
    });
    const service = createAgentSessionRealtimeService({
      provider,
      conversationSessionId: 'session-shared-dispose',
      applicationAttemptId: 'voice:shared-dispose',
      signal: new AbortController().signal,
      sessionRpc,
      onStarted: vi.fn(),
    });
    const started = await service.start({
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    let disposeSettled = false;
    const disposing = Promise.resolve(started.handle.dispose()).then(() => {
      disposeSettled = true;
    });
    await stopRpcEntered1.promise;
    expect(stopRpc).toHaveBeenCalledOnce();
    const caller = new AbortController();
    const callerStop = started.handle.stop({ signal: caller.signal });
    caller.abort();
    const callerOutcome = await callerStop;
    const disposeWasPendingAtCallerAbort = !disposeSettled;
    const stopCallsBeforeSharedSettlement = stopRpc.mock.calls.length;

    resolveStop({ ok: true, status: 'stopped' });
    await disposing;
    const finalCallerOutcome = await callerStop;
    const cachedStopOutcome = await started.handle.stop();
    resolveWatch({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'stopped' },
    });

    expect(callerOutcome).toEqual({ status: 'aborted' });
    expect(finalCallerOutcome).toEqual({ status: 'aborted' });
    expect(disposeWasPendingAtCallerAbort).toBe(true);
    expect(stopCallsBeforeSharedSettlement).toBe(1);
    expect(cachedStopOutcome).toEqual({ status: 'stopped' });
    expect(stopRpc).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'watcher'] as const)(
    'isolates a throwing %s public-handle watcher while preserving subscriptions and abort cleanup',
    async (throwingBoundary) => {
      const attempt = new AbortController();
      const stopRpc = vi.fn(async () => ({ ok: true, status: 'stopped' }));
      const ownerTerminal = vi.fn(() => {
        if (throwingBoundary === 'owner') throw new Error('owner_terminal_callback_failed');
      });
      const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
        handle.watch(ownerTerminal);
      });
      const sessionRpc = vi.fn(async ({ method }: Readonly<{ method: string }>) => {
        if (method.endsWith('.start')) return successfulStart;
        if (method.endsWith('.watch')) return await new Promise<never>(() => undefined);
        if (method.endsWith('.stop')) return await stopRpc();
        return { ok: true, status: 'available', transport: 'webrtc' };
      });
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionId: `session-throwing-${throwingBoundary}`,
        applicationAttemptId: `voice:throwing-${throwingBoundary}`,
        signal: attempt.signal,
        sessionRpc,
        onStarted,
      });
      const started = await service.start({
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
      });
      expect(started.status).toBe('started');
      if (started.status !== 'started') return;

      const repeatedListener = vi.fn();
      const firstSubscription = started.handle.watch(repeatedListener);
      started.handle.watch(repeatedListener);
      firstSubscription.dispose();
      started.handle.watch(() => {
        if (throwingBoundary === 'watcher') throw new Error('watcher_callback_failed');
      });
      const survivingListener = vi.fn();
      started.handle.watch(survivingListener);

      let abortFailure: unknown = null;
      try {
        attempt.abort();
      } catch (error) {
        abortFailure = error;
      }
      await Promise.resolve();
      const stopCallsAfterAbort = stopRpc.mock.calls.length;
      await started.handle.dispose();

      expect(abortFailure).toBeNull();
      expect(stopCallsAfterAbort).toBe(1);
      expect(ownerTerminal).toHaveBeenCalledOnce();
      expect(repeatedListener).toHaveBeenCalledOnce();
      expect(survivingListener).toHaveBeenCalledOnce();
      expect(stopRpc).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      operation: 'inspect',
      remote: {
        ok: false,
        status: 'unavailable',
        code: 'authentication_required',
        message: sentinels.inspect,
        reason: 'authentication_required',
      },
      expected: {
        status: 'unavailable',
        reason: 'authentication_required',
        diagnostic: {
          code: 'authentication_required',
          severity: 'error',
          message: 'Agent realtime is unavailable.',
        },
      },
    },
    {
      operation: 'start',
      remote: {
        ok: false,
        status: 'failed',
        code: 'upstream_rejected',
        message: sentinels.start,
      },
      expected: {
        status: 'failed',
        diagnostic: {
          code: 'upstream_rejected',
          severity: 'error',
          message: 'Agent realtime start failed.',
        },
      },
    },
    {
      operation: 'watch',
      remote: {
        ok: true,
        status: 'terminal',
        event: {
          kind: 'terminal',
          reason: 'upstream_closed',
          diagnostic: {
            code: 'upstream_closed',
            severity: 'warning',
            message: sentinels.watch,
          },
        },
      },
      expected: {
        kind: 'terminal',
        reason: 'upstream_closed',
        diagnostic: {
          code: 'upstream_closed',
          severity: 'warning',
          message: 'Agent realtime ended.',
        },
      },
    },
    {
      operation: 'stop',
      remote: {
        ok: false,
        status: 'unavailable',
        code: 'stop_unavailable',
        message: sentinels.stop,
      },
      expected: {
        status: 'unavailable',
        diagnostic: {
          code: 'stop_unavailable',
          severity: 'error',
          message: 'Agent realtime stop is unavailable.',
        },
      },
    },
  ] as const)(
    'reconstructs $operation diagnostics from stable fields and static host text',
    async ({ operation, remote, expected }) => {
      const result = await exerciseProviderFacingOperation({
        operation,
        result: async () => remote,
      });

      expect(result).toEqual(expected);
      expectNoDiagnosticSentinel(result);
    },
  );

  it.each([
    ['inspect', 'agent_realtime_inspect_failed', 'Agent realtime inspection failed.'],
    ['start', 'agent_realtime_start_failed', 'Agent realtime start failed.'],
    ['watch', 'agent_realtime_watch_failed', 'Agent realtime watch failed.'],
    ['stop', 'agent_realtime_stop_failed', 'Agent realtime stop failed.'],
  ] as const)(
    'sanitizes %s RPC rejections before they reach the provider-facing service',
    async (operation, code, message) => {
      const result = await exerciseProviderFacingOperation({
        operation,
        result: async () => {
          throw new Error(sentinels[operation]);
        },
      });

      expect(result).toMatchObject(
        operation === 'watch'
          ? {
              kind: 'terminal',
              reason: 'error',
              diagnostic: { code, severity: 'error', message },
            }
          : operation === 'inspect'
            ? {
                status: 'unavailable',
                reason: 'session_unavailable',
                diagnostic: { code, severity: 'error', message },
              }
            : operation === 'start'
              ? {
                  status: 'failed',
                  diagnostic: { code, severity: 'error', message },
                }
              : {
                  status: 'unavailable',
                  diagnostic: { code, severity: 'error', message },
                },
      );
      expectNoDiagnosticSentinel(result);
    },
  );

  it.each([
    ['inspect', 'agent_realtime_invalid_inspect_response', 'Agent realtime inspection failed.'],
    ['start', 'agent_realtime_invalid_start_response', 'Agent realtime start failed.'],
    ['watch', 'agent_realtime_invalid_watch_response', 'Agent realtime watch failed.'],
    ['stop', 'agent_realtime_invalid_stop_response', 'Agent realtime stop failed.'],
  ] as const)(
    'sanitizes invalid %s RPC responses before they reach the provider-facing service',
    async (operation, code, message) => {
      const result = await exerciseProviderFacingOperation({
        operation,
        result: async () => ({
          malformed: true,
          message: sentinels[operation],
          details: { leaked: sentinels.stop },
        }),
      });

      expect(result).toMatchObject(
        operation === 'watch'
          ? {
              kind: 'terminal',
              reason: 'error',
              diagnostic: { code, severity: 'error', message },
            }
          : operation === 'inspect'
            ? {
                status: 'unavailable',
                reason: 'session_unavailable',
                diagnostic: { code, severity: 'error', message },
              }
            : operation === 'start'
              ? {
                  status: 'failed',
                  diagnostic: { code, severity: 'error', message },
                }
              : {
                  status: 'unavailable',
                  diagnostic: { code, severity: 'error', message },
                },
      );
      expectNoDiagnosticSentinel(result);
    },
  );

  it('replaces an unsafe remote diagnostic code instead of moving private text into the code field', async () => {
    const result = await exerciseProviderFacingOperation({
      operation: 'inspect',
      result: async () => ({
        ok: false,
        status: 'unavailable',
        code: sentinels.inspect,
        message: 'static-looking message',
        reason: 'session_unavailable',
      }),
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'session_unavailable',
      diagnostic: {
        code: 'agent_realtime_inspect_failed',
        severity: 'error',
        message: 'Agent realtime is unavailable.',
      },
    });
    expectNoDiagnosticSentinel(result);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Console } from 'node:console';
import Fastify, { type FastifyInstance } from 'fastify';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { requestSessionStop } from './requestSessionStop';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { ActionExecutorContext, ActionExecutorDeps, ApprovalRequestV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { AccountMachineInventoryRow } from '@/api/machine/fetchAccountMachines';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const boundary = vi.hoisted(() => ({ socket: null as unknown, mode: 'timeout' }));
vi.mock('socket.io-client', () => ({ io: () => boundary.socket }));

describe('requestSessionStop machine transport', () => {
  const sessionId = 'cmuo0nwxt11bptmszygswp8g3';
  const secret = new Uint8Array(32).fill(1);
  const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret } };
  let calls: string[];
  let relay: FastifyInstance;
  let restoreHttp: () => void;
  let receivedStop: unknown;

  beforeEach(async () => {
    vi.useFakeTimers();
    calls = [];
    receivedStop = undefined;
    // Only the network adapters are replaced; resolution, encryption, request disposition,
    // and Stop outcome classification all execute through their production owners.
    const session = createSessionRecordFixture({
      id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
      metadata: encodeBase64(encrypt(secret, 'legacy', { machineId: 'owning-machine' })),
      metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      machineId: 'owning-machine',
    });
    const machine = { id: 'owning-machine', dataEncryptionKey: null } satisfies AccountMachineInventoryRow;
    relay = Fastify();
    relay.addHook('onRequest', async (request) => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
    });
    relay.get(`/v2/sessions/${sessionId}`, async () => ({ session }));
    relay.get('/v1/machines/owning-machine', async () => ({ machine }));
    await relay.ready();
    restoreHttp = installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin });
    const events = new EventEmitter();
    boundary.socket = {
      on: events.on.bind(events), off: events.off.bind(events),
      connect: () => boundary.mode === 'connect_error'
        ? events.emit('connect_error', new Error('Connection refused'))
        : events.emit('connect'),
      disconnect: () => undefined, close: () => undefined,
      emit: (event: string, payload: unknown, callback?: (response: unknown) => void) => {
        calls.push(event);
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        if (boundary.mode === 'attribution') {
          if (!payload || typeof payload !== 'object' || !('params' in payload) || typeof payload.params !== 'string') {
            throw new Error('Expected encrypted machine RPC request');
          }
          receivedStop = decrypt(secret, 'legacy', decodeBase64(payload.params));
          callback?.({ ok: true, result: encodeBase64(encrypt(secret, 'legacy', { status: 'stopped' })) });
        }
        if (boundary.mode === 'disconnect') events.emit('disconnect', 'transport close');
        if (boundary.mode === 'forbidden') callback?.({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
        if (boundary.mode === 'unavailable') callback?.({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        if (boundary.mode === 'slow_stop') setTimeout(() => callback?.({ ok: true,
          result: encodeBase64(encrypt(secret, 'legacy', { status: 'stopped' })),
        }), 22_410);
        // The finite relay forwarding deadline owns a request whose handler does not settle.
        if (boundary.mode === 'timeout') setTimeout(() => callback?.({ ok: false, error: 'RPC call timeout' }), 30_000);
      },
    };
  });

  it.each([
    {
      label: 'original tool caller', callerSession: 'runtime-session',
      context: { approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'tool-session', toolCallId: 'stop-tool', toolInput: 'private input' } },
      source: { surface: 'mcp', requestingSessionId: 'tool-session', toolCallId: 'stop-tool' },
    },
    {
      label: 'ambient session caller', callerSession: 'runtime-session', context: {},
      source: { surface: 'mcp', requestingSessionId: 'runtime-session' },
    },
    {
      label: 'unknown external caller', callerSession: undefined, context: {}, source: { surface: 'mcp' },
    },
    {
      label: 'approved legacy request with unknown origin', callerSession: 'approver-session',
      context: { bypassApprovals: true }, source: { surface: 'mcp' },
    },
  ] satisfies ReadonlyArray<{
    label: string; callerSession: string | undefined; context: ActionExecutorContext; source: unknown;
  }>)('retains $label through the real action and encrypted machine transport', async ({ callerSession, context, source }) => {
    boundary.mode = 'attribution';
    const executor = createCliActionExecutorFromCredentials({
      credentials, processEnv: { HAPPIER_SESSION_ID: callerSession },
    });
    const result = await executor.execute('session.stop', { sessionId }, {
      ...context, surface: 'mcp', defaultSessionId: sessionId,
    });
    expect(result).toMatchObject({ ok: true, result: { stopped: true } });
    expect(receivedStop).toEqual({ sessionId, source });
  });

  afterEach(async () => {
    restoreHttp?.();
    await relay?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('retains an ambient CLI requester across deferred approval by another session', async () => {
    boundary.mode = 'attribution';
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({
      v: 1, actions: { 'session.stop': { approvalRequiredSurfaces: ['cli'] } },
    }));
    let stored: ApprovalRequestV1 | null = null;
    // Replace the remote artifact storage boundary, retaining real approval orchestration.
    const overrides: Partial<ActionExecutorDeps> = {
      approvalsCreate: async ({ request }) => {
        stored = request;
        return { artifactId: 'stop-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = request;
        return { ok: true };
      },
    };
    const requester = createCliActionExecutorFromCredentials({
      credentials, processEnv: { HAPPIER_SESSION_ID: 'requesting-session' }, overrides,
    });
    const requested = await requester.execute('session.stop', { sessionId }, { surface: 'cli' });
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(receivedStop).toBeUndefined();
    const approver = createCliActionExecutorFromCredentials({
      credentials, processEnv: { HAPPIER_SESSION_ID: 'approver-session' }, overrides,
    });
    const approved = await approver.execute('approval.request.decide', {
      artifactId: 'stop-approval', decision: 'approve',
    }, { surface: 'cli', approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'approver-session', toolCallId: 'approve-tool' } });
    expect(approved.ok).toBe(true);
    expect(receivedStop).toEqual({ sessionId, source: { surface: 'cli', requestingSessionId: 'requesting-session' } });
  });

  it.each(['timeout', 'disconnect'])('preserves ambiguous %s after emission even when session metadata is inactive', async (mode) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // Vitest buffers console.log; route it through the real Node console to observe
    // the stdout boundary without replacing the production logger.
    const nodeConsole = new Console(process.stdout, process.stderr);
    vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    boundary.mode = mode;
    const result = requestSessionStop({ credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(result).resolves.toEqual({
      ok: true, sessionId, stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('waits for a physical Stop acknowledgement beyond the generic machine RPC cutoff', async () => {
    boundary.mode = 'slow_stop';
    let settled = false;
    const result = requestSessionStop({ credentials, idOrPrefix: sessionId })
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false);
    expect(calls).not.toContain(SOCKET_RPC_EVENTS.CANCEL);
    await vi.advanceTimersByTimeAsync(2_410);
    await expect(result).resolves.toEqual({ ok: true, sessionId, stopped: true });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('retains a definitive authorization refusal', async () => {
    boundary.mode = 'forbidden';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_forbidden' },
    });
  });

  it('retains a definitive unavailable-target response', async () => {
    boundary.mode = 'unavailable';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
  });

  it('reports unavailable before emission without issuing Stop', async () => {
    boundary.mode = 'connect_error';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
    expect(calls).toEqual([]);
  });
});

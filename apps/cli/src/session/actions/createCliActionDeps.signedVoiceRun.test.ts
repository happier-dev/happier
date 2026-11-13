import axios from 'axios';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, readBackendTargetRefV2, verifyExternalActionMachineRpcRequestV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createCliActionDeps } from './createCliActionDeps';

// Socket.IO and HTTP are the genuine process boundaries; all Action, Session,
// encryption and execution-run transport owners beneath them remain real.
const listeners = new Map<string, Set<() => void>>();
const packets: SocketRpcRequestPayload[] = [];
const socket = {
  io: createSocketIoManagerStub(),
  connected: false,
  connect: vi.fn(() => { socket.connected = true; for (const fn of listeners.get('connect') ?? []) fn(); }),
  on: vi.fn((event: string, fn: () => void) => {
    const current = listeners.get(event) ?? new Set<() => void>(); current.add(fn); listeners.set(event, current);
  }),
  off: vi.fn((event: string, fn?: () => void) => { if (fn) listeners.get(event)?.delete(fn); else listeners.delete(event); }),
  removeAllListeners: vi.fn(() => listeners.clear()),
  disconnect: vi.fn(() => { socket.connected = false; }),
  close: vi.fn(),
  emit: vi.fn((event: string, packet: SocketRpcRequestPayload, ack?: (value: unknown) => void) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return;
    packets.push(packet);
    ack?.({ ok: true, result: { ok: true, runId: 'run-voice' } });
  }),
  emitWithAck: vi.fn((event: string, packet: SocketRpcRequestPayload) => new Promise<unknown>(resolve => socket.emit(event, packet, resolve))),
};
vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));

const sessionId = 'cmwec73r300gamcvijq3b0p9z';
const target = { kind: 'machine' as const, machineId: 'machine-target' };
const installationId = 'target-installation';
const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
const start = {
  intent: 'voice_agent' as const,
  backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'codex' })!,
  permissionMode: 'default' as const,
  retentionPolicy: 'resumable' as const,
  runClass: 'long_lived' as const,
  ioMode: 'streaming' as const,
  bootstrapMode: 'none' as const,
};

beforeEach(async () => {
  packets.length = 0; listeners.clear(); socket.connected = false;
  const session = createSessionRecordFixture({ id: sessionId, active: true, machineId: target.machineId,
    encryptionMode: 'plain', metadata: JSON.stringify(await createTestMetadata({ machineId: target.machineId, path: '/workspace' })) });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
    throw new Error(`Unexpected HTTP read: ${path}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('attached Voice Run signed Session transport', () => {
  it.each(['start', 'ensure', 'ensure_or_start'] as const)('preserves admitted Account authorization through %s to the runner', async operation => {
    const actionId = operation === 'start' ? 'execution.run.start' : operation === 'ensure' ? 'execution.run.ensure' : 'execution.run.ensure_or_start';
    const method = operation === 'start' ? SESSION_RPC_METHODS.EXECUTION_RUN_START : operation === 'ensure' ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE : SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START;
    const request = operation === 'start' ? start : operation === 'ensure' ? { runId: 'run-voice' } : { runId: 'run-voice', start };
    const invocation = { surface: 'voice', authority: 'present_user', caller: { kind: 'host' } } as const;
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1 as const, token: 'home-voice-proof', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      accountEncryptionMode: 'plain' as const, serverIdentityId: 'srv_home', machineId: target.machineId,
      installationId, actionId, requestId: 'voice-start-request', requestEnvelopeDigest: 'a'.repeat(43), target,
    } }, credentials: { token: 'account-token' }, invocation,
      purpose: { kind: 'machine_rpc', method, params: request }, installationPublicKey: keys.publicKey, randomBytes });
    const context = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: target, externalActionExecutionAuthorization: authorization } satisfies ActionExecutorContext;
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    const result = operation === 'start' ? await deps.executionRunStart(sessionId, start, context)
      : operation === 'ensure' ? await deps.executionRunEnsure!(sessionId, { runId: 'run-voice' }, context)
      : await deps.executionRunEnsureOrStart!(sessionId, { runId: 'run-voice', start }, context);
    expect(result).toMatchObject({ ok: true });
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.externalActionExecution, 'runner must receive the existing signed Account authorization').toBeDefined();
    const execution = packet.externalActionExecution!;
    expect(execution.authorization).toEqual(authorization);
    if (!packet.requestId) throw new Error('Signed Machine RPC must carry its request id');
    expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      requesterAccountContext: execution.authorization.requesterAccountContext,
      target, installationId, event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId,
      params: packet.params, signature: execution.machineSignature, publicKey: keys.publicKey })).toBe(true);
    expect(openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
      purpose: { kind: 'machine_rpc', method, params: request }, machineId: target.machineId,
      installationId, serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey, includeInvocation: true }))
      .toEqual({ credentials: { token: 'account-token' }, invocation });
  });

  it('refuses signed Account Start without the installation signer before issuing an unsigned RPC', async () => {
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    const context = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' }, externalActionTarget: target,
      externalActionExecutionAuthorization: { v: 1, token: 'home-voice-proof', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId, installationId,
        actionId: 'execution.run.start', requestId: 'voice-start-request', requestEnvelopeDigest: 'a'.repeat(43), target,
      } } } satisfies ActionExecutorContext;
    let outcome: unknown;
    try { outcome = await deps.executionRunStart(sessionId, start, context); }
    catch (error) { outcome = error; }
    expect(packets, 'missing signing custody must never fall back to unsigned Account dispatch').toEqual([]);
    expect(outcome).not.toMatchObject({ ok: true });
  });

  it('keeps ordinary MCP Voice intent unsigned and under the automation ceiling', async () => {
    const deps = createCliActionDeps({ token: 'account-token', credentials: { token: 'account-token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    expect(await deps.executionRunStart(sessionId, start, { surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
    expect(packets).toHaveLength(1);
    expect(packets[0]!.externalActionExecution).toBeUndefined();
  });
});

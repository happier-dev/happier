import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol/sessions/fork';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionDeps } from './createCliActionDeps';

const network = vi.hoisted(() => ({ io: vi.fn() }));
// Socket.IO and HTTP are the remote Machine boundary; the fork port and RPC
// serialization remain real so an omitted authority ceiling is observable.
vi.mock('socket.io-client', () => ({ io: network.io }));
afterEach(() => { vi.restoreAllMocks(); network.io.mockReset(); });

it('forks through the receiving Machine’s strict versioned request boundary', async () => {
  const sessionId = 'cmv4ztyai00jvm2gbz2hkfqyk';
  const machineId = 'machine-source';
  const row = {
    ...createSessionNotificationContextFixture(sessionId),
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId, path: '/repo' }),
  };
  // HTTP and the receiving Machine process are genuine system boundaries.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/v1/account/encryption/currentness')) {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (String(url).includes(`/v2/sessions/${sessionId}`)) {
      return { status: 200, data: { session: row } };
    }
    throw new Error(`Unexpected HTTP request: ${String(url)}`);
  });
  const deps = createCliActionDeps({
    token: 'token_test', credentials: { token: 'token_test', encryption: null },
    sessionId, mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: {
      machineId,
      invoke: async (_method, request) => {
        const parsed = SessionForkRpcParamsSchema.safeParse(request);
        return parsed.success
          ? { ok: true, childSessionId: 'session-child' }
          : { ok: false, errorCode: 'INVALID_REQUEST' };
      },
    },
  });
  await expect(deps.sessionFork({ sessionId, forkPoint: { type: 'latest' }, strategy: 'replay' }))
    .resolves.toEqual({ ok: true, childSessionId: 'session-child' });
});

it('retains the automation ceiling on the serialized fork hop', async () => {
  const sessionId = 'cmv4ztyai00jvm2gbz2hkfqyk';
  const machineId = 'remote-fork-machine';
  const row = { ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId, path: '/repo' }) };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: {
      machine: { ...createAvailableSessionSpawnMachineSnapshot(machineId), storageMode: 'plain' },
    } };
    throw new Error(`Unexpected fork HTTP ${path}`);
  });
  const answer = async (event: string, payload: unknown) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') throw new Error('Unexpected fork RPC');
    expect(Reflect.get(payload, 'method')).toBe(`${machineId}:${RPC_METHODS.SESSION_FORK}`);
    return { ok: true, result: { ok: true, childSessionId: 'remote-child' } };
  };
  network.io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: answer, emit: (event, [payload, callback]) => {
    if (typeof callback === 'function') void answer(event, payload).then(result => { callback(result); });
  } }));
  const deps = createCliActionDeps({ token: 'token_test', credentials: { token: 'token_test', encryption: null },
    sessionId, mode: 'plain', ctx: null });
  await expect(deps.sessionFork({ sessionId, forkPoint: { type: 'latest' }, strategy: 'replay' },
    { surface: 'agent', authority: 'account_automation' }))
    .resolves.toEqual({ ok: true, childSessionId: 'remote-child' });
  expect(network.io).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    auth: expect.objectContaining({ authorityCeiling: 'account_automation' }),
  }));
});

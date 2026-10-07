import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

import {
  createResolvedSessionConnectedServiceAuthTransport,
  createSessionConnectedServiceAuthTransport,
} from './transport';

const sessionId = 'c1234567890123456789012345';
const requests: Array<Readonly<{ method: string; params: unknown }>> = [];
const responses: unknown[] = [];
let socket: ReturnType<typeof createApiSessionSocketStub>;

function createTransport() {
  return createResolvedSessionConnectedServiceAuthTransport({
    token: 'token-1', sessionId, mode: 'plain', ctx: null,
  });
}

function serveSession(mode: 'plain' | 'e2ee') {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path === `/v2/sessions/${sessionId}`) {
      return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: mode, metadata: mode === 'plain' ? '{}' : 'retained-ciphertext',
        dataEncryptionKey: mode === 'plain' ? null : 'retained-data-key-envelope',
      }) } };
    }
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
}

describe('createResolvedSessionConnectedServiceAuthTransport', () => {
  beforeEach(() => {
    requests.length = 0;
    responses.length = 0;
    // Only Socket.IO is substituted. Session RPC lifecycle, codec, authorization
    // and Connected Account request/response normalization remain real.
    socket = createApiSessionSocketStub({
      emitWithAck: (event, payload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!payload || typeof payload !== 'object' || !('method' in payload)
          || typeof payload.method !== 'string' || !('params' in payload)) {
          throw new Error('Malformed Socket RPC request');
        }
        requests.push({ method: payload.method, params: payload.params });
        if (!responses.length) throw new Error('Unexpected Socket RPC request');
        return { ok: true, result: responses.shift() };
      },
    });
    bindApiSessionSocketMock(io, socket);
  });
  afterEach(() => { vi.restoreAllMocks(); io.mockReset(); });

  it('invalidates connected-service auth for a plain Session with token-only credentials', async () => {
    serveSession('plain');
    responses.push({ ok: true });
    const transport = createSessionConnectedServiceAuthTransport({
      credentials: { token: 'token-only', encryption: null }, sessionId,
    });
    await expect(transport.invalidateConnectedServiceAuthTransports()).resolves.toEqual({ ok: true, value: true });
    expect(requests).toEqual([{ method: `${sessionId}:session.connectedServiceAuth.invalidateTransports`, params: {} }]);
    expect(socket.connected).toBe(false);
  });

  it('preserves typed material-unavailable failure for retained E2EE Session control', async () => {
    serveSession('e2ee');
    const transport = createSessionConnectedServiceAuthTransport({
      credentials: { token: 'token-only', encryption: null }, sessionId,
    });
    await expect(transport.invalidateConnectedServiceAuthTransports()).resolves.toEqual({
      ok: false, code: 'encryption_material_unavailable', error: 'encryption_material_unavailable',
      diagnostics: [{ code: 'encryption_material_unavailable' }],
    });
    expect(requests).toEqual([]);
    expect(io).not.toHaveBeenCalled();
  });

  it('forwards connected-service auth apply and qualifies runtime identity at Protocol ingress', async () => {
    responses.push(
      { ok: true, appliedVia: 'direct_live_hot_auth', activeAccountId: 'acct_1' },
      { ok: true, serviceId: 'openai-codex', identity: {
        strategy: 'provider_account_id', proofStrength: 'exact', providerAccountId: 'acct_1',
      } },
    );
    const transport = createTransport();
    const applyInput = { serviceId: 'openai-codex', reason: 'usage_limit' as const,
      authGeneration: { kind: 'oauth' as const, providerAccountId: 'acct_1' } };
    await expect(transport.applyConnectedServiceAuthGeneration(applyInput)).resolves.toEqual({
      ok: true, value: { ok: true, appliedVia: 'direct_live_hot_auth', activeAccountId: 'acct_1' },
    });
    const identityInput = { serviceId: 'openai-codex', reason: 'diagnostic' as const };
    await expect(transport.readConnectedServiceRuntimeIdentity(identityInput)).resolves.toEqual({
      ok: true, value: { ok: true, serviceId: 'happier.agent.codex/openai-codex',
        identity: { strategy: 'provider_account_id', proofStrength: 'exact', providerAccountId: 'acct_1' } },
    });
    expect(requests).toEqual([
      { method: `${sessionId}:session.connectedServiceAuth.applyGeneration`, params: applyInput },
      { method: `${sessionId}:session.connectedServiceAuth.readRuntimeIdentity`, params: identityInput },
    ]);
    expect(socket.timeout.mock.calls.map(([timeout]) => timeout)).toEqual([60_000, 20_000]);
  });

  it('fails closed when connected-service auth RPC responses are malformed', async () => {
    responses.push({ ok: true, activeAccountId: 'acct_1' });
    await expect(createTransport().applyConnectedServiceAuthGeneration({
      serviceId: 'openai-codex', reason: 'usage_limit', authGeneration: { kind: 'oauth' },
    })).resolves.toEqual({
      ok: false, code: 'connected_service_auth_apply_failed', error: 'connected_service_auth_apply_failed',
      diagnostics: [{ code: 'connected_service_auth_apply_failed' }],
    });
  });
});

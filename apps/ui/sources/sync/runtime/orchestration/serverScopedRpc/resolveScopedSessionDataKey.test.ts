import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveScopedSessionCryptoContext } from './resolveScopedSessionDataKey';
import { resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { createCapturedServerReadTransport } from './capturedServerReadTransport';

/** The standalone, transferable Session DEK the scoped crypto context yields, if any. */
async function resolveScopedSessionDataKey(
  params: Parameters<typeof resolveScopedSessionCryptoContext>[0],
): Promise<Uint8Array | null> {
  const context = await resolveScopedSessionCryptoContext(params);
  return context.encryptionMode === 'e2ee' ? context.sessionDataKey : null;
}

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => {
    // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type.
    const mocked = {
      runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
      get runtimeFetchManualResponse() { return this.runtimeFetch; },
    };
    return mocked;
});

const validSessionById = {
  id: 'session-1',
  seq: 1,
  createdAt: 1,
  updatedAt: 1,
  active: true,
  activeAt: 1,
  archivedAt: null,
  metadata: 'metadata',
  metadataVersion: 1,
  agentState: null,
  agentStateVersion: 0,
  pendingCount: 0,
  pendingVersion: 0,
  dataEncryptionKey: 'k1',
};

describe('resolveScopedSessionDataKey', () => {
  afterEach(async () => {
    runtimeFetchMock.mockReset();
    resetSessionByIdHttpReadsForTests();
    try {
      const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
      await resetServerReachabilitySupervisors();
    } catch {
      // ignore
    }
  });

  it.each([
    { name: 'a recipient without its envelope', envelope: null, readiness: undefined, availability: 'encrypted_access_pending' },
    { name: 'an envelope this Account cannot open', envelope: 'AAAA', readiness: undefined, availability: 'encrypted_access_needs_repair' },
    { name: 'a recipient whose Account needs encryption setup', envelope: null,
      readiness: { refused: { status: 'unavailable', reason: 'encryption_setup_required' } }, availability: 'recipient_encryption_setup_required' },
    { name: 'a plain recipient Account', envelope: null,
      readiness: { observed: { status: 'unavailable', reason: 'plain_account' } }, availability: 'recipient_encryption_setup_required' },
    { name: 'an inconsistent recipient Account', envelope: null,
      readiness: { observed: { status: 'unavailable', reason: 'encryption_inconsistent' } }, availability: 'encrypted_access_needs_repair' },
  ] as const)('fails closed with the content availability of $name', async ({ envelope, readiness, availability }) => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { AccountEncryptionCurrentnessReadinessError } = await import('@/sync/api/account/apiAccountEncryptionMode');
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    const { resolveScopedSessionEncryption } = await import('./resolveScopedSessionDataKey');
    const context = { scope: 'scoped', encryption, credentials: { token: 't', secret: 's' }, targetServerId: 'server-a',
      targetServerUrl: 'https://server-a.test', token: 't', timeoutMs: 1000 } as unknown as Parameters<typeof resolveScopedSessionEncryption>[0]['context'];
    // The Account currentness owner answers readiness (or refuses with it); this resolver only consumes it.
    const readAccountCurrentness = readiness === undefined ? undefined : async () => {
      if (readiness.refused !== undefined) throw new AccountEncryptionCurrentnessReadinessError(readiness.refused);
      return { recipientEnvelopeReadiness: readiness.observed } as unknown as import('@happier-dev/sync-client').AccountEncryptionIdentity;
    };
    const failure = await resolveScopedSessionEncryption({ context, sessionId: 'team-session', admittedSession: {
      id: 'team-session', encryptionMode: 'e2ee', dataEncryptionKey: envelope, viewerRole: 'recipient', isCurrent: () => true,
    }, ...(readAccountCurrentness ? { readAccountCurrentness } : {}) }).catch((error: unknown) => error);
    // The scoped code stays; the typed reason is the canonical availability, never plaintext.
    expect(failure).toMatchObject({ code: 'scoped_session_encryption_unavailable', contentAvailability: availability });
    expect(encryption.getSessionEncryption('team-session')).toBeNull();
  });

  it('retires one caller-owned Session key read without cancelling another reader', async () => {
    const requests: Array<{ signal: AbortSignal | null | undefined; resolve: (response: Response) => void }> = [];
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/v2/sessions/')) return Response.json({});
      return await new Promise<Response>((resolve, reject) => {
        requests.push({ signal: init?.signal, resolve });
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const first = new AbortController();
    const second = new AbortController();
    const params = { serverId: 's-id', serverUrl: 'https://server.example.test', token: 'token', sessionId: 'session-1',
      readTransport: createCapturedServerReadTransport({ serverId: 's-id', profile: { serverUrl: 'https://server.example.test' }, credentials: { token: 'token' } }) };
    const cancelled = resolveScopedSessionCryptoContext({ ...params, signal: first.signal });
    const retained = resolveScopedSessionCryptoContext({ ...params, signal: second.signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    first.abort();
    await expect(cancelled).resolves.toMatchObject({ encryptionMode: 'unknown' });
    expect(requests[0]?.signal?.aborted).toBe(false);
    requests[0]!.resolve(Response.json({ results: [{ sessionId: 'session-1', detail: { status: 200,
      body: { session: { ...validSessionById, encryptionMode: 'plain', dataEncryptionKey: null } } } }] }));
    await expect(retained).resolves.toEqual({ encryptionMode: 'plain', sessionDataKey: null });
  });

  it.each(['absent', 'empty', 'malformed', 'wrong_recipient'] as const)(
    'keeps %s envelopes unavailable and opens a later valid envelope through the canonical reader',
    async (initialEnvelope) => {
      const { Encryption } = await import('@/sync/encryption/encryption');
      const { encodeBase64 } = await import('@/encryption/base64');
      const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
      const encryption = await Encryption.create(new Uint8Array(32).fill(7));
      const otherRecipient = await Encryption.create(new Uint8Array(32).fill(8));
      const sessionKey = new Uint8Array(32).fill(9);
      const sealTo = (recipientPublicKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionKey,
        recipientPublicKey,
        randomBytes: (length) => new Uint8Array(length).fill(3),
      }), 'base64');
      let dataEncryptionKey: string | null = initialEnvelope === 'absent'
        ? null
        : initialEnvelope === 'empty'
          ? ''
          : initialEnvelope === 'malformed'
            ? 'not-an-envelope'
            : sealTo(otherRecipient.contentDataKey);
      runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return {
          ok: true, status: 200,
          json: async () => ({ session: { ...validSessionById, encryptionMode: 'e2ee', dataEncryptionKey } }),
        };
      });
      const params = {
        serverId: 's-id', serverUrl: 'https://server.example.test',
        token: 'token', sessionId: 'session-1',
        decryptEncryptionKey: (value: string) => encryption.decryptEncryptionKey(value),
      };

      await expect(resolveScopedSessionDataKey(params)).resolves.toBeNull();
      expect(encryption.getSessionEncryption('session-1')).toBeNull();

      dataEncryptionKey = sealTo(encryption.contentDataKey);
      await expect(resolveScopedSessionDataKey(params)).resolves.toEqual(sessionKey);
      // Standalone key resolution never installs an Account-scoped Session reader.
      expect(encryption.getSessionEncryption('session-1')).toBeNull();
    },
  );

  it('loads and decrypts the session data encryption key from a valid by-id response', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ session: validSessionById }) };
    });
    const expectedKey = new Uint8Array(32).fill(9);
    const decrypt = vi.fn(async () => expectedKey);

    const key = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
    });

    expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v2/sessions/session-1'))).toBe(true);
    expect(decrypt).toHaveBeenCalledWith('k1');
    expect(key).toEqual(expectedKey);
  });

  it('uses the verified runtime origin for an Iroh-only session key lookup', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url === 'http://127.0.0.1:43111/v2/sessions/session-1') {
        return { ok: true, status: 200, json: async () => ({ session: validSessionById }) };
      }
      throw new Error(`unexpected session lookup: ${url}`);
    });
    const expectedKey = new Uint8Array(32).fill(7);
    const decrypt = vi.fn(async () => expectedKey);

    await expect(resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'http://127.0.0.1:3010',
      runtimeOrigin: 'http://127.0.0.1:43111',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
    })).resolves.toEqual(expectedKey);

    expect(runtimeFetchMock.mock.calls.some(([input]) =>
      String(input) === 'http://127.0.0.1:43111/v2/sessions/session-1',
    )).toBe(true);
    expect(runtimeFetchMock.mock.calls.some(([input]) =>
      String(input) === 'http://127.0.0.1:3010/v2/sessions/session-1',
    )).toBe(false);
  });

  it('loads the exact Session row through a selected semantic Home carrier', async () => {
    runtimeFetchMock.mockRejectedValue(new Error('canonical Home URL is unreachable'));
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      session: { ...validSessionById, encryptionMode: 'plain', dataEncryptionKey: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const decrypt = vi.fn(async () => new Uint8Array(32).fill(9));

    await expect(resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      homeCarrier: {
        endpointId: 'home-endpoint',
        readObservedPath: () => 'relay',
        request,
        createWebSocket: vi.fn(),
      },
    })).resolves.toBeNull();

    expect(request).toHaveBeenCalledWith(
      'https://server.example.test/v2/sessions/session-1',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(new Headers(request.mock.calls[0]?.[1].headers).get('Authorization')).toBe('Bearer token');
    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('returns null and does not call decryption for an invalid by-id shape', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ session: { id: 'session-1', dataEncryptionKey: 'k1' } }) };
    });

    const decrypt = vi.fn(async () => new Uint8Array([9]));

    const key = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });

    expect(key).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('does not cache transient failures', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const decrypt = vi.fn(async () => new Uint8Array([9]));

    const first = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });
    const second = await resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(runtimeFetchMock.mock.calls.filter(([input]) => String(input).includes('/v2/sessions/session-1')).length).toBe(2);
  });

  it('throws terminal auth instead of returning an unknown key for scoped 401 responses', async () => {
    runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });
    const decrypt = vi.fn(async () => new Uint8Array([9]));

    await expect(resolveScopedSessionDataKey({
      serverId: 's-id',
      serverUrl: 'https://server.example.test',
      token: 'token',
      sessionId: 'session-1',
      decryptEncryptionKey: decrypt,
      timeoutMs: 10,
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(decrypt).not.toHaveBeenCalled();
  });
});

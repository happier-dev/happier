import { describe, expect, it, vi } from 'vitest';
import {
  ExternalSessionOperationSharedPresentationV1Schema,
  createPlainSessionOwnerMetadataEnvelopeV1,
  projectLegacySessionAccessCapabilitiesV1,
  projectSessionSharedMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  sealEncryptedDataKeyEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createEmbedEncryption } from '@/embed/encryption/createEmbedEncryption';
import { Encryption } from '@/sync/encryption/encryption';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import {
  fetchAndApplySessionById as fetchAndApplySessionByIdSource,
  type SessionByIdEncryption,
} from './sessionById';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));

function capturedSessionHttp(request: (path: string, init: RequestInit) => Promise<Response>) {
  runtimeFetch.mockReset();
  const boundary = createSessionReadBatchHttpBoundary(observation => observation.path === '/v2/sessions/read-batch' ? undefined
    : request(`${observation.path}${observation.url.search}`, { method: 'GET', headers: observation.headers, signal: observation.signal }));
  runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
    return await boundary.handle({ home: 'home', method: init?.method ?? 'GET', path: url.pathname,
      url, accountId: 'account', headers: new Headers(init?.headers), signal: init?.signal,
      body: init?.body ? JSON.parse(String(init.body)) : undefined }) ?? Response.json({}, { status: 404 });
  });
  return createCapturedServerReadTransport({ serverId: 'server-a', profile: { serverUrl: 'https://session.example.test' }, credentials: { token: 't' } });
}

const E2EE_ACCOUNT_CURRENTNESS = {
  mode: 'e2ee',
  version: 1,
  signingKeyFingerprint: 'signing-1',
  contentKeyFingerprint: 'content-1',
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;
const PLAIN_ACCOUNT_CURRENTNESS = {
  mode: 'plain',
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;
/**
 * What a plaintext Account actually supplies. `getScopedSessionByIdEncryption(null)` — the only
 * production producer of this parameter — builds exactly this when the Account carries no client
 * data-encryption material, so the by-ID owner is never handed `null` at runtime.
 */
const PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION: SessionByIdEncryption = {
  decryptEncryptionKey: async () => null,
  initializeSessions: async () => {},
  getSessionEncryption: () => null,
};
function sessionDataKey(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

function fetchAndApplySessionById(
  params: Omit<
    Parameters<typeof fetchAndApplySessionByIdSource>[0],
    'accountCurrentness'
  > & Readonly<{
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
  }>,
) {
  return fetchAndApplySessionByIdSource({
    ...params,
    accountCurrentness:
      params.accountCurrentness ?? E2EE_ACCOUNT_CURRENTNESS,
  });
}

const onAgentRequest = vi.spyOn(voiceHooks, 'onAgentRequest');
const OWNER_METADATA_ENVELOPE = sealSessionOwnerMetadataEnvelopeV1({
  material: {
    type: 'dataKey',
    machineKey: new Uint8Array(32).fill(42),
  },
  ownerMetadata: SessionOwnerMetadataV1Schema.parse({
    v: 1,
    workspace: {
      path: '/private',
      host: 'owner-host',
    },
  }),
  randomBytes: (length) => new Uint8Array(length).fill(1),
});
const OWNER_TEST_CREDENTIALS = {
  token: 't',
  encryption: {
    publicKey: encodeBase64(new Uint8Array(32).fill(41), 'base64'),
    machineKey: encodeBase64(new Uint8Array(32).fill(42), 'base64'),
  },
} as const;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fetchAndApplySessionById', () => {
  it.each(['plain', 'e2ee'] as const)('hydrates a %s batch-supplied detail and turn response without issuing single reads', async mode => {
    const request = vi.fn(async () => Response.json({ error: 'Session not found' }, { status: 404 }));
    const secret = new Uint8Array(32).fill(4);
    const encrypted = mode === 'e2ee' ? await Encryption.create(secret) : null;
    encrypted?.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const key = sessionDataKey();
    if (encrypted) await encrypted.initializeSessions(new Map([['batch-session', key]]));
    const metadata = encrypted ? await encrypted.getSessionEncryption('batch-session')!.encryptRaw({ name: 'Batch' })
      : JSON.stringify({ name: 'Batch' });
    const dataEncryptionKey = encrypted ? encodeBase64(await encrypted.encryptEncryptionKey(key), 'base64') : null;
    const params = {
      sessionId: 'batch-session', credentials: encrypted ? { token: 't', secret: encodeBase64(secret, 'base64url') } : { token: 't' },
      accountCurrentness: encrypted ? E2EE_ACCOUNT_CURRENTNESS : PLAIN_ACCOUNT_CURRENTNESS,
      encryption: encrypted ?? PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map<string, Uint8Array>(),
      request, applySessions: vi.fn(), log: { log() {} },
      prefetched: {
        detail: { status: 200, body: { session: {
          id: 'batch-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          encryptionMode: mode, dataEncryptionKey, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata, agentStateVersion: 1, agentState: null, share: null,
        } } },
        turns: { status: 200, body: { v: 1, sessionId: 'batch-session', updatedAt: 900, turns: [
          { turnId: 'batch-turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } },
      },
    };
    const result = await fetchAndApplySessionById(params);
    expect(result).toMatchObject({ ok: true, session: { id: 'batch-session', metadata: { name: 'Batch' },
      sessionTurns: { turns: [{ turnId: 'batch-turn', terminalAt: 400 }] } } });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads an encrypted list projection without opening a Session key or publishing a Session', async () => {
    const secret = new Uint8Array(32).fill(4);
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const envelope = encodeBase64(await encryption.encryptEncryptionKey(sessionDataKey()), 'base64');
    const decryptKey = vi.spyOn(encryption, 'decryptEncryptionKey');
    const initialize = vi.spyOn(encryption, 'initializeSessions');
    const applySessions = vi.fn();
    const sessionDataKeys = new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = new Map<string, string>();
    try {
      const result = await fetchAndApplySessionById({
        sessionId: 'projection-only', serverId: 'home-a', contentDemand: 'list-projection',
        credentials: { token: 't', secret: encodeBase64(secret, 'base64url') },
        encryption, sessionDataKeys, sessionDataKeyEnvelopes,
        request: async () => Response.json({ session: {
          id: 'projection-only', createdAt: 1, updatedAt: 2, seq: 2, active: true, activeAt: 2,
          encryptionMode: 'e2ee', dataEncryptionKey: envelope, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: 'metadata-not-demanded',
          agentStateVersion: 1, agentState: 'agent-state-not-demanded', share: null,
          pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
        } }), applySessions, log: { log: () => {} },
      });
      expect(result).toMatchObject({ ok: true, session: null,
        sessionListRenderable: { id: 'projection-only', seq: 2, hasPendingPermissionRequests: true } });
      expect(decryptKey).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(sessionDataKeys.size).toBe(0);
      expect(sessionDataKeyEnvelopes.size).toBe(0);
      expect(applySessions).not.toHaveBeenCalled();
    } finally { decryptKey.mockRestore(); initialize.mockRestore(); }
  });
  describe('encryption-context reads', () => {
    it('initializes the current Session key without opening metadata or publishing a Session', async () => {
      const secret = new Uint8Array(32).fill(4);
      const author = await Encryption.create(secret);
      const encryption = await Encryption.create(secret);
      encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
      const key = sessionDataKey();
      await author.initializeSessions(new Map([['draft-session', key]]));
      const payload = { draft: 'recovered without opening the Session' };
      const ciphertext = await author.getSessionEncryption('draft-session')!.encryptRaw(payload);
      const envelope = encodeBase64(await author.encryptEncryptionKey(key), 'base64');
      const metadata = vi.spyOn(SessionEncryption.prototype, 'decryptMetadata');
      const metadataPayload = vi.spyOn(SessionEncryption.prototype, 'decryptMetadataPayload');
      const agentState = vi.spyOn(SessionEncryption.prototype, 'decryptAgentState');
      const applySessions = vi.fn();
      const sessionDataKeys = new Map<string, Uint8Array>();
      const sessionDataKeyEnvelopes = new Map<string, string>();
      const params: Parameters<typeof fetchAndApplySessionById>[0] & { contentDemand: 'encryption-context' } = {
        sessionId: 'draft-session', serverId: 'home-a', contentDemand: 'encryption-context',
        credentials: { token: 't', secret: encodeBase64(secret, 'base64url') },
        encryption, sessionDataKeys, sessionDataKeyEnvelopes,
        request: async () => Response.json({ session: {
          id: 'draft-session', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
          encryptionMode: 'e2ee', dataEncryptionKey: envelope, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: 'metadata-not-demanded',
          agentStateVersion: 1, agentState: 'agent-state-not-demanded', share: null,
        } }),
        applySessions, log: { log: () => {} },
      };
      try {
        const result = await fetchAndApplySessionById(params);
        expect(result).toMatchObject({ ok: true, encryptionMode: 'e2ee', session: null });
        expect(sessionDataKeys.get('draft-session')).toEqual(key);
        expect(sessionDataKeyEnvelopes.get('draft-session')).toBe(envelope);
        await expect(encryption.getSessionEncryption('draft-session')!.decryptRaw(ciphertext)).resolves.toEqual(payload);
        expect(metadata).not.toHaveBeenCalled();
        expect(metadataPayload).not.toHaveBeenCalled();
        expect(agentState).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
      } finally {
        metadata.mockRestore(); metadataPayload.mockRestore(); agentState.mockRestore();
      }
    });

    it('returns a keyless plain context without parsing Session content', async () => {
      const applySessions = vi.fn();
      const params: Parameters<typeof fetchAndApplySessionById>[0] & { contentDemand: 'encryption-context' } = {
        sessionId: 'plain-draft', contentDemand: 'encryption-context', credentials: { token: 't' },
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map(),
        request: async () => Response.json({ session: {
          id: 'plain-draft', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
          encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: 'not-json', agentStateVersion: 1, agentState: 'not-json', share: null,
        } }),
        applySessions, log: { log: () => {} },
      };
      await expect(fetchAndApplySessionById(params)).resolves.toMatchObject({ ok: true, encryptionMode: 'plain', session: null });
      expect(applySessions).not.toHaveBeenCalled();
    });

    it.each(['missing', 'invalid'] as const)('refuses a %s Session key without publishing a locked shell', async kind => {
      const encryption = await Encryption.create(new Uint8Array(32).fill(4));
      encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
      const applySessions = vi.fn();
      const params: Parameters<typeof fetchAndApplySessionById>[0] & { contentDemand: 'encryption-context' } = {
        sessionId: 'locked-draft', contentDemand: 'encryption-context', credentials: { token: 't' },
        encryption, sessionDataKeys: new Map(),
        accountCurrentness: { ...E2EE_ACCOUNT_CURRENTNESS, recipientEnvelopeReadiness: { status: 'available' } },
        request: async () => Response.json({ session: {
          id: 'locked-draft', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
          encryptionMode: 'e2ee', dataEncryptionKey: kind === 'missing' ? null : 'invalid-envelope',
          metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'metadata-not-demanded',
          agentStateVersion: 0, agentState: null, share: { accessLevel: 'view', canApprovePermissions: false },
        } }),
        applySessions, log: { log: () => {} },
      };
      await expect(fetchAndApplySessionById(params)).resolves.toMatchObject({
        ok: false, session: null, errorCode: kind === 'missing' ? 'session_key_unavailable' : 'session_key_invalid',
      });
      expect(encryption.getSessionEncryption('locked-draft')).toBeNull();
      expect(applySessions).not.toHaveBeenCalled();
    });

    it.each(['authority', 'key-rotation'] as const)('keeps an encryption-context read fenced when %s retires during key opening', async retirement => {
      const secret = new Uint8Array(32).fill(4);
      const encryption = await Encryption.create(secret);
      const envelope = encodeBase64(await encryption.encryptEncryptionKey(sessionDataKey()), 'base64');
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      encryption.configureNativeCryptoWorker({
        worker: {
          async probe() { return { available: true, failureReason: 0, nativeVersion: 1 }; },
          async decryptDataKeyEnvelopeV1(request) {
            started.resolve();
            await release.promise;
            return { status: 'ok', source: 'native', items: request.items.map(() => encodeBase64(sessionDataKey(), 'base64')) };
          },
          async decryptSecretboxJson() { throw new Error('Session content was not demanded'); },
          async decryptAesGcmJson() { throw new Error('Session content was not demanded'); },
        },
        routing: { mode: 'require', minPayloadBytes: 0 },
        scope: { accountId: 'draft-account', serverId: 'home-a', generation: 0 },
      });
      await encryption.initializeSessions(new Map([['draft-session', new Uint8Array(32).fill(9)]]), { serverId: 'home-a' });
      let current = true;
      const applySessions = vi.fn();
      const sessionDataKeys = new Map<string, Uint8Array>();
      const params: Parameters<typeof fetchAndApplySessionById>[0] & { contentDemand: 'encryption-context' } = {
        sessionId: 'draft-session', serverId: 'home-a', contentDemand: 'encryption-context',
        credentials: { token: 't', secret: encodeBase64(secret, 'base64url') }, encryption,
        sessionDataKeys, isCurrent: () => current,
        request: async () => Response.json({ session: {
          id: 'draft-session', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
          encryptionMode: 'e2ee', dataEncryptionKey: envelope, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: 'metadata-not-demanded', agentStateVersion: 0, agentState: null, share: null,
        } }),
        applySessions, log: { log: () => {} },
      };
      const read = fetchAndApplySessionById(params);
      try {
        await started.promise;
        if (retirement === 'authority') current = false;
        else await encryption.initializeSessions(new Map([['draft-session', new Uint8Array(32).fill(8)]]), { serverId: 'home-a' });
        release.resolve();
        await expect(read).resolves.toMatchObject({ ok: false, session: null, errorCode: 'stale_response' });
        expect(sessionDataKeys.has('draft-session')).toBe(false);
        expect(applySessions).not.toHaveBeenCalled();
      } finally { release.resolve(); await read; }
    });
  });

  it.each([undefined, 0])('leaves an unbounded Session read to its transport when timeoutMs is %s', async (timeoutMs) => {
    vi.useFakeTimers();
    try {
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      const applySessions = vi.fn();
      const resultPromise = fetchAndApplySessionById({
        sessionId: 'slow-session', credentials: { token: 't' },
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map(),
        request: (_path, init) => new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          response.promise.then(resolve, reject);
          started.resolve();
        }),
        applySessions, log: { log: () => {} }, includeTurnsProjection: false, timeoutMs,
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(10_001);
      response.resolve(Response.json({ session: {
        id: 'slow-session', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Garden notes' }),
        agentStateVersion: 0, agentState: null, share: null,
      } }));
      await vi.runAllTimersAsync();
      expect(await resultPromise).toMatchObject({ ok: true, session: { id: 'slow-session' } });
      expect(applySessions.mock.calls[0]?.[0]).toMatchObject([{ id: 'slow-session', metadata: { name: 'Garden notes' } }]);
    } finally { vi.useRealTimers(); }
  });
  it('retains an explicitly requested Session read deadline', async () => {
    vi.useFakeTimers();
    try {
      const started = createDeferred<void>();
      const applySessions = vi.fn();
      const resultPromise = fetchAndApplySessionById({
        sessionId: 'bounded-session', credentials: { token: 't' },
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map(), timeoutMs: 25,
        request: (_path, init) => new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          started.resolve();
        }),
        applySessions, log: { log: () => {} }, includeTurnsProjection: false,
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await resultPromise).toMatchObject({ ok: false, session: null });
      expect(applySessions).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('returns a scoped Session refusal for an embed detail 403 without Account auth recovery', async () => {
    const frame = await createEmbedEncryption();
    try {
      const result = await fetchAndApplySessionByIdSource({
        sessionId: 'embed', credentials: { token: 'hap_v1_child' }, sessionKey: null,
        encryption: frame.encryption, composerOptionsInput: null, sessionDataKeys: new Map(),
        request: async () => Response.json({ error: 'forbidden' }, { status: 403 }),
        applySessions: () => {}, log: { log: () => {} },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'forbidden', httpStatus: 403 });
    } finally { frame.dispose(); }
  });
  it('uses the embed envelope at the hydration producer and never opens the Account row envelope', async () => {
    const frame = await createEmbedEncryption();
    const otherFrame = await createEmbedEncryption();
    const seal = (publicKey: string) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey(), recipientPublicKey: decodeBase64(publicKey, 'base64url'),
      randomBytes: (length) => new Uint8Array(length).fill(5),
    }), 'base64');
    const result = await fetchAndApplySessionByIdSource({
      sessionId: 'embed', credentials: { token: 'hap_v1_child' },
      sessionKey: seal(otherFrame.embedPublicKey), composerOptionsInput: null,
      encryption: frame.encryption,
      sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(),
      request: async () => Response.json({ session: {
        id: 'embed', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
        encryptionMode: 'e2ee', dataEncryptionKey: seal(frame.embedPublicKey), metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: 'encrypted', agentStateVersion: 0, agentState: null, share: null,
      } }),
      applySessions: () => {}, log: { log: () => {} },
    });
    expect(result.sessionDataKeyHydration?.states.get('embed')).toBe('unopenable_envelope');
    expect(result).toMatchObject({ ok: false, errorCode: 'session_key_invalid' });
    expect(frame.encryption.getSessionEncryption('embed')).toBeNull();
    frame.dispose();
    otherFrame.dispose();
  });
  it('settles a missing embed envelope without Account readiness or legacy fallback', async () => {
    const frame = await createEmbedEncryption();
    const paths: string[] = [];
    const result = await fetchAndApplySessionByIdSource({
      sessionId: 'embed', credentials: OWNER_TEST_CREDENTIALS, sessionKey: null,
      encryption: frame.encryption, composerOptionsInput: null,
      sessionDataKeys: new Map(),
      request: async (path) => {
        paths.push(path);
        if (path !== '/v2/sessions/embed') throw new Error('Account request escaped embed scope');
        return Response.json({ session: {
          id: 'embed', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
          encryptionMode: 'e2ee', dataEncryptionKey: null, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: 'encrypted', agentStateVersion: 0, agentState: null, share: null,
        } });
      },
      applySessions: () => {}, log: { log: () => {} },
    });
    expect(paths).toEqual(['/v2/sessions/embed']);
    expect(result.sessionDataKeyHydration?.states.get('embed')).toBe('missing_envelope');
    expect(result).toMatchObject({ ok: false, errorCode: 'session_key_unavailable' });
    expect(frame.encryption.getSessionEncryption('embed')).toBeNull();
    frame.dispose();
  });
  it('does not label an unexpected request failure as a connectivity failure', async () => {
    const result = await fetchAndApplySessionById({
      sessionId: 's_request_bug', accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' }, encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map(),
      request: async () => { throw new Error('unexpected request adapter failure'); },
      applySessions: vi.fn(), log: { log: () => {} },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'request_failed' });
  });
  it('admits a mixed-version response so the Session store can merge its newer metadata', async () => {
    const initialState = storage.getState();
    const stored = {
      id: 's_mixed', serverId: 'server-a', createdAt: 1, updatedAt: 3, seq: 4,
      active: false, activeAt: 2, encryptionMode: 'plain' as const,
      metadataLayoutVersion: 0, metadataVersion: 3,
      metadata: { name: 'Old title' }, agentStateVersion: 9,
      agentState: { controlledByUser: true }, thinking: false, thinkingAt: 0,
    } as Session;
    storage.setState({ sessions: { ...initialState.sessions, [stored.id]: stored } });
    const applySessions = vi.fn(storage.getState().applySessions);
    try {
      const result = await fetchAndApplySessionById({
      sessionId: 's_mixed', serverId: 'server-a',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map(),
      request: async () => Response.json({ session: {
        id: 's_mixed', createdAt: 1, updatedAt: 4, seq: 5,
        active: false, activeAt: 2, encryptionMode: 'plain', dataEncryptionKey: null,
        metadataLayoutVersion: 0, metadataVersion: 4,
        metadata: JSON.stringify({ name: 'New title' }),
        agentStateVersion: 8, agentState: JSON.stringify({ controlledByUser: false }),
        share: null,
      } }),
      applySessions, getExistingSession: () => storage.getState().sessions[stored.id],
      includeTurnsProjection: false,
      log: { log: () => {} },
    });
      expect(result.ok).toBe(true);
      expect(applySessions).toHaveBeenCalledWith([
        expect.objectContaining({ metadataVersion: 4, agentStateVersion: 8 }),
      ]);
      expect(result.session).toMatchObject({ metadataVersion: 4, agentStateVersion: 9 });
      expect(storage.getState().sessions[stored.id]).toMatchObject({ metadataVersion: 4, agentStateVersion: 9 });
    } finally {
      storage.setState(initialState, true);
    }
  });
  it('refuses a plaintext session before parsing or applying it when this client requires E2EE', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_plain_blocked',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ path: '/must-not-open' }),
        agentStateVersion: 1,
        agentState: null,
        share: null,
      },
    }), { status: 200 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_plain_blocked',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 'token' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      clientEncryptionRequirement: 'require_e2ee',
    });

    expect(result).toEqual({ ok: false, session: null, errorCode: 'client_e2ee_required' });
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('rejects a qualified current detail response that omits responsibility', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_qualified_responsibility',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        share: { accessLevel: 'view', canApprovePermissions: false },
        effectiveAccess: {
          v: 1,
          level: 'view',
          sources: [{ kind: 'direct', shareId: 'share-1' }],
          capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
        },
        viewer: {
          latestFailureSeq: null,
          readState: { state: 'not_started' },
          relevance: { relevant: false, reasons: [] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: false, notificationLevel: null },
          notification: { level: 'none', source: 'none' },
        },
      },
    }), { status: 200 }));

    await expect(fetchAndApplySessionById({
      sessionId: 's_qualified_responsibility',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      accessProjectionVersion: 1,
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_response' });
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('rejects a qualified detail response that omits the negotiated effective-access projection', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      expect(path).toBe('/v2/sessions/s_qualified?accessProjectionVersion=1');
      return new Response(JSON.stringify({
        session: {
          id: 's_qualified',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 1,
          metadata: JSON.stringify({ readStateV1: null }),
          agentStateVersion: 1,
          agentState: JSON.stringify({ controlledByUser: true }),
          share: null,
        },
      }), { status: 200 });
    });

    await expect(fetchAndApplySessionById({
      sessionId: 's_qualified',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      accessProjectionVersion: 1,
    })).resolves.toEqual({
      ok: false,
      session: null,
      errorCode: 'invalid_response',
    });
    expect(applySessions).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable', 'not-json'],
    ['missing', JSON.stringify({})],
  ])('does not scan whole lists for concurrent negotiated-current detail reads with %s projections', async (_label, body) => {
    // The live Usage evidence reader issued 154 exact reads together. A failed
    // current response must not multiply that work into 154 whole-list scans.
    const sessionIds = Array.from({ length: 154 }, (_, index) => `current-${index}`);
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions?limit=200') {
        return new Response(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }), { status: 200 });
      }
      return new Response(body, { status: 200 });
    });
    const applySessions = vi.fn();
    const results = await Promise.all(sessionIds.map(sessionId => fetchAndApplySessionById({
      sessionId,
      credentials: { token: 'token' },
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      accessProjectionVersion: 1,
      includeTurnsProjection: false,
    })));

    expect(results.every(result => !result.ok && result.errorCode === 'invalid_response')).toBe(true);
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual(sessionIds.map(sessionId =>
      `/v2/sessions/${sessionId}?accessProjectionVersion=1`,
    ));

    const sessionId = sessionIds[0]!;
    request.mockImplementation(async () => new Response(JSON.stringify({ session: {
      id: sessionId, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
      encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
      metadata: JSON.stringify({ readStateV1: null }), agentStateVersion: 1,
      agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
    } }), { status: 200 }));
    await expect(fetchAndApplySessionById({
      sessionId, credentials: { token: 'token' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map<string, Uint8Array>(),
      request, applySessions, log: { log: () => {} }, accessProjectionVersion: 1, includeTurnsProjection: false,
    })).resolves.toMatchObject({ ok: true, session: { id: sessionId } });
    expect(applySessions).toHaveBeenCalledWith([expect.objectContaining({ id: sessionId })]);
  });

  it('fails closed instead of hiding a malformed current access projection behind the legacy list fallback', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_malformed_access') {
        return new Response(JSON.stringify({
          session: {
            id: 's_malformed_access',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
            effectiveAccess: { v: 1, role: 'owner' },
          },
        }), { status: 200 });
      }

      throw new Error(`legacy fallback must not run after an explicit current projection: ${path}`);
    });

    await expect(fetchAndApplySessionById({
      sessionId: 's_malformed_access',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
    })).resolves.toEqual({
      ok: false,
      session: null,
      errorCode: 'invalid_response',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('hydrates owner shared metadata, owner metadata, and full agent state without merging envelopes', async () => {
    const privateLegacyMetadata = {
      path: '/private/worktree',
      machineId: 'machine-private',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-private',
        remoteSessionId: 'native-private',
        source: { kind: 'codexHome', home: 'local' },
        linkedAtMs: 1,
      },
    };
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        ...privateLegacyMetadata,
        summary: { text: 'Safe title', updatedAt: 10 },
      },
      agentState: {
        controlledByUser: false,
        requests: {
          privateRequest: { tool: 'dangerous-private-detail' },
        },
      },
    });
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: privateLegacyMetadata.path,
        machineId: privateLegacyMetadata.machineId,
      },
      nativeSession: {
        externalSessionV1: {
          ...privateLegacyMetadata.externalSessionV1,
          source: { kind: 'codexHome', home: 'user' },
        },
      },
    });
    const ownerMetadataEnvelope =
      createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const fullAgentState = AgentStateSchema.parse({
      controlledByUser: false,
      requests: {
        privateRequest: { tool: 'dangerous-private-detail', arguments: {} },
      },
    });
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/sessions/s_owner/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions/s_owner');
      return new Response(JSON.stringify({
        session: {
          id: 's_owner',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: JSON.stringify(sharedMetadata),
          ownerMetadata: ownerMetadataEnvelope,
          agentStateVersion: 5,
          agentState: JSON.stringify(fullAgentState),
          share: null,
        },
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_owner',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    const hydrated = applySessions.mock.calls[0]?.[0]?.[0];
    expect(hydrated.metadata).toEqual(sharedMetadata);
    expect(hydrated).not.toHaveProperty('presence');
    expect(hydrated).not.toHaveProperty('ownerMetadata');
    expect(hydrated.ownerMetadataView).toEqual(expect.objectContaining({
      path: '/private/worktree',
      machineId: 'machine-private',
    }));
    expect(hydrated.agentState).toEqual(fullAgentState);
    expect(hydrated.metadata).not.toHaveProperty('path');
    expect(hydrated.metadata).not.toHaveProperty('ownerMetadata');
    expect(result.session).not.toHaveProperty('ownerMetadata');
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      sharedMetadataCiphertext: JSON.stringify(sharedMetadata),
      ownerMetadataEnvelope,
      agentStateVersion: 5,
      agentStateCiphertext: JSON.stringify(fullAgentState),
      value: {
        metadata: expect.objectContaining({
          path: '/private/worktree',
          machineId: 'machine-private',
        }),
        sharedMetadata,
        ownerMetadata,
        agentState: fullAgentState,
      },
    });
    expect(JSON.stringify(hydrated.metadata)).not.toContain('/private/worktree');
  });

  it('settles a negotiated layout-v1 owner row without its required owner envelope as an unavailable shell', async () => {
    const applySessions = vi.fn();

    const result = await fetchAndApplySessionById({
      sessionId: 's_owner_missing_envelope',
      credentials: OWNER_TEST_CREDENTIALS,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload: async () => null,
          decryptAgentState: async () => null,
        }),
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request: vi.fn(async (path: string) => {
        expect(path).toBe('/v2/sessions/s_owner_missing_envelope?accessProjectionVersion=1');
        return Response.json({ session: {
          id: 's_owner_missing_envelope', createdAt: 1, updatedAt: 2, seq: 3,
          active: false, activeAt: 2, encryptionMode: 'e2ee', dataEncryptionKey: 'dek',
          metadataLayoutVersion: 1, metadataVersion: 4, metadata: 'encrypted-shared-metadata',
          ownerMetadata: null, agentStateVersion: 5,
          agentState: 'encrypted-agent-state', share: null,
          responsibleAccountId: null, responsibleAccount: null,
          effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        } });
      }),
      applySessions,
      log: { log: () => {} },
      accessProjectionVersion: 1,
      includeTurnsProjection: false,
    });

    expect(result).toMatchObject({
      ok: true,
      session: {
        id: 's_owner_missing_envelope',
        metadata: null,
        ownerMetadataView: null,
        agentState: null,
        encryptedContentAvailability: 'encrypted_content_unavailable',
      },
    });
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_owner_missing_envelope',
        metadata: null,
        ownerMetadataView: null,
        agentState: null,
        encryptedContentAvailability: 'encrypted_content_unavailable',
      }),
    ]);
  });

  it.each(['view', 'edit', 'admin'] as const)(
    'hydrates a layout-v1 %s recipient without inferring owner metadata or full Agent state',
    async (accessLevel) => {
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Shared title', updatedAt: 10 },
      },
    });
    const decryptAgentState = vi.fn(async () => {
      throw new Error('shared recipients must not request full Agent state');
    });
    const fetchAccountCurrentness = vi.fn(async () => {
      throw new Error('shared recipients must not request Account currentness');
    });
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/sessions/s_shared/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        session: {
          id: 's_shared',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'e2ee',
          dataEncryptionKey: 'dek',
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: 'encrypted-shared-metadata',
          agentStateVersion: 7,
          agentState: null,
          share: {
            accessLevel,
            canApprovePermissions: false,
          },
        },
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_shared',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload: async () => sharedMetadata,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      fetchAccountCurrentness,
      request,
      applySessions,
      log: { log: () => {} },
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    expect(fetchAccountCurrentness).not.toHaveBeenCalled();
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_shared',
        metadata: sharedMetadata,
        ownerMetadataView: null,
        agentState: null,
        agentStateVersion: 7,
      }),
    ]);
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      sharedMetadataCiphertext: 'encrypted-shared-metadata',
      value: {
        metadata: sharedMetadata,
        sharedMetadata,
        ownerMetadata: null,
        agentState: null,
      },
    });
    },
  );

  it('fails closed when an encrypted owner envelope is present without real account material', async () => {
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const applySessions = vi.fn();
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
    const result = await fetchAndApplySessionById({
      sessionId: 's_encrypted_owner_without_material',
      credentials: { token: 'token-only' },
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload: async () => sharedMetadata,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request: vi.fn(async () => new Response(JSON.stringify({
        session: {
          id: 's_encrypted_owner_without_material',
          createdAt: 1,
          updatedAt: 2,
          seq: 3,
          active: true,
          activeAt: 2,
          encryptionMode: 'e2ee',
          dataEncryptionKey: 'dek',
          metadataLayoutVersion: 1,
          metadataVersion: 4,
          metadata: 'encrypted-shared-metadata',
          ownerMetadata: OWNER_METADATA_ENVELOPE,
          agentStateVersion: 7,
          agentState: 'encrypted-agent-state',
          share: null,
        },
      }), { status: 200 })),
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toMatchObject({
      ok: true,
      session: {
        metadata: null,
        ownerMetadataView: null,
        agentState: null,
        encryptedContentAvailability: 'encrypted_content_unavailable',
      },
    });
    expect(decryptAgentState).not.toHaveBeenCalled();
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        metadata: null,
        ownerMetadataView: null,
        agentState: null,
        encryptedContentAvailability: 'encrypted_content_unavailable',
      }),
    ]);
  });

  it.each([
    {
      name: 'keeps a linked External Session on the legacy owner while activation is frozen',
      expectedMode: 'legacy_owner' as const,
      metadata: {
        summary: { text: 'Legacy owner', updatedAt: 10 },
        externalSessionV1: {
          v: 1 as const,
          agentId: 'codex',
          machineId: 'machine-private-layout0',
          remoteSessionId: 'native-private-layout0',
          source: { kind: 'codexHome' as const, home: 'user' as const },
        },
      },
    },
    {
      name: 'keeps an ordinary Session on the legacy owner',
      expectedMode: 'legacy_owner' as const,
      metadata: {
        path: '/legacy',
        host: 'owner',
        summary: { text: 'Legacy owner', updatedAt: 10 },
      },
    },
  ])('$name from the exact E2EE layout-0 tuple', async ({
    expectedMode,
    metadata,
  }) => {
    const fullAgentState = {
      controlledByUser: true,
      privateAgentSentinel: 'agent-private-layout0',
    };
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_layout0_owner',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 0,
        metadataVersion: 4,
        metadata: 'metadata-exact-layout0',
        agentStateVersion: 7,
        agentState: 'agent-exact-layout0',
        share: null,
      },
    }), { status: 200 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_layout0_owner',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          encryptRaw: async (payload) => JSON.stringify(payload),
          decryptMetadata: async () => metadata,
          decryptAgentState: async () => fullAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request,
      applySessions,
      log: { log: () => {} },
      includeTurnsProjection: false,
      includeMetadataTupleMutationSnapshot: true,
    });

    expect(result.ok).toBe(true);
    expect(result.metadataTupleMutationSnapshot).toEqual({
      mode: expectedMode,
      metadataLayoutVersion: 0,
      metadataVersion: 4,
      metadataCiphertext: 'metadata-exact-layout0',
      ownerMetadata: null,
      agentStateVersion: 7,
      agentStateCiphertext: 'agent-exact-layout0',
      value: {
        metadata: expect.objectContaining(metadata),
        agentState: fullAgentState,
      },
    });
    expect(JSON.stringify(result.session)).not.toContain(
      'metadata-exact-layout0',
    );
    expect(JSON.stringify(result.session)).not.toContain(
      'agent-exact-layout0',
    );
  });

  it('accepts legacy-compatible single-session payloads when newer fields are omitted', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_legacy_payload',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        accessLevel: 'admin',
        canApprovePermissions: true,
      },
    }), { status: 200 }));

    const getSessionEncryption = vi.fn(() => null);
    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_payload',
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_legacy_payload',
        accessLevel: 'admin',
        canApprovePermissions: true,
      }),
    ]);
    expect(getSessionEncryption).not.toHaveBeenCalled();
  });

  it('refuses a missing detail route even when a list could supply a retained Session', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/v2/sessions/s_legacy') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy',
          method: 'GET',
        }), { status: 404 });
      }

      if (path === '/v1/sessions/s_legacy/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [
          {
            id: 's_legacy',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        ],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy',
      credentials: { token: 't' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toMatchObject({ ok: false, session: null, errorCode: 'invalid_response', httpStatus: 404 });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s_legacy',
    ]);
  });

  it('hydrates session turn projection for rollback read models', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s1') {
        return new Response(JSON.stringify({
          session: {
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      expect(path).toBe('/v1/sessions/s1/turns');
      return new Response(JSON.stringify({
        v: 1,
        sessionId: 's1',
        latestTurnId: 'turn-1',
        updatedAt: 4,
        turns: [
          {
            turnId: 'turn-1',
            status: 'completed',
            startedAt: 1,
            updatedAt: 4,
            terminalAt: 4,
            transcriptAnchors: {
              startUserMessageSeq: 1,
              userMessageSeqs: [1, 3],
              startSeqInclusive: 1,
              endSeqInclusive: 4,
            },
            rollback: { state: 'eligible', updatedAt: 4 },
          },
        ],
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/v2/sessions/s1',
      '/v1/sessions/s1/turns',
    ]);
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        sessionTurns: expect.objectContaining({
          latestTurnId: 'turn-1',
          turns: [expect.objectContaining({ turnId: 'turn-1' })],
        }),
        rollbackEligibleTurnStarts: [1],
      }),
    ]);
  });


  it('returns not_found for the current-server session-by-id 404 contract without compat scanning', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: 'Session not found',
    }), { status: 404 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_missing',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'not_found',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not claim not_found when a current-text session-by-id 404 carries route metadata', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_current_text_extra_404') {
        return new Response(JSON.stringify({
          error: 'Session not found',
          path: '/v2/sessions/s_current_text_extra_404',
          method: 'GET',
        }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_current_text_extra_404',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'invalid_response',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v2/sessions/s_current_text_extra_404',
    ]);
  });

  it('rejects a malformed responsibility tuple from by-id without scanning legacy lists', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({ session: {
      id: 's_responsibility_invalid',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
      share: null,
      responsibleAccountId: 'account-a',
    } }), { status: 200 }));

    const result = await fetchAndApplySessionById({
      sessionId: 's_responsibility_invalid',
      credentials: { token: 't' } as any,
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_response' });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty body', () => new Response(null, { status: 404 })],
    ['a plain-text body', () => new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })],
  ])('does not claim not_found for session-by-id 404 with %s', async (_label, createResponse) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => createResponse());

    const result = await fetchAndApplySessionById({
      sessionId: 's_invalid_404',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'invalid_response',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing v2 detail route without scanning Account lists or claiming Session absence', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_legacy_absent') {
        return new Response(JSON.stringify({
          error: 'Not found',
          path: '/v2/sessions/s_legacy_absent',
          method: 'GET',
        }), { status: 404 });
      }
      expect(path).toBe('/v2/sessions?limit=200');
      return new Response(JSON.stringify({
        sessions: [],
        nextCursor: null,
        hasNext: false,
      }), { status: 200 });
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_legacy_absent',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(result).toEqual({
      ok: false,
      session: null,
      errorCode: 'invalid_response',
      httpStatus: 404,
    });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/v2/sessions/s_legacy_absent',
    ]);
  });

  it('keeps an exact Session refusal scoped to that Session', async () => {
    const request = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
    const applySessions = vi.fn();
    await expect(fetchAndApplySessionById({
      sessionId: 's_forbidden', credentials: { token: 't', secret: 's' },
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map(), request, applySessions, log: { log: () => {} },
    })).resolves.toMatchObject({ ok: false, session: null, errorCode: 'forbidden', httpStatus: 403 });
    expect(applySessions).not.toHaveBeenCalled();
    expect(request.mock.calls).toHaveLength(1);
  });

  it('keeps a forbidden optional turns projection scoped to that Session', async () => {
    const session = createSessionFixture({ id: 'turns-forbidden', encryptionMode: 'plain' });
    const request = vi.fn(async (path: string) => path.endsWith('/turns')
      ? Response.json({ error: 'forbidden' }, { status: 403 })
      : Response.json(createPlainSessionByIdResponseFixture(session)));
    await expect(fetchAndApplySessionById({
      sessionId: session.id, credentials: { token: 't' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map(),
      request, applySessions: () => {}, log: { log() {} },
    })).resolves.toMatchObject({ ok: true, session: { id: session.id } });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      `/v2/sessions/${session.id}`, `/v1/sessions/${session.id}/turns`,
    ]);
  });

  it.each([401] as const)('throws terminal auth for session-by-id status %s', async (status) => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'auth failed' }), { status }));

    await expect(fetchAndApplySessionById({
      sessionId: 's_auth_failed',
      credentials: { token: 't', secret: 's' },
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(applySessions).not.toHaveBeenCalled();
  });

  it('announces new fetched agent requests relative to existing session state', async () => {
    onAgentRequest.mockClear();
    const initialState = storage.getState();
    try {
    storage.setState(storage.getInitialState(), true);
    storage.getState().applySessions([createSessionFixture({
      id: 's1', serverId: 'server-a', encryptionMode: 'plain', agentStateVersion: 1,
      agentState: { controlledByUser: true, requests: {}, completedRequests: {} },
    })]);
    const applySessions = vi.fn((sessions: Session[]) => storage.getState().applySessions(sessions));
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      serverId: 'server-a',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      getExistingSession: id => storage.getState().sessions[id],
      includeTurnsProjection: false,
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      { serverId: 'server-a', sessionId: 's1' },
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
    } finally {
      storage.setState(initialState, true);
    }
  });

  it('captures the previous session before applySessions updates storage', async () => {
    onAgentRequest.mockClear();

    const initialState = storage.getState();
    try {
    storage.setState(storage.getInitialState(), true);
    storage.getState().applySessions([createSessionFixture({
      id: 's1', serverId: 'server-a', encryptionMode: 'plain', agentStateVersion: 1,
      agentState: {
        controlledByUser: true,
        requests: {},
        completedRequests: {},
      },
    })]);

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 2,
        agentState: JSON.stringify({
          controlledByUser: true,
          requests: {
            req_1: {
              tool: 'AskUserQuestion',
              kind: 'user_action',
              arguments: { question: 'Pick a color' },
              createdAt: 1,
            },
          },
          completedRequests: {},
        }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      serverId: 'server-a',
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      credentials: { token: 't' },
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: sessions => storage.getState().applySessions(sessions),
      getExistingSession: id => storage.getState().sessions[id],
      includeTurnsProjection: false,
      log: { log: () => {} },
    });

    expect(onAgentRequest).toHaveBeenCalledWith(
      { serverId: 'server-a', sessionId: 's1' },
      'req_1',
      'user_action',
      'AskUserQuestion',
      { question: 'Pick a color' },
    );
    } finally {
      storage.setState(initialState, true);
    }
  });

  it('applies a plaintext session row by id', async () => {
    onAgentRequest.mockClear();
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => null);
    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);

    const responseJson = {
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
        share: null,
      },
    };

    const request = vi.fn(async () => new Response(JSON.stringify(responseJson), { status: 200 }));
    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption,
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(request).toHaveBeenCalledWith('/v2/sessions/s1', expect.any(Object));
    expect(decryptEncryptionKey).not.toHaveBeenCalled();
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        encryptionMode: 'plain',
        metadata: expect.any(Object),
        agentState: expect.any(Object),
        lastViewedSessionSeq: 2,
        pendingPermissionRequestCount: 3,
        pendingUserActionRequestCount: 1,
      }),
    ]);
  });

  it('stores the owning serverId on hydrated sessions when fetch scope is known', async () => {
    const applySessions = vi.fn();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }),
        agentStateVersion: 1,
        agentState: JSON.stringify({ controlledByUser: true }),
        share: null,
      },
    }), { status: 200 }));

    await fetchAndApplySessionById({
      sessionId: 's1',
      serverId: 'server-owned',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        serverId: 'server-owned',
      }),
    ]);
  });

  it('initializes session encryption when dataEncryptionKey is present', async () => {
    onAgentRequest.mockClear();
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => sessionDataKey());
    const initializeSessions = vi.fn(async () => {});
    const externalSessionOperationPresentationV1 =
      ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-public-safe-1',
        revision: 4,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
      });
    const decryptMetadataPayload = vi.fn(async () =>
      projectSessionSharedMetadataV1({
        metadata: { externalSessionOperationPresentationV1 },
      }));
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's1',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>();

    await fetchAndApplySessionById({
      sessionId: 's1',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).toHaveBeenCalledWith('dek');
    expect(initializeSessions).toHaveBeenCalledWith(
      new Map([['s1', sessionDataKey()]]),
      { shouldContinue: expect.any(Function) },
    );
    expect(sessionDataKeys.get('s1')).toEqual(sessionDataKey());

    expect(decryptMetadataPayload).toHaveBeenCalledWith(
      1,
      'enc-meta',
      expect.objectContaining({ onAuthenticationFailure: expect.any(Function) }),
    );
    expect(decryptMetadata).not.toHaveBeenCalled();
    expect(decryptAgentState).toHaveBeenCalledWith(1, 'enc-state');
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's1',
        metadata: expect.objectContaining({
          externalSessionOperationPresentationV1,
        }),
      }),
    ]);
    const hydratedMetadata = JSON.stringify(
      applySessions.mock.calls[0]?.[0]?.[0]?.metadata,
    );
    expect(hydratedMetadata).toContain('operation-public-safe-1');
    expect(hydratedMetadata).not.toContain('operationClaimId');
    expect(hydratedMetadata).not.toContain('canonicalOwnerEvidence');
    expect(hydratedMetadata).not.toContain('privateStagingId');
  });

  it('does not repopulate active account key or session state after authority changes during key initialization', async () => {
    let current = true;
    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const initializeSessions = vi.fn(async () => await initialization);
    const getSessionEncryption = vi.fn(() => null);
    const applySessions = vi.fn();
    const sessionDataKeys = new Map<string, Uint8Array>();
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 'stale-account-session',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: false,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'account-a-envelope',
        metadataVersion: 1,
        metadata: 'encrypted-metadata',
        agentStateVersion: 1,
        agentState: 'encrypted-agent-state',
        share: null,
      },
    }), { status: 200 }));

    const hydration = fetchAndApplySessionById({
      sessionId: 'stale-account-session',
      serverId: 'server-a',
      credentials: { token: 'account-a-token', secret: 'account-a-secret' } as any,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions,
        getSessionEncryption,
      },
      sessionDataKeys,
      request,
      applySessions,
      getExistingSession: () => ({
        id: 'stale-account-session',
        serverId: 'server-a',
        createdAt: 1,
        updatedAt: 3,
        seq: 4,
        active: false,
        activeAt: 2,
        encryptionMode: 'e2ee',
        metadataVersion: 2,
        metadata: null,
        agentStateVersion: 2,
        agentState: null,
        thinking: false,
        thinkingAt: 0,
      }),
      isCurrent: () => current,
      log: { log: () => {} },
    });
    await vi.waitFor(() => expect(initializeSessions).toHaveBeenCalledTimes(1));
    current = false;
    releaseInitialization();

    await expect(hydration).resolves.toMatchObject({
      ok: false,
      errorCode: 'stale_response',
    });
    expect(sessionDataKeys.has('stale-account-session')).toBe(false);
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('does not retain a data key after the Account/server encryption generation changes during initialization', async () => {
    let generation = 7;
    let releaseInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const sessionDataKeys = new Map<string, Uint8Array>();
    const initializeSessions = vi.fn(async () => await initialization);
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => new Uint8Array(32).fill(8));
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 'generation-scoped-session',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: false,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'account-a-envelope',
        metadataVersion: 1,
        metadata: 'encrypted-metadata',
        agentStateVersion: 1,
        agentState: 'encrypted-agent-state',
        share: null,
      },
    }), { status: 200 }));

    const hydration = fetchAndApplySessionById({
      sessionId: 'generation-scoped-session',
      serverId: 'server-a',
      credentials: { token: 'account-a-token', secret: 'account-a-secret' } as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => null,
        getCurrentEncryptionGenerationScope: (scope) => ({
          accountId: scope?.accountId ?? 'account-a',
          serverId: scope?.serverId ?? null,
          generation,
        }),
        isCurrentEncryptionGenerationScope: (scope) => scope.generation === generation,
      },
      sessionDataKeys,
      request,
      applySessions,
      log: { log: () => {} },
    });

    await vi.waitFor(() => expect(initializeSessions).toHaveBeenCalledTimes(1));
    generation += 1;
    releaseInitialization();

    await expect(hydration).resolves.toMatchObject({
      ok: false,
      session: null,
      errorCode: 'stale_response',
    });
    expect(sessionDataKeys.has('generation-scoped-session')).toBe(false);
    expect(initializeSessions).toHaveBeenCalledWith(
      new Map([['generation-scoped-session', new Uint8Array(32).fill(8)]]),
      expect.objectContaining({ serverId: 'server-a', shouldContinue: expect.any(Function) }),
    );
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('reuses a cached session data key when the encrypted envelope is unchanged', async () => {
    const applySessions = vi.fn();
    const decryptEncryptionKey = vi.fn(async () => sessionDataKey());
    const initializeSessions = vi.fn(async () => {});
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const decryptMetadataPayload = vi.fn(async () => sharedMetadata);
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
    const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
    const cachedKey = sessionDataKey();

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_cached',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'cached-envelope',
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const sessionDataKeys = new Map<string, Uint8Array>([['s_cached', cachedKey]]);
    const sessionDataKeyEnvelopes = new Map<string, string>([['s_cached', 'cached-envelope']]);

    await fetchAndApplySessionById({
      sessionId: 's_cached',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey,
        initializeSessions,
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys,
      sessionDataKeyEnvelopes,
      request,
      applySessions,
      log: { log: () => {} },
    });

    expect(decryptEncryptionKey).not.toHaveBeenCalled();
    expect(initializeSessions).toHaveBeenCalledWith(
      new Map([['s_cached', cachedKey]]),
      { shouldContinue: expect.any(Function) },
    );
    expect(sessionDataKeys.get('s_cached')).toBe(cachedKey);
    expect(sessionDataKeyEnvelopes.get('s_cached')).toBe('cached-envelope');
    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_cached',
        metadata: sharedMetadata,
        agentState: { controlledByUser: true },
      }),
    ]);
  });

  it('starts encrypted metadata and agent-state decrypts before awaiting either result', async () => {
    const applySessions = vi.fn();
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const metadataDeferred = createDeferred<typeof sharedMetadata>();
    const agentStateDeferred = createDeferred<{ controlledByUser: true }>();
    const decryptMetadataPayload = vi.fn(async () => metadataDeferred.promise);
    const decryptMetadata = vi.fn(async () => {
      throw new Error('layout-v1 metadata must bypass the legacy parser');
    });
    const decryptAgentState = vi.fn(async () => agentStateDeferred.promise);

    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_parallel',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-meta',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-state',
        share: null,
      },
    }), { status: 200 }));

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_parallel',
      credentials: OWNER_TEST_CREDENTIALS as any,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata,
          decryptMetadataPayload,
          decryptAgentState,
        } as any),
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions,
      log: { log: () => {} },
    });

    try {
      await expect.poll(() => ({
        metadata: decryptMetadataPayload.mock.calls.length,
        agentState: decryptAgentState.mock.calls.length,
      }), { timeout: 100 }).toEqual({ metadata: 1, agentState: 1 });
    } finally {
      metadataDeferred.resolve(sharedMetadata);
      agentStateDeferred.resolve({ controlledByUser: true });
      await fetchPromise;
    }

    expect(applySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 's_parallel',
        metadata: sharedMetadata,
        agentState: { controlledByUser: true },
      }),
    ]);
    expect(decryptMetadata).not.toHaveBeenCalled();
  });

  it('treats a newer stored owner tuple as visible after store admission of the older by-id response', async () => {
    onAgentRequest.mockClear();
    const staleSharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Stale', updatedAt: 1 },
      },
    });
    const newerSharedMetadata = projectSessionSharedMetadataV1({
      metadata: {
        summary: { text: 'Newer', updatedAt: 2 },
      },
    });
    const metadataDeferred =
      createDeferred<typeof staleSharedMetadata>();
    const decryptMetadataPayload = vi.fn(
      async () => metadataDeferred.promise,
    );
    const decryptAgentState = vi.fn(async () => ({
      requests: {
        staleRequest: {
          tool: 'stale-tool',
          arguments: {},
          createdAt: 1,
        },
      },
    }));
    const applySessions = vi.fn();
    let currentSession: Session | null = null;
    const request = vi.fn(async () => new Response(JSON.stringify({
      session: {
        id: 's_stale_decrypt',
        createdAt: 1,
        updatedAt: 1,
        seq: 1,
        active: true,
        activeAt: 1,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'dek',
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        metadata: 'enc-stale-metadata',
        ownerMetadata: OWNER_METADATA_ENVELOPE,
        agentStateVersion: 1,
        agentState: 'enc-stale-agent-state',
        share: null,
      },
    }), { status: 200 }));

    const fetchPromise = fetchAndApplySessionById({
      sessionId: 's_stale_decrypt',
      serverId: 'server-a',
      credentials: OWNER_TEST_CREDENTIALS as never,
      encryption: {
        decryptEncryptionKey: async () => sessionDataKey(),
        initializeSessions: async () => {},
        getSessionEncryption: () => ({
          decryptMetadata: async () => null,
          decryptMetadataPayload,
          decryptAgentState,
        }),
      },
      sessionDataKeys: new Map(),
      request,
      applySessions,
      getExistingSession: () => currentSession,
      log: { log: () => {} },
      includeTurnsProjection: false,
      includeMetadataTupleMutationSnapshot: true,
    });

    await expect.poll(
      () => decryptMetadataPayload.mock.calls.length,
      { timeout: 100 },
    ).toBe(1);
    currentSession = {
      id: 's_stale_decrypt',
      serverId: 'server-a',
      createdAt: 1,
      updatedAt: 2,
      seq: 2,
      active: true,
      activeAt: 2,
      encryptionMode: 'e2ee',
      metadataLayoutVersion: 1,
      metadataVersion: 2,
      metadata: newerSharedMetadata as unknown as Session['metadata'],
      ownerMetadataView: {
        path: '/newer/private',
        host: 'newer-host',
        summary: { text: 'Newer', updatedAt: 2 },
      },
      agentStateVersion: 1,
      agentState: {
        requests: {
          newerRequest: {
            tool: 'newer-tool',
            arguments: {},
            createdAt: 2,
          },
        },
      },
      thinking: false,
      thinkingAt: 0,
      presence: 'online',
    };
    metadataDeferred.resolve(staleSharedMetadata);

    await expect(fetchPromise).resolves.toMatchObject({
      ok: true,
      session: currentSession,
      metadataTupleMutationSnapshot: null,
    });
    expect(applySessions).toHaveBeenCalledTimes(1);
    expect(onAgentRequest).not.toHaveBeenCalled();
    expect(currentSession.metadata).toEqual(newerSharedMetadata);
    expect(currentSession.ownerMetadataView).toMatchObject({
      path: '/newer/private',
    });
    expect(currentSession.agentStateVersion).toBe(1);
  });

  it('coalesces concurrent session detail HTTP reads for the same request transport', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_coalesced',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_coalesced',
      credentials: { token: 't' } as any,
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      readTransport: capturedSessionHttp(request),
      log: { log: () => {} },
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const first = fetchAndApplySessionById({ ...baseParams, applySessions: firstApplySessions });
    const second = fetchAndApplySessionById({ ...baseParams, applySessions: secondApplySessions });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(request.mock.calls.filter((call) => call[0] === '/v2/sessions/s_coalesced')).toHaveLength(1);
    expect(request.mock.calls.filter((call) => call[0] === '/v1/sessions/s_coalesced/turns')).toHaveLength(1);
    expect(runtimeFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v2/sessions/read-batch')).toHaveLength(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_coalesced' })]);
  });

  it('detaches one exact-read deadline without cancelling another borrower of the same authority', async () => {
    const detailGate = createDeferred<void>();
    let physicalSignal: AbortSignal | null | undefined;
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      physicalSignal = init.signal;
      await Promise.race([
        detailGate.promise,
        new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
      ]);
      return Response.json({ session: {
        id: 's_deadline', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
        metadata: JSON.stringify({ readStateV1: null }), agentStateVersion: 1,
        agentState: null, share: null,
      } });
    });
    const common = {
      sessionId: 's_deadline', credentials: { token: 't' }, request,
      readTransport: capturedSessionHttp(request),
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map<string, Uint8Array>(),
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS, contentDemand: 'encryption-context' as const,
      applySessions: vi.fn(), log: { log: () => {} },
    };
    const short = fetchAndApplySessionById({ ...common, timeoutMs: 10 });
    const surviving = fetchAndApplySessionById({ ...common, timeoutMs: 1000 });
    await expect(short).resolves.toMatchObject({ ok: false });
    const cancelledSurvivor = physicalSignal?.aborted;
    detailGate.resolve();
    const result = await surviving;
    expect(cancelledSurvivor).toBe(false);
    expect(result).toMatchObject({ ok: true, encryptionMode: 'plain' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent scoped session detail HTTP reads across request wrappers', async () => {
    const detailGate = createDeferred<void>();
    let detailRequests = 0;
    const createRequest = () => vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_scoped_coalesced') {
        detailRequests += 1;
        await detailGate.promise;
        return new Response(JSON.stringify({
          session: {
            id: 's_scoped_coalesced',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_scoped_coalesced/turns') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_scoped_coalesced',
      serverId: 'server-a',
      credentials: { token: 't' } as any,
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      log: { log: () => {} },
      readTransport: capturedSessionHttp(createRequest()),
    };

    const firstApplySessions = vi.fn();
    const secondApplySessions = vi.fn();
    const first = fetchAndApplySessionById({
      ...baseParams,
      request: createRequest(),
      applySessions: firstApplySessions,
    });
    const second = fetchAndApplySessionById({
      ...baseParams,
      request: createRequest(),
      applySessions: secondApplySessions,
    });

    await expect.poll(() => detailRequests, { timeout: 100 }).toBe(1);
    detailGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(detailRequests).toBe(1);
    expect(runtimeFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v2/sessions/read-batch')).toHaveLength(1);
    expect(firstApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
    expect(secondApplySessions).toHaveBeenCalledWith([expect.objectContaining({ id: 's_scoped_coalesced' })]);
  });

  it('does not adopt a pre-wake in-flight detail observation for a later captured demand', async () => {
    const oldDetailGate = createDeferred<void>();
    let oldDetailRequests = 0;
    let newDetailRequests = 0;
    const buildResponse = (path: string) => new Response(JSON.stringify({
      session: {
        id: 's_authority_rotation',
        createdAt: 1,
        updatedAt: 2,
        seq: 3,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 1,
        metadata: JSON.stringify({ path }),
        agentStateVersion: 1,
        agentState: null,
        share: null,
      },
    }), { status: 200 });
    const oldRequest = vi.fn(async () => {
      oldDetailRequests += 1;
      await oldDetailGate.promise;
      return buildResponse('/old-authority');
    });
    const newRequest = vi.fn(async () => {
      newDetailRequests += 1;
      return buildResponse('/new-authority');
    });
    let currentRequest = oldRequest;
    const readTransport = capturedSessionHttp(() => currentRequest());
    const encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    } satisfies SessionByIdEncryption;
    const baseParams = {
      sessionId: 's_authority_rotation',
      serverId: 'server-a',
      credentials: { token: 't' },
      encryption,
      sessionDataKeys: new Map<string, Uint8Array>(),
      log: { log: () => {} },
      includeTurnsProjection: false,
      readTransport,
    };
    const oldApplySessions = vi.fn();
    const newApplySessions = vi.fn();
    const oldRead = fetchAndApplySessionById({
      ...baseParams,
      request: oldRequest,
      applySessions: oldApplySessions,
    });
    await expect.poll(() => oldDetailRequests).toBe(1);
    currentRequest = newRequest;
    publishHomeAccountChange('server-a', ['s_authority_rotation']);
    const newRead = fetchAndApplySessionById({
      ...baseParams,
      request: newRequest,
      applySessions: newApplySessions,
    });
    await Promise.resolve();
    oldDetailGate.resolve();
    await Promise.all([oldRead, newRead]);

    expect(newDetailRequests).toBe(1);
    expect(newApplySessions).toHaveBeenCalledWith([
      expect.objectContaining({
        metadata: expect.objectContaining({ path: '/new-authority' }),
      }),
    ]);
  });

  it('can hydrate the session shell without fetching the turns projection', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/v2/sessions/s_shell_only') {
        return new Response(JSON.stringify({
          session: {
            id: 's_shell_only',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      if (path === '/v1/sessions/s_shell_only/turns') {
        throw new Error('turns projection should not be fetched for shell-only hydration');
      }

      throw new Error(`unexpected path ${path}`);
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_shell_only',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: vi.fn(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    expect(request.mock.calls.map((call) => call[0])).toEqual(['/v2/sessions/s_shell_only']);
  });

  it.each(['batch', 'opaque'] as const)('does not replace a %s transient detail refusal with a stale legacy listing', async transportKind => {
    const session = createSessionFixture({ id: 'unavailable', encryptionMode: 'plain' });
    const row = createPlainSessionByIdResponseFixture(session).session;
    const reads: string[] = [];
    const request = async (path: string, _init: RequestInit) => {
      reads.push(path);
      if (path === '/v2/sessions/unavailable') return transportKind === 'batch'
        ? Response.json({ error: 'session_read_unavailable' }, { status: 503 })
        : new Response(null, { status: 503 });
      return Response.json({ sessions: [row], nextCursor: null, hasNext: false });
    };
    const applySessions = vi.fn();
    const result = await fetchAndApplySessionById({
      sessionId: session.id, credentials: { token: 't' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
      encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION, sessionDataKeys: new Map(), request,
      ...(transportKind === 'batch' ? { readTransport: capturedSessionHttp(request) } : {}),
      contentDemand: 'list-projection', includeTurnsProjection: false, applySessions, log: { log() {} },
    });
    expect(result).toMatchObject({ ok: false, session: null, errorCode: 'http_error', httpStatus: 503 });
    expect(reads).toEqual(['/v2/sessions/unavailable']);
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('classifies a malformed admitted batch as an invalid response without accepting a legacy list row', async () => {
    const reads: string[] = [];
    const request = async (path: string, _init: RequestInit) => {
      reads.push(path);
      if (path === '/v2/sessions/malformed') return Response.json({});
      return Response.json({ sessions: [createPlainSessionByIdResponseFixture(
        createSessionFixture({ id: 'malformed', encryptionMode: 'plain' })).session], nextCursor: null, hasNext: false });
    };
    const applySessions = vi.fn();
    const result = await fetchAndApplySessionById({ sessionId: 'malformed', credentials: { token: 't' },
      accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS, encryption: PLAINTEXT_ACCOUNT_SESSION_ENCRYPTION,
      sessionDataKeys: new Map(), request, readTransport: capturedSessionHttp(request),
      contentDemand: 'list-projection', includeTurnsProjection: false, applySessions, log: { log() {} } });
    expect(result).toMatchObject({ ok: false, session: null, errorCode: 'invalid_response' });
    expect(reads).toEqual(['/v2/sessions/malformed']);
    expect(applySessions).not.toHaveBeenCalled();
  });

  it('uses browser-CORS-safe headers for targeted session detail reads', async () => {
    const request = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/v2/sessions/s_purpose') {
        return new Response(JSON.stringify({
          session: {
            id: 's_purpose',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: true }),
            share: null,
          },
        }), { status: 200 });
      }

      throw new Error(`unexpected path ${path}`);
    });

    const result = await fetchAndApplySessionById({
      sessionId: 's_purpose',
      credentials: { token: 't' } as any,
      encryption: {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        getSessionEncryption: () => null,
      },
      sessionDataKeys: new Map<string, Uint8Array>(),
      request,
      applySessions: vi.fn(),
      log: { log: () => {} },
      includeTurnsProjection: false,
    });

    expect(result.ok).toBe(true);
    const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
    }));
    expect(headers).not.toHaveProperty('X-Happier-Request-Purpose');
  });
});

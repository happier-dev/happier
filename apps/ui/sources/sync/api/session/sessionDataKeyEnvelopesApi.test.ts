import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

// Transform the real transport graph during collection, before per-request assertions.
import './sessionDataKeyEnvelopesApi';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

/**
 * The manager Account's real content key pair. Persisted data-key credentials carry the content
 * private key as `machineKey`, which is exactly what the canonical Account encryption owner opens
 * the caller's own Session envelope with — so the composed test never fabricates a key.
 */
const MANAGER_CONTENT_KEYS = tweetnacl.box.keyPair();

/** A Session's stored shared metadata ciphertext as the Home serves it, sealed with `key`. */
async function sealSharedMetadata(key: Uint8Array, plaintext: unknown): Promise<string> {
    const { AES256Encryption } = await import('@/sync/encryption/encryptor');
    const { encodeBase64 } = await import('@/encryption/base64');
    const [sealed] = await new AES256Encryption(key).encrypt([plaintext]);
    return encodeBase64(sealed!, 'base64');
}

/** The canonical layout-1 owner tuple sealed to the manager, as the Home serves it beside shared metadata. */
async function sealedOwnerMetadata() {
    const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { sealSessionOwnerMetadataEnvelopeV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
    const current = createPlainSessionCurrentProjectionRecordFixture({ metadata: null });
    if (current.ownerMetadata?.t !== 'plain') throw new Error('Expected the canonical owner fixture');
    return sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'dataKey', machineKey: MANAGER_CONTENT_KEYS.secretKey },
        ownerMetadata: current.ownerMetadata.v, randomBytes: tweetnacl.randomBytes });
}

/** A recipient with a real content key and a binding its own signing key signed. */
async function createAvailableRecipient(recipientAccountId: string) {
    const { encodeBase64 } = await import('@/encryption/base64');
    const { encodeHex } = await import('@/encryption/hex');
    const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol/crypto/accountContentKeyBindingV1');
    const content = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    return { content, item: {
        recipientAccountId, envelopeState: 'missing' as const,
        contentKey: {
            status: 'available' as const,
            accountSigningPublicKey: encodeHex(signing.publicKey),
            contentPublicKey: encodeBase64(content.publicKey, 'base64'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey,
            }), 'base64'),
        },
    } };
}

async function setup(options?: Readonly<{ accountEncryption?: 'plain' | 'e2ee' }>) {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `envelope-${crypto.randomUUID()}`);
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    const target = await upsertServerProfile({ serverUrl: 'https://target.example', name: 'Target' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
    const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { encodeBase64 } = await import('@/encryption/base64');
    // Persistent credentials and HTTP are the replaced system boundaries.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => ({
        token: token(url === 'https://target.example' ? 'target-account' : 'active-account'),
        ...(options?.accountEncryption === 'e2ee' ? {
            encryption: {
                publicKey: encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                machineKey: encodeBase64(MANAGER_CONTENT_KEYS.secretKey, 'base64'),
            },
        } : {}),
    }));
    const request = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response(JSON.stringify({ status: 'not_required' })));
    const sessionBoundary = createSessionReadBatchHttpBoundary(component => component.path === '/v2/sessions/read-batch'
        ? undefined : request(String(component.url), { method: component.method, headers: component.headers, signal: component.signal }));
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const targetUrl = new URL(String(url));
        if (targetUrl.pathname === '/v1/auth/ping') return new Response('{}');
        // The persisted key binding the Account encryption owner admits material against comes from
        // the canonical currentness fixture, derived from the same real manager key pair.
        if (targetUrl.pathname === '/v1/account/encryption/currentness' && options?.accountEncryption === 'e2ee') {
            const { createDataKeyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
            return Response.json(createDataKeyAccountEncryptionCurrentnessFixture({
                machineKey: MANAGER_CONTENT_KEYS.secretKey, publicKey: MANAGER_CONTENT_KEYS.publicKey }));
        }
        if (targetUrl.pathname === '/v2/sessions/read-batch') {
            const response = await sessionBoundary.handle({ home: targetUrl.origin, method: init?.method ?? 'GET',
                path: targetUrl.pathname, url: targetUrl, accountId: null, headers: new Headers(init?.headers),
                body: JSON.parse(String(init?.body)), signal: init?.signal });
            if (!response) throw new Error('Session batch boundary omitted its response');
            return response;
        }
        return request(String(url), init);
    });
    return { target, request, token, TokenStorage };
}

describe('Session envelope exact Account transport', () => {
    it('shares equivalent page reads across captured callers while cancellation detaches only one reader', async () => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const signals: Array<AbortSignal | null | undefined> = [];
        env.request.mockImplementation(async (_url, init) => {
            signals.push(init?.signal);
            await Promise.race([held, new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort',
                () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))]);
            return Response.json({ status: 'not_required' });
        });
        const firstAbort = new AbortController();
        const options = { scope: { serverId: env.target.id, accountId: 'target-account' }, sessionId: 'same', availability: 'available' as const };
        const departed = createSessionDataKeyEnvelopeClient({ ...options, signal: firstAbort.signal }).fetchPage(null)
            .then(() => 'disclosed', () => 'cancelled');
        const survivor = createSessionDataKeyEnvelopeClient(options).fetchPage(null);
        await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
        firstAbort.abort();
        await expect(departed).resolves.toBe('cancelled');
        const cancelledSurvivor = signals.at(-1)?.aborted;
        release();
        await expect(survivor).resolves.toEqual({ status: 'not_required' });
        expect(cancelledSurvivor).toBe(false);
        expect(env.request).toHaveBeenCalledTimes(1);
    });

    it('separates audience and cursor pages and never lets a post-PATCH read join a pre-write observation', async () => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        const { encodeSessionDataKeyEnvelopeCursorV1 } = await import('@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let getCount = 0;
        env.request.mockImplementation(async (_url, init) => {
            if (init?.method === 'PATCH') return Response.json({ appliedCount: 0 });
            getCount += 1;
            if (getCount === 1) await held;
            return Response.json({ status: 'not_required' });
        });
        const options = { scope: { serverId: env.target.id, accountId: 'target-account' }, sessionId: 'same', availability: 'available' as const };
        const client = createSessionDataKeyEnvelopeClient(options);
        const old = client.fetchPage(null);
        try {
            await vi.waitFor(() => expect(getCount).toBe(1));
            await client.patchPage({ entries: [] });
            const current = client.fetchPage(null);
            await vi.waitFor(() => expect(getCount).toBe(2));
            release();
            await Promise.all([old, current]);
            await Promise.all([client.fetchPage(null),
                createSessionDataKeyEnvelopeClient({ ...options, state: 'all' }).fetchPage(null),
                client.fetchPage(encodeSessionDataKeyEnvelopeCursorV1('recipient'))]);
            expect(getCount).toBe(5);
        } finally { release(); await old; }
    });

    it.each([
        { payload: { error: 'credential_scope_denied' }, code: 'credential_scope_denied' },
        { payload: { error: 'credential_scope_denied', details: {} }, code: 'session_data_key_envelope_request_failed' },
    ])('preserves only a strict scope refusal: $code', async ({ payload, code }) => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        env.request.mockImplementation(async () => Response.json(payload, { status: 403 }));
        const client = createSessionDataKeyEnvelopeClient({ scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available' });
        await expect(client.fetchPage(null)).rejects.toMatchObject({ code, status: 403 });
        await expect(client.patchPage({ entries: [] })).rejects.toMatchObject({ code, status: 403 });
    });

    it('reads the nested resource with target credentials and rejects an Account mismatch before discovery', async () => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        const args = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same/id', availability: 'available' as const,
            isCurrent: () => true,
        };
        await expect(createSessionDataKeyEnvelopeClient(args).fetchPage(null)).resolves.toEqual({ status: 'not_required' });
        expect(env.request.mock.calls[0]?.[0]).toBe('https://target.example/v2/sessions/same%2Fid/data-key/envelopes?state=action_required');
        expect(new Headers(env.request.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
        env.request.mockClear();
        await expect(createSessionDataKeyEnvelopeClient({ ...args, scope: { ...args.scope, accountId: 'wrong' } }).fetchPage(null)).rejects.toThrow();
        expect(env.request).not.toHaveBeenCalled();
    });

    it('fails unsupported collection access without probing and preserves typed server errors', async () => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        const args = { scope: { serverId: env.target.id, accountId: 'target-account' }, sessionId: 'same', isCurrent: () => true };
        await expect(createSessionDataKeyEnvelopeClient({ ...args, availability: 'unavailable' }).fetchPage(null)).rejects.toMatchObject({ code: 'session_access_sharing_unavailable' });
        expect(env.request).not.toHaveBeenCalled();
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
        await expect(createSessionDataKeyEnvelopeClient({ ...args, availability: 'available' }).fetchPage(null)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(env.request.mock.calls).toHaveLength(1);
    });

    it('preserves a missing Session refusal without discovering recipient identities', async () => {
        const env = await setup();
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return Response.json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/sessions/same') return Response.json({ error: 'Session not found' }, { status: 404 });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(prepareSessionDataKeyEnvelopesForScope({ scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true }))
            .rejects.toMatchObject({ errorCode: 'not_found', httpStatus: 404 });
        expect(env.request.mock.calls.some(([url]) => url.endsWith('/turns') || url.includes('/data-key/envelopes'))).toBe(false);
    });

    it('prepares a plain Session without opening keys or discovering recipient identities', async () => {
        const env = await setup();
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 0, active: true, activeAt: 2,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1, metadata: '{}',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'not_required', preparedCount: 0 });
        expect(env.request.mock.calls.every(([url]) => !url.includes('/data-key/envelopes'))).toBe(true);
        expect(env.request.mock.calls.some(([url]) => url.endsWith('/turns'))).toBe(false);
    });

    it.each([
        ['session_access_authentication_required', 403],
        ['session_access_authentication_unavailable', 503],
    ] as const)('preserves %s through the envelope transport and existing recovery presenter', async (code, status) => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        const { presentSessionAccessFailure, presentSessionAccessReason } = await import('@/components/sessions/access/presentSessionAccessFailure');
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: code }), { status }));
        const client = createSessionDataKeyEnvelopeClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        });
        const failure = await client.fetchPage(null).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code, status });
        expect(presentSessionAccessFailure(failure)).toEqual({ ...presentSessionAccessReason(code), retryable: false });
        // A sign-in requirement is surfaced once; the client cannot replay a mutation.
        expect(env.request.mock.calls).toHaveLength(1);
    });

    it.each(['missing', 'prepared'] as const)('prepares a real E2EE Session for a %s recipient so it opens the exact Session DEK', async (envelopeState) => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { openEncryptedDataKeyEnvelopeV1, signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');

        // The one Session DEK, sealed to the manager exactly as the Home stores it.
        const sessionDataKey = new Uint8Array(32).fill(11);
        const callerEnvelope = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        const contentPublicKey = encodeBase64(recipient.content.publicKey, 'base64');
        const item = {
            recipientAccountId: 'recipient-1',
            envelopeState,
            contentKey: {
                status: 'available',
                accountSigningPublicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey,
                contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            },
        };

        const events: string[] = [];
        let uploaded: { recipientAccountId: string; encryptedDataKey: string } | null = null;
        let envelopePages = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
                contentKeyFingerprint: 'content-current', updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' },
            }));
            if (path === '/v2/sessions/same') {
                events.push('session');
                return new Response(JSON.stringify({ session: {
                    id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                    encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                    metadataLayoutVersion: 1, metadataVersion: 4, metadata: await sealSharedMetadata(sessionDataKey, { v: 1 }),
                    ownerMetadata: await sealedOwnerMetadata(),
                    agentStateVersion: 5, agentState: null, share: null,
                } }));
            }
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            if (path.endsWith('/data-key/envelopes') && init?.method === 'PATCH') {
                events.push('patch');
                const body = JSON.parse(String(init.body)) as { entries: typeof uploaded[] };
                expect(body.entries.map(entry => entry?.recipientAccountId)).toEqual(['recipient-1']);
                uploaded = body.entries[0] ?? null;
                return new Response(JSON.stringify({ appliedCount: 1 }));
            }
            if (path.endsWith('/data-key/envelopes')) {
                envelopePages += 1;
                events.push(`get:${envelopePages}`);
                const includesRecipient = envelopeState === 'missing' || new URL(url).searchParams.get('state') === 'all';
                return new Response(JSON.stringify(envelopePages === 1
                    ? { status: 'required', summary: { prepared: envelopeState === 'prepared' ? 2 : 0, pending: envelopeState === 'missing' ? 1 : 0, invalid: 0, recipientKeyUnavailable: 0 }, items: includesRecipient ? (envelopeState === 'prepared' ? [{ ...item, recipientAccountId: 'unrelated-recipient' }, item] : [item]) : [], nextCursor: null }
                    : { status: 'required', summary: { prepared: envelopeState === 'prepared' ? 2 : 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [], nextCursor: null }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        const onProgress = vi.fn(() => { events.push('progress'); });
        const outcome = await prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
            ...(envelopeState === 'prepared' ? { reprepareRecipientAccountId: 'recipient-1' } : {}),
            onProgress,
        });

        expect(outcome.status).toBe('complete');
        const { SessionAccessEncryptionPrepareResultV1Schema } = await import('@happier-dev/protocol/sessions/access/sessionAccessActionsV1');
        expect(SessionAccessEncryptionPrepareResultV1Schema.parse(outcome)).toEqual(outcome);
        expect(outcome.preparedCount).toBe(1);
        expect(env.request.mock.calls.some(([url]) => url.endsWith('/turns'))).toBe(false);
        // The recipient recovers the exact 32 bytes the manager opened from its own envelope —
        // not a re-keyed value, and not the manager's Account material.
        const opened = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(uploaded!.encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: recipient.content.secretKey,
        });
        expect(opened).toEqual(sessionDataKey);
        expect(opened?.byteLength).toBe(32);
        // Nobody else can open it, including the manager whose envelope supplied the key.
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(uploaded!.encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: MANAGER_CONTENT_KEYS.secretKey,
        })).toBeNull();
        // Snapshot, then the served row that proves the key, before discovery; progress only after
        // the server acknowledged the commit.
        expect(events).toEqual(['session', 'session', 'get:1', 'patch', 'progress', 'get:2']);
        expect(onProgress).toHaveBeenCalledWith({
            preparedCount: 1,
            pagesCommitted: 1,
            actionableTotal: 1,
        });
        // The rendered aggregate is the server's own, refreshed by the final recheck page.
        expect(outcome.summary).toEqual({ prepared: envelopeState === 'prepared' ? 2 : 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 });
    });

    it.each([
        ['Saved Secret', 'its own non-Session content', { name: 'deploy token', value: 'redacted' }, null],
        ['Workflow', 'Session metadata it cannot open', { v: 1 }, new Uint8Array(32).fill(1)],
        ['Machine', 'layout-1 claimed over a flat record', { host: 'alice', platform: 'linux' }, null],
    ] as const)('seals nothing when a malicious Home serves a %s key as the Session key with %s', async (_resource, _case, plaintext, metadataKey) => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        // A resource key this manager can open, listed by the Home as this Session's envelope.
        const foreignResourceKey = new Uint8Array(32).fill(0x5a);
        const metadata = await sealSharedMetadata(metadataKey ?? foreignResourceKey, plaintext);
        const ownerMetadata = await sealedOwnerMetadata();
        const recipient = await createAvailableRecipient('recipient-1');
        const patches: string[] = [];
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current', updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v2/sessions/same') return Response.json({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee',
                dataEncryptionKey: encryptDataKeyForRecipientV0(foreignResourceKey, encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64')),
                metadataLayoutVersion: 1, metadataVersion: 4, metadata, ownerMetadata,
                agentStateVersion: 5, agentState: null, share: null,
            } });
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            if (init?.method === 'PATCH') { patches.push(path); return Response.json({ appliedCount: 1 }); }
            if (path.endsWith('/data-key/envelopes')) return Response.json({ status: 'required',
                summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [recipient.item], nextCursor: null });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'session_data_key_unavailable', preparedCount: 0 });
        expect(patches).toEqual([]);
    });

    it('moves a layout-0 Session to layout 1 once through the tuple owner, then shares the proven key', async () => {
        // The app entry registers this runtime; the tuple owner under it stays real.
        await import('@/sync/syncEngine');
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { openEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const { createDataKeyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        const sessionDataKey = new Uint8Array(32).fill(21);
        const recipient = await createAvailableRecipient('recipient-1');
        // A released 0.2 Session: one flat record sealed with its own key, no layout marker.
        let row: Record<string, unknown> = {
            id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2, encryptionMode: 'e2ee',
            dataEncryptionKey: encryptDataKeyForRecipientV0(sessionDataKey, encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64')),
            metadataLayoutVersion: 0, metadataVersion: 4,
            metadata: await sealSharedMetadata(sessionDataKey, { path: '/repo', host: 'owner-laptop', summary: { text: 'Old work', updatedAt: 1 } }),
            agentStateVersion: 5, agentState: null, share: null,
        };
        const writes: string[] = [];
        let uploaded: string | null = null;
        let pages = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            const method = init?.method ?? 'GET';
            if (path === '/v1/account/encryption/currentness') return Response.json(createDataKeyAccountEncryptionCurrentnessFixture({
                machineKey: MANAGER_CONTENT_KEYS.secretKey, publicKey: MANAGER_CONTENT_KEYS.publicKey }));
            if (path.includes('/account/encryption')) return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current', updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v2/sessions/same' && method === 'PATCH') {
                writes.push('layout');
                const body = JSON.parse(String(init?.body)) as { target: { metadataLayoutVersion: number;
                    sharedMetadata: { ciphertext: string }; ownerMetadata: unknown } };
                row = { ...row, metadataLayoutVersion: body.target.metadataLayoutVersion, metadataVersion: 5,
                    metadata: body.target.sharedMetadata.ciphertext, ownerMetadata: body.target.ownerMetadata, agentStateVersion: 6 };
                return Response.json({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: 5 }, agentState: { version: 6 } });
            }
            if (path === '/v2/sessions/same') return Response.json({ session: row });
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            if (path.endsWith('/data-key/envelopes') && method === 'PATCH') {
                writes.push('envelope');
                uploaded = (JSON.parse(String(init?.body)) as { entries: Array<{ encryptedDataKey: string }> }).entries[0]!.encryptedDataKey;
                return Response.json({ appliedCount: 1 });
            }
            if (path.endsWith('/data-key/envelopes')) {
                pages += 1;
                return Response.json({ status: 'required',
                    summary: { prepared: pages === 1 ? 0 : 1, pending: pages === 1 ? 1 : 0, invalid: 0, recipientKeyUnavailable: 0 },
                    items: pages === 1 ? [recipient.item] : [], nextCursor: null });
            }
            throw new Error(`Unexpected request ${method} ${path}`);
        });
        await expect(prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'complete', preparedCount: 1 });
        // One layout move, before the key is sealed to anyone.
        expect(writes).toEqual(['layout', 'envelope']);
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(uploaded!, 'base64'), recipientSecretKeyOrSeed: recipient.content.secretKey,
        })).toEqual(sessionDataKey);
    }, 180_000);

    it.each(['missing', 'legacy'] as const)('keeps %s standalone-key custody unavailable without turns or recipient discovery', async custody => {
        const env = await setup({ accountEncryption: 'e2ee' });
        if (custody === 'legacy') {
            vi.mocked(env.TokenStorage.getCredentialsForServerUrl).mockImplementation(async url => ({
                token: env.token(url === 'https://target.example' ? 'target-account' : 'active-account'),
                secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'),
            }));
        }
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current', updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v2/sessions/same') return Response.json({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: null, metadataLayoutVersion: 0,
                metadataVersion: 4, metadata: 'not-demanded', agentStateVersion: 5, agentState: null, share: null,
            } });
            throw new Error(`Unexpected request ${path}`);
        });
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        await expect(prepareSessionDataKeyEnvelopesForScope({ scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true }))
            .resolves.toMatchObject({ status: 'session_data_key_unavailable', preparedCount: 0, summary: null });
        expect(env.request.mock.calls.some(([url]) => url.endsWith('/turns') || url.includes('/data-key/envelopes'))).toBe(false);
    });

    it('does not carry a Session DEK across an Account-encryption generation change while opening it', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');

        const sessionDataKey = new Uint8Array(32).fill(11);
        const callerEnvelope = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const originalOpen = Encryption.prototype.decryptEncryptionKey;
        vi.spyOn(Encryption.prototype, 'decryptEncryptionKey').mockImplementation(async function (this: typeof Encryption.prototype, encrypted, scope) {
            const opened = await originalOpen.call(this, encrypted, scope);
            // This is the exact dangerous boundary: the caller's old Session DEK has opened, but
            // the Account encryption owner has moved to a new generation before recipient work
            // begins. Capturing generation only after this await would bless the retired bytes.
            const captured = this.getCurrentEncryptionGenerationScope({ serverId: env.target.id });
            this.configureNativeCryptoWorker({
                scope: {
                    accountId: captured.accountId,
                    serverId: captured.serverId,
                    generation: captured.generation + 1,
                },
            });
            return opened;
        });

        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
                contentKeyFingerprint: 'content-current', updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' },
            }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                metadataLayoutVersion: 0, metadataVersion: 4, metadata: 'sealed-metadata',
                agentStateVersion: 5, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            if (path.endsWith('/data-key/envelopes')) {
                throw new Error('stale key material must not reach recipient discovery');
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await expect(prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'scope_changed', preparedCount: 0 });
        expect(env.request.mock.calls.every(([url]) => !url.includes('/data-key/envelopes'))).toBe(true);
    });

    it('returns scope_changed when Account encryption changes during the Session snapshot read', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { Encryption } = await import('@/sync/encryption/encryption');
        const originalCreate = Encryption.createFromContentKeyPair;
        let manager: typeof Encryption.prototype | null = null;
        vi.spyOn(Encryption, 'createFromContentKeyPair').mockImplementation(async params => {
            manager = await originalCreate(params);
            return manager;
        });
        const { prepareSessionDataKeyEnvelopesForScope } = await import('./sessionDataKeyEnvelopesApi');
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) {
                return new Response(JSON.stringify({
                    mode: 'e2ee',
                    version: 1,
                    signingKeyFingerprint: 'signing-current',
                    contentKeyFingerprint: 'content-current',
                    updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'available' },
                }));
            }
            if (path === '/v2/sessions/same') {
                if (!manager) throw new Error('Expected Account encryption before Session fetch');
                const scope = manager.getCurrentEncryptionGenerationScope({ serverId: env.target.id });
                manager.configureNativeCryptoWorker({ scope: { ...scope, generation: scope.generation + 1 } });
                return new Response(JSON.stringify({ session: {
                    id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                    encryptionMode: 'e2ee', dataEncryptionKey: 'retired-envelope',
                    metadataLayoutVersion: 0, metadataVersion: 4, metadata: 'sealed',
                    agentStateVersion: 5, agentState: null, share: null,
                } }));
            }
            if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(prepareSessionDataKeyEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same', availability: 'available', isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'scope_changed', preparedCount: 0 });
    });

    it('suppresses a response after target credentials change', async () => {
        const env = await setup();
        const { createSessionDataKeyEnvelopeClient } = await import('./sessionDataKeyEnvelopesApi');
        env.request.mockImplementation(async () => {
            await env.TokenStorage.setCredentialsForServerUrl('https://target.example', { serverId: env.target.id }, { token: env.token('replacement') });
            return new Response(JSON.stringify({ status: 'not_required' }));
        });
        await expect(createSessionDataKeyEnvelopeClient({
            scope: { serverId: env.target.id, accountId: 'target-account' }, sessionId: 'same',
            availability: 'available', isCurrent: () => true,
        }).fetchPage(null)).rejects.toMatchObject({ code: 'scope_changed' });
    });
});

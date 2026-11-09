import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Keep the real draft persistence adapter/merge; replace only device record
// transactions so the controlled retry clock cannot block IndexedDB tasks.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

// Install network boundaries before the real Sync graph; load that graph once
// during collection instead of resetting and importing it inside a timed hook.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const drafts = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('./domains/state/storage');
const { profileDefaults } = await import('./domains/profiles/profile');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');

beforeEach(() => network.resetRequests());

afterAll(async () => {
    await disconnectActiveServerConnection();
    await network.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Session draft collection context batching', () => {
    it.each(['plain', 'e2ee'] as const)('opens a %s draft page with one admitted batch for missing Session contexts and reuses retained context', async accountMode => {
        const secret = new Uint8Array(32).fill(17);
        const accountId = `draft-context-${accountMode}`;
        const credentials = { token: createAccountTokenForTests(accountId),
            ...(accountMode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
        const home = await network.addHome(`https://draft-context-${accountMode}.example.test`, accountId,
            { credentials, encryptionMode: accountMode });
        const authorEncryption = await Encryption.create(secret);
        authorEncryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const keys = new Map<string, Uint8Array>(['retained', 'missing-a', 'missing-b'].map((suffix, index) =>
            [`draft-context-${suffix}`, new Uint8Array(32).fill(index + 3)]));
        await authorEncryption.initializeSessions(keys);
        const envelopes = new Map(await Promise.all([...keys].map(async ([id, key]) =>
            [id, encodeBase64(await authorEncryption.encryptEncryptionKey(key), 'base64')] as const)));
        const row = (sessionId: string) => ({ ...createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }),
            ...(accountMode === 'e2ee' ? { encryptionMode: 'e2ee', dataEncryptionKey: envelopes.get(sessionId),
                metadataLayoutVersion: 0, ownerMetadata: undefined, metadata: 'metadata-not-demanded', agentState: 'state-not-demanded' } : {}) });
        const sessionReads: string[] = [];
        const batches: string[][] = [];
        let denied = false;
        let incomplete = false;
        let batchGate: ReturnType<typeof createDeferred<void>> | null = null;
        let batchStarted: ReturnType<typeof createDeferred<void>> | null = null;
        let records: import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2[] = [];
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(accountMode === 'plain'
                ? createPlainAccountEncryptionCurrentnessFixture() : { mode: 'e2ee', version: 1, signingKeyFingerprint: 'fixture-signing',
                    contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(
                        deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey), updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: accountMode === 'plain' ? { t: 'plain', v: {} } : null, version: 1 });
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: records });
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
            if (/^\/v2\/sessions\/draft-context-/.test(path)) {
                const sessionId = path.split('/').at(-1)!;
                return denied && sessionId.endsWith('missing-a')
                    ? Response.json({ error: 'Session not found' }, { status: 404 })
                    : Response.json({ session: row(sessionId) });
            }
            const turnsMatch = /^\/v1\/sessions\/(draft-context-[^/]+)\/turns$/.exec(path);
            if (turnsMatch) return Response.json({ v: 1, sessionId: turnsMatch[1], updatedAt: 1, turns: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        // The harness answers each batch by reading its Sessions through the responder above, so a
        // Session read outside a batch is the only way a single-record route is requested.
        const answerBatchesThroughResponder = network.request;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v2/sessions/read-batch' && init?.method === 'POST') {
                const request = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init.body)));
                batches.push(request.sessionIds);
                batchStarted?.resolve();
                if (batchGate) await batchGate.promise;
                if (incomplete) return Response.json({ results: [] });
            } else if (/^\/v2\/sessions\/draft-context-/.test(url.pathname)) sessionReads.push(url.pathname);
            return answerBatchesThroughResponder(input, init);
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        await flushHookEffects({ cycles: 12, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        const cipher = createSessionDraftCipher({ accountMode, accountCryptoMaterial: accountMode === 'plain' ? null : { type: 'legacy', secret },
            getSessionContext: sessionId => accountMode === 'plain' ? { mode: 'plain' }
                : { mode: 'e2ee', encryption: authorEncryption.getSessionEncryption(sessionId) }, randomBytes: length => new Uint8Array(length) });
        const author = drafts.createSessionDraftRepository({ storage: { getString: () => undefined, getAllKeys: () => [], set: () => {}, delete: () => {} },
            scope, cipher, syncEnabled: false });
        records = await Promise.all(['retained', 'missing-a', 'missing-b'].map(async suffix => {
            const sessionId = `draft-context-${suffix}`;
            author.writeExistingSessionDraft({ scope, sessionId, patch: { text: `kept ${suffix}` } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })!;
            return { address: snapshot.address, content: await cipher.seal(snapshot.address, snapshot.document), revision: 1, createdAt: 1, updatedAt: 1 };
        }));
        const { sync } = await import('./syncEngine');
        if (accountMode === 'e2ee') {
            if (!sync.encryption) throw new Error('Expected the real Account encryption owner');
            await sync.encryption.initializeSessions(new Map([['draft-context-retained', keys.get('draft-context-retained')!]]), { serverId: scope.serverId });
        }
        storage.getState().applySessions([createSessionFixture({ id: 'draft-context-retained', serverId: scope.serverId, encryptionMode: accountMode })]);
        sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, accountMode);
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(records.map(record => drafts.getExistingSessionDraftProjection(scope, record.address.kind === 'session' ? record.address.sessionId : '')?.text))
            .toEqual(['kept retained', 'kept missing-a', 'kept missing-b']);
        expect(sessionReads).toEqual([]);
        expect(batches).toEqual([['draft-context-missing-a', 'draft-context-missing-b']]);
        expect(storage.getState().sessions['draft-context-missing-a']).toBeUndefined();

        const advanceRecords = async (text: string) => {
            records = await Promise.all(records.map(async record => {
                if (record.address.kind !== 'session') throw new Error('Expected Session draft');
                author.writeExistingSessionDraft({ scope, sessionId: record.address.sessionId, patch: { text } });
                return { ...record, revision: record.revision + 1,
                    content: await cipher.seal(record.address, author.getSessionDraftSnapshot(scope, record.address)!.document) };
            }));
        };
        const text = (suffix: string) => drafts.getExistingSessionDraftProjection(scope, `draft-context-${suffix}`)?.text;
        denied = true;
        await advanceRecords('new remote text');
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-a')).toBe('kept missing-a');
        expect(text('missing-b')).toBe('new remote text');
        denied = false;
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-a')).toBe('new remote text');

        incomplete = true;
        await advanceRecords('after failed batch');
        await expect(drafts.ensureSessionDraftRepositoryHydrated(scope)).rejects.toBeInstanceOf(SessionPartsInvalidResponseError);
        expect(text('retained')).toBe('new remote text');
        expect(text('missing-b')).toBe('new remote text');
        incomplete = false;
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-b')).toBe('after failed batch');

        // A plain Session never discloses an encrypted draft as a plain payload.
        const retainedRecord = records[0]!;
        records = [{ ...retainedRecord, revision: retainedRecord.revision + 1, content: accountMode === 'plain'
            ? { t: 'encrypted', c: 'wrong-mode' }
            : { t: 'plain', v: createSessionDraftPrivatePayloadV2(retainedRecord.address,
                author.getSessionDraftSnapshot(scope, retainedRecord.address)!.document) } }, ...records.slice(1)];
        await expect(drafts.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow('Unable to open session draft');
        expect(text('retained')).toBe('after failed batch');
        records = [retainedRecord, ...records.slice(1)];

        await advanceRecords('must stay with retired scope');
        batchGate = createDeferred<void>();
        batchStarted = createDeferred<void>();
        const retiredRead = drafts.ensureSessionDraftRepositoryHydrated(scope);
        const retiredOutcome = retiredRead.catch(() => undefined);
        await batchStarted.promise;
        await disconnectActiveServerConnection();
        batchGate.resolve();
        await retiredOutcome;
        expect(text('missing-b')).toBe('after failed batch');
        expect(sessionReads).toEqual([]);
    });

    it('retries only the drafts a census could not open on later sync passes instead of re-listing the Account', async () => {
        await disconnectActiveServerConnection();
        const accountId = 'draft-gap-plain';
        const credentials = { token: createAccountTokenForTests(accountId) };
        const home = await network.addHome('https://draft-gap-plain.example.test', accountId, { credentials, encryptionMode: 'plain' });
        type DraftRecord = import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2;
        let records: DraftRecord[] = [];
        const tombstones = new Map<string, DraftRecord>();
        let denied = true;
        const counts = { list: 0, read: 0 };
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v2/account/session-drafts/list') {
                counts.list += 1;
                return Response.json({ items: records });
            }
            if (path === '/v2/account/session-drafts/read') {
                counts.read += 1;
                const { address } = JSON.parse(String(init?.body)) as { address: { kind: string; sessionId?: string } };
                const sessionId = address.sessionId ?? '';
                const record = records.find(item => item.address.kind === 'session' && item.address.sessionId === sessionId);
                if (record) return Response.json({ status: 'present', record });
                const tombstone = tombstones.get(sessionId);
                return Response.json(tombstone ? { status: 'deleted', record: tombstone } : { status: 'absent' });
            }
            if (/^\/v2\/sessions\/draft-gap-/.test(path)) {
                const sessionId = path.split('/').at(-1)!;
                return denied && sessionId === 'draft-gap-denied'
                    ? Response.json({ error: 'Session not found' }, { status: 404 })
                    : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
            }
            const turnsMatch = /^\/v1\/sessions\/(draft-gap-[^/]+)\/turns$/.exec(path);
            if (turnsMatch) return Response.json({ v: 1, sessionId: turnsMatch[1], updatedAt: 1, turns: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        setRuntimeFetch(network.request);
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        await flushHookEffects({ cycles: 12, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }), randomBytes: length => new Uint8Array(length) });
        const author = drafts.createSessionDraftRepository({ storage: { getString: () => undefined, getAllKeys: () => [], set: () => {}, delete: () => {} },
            scope, cipher, syncEnabled: false });
        const seal = async (sessionId: string, text: string, revision: number): Promise<DraftRecord> => {
            author.writeExistingSessionDraft({ scope, sessionId, patch: { text } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })!;
            return { address: snapshot.address, content: await cipher.seal(snapshot.address, snapshot.document), revision, createdAt: 1, updatedAt: revision };
        };
        const { sync } = await import('./syncEngine');
        storage.getState().applySessions([createSessionFixture({ id: 'draft-gap-open', serverId: scope.serverId, encryptionMode: 'plain' })]);
        records = await Promise.all(['open', 'denied'].map(suffix => seal(`draft-gap-${suffix}`, `first ${suffix}`, 1)));
        const text = (suffix: string) => drafts.getExistingSessionDraftProjection(scope, `draft-gap-${suffix}`)?.text;

        // An explicit refresh is the full census; the denied Session leaves one known address gap.
        counts.list = 0;
        await sync.resumeSync('manual');
        expect(text('open')).toBe('first open');
        expect(text('denied')).toBeUndefined();
        expect(counts.list).toBe(1);

        // Later sync passes retry that one address, never the Account list.
        counts.list = 0;
        counts.read = 0;
        for (let pass = 0; pass < 3; pass += 1) await sync.resumeSync('app-foreground');
        expect(counts).toEqual({ list: 0, read: 3 });

        // A gap retry applies the current authority: an update made while the context was unavailable.
        denied = false;
        records = [records[0]!, await seal('draft-gap-denied', 'updated while denied', 2)];
        await sync.resumeSync('app-foreground');
        expect(text('denied')).toBe('updated while denied');
        expect(counts.list).toBe(0);

        // The gap closed: the next pass reads nothing.
        counts.read = 0;
        await sync.resumeSync('app-foreground');
        expect(counts).toEqual({ list: 0, read: 0 });
    });

    it('applies a delete and an update that land during a gap retry window without losing or duplicating drafts', async () => {
        await disconnectActiveServerConnection();
        const accountId = 'draft-gap-delete';
        const credentials = { token: createAccountTokenForTests(accountId) };
        const home = await network.addHome('https://draft-gap-delete.example.test', accountId, { credentials, encryptionMode: 'plain' });
        type DraftRecord = import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2;
        let records: DraftRecord[] = [];
        const tombstones = new Map<string, DraftRecord>();
        let deniedIds = new Set<string>();
        const counts = { list: 0, read: 0 };
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v2/account/session-drafts/list') {
                counts.list += 1;
                return Response.json({ items: records });
            }
            if (path === '/v2/account/session-drafts/read') {
                counts.read += 1;
                const { address } = JSON.parse(String(init?.body)) as { address: { kind: string; sessionId?: string } };
                const sessionId = address.sessionId ?? '';
                const record = records.find(item => item.address.kind === 'session' && item.address.sessionId === sessionId);
                if (record) return Response.json({ status: 'present', record });
                const tombstone = tombstones.get(sessionId);
                return Response.json(tombstone ? { status: 'deleted', record: tombstone } : { status: 'absent' });
            }
            if (/^\/v2\/sessions\/draft-del-/.test(path)) {
                const sessionId = path.split('/').at(-1)!;
                return deniedIds.has(sessionId)
                    ? Response.json({ error: 'Session not found' }, { status: 404 })
                    : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
            }
            const turnsMatch = /^\/v1\/sessions\/(draft-del-[^/]+)\/turns$/.exec(path);
            if (turnsMatch) return Response.json({ v: 1, sessionId: turnsMatch[1], updatedAt: 1, turns: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        setRuntimeFetch(network.request);
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        await flushHookEffects({ cycles: 12, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }), randomBytes: length => new Uint8Array(length) });
        const author = drafts.createSessionDraftRepository({ storage: { getString: () => undefined, getAllKeys: () => [], set: () => {}, delete: () => {} },
            scope, cipher, syncEnabled: false });
        const seal = async (sessionId: string, text: string, revision: number): Promise<DraftRecord> => {
            author.writeExistingSessionDraft({ scope, sessionId, patch: { text } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })!;
            return { address: snapshot.address, content: await cipher.seal(snapshot.address, snapshot.document), revision, createdAt: 1, updatedAt: revision };
        };
        const { sync } = await import('./syncEngine');
        const ids = ['a', 'b', 'c'].map(suffix => `draft-del-${suffix}`);
        records = await Promise.all(ids.map(id => seal(id, `first ${id}`, 1)));
        await sync.resumeSync('manual');
        const text = (id: string) => drafts.getExistingSessionDraftProjection(scope, id)?.text;
        expect(ids.map(text)).toEqual(ids.map(id => `first ${id}`));

        // a and b become unopenable after their drafts change remotely; c stays readable.
        deniedIds = new Set([ids[0]!, ids[1]!]);
        records = await Promise.all(ids.map(id => seal(id, `second ${id}`, 2)));
        await sync.resumeSync('manual');
        expect(ids.map(text)).toEqual([`first ${ids[0]}`, `first ${ids[1]}`, `second ${ids[2]}`]);

        // While the gap is open, a is deleted remotely and b is updated again.
        tombstones.set(ids[0]!, { ...records[0]!, revision: 3, content: null });
        records = [await seal(ids[1]!, `third ${ids[1]}`, 3), records[2]!];
        deniedIds = new Set();
        counts.list = 0;
        counts.read = 0;
        await sync.resumeSync('app-foreground');
        expect(text(ids[0]!)).toBeUndefined();
        expect(text(ids[1]!)).toBe(`third ${ids[1]}`);
        expect(text(ids[2]!)).toBe(`second ${ids[2]}`);
        expect(counts).toEqual({ list: 0, read: 2 });
    });

    it('decrypts unchanged Account drafts once across explicit refreshes that re-resolve an unchanged Account mode', async () => {
        await disconnectActiveServerConnection();
        const secret = new Uint8Array(32).fill(23);
        const accountId = 'draft-cipher-identity';
        const credentials = { token: createAccountTokenForTests(accountId), secret: encodeBase64(secret, 'base64url') };
        const home = await network.addHome('https://draft-cipher-identity.example.test', accountId, { credentials, encryptionMode: 'e2ee' });
        type DraftRecord = import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2;
        let records: DraftRecord[] = [];
        let lists = 0;
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1, signingKeyFingerprint: 'fixture-signing',
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(
                    deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey), updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 1 });
            if (path === '/v2/account/session-drafts/list') {
                lists += 1;
                return Response.json({ items: records });
            }
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        setRuntimeFetch(network.request);
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        await flushHookEffects({ cycles: 12, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        // A distinctive sealing nonce identifies exactly these drafts' secretbox opens at the
        // crypto library boundary, apart from any other Account decryption in a sync pass.
        const DRAFT_NONCE_BYTE = 0xa7;
        const cipher = createSessionDraftCipher({ accountMode: 'e2ee', accountCryptoMaterial: { type: 'legacy', secret },
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length).fill(DRAFT_NONCE_BYTE) });
        const author = drafts.createSessionDraftRepository({ storage: { getString: () => undefined, getAllKeys: () => [], set: () => {}, delete: () => {} },
            scope, cipher, syncEnabled: false });
        records = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
            const draftId = `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`;
            author.writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: `Identity ${index}` } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })!;
            return { address: snapshot.address, content: await cipher.seal(snapshot.address, snapshot.document), revision: 1, createdAt: index, updatedAt: index };
        }));
        const { sync } = await import('./syncEngine');
        const realOpen = tweetnacl.secretbox.open;
        let draftOpens = 0;
        const openSpy = vi.spyOn(tweetnacl.secretbox, 'open').mockImplementation((boxed, nonce, key) => {
            if (nonce.length > 0 && nonce.every(byte => byte === DRAFT_NONCE_BYTE)) draftOpens += 1;
            return realOpen(boxed, nonce, key);
        });
        try {
            lists = 0;
            await sync.resumeSync('manual');
            expect(drafts.listNewSessionDraftProjections(scope).length).toBe(20);
            expect(draftOpens).toBe(20);
            // Each explicit refresh is a full census and re-resolves the Account mode; unchanged
            // mode and key material keep the admitted documents, so nothing is decrypted again.
            for (let pass = 0; pass < 3; pass += 1) await sync.resumeSync('manual');
            expect(lists).toBe(4);
            expect(draftOpens).toBe(20);
        } finally {
            openSpy.mockRestore();
        }
    });

});


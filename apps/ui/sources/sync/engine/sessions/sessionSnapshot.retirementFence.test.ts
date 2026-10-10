import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    projectLegacySessionAccessCapabilitiesV1,
    type AccountEncryptionCurrentnessResponse,
    type V2SessionRecord,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { subscribeSessionListQueryHomeInvalidation } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { fetchAndApplySessions } from './sessionSnapshot';
import { handleDeleteSessionSocketUpdate } from './syncSessions';
import { getSessionName } from '@/utils/sessions/sessionUtils';

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

const initialState = storage.getState();

function buildSessionRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: JSON.stringify({ path: `/${id}`, host: 'test' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        encryptionMode: 'plain',
        share: null,
        effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
        },
        viewer: {
            readState: { state: 'not_started' },
            relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' },
            notification: { level: 'none', source: 'preference' },
        },
        responsibleAccountId: null,
        responsibleAccount: null,
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** One list read exactly as the production readers issue it: rows land in the real store. */
function readHomeList(serverId: string, respond: () => Promise<Response>) {
    return fetchAndApplySessions({
        serverId,
        source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
        credentials: { token: `token-${serverId}`, secret: 'secret' } as AuthCredentials,
        accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
        encryption: null,
        sessionDataKeys: new Map(),
        request: async () => await respond(),
        applySessions: () => {},
        applySessionListRenderables: (sessions) => {
            storage.getState().applyServerScopedSessionListRows(serverId, sessions, { source: 'ordinary', mode: 'replace' });
        },
        log: { log: () => {} },
    });
}

function page(ids: readonly string[]) {
    return jsonResponse({ sessions: ids.map(buildSessionRow), nextCursor: null, hasNext: false });
}

function queryPage(sessions: readonly V2SessionRecord[]) {
    return jsonResponse({ sessions, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
}

const QUERY = {
    v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
    audiences: [], tagIds: [], includeAttention: false,
} as const;

async function encryptedRow(encryption: Encryption, id: string): Promise<V2SessionRecord> {
    const key = new Uint8Array(32).fill(7);
    const cipher = await encryption.openEncryption(key);
    const [metadata] = await cipher.encrypt([{ path: `/${id}`, host: 'test' }]);
    return {
        ...buildSessionRow(id), active: false, encryptionMode: 'e2ee',
        metadata: encodeBase64(metadata!, 'base64'), agentState: null,
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64'),
    };
}

function readEncryptedQuery(input: {
    encryption: Encryption;
    request: () => Promise<Response>;
    signal?: AbortSignal;
    sessionDataKeys?: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
}) {
    return fetchAndApplySessions({
        serverId: 'home-a', source: { kind: 'query', body: QUERY, allowV1Fallback: false },
        credentials: { token: 'token-a', secret: encodeBase64(new Uint8Array(32).fill(4), 'base64') },
        encryption: input.encryption,
        signal: input.signal,
        sessionDataKeys: input.sessionDataKeys ?? new Map(),
        sessionDataKeyEnvelopes: input.sessionDataKeyEnvelopes,
        accountCurrentness: { ...PLAIN_ACCOUNT_CURRENTNESS, mode: 'e2ee' },
        request: input.request,
        // Generic background rows remain undemanded; listed reports still need readable summaries.
        sessionListBackgroundHydrationMaxRows: 0,
        applySessions: () => {},
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId['home-a']?.[id],
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches('home-a', patches),
        applySessionListRenderables: (rows) => storage.getState().applyServerScopedSessionListRows(
            'home-a', rows, { source: 'rowOnly', mode: 'replace' },
        ),
        log: { log() {} },
    });
}

describe('fetchAndApplySessions exact-Home retirement fence', () => {
    beforeEach(() => {
        storage.setState(initialState, true);
    });

    it('opens unopened report summaries from one encrypted list page without visiting a child', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const child = { ...await encryptedRow(encryption, 'child'), reportsTo: { sessionId: 'lead' } };
        const grandchild = { ...await encryptedRow(encryption, 'grandchild'), reportsTo: { sessionId: 'child' } };
        const unrelated = await encryptedRow(encryption, 'unrelated');
        const request = vi.fn(async () => queryPage([unrelated, child, grandchild]));
        await readEncryptedQuery({ encryption, request });
        await vi.waitFor(() => {
            const rows = storage.getState().sessionListRowsByServerId['home-a']!;
            expect([getSessionName(rows.child!), getSessionName(rows.grandchild!)]).toEqual(['child', 'grandchild']);
            expect(rows.unrelated?.metadata).toBeNull();
        });
        expect(storage.getState().sessions.child).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not let a list read that started before a deletion reinsert that Home\'s row', async () => {
        await readHomeList('home-a', async () => page(['same-id', 'kept']));
        await readHomeList('home-b', async () => page(['same-id']));

        let respondStale!: (response: Response) => void;
        const staleRead = readHomeList('home-a', () => new Promise<Response>((resolve) => { respondStale = resolve; }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // A committed delete/revoke of A/same-id lands while the page is in flight.
        storage.getState().deleteSession('same-id', 'home-a');
        respondStale(page(['same-id', 'kept']));
        const result = await staleRead;

        const state = storage.getState();
        expect(result.sessionIds).toEqual(['kept']);
        expect(state.sessionListRowsByServerId['home-a']?.['same-id']).toBeUndefined();
        expect(state.ordinarySessionListMembershipByServerId['home-a']).toEqual(['kept']);
        // The same id on another Home is a different Session and stays listed.
        expect(state.sessionListRowsByServerId['home-b']?.['same-id']).toBeDefined();
        expect(state.ordinarySessionListMembershipByServerId['home-b']).toEqual(['same-id']);
    });

    it('admits the row again from a read that started after the deletion (a later regrant)', async () => {
        await readHomeList('home-a', async () => page(['same-id']));
        storage.getState().deleteSession('same-id', 'home-a');

        const result = await readHomeList('home-a', async () => page(['same-id']));

        expect(result.sessionIds).toEqual(['same-id']);
        expect(storage.getState().sessionListRowsByServerId['home-a']?.['same-id']).toBeDefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId['home-a']).toEqual(['same-id']);
    });

    it('retires the Session from a mounted filtered list of that exact Home only', async () => {
        const controllerFor = (serverId: string) => createSessionListQueryHomeController({
            serverId,
            fetchPage: () => readHomeList(serverId, async () => page(['same-id', 'kept'])),
        });
        const homeA = controllerFor('home-a');
        const homeB = controllerFor('home-b');
        const query = {
            v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
            audiences: [], tagIds: [], includeAttention: false,
        } as const;
        await homeA.update({ query, selected: true, online: true, supported: true });
        await homeB.update({ query, selected: true, online: true, supported: true });
        const unsubscribe = subscribeSessionListQueryHomeInvalidation(() => new Map([['home-a', homeA], ['home-b', homeB]]));
        try {
            // The canonical local retirement owner a delete/revoke on Home A reaches.
            handleDeleteSessionSocketUpdate({
                sessionId: 'same-id',
                serverId: 'home-a',
                deleteSession: (sessionId, serverId) => storage.getState().deleteSession(sessionId, serverId),
                removeSessionEncryption: () => {},
                removeProjectManagerSession: () => {},
                clearScmStatusForSession: () => {},
                log: { log: () => {} },
            });
        } finally {
            unsubscribe();
        }

        expect(homeA.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['kept']);
        expect(homeB.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['same-id', 'kept']);
    });

    it('keeps a post-apply retirement out of final query membership and key publication', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const rows = await Promise.all(['retired', 'kept'].map((id) => encryptedRow(encryption, id)));
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        // The native worker is an OS boundary; store, query controller, DEK planning,
        // generation/currentness and initialization remain real.
        encryption.configureNativeCryptoWorker({
            worker: {
                async probe() { return { available: true, failureReason: 0, nativeVersion: 1 }; },
                async decryptDataKeyEnvelopeV1(request) {
                    started.resolve();
                    await release.promise;
                    return { status: 'ok', source: 'native', items: request.items.map(() => encodeBase64(new Uint8Array(32).fill(7), 'base64')) };
                },
                async decryptSecretboxJson() { throw new Error('Unexpected content hydration'); },
                async decryptAesGcmJson() { throw new Error('Unexpected content hydration'); },
            },
            routing: { mode: 'require', maxBatchSize: 50, minPayloadBytes: 0 },
            scope: { accountId: 'account-a', serverId: 'home-a', generation: 0 },
        });
        await readHomeList('home-b', async () => page(['retired']));
        const sessionDataKeys = new Map<string, Uint8Array>();
        const sessionDataKeyEnvelopes = new Map<string, string>();
        let result: Awaited<ReturnType<typeof fetchAndApplySessions>> | undefined;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: async ({ signal }) => {
                result = await readEncryptedQuery({ encryption, signal, sessionDataKeys, sessionDataKeyEnvelopes,
                    request: async () => queryPage(rows),
                });
                return result;
            },
        });
        const unsubscribe = subscribeSessionListQueryHomeInvalidation(() => new Map([['home-a', controller]]));
        try {
            const read = controller.update({ query: QUERY, selected: true, online: true, supported: true });
            await Promise.race([started.promise, read.then(() => { throw new Error('Query settled before DEK hydration'); })]);
            expect(storage.getState().sessionListRowsByServerId['home-a']?.retired).toBeDefined();
            handleDeleteSessionSocketUpdate({
                sessionId: 'retired', serverId: 'home-a',
                deleteSession: (id, serverId) => storage.getState().deleteSession(id, serverId),
                removeSessionEncryption: (id) => { encryption.removeSessionEncryption(id); },
                removeProjectManagerSession() {}, clearScmStatusForSession() {}, log: { log() {} },
            });
            release.resolve();
            await read;
            expect(result?.sessionIds).toEqual(['kept']);
            expect(controller.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['kept']);
            expect(storage.getState().sessionListRowsByServerId['home-a']?.retired).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId['home-b']?.retired).toBeDefined();
            expect(sessionDataKeys.has('retired')).toBe(false);
            expect(sessionDataKeyEnvelopes.has('retired')).toBe(false);
            expect(encryption.getSessionEncryption('retired')).toBeNull();
            expect(sessionDataKeys.has('kept')).toBe(true);
            expect(encryption.getSessionEncryption('kept')).not.toBeNull();
        } finally {
            release.resolve();
            unsubscribe();
            controller.dispose();
        }
    });

    it('rechecks retirement when a resolved fetch reaches the controller admission microtask', async () => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: () => {
                const read = readHomeList('home-a', async () => page(['retired-at-admission', 'kept']));
                // Register the committed event before the controller awaits this same
                // promise: fetch completion and membership admission are distinct turns.
                void read.then(() => handleDeleteSessionSocketUpdate({
                    sessionId: 'retired-at-admission', serverId: 'home-a',
                    deleteSession: (id, serverId) => storage.getState().deleteSession(id, serverId),
                    removeSessionEncryption() {}, removeProjectManagerSession() {},
                    clearScmStatusForSession() {}, log: { log() {} },
                }));
                return read;
            },
        });
        const unsubscribe = subscribeSessionListQueryHomeInvalidation(() => new Map([['home-a', controller]]));
        try {
            await controller.update({ query: QUERY, selected: true, online: true, supported: true });
            expect(controller.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['kept']);
            expect(storage.getState().sessionListRowsByServerId['home-a']?.['retired-at-admission']).toBeUndefined();
        } finally {
            unsubscribe();
            controller.dispose();
        }
    });

    it('omits only the retired Session when encryption initialization yields before commit', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        const retired = new Set<string>();
        const initializing = encryption.initializeSessions(new Map([
            ['retired-at-initialization', new Uint8Array(32).fill(7)],
            ['kept', new Uint8Array(32).fill(8)],
        ]), {
            serverId: 'home-a',
            isSessionCurrent: (id) => !retired.has(id),
        });
        // openEncryption is genuinely async; retirement wins while it is yielding.
        retired.add('retired-at-initialization');
        await initializing;
        expect(encryption.getSessionEncryption('retired-at-initialization')).toBeNull();
        expect(encryption.getSessionEncryption('kept')).not.toBeNull();
    });

    it('lets independent row-only readers of the same query share Encryption without superseding each other', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const rows = await Promise.all(['reference', 'awareness'].map((id) => encryptedRow(encryption, id)));
        const firstResponse = createDeferred<Response>();
        const first = readEncryptedQuery({ encryption, request: () => firstResponse.promise });
        const second = readEncryptedQuery({ encryption, request: async () => queryPage([rows[1]!]) });
        try {
            await second;
            firstResponse.resolve(queryPage([rows[0]!]));
            expect((await first).current).toBe(true);
            expect((await second).current).toBe(true);
            expect(storage.getState().sessionListRowsByServerId['home-a']?.reference).toBeDefined();
            expect(storage.getState().sessionListRowsByServerId['home-a']?.awareness).toBeDefined();
            expect(storage.getState().ordinarySessionListMembershipByServerId['home-a']).toBeUndefined();
        } finally {
            firstResponse.resolve(queryPage([]));
            await Promise.allSettled([first, second]);
        }
    });

    it('cancels only the caller that aborts, leaving an independent shared-Encryption reader current', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(4));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const row = await encryptedRow(encryption, 'kept');
        const response = createDeferred<Response>();
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();
        const first = readEncryptedQuery({ encryption, signal: firstAbort.signal, request: async () => (await response.promise).clone() });
        const second = readEncryptedQuery({ encryption, signal: secondAbort.signal, request: async () => (await response.promise).clone() });
        secondAbort.abort();
        response.resolve(queryPage([row]));
        expect((await first).current).toBe(true);
        expect((await second).current).toBe(false);
        expect(firstAbort.signal.aborted).toBe(false);
    });
});

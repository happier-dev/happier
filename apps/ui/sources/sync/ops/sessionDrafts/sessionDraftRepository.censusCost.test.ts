import { describe, expect, it, vi } from 'vitest';
import { canonicalSessionDraftAddressV2, createSessionDraftPrivatePayloadV2, SessionDraftListRequestV2Schema,
    SessionDraftReadRequestV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createApiSessionDraftsTransport } from '@/sync/api/account/apiSessionDrafts';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { countTransportRequests } from '@/dev/testkit';
import { createSessionDraftRepository } from './sessionDraftRepository';

const scope = { serverId: 'census-home', accountId: 'census-account' };
const memoryStorage = () => {
    const records = new Map<string, string>();
    return { getString: (key: string) => records.get(key), getAllKeys: () => [...records.keys()],
        set: (key: string, value: string) => { records.set(key, value); },
        delete: (key: string) => { records.delete(key); } };
};

describe('draft census request cost after remote cleanup', () => {
    it('resumes a cut-off census from its next page and applies nothing until the listing completes', async () => {
        // P03-RECONNECT-REST: a census cut off by a hide/outage restarted from page 1 on the next show.
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length) });
        const author = createSessionDraftRepository({ storage: memoryStorage(), cipher, syncEnabled: false });
        const seedId = '20000000-0000-4000-8000-000000000000';
        author.writeNewSessionDraft({ scope, draftId: seedId, materializationIntent: 'userEdit', patch: { text: 'listed' } });
        const document = author.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: seedId })!.document;
        const records = Array.from({ length: 250 }, (_, index) => {
            const address = { kind: 'newSession' as const, draftId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` };
            return { address, revision: 1, createdAt: 1, updatedAt: 1,
                content: { t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) } };
        });
        let cutOffNextPageTwo = true;
        const removedWhileAway = records[1]!.address;
        const http = countTransportRequests(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/read')) return Response.json({ status: 'absent' });
            if (!path.endsWith('/list')) throw new Error(`Unexpected request: ${path}`);
            const request = SessionDraftListRequestV2Schema.parse(JSON.parse(String(init?.body)));
            if (request.after && cutOffNextPageTwo) {
                cutOffNextPageTwo = false;
                throw new TypeError('Failed to fetch');
            }
            const offset = request.after ? records.findIndex(record => canonicalSessionDraftAddressV2(record.address) === request.after) + 1 : 0;
            const items = records.slice(offset, offset + (request.limit ?? records.length));
            const last = items.at(-1);
            return Response.json({ items, ...(offset + items.length < records.length && last
                ? { nextAfter: canonicalSessionDraftAddressV2(last.address) } : {}) });
        }, (path: string, init?: RequestInit) => {
            if (path.endsWith('/read')) return path;
            const request = SessionDraftListRequestV2Schema.parse(JSON.parse(String(init?.body)));
            return `${path}:${request.after ? 'after' : 'first'}`;
        });
        const repository = createSessionDraftRepository({ storage: memoryStorage(), scope, cipher,
            transport: createApiSessionDraftsTransport({ request: http.request }), syncEnabled: true });

        await expect(repository.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow();
        // A cut-off listing never advances local state past what it fully listed.
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(0);
        // A removal learned while the census is held (catch-up exact read) wins over its staged copy.
        records.splice(1, 1);
        await repository.materializeExact(scope, removedWhileAway);
        http.reset();

        await expect(repository.ensureSessionDraftRepositoryHydrated(scope)).resolves.toBe(true);
        expect(http.read()).toEqual({ '/v2/account/session-drafts/list:after': 2 });
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(249);
        expect(repository.getSessionDraftSnapshot(scope, removedWhileAway)).toBeNull();

        // A finished census is not resumed: the next one lists from the first page.
        http.reset();
        await repository.ensureSessionDraftRepositoryHydrated(scope);
        expect(http.read()).toEqual({ '/v2/account/session-drafts/list:first': 1, '/v2/account/session-drafts/list:after': 2 });
    });
    it('still reads the tombstone and retains a pending edit as an explicit conflict', async () => {
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length) });
        const address = { kind: 'newSession' as const, draftId: '10000000-0000-4000-8000-000000009999' };
        const author = createSessionDraftRepository({ storage: memoryStorage(), cipher, syncEnabled: false });
        author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'base' } });
        const document = author.getSessionDraftSnapshot(scope, address)!.document;
        const record = { address, revision: 1, createdAt: 1, updatedAt: 1,
            content: { t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) } };
        let cleaned = false;
        const http = countTransportRequests(async (path: string) => {
            if (path.endsWith('/list')) return Response.json({ items: cleaned ? [] : [record] });
            if (path.endsWith('/read')) return Response.json({ status: 'deleted', record: { ...record, revision: 2, content: null } });
            throw new Error(`Unexpected request: ${path}`);
        }, path => path);
        const repository = createSessionDraftRepository({ storage: memoryStorage(), scope, cipher,
            transport: createApiSessionDraftsTransport({ request: http.request }), syncEnabled: true });
        await repository.ensureSessionDraftRepositoryHydrated(scope);
        repository.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'keep my edit' } });
        cleaned = true;
        http.reset();

        await repository.ensureSessionDraftRepositoryHydrated(scope);

        expect(http.read()).toEqual({ '/v2/account/session-drafts/list': 1, '/v2/account/session-drafts/read': 1 });
        expect(repository.getSessionDraftSnapshot(scope, address)).toMatchObject({
            status: 'conflict',
            document: { composer: { text: { value: 'keep my edit' } } },
            conflict: { fields: [{ fieldId: 'composer.text', mine: 'keep my edit', synced: null }] },
        });
        expect(repository.isSessionDraftRemoteAcknowledged(scope, address)).toBe(false);
        expect(await repository.flushSessionDraft({ scope, address })).toEqual({ status: 'conflict' });
        expect(http.read()).toEqual({ '/v2/account/session-drafts/list': 1, '/v2/account/session-drafts/read': 1 });
    });
    it.each([false, true])('reconciles 7,232 acknowledged Account drafts without exact reads (read outage: %s)', async readOutage => {
        // QA-DRAFT-CLEANUP removed this many never-edited New Session drafts on
        // 2026-11-04. Seed retained bytes through the real document/census owners.
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length) });
        const author = createSessionDraftRepository({ storage: memoryStorage(), cipher, syncEnabled: false });
        const draftId = '10000000-0000-4000-8000-000000000000';
        author.writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: 'retained draft' } });
        const document = author.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })!.document;
        const records = Array.from({ length: 7_232 }, (_, index) => {
            const address = { kind: 'newSession' as const, draftId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` };
            return { address, revision: 1, createdAt: 1, updatedAt: 1,
                content: { t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) } };
        });
        let cleaned = false;
        const http = countTransportRequests(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/list')) {
                const request = SessionDraftListRequestV2Schema.parse(JSON.parse(String(init?.body)));
                const offset = request.after ? records.findIndex(record => canonicalSessionDraftAddressV2(record.address) === request.after) + 1 : 0;
                const items = cleaned ? [] : records.slice(offset, offset + (request.limit ?? records.length));
                const last = items.at(-1);
                return Response.json({ items, ...(!cleaned && offset + items.length < records.length && last
                    ? { nextAfter: canonicalSessionDraftAddressV2(last.address) } : {}) });
            }
            if (path.endsWith('/read')) {
                if (readOutage) throw new TypeError('Failed to fetch');
                const { address } = SessionDraftReadRequestV2Schema.parse(JSON.parse(String(init?.body)));
                return Response.json({ status: 'deleted', record: { address, revision: 2, content: null, createdAt: 1, updatedAt: 2 } });
            }
            throw new Error(`Unexpected draft mutation: ${path}`);
        }, (path: string, _init?: RequestInit) => path);
        const local = memoryStorage();
        const repository = createSessionDraftRepository({ storage: local, scope, cipher,
            transport: createApiSessionDraftsTransport({ request: http.request }), syncEnabled: true });
        await repository.ensureSessionDraftRepositoryHydrated(scope);
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(7_232);
        // A failed census must not turn incomplete inventory into deletions.
        const list = http.request;
        repository.configure({ scope, cipher, syncEnabled: true, transport: createApiSessionDraftsTransport({
            request: async (path, init) => {
                if (path.endsWith('/list')) throw new TypeError('Failed to fetch');
                return list(path, init);
            },
        }) });
        await expect(repository.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow();
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(7_232);
        repository.configure({ scope, cipher, syncEnabled: true,
            transport: createApiSessionDraftsTransport({ request: http.request }) });
        cleaned = true;
        http.reset();

        await repository.ensureSessionDraftRepositoryHydrated(scope);
        expect(http.read()).toEqual({ '/v2/account/session-drafts/list': 1 });
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(0);
        const reopened = createSessionDraftRepository({ storage: local, scope, cipher, syncEnabled: false });
        expect(reopened.listNewSessionDraftProjections(scope)).toHaveLength(0);

        http.reset();
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(http.read()).toEqual({});
        } finally { vi.useRealTimers(); }
    });
});

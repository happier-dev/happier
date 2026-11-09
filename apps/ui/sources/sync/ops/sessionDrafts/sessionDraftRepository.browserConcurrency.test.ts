import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createBrowserRecordStorageModuleMock } from '@/dev/testkit/mocks/browserRecordStorage';
import { createSessionDraftPersistenceStorage } from './sessionDraftPersistenceStorage';
import { createSessionDraftRepository, type SessionDraftRepositoryCipher } from './sessionDraftRepository';

vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const scope = { serverId: 'home', accountId: 'account' };
const cipher: SessionDraftRepositoryCipher = {
    seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
    open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
};
const records = createBrowserRecordStorageModuleMock();

async function openTab() {
    const storage = createSessionDraftPersistenceStorage({
        legacy: { getAllKeys: () => [], getString: () => undefined, delete: () => {} },
        records: {
            list: () => records.listBrowserRecords('session-drafts-repository-v1:'),
            read: records.readBrowserRecord,
            updateMany: records.updateBrowserRecords,
        },
    });
    await storage.prepare();
    const repository = createSessionDraftRepository({ storage, cipher, syncEnabled: false });
    return { repository, storage };
}

describe('Sessions sharing browser draft storage', () => {
    beforeEach(async () => { await records.clearBrowserRecords(); });

    async function storedRecords(): Promise<Map<string, string>> {
        return records.listBrowserRecords('');
    }

    /** Bytes and records that changed in the IndexedDB boundary while one keystroke autosaved. */
    async function measureKeystrokes(draftCount: number) {
        await records.clearBrowserRecords();
        const seed = await openTab();
        for (let index = 0; index < draftCount; index++) {
            seed.repository.writeExistingSessionDraft({ scope, sessionId: `held-${index}`, patch: { text: `Held draft ${index} `.repeat(20) } });
        }
        await seed.repository.flushSessionDraftLocally({ scope });
        const tab = await openTab();
        const perKey: Array<{ records: number; bytes: number }> = [];
        let text = '';
        for (const key of 'hello') {
            text += key;
            const before = await storedRecords();
            tab.repository.writeExistingSessionDraft({ scope, sessionId: 'typed', patch: { text } });
            await tab.repository.flushSessionDraftLocally({ scope });
            const after = await storedRecords();
            let changed = 0;
            let bytes = 0;
            for (const [key, value] of after) {
                if (before.get(key) === value) continue;
                changed++;
                bytes += value.length;
            }
            for (const key of before.keys()) if (!after.has(key)) changed++;
            perKey.push({ records: changed, bytes });
        }
        return perKey;
    }

    it('autosaves a keystroke as one draft record whose size does not depend on how many drafts the Account holds', async () => {
        const one = await measureKeystrokes(1);
        const many = await measureKeystrokes(500);
        // The first key creates the draft; later keys rewrite only that draft.
        expect(many.map((entry) => entry.records)).toEqual([1, 1, 1, 1, 1]);
        expect(many).toEqual(one);
    });

    it.each([false, true])('keeps two Sessions independent when hydration supplies older replica defaults: %s', async (olderReplica) => {
        const seed = await openTab();
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Main before' } });
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'other', patch: { text: 'Other before' } });
        await seed.repository.flushSessionDraftLocally({ scope });
        if (olderReplica) {
            // The existing reader accepts replicas predating these optional local fields.
            for (const [key, raw] of await records.listBrowserRecords('session-drafts-repository-v1:')) {
                const replica: Record<string, unknown> = JSON.parse(raw);
                delete replica.documentRevision;
                delete replica.deleteWhenEmpty;
                delete replica.localSupplement;
                await records.writeBrowserRecord(key, JSON.stringify(replica));
            }
        }
        const main = await openTab();
        const other = await openTab();
        // Both repositories hydrate the same Account envelope before either tab types.
        main.repository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'main' });
        other.repository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'other' });
        for (let edit = 1; edit <= 2; edit++) {
            main.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: `Main ${edit}` } });
            await main.repository.flushSessionDraftLocally({ scope });
            other.repository.writeExistingSessionDraft({ scope, sessionId: 'other', patch: { text: `Other ${edit}` } });
            await other.repository.flushSessionDraftLocally({ scope });
        }
        const reopened = (await openTab()).repository;
        expect(reopened.getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'main' })?.composer.text.value).toBe('Main 2');
        expect(reopened.getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'other' })?.composer.text.value).toBe('Other 2');
    });

    it('preserves both texts and publishes an error for a genuine concurrent edit of one Session', async () => {
        const seed = await openTab();
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Before' } });
        await seed.repository.flushSessionDraftLocally({ scope });
        const main = await openTab();
        const other = await openTab();
        const address = { kind: 'session', sessionId: 'main' } as const;
        main.repository.getSessionDraftSnapshot(scope, address);
        other.repository.getSessionDraftSnapshot(scope, address);
        other.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Other tab' } });
        await other.repository.flushSessionDraftLocally({ scope });
        main.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'My unsent text' } });
        await expect(main.repository.flushSessionDraftLocally({ scope })).rejects.toThrow();
        expect(main.repository.getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('My unsent text');
        expect(main.repository.getSessionDraftSnapshot(scope, address)?.status).toBe('error');
        const reopened = (await openTab()).repository;
        expect(reopened.getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('Other tab');
    });

    it('removes exactly the deleted draft record and restores the rest after reload', async () => {
        const tab = await openTab();
        tab.repository.writeExistingSessionDraft({ scope, sessionId: 'kept', patch: { text: 'Keep me' } });
        tab.repository.writeExistingSessionDraft({ scope, sessionId: 'removed', patch: { text: 'Delete me' } });
        await tab.repository.flushSessionDraftLocally({ scope });
        const before = await storedRecords();
        expect(await tab.repository.deleteSessionDraft({ scope, address: { kind: 'session', sessionId: 'removed' } })).toBe(true);
        const after = await storedRecords();
        expect([...before.keys()].filter((key) => !after.has(key))).toEqual([[...before.keys()].find((key) => key.endsWith('removed'))]);
        for (const [key, value] of after) expect(before.get(key)).toBe(value);
        const reopened = (await openTab()).repository;
        expect(reopened.getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'kept' })?.composer.text.value).toBe('Keep me');
        expect(reopened.getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'removed' })).toBeNull();
    });

    it('opens a 0.2 whole-scope record in two tabs at once and keeps both tabs\' edits to different drafts', async () => {
        const seed = await openTab();
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Main from 0.2' } });
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'other', patch: { text: 'Other from 0.2' } });
        await seed.repository.flushSessionDraftLocally({ scope });
        // Rebuild the 0.2 layout (one `v: 2` record holding every replica) from the stored drafts.
        const rows = await storedRecords();
        const recordKey = [...rows.keys()][0]!.split('/')[0]!;
        const replicas = Object.fromEntries([...rows].map(([key, raw]) => [key.slice(recordKey.length + 1), JSON.parse(raw)]));
        await records.clearBrowserRecords();
        await records.writeBrowserRecord(recordKey, JSON.stringify({ v: 2, ordinaryEntryDraftId: null, replicas }));

        const [main, other] = await Promise.all([openTab(), openTab()]);
        main.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Main in 0.3' } });
        await main.repository.flushSessionDraftLocally({ scope });
        other.repository.writeExistingSessionDraft({ scope, sessionId: 'other', patch: { text: 'Other in 0.3' } });
        await other.repository.flushSessionDraftLocally({ scope });
        const reopened = (await openTab()).repository;
        expect(reopened.getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'main' })?.composer.text.value).toBe('Main in 0.3');
        expect(reopened.getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'other' })?.composer.text.value).toBe('Other in 0.3');
        expect(JSON.parse((await storedRecords()).get(recordKey)!)).toEqual({ ordinaryEntryDraftId: null, v: 3 });
    });
});

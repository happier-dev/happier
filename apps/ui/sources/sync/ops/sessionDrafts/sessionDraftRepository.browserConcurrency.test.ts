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
            update: records.updateBrowserRecord,
        },
    });
    await storage.prepare();
    const repository = createSessionDraftRepository({ storage, cipher, syncEnabled: false });
    return { repository, storage };
}

describe('Sessions sharing browser draft storage', () => {
    beforeEach(async () => { await records.clearBrowserRecords(); });

    it.each([false, true])('keeps two Sessions independent when hydration supplies older replica defaults: %s', async (olderReplica) => {
        const seed = await openTab();
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'main', patch: { text: 'Main before' } });
        seed.repository.writeExistingSessionDraft({ scope, sessionId: 'other', patch: { text: 'Other before' } });
        await seed.repository.flushSessionDraftLocally({ scope });
        if (olderReplica) {
            // The existing reader accepts replicas predating these optional local fields.
            for (const [key, raw] of await records.listBrowserRecords('session-drafts-repository-v1:')) {
                const stored: { replicas: Record<string, Record<string, unknown>> } = JSON.parse(raw);
                for (const replica of Object.values(stored.replicas)) {
                    delete replica.documentRevision;
                    delete replica.deleteWhenEmpty;
                    delete replica.localSupplement;
                }
                await records.writeBrowserRecord(key, JSON.stringify(stored));
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
});

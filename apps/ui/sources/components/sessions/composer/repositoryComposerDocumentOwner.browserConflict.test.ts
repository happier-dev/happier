import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

import * as records from '@/sync/domains/state/browserRecordStorage';
import { createSessionDraftPersistenceStorage, discardSessionDraftPersistenceWrites, prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { createSessionDraftRepository, flushSessionDraftLocally, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';

const scope = { serverId: 'composer-conflict-home', accountId: 'composer-conflict-account' };
const ref = { kind: 'session', sessionId: 'conflicted-send' } as const;

afterEach(async () => {
    await discardSessionDraftPersistenceWrites();
    resetSessionDraftRepositoryForTests();
    await records.clearBrowserRecords();
});

describe('accepted composer handoff with a browser draft conflict', () => {
    it('settles accepted text without leaking the failed draft flush or discarding the other tab', async () => {
        await prepareSessionDraftPersistenceStorage();
        const owner = createRepositoryComposerDocumentOwner({ scope, ref });
        owner.replaceDocument({ text: 'shared baseline', structuredInputMentions: [], composerAttachments: [] });
        await flushSessionDraftLocally({ scope });

        const otherStorage = createSessionDraftPersistenceStorage({
            legacy: { getAllKeys: () => [], getString: () => undefined, delete: () => {} },
            records: { list: () => records.listBrowserRecords('session-drafts-repository-v1:'),
                update: records.updateBrowserRecord },
        });
        await otherStorage.prepare();
        const otherTab = createSessionDraftRepository({ storage: otherStorage, syncEnabled: false, cipher: {
            seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
            open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
        } });
        otherTab.getSessionDraftSnapshot(scope, ref);
        otherTab.writeExistingSessionDraft({ scope, sessionId: ref.sessionId, patch: { text: 'saved by the other tab' } });
        await otherTab.flushSessionDraftLocally({ scope });

        owner.replaceDocument({ text: 'the message being sent', structuredInputMentions: [], composerAttachments: [] });
        await expect(flushSessionDraftLocally({ scope })).rejects.toThrow();
        expect(owner.read().document.text).toBe('the message being sent');
        const accepted = owner.captureCurrentness();

        // Ordinary Send calls this only after the message handoff has been accepted.
        // Vitest also fails this case if its asynchronous persistence escapes unhandled.
        expect(owner.clearAccepted(accepted)).toMatchObject({ changed: true });
        expect(owner.read().document.text).toBe('');
        await vi.waitFor(() => expect(getSessionDraftSnapshot(scope, ref)?.status).toBe('error'));
        await new Promise(resolve => setTimeout(resolve, 0));
        const stored = [...(await records.listBrowserRecords('session-drafts-repository-v1:')).values()];
        expect(stored).toHaveLength(1);
        expect(stored[0]).toContain('saved by the other tab');
        expect(stored[0]).not.toContain('the message being sent');
    });
});

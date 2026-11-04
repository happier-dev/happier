import { afterEach, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { seedAndOpenNewSession } from '../newSessionSeedComposer';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { createNewSessionPromptStore } from '../hooks/screenModel/newSessionPromptStore';
import { useNewSessionComposerDocument } from '../hooks/screenModel/useNewSessionComposerDocument';
import { useNewSessionAttachmentsController } from './useNewSessionAttachmentsController';
import { resolveNewSessionDraftAttachmentFlowId } from './newSessionDraftAttachmentFlowId';
import {
    clearAcceptedNewSessionAttachmentDrafts,
    clearAllNewSessionAttachmentDrafts,
    clearNewSessionAttachmentDrafts,
    newSessionAttachmentDraftKey,
    readNewSessionAttachmentDrafts,
    subscribeNewSessionAttachmentDraftRemoval,
    writeNewSessionAttachmentDrafts,
} from './newSessionAttachmentDraftStore';
import { flushAttachmentDraftsForKey } from '@/components/sessions/attachments/attachmentDraftMemoryStore';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

afterEach(async () => {
    await standardCleanup();
    clearAllNewSessionAttachmentDrafts();
    resetSessionDraftRepositoryForTests();
});

it('recovers seeded media from the document Home and Account while another Home is active', async () => {
    const activeScope = { serverId: 'home-a', accountId: 'account-a' };
    const draftScope = { serverId: 'home-b', accountId: 'account-b' };
    const active = await activateStorageAccountScope(activeScope);
    try {
        await prepareSessionDraftPersistenceStorage();
        const draftId = '00000000-0000-4000-8000-000000000049';
        const bytes = new Uint8Array([137, 80, 78, 71]);
        expect(seedAndOpenNewSession({
            seed: {}, media: { items: [{ kind: 'image', source: {
                kind: 'memory', bytes, name: 'capture.png', mimeType: 'image/png',
            } }] }, scope: draftScope, isCurrent: () => true, createDraftId: () => draftId,
            navigateToNewSession: () => {},
        })).toMatchObject({ kind: 'opened', draftId });
        const flowId = resolveNewSessionDraftAttachmentFlowId(draftId);
        await flushAttachmentDraftsForKey(newSessionAttachmentDraftKey(flowId, draftScope));
        const draft = readNewSessionDraftFromRepository({ scope: draftScope, draftId });
        const promptStore = createNewSessionPromptStore(draft?.input ?? '');
        const mounted = await renderHook(() => {
            const composerDocument = useNewSessionComposerDocument({
                draftId, draftScope, scopeKey: 'home-b-account-b', promptStore,
                persistedAttachments: [], composerAttachmentEntriesById: {},
                canSubmitRef: { current: true }, isSubmitting: false,
            });
            return useNewSessionAttachmentsController({
                flowId, composerDocument, promptStore, isCreating: false,
                handleCreateSession: () => {}, selectedProfileId: null,
                targetServerId: 'execution-home-c',
            });
        });
        expect(mounted.getCurrent().drafts).toHaveLength(1);
        expect(mounted.getCurrent().drafts[0]?.source).toMatchObject({ kind: 'memory', bytes });
        await mounted.unmount();

        const otherAccountPrompt = createNewSessionPromptStore('');
        const isolated = await renderHook(() => {
            const composerDocument = useNewSessionComposerDocument({
                draftId, draftScope: { ...draftScope, accountId: 'account-a' },
                scopeKey: 'home-b-account-a', promptStore: otherAccountPrompt,
                persistedAttachments: [], composerAttachmentEntriesById: {},
                canSubmitRef: { current: true }, isSubmitting: false,
            });
            return useNewSessionAttachmentsController({
                flowId, composerDocument, promptStore: otherAccountPrompt, isCreating: false,
                handleCreateSession: () => {}, selectedProfileId: null,
                targetServerId: draftScope.serverId,
            });
        });
        await act(async () => { await flushAttachmentDraftsForKey(newSessionAttachmentDraftKey(flowId, { ...draftScope, accountId: 'account-a' })); });
        expect(isolated.getCurrent().drafts).toEqual([]);
        await isolated.unmount();

        const original = readNewSessionAttachmentDrafts(flowId, draftScope)[0]!;
        const successor = { ...original, id: 'successor-picture' };
        writeNewSessionAttachmentDrafts(flowId, [original, successor], draftScope);
        expect(clearAcceptedNewSessionAttachmentDrafts(flowId, [original], draftScope)).toEqual([successor]);
        expect(readNewSessionAttachmentDrafts(flowId, draftScope)).toEqual([successor]);
        const removed = vi.fn();
        const unsubscribe = subscribeNewSessionAttachmentDraftRemoval(flowId, removed, draftScope);
        try {
            clearNewSessionAttachmentDrafts(flowId, activeScope);
            expect(removed).not.toHaveBeenCalled();
            expect(readNewSessionAttachmentDrafts(flowId, draftScope)).toEqual([successor]);
            clearNewSessionAttachmentDrafts(flowId, draftScope);
            expect(removed).toHaveBeenCalledOnce();
            expect(readNewSessionAttachmentDrafts(flowId, draftScope)).toEqual([]);
            await flushAttachmentDraftsForKey(newSessionAttachmentDraftKey(flowId, draftScope));
        } finally {
            unsubscribe();
        }
    } finally {
        await standardCleanup();
        active.dispose();
    }
});

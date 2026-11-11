import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeNewSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { createNewSessionPromptStore } from './newSessionPromptStore';
import { useNewSessionComposerDocument } from './useNewSessionComposerDocument';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => {
    resetSessionDraftRepositoryForTests();
    await standardCleanup();
});

it('retains the exact durable document revision and selection when its presentation remounts', async () => {
    await prepareSessionDraftPersistenceStorage();
    const scope = { serverId: 'retained-new-home', accountId: 'retained-new-account' };
    const account = await activateStorageAccountScope(scope);
    const draftId = 'responsive-new-draft';
    const text = 'Unsent café é 👩🏽‍💻 日本語';
    writeNewSessionDraft({ scope, draftId, patch: { text }, materializationIntent: 'userEdit' });
    const promptStore = createNewSessionPromptStore(text);
    const holder: { current: ReturnType<typeof useNewSessionComposerDocument> | null } = { current: null };
    function DocumentProbe() {
        holder.current = useNewSessionComposerDocument({
            promptStore, persistedAttachments: [], composerAttachmentEntriesById: {},
            draftScope: scope, draftId, scopeKey: `${scope.serverId}/${scope.accountId}`,
            canSubmitRef: { current: true }, isSubmitting: false,
        });
        return null;
    }
    const screen = await renderScreen(<DocumentProbe key="desktop" />);
    try {
        await act(async () => { promptStore.setPrompt(`${text} edited`); });
        holder.current!.inputPersistence.onSelectionChangePersist({ start: 0, end: 2 }, promptStore.getPrompt().length);
        const before = holder.current!.readCurrentDocumentSnapshot();
        expect(before).toMatchObject({ text: `${text} edited`, selection: { start: 0, end: 2 } });
        await screen.update(<DocumentProbe key="phone" />);
        expect.soft(holder.current!.readCurrentDocumentSnapshot()).toMatchObject({
            ref: before!.ref, revision: before!.revision, text: before!.text, selection: before!.selection,
            references: before!.references, attachments: before!.attachments,
        });
        expect(holder.current!.inputPersistence).toMatchObject({ initialSelection: { start: 0, end: 2 } });
    } finally {
        await screen.unmount();
        account.dispose();
    }
});

it('clears an accepted durable New Session draft after its presentation unmounts', async () => {
    await prepareSessionDraftPersistenceStorage();
    const scope = { serverId: 'srv_new_draft', accountId: 'account-new-draft' };
    const account = await activateStorageAccountScope(scope);
    writeNewSessionDraft({
        scope,
        draftId: 'accepted-new-draft',
        patch: { text: 'Accepted before navigation' },
        materializationIntent: 'userEdit',
    });
    const promptStore = createNewSessionPromptStore('Accepted before navigation');
    const holder: { current: ReturnType<typeof useNewSessionComposerDocument> | null } = { current: null };
    function DocumentProbe() {
        holder.current = useNewSessionComposerDocument({
            promptStore, persistedAttachments: [], composerAttachmentEntriesById: {},
            draftScope: scope, draftId: 'accepted-new-draft', scopeKey: `${scope.serverId}/${scope.accountId}`,
            canSubmitRef: { current: true }, isSubmitting: false,
        });
        return null;
    }
    const screen = await renderScreen(<DocumentProbe />);
    try {
        const document = holder.current!;
        const submitted = document.captureSubmissionSnapshot();
        expect(submitted?.text).toBe('Accepted before navigation');
        expect(getSessionDraftDocumentField(
            getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: 'accepted-new-draft' })?.document ?? null,
            { kind: 'composer', field: 'text' },
        )?.value).toBe('Accepted before navigation');
        await screen.unmount();
        expect(document.isCurrent()).toBe(false);
        expect(document.clearAcceptedSnapshot(submitted!)).toBe(true);
        const stored = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: 'accepted-new-draft' });
        expect(getSessionDraftDocumentField(stored?.document ?? null, { kind: 'composer', field: 'text' })?.value ?? '').toBe('');
        expect(promptStore.getPrompt()).toBe('Accepted before navigation');
        expect(document.captureSubmissionSnapshot()).toBeNull();
    } finally {
        await screen.unmount();
        account.dispose();
    }
});

it('retains the same editable draft lifetime while hidden but rejects callbacks after unmount', async () => {
    const promptStore = createNewSessionPromptStore('Unsent retained draft');
    const holder: { current: ReturnType<typeof useNewSessionComposerDocument> | null } = { current: null };
    function DocumentProbe() {
        holder.current = useNewSessionComposerDocument({
            promptStore, persistedAttachments: [], composerAttachmentEntriesById: {},
            scopeKey: null, canSubmitRef: { current: true }, isSubmitting: false,
        });
        return null;
    }
    const frame = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden><DocumentProbe /></RetainedPanelSurface>;
    const screen = await renderScreen(frame(true));
    const document = holder.current!;
    const ref = document.ref;
    expect(document.isCurrent()).toBe(true);
    await screen.update(frame(false));
    expect(document.isCurrent()).toBe(true);
    expect(document.readCurrentDocumentSnapshot()?.text).toBe('Unsent retained draft');
    await screen.update(frame(true));
    expect(holder.current?.ref).toEqual(ref);
    expect(holder.current?.readCurrentDocumentSnapshot()?.text).toBe('Unsent retained draft');
    await screen.unmount();
    expect(document.isCurrent()).toBe(false);
    expect(document.readCurrentDocumentSnapshot()).toBeNull();
    expect(document.captureSubmissionSnapshot()).toBeNull();
});

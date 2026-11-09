import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { prepareSessionDraftPersistenceStorage, discardSessionDraftPersistenceWrites } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
const { resetSessionDraftRepositoryForTests, writeExistingSessionDraft, getSessionDraftSnapshot, listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createRepositoryComposerDocumentOwner } = await import('@/components/sessions/composer/repositoryComposerDocumentOwner');
const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { appendMountedComposerDraft } = await import('./appendMountedComposerDraft');
const { addMountedTranscriptAnnotation } = await import('./addMountedTranscriptAnnotation');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const [{ PluginProjectionV2Schema}, { PluginManifestV2Schema}] = await Promise.all([import('@happier-dev/protocol/daemon/contributionRegistryProjection'), import('@happier-dev/protocol/plugins/manifest/v2')]);
const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-app-context/manifest');
const { randomUUID } = await import('@/platform/randomUUID');
const { quoteTranscriptPassage } = await import('@/components/sessions/transcript/messageSelection/transcriptPassageActions');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { SessionAuthoringComposer } = await import('@/components/sessions/authoring/SessionAuthoringComposer');
const { createComposerTextStore, useComposerTextValue } = await import('@/components/sessions/agentInput/composerTextStore');
const { usePromptPickerController } = await import('@/components/sessions/agentInput/commandMenu/usePromptPickerController');
const { useDraft } = await import('@/hooks/session/useDraft');
const { useAskSelection } = await import('@/components/ui/code/selection/useAskSelection');
const { askAboutRanges } = await import('@/components/ui/code/selection/askAboutRanges');
const { buildAskSelectionQuote } = await import('@/components/ui/code/selection/askSelectionModel');
const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
const { askSelectionContext } = await import('@/components/ui/code/selection/askSelectionContext');

let scope: { serverId: string; accountId: string };
let unmount: (() => void) | undefined;
beforeEach(async () => {
    await home.reset();
    resetSessionDraftRepositoryForTests();
    await discardSessionDraftPersistenceWrites();
    await clearBrowserRecords();
    await prepareSessionDraftPersistenceStorage();
    const serverId = await home.addHome({ serverUrl: 'https://append.test', name: 'Append', accountId: 'account-a' });
    home.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://append.test');
    if (!credentials) throw new Error('Expected signed-in Home');
    await restoreConnectionToActiveServer(credentials);
    scope = { serverId, accountId: 'account-a' };
    getStorage().setState({ profileScope: scope, sessions: { 'source-session': createSessionFixture({ id: 'source-session', serverId }) },
        reviewCommentsDraftsByWorkspaceCacheKey: {} });
});
afterEach(async () => { unmount?.(); unmount = undefined; await disconnectActiveServerConnection(); vi.unstubAllGlobals(); });

function mountComposer(text: string, editable = true, presented: () => boolean = () => true) {
    const ref = { kind: 'session' as const, sessionId: 'source-session' };
    writeExistingSessionDraft({ scope, sessionId: ref.sessionId, patch: { text } });
    const owner = createRepositoryComposerDocumentOwner({ scope, ref });
    const focus = vi.fn(() => true);
    const definition = PluginManifestV2Schema.parse(PLUGIN_MANIFEST).contributes.composerAttachments
        ?.find(attachment => attachment.id === 'transcript-annotation');
    if (!definition) throw new Error('App context must declare the annotation contribution');
    const entry = {
        id: 'happier.app-context/transcript-annotation', pluginId: 'happier.app-context',
        identity: { pluginId: 'happier.app-context', localId: 'transcript-annotation' }, occurrenceId: 'app-context-generation',
        definition,
    };
    const catalog = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, 
        resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { composerAttachments: { family: 'composerAttachments', entriesById: { [entry.id]: entry } } },
    })).composerAttachmentsById;
    unmount = registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
        readScope: () => scope,
        isPresented: presented,
        readAttachmentComposition: () => ({ composerAttachmentsById: catalog }),
        readRevision: () => owner.read().revision,
        replace: (nextText) => owner.replaceDocument({ ...owner.read().document, text: nextText }),
        readSnapshot: () => projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: catalog }, presentation: {
            layout: 'wrap', focused: false, editable, submittable: editable, submitting: false, running: false,
        } }),
        commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
        focusComposer: focus,
    });
    return { ref, owner, focus };
}

describe('appendMountedComposerDraft', () => {
    it('adds several annotation attachments through real ingress and draft ownership, retaining text and references without sending', async () => {
        const { ref, owner, focus } = mountComposer('Keep @Session');
        const reference = { kind: 'happier.session', ref: 'session:other-session', label: 'Session',
            tokenText: '@Session', start: 5, end: 13 };
        owner.replaceDocument({ ...owner.read().document, structuredInputMentions: [reference] });
        const before = owner.read().document;
        expect(before.structuredInputMentions).toHaveLength(1);
        const source = { kind: 'session', session: { serverId: scope.serverId, sessionId: ref.sessionId }, messageId: 'committed-1' } as const;
        const first = { quote: '  exact ``` quote\n> text  ', note: 'First note', source };
        const second = { quote: 'Different passage', note: 'Second note', source };
        expect(await addMountedTranscriptAnnotation({ scope, ref, annotation: first })).toBe(true);
        expect(await addMountedTranscriptAnnotation({ scope, ref, annotation: second })).toBe(true);
        expect(owner.read().document).toMatchObject({ text: before.text, structuredInputMentions: before.structuredInputMentions, composerAttachments: [
            { value: first, presentation: { source, description: 'First note' } },
            { value: second, presentation: { source, description: 'Second note' } },
        ] });
        expect(new Set(owner.read().document.composerAttachments.map(item => item.key)).size).toBe(2);
        expect(await quoteTranscriptPassage({ quote: 'Quote from an ancestor ```\n> passage',
            source: { ...source, session: { ...source.session, sessionId: 'parent-session' } }, destination: ref,
            lifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        })).toBe(true);
        expect(owner.read().document.text).toBe(`${before.text}\n${buildAskSelectionQuote({ text: 'Quote from an ancestor ```\n> passage' })}`);
        expect(owner.read().document.composerAttachments).toHaveLength(2);
        expect(focus).toHaveBeenCalled();
        expect(home.requests.some(request => request.path.includes('/sessions') && request.input != null)).toBe(false);
    });

    it('refuses Quote and Annotate when the ordinary Session draft is no longer presented, retaining the draft', async () => {
        let presented = true;
        const { ref, owner, focus } = mountComposer('Original draft', true, () => presented);
        const annotation = { quote: 'Selected text', note: 'Keep this note', source: {
            kind: 'session' as const, session: { serverId: scope.serverId, sessionId: ref.sessionId }, messageId: 'committed-1',
        } };
        presented = false;
        expect(await appendMountedComposerDraft({ scope, ref, text: buildAskSelectionQuote({ text: annotation.quote }) })).toBe(false);
        expect(await addMountedTranscriptAnnotation({ scope, ref, annotation })).toBe(false);
        expect(owner.read().document).toMatchObject({ text: 'Original draft', composerAttachments: [] });
        expect(focus).not.toHaveBeenCalled();
    });

    it('puts file selections in the real workspace draft store, retaining context until the composer mounts', async () => {
        const workspaceScope = { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' };
        const reveal = vi.fn();
        const input = { workspaceScope, filePath: 'src/a.ts', savedText: 'first\nsecond\nlast',
            text: 'inserted\nfirst\nchanged second\nlast', ranges: [{ startLine: 2, endLine: 3, text: 'irst\nchanged sec' }],
            sessionTarget: { sessionId: 'source-session', revealSessionColumn: reveal } };
        const first = await askAboutRanges(input);
        expect(first.created).toBe(1);
        await askAboutRanges(input);
        const stored = getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(workspaceScope)];
        expect(stored).toHaveLength(1);
        expect(stored?.[0]).toMatchObject({ id: first.drafts[0]?.id, body: '', includeInPrompt: true,
            anchor: { kind: 'range', startLine: 1, endLine: 2 }, snapshot: { selectedLines: ['irst', 'changed sec'] } });
        expect(reveal).toHaveBeenCalled();
        const { focus } = mountComposer('');
        await askAboutRanges(input);
        expect(focus).toHaveBeenCalled();
    });

    it('asks about transcript code through the actual mounted composer transaction without sending', async () => {
        const { owner, focus } = mountComposer('My unsent question');
        const text = 'const code = `quoted`;';
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'transcript', getSelection: () => ({ startLine: 1, endLine: 1, text }),
            sessionTarget: { sessionId: 'source-session' },
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            openDetailsTab: () => { throw new Error('A normal Session Ask must not open a Run'); },
        }));
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        expect(owner.read().document.text).toBe(`My unsent question\n${buildAskSelectionQuote({ text })}`);
        expect(focus).toHaveBeenCalled();
        expect(home.requests.some((request) => request.path.includes('/sessions') && request.input != null)).toBe(false);
        await hook.unmount();
    });

    it('opens the canonical New Session draft when file Ask is configured to use a session', async () => {
        const workspaceScope = { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' };
        const hook = await renderHook(() => useAskSelection({ scopeId: 'project:workspace-a', workspaceScope,
            filePath: 'a.ts', source: 'file', getSelection: () => ({ startLine: 2, endLine: 2, text: 'value' }),
            getLinesText: () => 'first\nvalue', savedText: 'first\nvalue', sessionTarget: null,
            withoutSessionTarget: 'session',
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            openDetailsTab: () => { throw new Error('The Session preference must not open a Run'); },
        }));
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        const drafts = listNewSessionDraftProjections(scope);
        expect(drafts).toHaveLength(1);
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        expect(readNewSessionDraftFromRepository({ scope, draftId: drafts[0]!.draftId })).toMatchObject({
            input: buildAskSelectionQuote({ text: 'value', filePath: 'a.ts', startLine: 2, endLine: 2 }),
            selectedMachineId: 'machine-a', selectedPath: '/work',
        });
        await hook.unmount();
    });

    it('anchors mapped Markdown through the existing file draft owner and permits Comment', async () => {
        const workspaceScope = { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' };
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:source-session', workspaceScope,
            source: 'markdown', sourceLinesMapped: true, filePath: 'notes.md',
            getSelection: () => ({ startLine: 3, endLine: 3, text: 'selected code' }),
            getLinesText: () => '# Notes\n```ts\nselected code\n```', savedText: '# Notes\n```ts\nselected code\n```',
            sessionTarget: { sessionId: 'source-session' }, openDetailsTab: () => {},
        }));
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        const drafts = getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(workspaceScope)];
        expect(drafts).toMatchObject([{ filePath: 'notes.md', source: 'file', body: '', includeInPrompt: true,
            anchor: { kind: 'range', startLine: 3, endLine: 3 }, snapshot: { selectedLines: ['selected code'] } }]);
        expect(hook.getCurrent().canComment).toBe(true);
        await act(async () => { expect(await hook.getCurrent().comment()).toBe(true); });
        expect(getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(workspaceScope)])
            .toMatchObject([{ id: drafts?.[0]?.id, includeInPrompt: false }]);
        await hook.unmount();
    });

    it('keeps unmapped Markdown as an editable path-only quote without claiming rendered rows as source lines', async () => {
        const { owner } = mountComposer('Question');
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'markdown', filePath: 'notes.md', getSelection: () => ({ startLine: 40, endLine: 41, text: 'selected code' }),
            sessionTarget: { sessionId: 'source-session' },
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, openDetailsTab: () => {},
        }));
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        expect(owner.read().document.text).toBe(`Question\n${buildAskSelectionQuote({ text: 'selected code', filePath: 'notes.md' })}`);
        expect(hook.getCurrent().canComment).toBe(false);
        expect(getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey).toEqual({});
        await hook.unmount();
    });

    it('lets Problems use the same no-Session destination with its range questions', async () => {
        const navigate = vi.fn();
        const result = await askAboutRanges({
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            filePath: 'a.ts', savedText: 'first\nvalue', sessionTarget: null,
            ranges: [{ startLine: 2, endLine: 2, body: 'Explain this diagnostic' }],
            targetContext: { accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                withoutSessionTarget: 'session', navigateToNewSession: navigate,
                openDetailsTab: () => { throw new Error('The Session preference must not open a Run'); } },
        });
        expect(result.created).toBe(1);
        const drafts = listNewSessionDraftProjections(scope);
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        expect(readNewSessionDraftFromRepository({ scope, draftId: drafts[0]!.draftId })?.input).toBe(
            `${buildAskSelectionQuote({ text: 'value', filePath: 'a.ts', startLine: 2, endLine: 2 })}\n\nExplain this diagnostic`,
        );
        expect(navigate).toHaveBeenCalled();
        expect(getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey).toEqual({});
    });

    it('retains the last transcript selection when focus moves into the composer', async () => {
        const { owner } = mountComposer('Question');
        let current: import('@/components/ui/code/selection/useAskSelection').AskSelection | null = { startLine: 1, endLine: 1, text: 'remembered code' };
        let selectionChanged: (() => void) | undefined;
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'transcript', getSelection: () => current,
            subscribeSelection: (listener) => { selectionChanged = listener; return () => { selectionChanged = undefined; }; },
            sessionTarget: { sessionId: 'source-session' },
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) }, openDetailsTab: () => {},
        }));
        await act(async () => { current = null; selectionChanged?.(); });
        expect(hook.getCurrent().selection).toBeNull();
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(true); });
        expect(owner.read().document.text).toBe(`Question\n${buildAskSelectionQuote({ text: 'remembered code' })}`);
        await hook.unmount();
    });

    it('keeps the remembered source when a retained inactive editor reports a selection change', async () => {
        let inactiveSelectionChanged: (() => void) | undefined;
        const common = { scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'transcript' as const, sessionTarget: { sessionId: 'source-session' }, openDetailsTab: () => {} };
        const activeSelection = { startLine: 1, endLine: 1, text: 'active' };
        const inactiveSelection = { startLine: 1, endLine: 1, text: 'inactive' };
        const subscribeInactive = (listener: () => void) => { inactiveSelectionChanged = listener; return () => { inactiveSelectionChanged = undefined; }; };
        const hook = await renderHook(() => ({
            active: useAskSelection({ ...common, getSelection: () => activeSelection }),
            inactive: useAskSelection({ ...common, active: false,
                getSelection: () => inactiveSelection, subscribeSelection: subscribeInactive }),
        }));
        const activeSource = askSelectionContext.read(common.scopeId);
        await act(async () => { inactiveSelectionChanged?.(); });
        expect(askSelectionContext.read(common.scopeId)).toBe(activeSource);
        await hook.unmount();
    });

    it('captures a terminal selection from its existing selection-completed event', async () => {
        let current: import('@/components/ui/code/selection/useAskSelection').AskSelection | null = null;
        const hook = await renderHook(() => useAskSelection({ scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'terminal', getSelection: () => current,
            sessionTarget: { sessionId: 'source-session' }, openDetailsTab: () => {},
        }));
        await act(async () => { current = { startLine: 1, endLine: 1, text: 'terminal output' }; hook.getCurrent().remember(); });
        expect(hook.getCurrent().selection?.text).toBe('terminal output');
        await hook.unmount();
    });

    it('forgets the old selection when a retained surface switches file ownership', async () => {
        let current: import('@/components/ui/code/selection/useAskSelection').AskSelection | null = { startLine: 1, endLine: 1, text: 'old code' };
        const initialProps: { filePath?: string } = { filePath: 'old.ts' };
        const hook = await renderHook((props: { filePath?: string }) => useAskSelection({ scopeId: 'session:source-session',
            workspaceScope: { serverId: scope.serverId, machineId: 'machine-a', rootPath: '/work' },
            source: 'file', filePath: props.filePath, getSelection: () => current,
            getLinesText: () => 'new code', savedText: 'new code',
            sessionTarget: { sessionId: 'source-session' }, openDetailsTab: () => {},
        }), { initialProps });
        current = null;
        await hook.rerender({ filePath: 'new.ts' });
        await act(async () => { expect(await hook.getCurrent().ask()).toBe(false); });
        expect(getStorage().getState().reviewCommentsDraftsByWorkspaceCacheKey).toEqual({});
        await hook.rerender({});
        expect(hook.getCurrent().canComment).toBe(false);
        await hook.unmount();
    });
    it('preserves picker insertion when Make repeatable appends through the mounted draft transaction', async () => {
        const { ref, owner } = mountComposer('');
        const textStore = createComposerTextStore('');
        const inputRef = React.createRef<import('@/components/ui/forms/MultiTextInput').MultiTextInputHandle>();
        let picker!: ReturnType<typeof usePromptPickerController>;
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const session = getStorage().getState().sessions[ref.sessionId];
        function Composer(props: Readonly<{ bound: boolean }>) {
            const draft = useDraft(ref.sessionId, textStore, {
                accountLifetime: props.bound ? lifetime : null, session, active: false,
            });
            const value = useComposerTextValue(textStore);
            const stateRef = React.useRef({ text: '', selection: { start: 0, end: 0 } });
            picker = usePromptPickerController({
                composerKey: ref.sessionId, editable: true, canSend: true, inputRef, stateRef, send: () => {},
            });
            return React.createElement(SessionAuthoringComposer, {
                ref: inputRef, composerRef: ref, value, onChangeText: draft.setDraftValue,
                onStateChange: (state) => { stateRef.current = state; },
            });
        }
        const screen = await renderScreen(React.createElement(Composer, { bound: false }));
        try {
            // The composer remains mounted while its exact Account draft binding becomes available.
            await screen.update(React.createElement(Composer, { bound: true }));
            await act(async () => { expect(picker.open()).toBe(true); });
            await act(async () => {
                expect(await picker.apply(async () => ({ text: 'Picker inserted request' }), 'insert')).toBe(true);
            });
            expect(inputRef.current?.getText()).toBe('Picker inserted request');
            await act(async () => {
                expect(await appendMountedComposerDraft({ scope, ref, text: 'Assistant workflow seed' })).toBe(true);
            });
            const expected = 'Picker inserted request\nAssistant workflow seed';
            expect(owner.read().document.text).toBe(expected);
            expect(textStore.getPrompt()).toBe(expected);
            expect(inputRef.current?.getText()).toBe(expected);
        } finally {
            await screen.unmount();
        }
    });

    it('preserves unsent text, appends again from the current revision, and focuses without sending', async () => {
        const { ref, owner, focus } = mountComposer('Keep my unsent text');
        expect(await appendMountedComposerDraft({ scope, ref, text: 'First request' })).toBe(true);
        expect(owner.read().document.text).toBe('Keep my unsent text\nFirst request');
        owner.replaceDocument({ ...owner.read().document, text: `${owner.read().document.text}\nEdited meanwhile` });
        expect(await appendMountedComposerDraft({ scope, ref, text: 'Second request' })).toBe(true);
        const expected = 'Keep my unsent text\nFirst request\nEdited meanwhile\nSecond request';
        expect(owner.read().document.text).toBe(expected);
        expect(getSessionDraftSnapshot(scope, ref)?.document).toMatchObject({ composer: { text: { value: expected } } });
        expect(focus).toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toHaveLength(0);
        expect(Object.keys(getStorage().getState().sessions)).toEqual(['source-session']);
        expect(home.requests.some((request) => request.path.includes('/sessions') && request.input != null)).toBe(false);
    });

    it.each(['revision', 'home', 'readOnly'] as const)('preserves current text and focus when the %s changes before ingress applies', async (condition) => {
        const { ref, owner, focus } = mountComposer('Keep me', condition !== 'readOnly');
        const pending = appendMountedComposerDraft({ scope, ref, text: 'Must not overwrite' });
        const pendingAnnotation = addMountedTranscriptAnnotation({ scope, ref, annotation: {
            quote: 'Selected passage', note: 'Keep this note', source: {
                kind: 'session', session: { serverId: scope.serverId, sessionId: ref.sessionId }, messageId: 'committed-1',
            },
        } });
        if (condition === 'revision') owner.replaceDocument({ ...owner.read().document, text: 'Keep me\nTyped meanwhile' });
        if (condition === 'home') getStorage().setState({ profileScope: { ...scope, accountId: 'other-account' } });
        expect(await pending).toBe(false);
        expect(await pendingAnnotation).toBe(false);
        expect(owner.read().document.text).toBe(condition === 'revision' ? 'Keep me\nTyped meanwhile' : 'Keep me');
        expect(owner.read().document.composerAttachments).toEqual([]);
        expect(focus).not.toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toHaveLength(0);
        expect(home.requests.some((request) => request.path.includes('/sessions') && request.input != null)).toBe(false);
    });
});

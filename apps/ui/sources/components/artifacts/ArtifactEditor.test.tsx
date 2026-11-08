import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { Modal } from '@/modal';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { runGuardedNavigation, runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';
import type { TextEditorHandle, CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { getStorage } = await import('@/sync/domains/state/storage');

const navigation = vi.hoisted(() => ({ canGoBack: true, back: vi.fn(), replace: vi.fn(), push: vi.fn(),
    pathname: '/', params: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ pathname: () => navigation.pathname, params: () => navigation.params,
        router: { canGoBack: () => navigation.canGoBack,
        back: navigation.back, replace: navigation.replace, push: navigation.push } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    // These save intents accept canonical Action confirmation; navigation discard choices below stay explicit.
    return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
// The platform editor surface (Monaco on web, a CodeMirror WebView on native) is the boundary: a host node
// with the same value/onChange contract, so the editor's own draft, save and refusal logic stays real.
const editorBoundary = vi.hoisted(() => ({ pendingValue: null as string | null, rejectFlush: false }));
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
    const React = await import('react');
    return {
        CodeEditor: React.forwardRef<TextEditorHandle, CodeEditorProps>((props, ref) => {
            const value = React.useRef(props.value);
            const seed = React.useRef({ value: props.value, resetKey: props.resetKey });
            if (seed.current.value !== props.value || seed.current.resetKey !== props.resetKey) {
                value.current = props.value;
                seed.current = { value: props.value, resetKey: props.resetKey };
            }
            const latestProps = React.useRef(props);
            latestProps.current = props;
            // Real platform engines retain their handle across ordinary renders.
            React.useImperativeHandle(ref, () => ({
                getValue: () => editorBoundary.pendingValue ?? value.current,
                flushPendingChange: async () => {
                    if (editorBoundary.rejectFlush) throw new Error('snapshot_unconfirmed');
                    if (editorBoundary.pendingValue === null) return;
                    value.current = editorBoundary.pendingValue;
                    editorBoundary.pendingValue = null;
                    latestProps.current.onChange(value.current);
                },
            }), []);
            return React.createElement('CodeEditor', { testID: props.testID, value: props.value, onChangeText: (next: string) => {
                value.current = next;
                props.onChange(next);
            } });
        }),
    };
});

// The editor's Markdown field reaches the sync client at import: load it after a test installs its boundaries.
async function loadArtifactEditor() {
    return (await import('./ArtifactEditor')).ArtifactEditor;
}

describe('ArtifactEditor', () => {
    const initialState = getStorage().getState();
    let disposeHome: Awaited<ReturnType<typeof installRealActionExecutorModuleLoader>> | undefined;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    afterEach(async () => {
        await connection?.dispose();
        connection = undefined;
        await disposeHome?.();
        disposeHome = undefined;
        await act(async () => { getStorage().setState(initialState, true); });
        vi.restoreAllMocks();
    });
    async function restoreEditorHome(serverUrl: string) {
        installHomeGovernanceBoundaries(homes);
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Editor', serverUrl, accountId: 'owner', currentAccount: true });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        await loadSyncSingletonForTests();
        disposeHome = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl, accountId: 'owner', request: homes.request,
            credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) } });
        installHomeGovernanceBoundaries(homes);
        return serverId;
    }
    beforeEach(() => {
        navigation.pathname = '/';
        navigation.params = {};
        navigation.canGoBack = true;
        navigation.back.mockClear();
        navigation.replace.mockClear();
        navigation.push.mockClear();
        vi.mocked(Modal.alert).mockClear();
        editorBoundary.pendingValue = null;
        editorBoundary.rejectFlush = false;
    });

    it('invites writing in an empty Doc and removes the hint as the real body changes', async () => {
        await restoreEditorHome('https://artifact-editor-placeholder.test');
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        const placeholderId = 'artifact-editor:body:placeholder';
        expect(screen.findByTestId(placeholderId)?.props.accessibilityLabel).toBe('artifacts.bodyLabel');
        expect(screen.getTextContent()).toContain('artifacts.bodyPlaceholder');
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('');
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'My document'); });
        expect(screen.getTextContent()).not.toContain('artifacts.bodyPlaceholder');
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('My document');
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', ''); });
        expect(screen.getTextContent()).toContain('artifacts.bodyPlaceholder');
        await screen.unmount();
    });

    it('publishes a settled unavailable Session title through real route hydration and workspace wiring', async () => {
        await restoreEditorHome('https://missing-destination-title.test');
        // The canonical hydration owner settles an unknown qualified Home as missing.
        // It cannot be confused with an uncached Session on a known Home.
        const serverId = 'unknown-home';
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { useDestinationInstanceTitles, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
        getStorage().setState({ isDataReady: true,
            settings: { ...getStorage().getState().settings, mobileWorkspaceExperienceV1: 'classic' } });
        navigation.pathname = '/session/missing';
        navigation.params = { id: 'missing', serverId };
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        function Titles(props: Readonly<{ tabId: string; ref: import('@/components/appShell/destinations/compactAppDestinationCatalog').DestinationRef }>) {
            const entries = React.useMemo(() => [{ key: props.tabId, ref: props.ref }], [props.tabId, props.ref]);
            return React.createElement('MissingSessionTitle', { title: useDestinationInstanceTitles(catalog, entries).get(props.tabId) });
        }
        function HydratedRoute() {
            const state = useHydrateSessionForRoute('missing', 'MissingSessionTitle.test', { serverId, hydrateMessages: false });
            return React.createElement('MissingSessionRoute', { state });
        }
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={connection?.credentials ?? null}><WorkspaceProvider enabled catalog={catalog}>{workspace => {
                const tab = workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
                return <>
                    <Titles tabId={tab.id} ref={tab.target} />
                    <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/session/missing" focused visible
                        navigation={workspace.navigationForTab(tab.id)}><HydratedRoute /></DestinationInstanceHost>
                </>;
            }}</WorkspaceProvider></InjectedAuthProvider>
        );
        await vi.waitFor(() => expect(screen.root.findByType('MissingSessionRoute').props.state).toMatchObject({ kind: 'missing', sessionId: 'missing' }));
        expect(screen.root.findByType('MissingSessionTitle').props.title).toBe('errors.sessionDeleted');
        await screen.unmount();
    });

    it('guards the mounted artifact tab and navigation, preserving a cancelled or refused draft and saving before departure', async () => {
        const serverId = await restoreEditorHome('https://artifact-editor-guard.test');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const ArtifactEditor = await loadArtifactEditor();
        const tabId = 'artifact-draft';
        const screen = await renderScreen(<DestinationInstanceHost tabId={tabId}
            ref={{ kind: 'artifacts', params: { workspacePathname: '/artifacts/new' } }} pathname="/artifacts/new" focused visible
            navigation={{ back: navigation.back, replace: navigation.replace, push: navigation.push,
                canGoBack: () => navigation.canGoBack, pushRetainingCurrent: navigation.push }}>
            <ArtifactEditor artifact={null} mode="new" />
        </DestinationInstanceHost>);
        const departed = vi.fn();
        const leave = vi.fn(() => { runGuardedNavigation(departed); });
        // A debounced platform keystroke has not reached the React draft yet.
        editorBoundary.pendingValue = 'Unsaved document';
        const choose = async (choice: 'common.keepEditing' | 'common.save' | 'common.discard') => {
            await vi.waitFor(() => expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]).toBeDefined());
            const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
            expect(buttons?.map(button => button.text)).toEqual(['common.discard', 'common.save', 'common.keepEditing']);
            await act(async () => { await buttons?.find(button => button.text === choice)?.onPress?.(); });
        };
        let pending = runGuardedTabNavigation([tabId], leave);
        await choose('common.keepEditing');
        expect(await pending).toBe(false);
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('Unsaved document');
        vi.mocked(Modal.alert).mockClear();
        homes.answer(serverId, 'POST /v1/artifacts', { status: 413,
            body: { error: 'quota_exceeded', budget: 'document', limitBytes: 1, usedBytes: 10 } });
        pending = runGuardedTabNavigation([tabId], leave);
        await choose('common.save');
        await act(async () => { expect(await pending).toBe(false); });
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact-editor:quota')).not.toBeNull();
        vi.mocked(Modal.alert).mockClear();
        pending = runGuardedNavigation(leave);
        await choose('common.discard');
        await act(async () => { expect(await pending).toBe(true); });
        expect(leave).toHaveBeenCalledOnce();
        expect(departed).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('saves a guarded new artifact once and lets the save owner replace its destination', async () => {
        const serverId = await restoreEditorHome('https://artifact-editor-guard-save.test');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<DestinationInstanceHost tabId="artifact-draft"
            ref={{ kind: 'artifacts', params: { workspacePathname: '/artifacts/new' } }} pathname="/artifacts/new" focused visible
            navigation={{ back: navigation.back, replace: navigation.replace, push: navigation.push,
                canGoBack: () => navigation.canGoBack, pushRetainingCurrent: navigation.push }}>
            <ArtifactEditor artifact={null} mode="new" />
        </DestinationInstanceHost>);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'Saved document'); });
        const close = vi.fn();
        const pending = runGuardedTabNavigation(['artifact-draft'], close);
        await vi.waitFor(() => expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]).toBeDefined());
        await act(async () => {
            await vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === 'common.save')?.onPress?.();
            expect(await pending).toBe(true);
        });
        const stored = homes.artifacts(serverId).list();
        expect(stored).toHaveLength(1);
        expect(homes.artifacts(serverId).readPlainBody(stored[0]!.id)).toBe('Saved document');
        expect(navigation.replace).toHaveBeenCalledWith(`/artifacts/${stored[0]!.id}`);
        expect(close).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('protects both retained hosted editors after a cancelled bulk discard, including subsequent edits and unload', async () => {
        await restoreEditorHome('https://artifact-editor-cancelled-batch.test');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const ArtifactEditor = await loadArtifactEditor();
        type UnloadEvent = { preventDefault: () => void; returnValue?: string };
        type UnloadHandler = (event: UnloadEvent) => void;
        const unloadHandlers = new Set<UnloadHandler>();
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', { configurable: true, value: {
            addEventListener: (type: string, handler: UnloadHandler) => { if (type === 'beforeunload') unloadHandlers.add(handler); },
            removeEventListener: (type: string, handler: UnloadHandler) => { if (type === 'beforeunload') unloadHandlers.delete(handler); },
        } });
        const host = (tabId: string, focused: boolean) => <DestinationInstanceHost tabId={tabId}
            ref={{ kind: 'artifacts', params: { workspacePathname: '/artifacts/new' } }} pathname="/artifacts/new" focused={focused} visible
            navigation={{ back: navigation.back, replace: navigation.replace, push: navigation.push,
                canGoBack: () => navigation.canGoBack, pushRetainingCurrent: navigation.push }}>
            <ArtifactEditor artifact={null} mode="new" />
        </DestinationInstanceHost>;
        const screens: Awaited<ReturnType<typeof renderScreen>>[] = [];
        try {
            const first = await renderScreen(host('first-artifact', true));
            const second = await renderScreen(host('second-artifact', false));
            screens.push(first, second);
            await act(async () => {
                first.changeTextByTestId('artifact-editor:body:source', 'First draft');
                second.changeTextByTestId('artifact-editor:body:source', 'Second draft');
            });
            const choose = async (choice: 'common.keepEditing' | 'common.discard') => {
                await vi.waitFor(() => expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]).toBeDefined());
                const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
                vi.mocked(Modal.alert).mockClear();
                await act(async () => { await buttons?.find(button => button.text === choice)?.onPress?.(); });
            };
            const closeAll = vi.fn();
            const batch = runGuardedTabNavigation(['first-artifact', 'second-artifact'], closeAll);
            await choose('common.discard');
            await choose('common.keepEditing');
            expect(await batch).toBe(false);
            expect(closeAll).not.toHaveBeenCalled();
            expect(first.findByTestId('artifact-editor:body:source')?.props.value).toBe('First draft');
            expect(second.findByTestId('artifact-editor:body:source')?.props.value).toBe('Second draft');
            await act(async () => { first.changeTextByTestId('artifact-editor:body:source', 'First draft continued'); });
            const closeFirst = vi.fn();
            const nextClose = runGuardedTabNavigation(['first-artifact'], closeFirst);
            await choose('common.keepEditing');
            expect(await nextClose).toBe(false);
            expect(closeFirst).not.toHaveBeenCalled();
            expect(first.findByTestId('artifact-editor:body:source')?.props.value).toBe('First draft continued');
            const unloads = [...unloadHandlers].map(handler => {
                const event: UnloadEvent = { preventDefault: vi.fn() };
                handler(event);
                return event;
            });
            expect(unloads).toHaveLength(2);
            for (const event of unloads) {
                expect(event.preventDefault).toHaveBeenCalledOnce();
                expect(event.returnValue).toBe('');
            }
        } finally {
            for (const screen of screens) await screen.unmount();
            if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            else Reflect.deleteProperty(globalThis, 'window');
        }
    });

    it('saves against the opening full revision after another writer advances the head, retaining the refused draft', async () => {
        const opening: DecryptedArtifact = { id: 'document', title: 'Opening', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'Opening' }, rawHeader: { kind: 'artifact.legacy', title: 'Opening' },
            body: 'Opening body', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const current = { ...opening, title: 'Concurrent', body: 'Concurrent body', headerVersion: 2, bodyVersion: 2,
            header: { kind: 'artifact.legacy', title: 'Concurrent' }, rawHeader: { kind: 'artifact.legacy', title: 'Concurrent' } };
        const serverId = await restoreEditorHome('https://artifact-editor-cas.test');
        const { sync } = await import('@/sync/sync');
        const id = await sync.createArtifactWithHeader(opening.rawHeader!, opening.body ?? '');
        opening.id = id;
        current.id = id;
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={opening} mode="edit" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'My draft'); });
        await act(async () => { await sync.updateArtifactWithHeader(id, current.rawHeader, current.body,
            { expectedRevision: { headerVersion: 1, bodyVersion: 1 } }); });
        await screen.update(<ArtifactEditor artifact={current} mode="edit" />);
        const { MarkdownCodeEditorField } = await import('@/components/ui/markdown/editor/MarkdownCodeEditorField');
        expect(screen.findByType(MarkdownCodeEditorField).props.editorRef.current.getValue()).toBe('My draft');
        await screen.pressByTestIdAsync('artifact-editor:save');
        // The host press starts the shared asynchronous action lifecycle; wait
        // for its refusal before inspecting the retained draft and CAS request.
        await vi.waitFor(() => expect(screen.findByTestId('artifact-editor:conflict')).not.toBeNull());
        const writes = homes.requestsFor(`/v1/artifacts/${id}`).filter(request => request.input !== null);
        expect(writes.at(-1)?.input).toMatchObject({ expectedHeaderVersion: 1, expectedBodyVersion: 1 });
        expect(homes.artifacts(serverId).readPlainBody(id)).toBe('Concurrent body');
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('My draft');
        expect(screen.findByTestId('artifact-editor:title')?.props.value).toBe('Opening');
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it.each(['new', 'edit'] as const)('routes a policy-required %s save to its approval without discarding the draft', async mode => {
        await loadSyncSingletonForTests();
        const artifact: DecryptedArtifact = { id: 'approval-document', title: 'Opening', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'Opening' }, rawHeader: { kind: 'artifact.legacy', title: 'Opening' },
            body: 'Opening body', headerVersion: 3, bodyVersion: 7, seq: 1, createdAt: 1, updatedAt: 1,
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const serverId = await restoreEditorHome('https://artifact-editor-approval.test');
        const persisted = homes.artifacts(serverId);
        const { sync } = await import('@/sync/sync');
        if (mode === 'edit') artifact.id = await sync.createArtifactWithHeader(artifact.rawHeader!, artifact.body ?? '');
        await homes.requireUiApproval(serverId, mode === 'new' ? 'artifact.create' : 'artifact.update');
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={mode === 'edit' ? artifact : null} mode={mode} />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'Approval draft'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        const approval = persisted.list().find(row => row.id !== artifact.id);
        expect(approval).toBeDefined();
        const request = ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!));
        expect(request).toMatchObject({ actionId: mode === 'new' ? 'artifact.create' : 'artifact.update',
            actionArgs: { body: 'Approval draft', ...(mode === 'edit' ? { expectedRevision: { headerVersion: 3, bodyVersion: 7 } } : {}) } });
        expect(navigation.push).toHaveBeenCalledWith(`/inbox/approvals/${approval!.id}?serverId=${encodeURIComponent(serverId)}`);
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('Approval draft');
        expect(homes.requestsFor(`/v1/artifacts/${artifact.id}`).filter(request => request.input !== null)).toEqual([]);
        await screen.unmount();
    });

    it('returns to the collection when responsive navigation loses its back stack', async () => {
        await loadSyncSingletonForTests();
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        navigation.canGoBack = false;
        await screen.pressByTestIdAsync('artifact-editor:cancel');
        expect(navigation.replace).toHaveBeenCalledWith('/artifacts');
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('creates and updates a Markdown document through the real admitted Action and acknowledged store publication', async () => {
        const serverId = await restoreEditorHome('https://artifact-editor-success.test');
        const persisted = homes.artifacts(serverId);
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'First body'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        const stored = persisted.list()[0];
        expect(stored).toBeDefined();
        expect(navigation.replace).toHaveBeenCalledWith(`/artifacts/${stored!.id}`);
        expect(persisted.readPlainBody(stored!.id)).toBe('First body');
        await screen.unmount();
        // The edit route opens the full HTTP body/authority tuple, not its create-list header.
        const { sync } = await import('@/sync/sync');
        await sync.fetchArtifactWithBody(stored!.id);
        const artifact = getStorage().getState().artifacts[stored!.id]!;
        const editor = await renderScreen(<ArtifactEditor artifact={artifact} mode="edit" />);
        await act(async () => { editor.changeTextByTestId('artifact-editor:body:source', 'Second body'); });
        const { MarkdownCodeEditorField } = await import('@/components/ui/markdown/editor/MarkdownCodeEditorField');
        expect(editor.findByType(MarkdownCodeEditorField).props.editorRef.current.getValue()).toBe('Second body');
        await editor.pressByTestIdAsync('artifact-editor:save');
        await vi.waitFor(() => {
            expect(persisted.readPlainBody(stored!.id)).toBe('Second body');
            expect(getStorage().getState().artifacts[stored!.id]).toMatchObject({ body: 'Second body', headerVersion: 2, bodyVersion: 2 });
            expect(navigation.back).toHaveBeenCalledOnce();
        });
        await editor.unmount();
    });

    it('refuses an unconfirmed editor flush without writing or navigating and lets the retained draft retry', async () => {
        const serverId = await restoreEditorHome('https://artifact-editor-unconfirmed.test');
        const persisted = homes.artifacts(serverId);
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'Draft'); });
        editorBoundary.pendingValue = 'Draft with final native keystroke';
        editorBoundary.rejectFlush = true;
        await expect(screen.pressByTestIdAsync('artifact-editor:save')).resolves.toBeUndefined();
        expect(persisted.list()).toHaveLength(0);
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'artifacts.createError');
        expect(editorBoundary.pendingValue).toBe('Draft with final native keystroke');
        editorBoundary.rejectFlush = false;
        await screen.pressByTestIdAsync('artifact-editor:save');
        expect(persisted.readPlainBody(persisted.list()[0]!.id)).toBe('Draft with final native keystroke');
        await screen.unmount();
    });

    it('keeps the draft and reports the named budget when the create Action refuses quota', async () => {
        const serverId = await restoreEditorHome('https://artifact-editor-quota.test');
        homes.answer(serverId, 'POST /v1/artifacts', { status: 413,
            body: { error: 'quota_exceeded', budget: 'document', limitBytes: 1, usedBytes: 10 } });
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'My document'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        expect(screen.findByTestId('artifact-editor:quota')).not.toBeNull();
        expect(screen.getTextContent()).toContain('artifacts.browser.quota.documentTitle');
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('My document');
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('opens a distinct draft when a hydrated document route changes identity', async () => {
        await restoreEditorHome('https://artifact-editor-route-reset.test');
        const { EditArtifactContent } = await import('@/app/(app)/artifacts/edit/[id]');
        const first: DecryptedArtifact = { id: 'first', title: 'First', body: 'First body',
            header: { title: 'First' }, rawHeader: { title: 'First' }, headerVersion: 1, bodyVersion: 1,
            isDecrypted: true, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const second = { ...first, id: 'second', title: 'Second', body: 'Second body',
            header: { title: 'Second' }, rawHeader: { title: 'Second' }, headerVersion: 4, bodyVersion: 6 };
        const screen = await renderScreen(<EditArtifactContent id={first.id} artifact={first} />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body:source', 'First draft'); });
        await screen.update(<EditArtifactContent id={second.id} artifact={second} />);
        expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('Second body');
        expect(screen.findByTestId('artifact-editor:title')?.props.value).toBe('Second');
        await screen.unmount();
    });

    it('does not expose a text Save that can erase a binary file opened through a direct edit route', async () => {
        await restoreEditorHome('https://artifact-editor-binary.test');
        const artifact: DecryptedArtifact = { id: 'binary', title: 'archive.zip', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'archive.zip' }, rawHeader: { kind: 'artifact.legacy', title: 'archive.zip' },
            body: { blobId: 'a668646c-dc5f-464d-9e49-285c03698cc9', mime: 'application/zip', sizeBytes: 0, sha256: '0'.repeat(64) },
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const ArtifactEditor = await loadArtifactEditor();
        const screen = await renderScreen(<ArtifactEditor artifact={artifact} mode="edit" />);
        expect(screen.findByTestId('artifact-editor:save')).toBeNull();
        expect(screen.findByTestId('artifact:download')).not.toBeNull();
        const leave = vi.fn();
        expect(runGuardedNavigation(leave)).toBe(true);
        expect(leave).toHaveBeenCalledOnce();
    });
});

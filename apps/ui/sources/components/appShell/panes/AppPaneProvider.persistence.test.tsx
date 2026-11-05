import 'fake-indexeddb/auto';
import * as React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';

beforeEach(async () => {
    serverId = await homes.addHome({ name: 'Find Home', serverUrl: 'https://file-find-home.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://file-find-home.test', accountId: 'account-a', request: homes.request });
    getStorage().setState({ profileScope: { serverId, accountId: 'account-a' } });
    (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), getStorage().getState().applyLocalSettings({ }));
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    getStorage().setState(initialState, true);
});

function PaneScopeProbe(props: Readonly<{ triggerOpenDetails?: boolean }>) {
    const pane = useAppPaneScope('project:wr_1');
    const hasTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        if (!props.triggerOpenDetails) return;
        if (hasTriggeredRef.current) return;
        hasTriggeredRef.current = true;
        pane.openDetailsTab(
            {
                key: 'file:/repo/src/a.ts',
                kind: 'file',
                title: 'a.ts',
                resource: { kind: 'file', path: '/repo/src/a.ts' },
            },
            { intent: 'pinned' },
        );
        pane.setDetailsTabState('file:/repo/src/a.ts', { draft: 'draft text' });
    }, [pane, props.triggerOpenDetails]);

    return React.createElement('PaneScopeProbe', {
        scopeState: pane.scopeState,
    });
}

describe('AppPaneProvider persistence', () => {
    it('persists an admitted recipient selection and its rollback without overwriting source siblings', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { selectedPaneDestinationTabKey, selectedPaneDestinationResourceId } = await import('./model/selectedPaneDestination');
        const { listPaneWindowTabs, resolvePaneTabWindowTarget } = await import('./paneTabWindowTransfer');
        const scopeId = 'session:placed-selection';
        const tabKey = selectedPaneDestinationTabKey('right');
        const sourceWrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const source = await renderHook(useAppPaneContext, { wrapper: sourceWrapper });
        await act(async () => {
            source.getCurrent().dispatch({ type: 'openRight', scopeId, tabId: 'files' });
            source.getCurrent().dispatch({ type: 'setSelectedPanePresentation', scopeId, tabKey, presentation: { windowId: 'placed' } });
        });
        const original = source.getCurrent().getReadState().scopes[scopeId].right;
        const recipientWrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider presentedPaneTab={{ scopeId, tabKey }}>{children}</AppPaneProvider>;
        const recipient = await renderHook(useAppPaneContext, { wrapper: recipientWrapper });
        await act(async () => source.getCurrent().dispatch({ type: 'setBottomTabState', scopeId, tabId: 'sibling', nextState: { text: 'new source state' } }));
        await act(async () => recipient.getCurrent().dispatch({ type: 'selectRightDestination', scopeId, destination: { kind: 'builtin', id: 'git' } }));
        expect(paneUiState.read(scopeId)?.right.selectedDestination).toEqual({ kind: 'builtin', id: 'git' });
        const address = { kind: 'paneTab' as const, serverId: 'home-a', accountId: 'account-a', layoutId: 'layout-a', scopeId, tabKey };
        expect(resolvePaneTabWindowTarget(source.getCurrent(), address)?.resourceId).toBe(selectedPaneDestinationResourceId({ kind: 'builtin', id: 'git' }));
        expect(listPaneWindowTabs(source.getCurrent(), { ...address, scopeIds: [scopeId] }).find(tab => tab.tabKey === tabKey)?.title).toBe('git');
        await act(async () => source.getCurrent().dispatch({ type: 'setBottomTabState', scopeId, tabId: 'sibling', nextState: { text: 'newer source state' } }));
        expect(paneUiState.read(scopeId)?.right.selectedDestination).toEqual({ kind: 'builtin', id: 'git' });
        const remounted = await renderHook(useAppPaneContext, { wrapper: recipientWrapper });
        expect(remounted.getCurrent().getReadState().scopes[scopeId].right.selectedDestination).toEqual({ kind: 'builtin', id: 'git' });
        await remounted.unmount();
        await act(async () => {
            const current = recipient.getCurrent().getReadState().scopes[scopeId];
            recipient.getCurrent().dispatch({ type: 'restoreScope', scopeId, selectedPaneTabKey: tabKey, scope: { ...current,
                right: { ...current.right, activeTabId: original.activeTabId, selectedDestination: original.selectedDestination } } });
        });
        expect(paneUiState.read(scopeId)?.right.selectedDestination).toEqual(original.selectedDestination);
        expect(paneUiState.read(scopeId)?.bottom.tabState.sibling).toEqual({ text: 'newer source state' });
        await recipient.unmount();
        await source.unmount();
    });
    it('returns the recipient draft while preserving a source sibling edit and terminal identity', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { setPaneTabWindowPresentation } = await import('./paneTabWindowTransfer');
        const scopeId = 'project:wr_1';
        const tabKey = 'file:/repo/moved.ts';
        const sibling = 'file:/repo/sibling.ts';
        const sourceWrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const source = await renderHook(() => ({ pane: useAppPaneScope(scopeId), owner: useAppPaneContext() }), { wrapper: sourceWrapper });
        const address = { kind: 'paneTab' as const, serverId, accountId: 'account-a', layoutId: 'layout-a', scopeId, tabKey };
        await act(async () => {
            for (const key of [tabKey, sibling]) source.getCurrent().pane.openDetailsTab({ key, kind: 'file', title: key,
                resource: { kind: 'file', path: key.slice(5) } }, { intent: 'pinned' });
            source.getCurrent().pane.setDetailsTabState(tabKey, { accountId: 'account-a', isEditingFile: true,
                editorText: 'source draft', editorOriginalHash: 'base-hash', scrollTop: 71 });
            source.getCurrent().owner.dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' });
            source.getCurrent().owner.dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
                id: 'terminal-pane-transfer', target: { kind: 'workspace_shell' },
            }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
            setPaneTabWindowPresentation(source.getCurrent().owner, address, 'recipient');
        });
        const terminal = source.getCurrent().pane.scopeState?.bottom.tabState.terminal;
        expect(terminal).toBeDefined();
        const recipientWrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider presentedPaneTab={{ scopeId, tabKey }}>{children}</AppPaneProvider>;
        const recipient = await renderHook(() => useAppPaneScope(scopeId), { wrapper: recipientWrapper });
        await act(async () => recipient.getCurrent().patchDetailsTabState(tabKey, { editorText: 'recipient draft', scrollTop: 92 }));
        await act(async () => source.getCurrent().pane.setDetailsTabState(sibling, { text: 'source sibling draft' }));
        await act(async () => { await setPaneTabWindowPresentation(source.getCurrent().owner, address, null); });
        expect(source.getCurrent().pane.scopeState?.details.tabState[tabKey]).toEqual({ accountId: 'account-a',
            isEditingFile: true, editorText: 'recipient draft', editorOriginalHash: 'base-hash', scrollTop: 92 });
        expect(source.getCurrent().pane.scopeState?.details.tabState[sibling]).toEqual({ text: 'source sibling draft' });
        expect(source.getCurrent().pane.scopeState?.bottom.tabState.terminal).toEqual(terminal);
        expect(source.getCurrent().pane.scopeState?.details.tabs.map(tab => tab.key)).toEqual([tabKey, sibling]);
        await recipient.unmount();
        await source.unmount();
        const restored = await renderHook(() => useAppPaneScope(scopeId), { wrapper: sourceWrapper });
        expect(restored.getCurrent().scopeState?.details.tabState[tabKey]).toMatchObject({ editorText: 'recipient draft', editorOriginalHash: 'base-hash', scrollTop: 92 });
        expect(restored.getCurrent().scopeState?.details.tabState[sibling]).toEqual({ text: 'source sibling draft' });
        expect(restored.getCurrent().scopeState?.bottom.tabState.terminal).toEqual(terminal);
        await restored.unmount();
    });

    it('does not disguise a pane serialization programmer error as a storage failure', async () => {
        const { AppPaneProvider } = await import('./AppPaneProvider');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const pane = await renderHook(() => useAppPaneScope('project:wr_1'), { wrapper });
        const tabKey = 'file:/repo/invalid.ts';
        await act(async () => pane.getCurrent().openDetailsTab({ key: tabKey, kind: 'file', title: 'invalid.ts',
            resource: { kind: 'file', path: '/repo/invalid.ts' } }, { intent: 'pinned' }));
        const programmerError = new Error('Invalid draft serialization');
        try {
            await expect(Promise.resolve(act(async () => pane.getCurrent().setDetailsTabState(tabKey, {
                toJSON() { throw programmerError; },
            })))).rejects.toBe(programmerError);
        } finally {
            await pane.unmount();
        }
    });

    it('keeps editing pane drafts in memory when MMKV rejects a write and clears the warning after the next successful write', async () => {
        const { AppPaneProvider } = await import('./AppPaneProvider');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { UiStatePersistenceError } = await import('@/sync/domains/state/persistentUiState');
        const { useWorkspaceFileEditorState } = await import('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState');
        const { readWorkspaceFileEditorDraft } = await import('@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const tabKey = 'file:/repo/quota.ts';
        const originalText = 'const answer = 0;';
        const scope = { serverId, machineId: 'machine-a', rootPath: '/repo' };
        const encoding = { hasBom: false, editable: true, eol: 'lf' as const, mixedEol: false };
        const pane = await renderHook(() => {
            const currentPane = useAppPaneScope('project:wr_1');
            const persistDraft = React.useCallback((draft: Parameters<typeof useWorkspaceFileEditorState>[0]['persistedDraft']) => {
                currentPane.patchDetailsTabState(tabKey, draft ?? { accountId: null, isEditingFile: false,
                    editorOriginalHash: undefined, editorText: undefined });
            }, [currentPane.patchDetailsTabState]);
            const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
            const editor = useWorkspaceFileEditorState({
                scope, accountId: 'account-a',
                filePath: 'quota.ts', displayMode: 'file', fileText: originalText, fileHash: 'base-hash',
                encoding,
                fileWriteSupported, setFileWriteSupported, fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false, filesEditorChangeDebounceMs: 0, mountedRef: { current: true },
                refreshAll: async () => {}, persistDraft,
                persistedDraft: readWorkspaceFileEditorDraft(currentPane.scopeState?.details.tabState[tabKey], 'account-a'),
                panePersistenceFailed: currentPane.persistenceFailed,
            });
            return { ...currentPane, editor };
        }, { wrapper });
        await act(async () => pane.getCurrent().openDetailsTab({ key: tabKey, kind: 'file', title: 'quota.ts',
            resource: { kind: 'file', path: '/repo/quota.ts' } }, { intent: 'pinned' }));
        await act(async () => pane.getCurrent().editor.startEditingFile());
        expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(false);
        const mmkv = getPersistenceStorage();
        const write = mmkv.set.bind(mmkv);
        const quota = new Error('MMKV quota exceeded');
        const set = vi.spyOn(mmkv, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:pane-scopes-v1:')) throw quota;
            write(key, value);
        });
        const firstDraft = { accountId: 'account-a', isEditingFile: true, editorOriginalHash: 'base-hash', editorText: 'const answer = 1;' };
        const continuedDraft = { ...firstDraft, editorText: 'const answer = 2;' };
        try {
            let writeError: unknown;
            try { paneUiState.set('failure', paneUiState.readAll()['project:wr_1']); } catch (error) { writeError = error; }
            expect(writeError).toBeInstanceOf(UiStatePersistenceError);
            expect(writeError).toMatchObject({ message: quota.message, cause: quota });
            await act(async () => pane.getCurrent().editor.onEditorChange(firstDraft.editorText));
            expect(pane.getCurrent().scopeState?.details.tabState[tabKey]).toEqual(firstDraft);
            expect(pane.getCurrent().persistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.getEditorText()).toBe(firstDraft.editorText);
            expect(pane.getCurrent().editor.isEditingFile).toBe(true);
            expect(pane.getCurrent().editor.editorStatus).toBe('dirty');
            await act(async () => pane.getCurrent().editor.onEditorChange(continuedDraft.editorText));
            expect(pane.getCurrent().scopeState?.details.tabState[tabKey]).toEqual(continuedDraft);
            expect(pane.getCurrent().persistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.getEditorText()).toBe(continuedDraft.editorText);
            expect(paneUiState.readAll()['project:wr_1'].details.tabState[tabKey]).toBeUndefined();
            set.mockImplementation(write);
            const recoveredDraft = { ...firstDraft, editorText: 'const answer = 3;' };
            await act(async () => pane.getCurrent().editor.onEditorChange(recoveredDraft.editorText));
            expect(pane.getCurrent().scopeState?.details.tabState[tabKey]).toEqual(recoveredDraft);
            expect(pane.getCurrent().persistenceFailed).toBe(false);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(false);
            expect(pane.getCurrent().editor.editorDirty).toBe(true);
            expect(pane.getCurrent().editor.isEditingFile).toBe(true);
            expect(pane.getCurrent().editor.getEditorText()).toBe(recoveredDraft.editorText);
            expect(paneUiState.readAll()['project:wr_1'].details.tabState[tabKey]).toEqual(recoveredDraft);
            expect(readWorkspaceFileEditorDraft(paneUiState.readAll()['project:wr_1'].details.tabState[tabKey], 'account-a')).toEqual(recoveredDraft);
            const stored: unknown = JSON.parse(mmkv.getString('ui-state:pane-scopes-v1:project:wr_1') ?? 'null');
            expect(PersistedPaneScopesSchema.parse(
                { 'project:wr_1': stored },
            )['project:wr_1'].details.tabState[tabKey]).toEqual(recoveredDraft);
            set.mockImplementation((key, value) => {
                if (key.startsWith('ui-state:pane-scopes-v1:')) throw quota;
                write(key, value);
            });
            await act(async () => pane.getCurrent().editor.onEditorChange(originalText));
            expect(pane.getCurrent().persistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.editorDirty).toBe(false);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(false);
        } finally {
            set.mockRestore();
            await pane.unmount();
        }
    });

    it('persists a generic main-column preference and restores it with the same scope', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const first = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            first.getCurrent().dispatch({ type: 'activateScope', scopeId: 'app' });
            first.getCurrent().dispatch({ type: 'setMainHidden', scopeId: 'app', hidden: true });
        });
        expect(paneUiState.readAll().app.mainHidden).toBe(true);
        await first.unmount();
        const second = await renderHook(useAppPaneContext, { wrapper });
        expect(second.getCurrent().state.scopes.app.mainHidden).toBe(true);
        await second.unmount();
    });

    it('remembers the Account and window workspace layout when the Settings Action is off', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { useWorkspaceState } = await import('../workspace/useWorkspaceState');
        const { readScopedWorkspaceLayout, workspaceLayoutScopeKey } = await import('../workspace/workspacePersistence');
        getStorage().setState({ isDataReady: true, settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const initialTab = { id: 'new', target: { kind: 'newTab', params: {} }, pinned: false, preview: true };
        const tab = { id: 'session-a', target: { kind: 'session', params: { id: 'session-a', serverId } }, pinned: true, preview: false };
        const windowId = 'layout-memory';
        const scopeKey = workspaceLayoutScopeKey({ serverId, accountId: 'account-a', windowId });
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId }));
        expect(hook.getCurrent().isReady).toBe(true);
        await act(async () => hook.getCurrent().dispatch({ type: 'openTab', groupId: 'group:1', tab }));
        const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
        expect(readScopedWorkspaceLayout(workspaceLayoutsState.readAll(), scopeKey)?.tabs['session-a']).toEqual(tab);
        await hook.unmount();
        const restored = await renderHook(() => useWorkspaceState({ initialTab, windowId }));
        expect(restored.getCurrent().state.tabs['session-a']).toEqual(tab);
        await restored.unmount();
    });
    it('hands Find launch input once to its exact destination without persisting the query', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        let context: ReturnType<typeof useAppPaneContext> | null = null;
        function Probe() { context = useAppPaneContext(); return null; }
        const screen = await renderScreen(<AppPaneProvider><Probe /></AppPaneProvider>);
        const destination = { host: 'project' as const, id: 'wr_1', accountId: 'account-a', path: 'src/a.ts',
            scope: { serverId, machineId: 'machine-a', rootPath: '/repo' } };
        const seed = { query: 'private needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };
        if (!context) throw new Error('Pane host did not mount');
        const handoff = (context as ReturnType<typeof useAppPaneContext>).fileFindSeedHandoff;
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        handoff.stage(destination, seed, authority);
        expect(handoff.take({ ...destination, accountId: 'account-b' })).toBeNull();
        expect(handoff.take({ ...destination, scope: { ...destination.scope, serverId: 'home-b' } })).toBeNull();
        expect(handoff.take(destination)).toEqual(seed);
        expect(handoff.take(destination)).toBeNull();
        const cancel = handoff.stage(destination, seed, authority);
        cancel();
        expect(handoff.take(destination)).toBeNull();
        expect(JSON.stringify(getStorage().getState().localSettings)).not.toContain(seed.query);
        handoff.stage(destination, seed, authority);
        await screen.unmount();
        expect(handoff.take(destination)).toBeNull();
    });
    it('reveals accepted terminal selections through the matching mounted session driver, never a foreign Home', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { useRegisterSessionPaneDriver } = await import('@/components/sessions/panes/useRegisterSessionPaneDriver');
        const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected real Account lifetime');
        const calls: string[] = [];
        let dispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | undefined;
        let scopeId = '';
        function Probe(props: Readonly<{ home: string }>) {
            const register = useSessionCockpitChromeRegister();
            const switchSurface = React.useCallback((surface: string) => { calls.push(`${props.home}:${surface}`); }, [props.home]);
            React.useEffect(() => register({ sessionId: 'same-session', serverId: props.home, activeSurface: 'chat', terminalTabAvailable: true, openDetailsTabCount: 0, switchSurface }), [props.home, register, switchSurface]);
            scopeId = useRegisterSessionPaneDriver('same-session', serverId, undefined, {
                pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine-a', serverId, platform: 'ios', accountLifetime,
            });
            dispatch = useAppPaneContext().dispatch;
            return null;
        }
        const harness = (home: string) => <AppPaneProvider><SessionCockpitChromeRegistryProvider><Probe home={home} /></SessionCockpitChromeRegistryProvider></AppPaneProvider>;
        const screen = await renderScreen(harness(serverId));
        const command = async (command: import('@/components/sessions/terminal/sessionTerminalWorkspace').SessionTerminalWorkspaceCommand) => {
            await act(async () => { dispatch?.({ type: 'terminalWorkspace', scopeId, command }); });
        };
        await command({ type: 'open', terminal: { id: 'shell', target: { kind: 'workspace_shell' } } });
        expect(calls).toEqual([`${serverId}:terminal`]);
        calls.length = 0;
        await command({ type: 'split', terminal: { id: 'rejected', target: { kind: 'workspace_shell' } }, availableWidthPx: 500, minimumTerminalWidthPx: 320 });
        await command({ type: 'focus', terminalId: 'missing' });
        expect(calls).toEqual([]);
        await command({ type: 'split', terminal: { id: 'second', target: { kind: 'workspace_shell' } }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 });
        await command({ type: 'focus', terminalId: 'shell' });
        await command({ type: 'focus', terminalId: 'shell' });
        await command({ type: 'detach', terminalId: 'second', newTabId: 'detached-second' });
        expect(calls).toEqual(Array.from({ length: 4 }, () => `${serverId}:terminal`));
        calls.length = 0;
        await screen.update(harness('home-b'));
        await command({ type: 'open', terminal: { id: 'other', target: { kind: 'workspace_shell' } } });
        await command({ type: 'focus', terminalId: 'shell' });
        expect(calls).toEqual([]);
        await screen.update(harness(serverId));
        await command({ type: 'focus', terminalId: 'shell' });
        expect(calls).toEqual([`${serverId}:terminal`]);
    });

    it('hydrates persisted pane scopes from local settings on mount', async () => {
        (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse(PersistedPaneScopesSchema.parse({
                'project:wr_1': {
                    right: { isOpen: true, activeTabId: 'git', tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'file:/repo/src/a.ts',
                                kind: 'file',
                                title: 'a.ts',
                                resource: { kind: 'file', path: '/repo/src/a.ts' },
                                isPreview: false,
                                isPinned: true,
                            },
                        ],
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabState: {
                            'file:/repo/src/a.ts': { draft: 'draft text' },
                        },
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            }))), getStorage().getState().applyLocalSettings({
        }));

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState).toEqual(expect.objectContaining({
            right: expect.objectContaining({
                isOpen: true,
                activeTabId: 'git',
                selectedDestination: { kind: 'builtin', id: 'git' },
            }),
            details: expect.objectContaining({
                isOpen: true,
                activeTabKey: 'file:/repo/src/a.ts',
                focusedGroupId: 'group:1',
                groups: [
                    expect.objectContaining({
                        id: 'group:1',
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabKeys: ['file:/repo/src/a.ts'],
                    }),
                ],
                tabState: {
                    'file:/repo/src/a.ts': { draft: 'draft text' },
                },
            }),
        }));
    });

    it('preserves own Details tab keys through the local-setting boundary and removes inherited-only group references', async () => {
        const tabKey = '__proto__';
        (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse(PersistedPaneScopesSchema.parse(JSON.parse(JSON.stringify({
                'project:wr_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabState: { [tabKey]: { scrollY: 240 } },
                        tabsByKey: {
                            [tabKey]: {
                                key: tabKey,
                                kind: 'file',
                                title: 'prototype-safe.ts',
                                resource: { kind: 'file', path: '/repo/prototype-safe.ts' },
                                isPreview: false,
                                isPinned: true,
                            },
                        },
                        groupsById: {
                            'group:1': {
                                id: 'group:1',
                                tabKeys: [tabKey, 'constructor'],
                                activeTabKey: tabKey,
                            },
                        },
                        root: {
                            id: 'group:1',
                            kind: 'leaf',
                            leafKind: 'details-group',
                            payload: { groupId: 'group:1' },
                        },
                        focusedGroupId: 'group:1',
                        maximizedGroupId: null,
                        nextGroupOrdinal: 2,
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            }))))), getStorage().getState().applyLocalSettings({
        }));

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        const scopeState = screen.tree.findByType('PaneScopeProbe' as never).props.scopeState;
        if (!scopeState) throw new Error('Expected hydrated pane scope state');

        expect(scopeState.details.tabs).toEqual([
            expect.objectContaining({ key: tabKey }),
        ]);
        expect(scopeState.details.groups).toEqual([
            expect.objectContaining({
                id: 'group:1',
                tabKeys: [tabKey],
                activeTabKey: tabKey,
            }),
        ]);
        expect(Object.prototype.hasOwnProperty.call(scopeState.details.tabState, tabKey)).toBe(true);
        expect(scopeState.details.tabState[tabKey]).toEqual({ scrollY: 240 });
        const roundTrippedScopes = PersistedPaneScopesSchema.parse(
            paneUiState.readAll(),
        );
        expect(roundTrippedScopes).toEqual(expect.objectContaining({
            'project:wr_1': expect.objectContaining({
                details: expect.objectContaining({
                    tabsByKey: expect.objectContaining({
                        [tabKey]: expect.objectContaining({ key: tabKey }),
                    }),
                    groupsById: {
                        'group:1': {
                            id: 'group:1',
                            tabKeys: [tabKey],
                            activeTabKey: tabKey,
                        },
                    },
                }),
            }),
        }));
    });

    it('persists pane scope memory when the Settings Action is off', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        getStorage().setState({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe triggerOpenDetails={false} />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <PaneScopeProbe triggerOpenDetails />
                </AppPaneProvider>,
            );
        });

        expect(paneUiState.readAll()).toEqual(expect.objectContaining({
            'project:wr_1': expect.objectContaining({
                details: expect.objectContaining({
                    focusedGroupId: 'group:1',
                    root: {
                        id: 'group:1',
                        kind: 'leaf',
                        leafKind: 'details-group',
                        payload: { groupId: 'group:1' },
                    },
                    tabsByKey: expect.objectContaining({
                        'file:/repo/src/a.ts': expect.objectContaining({
                            isPinned: true,
                            isPreview: false,
                        }),
                    }),
                    groupsById: {
                        'group:1': {
                            id: 'group:1',
                            tabKeys: ['file:/repo/src/a.ts'],
                            activeTabKey: 'file:/repo/src/a.ts',
                        },
                    },
                    tabState: {
                        'file:/repo/src/a.ts': { draft: 'draft text' },
                    },
                }),
            }),
        }));
    });

    it('hydrates persisted pane scopes that arrive after the initial mount', async () => {
        const persistedScopes = PersistedPaneScopesSchema.parse({
            'project:wr_1': {
                right: { isOpen: true, activeTabId: 'git', tabState: {} },
                details: {
                    isOpen: true,
                    tabs: [
                        {
                            key: 'file:/repo/src/a.ts',
                            kind: 'file',
                            title: 'a.ts',
                            resource: { kind: 'file', path: '/repo/src/a.ts' },
                            isPreview: false,
                            isPinned: true,
                        },
                    ],
                    activeTabKey: 'file:/repo/src/a.ts',
                    tabState: {
                        'file:/repo/src/a.ts': { draft: 'draft text' },
                    },
                },
                bottom: { isOpen: false, activeTabId: null, tabState: {} },
            },
        });

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        await act(async () => {
            (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse(persistedScopes)), getStorage().getState().applyLocalSettings({ }));
            await screen.update(
                <AppPaneProvider>
                    <PaneScopeProbe />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState).toEqual(expect.objectContaining({
            right: expect.objectContaining({
                isOpen: true,
                activeTabId: 'git',
                selectedDestination: { kind: 'builtin', id: 'git' },
            }),
            details: expect.objectContaining({
                isOpen: true,
                activeTabKey: 'file:/repo/src/a.ts',
                focusedGroupId: 'group:1',
                groups: [
                    expect.objectContaining({
                        id: 'group:1',
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabKeys: ['file:/repo/src/a.ts'],
                    }),
                ],
                tabState: {
                    'file:/repo/src/a.ts': { draft: 'draft text' },
                },
            }),
        }));
    });
});

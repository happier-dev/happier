import { resolveSessionCockpitMobileCatalog } from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import 'fake-indexeddb/auto';
import * as React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createRenderCommitCounter, renderHook, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
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
// Import the real driver graph during collection, outside the behavior deadline.
const [{ useRegisterSessionPaneDriver }, { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister }] = await Promise.all([
    import('@/components/sessions/panes/useRegisterSessionPaneDriver'),
    import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'),
]);
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
    it('retains distinct window pane scopes through a stale sibling write and relaunch', async () => {
        const { Dimensions } = await import('react-native');
        const dimensions = Dimensions.get('window');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...dimensions, width: 1440, height: 900 });
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const first = await renderHook(useAppPaneContext, { wrapper });
        const second = await renderHook(useAppPaneContext, { wrapper });
        try {
            // Both realms admitted their writes before either receives the sibling's storage event.
            await act(async () => {
                first.getCurrent().dispatch({ type: 'openRight', scopeId: 'session:first-window', tabId: 'files' });
                second.getCurrent().dispatch({ type: 'openBottom', scopeId: 'session:second-window', tabId: 'git' });
                expect(paneUiState.read('session:first-window')?.right.isOpen).toBe(true);
                expect(paneUiState.read('session:second-window')?.bottom.isOpen).toBe(true);
            });
            await act(async () => {
                first.getCurrent().dispatch({ type: 'setRightTabState', scopeId: 'session:first-window', tabId: 'files', nextState: { query: 'first' } });
                second.getCurrent().dispatch({ type: 'setRightTabState', scopeId: 'session:first-window', tabId: 'files', nextState: { query: 'last writer' } });
            });
            expect(paneUiState.read('session:first-window')?.right.tabState.files).toEqual({ query: 'last writer' });
            await first.unmount();
            await second.unmount();
            const restored = await renderHook(useAppPaneContext, { wrapper });
            try {
                expect(restored.getCurrent().state.scopes['session:first-window'].right).toMatchObject({ isOpen: true, activeTabId: 'files' });
                expect(restored.getCurrent().state.scopes['session:first-window'].right.tabState.files).toEqual({ query: 'last writer' });
                expect(restored.getCurrent().state.scopes['session:second-window'].bottom).toMatchObject({ isOpen: true, activeTabId: 'git' });
            } finally {
                await restored.unmount();
            }
        } finally {
            await first.unmount();
            await second.unmount();
            viewport.mockRestore();
        }
    });

    it('keeps the current Shell inventory across stale sibling writes and honors explicit Close', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { EMPTY_TERMINAL_WORKSPACE, readSessionTerminalWorkspace, reduceSessionTerminalWorkspace } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
        const { PersistedPaneScopeSchema } = await import('./model/paneScopePersistenceSchema');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const scopeId = 'session:shared-shell-inventory';
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const first = await renderHook(useAppPaneContext, { wrapper });
        const second = await renderHook(useAppPaneContext, { wrapper });
        const savedIds = () => readSessionTerminalWorkspace(paneUiState.readStrict(scopeId, value => PersistedPaneScopeSchema.parse(value))?.bottom.tabState.terminal)
            .tabs.flatMap(tab => tab.terminals.map(terminal => terminal.id));
        try {
            await act(async () => first.getCurrent().dispatch({ type: 'setBottomTabState', scopeId, tabId: 'terminal', nextState: EMPTY_TERMINAL_WORKSPACE }));
            await act(async () => first.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
                command: { type: 'open', terminal: { id: 'desktop-shell', target: { kind: 'workspace_shell' } } } }));
            const staleScope = first.getCurrent().state.scopes[scopeId];
            await act(async () => second.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
                command: { type: 'open', terminal: { id: 'phone-shell', target: { kind: 'workspace_shell' } } } }));
            expect(savedIds()).toEqual(['desktop-shell', 'phone-shell']);
            // The older presenter still owns its layout, but must not replace newer Shell membership.
            await act(async () => first.getCurrent().dispatch({ type: 'openRight', scopeId, tabId: 'files' }));
            expect(savedIds()).toEqual(['desktop-shell', 'phone-shell']);
            await act(async () => second.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
                command: { type: 'close', terminalId: 'desktop-shell' } }));
            expect(savedIds()).toEqual(['phone-shell']);
            await act(async () => first.getCurrent().dispatch({ type: 'setRightTabState', scopeId, tabId: 'files', nextState: { query: 'new query' } }));
            expect(savedIds()).toEqual(['phone-shell']);
            await act(async () => first.getCurrent().dispatch({ type: 'restoreScope', scopeId, scope: staleScope }));
            expect(savedIds()).toEqual(['phone-shell']);
            // Another browser realm writes the real adapter before its storage event is delivered.
            const saved = paneUiState.read(scopeId)!;
            getPersistenceStorage().set(`ui-state:pane-scopes-v1:${scopeId}`, JSON.stringify({ ...saved,
                bottom: { ...saved.bottom, tabState: { ...saved.bottom.tabState, terminal: reduceSessionTerminalWorkspace(
                    readSessionTerminalWorkspace(saved.bottom.tabState.terminal),
                    { type: 'open', terminal: { id: 'other-realm-shell', target: { kind: 'workspace_shell' } } },
                ) } },
            }));
            await act(async () => { expect(first.getCurrent().flushPersistence?.()).toBe(true); });
            expect(savedIds()).toEqual(['phone-shell', 'other-realm-shell']);
            // Both commands arrive before React can hydrate either provider from the sibling publication.
            const reads = vi.spyOn(getPersistenceStorage(), 'getString');
            try {
                await act(async () => {
                    first.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
                        command: { type: 'open', terminal: { id: 'desktop-new-shell', target: { kind: 'workspace_shell' } } } });
                    second.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
                        command: { type: 'open', terminal: { id: 'phone-new-shell', target: { kind: 'workspace_shell' } } } });
                    // Each real write reads its retained record once and reuses that read at persistence;
                    // the adapter's existing idempotent-set comparison is the other backing read.
                    expect(reads.mock.calls.filter(([key]) => key === `ui-state:pane-scopes-v1:${scopeId}`)).toHaveLength(4);
                });
            } finally { reads.mockRestore(); }
            expect(savedIds()).toEqual(['phone-shell', 'other-realm-shell', 'desktop-new-shell', 'phone-new-shell']);
            expect(readSessionTerminalWorkspace(first.getCurrent().state.scopes[scopeId].bottom.tabState.terminal)
                .tabs.flatMap(tab => tab.terminals.map(terminal => terminal.id))).toEqual(savedIds());
            await first.unmount();
            await second.unmount();
            const restored = await renderHook(useAppPaneContext, { wrapper });
            try {
                expect(readSessionTerminalWorkspace(restored.getCurrent().state.scopes[scopeId].bottom.tabState.terminal)
                    .tabs.flatMap(tab => tab.terminals.map(terminal => terminal.id))).toEqual(['phone-shell', 'other-realm-shell', 'desktop-new-shell', 'phone-new-shell']);
            } finally { await restored.unmount(); }
        } finally {
            await first.unmount();
            await second.unmount();
        }
    });

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
        await act(async () => { setPaneTabWindowPresentation(source.getCurrent().owner, address, null); });
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
    it.each(['cold', 'late'] as const)('restores a duplicated terminal workspace in one desktop pane on %s hydration', async hydration => {
        const { Dimensions } = await import('react-native');
        const dimensions = Dimensions.get('window');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...dimensions, width: 1440, height: 900 });
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { appPaneReduce, createAppPaneState } = await import('./model/appPaneReducer');
        const { serializePersistedPaneScope } = await import('./model/paneScopePersistence');
        const scopeId = 'session:restored-terminal-dock';
        let fixture = appPaneReduce(createAppPaneState({ maxScopesInMemory: 12 }), { type: 'openBottom', scopeId, tabId: 'terminal' });
        fixture = appPaneReduce(fixture, { type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
            id: 'split-shell', target: { kind: 'workspace_shell' },
        }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
        const scope = fixture.scopes[scopeId];
        // The old owner admitted both views of the same workspace; retain that stored shape at ingress.
        const saved = serializePersistedPaneScope({ ...scope,
            right: { ...scope.right, isOpen: true, activeTabId: 'terminal', selectedDestination: { kind: 'builtin', id: 'terminal' } },
        }, { preserveDesktopVisibility: false });
        const otherScopeId = 'session:restored-terminal-with-git';
        const otherSaved = { ...saved, right: { ...saved.right, activeTabId: 'git', selectedDestination: { kind: 'builtin' as const, id: 'git' } } };
        const detailsScopeId = 'session:restored-sidebar-terminal';
        const detailsFixture = appPaneReduce(fixture, { type: 'openDetailsTab', scopeId, openAs: 'pinned', tab: {
            key: 'terminal:embedded', kind: 'terminal', title: 'Terminal', resource: { kind: 'terminal', terminalInstanceId: 'embedded' },
        } });
        const detailsSaved = serializePersistedPaneScope({ ...detailsFixture.scopes[scopeId], right: saved.right }, { preserveDesktopVisibility: false });
        const hydrate = () => {
            paneUiState.set(scopeId, saved);
            paneUiState.set(otherScopeId, otherSaved);
            paneUiState.set(detailsScopeId, detailsSaved);
        };
        if (hydration === 'cold') hydrate();
        const mounted = await renderHook(useAppPaneContext, { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> });
        try {
            if (hydration === 'late') await act(async () => hydrate());
            const restored = mounted.getCurrent().state.scopes[scopeId];
            expect(restored).toMatchObject({ right: { isOpen: false }, bottom: { isOpen: true, activeTabId: 'terminal' } });
            expect(restored.bottom.tabState.terminal).toEqual(scope.bottom.tabState.terminal);
            expect(mounted.getCurrent().state.scopes[otherScopeId]).toMatchObject({
                right: { isOpen: true, activeTabId: 'git' }, bottom: { isOpen: true, activeTabId: 'terminal' },
            });
            const sidebarRestored = mounted.getCurrent().state.scopes[detailsScopeId];
            expect(sidebarRestored).toMatchObject({ right: { isOpen: true, activeTabId: 'terminal' }, bottom: { isOpen: false } });
            expect(sidebarRestored.details.tabsByKey['terminal:embedded']).toBeUndefined();
        } finally {
            await mounted.unmount();
            viewport.mockRestore();
        }
    });
    it.each(['cold', 'late'] as const)('restores desktop pane content without opening phone sheets on %s hydration', async (hydration) => {
        const { Dimensions } = await import('react-native');
        const dimensions = Dimensions.get('window');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...dimensions, width: 1440, height: 900 });
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const scopeId = 'session:phone-landing';
        const tab = { key: 'file:src/a.ts', kind: 'file', title: 'a.ts', resource: { kind: 'file', path: 'src/a.ts' } };
        const first = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            const dispatch = first.getCurrent().dispatch;
            dispatch({ type: 'activateScope', scopeId });
            dispatch({ type: 'openRight', scopeId, tabId: 'files' });
            dispatch({ type: 'setRightTabState', scopeId, tabId: 'files', nextState: { query: 'retained' } });
            dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: 'pinned' });
            dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' });
            dispatch({ type: 'setMainHidden', scopeId, hidden: true });
        });
        const saved = paneUiState.read(scopeId)!;
        await first.unmount();
        if (hydration === 'late') replacePersistentUiStateForTest(paneUiState, {});
        viewport.mockReturnValue({ ...dimensions, width: 390, height: 844 });
        const phone = await renderHook(useAppPaneContext, { wrapper });
        if (hydration === 'late') await act(async () => paneUiState.set(scopeId, saved));
        const scope = () => phone.getCurrent().state.scopes[scopeId];
        expect(scope()).toMatchObject({ mainHidden: false,
            right: { isOpen: false, activeTabId: 'files', tabState: { files: { query: 'retained' } } },
            details: { isOpen: false, tabsByKey: { [tab.key]: expect.objectContaining(tab) } },
            bottom: { isOpen: false, activeTabId: 'terminal' },
        });
        // Activation and content writes on a phone must not overwrite desktop layout visibility.
        await act(async () => {
            phone.getCurrent().dispatch({ type: 'activateScope', scopeId });
            phone.getCurrent().dispatch({ type: 'setRightTabState', scopeId, tabId: 'files', nextState: { query: 'phone' } });
            phone.getCurrent().dispatch({ type: 'openRight', scopeId, tabId: 'git' });
            phone.getCurrent().dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: 'pinned' });
            phone.getCurrent().dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' });
        });
        expect(scope()).toMatchObject({ right: { isOpen: true }, details: { isOpen: true }, bottom: { isOpen: true } });
        await act(async () => {
            phone.getCurrent().dispatch({ type: 'closeRight', scopeId });
            phone.getCurrent().dispatch({ type: 'closeDetails', scopeId });
            phone.getCurrent().dispatch({ type: 'closeBottom', scopeId });
        });
        // Widening may rebind a host before reload. Its lifecycle intents still
        // belong to the phone landing and must not save its closed sheets as columns.
        viewport.mockReturnValue({ ...dimensions, width: 1440, height: 900 });
        await act(async () => {
            phone.getCurrent().dispatch({ type: 'releaseScope', scopeId });
            phone.getCurrent().dispatch({ type: 'activateScope', scopeId });
            phone.getCurrent().dispatch({ type: 'setRightTabState', scopeId, tabId: 'files', nextState: { query: 'phone after widening' } });
        });
        expect(paneUiState.read(scopeId)).toMatchObject({ mainHidden: true,
            right: { isOpen: true, activeTabId: 'git', tabState: { files: { query: 'phone after widening' } } },
            details: { isOpen: true }, bottom: { isOpen: true },
        });
        await phone.unmount();
        viewport.mockReturnValue({ ...dimensions, width: 390, height: 844 });
        const phoneAgain = await renderHook(useAppPaneContext, { wrapper });
        expect(phoneAgain.getCurrent().state.scopes[scopeId]).toMatchObject({
            right: { isOpen: false }, details: { isOpen: false }, bottom: { isOpen: false },
        });
        await phoneAgain.unmount();
        viewport.mockReturnValue({ ...dimensions, width: 1440, height: 900 });
        const desktop = await renderHook(useAppPaneContext, { wrapper });
        expect(desktop.getCurrent().state.scopes[scopeId]).toMatchObject({ mainHidden: true,
            right: { isOpen: true, activeTabId: 'git' }, details: { isOpen: true }, bottom: { isOpen: true },
        });
        await desktop.unmount();
        viewport.mockRestore();
    });

    it.each(['cold', 'late'] as const)('restores 153 tabs in one %s scope publication and stays idle', async (restore) => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { AppPaneContext } = await import('./AppPaneContext');
        const { appPaneReduce, createAppPaneState } = await import('./model/appPaneReducer');
        const { serializeDetailsWorkspaceState } = await import('./details/workspace/migrateLegacyDetailsWorkspaceState');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const scopeId = 'session:idle-cost';
        let fixture = createAppPaneState({ maxScopesInMemory: 12 });
        for (let index = 0; index < 153; index += 1) {
            const path = `/repo/restored-${index}.ts`;
            fixture = appPaneReduce(fixture, { type: 'openDetailsTab', scopeId, openAs: 'pinned',
                tab: { key: `file:${path}`, kind: 'file', title: path, resource: { kind: 'file', path } } });
        }
        const scope = fixture.scopes[scopeId];
        const persisted = PersistedPaneScopesSchema.parse({ [scopeId]: {
            ...scope, details: serializeDetailsWorkspaceState(scope.details),
        } })[scopeId];
        if (restore === 'cold') paneUiState.set(scopeId, persisted);
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const deletes = vi.spyOn(getPersistenceStorage(), 'delete');
        // Account restore/cache writes belong to the Home harness, not pane restoration.
        const paneWrites = () => writes.mock.calls.filter(([key]) => key.startsWith('ui-state:pane-scopes-v1:'));
        const broadNotifications = vi.fn();
        const keyedNotifications = vi.fn();
        const stopBroad = paneUiState.subscribe(broadNotifications);
        const stopKeyed = paneUiState.subscribeKey(scopeId, keyedNotifications);
        const subscribe = paneUiState.subscribe;
        let activeOwnerSubscriptions = 0;
        const ownerSubscription = vi.spyOn(paneUiState, 'subscribe').mockImplementation(listener => {
            activeOwnerSubscriptions += 1;
            const stop = subscribe(listener);
            return () => { activeOwnerSubscriptions -= 1; stop(); };
        });
        const renders = createRenderCommitCounter();
        let publishedScopes: ReturnType<typeof createAppPaneState>['scopes'] | undefined;
        let scopePublications = 0;
        let callbacks = 0;
        function Probe() {
            const scopes = useAppPaneContext(value => value.state.scopes);
            useRenderCommitCounter(renders);
            const context = React.useContext(AppPaneContext);
            React.useLayoutEffect(() => {
                const observe = () => {
                    callbacks += 1;
                    const next = context?.getSnapshot().state.scopes;
                    if (next !== publishedScopes && next?.[scopeId]) {
                        publishedScopes = next;
                        scopePublications += 1;
                    }
                };
                return context?.subscribe(observe);
            }, [context]);
            return React.createElement('RestoredScope', { tabs: Object.keys(scopes[scopeId]?.details.tabsByKey ?? {}).length });
        }
        const screen = await renderScreen(<AppPaneProvider><Probe /></AppPaneProvider>);
        try {
            if (restore === 'late') {
                renders.reset(); callbacks = 0;
                await act(async () => paneUiState.set(scopeId, persisted));
                expect(broadNotifications).toHaveBeenCalledTimes(1);
                expect(keyedNotifications).toHaveBeenCalledTimes(1);
                expect(paneWrites()).toHaveLength(1); // the incoming scope, not one write per tab
            } else {
                expect(broadNotifications).not.toHaveBeenCalled();
                expect(keyedNotifications).not.toHaveBeenCalled();
                expect(paneWrites()).toHaveLength(0); // canonical cold restore never persists again
            }
            expect(screen.findByType('RestoredScope').props.tabs).toBe(153);
            expect(scopePublications).toBe(1);
            expect(renders.read()).toEqual({ renders: 1, commits: 1 });
            expect(activeOwnerSubscriptions).toBe(1); // aggregate provider, never one subscription per tab
            const retainedOwnerSnapshot = paneUiState.readAll();
            const retainedScopes = publishedScopes;
            const retainedTabs = publishedScopes?.[scopeId].details.tabsByKey;
            const subscriptionsBefore = ownerSubscription.mock.calls.length;
            writes.mockClear(); broadNotifications.mockClear(); keyedNotifications.mockClear();
            renders.reset(); callbacks = 0;
            // Exercise the real store's Machine-arrival path without a live Account.
            await act(async () => getStorage().getState().applyMachines([createMachineFixture({ id: 'unrelated-idle-machine' })]));
            expect(getStorage().getState().machines['unrelated-idle-machine']).toBeDefined();
            for (let tick = 0; tick < 50; tick += 1) await act(async () => {});
            expect(paneWrites()).toHaveLength(0);
            expect(writes.mock.calls.filter(([key]) => key === 'settings' || key === 'local-settings')).toHaveLength(0);
            expect(deletes.mock.calls.filter(([key]) => key.startsWith('ui-state:pane-scopes-v1:'))).toHaveLength(0);
            expect(broadNotifications).not.toHaveBeenCalled();
            expect(keyedNotifications).not.toHaveBeenCalled();
            expect(callbacks).toBe(0);
            expect(scopePublications).toBe(1);
            expect(renders.read()).toEqual({ renders: 0, commits: 0 });
            expect(ownerSubscription).toHaveBeenCalledTimes(subscriptionsBefore);
            expect(paneUiState.readAll()).toBe(retainedOwnerSnapshot);
            expect(publishedScopes).toBe(retainedScopes);
            expect(publishedScopes?.[scopeId].details.tabsByKey).toBe(retainedTabs);
            expect(Object.keys(retainedTabs ?? {})).toHaveLength(153);
            // A reconstructed equal record is also a no-op, not a reference-equality feedback loop.
            await act(async () => paneUiState.set(scopeId, JSON.parse(JSON.stringify(persisted))));
            expect(paneWrites()).toHaveLength(0);
            expect(broadNotifications).not.toHaveBeenCalled();
            expect(keyedNotifications).not.toHaveBeenCalled();
            expect(renders.read()).toEqual({ renders: 0, commits: 0 });
        } finally {
            await screen.unmount();
            expect(activeOwnerSubscriptions).toBe(0);
            ownerSubscription.mockRestore();
            stopBroad(); stopKeyed(); writes.mockRestore(); deletes.mockRestore();
        }
    });

    it('opens files, switches tabs and records suggestions without writing settings', async () => {
        const { AppPaneProvider } = await import('./AppPaneProvider');
        const { recordFileEditorAiSuggestionUsage } = await import('@/sync/store/files/fileEditorAiSuggestionUsage');
        const { recordWorkspaceFileOpen } = await import('@/sync/store/files/recentWorkspaceFiles');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const wrapper = ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider>;
        const pane = await renderHook(() => useAppPaneScope('project:wr_1'), { wrapper });
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            for (const name of ['first', 'second', 'first']) {
                await act(async () => pane.getCurrent().openDetailsTab({ key: `file:/repo/${name}.ts`, kind: 'file',
                    title: `${name}.ts`, resource: { kind: 'file', path: `/repo/${name}.ts` } }, { intent: 'pinned' }));
            }
            const scope = { serverId, accountId: 'account-a' };
            expect(getStorage().getState().settingsScope).toEqual(scope);
            recordFileEditorAiSuggestionUsage(scope, { kind: 'requested' });
            recordWorkspaceFileOpen(scope, 'cost-contract-workspace', 'first.ts');
            recordWorkspaceFileOpen(scope, 'cost-contract-workspace', 'second.ts');
            expect(writes.mock.calls.filter(([key]) => key === 'local-settings' || key === 'settings')).toHaveLength(0);
        } finally {
            writes.mockRestore();
            await pane.unmount();
        }
    });

    it('keeps draft text in the editor until a lifecycle checkpoint while publishing dirty metadata once', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { AppPaneContext } = await import('./AppPaneContext');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { loadLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
        const { useWorkspaceFileEditorState } = await import('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState');
        const browser = new EventTarget();
        vi.stubGlobal('addEventListener', browser.addEventListener.bind(browser));
        vi.stubGlobal('removeEventListener', browser.removeEventListener.bind(browser));
        const tabKey = 'file:/repo/typing.ts';
        let editor!: ReturnType<typeof useWorkspaceFileEditorState>;
        let pane!: ReturnType<typeof useAppPaneScope>;
        let unrelatedCommits = 0;
        let panePublications = 0;
        function UnrelatedPane() {
            useAppPaneContext(value => value.state.scopes['project:wr_1']?.right);
            return null;
        }
        function Editor() {
            const context = React.useContext(AppPaneContext);
            React.useEffect(() => context?.subscribe(() => { panePublications += 1; }), [context]);
            pane = useAppPaneScope('project:wr_1');
            const persistDraft = React.useCallback<NonNullable<Parameters<typeof useWorkspaceFileEditorState>[0]['persistDraft']>>((draft, options) => {
                pane.patchDetailsTabState(tabKey, draft ?? { accountId: null, isEditingFile: false, editorText: undefined }, options);
            }, [pane.patchDetailsTabState]);
            editor = useWorkspaceFileEditorState({ scope: { serverId, machineId: 'machine-a', rootPath: '/repo' },
                accountId: 'account-a', filePath: 'typing.ts', displayMode: 'file', fileText: 'base', fileHash: 'hash',
                fileWriteSupported: true, setFileWriteSupported() {}, fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false, filesEditorChangeDebounceMs: 0, mountedRef: { current: true },
                refreshAll: async () => {}, persistDraft });
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider><Editor /><React.Profiler id="unrelated" onRender={() => { unrelatedCommits += 1; }}><UnrelatedPane /></React.Profiler></AppPaneProvider>);
        const mmkv = getPersistenceStorage();
        const writes = vi.spyOn(mmkv, 'set');
        const settings = vi.spyOn(getStorage().getState(), 'applyLocalSettings');
        try {
            await act(async () => pane.openDetailsTab({ key: tabKey, kind: 'file', title: 'typing.ts', resource: { kind: 'file', path: '/repo/typing.ts' } }, { intent: 'pinned' }));
            await act(async () => editor.startEditingFile());
            writes.mockClear(); settings.mockClear();
            const before = unrelatedCommits;
            const publicationsBefore = panePublications;
            for (let index = 1; index <= 20; index += 1) {
                await act(async () => editor.onEditorChange(`base${'x'.repeat(index)}`));
            }
            expect(pane.scopeState?.details.tabState[tabKey]).toMatchObject({ accountId: 'account-a', isEditingFile: true, editorText: 'basex' });
            expect(settings).not.toHaveBeenCalled();
            expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
            expect(unrelatedCommits - before).toBe(0);
            expect(panePublications - publicationsBefore).toBe(1); // dirty transition only, never text versions
            expect(editor.getEditorText()).toBe(`base${'x'.repeat(20)}`);
            // The native/browser engine may be ahead of its debounced callback.
            editor.editorHandleRef.current = { getValue: () => 'latest engine buffer', flushPendingChange: async () => {} };
            await act(async () => { browser.dispatchEvent(new Event('pagehide')); });
            expect(paneUiState.readAll()['project:wr_1'].details.tabState[tabKey]).toMatchObject({ editorText: 'latest engine buffer', isEditingFile: true });
            expect(settings).not.toHaveBeenCalled();
        } finally {
            writes.mockRestore(); settings.mockRestore();
            await screen.unmount();
            vi.unstubAllGlobals();
        }
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
            const persistDraft = React.useCallback<NonNullable<Parameters<typeof useWorkspaceFileEditorState>[0]['persistDraft']>>((draft, options) => {
                currentPane.patchDetailsTabState(tabKey, draft ?? { accountId: null, isEditingFile: false,
                    editorOriginalHash: undefined, editorText: undefined }, options);
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
            await act(async () => { expect(await pane.getCurrent().editor.prepareEditorTransition()).toBe(false); });
            expect(pane.getCurrent().scopeState?.details.tabState[tabKey]).toEqual(firstDraft);
            expect(pane.getCurrent().persistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.getEditorText()).toBe(firstDraft.editorText);
            expect(pane.getCurrent().editor.isEditingFile).toBe(true);
            expect(pane.getCurrent().editor.editorStatus).toBe('dirty');
            await act(async () => pane.getCurrent().editor.onEditorChange(continuedDraft.editorText));
            await act(async () => { await pane.getCurrent().editor.prepareEditorTransition(); });
            expect(pane.getCurrent().scopeState?.details.tabState[tabKey]).toEqual(continuedDraft);
            expect(pane.getCurrent().persistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.draftPersistenceFailed).toBe(true);
            expect(pane.getCurrent().editor.getEditorText()).toBe(continuedDraft.editorText);
            expect(paneUiState.readAll()['project:wr_1'].details.tabState[tabKey]).toBeUndefined();
            set.mockImplementation(write);
            const recoveredDraft = { ...firstDraft, editorText: 'const answer = 3;' };
            await act(async () => pane.getCurrent().editor.onEditorChange(recoveredDraft.editorText));
            await act(async () => { await pane.getCurrent().editor.prepareEditorTransition(); });
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
            await act(async () => { await pane.getCurrent().editor.prepareEditorTransition(); });
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
        const { parseWorkspaceLayout, workspaceLayoutScopeKey } = await import('../workspace/workspacePersistence');
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
        expect(parseWorkspaceLayout(workspaceLayoutsState.read(scopeKey))?.tabs['session-a']).toEqual(tab);
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
        const calls: string[] = [];
        let dispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | undefined;
        let scopeId = '';
        function Probe(props: Readonly<{ home: string }>) {
            const register = useSessionCockpitChromeRegister();
            const switchSurface = React.useCallback((surface: string) => { calls.push(`${props.home}:${surface}`); }, [props.home]);
            const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true }), []);
            const readColumn = React.useCallback(() => ({ present: true, visible: true, available: true, setVisible: () => {} }), []);
            React.useEffect(() => register({ sessionId: 'same-session', serverId: props.home, activeSurface: 'chat', terminalTabAvailable: true, catalog, readColumn, openDetailsTabCount: 0, switchSurface }), [props.home, register, switchSurface, catalog, readColumn]);
            scopeId = useRegisterSessionPaneDriver('same-session', serverId);
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

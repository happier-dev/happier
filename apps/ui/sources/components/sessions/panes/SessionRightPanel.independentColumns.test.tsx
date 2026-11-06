import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from './sessionPaneScopeId';
import type { RightSidebarRailAction } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

installSessionDetailsPanelCommonModuleMocks();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { SessionRightPanel, SessionPageTabs, SessionActionRail, SessionRightSidebarProvider, useSessionRightSidebarPresentation } = await import('./SessionRightPanel');
const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
const { SessionBrowseFilesSurface } = await import('./surfaces/SessionBrowseFilesSurface');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
const { PresentedDetailNavigationProvider } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
const { RightSidebarIconTabBar } = await import('@/components/appShell/rightSidebar/RightSidebarIconTabBar');
const { RightSidebarPaneHeader } = await import('@/components/appShell/rightSidebar/RightSidebarPaneHeader');
const { RightSidebarActionsContext } = await import('@/components/appShell/rightSidebar/rightSidebarActions');
const { Modal } = await import('@/modal');

it.each(['page', 'page-chat', 'header', 'screen-header', 'presentation', 'published-main', 'published-side', 'back', 'close'] as const)(
    'admits the mounted %s control before changing its Session column', async control => {
        storage.getState().applyLocalSettings({ paneArrangement: 'editor', uiMultiPanePanelsEnabled: true }, { persist: false });
        const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
        const panelPresentation = control === 'screen-header' ? 'screen' : 'pane';
        const selectsSide = control === 'header' || control === 'screen-header' || control === 'published-side';
        const published = React.createRef<import('@/components/appShell/rightSidebar/rightSidebarActions').RightSidebarActions | null>();
        let presentation: ReturnType<typeof useSessionRightSidebarPresentation>;
        function PresentationControl() { presentation = useSessionRightSidebarPresentation(); return null; }
        const wrap = (content: React.ReactElement) => <RightSidebarActionsContext.Provider value={published}>
            <SessionRightSidebarProvider sessionId="s1" scopeId={scopeId} presentation={panelPresentation}>
                <SessionPageTabs /><SessionRightPanel sessionId="s1" scopeId={scopeId} presentation={panelPresentation} />
                <SessionActionRail /><PresentationControl />{content}
            </SessionRightSidebarProvider>
        </RightSidebarActionsContext.Provider>;
        const screen = await renderScreen(<runtime.Wrapper><AppPaneScopeHost scopeId={scopeId} arrangement="honour"
            main={<div>Chat</div>} wrapScopeContent={wrap} /></runtime.Wrapper>);
        try {
            await act(async () => {
                if (control === 'back' || control === 'page-chat') runtime.pane.setMainTab('navigation');
                if (control === 'close') runtime.pane.openRight({ tabId: 'info' });
                storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { 'shell.column.set': { enabled: false } } }) });
            });
            const before = runtime.pane.scopeState;
            const select = () => {
                switch (control) {
                    case 'page': screen.findByType(SegmentedTabBar).props.onSelectTab('navigation'); break;
                    case 'page-chat': screen.findByType(SegmentedTabBar).props.onSelectTab('chat'); break;
                    case 'header':
                    case 'screen-header': screen.findByType(RightSidebarIconTabBar).props.onSelectTab('files'); break;
                    case 'presentation': presentation.selectTab('navigation'); break;
                    case 'published-main': published.current!.main!.selectTab('navigation'); break;
                    case 'published-side': published.current!.selectTab('files'); break;
                    case 'back': presentation.backToTranscript(); break;
                    case 'close': screen.findAllByType(RightSidebarPaneHeader)
                        .find(header => header.props.testID === 'session-rightpanel-header')!.props.onClose(); break;
                }
            };
            await act(async () => { select(); });
            expect(runtime.pane.scopeState).toEqual(before);
            await expect.poll(() => vi.mocked(Modal.alert).mock.calls.length).toBeGreaterThan(0);
            await act(async () => {
                storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) });
                select();
            });
            await expect.poll(() => selectsSide
                ? runtime.pane.scopeState?.right.activeTabId
                : control === 'close' ? runtime.pane.scopeState?.right.isOpen
                    : runtime.pane.scopeState?.mainTabId).toBe(selectsSide
                ? 'files' : control === 'close' ? false : control === 'back' || control === 'page-chat' ? null : 'navigation');
        } finally { await screen.unmount(); }
    },
);

it('opens and closes People through the mounted rail without a Session Machine', async () => {
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId,
        metadata: { path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const screen = await renderScreen(<runtime.Wrapper>
        <SessionRightSidebarProvider sessionId="s1" scopeId={scopeId}><SessionActionRail /></SessionRightSidebarProvider>
    </runtime.Wrapper>);
    try {
        const pressPeople = () => {
            const actions: readonly RightSidebarRailAction[] = screen.findByType(RightSidebarActionRail).props.actions;
            const people = actions.find(action => action.id === 'collaboration');
            expect(people).toMatchObject({ disabled: false });
            people!.onPress();
        };
        await act(async () => { pressPeople(); });
        await expect.poll(() => runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'collaboration' });
        await act(async () => { pressPeople(); });
        await expect.poll(() => runtime.pane.scopeState?.right.isOpen).toBe(false);
    } finally { await screen.unmount(); }
});

it('keeps the selected main body while a companion opens and closes through the same column Actions', async () => {
    storage.getState().applyLocalSettings({ paneArrangement: 'editor', uiMultiPanePanelsEnabled: true }, { persist: false });
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const panelProps = { sessionId: 's1', scopeId };
    const sidebar = { render: () => <SessionRightPanel {...panelProps} />,
        renderActionRail: () => <SessionActionRail /> };
    const wrap = (content: React.ReactElement) => <SessionRightSidebarProvider {...panelProps}>{content}</SessionRightSidebarProvider>;
    const screen = await renderScreen(<PresentedDetailNavigationProvider><runtime.Wrapper><AppPaneScopeHost scopeId={scopeId} arrangement="honour"
        mainColumn={{ hideLabel: 'Hide Session', showLabel: 'Show Session', identity: { name: 'Test Session', mark: null } }} main={<div>Chat</div>}
        rightSidebarAdapter={sidebar} wrapScopeContent={wrap} /></runtime.Wrapper></PresentedDetailNavigationProvider>);
    try {
        const { readShellColumnActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
        const { Modal } = await import('@/modal');
        await act(async () => { await readShellColumnActionOwner('main')?.openNavigationCustomizer?.(); });
        const props = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].props as import('@/components/ui/navigation/NavigationPlacementCustomizer').DetailNavigationCustomizerProps;
        expect(props).toMatchObject({ pageKind: 'session', device: 'desktop', testID: 'session-navigation-customizer' });
        expect(props.desktop.map(section => section.id)).toEqual(['pages', 'companions']);
        expect(props.desktop[0]?.fixedItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'chat' })]));
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'navigation' })).toEqual({ ok: true });
        });
        expect(runtime.pane.scopeState?.mainTabId).toBe('navigation');
        expect(screen.findAllByType(SessionTranscriptNavigationPane)).toHaveLength(1);
        const navigationBody = screen.findByType(SessionTranscriptNavigationPane);
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'files' })).toEqual({ ok: true });
        });
        expect(runtime.pane.scopeState?.mainTabId).toBe('navigation');
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('files');
        expect(screen.findByType(SessionTranscriptNavigationPane)).toBe(navigationBody);
        expect(screen.findAllByType(SessionBrowseFilesSurface)).toHaveLength(1);
        expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ activeTab: 'navigation' });
        expect(await invokeScopeAction('shell.column.get', { column: 'side' })).toMatchObject({ activeTab: 'files', visible: true });
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: false })).toEqual({ ok: true });
        });
        expect(runtime.pane.scopeState?.mainTabId).toBe('navigation');
        expect(screen.findByType(SessionTranscriptNavigationPane)).toBe(navigationBody);
        await act(async () => {
            expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'chat' })).toEqual({ ok: true });
        });
        expect(runtime.pane.scopeState?.mainTabId).toBeNull();
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('files');
    } finally { await screen.unmount(); }
});

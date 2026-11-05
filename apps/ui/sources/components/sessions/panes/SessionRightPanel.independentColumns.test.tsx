import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from './sessionPaneScopeId';
import type { RightSidebarRailAction } from '@/components/appShell/rightSidebar/RightSidebarActionRail';

installSessionDetailsPanelCommonModuleMocks();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { SessionRightPanel, SessionActionRail, SessionRightSidebarProvider } = await import('./SessionRightPanel');
const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
const { SessionBrowseFilesSurface } = await import('./surfaces/SessionBrowseFilesSurface');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
const { PresentedDetailNavigationProvider } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');

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

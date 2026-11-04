// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { WorkspaceDestinationRow } from './WorkspaceDestinationRow';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WORKSPACE_OPEN_IN_NEW_TAB_ID, WORKSPACE_OPEN_TO_RIGHT_ID } from './useWorkspaceOpenActions';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { DetailsTabStrip } from '@/components/appShell/panes/details/workspace/DetailsTabStrip';
import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { ENTITY_DRAG_DELIVERY_MIME_V1 } from '@happier-dev/protocol/plugins/ui';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// The DOM portal is a browser boundary; the real menu remains inside this renderer's tree.
vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

function harness() {
    let state = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1' } }, pinned: false, preview: false });
    let id = 0;
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state,
        getCatalog: () => resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } }),
        dispatch: (action) => { state = reduceWorkspaceState(state, action); },
        transport: { commit: () => {} }, createId: () => `new:${++id}`, onChange: () => {},
    });
    const workspace: WorkspaceNavigationContextValue = {
        active: true, get state() { return state; }, canGoBack: false, canGoForward: false,
        openHref: adapter.openHref, activateTab: adapter.activateTab, closeTab: adapter.closeTab, closeTabs: adapter.closeTabs,
        findOpenHref: adapter.findOpenHref,
        catalog: resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } }),
        dispatch: adapter.dispatch, navigationForTab: () => { throw new Error('Unexpected instance navigation'); },
        registerBackStep: () => () => {}, back: () => adapter.step(-1), forward: () => adapter.step(1),
        canvasControlsRef: { current: {
            readSplitMeasurement: () => ({ availableSizePx: 1400, minimumExistingSizePx: 420 }),
            resizeSplit: () => false,
        } },
    };
    return { workspace, state: () => state };
}

describe('workspace destination row browser gestures', () => {
    const runtime = useEntityDragDropRuntime();
    let previousScope: ReturnType<typeof storage.getState>['profileScope'];
    beforeEach(() => {
        previousScope = storage.getState().profileScope;
        storage.setState({ profileScope: { serverId: 'home-b', accountId: 'account-a' } });
    });
    afterEach(() => {
        act(() => {
            runtime.cancel();
            storage.setState({ profileScope: previousScope });
        });
        standardCleanup();
    });
    it('opens the shared menu with the context-menu key and Shift-F10 while leaving text controls alone', async () => {
        const h = harness();
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
            <WorkspaceDestinationRow href="/session/B1?serverId=home-b"><ViewBoundary /></WorkspaceDestinationRow>
        </WorkspaceNavigationProvider>);
        const host = document.createElement('div');
        const primary = document.createElement('div');
        primary.setAttribute('role', 'treeitem');
        const input = document.createElement('input');
        host.append(primary, input);
        screen.root.findAllByType('View')[0].props.ref(host);
        for (const key of [new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
            new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })]) {
            await act(async () => { primary.dispatchEvent(key); });
            expect(key.defaultPrevented).toBe(true);
            expect(screen.findByType(DropdownMenu).props.items.some((item: { id: string }) => item.id === WORKSPACE_OPEN_IN_NEW_TAB_ID)).toBe(true);
            await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(false); });
        }
        const editorMenu = new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
        input.dispatchEvent(editorMenu);
        expect(editorMenu.defaultPrevented).toBe(false);
        expect(screen.findAllByType(DropdownMenu)).toHaveLength(0);
    });
    it('routes context gestures once into a row-owned menu that already consumes the shared items', async () => {
        const h = harness();
        const openExistingMenu = vi.fn();
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
            <WorkspaceDestinationRow href="/session/B1?serverId=home-b" existingMenu onOpenExistingMenu={openExistingMenu}><ViewBoundary /></WorkspaceDestinationRow>
        </WorkspaceNavigationProvider>);
        const host = document.createElement('div');
        screen.root.findAllByType('View')[0].props.ref(host);
        const pointer = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        const keyboard = new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true });
        await act(async () => { host.dispatchEvent(pointer); host.dispatchEvent(keyboard); });
        expect([pointer.defaultPrevented, keyboard.defaultPrevented]).toEqual([true, true]);
        expect(openExistingMenu).toHaveBeenCalledTimes(2);
        expect(screen.findAllByType(DropdownMenu)).toHaveLength(0);
    });
    it('registers a typed folder without a navigation href', async () => {
        const item = { kind: 'repository-file', scope: { serverId: 'home-b', accountId: 'account-a' }, machineId: 'machine', path: '/workspace/src', entryKind: 'directory' } as const;
        let openMenu: (() => void) | undefined;
        const screen = await renderScreen(<WorkspaceDestinationRow href={null} entityItem={item} entityTitle="src/">{actions => {
            openMenu = actions.openMenu;
            return <ViewBoundary />;
        }}</WorkspaceDestinationRow>);
        const host = document.createElement('div');
        screen.root.findAllByType('View')[0].props.ref(host);
        const drag = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(drag, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '' } });
        act(() => { host.dispatchEvent(drag); });
        expect(runtime.getSnapshot().item).toEqual(item);
        act(() => { runtime.cancel(); openMenu?.(); });
        expect(screen.findByType(DropdownMenu).props.items).toContainEqual(expect.objectContaining({ id: 'entity.mentionInComposer' }));
    });
    it('lets a Details tab middle click reach guarded close without outward-opening its non-null href', async () => {
        const h = harness();
        const tab = { key: 'file:src/app.ts', kind: 'file', title: 'app.ts', isPinned: true, isPreview: false,
            resource: { kind: 'file', path: 'src/app.ts' } } as const;
        const closeDetailsTab = vi.fn();
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        const remove = registerMountedTabUnsavedChangesGuard(tab.key, {
            isDirtyRef: { current: true }, tag: 'file-editor', requestDecision,
        });
        try {
            const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
                <DetailsTabStrip sessionId="B1" serverId="home-b"
                    pane={{ setActiveDetailsTab: () => {}, pinDetailsTab: () => {}, unpinDetailsTab: () => {}, closeDetailsTab }}
                    group={{ id: 'details', tabKeys: [tab.key], activeTabKey: tab.key, tabs: [tab], isFocused: true }}
                    testIds={{ tab: () => 'file-tab-primary' }} />
            </WorkspaceNavigationProvider>);
            const destination = screen.root.findByType(WorkspaceDestinationRow);
            expect(destination.props.href).toContain('/session/B1/details');
            const host = document.createElement('div');
            const primary = document.createElement('div');
            primary.setAttribute('role', 'tab');
            host.append(primary);
            // Match the existing native-host boundary: real capture and bubble listeners share a DOM tree.
            destination.findAllByType('View')[0].props.ref(host);
            const tabPress = screen.findHostByTestId('file-tab-primary')!;
            primary.addEventListener('auxclick', event => tabPress.props.onAuxClick(event));
            const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
            await act(async () => { primary.dispatchEvent(middle); });
            expect(Object.keys(h.state().tabs)).toEqual(['A']);
            expect(requestDecision).toHaveBeenCalledTimes(1);
            expect(closeDetailsTab).not.toHaveBeenCalled();
            expect(middle.defaultPrevented).toBe(true);
            await act(async () => {
                primary.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }));
            });
            expect(Object.values(h.state().tabs).some(entry => entry.target.kind === 'sessionDetails')).toBe(true);
            expect(closeDetailsTab).not.toHaveBeenCalled();
        } finally { remove(); }
    });
    it('opens the mixed-list Workflow Run row through the same kept-tab gesture owner', async () => {
        const previous = storage.getState();
        const h = harness();
        try {
            storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                createWorkflowRunSummaryFixture({ id: 'run-gesture', startedBy: 'user' }),
                { kind: 'available', value: { title: 'Gesture Run' } },
            )]);
            const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
                <WorkflowRunItemBody kind="workflow_run" runId="run-gesture" serverId="server-a" dataActive={false} />
            </WorkspaceNavigationProvider>);
            const host = document.createElement('div');
            const primary = document.createElement('button');
            host.appendChild(primary);
            for (const view of screen.root.findAllByType(View).filter(node => typeof node.props.ref === 'function')) {
                view.props.ref(host);
            }
            vi.stubGlobal('navigator', { platform: 'MacIntel' });
            const event = new MouseEvent('click', { metaKey: true, bubbles: true, cancelable: true });
            primary.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
            expect(Object.values(h.state().tabs).find((tab) => tab.target.kind === 'workflowRun')).toMatchObject({
                preview: false, target: { params: { runId: 'run-gesture' } },
            });
        } finally {
            vi.unstubAllGlobals();
            act(() => storage.setState(previous));
        }
    });
    it('does not drag non-shareable Details resources to the base session instead', async () => {
        const h = harness();
        const tab = { key: 'browser-view:browser:view', kind: 'browser-view', title: 'Docs', isPinned: false, isPreview: false,
            resource: { kind: 'browser-view', browserSessionId: 'browser', viewId: 'view',
                target: { kind: 'externalUrl', targetId: 'target', url: 'https://docs.test' } },
        } as const;
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
            <DetailsTabStrip sessionId="B1" serverId="home-b"
                pane={{ setActiveDetailsTab: () => {}, pinDetailsTab: () => {}, unpinDetailsTab: () => {}, closeDetailsTab: () => {} }}
                group={{ id: 'details', tabKeys: [tab.key], activeTabKey: tab.key, tabs: [tab], isFocused: true }} />
        </WorkspaceNavigationProvider>);
        const host = document.createElement('div');
        // Host refs are the native/browser boundary; all destination and serializer logic stays real.
        for (const row of screen.root.findAllByType(View).filter(node => typeof node.props.ref === 'function')) row.props.ref(host);
        const setData = vi.fn();
        const drag = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(drag, 'dataTransfer', { value: { setData, effectAllowed: '' } });
        host.dispatchEvent(drag);
        expect(setData).not.toHaveBeenCalled();
        const file = { key: 'file:src/app.ts', kind: 'file', title: 'app.ts', isPinned: false, isPreview: false,
            resource: { kind: 'file', path: 'src/app.ts' },
        } as const;
        await act(async () => { screen.update(<WorkspaceNavigationProvider value={h.workspace}>
            <DetailsTabStrip sessionId="B1" serverId="home-b"
                pane={{ setActiveDetailsTab: () => {}, pinDetailsTab: () => {}, unpinDetailsTab: () => {}, closeDetailsTab: () => {} }}
                group={{ id: 'details', tabKeys: [file.key], activeTabKey: file.key, tabs: [file], isFocused: true }} />
        </WorkspaceNavigationProvider>); });
        const destination = screen.root.findByType(WorkspaceDestinationRow);
        destination.findAllByType('View')[0].props.ref(host);
        host.dispatchEvent(drag);
        const data = runtime.getSnapshot().item;
        expect(data?.kind).toBe('destination');
        if (data?.kind !== 'destination') throw new Error('Expected a shareable Details file destination');
        const href = new URL(data.href, 'https://happier.test');
        expect(href.pathname).toBe('/session/B1/details');
        expect(Object.fromEntries(href.searchParams)).toMatchObject({ serverId: 'home-b', details: 'file', path: 'src/app.ts' });
    });
    it('opens kept tabs from pointer and menu intent, and carries their scoped href into the tab bar', async () => {
        const h = harness();
        const href = '/session/B1?serverId=home-b';
        const screen = await renderScreen(<WorkspaceNavigationProvider value={h.workspace}>
            <WorkspaceDestinationRow href={href}><ViewBoundary /></WorkspaceDestinationRow>
        </WorkspaceNavigationProvider>);
        const root = document.createElement('div');
        // Match real row/tab anatomy: the primary target precedes its independent close/pin targets.
        const primary = document.createElement('div');
        primary.setAttribute('role', 'treeitem');
        const pin = document.createElement('button');
        const close = document.createElement('button');
        root.append(primary, pin, close);
        screen.root.findAllByType('View')[0].props.ref(root);
        const ordinary = new MouseEvent('click', { bubbles: true, cancelable: true });
        root.dispatchEvent(ordinary);
        expect(Object.keys(h.state().tabs)).toEqual(['A']);
        expect(ordinary.defaultPrevented).toBe(false);

        for (const control of [pin, close]) {
            const secondary = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true });
            control.dispatchEvent(secondary);
            expect(secondary.defaultPrevented).toBe(false);
            expect(Object.keys(h.state().tabs)).toEqual(['A']);
            const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            control.dispatchEvent(context);
            expect(context.defaultPrevented).toBe(false);
        }

        const alt = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true });
        primary.dispatchEvent(alt);
        expect(alt.defaultPrevented).toBe(true);
        expect(Object.values(h.state().tabs).find(tab => tab.target.params.id === 'B1')).toMatchObject({ preview: false, pinned: false });
        root.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        primary.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true, cancelable: true }));
        vi.stubGlobal('navigator', { platform: 'Win32' });
        primary.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }));
        vi.unstubAllGlobals();
        const keptTabs = Object.values(h.state().tabs).filter(tab => tab.target.params.id === 'B1');
        expect(keptTabs).toHaveLength(4);
        expect(keptTabs.every(tab => !tab.preview && tab.target.params.serverId === 'home-b')).toBe(true);

        const setData = vi.fn();
        const drag = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(drag, 'dataTransfer', { value: { setData, effectAllowed: '' } });
        root.dispatchEvent(drag);
        expect(runtime.getSnapshot().item).toEqual({ kind: 'session',
            scope: { serverId: 'home-b', accountId: 'account-a' }, address: { serverId: 'home-b', sessionId: 'B1' } });
        // The browser sees a delivery hint and the destination title as plain text, never the scoped Session identity.
        expect(setData.mock.calls[0]).toEqual([ENTITY_DRAG_DELIVERY_MIME_V1, '']);
        expect(setData.mock.calls.slice(1).map(([type]) => type)).toEqual(['text/plain']);
        expect(JSON.stringify(setData.mock.calls)).not.toMatch(/home-b|account-a|B1/);
        runtime.cancel();

        await act(async () => { root.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 30, bubbles: true, cancelable: true })); });
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.open).toBe(true);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toContain(WORKSPACE_OPEN_IN_NEW_TAB_ID);
        await act(async () => { menu.props.onSelect(WORKSPACE_OPEN_TO_RIGHT_ID); });
        expect(Object.keys(h.state().groups)).toHaveLength(2);

        // A retained virtualized row/tab may move to another scope without remounting its DOM host.
        const projectHref = buildProjectRouteHref({ workspaceRefId: 'project-b', segment: 'code',
            activeRootPath: '/work/branch', defaultRootPath: '/work/main', activeWorktreeId: 'branch-b',
            sourceSurface: 'browse', initialResource: { kind: 'file', path: 'src/app.ts' },
        });
        await act(async () => { screen.update(<WorkspaceNavigationProvider value={h.workspace}>
            <WorkspaceDestinationRow href={projectHref}><ViewBoundary /></WorkspaceDestinationRow>
        </WorkspaceNavigationProvider>); });
        root.dispatchEvent(drag);
        expect(runtime.getSnapshot().item).toEqual({ kind: 'destination',
            scope: { serverId: 'home-b', accountId: 'account-a' }, href: projectHref });
        primary.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
        expect(Object.values(h.state().tabs).find(tab => tab.target.kind === 'project')).toMatchObject({
            preview: false, target: { params: { workspaceRefId: 'project-b', worktreeId: 'branch-b', initialFile: 'src/app.ts' } },
        });
    });
});

function ViewBoundary() { return React.createElement('Row'); }

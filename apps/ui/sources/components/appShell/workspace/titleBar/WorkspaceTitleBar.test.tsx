import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import type { SplitCanvasHostControls } from '../../splitCanvas/components/SplitCanvasHost';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '../WorkspaceNavigationContext';
import { WorkspaceShell } from '../WorkspaceShell';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState, type WorkspaceTab } from '../workspaceState';
import { WorkspaceTitleBar } from './WorkspaceTitleBar';
import { createWorkspaceBarGeometry, WorkspaceBarGeometryContext } from './workspaceBarGeometry';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
// The popover's portal/measurement boundary renders open menus inline; the menus themselves are real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

type WindowFrame = Readonly<{ x: number; width: number }>;

/** The platform's window measurement, per measured view (the only boundary between panes and the strip). */
function windowMeasurement(frames: Readonly<Record<string, WindowFrame>>) {
    return (element: React.ReactElement<{ testID?: string }>) => {
        const frame = element.props.testID ? frames[element.props.testID] : undefined;
        return frame
            ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(frame.x, 0, frame.width, 800) }
            : null;
    };
}

function tab(id: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
    return { id, target: { kind: `removed:${id}`, params: {} }, pinned: false, preview: false, ...overrides };
}

function Harness(props: Readonly<{ initial: WorkspaceState; clusterEndPx: number; trailingStartPx?: number }>) {
    const [state, dispatch] = React.useReducer(reduceWorkspaceState, props.initial);
    const canvasControlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const [geometry] = React.useState(createWorkspaceBarGeometry);
    const value: WorkspaceNavigationContextValue = {
        active: true, state, dispatch, canvasControlsRef,
        closeTab: (groupId, tabId) => dispatch({ type: 'closeTab', groupId, tabId, newTab: tab('empty', { target: { kind: 'newTab', params: {} } }) }),
        closeTabs: (groupId, tabIds) => {
            for (const tabId of tabIds) if (!state.tabs[tabId]?.pinned) dispatch({ type: 'closeTab', groupId, tabId, newTab: tab('empty', { target: { kind: 'newTab', params: {} } }) });
        },
        activateTab: (groupId, tabId) => dispatch({ type: 'activateTab', groupId, tabId }),
        canGoBack: false, canGoForward: false, openHref: () => false,
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return <WorkspaceNavigationContext.Provider value={value}>
        <WorkspaceBarGeometryContext.Provider value={geometry}>
            {React.createElement('WorkspaceStateProbe', { state })}
            <WorkspaceTitleBar catalog={[]} clusterEndPx={props.clusterEndPx} stripHeightPx={40} trailingStartPx={props.trailingStartPx} />
            <WorkspaceShell catalog={[]} />
        </WorkspaceBarGeometryContext.Provider>
    </WorkspaceNavigationContext.Provider>;
}

function stateOf(screen: Awaited<ReturnType<typeof renderScreen>>): WorkspaceState {
    return screen.root.findByType('WorkspaceStateProbe' as unknown as React.ElementType).props.state;
}

function hasTestId(node: ReactTestInstance, testID: string): boolean {
    return node.findAll((candidate) => candidate.props?.testID === testID).length > 0;
}

/** Group 1 (a, b) | group 2 (c) over group 3 (d): two top-row panes and one below. */
function threePanes(): WorkspaceState {
    let state = reduceWorkspaceState(createWorkspaceState(tab('a')), { type: 'openTab', groupId: 'group:1', tab: tab('b') });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c') });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('d') });
    state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'c', sourceGroupId: 'group:1', targetGroupId: 'group:1',
        newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
    state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'd', sourceGroupId: 'group:1', targetGroupId: 'group:2',
        newGroupId: 'group:3', axis: 'column', placement: 'after', availableSizePx: 800, minimumFirstSizePx: 200, minimumSecondSizePx: 200 });
    return reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'a' });
}

describe('WorkspaceTitleBar', () => {
    it('reserves the measured trailing control span, including a resize that hides a covered pane', async () => {
        const frames = windowMeasurement({
            'workspace-title-bar': { x: 0, width: 1440 },
            'workspace-group-group_1': { x: 300, width: 560 },
            'workspace-group-group_2': { x: 870, width: 560 },
        });
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={200} trailingStartPx={1200} />, { createNodeMock: frames });
        expect(screen.findByTestId('workspace-bar-segment-group:2')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 870, width: 330 })]));
        await act(async () => { screen.tree.update(<Harness initial={threePanes()} clusterEndPx={200} trailingStartPx={850} />); });
        expect(screen.findByTestId('workspace-bar-segment-group:2')).toBeNull();
        expect(screen.findByTestId('workspace-bar-segment-group:1')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 300, width: 550 })]));
    });
    it('offers recently closed tabs even when all open tabs fit and reopens the chosen tab', async () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b'), fallbackTitle: 'Closed document' });
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'b', newTab: tab('blank', { target: { kind: 'newTab', params: {} } }) });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 1100 } }),
        });
        expect(screen.findByTestId('workspace-overflow-group_1')).not.toBeNull();
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        await screen.pressByTestIdAsync('workspace-reopen-tab-b');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('b');
        expect(stateOf(screen).recentlyClosed).toEqual([]);
    });
    it('puts each top-row pane\'s tabs in the window strip over that pane and keeps a strip for a pane below', async () => {
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({
                'workspace-title-bar': { x: 0, width: 1440 },
                'workspace-group-group_1': { x: 300, width: 560 },
                'workspace-group-group_2': { x: 870, width: 560 },
                'workspace-group-group_3': { x: 870, width: 560 },
            }),
        });
        const first = screen.findByTestId('workspace-bar-segment-group:1');
        const second = screen.findByTestId('workspace-bar-segment-group:2');
        expect(first && hasTestId(first, 'workspace-tab-a') && hasTestId(first, 'workspace-tab-b')).toBe(true);
        expect(second && hasTestId(second, 'workspace-tab-c')).toBe(true);
        expect(screen.findByTestId('workspace-bar-segment-group:3')).toBeNull();
        // Over its pane: the segment spans exactly the pane's measured span.
        expect(first?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ left: 300, width: 560 })]));

        // The top-row panes keep no strip of their own; the pane below keeps one with its tabs.
        const top = screen.findByTestId('workspace-group-group_1');
        const below = screen.findByTestId('workspace-group-group_3');
        expect(top && hasTestId(top, 'workspace-tabs-group_1')).toBe(false);
        expect(below && hasTestId(below, 'workspace-tab-d')).toBe(true);

        // The raised tab is the whole focus signal: panes draw no card, ring or controls of their own.
        expect(screen.root.findAll((node) => typeof node.props?.testID === 'string'
            && /^split-canvas-leaf-(maximize|close)-/.test(node.props.testID))).toHaveLength(0);

        // A tab in the strip is the pane's own tab: pressing it focuses that pane.
        await act(async () => { second?.findAll((node) => node.props?.testID === 'workspace-tab-c' && typeof node.props.onPress === 'function')[0]?.props.onPress(); });
        expect(stateOf(screen).focusedGroupId).toBe('group:2');
    });

    it('starts the first pane\'s tabs after the strip\'s own controls when the pane reaches under them', async () => {
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={360} />, {
            createNodeMock: windowMeasurement({
                'workspace-title-bar': { x: 0, width: 1440 },
                'workspace-group-group_1': { x: 56, width: 804 },
                'workspace-group-group_2': { x: 870, width: 560 },
            }),
        });
        expect(screen.findByTestId('workspace-bar-segment-group:1')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 372, width: 488 })]));
    });

    it('names a session tab after the session, live: renaming the session renames its tab', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const named = (text: string) => createSessionFixture({
            id: 'session-live',
            metadata: { path: '/Users/tester/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1',
                summary: { text, updatedAt: 1 } } as never,
        });
        act(() => { storage.getState().applySessions([named('Fix settings modal remount')]); });
        // The session tab stays unvisited, so only its title is in play (its body never mounts).
        const state = reduceWorkspaceState(createWorkspaceState(tab('s', { target: { kind: 'session', params: { id: 'session-live' } } })),
            { type: 'openTab', groupId: 'group:1', tab: tab('other') });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 900 } }),
        });
        const segment = () => screen.findByTestId('workspace-bar-segment-group:1');
        const titles = () => (segment()?.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children) ?? []);
        expect(titles()).toContain('Fix settings modal remount');

        await act(async () => { storage.getState().applySessions([named('Key the settings modal by route')]); });
        expect(titles()).toContain('Key the settings modal by route');
        expect(titles()).not.toContain('Fix settings modal remount');
    });

    it('collapses the tabs that do not fit behind +N, keeps the open one, and closes the others from a tab\'s menu', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        let state = createWorkspaceState(tab('a', { pinned: true }));
        for (const id of ids.slice(1)) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'b' });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 600 } }),
        });
        const visibleTabs = () => ids.filter((id) => screen.findAllByTestId(`workspace-tab-${id}`).length > 0);
        expect(visibleTabs()).toEqual(ids);

        await act(async () => { screen.findByTestId('workspace-tabs-group_1')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 30 } } }); });
        const shown = visibleTabs();
        expect(shown.length).toBeLessThan(ids.length);
        expect(shown).toEqual(expect.arrayContaining(['a', 'b']));
        const overflow = screen.findByTestId('workspace-overflow-group_1');
        expect(overflow?.props.accessibilityLabel).toBe('workspaceBar.moreTabs');

        // +N lists every tab of the pane; choosing a hidden one opens it in the bar.
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        // A menu opens on the frame after the press that asked for it.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        await screen.pressByTestIdAsync('workspace-overflow-tab-h');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('h');
        expect(visibleTabs()).toContain('h');

        // "Close other tabs" keeps the tab and the pinned tab.
        const h = screen.findAllByTestId('workspace-tab-h').find((node) => typeof node.props.onLongPress === 'function');
        await act(async () => { h?.props.onLongPress({}); });
        await screen.pressByTestIdAsync('workspace-tab-menu-close-others');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['a', 'h']);
        // Open-tab overflow is gone, but every explicit close remains reachable for undo.
        expect(screen.findByTestId('workspace-overflow-group_1')?.props.accessibilityLabel).toBe('workspaceTabs.recentlyClosed');
        expect(stateOf(screen).recentlyClosed.map(entry => entry.tab.id)).toEqual(ids.slice(1, -1).reverse());
    });
});

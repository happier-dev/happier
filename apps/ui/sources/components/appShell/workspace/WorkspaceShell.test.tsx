import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { resolveDestinationRefFromHref, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { WorkspaceShell } from './WorkspaceShell';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';

installPanelCommonModuleMocks();
// Expo's module-loader boundary supplies the empty new-tab body used by this shell journey.
registerWorkspaceRouteContext((key) => {
    if (key !== './(app)/index.tsx') throw new Error(`Unexpected shell route: ${key}`);
    return { WorkspaceRouteBody: () => null };
});
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// The popover's portal/measurement boundary renders the open tab menu inline; the menu itself is real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function Harness(props: Readonly<{ initial: WorkspaceState }>) {
    const [state, dispatch] = React.useReducer(reduceWorkspaceState, props.initial);
    // The provider's handle on the canvas, as WorkspaceProvider supplies it.
    const canvasControlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const closeTab = (groupId: string, tabId: string) => dispatch({ type: 'closeTab', groupId, tabId,
        newTab: { id: 'empty', target: { kind: 'newTab', params: {} }, pinned: false, preview: false } });
    const value: WorkspaceNavigationContextValue = {
        active: true, state, dispatch, closeTab, canvasControlsRef,
        closeTabs: (groupId, tabIds) => { for (const tabId of tabIds) if (!state.tabs[tabId]?.pinned) closeTab(groupId, tabId); },
        activateTab: (groupId, tabId) => dispatch({ type: 'activateTab', groupId, tabId }),
        canGoBack: false, canGoForward: false, openHref: () => false,
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return <WorkspaceNavigationContext.Provider value={value}>
        <StateProbe state={state} />
        <WorkspaceShell catalog={[]} />
    </WorkspaceNavigationContext.Provider>;
}

function StateProbe(props: Readonly<{ state: WorkspaceState }>) {
    return React.createElement('WorkspaceStateProbe', props);
}

function initialState() {
    return reduceWorkspaceState(createWorkspaceState({ id: 'a', target: { kind: 'removed:a', params: {} }, pinned: false, preview: false }),
        { type: 'openTab', groupId: 'group:1', tab: { id: 'b', target: { kind: 'removed:b', params: {} }, pinned: false, preview: true } });
}

function stateOf(screen: Awaited<ReturnType<typeof renderScreen>>): WorkspaceState {
    return screen.root.findByType('WorkspaceStateProbe').props.state;
}

/** Opens a tab's menu (press and hold) and chooses one of its items; the menu commits once closed. */
async function chooseFromTabMenu(screen: Awaited<ReturnType<typeof renderScreen>>, tabId: string, itemTestId: string) {
    const tab = screen.findAllByTestId(`workspace-tab-${tabId}`).find((node) => typeof node.props.onLongPress === 'function');
    if (!tab) throw new Error(`Tab ${tabId} offers no menu`);
    await act(async () => { tab.props.onLongPress({}); });
    await screen.pressByTestIdAsync(itemTestId);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
}

function measureCanvas(screen: Awaited<ReturnType<typeof renderScreen>>, width: number, height: number) {
    const event = { nativeEvent: { layout: { width, height, x: 0, y: 0 } } };
    screen.findByTestId('split-canvas-host')?.props.onLayout(event);
    screen.findByTestId('split-canvas-leaf-interaction-surface-group:1')?.props.onLayout(event);
}

describe('WorkspaceShell', () => {
    it('provides discoverable toolbar actions through the shared button interaction owner', async () => {
        const screen = await renderScreen(<Harness initial={initialState()} />);
        const button = screen.findByTestId('workspace-new-tab-group_1');
        expect(button?.props.accessibilityLabel).toBe('workspaceBar.newTab');
        const background = () => {
            const style = screen.findByTestId('workspace-new-tab-group_1')?.props.style;
            const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
            const entries = Array.isArray(resolved) ? resolved.flat(Infinity) : [resolved];
            return Object.assign({}, ...entries.filter(Boolean)).backgroundColor;
        };
        const idleBackground = background();
        await act(async () => {
            button?.props.onHoverIn?.({});
        });
        expect(background()).not.toBe(idleBackground);
        await act(async () => { button?.props.onPress(); });
        expect(stateOf(screen).tabs[stateOf(screen).groups['group:1'].activeTabId].target.kind).toBe('newTab');
    });

    it('moves a singleton plugin tab into a split and leaves a new-tab target in its empty source', () => {
        const catalog: readonly CompactAppDestination[] = [{
            id: 'plugin:acme.notes:notes', kind: 'plugin', container: 'appPage',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            title: 'Notes', icon: 'note', order: 40, placement: { kind: 'rail', region: 'plugins' },
            activation: 'navigate', routePath: '/plugins/acme.notes/notes', availability: 'available',
        }];
        const target = resolveDestinationRefFromHref(catalog, '/plugins/acme.notes/notes/first');
        if (!target) throw new Error('The singleton catalog fixture must resolve its route');
        const pluginTab = { id: 'singleton-notes', target, pinned: true, preview: false };
        const state = reduceWorkspaceState(createWorkspaceState(pluginTab), {
            type: 'splitTab', tabId: pluginTab.id, sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420,
            newTabForSource: { id: 'source-new', target: { kind: 'newTab', params: {} }, pinned: false, preview: false },
        });
        expect(Object.values(state.tabs).filter((tab) => tab.target.kind === target.kind)).toEqual([pluginTab]);
        expect(state.groups['group:2'].tabIds).toEqual([pluginTab.id]);
        expect(state.groups['group:1'].tabIds).toEqual(['source-new']);
        expect(state.tabs['source-new'].target.kind).toBe('newTab');
        expect(state.focusedGroupId).toBe('group:2');
    });

    it('retains visited tabs without mounting unopened tabs and releases closed bodies', async () => {
        const screen = await renderScreen(<Harness initial={initialState()} />);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['b']);
        await act(async () => { screen.findByTestId('workspace-tab-a')?.props.onPress(); });
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('a');
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['a', true, true], ['b', false, false]]);
        await act(async () => { screen.findByTestId('workspace-tab-b')?.props.onPress(); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['a', false, false], ['b', true, true]]);
        await chooseFromTabMenu(screen, 'a', 'workspace-tab-menu-pin');
        expect(stateOf(screen).tabs.a).toMatchObject({ pinned: true, preview: false });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-pin');
        expect(stateOf(screen).tabs.b).toMatchObject({ pinned: true, preview: false });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-close');
        expect(stateOf(screen).tabs.b).toBeUndefined();
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('a');
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['a']);
    });

    it('refuses an unmeasured split, then moves the selected tab using the measured group extent', async () => {
        const screen = await renderScreen(<Harness initial={initialState()} />);
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right');
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        await act(async () => { measureCanvas(screen, 1200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right');
        const state = stateOf(screen);
        expect(Object.keys(state.groups)).toHaveLength(2);
        expect(state.groups['group:1'].tabIds).toEqual(['a']);
        expect(state.groups[state.focusedGroupId].tabIds).toEqual(['b']);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.focused, node.props.visible]))
            .toEqual([['a', false, true], ['b', true, true]]);
    });

    it('keeps a split below the two existing minimum widths in one pane', async () => {
        const screen = await renderScreen(<Harness initial={initialState()} />);
        await act(async () => { measureCanvas(screen, 500, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right');
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        expect(stateOf(screen).tabs.b.target.kind).toBe('removed:b');
    });

    it('splits down using the existing minimum height and collapses the new pane when its tab closes', async () => {
        const screen = await renderScreen(<Harness initial={initialState()} />);
        await act(async () => { measureCanvas(screen, 800, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-down');
        expect(stateOf(screen).root).toMatchObject({ kind: 'split', axis: 'column' });
        await act(async () => { screen.findByTestId('workspace-tab-close-b')?.props.onPress({}); });
        expect(stateOf(screen).root).toMatchObject({ kind: 'leaf', id: 'group:1' });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['a']);
    });

    it('uses the normal canvas budget while maximized and reveals the focused destination after an admitted split', async () => {
        let initial = reduceWorkspaceState(initialState(), { type: 'openTab', groupId: 'group:1',
            tab: { id: 'c', target: { kind: 'removed:c', params: {} }, pinned: false, preview: false } });
        initial = reduceWorkspaceState(initial, { type: 'splitTab', tabId: 'c', sourceGroupId: 'group:1',
            targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 2190, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
        initial = reduceWorkspaceState(initial, { type: 'toggleMaximize', groupId: 'group:1' });
        const screen = await renderScreen(<Harness initial={initial} />);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['b']);

        // The maximized leaf reports the whole canvas; its normal half is too small to split.
        await act(async () => { measureCanvas(screen, 1600, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right');
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(2);
        expect(stateOf(screen).maximizedGroupId).toBe('group:1');

        await act(async () => { measureCanvas(screen, 2200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right');
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(3);
        expect(stateOf(screen).maximizedGroupId).toBeNull();
        expect(screen.root.findAllByType(DestinationInstanceHost).filter((node) => node.props.focused)
            .map((node) => [node.props.tabId, node.props.visible])).toEqual([['b', true]]);
    });
});

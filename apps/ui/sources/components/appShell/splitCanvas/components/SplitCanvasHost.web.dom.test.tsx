/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { isWorkspaceActionId } from '@happier-dev/protocol';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { useEntityDragDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { resolveCompactAppDestinations } from '../../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '../../workspace/workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from '../../workspace/workspaceActions';
import { createWorkspaceState, reduceWorkspaceState } from '../../workspace/workspaceState';
import type { WorkspaceNavigationContextValue } from '../../workspace/WorkspaceNavigationContext';
import { resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from '../../workspace/workspaceEntityDrop';
import { presentPaneDropAdmission } from '../presentation/paneDropPresentation';
import { SplitCanvasHost, type SplitCanvasHostControls } from './SplitCanvasHost';

// RNW supplies the real DOM hosts and drag delivery. Theme/native OS facilities are boundaries.
vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { StyleSheet } = await vi.importActual<typeof import('react-native')>('react-native-web');
    return createUnistylesMock({ styleSheet: { absoluteFillObject: StyleSheet.absoluteFillObject } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const scope = { serverId: 'home', accountId: 'account' };
const scratch: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of scratch.splice(0)) await dispose(); vi.unstubAllGlobals(); });

async function harness(width = 1400) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // jsdom has no layout engine. This boundary supplies one pane's viewport measurement;
    // actual RNW rendering, source delivery, target registration, admission and reducers run.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return new DOMRect(this.dataset.testid?.includes('drag-source') ? 0 : 100, 80, width, 600);
    });
    scratch.push(async () => { vi.restoreAllMocks(); });
    const runtime = createEntityDragDropRuntime();
    let state = createWorkspaceState({ id: 'anchor', target: { kind: 'session', params: { id: 'existing', ...scope } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
    let sequence = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog, getScope: () => scope,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `id:${++sequence}`,
        transport: { commit: () => {} }, onChange: () => {} });
    const workspace: WorkspaceNavigationContextValue = { active: true, get state() { return state; }, catalog,
        ...navigation, canGoBack: false, canGoForward: false,
        back: () => navigation.step(-1), forward: () => navigation.step(1),
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }), registerBackStep: () => () => {} };
    const controlsRef: { current: SplitCanvasHostControls | null } = { current: null };
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => controlsRef.current, createId: () => `id:${++sequence}` });
    let item: EntityDragItemV1 = { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'new-session' } };
    runtime.registerSource({ id: 'source', scope, getItem: () => item, isCurrent: () => true });
    function Source() {
        const ref = useEntityDragDomBinding({ runtime, sourceId: 'source', enabled: true });
        return <View ref={ref} testID="drag-source" />;
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    scratch.push(async () => { await act(async () => root.unmount()); container.remove(); });
    const tree = () => <><Source /><SplitCanvasHost
        state={{ root: state.root, focusedLeafId: state.focusedGroupId, maximizedLeafId: null }}
        dispatch={() => {}} controlsRef={controlsRef} keyboardEnabled={false}
        getLeafMinimumSizePx={() => ({ width: 400, height: 100 })}
        renderLeafHeader={() => <View testID="pane-header" />}
        retainedLeafContents={[{ id: 'anchor', leafId: 'group:1', isActive: true, render: () => <View testID="transcript" /> }]}
        entityDrop={{ runtime, id: 'workspace', scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
            resolve: input => presentPaneDropAdmission(resolveWorkspaceEntityDrop({ ...input, workspace, scope, catalog, workspaceRefs: [] }),
                { paneId: input.target.leafId, paneTitle: null, locateTab: () => null }),
            execute: async effect => {
                if (!isWorkspaceActionId(effect.actionId)) throw new Error('Expected workspace action');
                const result = execute(effect.actionId, effect.input);
                return result.ok ? { status: 'applied' } : { status: 'refused', reason: { code: result.errorCode, message: result.error } };
            },
        }} /></>;
    await act(async () => { root.render(tree()); });
    const host = container.querySelector<HTMLElement>('[data-testid="split-canvas-host"]')!;
    // RNW's onLayout is driven by ResizeObserver in a browser. Supply its layout
    // observation here, since jsdom cannot produce that OS measurement.
    const onLayout = Reflect.get(host, '__reactLayoutHandler') as (event: unknown) => void;
    await act(async () => { onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } } }); });
    const slot = container.querySelector<HTMLElement>('[data-testid="split-canvas-content-slot-group:1"]')!;
    const onSlotLayout = Reflect.get(slot, '__reactLayoutHandler') as (event: unknown) => void;
    await act(async () => { onSlotLayout({ nativeEvent: { layout: { x: 0, y: 40, width, height: 560 } } }); });
    const event = async (type: string, x: number, y: number) => {
        const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
        await act(async () => { (type === 'dragstart' ? container.querySelector('[data-testid="drag-source"]')! : host).dispatchEvent(e); });
    };
    return { container, runtime, workspace, navigation, setItem: (next: EntityDragItemV1) => { item = next; },
        begin: () => event('dragstart', 20, 380), move: (x: number, y = 380) => event('dragover', x, y),
        drop: (x: number, y = 380) => event('drop', x, y) };
}

describe('pane DOM carry through workspace owners', () => {
    it('paints pane feedback above the retained transcript', async () => {
        const h = await harness();
        await h.begin(); await h.move(1450);
        const zone = h.container.querySelector<HTMLElement>('[data-testid="split-canvas-drop-overlay-group:1-right"]')!;
        expect(zone).not.toBeNull();
        const transcript = h.container.querySelector('[data-testid="split-canvas-retained-content-anchor"]')!;
        expect(transcript.querySelector('[data-testid="transcript"]')).not.toBeNull();
        expect(Boolean(transcript.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    it.each([
        { placement: 'left', x: 125, y: 380, mode: 'splitLeft' },
        { placement: 'right', x: 1450, y: 380, mode: 'splitRight' },
        { placement: 'up', x: 800, y: 90, mode: 'splitUp' },
        { placement: 'down', x: 800, y: 670, mode: 'splitDown' },
    ] as const)('splits throughout the painted $placement zone', async ({ placement, x, y, mode }) => {
        const h = await harness();
        await h.begin(); await h.move(x, y);
        const zone = h.container.querySelector<HTMLElement>(`[data-testid="split-canvas-drop-overlay-group:1-${placement}"]`)!;
        expect(zone).not.toBeNull();
        // Release near the inside of the painted band, not only at the pointer that selected it.
        const style = getComputedStyle(zone);
        const left = Number.parseFloat(style.left) / 100;
        const right = 1 - Number.parseFloat(style.right) / 100;
        const top = Number.parseFloat(style.top) / 100;
        const bottom = 1 - Number.parseFloat(style.bottom) / 100;
        const releaseX = 100 + 1400 * (left + (right - left) * (placement === 'left' ? 0.875 : placement === 'right' ? 0.125 : 0.5));
        const releaseY = 80 + 600 * (top + (bottom - top) * (placement === 'up' ? 0.875 : placement === 'down' ? 0.125 : 0.5));
        await h.move(releaseX, releaseY);
        expect(h.runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: { mode } } });
        await h.drop(releaseX, releaseY);
        expect(h.workspace.state.root.kind).toBe('split');
        expect(Object.values(h.workspace.state.tabs).map(tab => tab.target.params.id)).toEqual(['existing', 'new-session']);
    });

    it('keeps centre tabs, goes to an existing Session and leaves an own-pane tab in place', async () => {
        const h = await harness();
        await h.begin(); await h.move(800); await h.drop(800);
        expect(h.workspace.state.root.kind).toBe('leaf');
        expect(h.workspace.state.groups['group:1'].tabIds).toHaveLength(2);
        expect(Object.values(h.workspace.state.tabs).every(tab => !tab.preview)).toBe(true);
        await h.begin(); await h.move(1450); await h.drop(1450);
        expect(h.workspace.state.groups['group:1'].tabIds).toHaveLength(2);
        const before = h.workspace.state;
        h.setItem({ kind: 'workspace-tab', scope, tabId: 'anchor' });
        await h.begin(); await h.move(800);
        expect(h.runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'workspace_tab_already_here' } });
        await h.drop(800);
        expect(h.workspace.state).toBe(before);
    });

    it('folds an undersized edge into centre without advertising a split', async () => {
        const h = await harness(600);
        await h.begin(); await h.move(680);
        expect(h.runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: { mode: 'newTab' } } });
        expect(h.container.querySelector('[data-testid="split-canvas-drop-overlay-group:1-right"]')).toBeNull();
        await h.drop(680);
        expect(h.workspace.state.root.kind).toBe('leaf');
    });
});

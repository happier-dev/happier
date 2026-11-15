import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createSplitCanvasState, splitCanvasReduce } from '../model/splitCanvasReducer';
import type { SplitCanvasLeafNode, SplitCanvasNode, SplitCanvasState } from '../model/splitCanvasTypes';
import type { SplitCanvasHostControls } from './SplitCanvasHost';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { runGuardedTabNavigation, type ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

// Load the real host after platform mocks, during collection rather than a test's timeout budget.
const { SplitCanvasHost } = await import('./SplitCanvasHost');

afterEach(() => {
    vi.unstubAllGlobals();
});

function createLeaf(id: string) {
    return {
        id,
        kind: 'leaf' as const,
        leafKind: 'test',
        payload: id,
    };
}

function createNestedState(): SplitCanvasState<string> {
    return {
        root: {
            id: 'split-root',
            kind: 'split',
            axis: 'row',
            ratio: 0.5,
            first: createLeaf('leaf-a'),
            second: {
                id: 'split-nested',
                kind: 'split',
                axis: 'column',
                ratio: 0.5,
                first: createLeaf('leaf-b'),
                second: createLeaf('leaf-c'),
            } satisfies SplitCanvasNode<string>,
        } satisfies SplitCanvasNode<string>,
        focusedLeafId: 'leaf-a',
        maximizedLeafId: null,
    };
}

function createLeafHostRect(input: Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>) {
    return {
        getBoundingClientRect: () => input,
    };
}

function findLeafFrameInstance(screen: Awaited<ReturnType<typeof renderScreen>>, leafId: string) {
    return screen.find((instance) =>
        instance.props?.leafId === leafId
        && typeof instance.props?.onHostRefChange === 'function'
        && instance.props?.children != null,
    );
}

function findDivider(screen: Awaited<ReturnType<typeof renderScreen>>, splitId: string) {
    return screen.find((instance) => instance.props.splitId === splitId
        && typeof instance.props.onDragRatio === 'function');
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findAncestorWithFlattenedStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: Record<string, unknown>) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        const style = flattenStyle(current.props?.style);
        if (predicate(style)) {
            return current;
        }
        current = current.parent ?? null;
    }
    return null;
}

describe('SplitCanvasHost', () => {
    it.each(['member', 'leaf'] as const)('does no hidden %s renders while retaining draft state and background completion', async kind => {
        const store = createStore(() => ({ value: 0 }));
        let renders = 0;
        let mounts = 0;
        const presentations: boolean[] = [];
        const completed: number[] = [];
        function Body() {
            const value = useStore(store, state => state.value);
            const presented = useLayoutPresentationActive();
            const [draft, setDraft] = React.useState(() => { mounts += 1; return ''; });
            React.useEffect(() => { presentations.push(presented); }, [presented]);
            // Work admitted before navigation still settles while its body is parked.
            React.useEffect(() => store.subscribe(state => { completed.push(state.value); }), []);
            renders += 1;
            return React.createElement('RetainedBody', { value, draft, onChangeText: setDraft });
        }
        const body = <Body />;
        const state = createNestedState();
        const tree = (hidden: boolean) => <SplitCanvasHost
            state={{ ...state, maximizedLeafId: kind === 'leaf' && hidden ? 'leaf-b' : null }} dispatch={() => {}}
            {...(kind === 'member' ? {
                renderLeafHeader: () => null,
                retainedLeafContents: [{ id: 'home', leafId: 'leaf-a', isActive: !hidden, render: () => body }],
            } : { renderLeaf: ({ leaf }: { leaf: SplitCanvasLeafNode<string> }) => leaf.id === 'leaf-a' ? body : null })} />;
        const screen = await renderScreen(tree(false));
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width: 1000, height: 600 } } });
            if (kind === 'member') invokeTestInstanceHandler(screen.findByTestId('split-canvas-content-slot-leaf-a'), 'onLayout',
                { nativeEvent: { layout: { x: 0, y: 30 } } });
        });
        await act(async () => screen.root.findByType('RetainedBody').props.onChangeText('unsent'));
        await screen.update(tree(true));
        expect(presentations.at(-1)).toBe(false);
        renders = 0;
        for (let value = 1; value <= 3; value++) await act(async () => { store.setState({ value }); });
        expect(renders).toBe(0);
        expect(completed).toEqual([1, 2, 3]);
        await screen.update(tree(false));
        expect(screen.root.findByType('RetainedBody').props).toMatchObject({ value: 3, draft: 'unsent' });
        expect(presentations.at(-1)).toBe(true);
        expect(mounts).toBe(1);
        await screen.unmount();
    });

    it('publishes horizontal edge contact to headers and retained members across row, column, and maximize changes', async () => {
        const state = createNestedState();
        const header = (input: Parameters<NonNullable<React.ComponentProps<typeof SplitCanvasHost>['renderLeafHeader']>>[0]) =>
            React.createElement('HeaderEdges', { leafId: input.leaf.id, left: input.touchesLeftEdge, right: input.touchesRightEdge });
        const members = ['leaf-a', 'leaf-b', 'leaf-c'].map(leafId => ({
            id: leafId, leafId, isActive: true,
            render: (input: import('./SplitCanvasHost').SplitCanvasRetainedLeafContentContext) =>
                React.createElement('MemberEdges', { leafId: input.leafId, left: input.touchesLeftEdge, right: input.touchesRightEdge }),
        }));
        const tree = (maximizedLeafId: string | null) => <SplitCanvasHost state={{ ...state, maximizedLeafId }} dispatch={() => {}}
            renderLeafHeader={header} retainedLeafContents={members} />;
        const screen = await renderScreen(tree(null));
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width: 1000, height: 600 } } });
            for (const leafId of ['leaf-a', 'leaf-b', 'leaf-c']) {
                invokeTestInstanceHandler(screen.findByTestId(`split-canvas-content-slot-${leafId}`), 'onLayout', { nativeEvent: { layout: { x: 0, y: 30 } } });
            }
        });
        const edges = (type: string) => screen.root.findAllByType(type as never).map(node => [node.props.leafId, node.props.left, node.props.right]);
        for (const type of ['HeaderEdges', 'MemberEdges']) {
            expect(edges(type)).toEqual([['leaf-a', true, false], ['leaf-b', false, true], ['leaf-c', false, true]]);
        }
        await screen.update(tree('leaf-c'));
        for (const type of ['HeaderEdges', 'MemberEdges']) {
            expect(edges(type).find(row => row[0] === 'leaf-c')).toEqual(['leaf-c', true, true]);
        }
        await screen.update(tree(null));
        for (const type of ['HeaderEdges', 'MemberEdges']) {
            expect(edges(type).find(row => row[0] === 'leaf-c')).toEqual(['leaf-c', false, true]);
        }
    });

    it('leaves a hidden retained member layer untouched by a canvas resize', async () => {
        const state = createNestedState();
        const header = () => null;
        const hiddenBody = () => React.createElement('HiddenBody', {});
        const visibleBody = () => React.createElement('VisibleBody', {});
        // The hidden member was presented once (a visited tab), so it keeps its retained layer.
        const presented = [{ id: 'hidden', leafId: 'leaf-a', isActive: true, render: hiddenBody },
            { id: 'visible', leafId: 'leaf-a', isActive: false, render: visibleBody }];
        const hidden = { id: 'hidden', leafId: 'leaf-a', isActive: false, render: hiddenBody };
        const visible = { id: 'visible', leafId: 'leaf-a', isActive: true, render: visibleBody };
        const members = [hidden, visible];
        const screen = await renderScreen(<SplitCanvasHost state={state} dispatch={() => {}} renderLeafHeader={header} retainedLeafContents={presented} />);
        const layout = async (width: number, height: number) => act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width, height } } });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-content-slot-leaf-a'), 'onLayout', { nativeEvent: { layout: { x: 0, y: 30 } } });
        });
        await layout(1000, 600);
        await screen.update(<SplitCanvasHost state={state} dispatch={() => {}} renderLeafHeader={header} retainedLeafContents={members} />);
        const hiddenBefore = screen.findByTestId('split-canvas-retained-content-hidden')?.props;
        expect(hiddenBefore).toBeTruthy();
        const visibleBefore = screen.findByTestId('split-canvas-retained-content-visible')?.props;
        await layout(1200, 700);
        // The visible member follows the canvas; a hidden one's frame is not observable, so it stays put.
        expect(screen.findByTestId('split-canvas-retained-content-visible')?.props).not.toBe(visibleBefore);
        expect(screen.findByTestId('split-canvas-retained-content-hidden')?.props).toBe(hiddenBefore);
        await screen.unmount();
    });

    it('updates keyboard focus chrome without rebuilding unrelated pane bodies', async () => {
        // Browser event delivery is the boundary; the real canvas owns modality and focus chrome.
        const browser = new EventTarget();
        vi.stubGlobal('window', browser);
        const renderLeaf = vi.fn(({ leaf }: { leaf: SplitCanvasLeafNode<string> }) =>
            React.createElement('LeafContent', { leafId: leaf.id }));
        const screen = await renderScreen(<SplitCanvasHost state={createNestedState()} dispatch={() => {}}
            chrome="flat" renderLeaf={renderLeaf} />);
        await act(async () => { invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout',
            { nativeEvent: { layout: { width: 1000, height: 600 } } }); });
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-a')).toBeNull();
        const builds = renderLeaf.mock.calls.length;
        for (let index = 0; index < 20; index += 1) {
            await act(async () => { browser.dispatchEvent(new Event('keydown')); });
        }
        expect(renderLeaf.mock.calls.length).toBe(builds);
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-a')).toBeTruthy();
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-b')).toBeNull();
        await act(async () => { browser.dispatchEvent(new Event('pointerdown')); });
        expect(renderLeaf.mock.calls.length).toBe(builds);
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-a')).toBeNull();
        await act(async () => { browser.dispatchEvent(new Event('keydown')); });
        expect(renderLeaf.mock.calls.length).toBe(builds);
        // A newly focused ring reads the incumbent modality even while it had no visible consumer.
        await screen.update(<SplitCanvasHost state={{ ...createNestedState(), focusedLeafId: 'leaf-b' }}
            dispatch={() => {}} chrome="flat" renderLeaf={renderLeaf} />);
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-a')).toBeNull();
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-b')).toBeTruthy();
        await screen.unmount();
    });

    it('uses an eight pixel inset gutter for both layout and split admission', async () => {
        const controlsRef: React.MutableRefObject<SplitCanvasHostControls | null> = { current: null };
        const screen = await renderScreen(<SplitCanvasHost state={createNestedState()} dispatch={() => {}}
            gutterSizePx={8} chrome="flat" controlsRef={controlsRef}
            getLeafMinimumSizePx={() => ({ width: 100, height: 100 })} renderLeaf={() => null} />);
        await act(async () => { invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout',
            { nativeEvent: { layout: { width: 1000, height: 600 } } }); });
        expect(controlsRef.current?.readSplitMeasurement('leaf-a', 'right')).toEqual({ availableSizePx: 488, minimumExistingSizePx: 100 });
        expect(controlsRef.current?.readSplitMeasurement('leaf-b', 'down')).toEqual({ availableSizePx: 288, minimumExistingSizePx: 100 });
    });
    it('preserves member state and its dirty guard when moved between leaves or hidden', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        let mounts = 0;
        function MemberProbe() {
            const [mount] = React.useState(() => ++mounts);
            const [draft, setDraft] = React.useState('initial');
            const isDirtyRef = React.useRef(true);
            const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
                isDirtyRef,
                requestDecision: async () => 'keepEditing',
                tag: 'split-canvas-retained-editor',
            }), []);
            useActiveUnsavedChangesGuard({ navigation: null, guard, focused: false, tabId: 'member' });
            return React.createElement('MemberProbe', { mount, draft, setDraft });
        }
        const state = createNestedState();
        const dispatch = vi.fn();
        const render = () => <MemberProbe />;
        const tree = (leafId: string, maximizedLeafId: string | null = null) => <SplitCanvasHost state={{ ...state, maximizedLeafId }} dispatch={dispatch}
            renderLeafHeader={() => null} retainedLeafContents={[{ id: 'member', leafId, isActive: true, render }]} />;
        const screen = await renderScreen(tree('leaf-a'));
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width: 1000, height: 600 } } });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-content-slot-leaf-a'), 'onLayout', { nativeEvent: { layout: { x: 0, y: 50, width: 495, height: 550 } } });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-content-slot-leaf-b'), 'onLayout', { nativeEvent: { layout: { x: 0, y: 40, width: 495, height: 251 } } });
        });
        await act(async () => { screen.root.findByType('MemberProbe').props.setDraft('unsent'); });
        const original = screen.root.findByType('MemberProbe').props.mount;
        await act(async () => { screen.update(tree('leaf-b')); });
        expect(screen.root.findByType('MemberProbe').props).toMatchObject({ mount: original, draft: 'unsent' });
        // leaf-b stands on the canvas's right edge: the host holds that side, so a resize moves it on the same frame.
        expect(flattenStyle(screen.findByTestId('split-canvas-retained-content-member')?.props.style)).toMatchObject({ left: 505, top: 40, right: 0, height: 251 });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-member:member'), 'onStartShouldSetResponderCapture', {});
        expect(dispatch).toHaveBeenLastCalledWith({ type: 'focusLeaf', leafId: 'leaf-b' });
        await act(async () => { screen.update(tree('leaf-b', 'leaf-a')); });
        expect(screen.findByTestId('split-canvas-retained-content-member')?.props.pointerEvents).toBe('none');
        let closed = false;
        expect(await runGuardedTabNavigation(['member'], () => { closed = true; })).toBe(false);
        expect(closed).toBe(false);
        await act(async () => { screen.update(tree('leaf-b')); });
        expect(screen.root.findByType('MemberProbe').props).toMatchObject({ mount: original, draft: 'unsent' });
        expect(mounts).toBe(1);
    });
    it('preserves an existing leaf mount when a new split changes its ancestry', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        let sequence = 0;
        function LeafProbe(props: Readonly<{ leafId: string }>) {
            const [mount] = React.useState(() => ++sequence);
            return React.createElement('LeafMount', { leafId: props.leafId, mount });
        }
        const leaf = createLeaf('leaf-a');
        const renderLeaf = ({ leaf: current }: Readonly<{ leaf: SplitCanvasLeafNode<string> }>) => <LeafProbe leafId={current.id} />;
        const state = { root: leaf, focusedLeafId: leaf.id, maximizedLeafId: null };
        const screen = await renderScreen(<SplitCanvasHost state={state} dispatch={() => {}} renderLeaf={renderLeaf} />);
        const original = screen.root.findByType('LeafMount').props.mount;
        await screen.update(<SplitCanvasHost state={{ ...state, root: {
            id: 'split', kind: 'split', axis: 'row', ratio: 0.5, first: leaf, second: createLeaf('leaf-b'),
        } }} dispatch={() => {}} renderLeaf={renderLeaf} />);
        expect(screen.root.findAllByType('LeafMount').find(node => node.props.leafId === leaf.id)?.props.mount).toBe(original);
    });
    it('propagates visibility changes into a retained hidden subtree when its tree node stays unchanged', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        const state = createNestedState();
        const tree = (maximizedLeafId: string | null) => <SplitCanvasHost
            state={{ ...state, maximizedLeafId }} dispatch={() => {}}
            renderLeaf={({ leaf }) => React.createElement('VisibilityProbe', {
                leafId: leaf.id, visible: maximizedLeafId === null || maximizedLeafId === leaf.id,
            })} />;
        const screen = await renderScreen(tree(null));
        await screen.update(tree('leaf-a'));
        expect(screen.root.findAllByType('VisibilityProbe').map((node) => [node.props.leafId, node.props.visible]))
            .toEqual([['leaf-a', true], ['leaf-b', false], ['leaf-c', false]]);
        await screen.update(tree(null));
        expect(screen.root.findAllByType('VisibilityProbe').every((node) => node.props.visible)).toBe(true);
    });
    it('offers mounted actions the same measured split admission as UI requests', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        const controlsRef: { current: SplitCanvasHostControls | null } = { current: null };
        const screen = await renderScreen(<SplitCanvasHost
            state={createNestedState()} dispatch={() => {}} renderLeaf={() => null}
            getLeafMinimumSizePx={() => ({ width: 100, height: 80 })}
            controlsRef={controlsRef}
        />);
        expect(controlsRef.current).not.toBeNull();
        expect(controlsRef.current?.readSplitMeasurement('leaf-a', 'right')).toBeNull();
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { width: 1000, height: 600 } },
            });
        });
        expect(controlsRef.current?.readSplitMeasurement('leaf-a', 'right')).toEqual({ availableSizePx: 485, minimumExistingSizePx: 100 });
        expect(controlsRef.current?.readSplitMeasurement('missing', 'right')).toBeNull();
        await act(async () => { screen.unmount(); });
        expect(controlsRef.current).toBeNull();
    });
    it('measures a maximized nested leaf in its normal layout for both split axes', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        const nested = createNestedState();
        const state: SplitCanvasState<string> = {
            ...nested, root: nested.root?.kind === 'split' ? { ...nested.root, ratio: 0.2 } : nested.root,
            focusedLeafId: 'leaf-c', maximizedLeafId: 'leaf-c',
        };
        const onRequestSplitLeaf = vi.fn();
        const screen = await renderScreen(<SplitCanvasHost
            state={state} dispatch={vi.fn()} keyboardEnabled={false}
            getLeafMinimumSizePx={(leaf) => ({ width: leaf.id === 'leaf-a' ? 600 : 100, height: 100 })}
            onRequestSplitLeaf={onRequestSplitLeaf}
            renderLeaf={({ leaf, requestSplit }) => React.createElement('LeafContent', { leafId: leaf.id, requestSplit })}
        />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1010, height: 818 } },
            });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-c'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1010, height: 818 } },
            });
        });
        const content = screen.tree.root.findAllByType('LeafContent').find((node) => node.props.leafId === 'leaf-c');
        await act(async () => content?.props.requestSplit('right'));
        expect(onRequestSplitLeaf).toHaveBeenLastCalledWith({
            leafId: 'leaf-c', direction: 'right', availableSizePx: 390, minimumExistingSizePx: 100,
        });
        await act(async () => content?.props.requestSplit('down'));
        expect(onRequestSplitLeaf).toHaveBeenLastCalledWith({
            leafId: 'leaf-c', direction: 'down', availableSizePx: 382, minimumExistingSizePx: 100,
        });
    });

    it('rejects an undersized maximized split, then admits it after the host grows', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        let state: SplitCanvasState<string> = { ...createNestedState(), focusedLeafId: 'leaf-c', maximizedLeafId: 'leaf-c' };
        const screen = await renderScreen(<SplitCanvasHost
            state={state} dispatch={vi.fn()} keyboardEnabled={false}
            getLeafMinimumSizePx={() => ({ width: 250, height: 100 })}
            onRequestSplitLeaf={(input) => {
                state = splitCanvasReduce(state, {
                    type: 'splitLeaf', targetLeafId: input.leafId, axis: 'row', placement: 'after', newLeaf: createLeaf('leaf-d'),
                    availableSizePx: input.availableSizePx, minimumFirstSizePx: input.minimumExistingSizePx, minimumSecondSizePx: 250,
                });
            }}
            renderLeaf={({ leaf, requestSplit }) => React.createElement('LeafContent', { leafId: leaf.id, requestSplit })}
        />);
        const content = screen.tree.root.findAllByType('LeafContent').find((node) => node.props.leafId === 'leaf-c');
        const initial = state;
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1010, height: 818 } },
            });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-c'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1010, height: 818 } },
            });
            content?.props.requestSplit('right');
        });
        expect(state).toBe(initial);
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1210, height: 818 } },
            });
            content?.props.requestSplit('right');
        });
        expect(state.focusedLeafId).toBe('leaf-d');
        expect(state.maximizedLeafId).toBeNull();
    });

    it('hides sibling leaves when the focused leaf is maximized through the shared leaf controls', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        const { splitCanvasReduce } = await import('../model/splitCanvasReducer');

        const StatefulHost = () => {
            const [state, setState] = React.useState<SplitCanvasState<string>>({
                root: {
                    id: 'split-root',
                    kind: 'split',
                    axis: 'row',
                    ratio: 0.5,
                    first: createLeaf('leaf-a'),
                    second: createLeaf('leaf-b'),
                } satisfies SplitCanvasNode<string>,
                focusedLeafId: 'leaf-a',
                maximizedLeafId: null,
            });

            const dispatch = React.useCallback((action: any) => {
                setState((current) => splitCanvasReduce(current, action));
            }, []);

            return (
                <SplitCanvasHost
                    state={state}
                    dispatch={dispatch}
                    renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                    renderLeafLabel={(leaf) => `Leaf ${leaf.id}`}
                />
            );
        };

        const screen = await renderScreen(<StatefulHost />);

        const maximizeButton = screen.findByTestId('split-canvas-leaf-maximize-leaf-a');
        expect(maximizeButton).toBeTruthy();

        await act(async () => {
            maximizeButton?.props.onPress?.();
        });

        expect(screen.findByTestId('split-canvas-leaf-frame-leaf-a')).toBeTruthy();
        const hiddenLeaf = screen.findByTestId('split-canvas-leaf-frame-leaf-b');
        expect(hiddenLeaf).toBeTruthy();
        expect(findAncestorWithFlattenedStyle(hiddenLeaf, (style) => style.display === 'none')).toBeTruthy();
    });

    it('keeps the shared leaf frame visually quiet for a single focused leaf', async () => {
        const dispatch = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                renderLeafLabel={(leaf) => `Leaf ${leaf.id}`}
            />,
        );

        const interactionSurface = screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a');
        expect(interactionSurface).toBeTruthy();
        expect(flattenStyle(interactionSurface?.props.style)).toEqual(expect.objectContaining({
            borderRadius: 0,
        }));
        expect(flattenStyle(interactionSurface?.props.style)).not.toHaveProperty('backgroundColor');
        expect(screen.findByTestId('split-canvas-focus-ring-leaf-a')).toBeNull();
        expect(screen.findByTestId('split-canvas-leaf-close-leaf-a')).toBeNull();
        expect(screen.findByTestId('split-canvas-leaf-maximize-leaf-a')).toBeNull();
        expect(screen.findByTestId('split-canvas-leaf-title-leaf-a')).toBeNull();
    });

    it('promotes focus from descendant interaction instead of relying on an outer press wrapper', async () => {
        const dispatch = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const state: SplitCanvasState<string> = {
            root: {
                id: 'split-root',
                kind: 'split',
                axis: 'row',
                ratio: 0.5,
                first: createLeaf('leaf-a'),
                second: createLeaf('leaf-b'),
            } satisfies SplitCanvasNode<string>,
            focusedLeafId: 'leaf-a',
            maximizedLeafId: null,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        invokeTestInstanceHandler(
            screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-b'),
            'onStartShouldSetResponderCapture',
            {},
            'split-canvas-leaf-interaction-surface-leaf-b',
        );

        expect(dispatch).toHaveBeenCalledWith({ type: 'focusLeaf', leafId: 'leaf-b' });
    });




    it('does not recompute leaf content whose focused state did not change', async () => {
        const dispatch = vi.fn();
        const renderCounts = new Map<string, number>();
        const renderLeaf = ({ leaf }: Readonly<{ leaf: SplitCanvasLeafNode }>) => {
            renderCounts.set(leaf.id, (renderCounts.get(leaf.id) ?? 0) + 1);
            return React.createElement('LeafContent', { leafId: leaf.id });
        };

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const root: SplitCanvasNode<string> = {
            id: 'split-root',
            kind: 'split',
            axis: 'row',
            ratio: 0.5,
            first: createLeaf('leaf-a'),
            second: {
                id: 'split-nested',
                kind: 'split',
                axis: 'column',
                ratio: 0.5,
                first: createLeaf('leaf-b'),
                second: createLeaf('leaf-c'),
            },
        };
        const state: SplitCanvasState<string> = {
            root,
            focusedLeafId: 'leaf-a',
            maximizedLeafId: null,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={renderLeaf}
            />,
        );

        await screen.update(
            <SplitCanvasHost
                state={{
                    ...state,
                    focusedLeafId: 'leaf-b',
                }}
                dispatch={dispatch}
                renderLeaf={renderLeaf}
            />,
        );

        expect(renderCounts.get('leaf-a')).toBe(2);
        expect(renderCounts.get('leaf-b')).toBe(2);
        expect(renderCounts.get('leaf-c')).toBe(1);
    });

    it('hides nested split chrome while another leaf is maximized', async () => {
        const dispatch = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const state = createNestedState();

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        expect(screen.findByTestId('split-canvas-divider-split-nested')).not.toBeNull();

        await screen.update(
            <SplitCanvasHost
                state={{
                    ...state,
                    maximizedLeafId: 'leaf-a',
                }}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        expect(screen.findByTestId('split-canvas-divider-split-nested')).toBeNull();
    });

    it('applies live divider ratios without animation-frame support before committing them to the reducer', async () => {
        // This exercises the non-RAF boundary; the next frame-coalescing test owns RAF delivery.
        vi.stubGlobal('requestAnimationFrame', undefined);
        const dispatch = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const state: SplitCanvasState<string> = {
            root: {
                id: 'split-root',
                kind: 'split',
                axis: 'row',
                ratio: 0.5,
                first: createLeaf('leaf-a'),
                second: createLeaf('leaf-b'),
            } satisfies SplitCanvasNode<string>,
            focusedLeafId: 'leaf-a',
            maximizedLeafId: null,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        const divider = findDivider(screen, 'split-root');

        await act(async () => {
            divider.props.onDragRatio?.(0.7, {
                attemptedSizePx: 700,
                clampedSizePx: 700,
                exceededMinPx: false,
                exceededMaxPx: false,
                overshootPx: 0,
                collapseArmed: false,
            });
        });

        expect(screen.findByTestId('split-canvas-pane-first-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.7 }),
        );
        expect(screen.findByTestId('split-canvas-pane-second-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.3 }),
        );
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('uses both child subtree minimums to bound a measured divider', async () => {
        const dispatch = vi.fn();
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        const state: SplitCanvasState<string> = {
            root: {
                id: 'split-measured', kind: 'split', axis: 'row', ratio: 0.6,
                first: createLeaf('leaf-a'), second: createLeaf('leaf-b'),
            },
            focusedLeafId: 'leaf-a', maximizedLeafId: null,
        };
        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                getLeafMinimumSizePx={(leaf) => ({ width: leaf.id === 'leaf-a' ? 400 : 100, height: 100 })}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-split-split-measured'), 'onLayout', {
                nativeEvent: { layout: { width: 700, height: 400 } },
            });
        });

        const divider = findDivider(screen, 'split-measured');
        expect(divider.props.minRatio).toBeCloseTo(400 / 690);
        expect(divider.props.maxRatio).toBeCloseTo(1 - 100 / 690);

        await act(async () => divider.props.onCommitRatio?.(0.4));
        expect(dispatch).toHaveBeenCalledWith({
            type: 'setSplitRatio', splitId: 'split-measured', ratio: 0.4,
            availableSizePx: 690, minimumFirstSizePx: 400, minimumSecondSizePx: 100,
        });
    });




});

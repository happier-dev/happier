import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createSplitCanvasState, splitCanvasReduce } from '../model/splitCanvasReducer';
import type { SplitCanvasLeafNode, SplitCanvasNode, SplitCanvasState } from '../model/splitCanvasTypes';
import type { SplitCanvasHostControls } from './SplitCanvasHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

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
    it('preserves member state when the same member moves between leaves', async () => {
        const { SplitCanvasHost } = await import('./SplitCanvasHost');
        let mounts = 0;
        function MemberProbe() {
            const [mount] = React.useState(() => ++mounts);
            const [draft, setDraft] = React.useState('initial');
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
        expect(flattenStyle(screen.findByTestId('split-canvas-retained-content-member')?.props.style)).toMatchObject({ left: 505, top: 40, width: 495, height: 251 });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-member:member'), 'onStartShouldSetResponderCapture', {});
        expect(dispatch).toHaveBeenLastCalledWith({ type: 'focusLeaf', leafId: 'leaf-b' });
        await act(async () => { screen.update(tree('leaf-b', 'leaf-a')); });
        expect(screen.findByTestId('split-canvas-retained-content-member')?.props.pointerEvents).toBe('none');
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
        await act(async () => { screen.tree.update(<SplitCanvasHost state={{ ...state, root: {
            id: 'split', kind: 'split', axis: 'row', ratio: 0.5, first: leaf, second: createLeaf('leaf-b'),
        } }} dispatch={() => {}} renderLeaf={renderLeaf} />); });
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
        await act(async () => { screen.tree.update(tree('leaf-a')); });
        expect(screen.root.findAllByType('VisibilityProbe').map((node) => [node.props.leafId, node.props.visible]))
            .toEqual([['leaf-a', true], ['leaf-b', false], ['leaf-c', false]]);
        await act(async () => { screen.tree.update(tree(null)); });
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

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={{
                        ...state,
                        focusedLeafId: 'leaf-b',
                    }}
                    dispatch={dispatch}
                    renderLeaf={renderLeaf}
                />,
            );
        });

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

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={{
                        ...state,
                        maximizedLeafId: 'leaf-a',
                    }}
                    dispatch={dispatch}
                    renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                />,
            );
        });

        expect(screen.findByTestId('split-canvas-divider-split-nested')).toBeNull();
    });

    it('applies live divider ratios before committing them to the reducer', async () => {
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
            });
        });

        expect(screen.findByTestId('split-canvas-pane-first-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.7 }),
        );
        expect(screen.findByTestId('split-canvas-pane-second-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.3 }),
        );
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

    it('coalesces live divider ratio updates into animation frames when resizing on web', async () => {
        const dispatch = vi.fn();
        const rafCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
            rafCallbacks.push(callback);
            return rafCallbacks.length;
        });
        const cancelAnimationFrameSpy = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy);

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
            divider.props.onDragRatio?.(0.6, null);
            divider.props.onDragRatio?.(0.7, null);
        });

        expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('split-canvas-pane-first-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.5 }),
        );

        await act(async () => {
            rafCallbacks.shift()?.(16);
        });

        expect(screen.findByTestId('split-canvas-pane-first-split-root')?.props.style).toEqual(
            expect.objectContaining({ flex: 0.7 }),
        );

        await act(async () => {
            divider.props.onDragRatio?.(0.72, null);
            divider.props.onCommitRatio?.(0.75, {
                attemptedSizePx: 750,
                clampedSizePx: 750,
                exceededMinPx: false,
                exceededMaxPx: false,
            });
        });

        expect(cancelAnimationFrameSpy).toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith({
            type: 'setSplitRatio',
            splitId: 'split-root',
            ratio: 0.75,
        });
    });



});

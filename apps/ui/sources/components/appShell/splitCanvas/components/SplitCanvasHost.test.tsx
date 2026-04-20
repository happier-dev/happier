import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createSplitCanvasState } from '../model/splitCanvasReducer';
import type { SplitCanvasDropTarget, SplitCanvasLeafNode, SplitCanvasNode, SplitCanvasState } from '../model/splitCanvasTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

afterEach(() => {
    vi.unstubAllGlobals();
});

const webDropTargetViewSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement('WebDropTargetView', props, props.children)));
const splitCanvasDividerSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement('SplitCanvasDivider', props, props.children)));

vi.mock('@/components/workspaces/files/repositoryTree/WebDropTargetView', () => ({
    WebDropTargetView: (props: any) => webDropTargetViewSpy(props),
}));

vi.mock('./SplitCanvasDivider', () => ({
    SplitCanvasDivider: (props: any) => splitCanvasDividerSpy(props),
}));

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
        maxLeaves: 4,
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
                maxLeaves: 4,
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
            maxLeaves: 4,
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
            maxLeaves: 4,
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

    it('uses one shared web drop target and resolves drop placement from host hit testing', async () => {
        const dispatch = vi.fn();
        const onLeafDrop = vi.fn();
        const onActiveDropTargetChange = vi.fn();

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
            maxLeaves: 4,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                onActiveDropTargetChange={onActiveDropTargetChange}
                onLeafDrop={onLeafDrop}
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
            nativeEvent: {
                layout: {
                    width: 800,
                    height: 400,
                },
            },
        });

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 400,
                },
            },
        });

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-b'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 400,
                    y: 0,
                    width: 400,
                    height: 400,
                },
            },
        });

        const dropTargets = screen.tree.root.findAllByType('WebDropTargetView');
        expect(dropTargets).toHaveLength(1);

        const dropTarget = dropTargets[0];

        await act(async () => {
            dropTarget.props.onDragOver?.({
                clientX: 412,
                clientY: 120,
                preventDefault: vi.fn(),
                currentTarget: {
                    getBoundingClientRect: () => ({
                        left: 0,
                        top: 0,
                        width: 800,
                        height: 400,
                    }),
                },
            });
        });

        expect(onActiveDropTargetChange).toHaveBeenCalledWith({
            leafId: 'leaf-b',
            placement: 'left',
        } satisfies SplitCanvasDropTarget);

        await act(async () => {
            dropTarget.props.onDrop?.({
                clientX: 412,
                clientY: 120,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
                dataTransfer: {
                    getData: () => JSON.stringify({ sessionId: 'sess_2' }),
                },
                currentTarget: {
                    getBoundingClientRect: () => ({
                        left: 0,
                        top: 0,
                        width: 800,
                        height: 400,
                    }),
                },
            });
        });

        expect(onLeafDrop).toHaveBeenCalledWith({
            payload: JSON.stringify({ sessionId: 'sess_2' }),
            target: {
                leafId: 'leaf-b',
                placement: 'left',
            },
        });
        expect(onActiveDropTargetChange).toHaveBeenLastCalledWith(null);
    });

    it('does not recompute unaffected leaf content when only the active drop target changes', async () => {
        const dispatch = vi.fn();
        const renderCounts = new Map<string, number>();
        const renderLeaf = ({ leaf }: Readonly<{ leaf: SplitCanvasLeafNode }>) => {
            renderCounts.set(leaf.id, (renderCounts.get(leaf.id) ?? 0) + 1);
            return React.createElement('LeafContent', { leafId: leaf.id });
        };

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
            maxLeaves: 4,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={renderLeaf}
            />,
        );

        expect(renderCounts.get('leaf-a')).toBe(1);
        expect(renderCounts.get('leaf-b')).toBe(1);

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={state}
                    dispatch={dispatch}
                    renderLeaf={renderLeaf}
                    activeDropTarget={{
                        leafId: 'leaf-b',
                        placement: 'right',
                    }}
                />,
            );
        });

        expect(renderCounts.get('leaf-a')).toBe(1);
        expect(renderCounts.get('leaf-b')).toBe(2);
    });

    it('does not remount leaf content when split drag availability toggles', async () => {
        const dispatch = vi.fn();
        const renderCounts = new Map<string, number>();
        const renderLeaf = ({ leaf }: Readonly<{ leaf: SplitCanvasLeafNode }>) => {
            renderCounts.set(leaf.id, (renderCounts.get(leaf.id) ?? 0) + 1);
            return React.createElement('LeafContent', { leafId: leaf.id });
        };

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
            maxLeaves: 4,
        };

        const onActiveDropTargetChange = vi.fn();
        const onLeafDrop = vi.fn();

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={renderLeaf}
            />,
        );

        expect(renderCounts.get('leaf-a')).toBe(1);
        expect(renderCounts.get('leaf-b')).toBe(1);

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={state}
                    dispatch={dispatch}
                    renderLeaf={renderLeaf}
                    onActiveDropTargetChange={onActiveDropTargetChange}
                    onLeafDrop={onLeafDrop}
                />,
            );
        });

        expect(renderCounts.get('leaf-a')).toBe(1);
        expect(renderCounts.get('leaf-b')).toBe(1);

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={state}
                    dispatch={dispatch}
                    renderLeaf={renderLeaf}
                />,
            );
        });

        expect(renderCounts.get('leaf-a')).toBe(1);
        expect(renderCounts.get('leaf-b')).toBe(1);
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
            maxLeaves: 4,
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

    it('does not rerender hidden nested split chrome while another leaf is maximized', async () => {
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

        expect(splitCanvasDividerSpy.mock.calls.map(([props]) => props.splitId)).toEqual(
            expect.arrayContaining(['split-root', 'split-nested']),
        );

        splitCanvasDividerSpy.mockClear();

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

        expect(splitCanvasDividerSpy.mock.calls.map(([props]) => props.splitId)).not.toContain('split-nested');
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
            maxLeaves: 4,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        const divider = screen.tree.root.findByType('SplitCanvasDivider');

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
            maxLeaves: 4,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
            />,
        );

        const divider = screen.tree.root.findByType('SplitCanvasDivider');

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

    it('resolves nested drop targets through shared host ref geometry instead of parent-relative leaf layouts', async () => {
        const dispatch = vi.fn();
        const onActiveDropTargetChange = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const screen = await renderScreen(
            <SplitCanvasHost
                state={createNestedState()}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                onActiveDropTargetChange={onActiveDropTargetChange}
                onLeafDrop={vi.fn()}
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 600,
                },
            },
        });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-b'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 300,
                },
            },
        });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-c'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 300,
                    width: 400,
                    height: 300,
                },
            },
        });

        const leafAFrame = findLeafFrameInstance(screen, 'leaf-a');
        const leafBFrame = findLeafFrameInstance(screen, 'leaf-b');
        const leafCFrame = findLeafFrameInstance(screen, 'leaf-c');

        await act(async () => {
            leafAFrame?.props.onHostRefChange?.(createLeafHostRect({
                left: 0,
                top: 0,
                width: 400,
                height: 600,
            }));
            leafBFrame?.props.onHostRefChange?.(createLeafHostRect({
                left: 400,
                top: 0,
                width: 400,
                height: 300,
            }));
            leafCFrame?.props.onHostRefChange?.(createLeafHostRect({
                left: 400,
                top: 300,
                width: 400,
                height: 300,
            }));
        });

        const dropTarget = screen.tree.root.findByType('WebDropTargetView');

        await act(async () => {
            dropTarget.props.onDragOver?.({
                clientX: 412,
                clientY: 420,
                preventDefault: vi.fn(),
                currentTarget: {
                    getBoundingClientRect: () => ({
                        left: 0,
                        top: 0,
                        width: 800,
                        height: 600,
                    }),
                },
            });
        });

        expect(onActiveDropTargetChange).toHaveBeenLastCalledWith({
            leafId: 'leaf-c',
            placement: 'left',
        } satisfies SplitCanvasDropTarget);
    });

    it('clears stale shared host geometry after leaf removal so nested drops target surviving leaves', async () => {
        const dispatch = vi.fn();
        const onActiveDropTargetChange = vi.fn();

        const { SplitCanvasHost } = await import('./SplitCanvasHost');

        const screen = await renderScreen(
            <SplitCanvasHost
                state={createNestedState()}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                onActiveDropTargetChange={onActiveDropTargetChange}
                onLeafDrop={vi.fn()}
            />,
        );

        const registerNestedLeafHosts = async () => {
            const leafAFrame = findLeafFrameInstance(screen, 'leaf-a');
            const leafBFrame = findLeafFrameInstance(screen, 'leaf-b');
            const leafCFrame = findLeafFrameInstance(screen, 'leaf-c');

            await act(async () => {
                leafAFrame?.props.onHostRefChange?.(createLeafHostRect({
                    left: 0,
                    top: 0,
                    width: 400,
                    height: 600,
                }));
                leafBFrame?.props.onHostRefChange?.(createLeafHostRect({
                    left: 400,
                    top: 0,
                    width: 400,
                    height: 300,
                }));
                leafCFrame?.props.onHostRefChange?.(createLeafHostRect({
                    left: 400,
                    top: 300,
                    width: 400,
                    height: 300,
                }));
            });

            return {
                leafBFrame,
                leafCFrame,
            };
        };

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 600,
                },
            },
        });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-b'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 300,
                },
            },
        });
        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-c'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 0,
                    y: 300,
                    width: 400,
                    height: 300,
                },
            },
        });

        const initialLeafFrames = await registerNestedLeafHosts();

        await act(async () => {
            initialLeafFrames.leafCFrame?.props.onHostRefChange?.(null);
            screen.tree.update(
                <SplitCanvasHost
                    state={{
                        root: {
                            id: 'split-root',
                            kind: 'split',
                            axis: 'row',
                            ratio: 0.5,
                            first: createLeaf('leaf-a'),
                            second: createLeaf('leaf-b'),
                        },
                        focusedLeafId: 'leaf-a',
                        maximizedLeafId: null,
                        maxLeaves: 4,
                    }}
                    dispatch={dispatch}
                    renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                    onActiveDropTargetChange={onActiveDropTargetChange}
                    onLeafDrop={vi.fn()}
                />,
            );
        });

        invokeTestInstanceHandler(screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-b'), 'onLayout', {
            nativeEvent: {
                layout: {
                    x: 400,
                    y: 0,
                    width: 400,
                    height: 600,
                },
            },
        });

        const nextLeafBFrame = findLeafFrameInstance(screen, 'leaf-b');

        await act(async () => {
            nextLeafBFrame?.props.onHostRefChange?.(createLeafHostRect({
                left: 400,
                top: 0,
                width: 400,
                height: 600,
            }));
        });

        const dropTarget = screen.tree.root.findByType('WebDropTargetView');

        await act(async () => {
            dropTarget.props.onDragOver?.({
                clientX: 412,
                clientY: 420,
                preventDefault: vi.fn(),
                currentTarget: {
                    getBoundingClientRect: () => ({
                        left: 0,
                        top: 0,
                        width: 800,
                        height: 600,
                    }),
                },
            });
        });

        expect(onActiveDropTargetChange).toHaveBeenLastCalledWith({
            leafId: 'leaf-b',
            placement: 'left',
        } satisfies SplitCanvasDropTarget);
    });

    it('keeps global drag cleanup listeners stable across equivalent rerenders and still uses the latest callback', async () => {
        const fakeWindow = new (globalThis as any).EventTarget();
        const originalAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
        const originalRemoveEventListener = fakeWindow.removeEventListener.bind(fakeWindow);
        const addEventListener = vi.fn((...args: Parameters<typeof originalAddEventListener>) => originalAddEventListener(...args));
        const removeEventListener = vi.fn((...args: Parameters<typeof originalRemoveEventListener>) => originalRemoveEventListener(...args));
        fakeWindow.addEventListener = addEventListener;
        fakeWindow.removeEventListener = removeEventListener;
        vi.stubGlobal('window', fakeWindow);

        const dispatch = vi.fn();
        const firstCallback = vi.fn();
        const latestCallback = vi.fn();

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
            maxLeaves: 4,
        };

        const screen = await renderScreen(
            <SplitCanvasHost
                state={state}
                dispatch={dispatch}
                renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                onActiveDropTargetChange={firstCallback}
                onLeafDrop={vi.fn()}
            />,
        );

        const initialAttachCount = addEventListener.mock.calls.length;
        const initialDetachCount = removeEventListener.mock.calls.length;

        await act(async () => {
            screen.tree.update(
                <SplitCanvasHost
                    state={state}
                    dispatch={dispatch}
                    renderLeaf={({ leaf }) => React.createElement('LeafContent', { leafId: leaf.id })}
                    onActiveDropTargetChange={latestCallback}
                    onLeafDrop={vi.fn()}
                />,
            );
        });

        expect(addEventListener.mock.calls.length).toBe(initialAttachCount);
        expect(removeEventListener.mock.calls.length).toBe(initialDetachCount);

        await act(async () => {
            fakeWindow.dispatchEvent(new Event('drop'));
        });

        expect(firstCallback).not.toHaveBeenCalled();
        expect(latestCallback).toHaveBeenCalledWith(null);
    });
});

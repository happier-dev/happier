import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SplitCanvasDropTarget, SplitCanvasLeafNode, SplitCanvasNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

const sessionCanvasLeafSpy = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => React.createElement('SessionCanvasLeaf', props)));
const registerSessionSplitCanvasRuntimeSpy = vi.hoisted(() => vi.fn((_input: unknown) => () => {}));
const splitCanvasHostSpy = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => React.createElement('SplitCanvasHost', props)));
const useSessionSplitCanvasStateSpy = vi.hoisted(() => vi.fn());
const useSessionSplitCanvasDragStateSpy = vi.hoisted(() => vi.fn(() => false));
const navigateToSessionSpy = vi.hoisted(() => vi.fn());
const routeHydrationState = {
    kind: 'available',
    sessionId: 'sess_2',
    serverId: 'server-route',
} as const;

const baseSplitCanvasState = {
    root: {
        kind: 'split',
        axis: 'row',
        first: {
            id: 'session-leaf:sess_1',
            kind: 'leaf',
            leafKind: 'session',
            payload: { sessionId: 'sess_1' },
        },
        second: {
            id: 'session-leaf:sess_2',
            kind: 'leaf',
            leafKind: 'session',
            payload: { sessionId: 'sess_2' },
        },
    },
    focusedLeafId: 'session-leaf:sess_2',
    maximizedLeafId: null,
    maxLeaves: 8,
} as const;

const nestedSplitCanvasState = {
    root: {
        kind: 'split',
        axis: 'row',
        ratio: 0.5,
        first: {
            id: 'session-leaf:sess_1',
            kind: 'leaf',
            leafKind: 'session',
            payload: { sessionId: 'sess_1' },
        },
        second: {
            id: 'split-right',
            kind: 'split',
            axis: 'column',
            ratio: 0.5,
            first: {
                id: 'session-leaf:sess_2',
                kind: 'leaf',
                leafKind: 'session',
                payload: { sessionId: 'sess_2' },
            },
            second: {
                id: 'session-leaf:sess_3',
                kind: 'leaf',
                leafKind: 'session',
                payload: { sessionId: 'sess_3' },
            },
        },
    },
    focusedLeafId: 'session-leaf:sess_2',
    maximizedLeafId: null,
    maxLeaves: 8,
} as const;

function collectLeaves(node: SplitCanvasNode<{ sessionId: string }> | null): Array<SplitCanvasLeafNode<{ sessionId: string }>> {
    if (!node) {
        return [];
    }
    if (node.kind === 'leaf') {
        return [node];
    }
    return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

vi.mock('./SessionCanvasLeaf', () => ({
    SessionCanvasLeaf: (props: Record<string, unknown>) => sessionCanvasLeafSpy(props),
}));

vi.mock('./useSessionCanvasEligibility', () => ({
    useSessionCanvasEligibility: () => ({
        isCanvasEligible: true,
        reason: 'eligible',
        scope: {
            workspaceCacheKey: 'server-route:machine-1:/repo',
            serverId: 'server-route',
            machineId: 'machine-1',
            rootPath: '/repo',
        },
    }),
}));

vi.mock('./useSessionSplitCanvasState', () => ({
    useSessionSplitCanvasState: () => useSessionSplitCanvasStateSpy(),
}));

vi.mock('./useSessionSplitCanvasDragState', () => ({
    useSessionSplitCanvasDragState: () => useSessionSplitCanvasDragStateSpy(),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('./sessionSplitCanvasRuntime', () => ({
    registerSessionSplitCanvasRuntime: (input: unknown) => registerSessionSplitCanvasRuntimeSpy(input),
}));

vi.mock('@/components/appShell/splitCanvas/components/SplitCanvasHost', () => ({
    SplitCanvasHost: (props: {
        state: {
            root: SplitCanvasNode<{ sessionId: string }> | null;
            focusedLeafId: string | null;
            maximizedLeafId: string | null;
        };
        renderLeaf: (input: {
            leaf: SplitCanvasLeafNode<{ sessionId: string }>;
            isFocused: boolean;
            isMaximized: boolean;
        }) => React.ReactNode;
        activeDropTarget?: SplitCanvasDropTarget | null;
        onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
        onLeafDrop?: (input: Readonly<{
            payload: string;
            target: SplitCanvasDropTarget;
        }>) => void;
    }) => {
        splitCanvasHostSpy(props);
        return React.createElement(
            React.Fragment,
            null,
            ...collectLeaves(props.state.root).map((leaf) => props.renderLeaf({
                leaf,
                isFocused: props.state.focusedLeafId === leaf.id,
                isMaximized: props.state.maximizedLeafId === leaf.id,
            })),
        );
    },
}));

describe('SessionSplitCanvasScreen', () => {
    afterEach(() => {
        standardCleanup();
        splitCanvasHostSpy.mockClear();
        registerSessionSplitCanvasRuntimeSpy.mockClear();
        sessionCanvasLeafSpy.mockClear();
        useSessionSplitCanvasStateSpy.mockReset();
        useSessionSplitCanvasDragStateSpy.mockReset();
        useSessionSplitCanvasDragStateSpy.mockReturnValue(false);
        navigateToSessionSpy.mockReset();
    });

    it('restores persisted leaves through the shared split host and routes focus and anchor props to the correct leaf', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });

        const paneUrlState = {
            rightTabId: 'files',
        };
        const attachmentDrafts = [{ id: 'draft-1' }];

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');

        const screen = await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
                jumpToSeq={42}
                paneUrlState={paneUrlState as never}
                initialAttachmentDrafts={attachmentDrafts as never}
                routeHydrationState={routeHydrationState}
            />,
        );

        expect(sessionCanvasLeafSpy).toHaveBeenCalledTimes(2);
        expect(sessionCanvasLeafSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
            sessionId: 'sess_1',
            surfaceFocused: false,
            surfaceVisible: true,
            routeAnchor: false,
            routeServerId: undefined,
            jumpToSeq: null,
            paneUrlState: undefined,
            initialAttachmentDrafts: null,
        }));
        expect(sessionCanvasLeafSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
            sessionId: 'sess_2',
            surfaceFocused: true,
            surfaceVisible: true,
            routeAnchor: true,
            routeServerId: 'server-route',
            jumpToSeq: 42,
            paneUrlState,
            initialAttachmentDrafts: attachmentDrafts,
            routeHydrationState,
        }));
        expect(registerSessionSplitCanvasRuntimeSpy).toHaveBeenCalledWith({
            snapshot: {
                routeSessionId: 'sess_2',
                focusedSessionId: 'sess_2',
                openSessionIds: ['sess_1', 'sess_2'],
                scope: {
                    workspaceCacheKey: 'server-route:machine-1:/repo',
                    serverId: 'server-route',
                    machineId: 'machine-1',
                    rootPath: '/repo',
                },
            },
            controller: expect.objectContaining({
                focusSession: expect.any(Function),
                openSessionInSplit: expect.any(Function),
            }),
        });

        await screen.unmount();
    });

    it('marks non-maximized retained leaves as hidden so their session runtime can pause while maximize is active', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: {
                ...baseSplitCanvasState,
                maximizedLeafId: 'session-leaf:sess_2',
            },
            dispatch,
            openSessionInSplit,
            focusSession,
        });

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');

        const screen = await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        expect(sessionCanvasLeafSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
            sessionId: 'sess_1',
            surfaceVisible: false,
        }));
        expect(sessionCanvasLeafSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
            sessionId: 'sess_2',
            surfaceVisible: true,
        }));

        await screen.unmount();
    });

    it('promotes the surviving focused leaf to route-anchor responsibilities when the URL session is no longer present in the split tree', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: {
                root: {
                    id: 'session-leaf:sess_2',
                    kind: 'leaf',
                    leafKind: 'session',
                    payload: { sessionId: 'sess_2' },
                },
                focusedLeafId: 'session-leaf:sess_2',
                maximizedLeafId: null,
                maxLeaves: 8,
            },
            dispatch,
            openSessionInSplit,
            focusSession,
        });

        const paneUrlState = {
            rightTabId: 'files',
        };
        const attachmentDrafts = [{ id: 'draft-1' }];

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');

        const screen = await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_1"
                routeServerId="server-route"
                jumpToSeq={42}
                paneUrlState={paneUrlState as never}
                initialAttachmentDrafts={attachmentDrafts as never}
                routeHydrationState={routeHydrationState}
            />,
        );

        expect(sessionCanvasLeafSpy).toHaveBeenCalledTimes(1);
        expect(sessionCanvasLeafSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
            sessionId: 'sess_2',
            surfaceFocused: true,
            surfaceVisible: true,
            routeAnchor: true,
            routeServerId: 'server-route',
            jumpToSeq: 42,
            paneUrlState,
            initialAttachmentDrafts: attachmentDrafts,
            routeHydrationState,
        }));

        await screen.unmount();
    });

    it('navigates to the surviving session when closing the route-owner leaf', async () => {
        const dispatch = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit: vi.fn(),
            focusSession: vi.fn(),
        });

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');

        const screen = await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const hostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            dispatch: (action: { type: 'closeLeaf'; leafId: string }) => void;
        } | undefined;
        expect(hostProps).toBeDefined();

        hostProps?.dispatch({
            type: 'closeLeaf',
            leafId: 'session-leaf:sess_2',
        });

        expect(dispatch).toHaveBeenCalledWith({
            type: 'closeLeaf',
            leafId: 'session-leaf:sess_2',
        });
        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_1', {
            serverId: 'server-route',
        });

        await screen.unmount();
    });

    it('keeps split drop handling disabled when no session split drag is active', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const hostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            onLeafDrop?: (input: Readonly<{
                payload: string;
                target: SplitCanvasDropTarget;
            }>) => void;
            onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
        } | undefined;
        expect(hostProps).toBeTruthy();
        expect(hostProps?.onLeafDrop).toBeUndefined();
        expect(hostProps?.onActiveDropTargetChange).toBeUndefined();
    });

    it('splits or focuses a session when the host commits a drop during an active session split drag', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });
        useSessionSplitCanvasDragStateSpy.mockReturnValue(true);

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const activeHostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            onLeafDrop?: (input: Readonly<{
                payload: string;
                target: SplitCanvasDropTarget;
            }>) => void;
            onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
        } | undefined;
        expect(activeHostProps?.onLeafDrop).toBeTypeOf('function');
        expect(activeHostProps?.onActiveDropTargetChange).toBeTypeOf('function');

        await activeHostProps?.onLeafDrop?.({
            payload: JSON.stringify({ sessionId: 'sess_3' }),
            target: {
                leafId: 'session-leaf:sess_2',
                placement: 'right',
            },
        });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'splitLeaf',
            targetLeafId: 'session-leaf:sess_2',
            axis: 'row',
            placement: 'after',
        }));
        expect(openSessionInSplit).not.toHaveBeenCalled();
        expect(focusSession).not.toHaveBeenCalled();

        dispatch.mockClear();
        await activeHostProps?.onLeafDrop?.({
            payload: JSON.stringify({ sessionId: 'sess_2' }),
            target: {
                leafId: 'session-leaf:sess_1',
                placement: 'left',
            },
        });

        expect(focusSession).toHaveBeenCalledWith('sess_2');
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'splitLeaf',
        }));
    });

    it('replaces a non-route session leaf when a new session is dropped on the center target', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });
        useSessionSplitCanvasDragStateSpy.mockReturnValue(true);

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const hostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            onLeafDrop?: (input: Readonly<{
                payload: string;
                target: SplitCanvasDropTarget;
            }>) => void;
        } | undefined;

        await hostProps?.onLeafDrop?.({
            payload: JSON.stringify({ sessionId: 'sess_4' }),
            target: {
                leafId: 'session-leaf:sess_1',
                placement: 'center',
            },
        });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'replaceLeaf',
            leafId: 'session-leaf:sess_1',
            nextLeaf: expect.objectContaining({
                id: 'session-leaf:sess_4',
                payload: { sessionId: 'sess_4' },
            }),
        }));
        expect(focusSession).not.toHaveBeenCalled();
    });

    it('opens a new split beside the route-anchor leaf when a new session is dropped on its center target', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });
        useSessionSplitCanvasDragStateSpy.mockReturnValue(true);

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const hostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            onLeafDrop?: (input: Readonly<{
                payload: string;
                target: SplitCanvasDropTarget;
            }>) => void;
        } | undefined;

        await hostProps?.onLeafDrop?.({
            payload: JSON.stringify({ sessionId: 'sess_4' }),
            target: {
                leafId: 'session-leaf:sess_2',
                placement: 'center',
            },
        });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'splitLeaf',
            targetLeafId: 'session-leaf:sess_2',
            axis: 'row',
            placement: 'after',
            newLeaf: expect.objectContaining({
                id: 'session-leaf:sess_4',
                payload: { sessionId: 'sess_4' },
            }),
        }));
        expect(focusSession).not.toHaveBeenCalled();
    });

    it('uses the exact nested target leaf id when handling drop actions inside nested splits', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: nestedSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });
        useSessionSplitCanvasDragStateSpy.mockReturnValue(true);

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const hostProps = splitCanvasHostSpy.mock.calls.at(-1)?.[0] as {
            onLeafDrop?: (input: Readonly<{
                payload: string;
                target: SplitCanvasDropTarget;
            }>) => void;
        } | undefined;

        await hostProps?.onLeafDrop?.({
            payload: JSON.stringify({ sessionId: 'sess_9' }),
            target: {
                leafId: 'session-leaf:sess_3',
                placement: 'down',
            },
        });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            type: 'splitLeaf',
            targetLeafId: 'session-leaf:sess_3',
            axis: 'column',
            placement: 'after',
        }));
    });

    it('focuses a leaf when the rendered session surface is interacted with', async () => {
        const dispatch = vi.fn();
        const openSessionInSplit = vi.fn();
        const focusSession = vi.fn();
        useSessionSplitCanvasStateSpy.mockReturnValue({
            state: baseSplitCanvasState,
            dispatch,
            openSessionInSplit,
            focusSession,
        });

        const { SessionSplitCanvasScreen } = await import('./SessionSplitCanvasScreen');
        await renderScreen(
            <SessionSplitCanvasScreen
                sessionId="sess_2"
                routeServerId="server-route"
            />,
        );

        const secondLeafProps = sessionCanvasLeafSpy.mock.calls.at(-1)?.[0] as {
            onSurfaceInteract?: () => void;
        } | undefined;

        expect(secondLeafProps?.onSurfaceInteract).toBeTypeOf('function');

        secondLeafProps?.onSurfaceInteract?.();

        expect(focusSession).toHaveBeenCalledWith('sess_2');
    });
});

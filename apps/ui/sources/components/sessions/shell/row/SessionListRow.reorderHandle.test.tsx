import React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionFixture,
    pressTestInstanceAsync,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
    type TreeDropResult,
    type TreeDropVisualGeometry,
} from '@/components/ui/treeDragDrop';
import type { UseSessionInlineDragResolvedDrop } from '../useSessionInlineDrag';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockGestureEvent = Record<string, unknown>;

type MockGesture = {
    kind: 'pan';
    config: Record<string, unknown>;
    handlers: Record<string, (event?: MockGestureEvent) => void>;
} & Record<string, unknown>;

function createMockPanGesture(): MockGesture {
    const gesture: MockGesture = {
        kind: 'pan' as const,
        config: {},
        handlers: {},
    };

    const chain = <TArgs extends readonly unknown[]>(method: string, handler: (...args: TArgs) => MockGesture) => {
        gesture[method] = handler;
    };

    chain('minDistance', (value: number) => {
        gesture.config.minDistance = value;
        return gesture;
    });
    chain('activateAfterLongPress', (value: number) => {
        gesture.config.activateAfterLongPress = value;
        return gesture;
    });
    chain('cancelsTouchesInView', (value: boolean) => {
        gesture.config.cancelsTouchesInView = value;
        return gesture;
    });
    for (const method of ['onStart', 'onUpdate', 'onEnd', 'onFinalize', 'onTouchesDown', 'onTouchesMove', 'onTouchesUp', 'onTouchesCancelled']) {
        chain(method, (handler: (event?: MockGestureEvent) => void) => {
            gesture.handlers[method] = handler;
            return gesture;
        });
    }

    return gesture;
}

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('react-native-reanimated', () => ({
    default: {
        View: 'Animated.View',
    },
    Easing: {
        bezier: () => 'bezier',
        linear: 'linear',
    },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    withSpring: (value: unknown) => value,
}));

vi.mock('react-native-gesture-handler', () => ({
    Gesture: {
        Pan: () => createMockPanGesture(),
    },
    GestureDetector: (props: { gesture: MockGesture; children: React.ReactNode }) =>
        React.createElement('GestureDetector', { gesture: props.gesture }, props.children),
    Swipeable: 'Swipeable',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: 'status',
        statusDotColor: 'dot',
        isPulsing: false,
    }),
}));

const navigateToSessionSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: unknown) => [false, fn],
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                }),
                useSession: () => null,
            },
        });
    },
});

function overlayShared(): TreeDropOverlaySharedValues {
    return {
        overlayVisible: { value: 0 },
        overlayKind: { value: TREE_DROP_OVERLAY_KIND_NONE as TreeDropOverlayKind },
        overlayTop: { value: 0 },
        overlayHeight: { value: 0 },
        overlayLeft: { value: 0 },
        overlayRight: { value: 0 },
        overlayDepth: { value: 0 },
    };
}

function lineResolved(): UseSessionInlineDragResolvedDrop {
    const result: TreeDropResult = {
        instruction: {
            kind: 'reorder-before',
            targetId: 'session:server_a:sess_target',
            containerId: 'workspace-root:server_a',
            parentId: null,
            depth: 0,
        },
        visual: {
            kind: 'line',
            targetId: 'session:server_a:sess_target',
            edge: 'top',
            depth: 0,
        },
    };
    const geometry: TreeDropVisualGeometry = {
        kind: 'line',
        depth: 0,
        edge: 'top',
        targetId: 'session:server_a:sess_target',
        geometry: { top: 40, left: 16, width: 320, height: 2 },
    };
    return { result, geometry, destinationKey: 'workspace-root:server_a:slot:0' };
}

function triggerHoverEnter(node: ReactTestInstance) {
    node.props.onMouseEnter?.();
    node.props.onHoverIn?.();
    node.props.onPointerEnter?.();
}

function requireTestInstance(instance: ReactTestInstance | null, label: string): ReactTestInstance {
    if (instance) return instance;
    throw new Error(`Missing ${label}`);
}

describe('SessionListRow reorder handle', () => {
    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        vi.useRealTimers();
    });

    it('commits a handle drag without allowing the release press to open the source session', async () => {
        vi.useFakeTimers();

        const { SessionListRow } = await import('./SessionListRow');
        const onDragStart = vi.fn();
        const onDropResult = vi.fn();
        const resolved = lineResolved();
        const session = createSessionFixture({
            id: 'sess_source',
            active: true,
            metadata: null,
        });

        const screen = await renderScreen(
            <SessionListRow
                session={session}
                rowModel={createSessionItemTestRowModel({
                    session,
                    serverId: 'server_a',
                    serverName: 'Server A',
                    showServerBadge: true,
                })}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={false}
                isSingle={false}
                variant="default"
                compact={false}
                sessionKey="sess_source"
                treeRowId="session:server_a:sess_source"
                groupKey="workspace-root:server_a"
                onDragStart={onDragStart}
                resolveDropResult={() => resolved}
                onDropResult={onDropResult}
                onDragCancel={vi.fn()}
                isDragActive={false}
                isBeingDragged={false}
                dataIndex={0}
                overlayShared={overlayShared()}
                onRegisterTreeRowBounds={vi.fn()}
                onUnregisterTreeRowBounds={vi.fn()}
            />,
        );

        const rightArea = requireTestInstance(screen.findByTestId('session-item-right-area'), 'session item right area');
        await act(async () => {
            triggerHoverEnter(rightArea);
        });

        const handle = requireTestInstance(screen.findByTestId('session-item-reorder-handle'), 'session reorder handle');
        const gesture = handle.parent?.props.gesture as MockGesture | undefined;
        expect(gesture).toBeTruthy();

        await act(async () => {
            handle.props.onPointerDown?.({});
            gesture?.handlers.onStart?.();
            gesture?.handlers.onUpdate?.({
                translationY: 80,
                absoluteX: 24,
                absoluteY: 120,
            });
            vi.advanceTimersByTime(600);
            gesture?.handlers.onEnd?.({
                translationY: 90,
                absoluteX: 24,
                absoluteY: 140,
            });
            handle.props.onPointerUp?.({});
        });

        expect(onDragStart).toHaveBeenCalledWith('sess_source');
        expect(onDropResult).toHaveBeenCalledWith({
            sessionKey: 'sess_source',
            groupKey: 'workspace-root:server_a',
            dataIndex: 0,
            result: resolved.result,
        });

        const row = screen.findByTestId('session-list-item-sess_source');
        await act(async () => {
            await pressTestInstanceAsync(row, 'session list row after handle drag');
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            await pressTestInstanceAsync(row, 'session list row follow-up press');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledTimes(1);
        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_source', { serverId: 'server_a' });
    });

    it('does not render or attach the reorder handle when drag affordance is disabled', async () => {
        const { SessionListRow } = await import('./SessionListRow');
        const session = createSessionFixture({
            id: 'sess_source',
            active: true,
            metadata: null,
        });
        const rowProps = {
            session,
            rowModel: createSessionItemTestRowModel({
                session,
                serverId: 'server_a',
                serverName: 'Server A',
                showServerBadge: true,
            }),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: false,
            isSingle: false,
            variant: 'default' as const,
            compact: false,
            sessionKey: 'sess_source',
            treeRowId: 'session:server_a:sess_source',
            groupKey: 'workspace-root:server_a',
            onDragStart: vi.fn(),
            resolveDropResult: () => lineResolved(),
            onDropResult: vi.fn(),
            onDragCancel: vi.fn(),
            isDragActive: false,
            isBeingDragged: false,
            dataIndex: 0,
            overlayShared: overlayShared(),
            onRegisterTreeRowBounds: vi.fn(),
            onUnregisterTreeRowBounds: vi.fn(),
            dragEnabled: false,
        };

        const screen = await renderScreen(
            <SessionListRow {...rowProps} />,
        );

        const rightArea = requireTestInstance(screen.findByTestId('session-item-right-area'), 'session item right area');
        await act(async () => {
            triggerHoverEnter(rightArea);
        });

        expect(screen.findByTestId('session-item-reorder-handle')).toBeNull();
        expect(rowProps.onDragStart).not.toHaveBeenCalled();
    });
});

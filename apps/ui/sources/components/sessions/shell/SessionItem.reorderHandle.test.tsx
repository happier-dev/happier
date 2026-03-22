import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

const mockGesture = { type: 'pan' };
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', { gesture: props.gesture }, props.children),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                        OS: 'web',
                                    },
                                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
    useSession: () => null,
    useSessionListMeaningfulActivityAt: () => null,
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const sessionItemModulePromise = import('./SessionItem');

function findRowPressable(tree: renderer.ReactTestRenderer) {
    const pressables = tree.root.findAllByType('Pressable');
    const row = pressables.find((p) => !p.props.accessibilityLabel);
    if (!row) throw new Error('Row Pressable not found');
    return row;
}

function triggerHoverEnter(node: renderer.ReactTestInstance) {
    node.props.onMouseEnter?.();
    node.props.onHoverIn?.();
    node.props.onPointerEnter?.();
}

describe('SessionItem reorder handle', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a GestureDetector-wrapped reorder handle when reorderHandleGesture is provided', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = {
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                reorderHandleGesture={mockGesture as any}
            />,
        );

        // On web, actions are only rendered on hover. Trigger hover first.
        const row = findRowPressable(screen.tree);
        await act(async () => {
            triggerHoverEnter(row);
        });

        const handles = screen.findAllByTestId('session-item-reorder-handle');
        expect(handles).toHaveLength(1);

        // Verify the handle is wrapped in a GestureDetector
        const gestureDetectors = screen.root.findAllByType('GestureDetector');
        expect(gestureDetectors.length).toBeGreaterThanOrEqual(1);
        const handleDetector = gestureDetectors.find((g: any) => g.props.gesture === mockGesture);
        expect(handleDetector).toBeTruthy();
    });

    it('renders the reorder handle without hover when isBeingDragged is true', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = {
            id: 'sess_3',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                reorderHandleGesture={mockGesture as any}
                isBeingDragged={true}
            />,
        );

        // Do NOT trigger hover — isBeingDragged should force the handle visible
        const handles = screen.findAllByTestId('session-item-reorder-handle');
        expect(handles).toHaveLength(1);
    });

    it('does not render a reorder handle when reorderHandleGesture is not provided', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = {
            id: 'sess_2',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const row = findRowPressable(screen.tree);
        await act(async () => {
            triggerHoverEnter(row);
        });

        const handles = screen.findAllByTestId('session-item-reorder-handle');
        expect(handles).toHaveLength(0);
    });
});

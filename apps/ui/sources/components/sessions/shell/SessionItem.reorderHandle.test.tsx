import React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

const mockGesture = { type: 'pan' };
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', { gesture: props.gesture }, props.children),
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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
            useSessionListMeaningfulActivityAt: () => null,
        });
    },
});

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
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

const navigateToSessionSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
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

const sessionItemModulePromise = import('./SessionItem').then(({ SessionItem }) => (
    createModelBackedSessionItemTestComponent(SessionItem)
));

function triggerHoverEnter(node: ReactTestInstance) {
    node.props.onMouseEnter?.();
    node.props.onHoverIn?.();
    node.props.onPointerEnter?.();
}

describe('SessionItem reorder handle', () => {
    afterEach(() => {
        navigateToSessionSpy.mockClear();
        standardCleanup();
    });

    it('renders a GestureDetector-wrapped reorder handle when reorderHandleGesture is provided', async () => {
        const SessionItem = await sessionItemModulePromise;
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
        const row = screen.findByTestId('session-list-item-sess_1');
        expect(row).toBeTruthy();
        const hoverTargets = screen.tree.root.findAll((node) => (
            typeof node.props?.onPointerEnter === 'function'
            || typeof node.props?.onMouseEnter === 'function'
            || typeof node.props?.onHoverIn === 'function'
        ));
        expect(hoverTargets.length).toBeGreaterThan(0);
        await act(async () => {
            for (const target of hoverTargets) {
                triggerHoverEnter(target);
            }
        });

        const handles = screen.findAllByTestId('session-item-reorder-handle');
        expect(handles).toHaveLength(1);

        const handle = handles[0];
        expect(handle.parent?.type).toBe('GestureDetector');
        expect(handle.parent?.props.gesture).toBe(mockGesture);
    });

    it('renders the reorder handle without hover when isBeingDragged is true', async () => {
        const SessionItem = await sessionItemModulePromise;
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
        const SessionItem = await sessionItemModulePromise;
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

        const row = screen.findByTestId('session-list-item-sess_2');
        expect(row).toBeTruthy();
        await act(async () => {
            triggerHoverEnter(row!);
        });

        const handles = screen.findAllByTestId('session-item-reorder-handle');
        expect(handles).toHaveLength(0);
    });

    it('suppresses the next row press when the reorder handle receives a pointer gesture', async () => {
        const SessionItem = await sessionItemModulePromise;
        const session = {
            id: 'sess_4',
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

        const row = screen.findByTestId('session-list-item-sess_4');
        expect(row).toBeTruthy();
        const hoverTargets = screen.tree.root.findAll((node) => (
            typeof node.props?.onPointerEnter === 'function'
            || typeof node.props?.onMouseEnter === 'function'
            || typeof node.props?.onHoverIn === 'function'
        ));
        expect(hoverTargets.length).toBeGreaterThan(0);
        await act(async () => {
            for (const target of hoverTargets) {
                triggerHoverEnter(target);
            }
        });

        const handle = screen.findByTestId('session-item-reorder-handle');
        expect(handle).toBeTruthy();

        await act(async () => {
            handle?.props.onPointerDown?.({});
            handle?.props.onPointerUp?.({});
        });
        await act(async () => {
            await pressTestInstanceAsync(row, 'session list row after handle pointer gesture');
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            await pressTestInstanceAsync(row, 'session list row follow-up press');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledTimes(1);
        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_a' });
    });
});

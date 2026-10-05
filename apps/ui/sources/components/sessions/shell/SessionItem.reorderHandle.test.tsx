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
    isUntitledSessionName: (name: string) => name === 'session.untitled',
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

const SESSION = {
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
} as const;

async function hoverAll(screen: Awaited<ReturnType<typeof renderScreen>>): Promise<void> {
    const hoverTargets = screen.tree.root.findAll((node) => (
        typeof node.props?.onPointerEnter === 'function'
        || typeof node.props?.onMouseEnter === 'function'
        || typeof node.props?.onHoverIn === 'function'
    ));
    await act(async () => {
        for (const target of hoverTargets) triggerHoverEnter(target);
    });
}

describe('SessionItem desktop carry (E1)', () => {
    afterEach(() => {
        navigateToSessionSpy.mockClear();
        standardCleanup();
    });

    it('draws no separate drag handle or grip on a hovered desktop row: the whole row is the source', async () => {
        const SessionItem = await sessionItemModulePromise;
        const screen = await renderScreen(
            <SessionItem
                session={{ ...SESSION, id: 'sess_1' } as any}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                dragEnabled
            />,
        );
        await hoverAll(screen);

        expect(screen.findAllByTestId('session-item-reorder-handle')).toHaveLength(0);
        expect(screen.findAllByTestId('session-item-drag-grip-sess_1')).toHaveLength(0);
    });
});

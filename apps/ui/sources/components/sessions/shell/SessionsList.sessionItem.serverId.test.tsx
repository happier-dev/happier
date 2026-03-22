import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>;

const navigateSpy = vi.fn();
const themeColors = vi.hoisted(() => ({
    surface: '#fff',
    surfaceSelected: '#eee',
    divider: '#ddd',
    text: '#111',
    textSecondary: '#666',
    textLink: '#07f',
    input: { background: '#f0f0f0' },
    groupped: { background: '#f7f7f7' },
    status: { error: '#f00' },
    button: { primary: { tint: '#fff' } },
}));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: themeColors,
    });
});
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Platform: { OS: 'web' },
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
    Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', {
        ...props,
        testID: props.testID ?? 'session-item-avatar',
    }),
}));
vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));
vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateSpy,
}));
vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));
vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));
vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
            sessionRename: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
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
            }),
            useSession: () => null,
            useSessionListMeaningfulActivityAt: () => null,
        },
    });
});
vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));
vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

describe('SessionItem navigation', () => {
    function createSession(id: string) {
        return {
            id,
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
    }

    async function renderSessionItem(props: SessionItemProps) {
        const { SessionItem } = await import('./SessionItem');
        return renderScreen(<SessionItem {...props} />);
    }

    afterEach(() => {
        standardCleanup();
    });

    it('passes serverId when navigating to a session', async () => {
        navigateSpy.mockClear();

        const screen = await renderSessionItem({
            session: createSession('sess_1'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        await screen.pressByTestIdAsync('session-list-item-sess_1');

        expect(navigateSpy).toHaveBeenCalledTimes(1);
        expect(navigateSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });

        await screen.unmount();
    });

    it('hides avatars in minimal compact mode', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_min'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: true,
            compactMinimal: true,
        });

        expect(screen.findByTestId('session-item-avatar')).toBeNull();

        await screen.unmount();
    });
});

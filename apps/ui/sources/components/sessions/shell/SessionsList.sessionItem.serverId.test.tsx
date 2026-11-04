import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = ModelBackedSessionItemTestProps;

const navigateSpy = vi.fn();
installDisconnectedServerSocketBoundary();
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

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
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
                    name: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                    connectedAccountsV4: [],
                    connectedAccountGroupsV4: [],
                }),
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
            },
        });
    },
});
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
// Real `@/constants/Typography` is used: it depends only on the mocked
// `react-native` Platform, and the row corridor evaluates the meta type role
// while module mocks initialize (browser/frame/styles.ts), so a partial
// `default`-only mock fails mock-factory initialization.
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/sessions/sessionUtils')>();
    return {
        ...actual,
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
    };
});
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', {
        ...props,
        testID: props.testID ?? 'session-item-avatar',
    }),
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
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
            sessionStopWithServerScope: vi.fn(async (sessionId: string) => ({ success: true, sessionId, stopped: true as const })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
            sessionRename: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));
vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

describe('SessionItem navigation', () => {
    function createSession(id: string) {
        return createSessionFixture({
            id,
            active: true,
            activeAt: 1,
            metadata: { path: '/repo', machineId: 'machine-canvas', host: 'canvas.local' },
        });
    }

    async function renderSessionItem(props: SessionItemProps) {
        const { SessionItem } = await import('./SessionItem');
        const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem, {
            resolveRowViewModelOverrides: (itemProps) => ({
                identityDisplay: itemProps.compactMinimal === true ? 'none' : 'avatar',
            }),
        });
        return renderScreen(<ModelBackedSessionItem {...props} />);
    }

    afterEach(async () => {
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
            variant: 'default',
            compact: true,
            compactMinimal: true,
        });

        expect(screen.findByTestId('session-item-avatar')).toBeNull();

        await screen.unmount();
    });
});

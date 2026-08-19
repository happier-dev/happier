import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveSessionRowPresentation } from './row/resolveSessionRowPresentation';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A row kept in Needs attention SAYS SO, and says so to a screen reader too.
 *
 * The resolver already pins that a standing row asks for the status line and the muted marker.
 * Nothing pinned that the row paints them: a read, idle session's row draws no attention signal at
 * all, so a standing row that lost the join would sit in the band looking exactly like a dormant
 * one — the failure this whole feature exists to prevent, and invisible to every unit test above it.
 */

type SessionItemProps = Omit<
    React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
    'rowModel'
> & {
    rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
};

vi.mock('react-native-reanimated', () => ({}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
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
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: '',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
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
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

const SESSION_ID = 'sess_1';
const STATUS_TEXT_TEST_ID = `session-list-status-subtitle-text-${SESSION_ID}-quiet`;
const INDICATOR_TEST_ID = `session-row-attention-indicator-${SESSION_ID}-secondary`;

describe('SessionItem attention standing', () => {
    function createSession() {
        return {
            id: SESSION_ID,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
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

    /** A read, idle session: nothing about it produces an attention signal of its own. */
    async function renderRow(standing: boolean) {
        const { SessionItem } = await import('./SessionItem');
        const props: SessionItemProps = {
            session: createSession(),
            serverId: 'server_a',
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'no-path',
            compact: false,
        };
        return renderScreen(
            <SessionItem
                {...props}
                rowModel={createSessionItemTestRowModel(props, {
                    presentation: resolveSessionRowPresentation({
                        attentionState: 'quiet',
                        standing,
                        density: 'default',
                        requestedSecondaryLineMode: 'status',
                        hasPathSubtitle: false,
                    }),
                })}
            />,
        );
    }

    afterEach(() => {
        standardCleanup();
    });

    it('says why a kept session is still in the band, and announces it', async () => {
        const screen = await renderRow(true);

        expect(screen.findByTestId(STATUS_TEXT_TEST_ID)?.props.children).toBe('status.keptInAttention');
        expect(screen.findByTestId(INDICATOR_TEST_ID)?.props.accessibilityLabel).toBe('status.keptInAttention');
    });

    it('leaves a read idle row silent when it is not kept', async () => {
        const screen = await renderRow(false);

        expect(screen.findByTestId(STATUS_TEXT_TEST_ID)).toBeNull();
        expect(screen.findByTestId(INDICATOR_TEST_ID)).toBeNull();
    });
});

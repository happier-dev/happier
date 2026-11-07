import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The updated session animation is a presentation of the row's existing attention state: the
 * setting reaches the row through the row model, and only the states that wait on the person
 * (permission, action, failed) get the animated layer. What the layer looks like over time is the
 * animation's business; this pins that it is there for those rows and absent for every other.
 */

type SessionItemProps = Omit<
    React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
    'rowModel'
> & {
    rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
};

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
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

const SESSION_ID = 'sess_attention';
const LAYER_TEST_ID = `session-item-updated-animation-${SESSION_ID}`;

type RowAttention = 'permission_required' | 'action_required' | 'failed' | 'working' | 'quiet' | 'unread' | 'ready';
type Animation = 'none' | 'fade' | 'glow' | 'sweep';

const indicatorByState = {
    permission_required: 'permission',
    action_required: 'action',
    failed: 'failed',
    working: 'working',
    unread: 'unread',
    ready: 'ready',
    quiet: 'none',
} as const;

describe('SessionItem updated session animation', () => {
    function createSession() {
        return {
            id: SESSION_ID,
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
            thinkingAt: 1,
            presence: 'online',
        } as any;
    }

    const status: SessionStatus = {
        state: 'permission_required',
        isConnected: true,
        statusText: 'Permission needed',
        statusColor: 'status-color',
        statusDotColor: 'status-dot-color',
        isPulsing: true,
        shouldShowStatus: true,
    };

    async function renderRow(rowState: RowAttention, updatedSessionAnimation: Animation) {
        const { SessionItem } = await import('./SessionItem');
        const props: SessionItemProps = { session: createSession(), compact: false, variant: 'no-path' };
        return renderScreen(
            <SessionItem
                {...props}
                rowModel={createSessionItemTestRowModel(props, {
                    status,
                    updatedSessionAnimation,
                    attention: { listState: rowState === 'working' ? 'thinking' : rowState, rowState },
                    presentation: {
                        attentionIndicator: indicatorByState[rowState],
                        titleTone: rowState === 'quiet' ? 'quiet' : 'emphasized',
                        secondaryLine: 'status',
                    },
                })}
            />,
        );
    }

    afterEach(() => {
        standardCleanup();
    });

    const waiting = ['permission_required', 'action_required', 'failed'] as const;
    // An unseen update that needs no input is drawn too, in light blue.
    const unseen = ['unread', 'ready'] as const;
    const animated = [...waiting, ...unseen] as const;
    const styles = ['fade', 'glow', 'sweep'] as const;

    it.each(styles.flatMap((animation) => animated.map((rowState) => [animation, rowState] as const)))(
        'animates a %s row for %s',
        async (animation, rowState) => {
            const screen = await renderRow(rowState, animation);

            const layer = screen.findByTestId(LAYER_TEST_ID);
            expect(layer).toBeTruthy();
            // Decorative: it must never be announced or take a press from the row beneath it.
            expect(layer?.props.pointerEvents).toBe('none');
            expect(layer?.props.accessible).toBe(false);
        },
    );

    it.each(waiting)('leaves a %s row untouched when the animation is none', async (rowState) => {
        const screen = await renderRow(rowState, 'none');

        expect(screen.findByTestId(LAYER_TEST_ID)).toBeNull();
    });

    it.each(['working', 'quiet'] as const)('never animates a %s row', async (rowState) => {
        const screen = await renderRow(rowState, 'glow');

        expect(screen.findByTestId(LAYER_TEST_ID)).toBeNull();
    });
});

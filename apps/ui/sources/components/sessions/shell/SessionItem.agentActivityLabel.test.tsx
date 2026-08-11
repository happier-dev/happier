import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The session-list row DRAWS the agent-activity sentence it was handed.
 *
 * `buildSessionListRowModel` already pins what the sentence says — it composes through the same
 * owner as the composer chip, so the row and the session it opens onto cannot disagree. Nothing
 * pinned that the row paints it: the render is a pure pass-through of `rowModel.agentActivityLabel`,
 * and deleting the whole `<Text testID="session-list-agent-activity-count-*">` block left every
 * suite green. That is the same false-green shape this corridor already hit at the pane roster and
 * at the run panel — a decision correctly owned and then silently unrendered.
 *
 * So this asserts the join, and only the join: the row model's string reaches a painted node, and
 * an absent string paints nothing. What the string SAYS stays in `buildSessionListRowModel.test.ts`.
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
        statusText: 'Working',
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
const AGENT_ACTIVITY_TEST_ID = `session-list-agent-activity-count-${SESSION_ID}`;

describe('SessionItem agent-activity label', () => {
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
            thinking: true,
            thinkingAt: 1,
            presence: 'online',
        } as any;
    }

    /** A live session, so the row shows the STATUS secondary line the label sits on. */
    const workingStatus: SessionStatus = {
        state: 'thinking',
        isConnected: true,
        statusText: 'Working',
        statusColor: 'status-color',
        statusDotColor: 'status-dot-color',
        isPulsing: true,
        shouldShowStatus: true,
    };

    async function renderRow(agentActivityLabel: string | null) {
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
                    status: workingStatus,
                    agentActivityLabel,
                })}
            />,
        );
    }

    afterEach(() => {
        standardCleanup();
    });

    it('paints the sentence the row model handed it', async () => {
        const screen = await renderRow('3 subagents working');

        const label = screen.findByTestId(AGENT_ACTIVITY_TEST_ID);
        expect(label).toBeTruthy();
        expect(label?.props.children).toBe('3 subagents working');
    });

    it('paints the workflow sentence verbatim rather than a count of its own', async () => {
        const screen = await renderRow('1 workflow, 5 agents');

        expect(screen.findByTestId(AGENT_ACTIVITY_TEST_ID)?.props.children)
            .toBe('1 workflow, 5 agents');
    });

    it('paints nothing when the row model says nothing, and still draws the status line', async () => {
        const screen = await renderRow(null);

        expect(screen.findByTestId(AGENT_ACTIVITY_TEST_ID)).toBeNull();
        expect(screen.findByTestId(`session-list-status-subtitle-text-${SESSION_ID}-working`)?.props.children)
            .toBe('Working');
    });
});

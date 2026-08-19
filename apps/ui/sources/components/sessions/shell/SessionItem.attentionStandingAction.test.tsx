import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from '@/components/sessions/actions/sessionActionIds';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type {
    SessionListRowPresentationSettings,
    SessionListRowSessionItem,
} from './row/sessionListRowModelTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Keep in Needs attention action has to reach the row through the SAME producer chain the app
 * uses: list settings -> row model -> row props -> action target -> availability -> menu. A test
 * that hands `createSessionActionTarget` an `attentionStanding` flag directly proves nothing,
 * because the shipped defect was that no production caller ever passed one.
 */

const SERVER_ID = 'server_a';
const SESSION_ID = 'sess_1';
const SESSION_KEY = `${SERVER_ID}:${SESSION_ID}`;

const sessionOrganizationOps = vi.hoisted(() => ({
    sessionSetAttentionStandingWithServerScope: vi.fn(async () => ({ success: true })),
}));

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
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/sessionUtils')>(),
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: false,
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
vi.mock('@/sync/ops/sessionOrganization', () => sessionOrganizationOps);
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

function createSession() {
    return {
        id: SESSION_ID,
        seq: 1,
        lastViewedSessionSeq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        owner: 'u1',
        accessLevel: undefined,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    } as any;
}

function createRowPresentationSettings(params: Readonly<{
    attentionStandingEnabled: boolean;
    attentionStandingPolicy: SessionAttentionStandingPolicy;
}>): SessionListRowPresentationSettings {
    return {
        currentUserId: 'u1',
        density: 'default',
        compact: false,
        compactMinimal: false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingTextMode: 'static',
        statusColors: {
            connected: '#0f0',
            connecting: '#ff0',
            actionRequired: '#f80',
            disconnected: '#888',
            error: '#f00',
            default: '#000',
        },
        hideInactiveSessions: false,
        showServerBadge: false,
        showPinnedServerBadge: false,
        agentActivityCountEnabled: false,
        tagsEnabled: false,
        sessionTagsByKey: {},
        allKnownTags: [],
        pinnedSessionKeys: [],
        attentionStandingEnabled: params.attentionStandingEnabled,
        attentionStandingPolicy: params.attentionStandingPolicy,
        hasMultipleMachines: false,
        reachableSessionDisplayByKey: {},
        folderViewEnabled: false,
        relativeNowMs: 1_000,
        runtimeNowMs: 1_000,
    };
}

async function renderRow(params: Readonly<{
    attentionStandingEnabled: boolean;
    attentionStandingPolicy: SessionAttentionStandingPolicy;
}>) {
    const { SessionItem } = await import('./SessionItem');
    const { buildSessionListRowModel } = await import('./row/buildSessionListRowModel');
    const session = createSession();
    const item: SessionListRowSessionItem = {
        type: 'session',
        session,
        serverId: SERVER_ID,
        groupKey: 'group-a',
        groupKind: 'date',
        variant: 'no-path',
    };
    const rowModel = buildSessionListRowModel({
        item,
        dataIndex: 0,
        isFirst: true,
        isLast: true,
        isSingle: true,
        settings: createRowPresentationSettings(params),
    });

    return renderScreen(
        <SessionItem
            session={session}
            serverId={SERVER_ID}
            currentUserId="u1"
            selected={false}
            isFirst
            isLast
            isSingle
            variant="no-path"
            compact={false}
            rowModel={rowModel}
        />,
    );
}

type RenderedRow = Awaited<ReturnType<typeof renderRow>>;

function hoverRow(screen: RenderedRow) {
    const row = screen.findByTestId(`session-list-item-${SESSION_ID}`) as any;
    const container = row?.parent as any;
    if (!container) throw new Error('expected session row container');
    container.props.onMouseEnter?.();
    container.props.onHoverIn?.();
    container.props.onPointerEnter?.();
}

function findRowMoreMenu(screen: RenderedRow) {
    const menus = screen.root.findAll((node) => String(node.type) === 'DropdownMenu'
        && Array.isArray(node.props?.items)
        && typeof node.props?.onSelect === 'function');
    const menu = menus.find((node) => (node.props.items as Array<{ id?: string }>)
        .some((entry) => typeof entry?.id === 'string' && entry.id.startsWith('ui.session.')));
    return menu ?? null;
}

function listRowMenuActionIds(screen: RenderedRow): string[] {
    const menu = findRowMoreMenu(screen);
    if (!menu) return [];
    return (menu.props.items as Array<{ id?: string }>).map((entry) => String(entry?.id ?? ''));
}

describe('SessionItem attention standing action', () => {
    beforeEach(() => {
        sessionOrganizationOps.sessionSetAttentionStandingWithServerScope.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('offers Keep in Needs attention for a session that is not standing', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
        });
        await act(async () => {
            hoverRow(screen);
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);

        await screen.unmount();
    });

    it('offers Remove from Needs attention for a stored standing session', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: {
                defaultStanding: false,
                overridesBySessionKey: { [SESSION_KEY]: true },
            },
        });
        await act(async () => {
            hoverRow(screen);
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);

        await screen.unmount();
    });

    it('honours an explicit not-standing override against a standing default', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: {
                defaultStanding: true,
                overridesBySessionKey: { [SESSION_KEY]: false },
            },
        });
        await act(async () => {
            hoverRow(screen);
        });

        expect(listRowMenuActionIds(screen)).toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);

        await screen.unmount();
    });

    it('hides both attention standing actions while the attention band is off', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: false,
            attentionStandingPolicy: {
                defaultStanding: false,
                overridesBySessionKey: { [SESSION_KEY]: true },
            },
        });
        await act(async () => {
            hoverRow(screen);
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);

        await screen.unmount();
    });

    it('writes the chosen standing through the session organization op', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
        });
        await act(async () => {
            hoverRow(screen);
        });

        const menu = findRowMoreMenu(screen);
        expect(menu).not.toBeNull();
        await act(async () => {
            await menu?.props.onSelect(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        });

        expect(sessionOrganizationOps.sessionSetAttentionStandingWithServerScope).toHaveBeenCalledWith(
            SESSION_ID,
            true,
            { serverId: SERVER_ID },
        );

        await screen.unmount();
    });
});

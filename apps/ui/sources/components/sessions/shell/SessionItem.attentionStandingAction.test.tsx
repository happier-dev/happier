/**
 * The Keep in Needs attention action has to reach a session-list row through the SAME producer
 * chain the app uses: standing policy -> row view model -> SessionItem props -> action target ->
 * availability -> row menu -> dispatch. A test that hands `createSessionActionTarget` its standing
 * inputs directly proves nothing, because the defect this guards against is that no production
 * caller passed them and the row menu silently offered neither direction.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from '@/components/sessions/actions/sessionActionIds';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let SERVER_ID: string;
const SESSION_ID = 'sess_standing';
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const standingPath = `/v2/session-organization/attention-standings/${SESSION_ID}`;

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => React.createElement('ContextMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
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
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

function createRenderableSession(): SessionListRenderableSession {
    return createSessionListRenderableSessionFixture({
        id: SESSION_ID,
        seq: 4,
        lastViewedSessionSeq: 4,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        owner: 'u1',
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    });
}

const BASE_ITEM = {
    type: 'session',
    sessionId: SESSION_ID,
    storageKind: 'persisted',
    groupKey: 'attention-placement-v1',
    groupKind: 'attention',
} satisfies Extract<SessionListIndexItem, { type: 'session' }>;

async function renderRow(params: Readonly<{
    attentionStandingEnabled: boolean;
    attentionStandingPolicy: SessionAttentionStandingPolicy;
    attentionPlacementReason?: 'standing' | 'unread';
}>) {
    const { SessionItem } = await import('./SessionItem');
    const { buildSessionListRowViewModels } = await import('./sessionListRowViewModels');
    const session = createRenderableSession();
    const rowKey = buildSessionListServerScopedRowKey(SERVER_ID, SESSION_ID);
    if (!rowKey) throw new Error('expected a row key');
    const rowViewModel = buildSessionListRowViewModels({
        listItems: [{ ...BASE_ITEM, serverId: SERVER_ID, attentionPlacementReason: params.attentionPlacementReason }],
        reachableSessionDisplayById: new Map(),
        rowRenderableByKey: new Map([[rowKey, session]]),
        relativeNowMs: 1_000,
        runtimeNowMs: 1_000,
        hasMultipleMachines: false,
        pinnedSessionKeys: new Set(),
        sessionTags: {},
        selectedSessionId: null,
        showServerBadge: false,
        showPinnedServerBadge: false,
        attentionStandingEnabled: params.attentionStandingEnabled,
        attentionStandingPolicy: params.attentionStandingPolicy,
    })[0];
    if (!rowViewModel) throw new Error('expected a row view model');

    return renderScreen(
        <SessionItem
            session={session}
            rowViewModel={rowViewModel}
            serverId={SERVER_ID}
            currentUserId="u1"
            selected={false}
            isFirst
            isLast
            isSingle
            variant="default"
            compact={false}
        />,
    );
}

type RenderedRow = Awaited<ReturnType<typeof renderRow>>;

function findRowMenu(screen: RenderedRow) {
    return screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) => (
        Array.isArray(node.props?.items)
        && typeof node.props?.onSelect === 'function'
        && node.props.items.some((entry: any) => typeof entry?.id === 'string' && entry.id.startsWith('ui.session.'))
    )) ?? null;
}

function listRowMenuActionIds(screen: RenderedRow): string[] {
    const menu = findRowMenu(screen);
    if (!menu) return [];
    return (menu.props.items as Array<{ id?: string }>).map((entry) => String(entry?.id ?? ''));
}

describe('SessionItem attention standing action', () => {
    beforeEach(async () => {
        await home.reset();
        SERVER_ID = await home.addHome({ name: 'Session Home', serverUrl: 'https://session-standing.test', accountId: 'u1' });
        home.answer(SERVER_ID, standingPath, {
            body: { standing: { sessionId: SESSION_ID, standing: true, updatedAt: 1 } },
        });
    });
    afterEach(async () => {
        await standardCleanup();
        await home.reset();
    });

    it('offers Keep in Needs attention for a session with no stored standing', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
    });

    it('offers Remove from Needs attention for a stored standing session placed for another reason', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: {
                defaultStanding: false,
                overridesBySessionKey: { [buildSessionOrganizationSessionKey(SERVER_ID, SESSION_ID)]: true },
            },
            // Placed as unread, so the presentation flag is false while the STORED bit is true.
            attentionPlacementReason: 'unread',
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    });

    it('hides both directions while the attention band is off', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: false,
            attentionStandingPolicy: {
                defaultStanding: false,
                overridesBySessionKey: { [buildSessionOrganizationSessionKey(SERVER_ID, SESSION_ID)]: true },
            },
        });

        const ids = listRowMenuActionIds(screen);
        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
    });

    it('writes the chosen standing through the session organization op', async () => {
        const screen = await renderRow({
            attentionStandingEnabled: true,
            attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
        });

        const menu = findRowMenu(screen);
        expect(menu).not.toBeNull();
        await act(async () => {
            await menu?.props.onSelect(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        });

        expect(home.requestsFor(standingPath)).toMatchObject([
            { serverId: SERVER_ID, input: { standing: true } },
        ]);
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[buildSessionOrganizationSessionKey(SERVER_ID, SESSION_ID)])
            .toMatchObject({ sessionId: SESSION_ID, standing: true });
    });
});

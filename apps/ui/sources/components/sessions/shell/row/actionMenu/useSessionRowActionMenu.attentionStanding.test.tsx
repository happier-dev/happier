import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionRowActionMenu } = await import('./useSessionRowActionMenu');
const SESSION_ID = 'session_1';
const route = `/v2/session-organization/attention-standings/${SESSION_ID}`;
let serverId: string;
let previousState = storage.getState();

function renderRowMenu(params: Readonly<{
    attentionStandingEnabled: boolean;
    attentionStanding: boolean;
    reminder?: Readonly<{ state: 'scheduled' | 'due'; remindAt: number }>;
}>) {
    const target = createSessionActionTarget({
        session: createSessionListRenderableSessionFixture({
            id: SESSION_ID, active: false, owner: 'user_1', metadata: null,
            seq: 4, lastViewedSessionSeq: 4, latestTurnStatus: 'completed',
        }),
        serverId,
        currentUserId: 'user_1',
        isConnected: false,
        attentionStandingEnabled: params.attentionStandingEnabled,
        attentionStanding: params.attentionStanding,
    });
    return renderHook(() => useSessionRowActionMenu({
        target,
        sessionName: 'Session one',
        hideInactiveSessions: false,
        iconColor: '#000000',
        activeTags: [],
        knownTags: [],
        tagsEnabled: false,
        touchPrimaryPointer: false,
        setContextMenuOpen: () => undefined,
        openTagsMenuFromContext: () => undefined,
        reminder: params.reminder,
    }));
}

beforeEach(async () => {
    previousState = storage.getState();
    await home.reset();
    serverId = await home.addHome({ name: 'Row menu Home', serverUrl: 'https://row-menu-standing.test', accountId: 'user_1' });
});
afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
});

describe('session row action menu attention standing', () => {
    it('renders Keep in Needs attention and commits standing when it is pressed', async () => {
        home.answer(serverId, route, { body: { standing: { sessionId: SESSION_ID, standing: true, updatedAt: 7 } } });
        const menu = await renderRowMenu({ attentionStandingEnabled: true, attentionStanding: false });

        expect(menu.getCurrent().moreMenuItems.map((item) => item.id))
            .toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        await menu.getCurrent().handleMoreMenuSelect(SESSION_ACTION_SET_ATTENTION_STANDING_ID);

        expect(home.requestsFor(route)).toMatchObject([{ serverId, input: { standing: true } }]);
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[
            buildSessionOrganizationSessionKey(serverId, SESSION_ID)
        ]).toEqual({ sessionId: SESSION_ID, standing: true, updatedAt: 7 });
    });

    it('renders Remove from Needs attention for a standing session and clears it', async () => {
        home.answer(serverId, route, { body: { standing: { sessionId: SESSION_ID, standing: false, updatedAt: 8 } } });
        const menu = await renderRowMenu({ attentionStandingEnabled: true, attentionStanding: true });

        expect(menu.getCurrent().moreMenuItems.map((item) => item.id))
            .toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        await menu.getCurrent().handleMoreMenuSelect(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);

        expect(home.requestsFor(route)).toMatchObject([{ serverId, input: { standing: false } }]);
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[
            buildSessionOrganizationSessionKey(serverId, SESSION_ID)
        ]).toEqual({ sessionId: SESSION_ID, standing: false, updatedAt: 8 });
    });

    it('renders neither direction while the attention band is off', async () => {
        const menu = await renderRowMenu({ attentionStandingEnabled: false, attentionStanding: false });
        const ids = menu.getCurrent().moreMenuItems.map((item) => item.id);

        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('clears the current reminder through the real standing mutation', async () => {
        home.answer(serverId, route, { body: { standing: { sessionId: SESSION_ID, standing: false, updatedAt: 9 } } });
        const menu = await renderRowMenu({
            attentionStandingEnabled: true,
            attentionStanding: false,
            reminder: { state: 'scheduled', remindAt: Date.now() + 60_000 },
        });
        const reminderItem = menu.getCurrent().moreMenuItems.find((item) => item.id === 'attention-reminder');
        expect(reminderItem?.submenu?.items.at(-1)?.id).toBe('attention-reminder:remove');
        await menu.getCurrent().handleMoreMenuSelect('attention-reminder:remove');

        expect(home.requestsFor(route)).toMatchObject([{ serverId, input: { remindAt: null } }]);
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[
            buildSessionOrganizationSessionKey(serverId, SESSION_ID)
        ]).toEqual({ sessionId: SESSION_ID, standing: false, updatedAt: 9 });
    });
});

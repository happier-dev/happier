import { describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionActionTarget } from './sessionActionContext';
import {
    listVisibleSessionActionIds,
    resolveSessionAttentionStandingActionId,
} from './sessionActionAvailability';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from './sessionActionIds';
import { executeSessionAction } from './sessionActionExecution';
import { getSessionActionMetadata } from './sessionActionMetadata';
import { listSessionBulkActionDescriptors } from './sessionBulkActionPresentation';
import {
    SESSION_BULK_ACTION_IDS,
    executeSessionBulkAction,
    type SessionBulkActionTarget,
} from './sessionBulkActionExecution';

function createSession(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session_1',
        active: false,
        archivedAt: null,
        owner: 'user_1',
        accessLevel: undefined,
        seq: 4,
        lastViewedSessionSeq: 4,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 1,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

/**
 * Every target here goes through `createSessionActionTarget`, the same constructor the row menu,
 * the session header and Session info use. Both standing inputs are REQUIRED so this file can only
 * describe what the action does once a surface supplies them; whether a surface actually does is a
 * separate question, answered through the real producer chain in
 * `SessionItem.attentionStandingAction.test.tsx`.
 */
function createTarget(params: Readonly<{
    session?: Partial<SessionListRenderableSession>;
    attentionStandingEnabled: boolean;
    attentionStanding: boolean;
}>) {
    return createSessionActionTarget({
        session: createSession(params.session),
        serverId: 'server_1',
        currentUserId: 'user_1',
        isConnected: false,
        attentionStandingEnabled: params.attentionStandingEnabled,
        attentionStanding: params.attentionStanding,
    });
}

describe('session attention standing action availability', () => {
    it('offers Keep in Needs attention for a session that is not standing yet', () => {
        const target = createTarget({ attentionStandingEnabled: true, attentionStanding: false });

        expect(resolveSessionAttentionStandingActionId(target)).toBe(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' }))
            .toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' }))
            .toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionHeader' }))
            .toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    });

    it('offers only Remove from Needs attention once the session is standing', () => {
        const target = createTarget({ attentionStandingEnabled: true, attentionStanding: true });

        expect(resolveSessionAttentionStandingActionId(target)).toBe(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' }))
            .not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    });

    // Whether a real surface actually supplies these inputs is NOT provable here: a hand-built
    // target passes just as happily when no production caller passes anything at all, which is
    // exactly how the row menu once offered neither direction. That reachability is proven through
    // the real producer chain in `SessionItem.attentionStandingAction.test.tsx`.
    it('hides both directions when the attention band is off, the session is archived, or access is view-only', () => {
        const bandOff = createTarget({ attentionStandingEnabled: false, attentionStanding: true });
        const archived = createTarget({
            session: { archivedAt: 10 },
            attentionStandingEnabled: true,
            attentionStanding: false,
        });
        const viewOnly = createTarget({
            session: { accessLevel: 'view' },
            attentionStandingEnabled: true,
            attentionStanding: false,
        });

        for (const target of [bandOff, archived, viewOnly]) {
            expect(target.attentionStandingAction).toEqual({ kind: 'none', visible: false });
            expect(resolveSessionAttentionStandingActionId(target)).toBeNull();
            const ids = listVisibleSessionActionIds({ target, surface: 'rowMenu' });
            expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
            expect(ids).not.toContain(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID);
        }
    });

    it('carries presentation metadata for both directions so a menu can render them', () => {
        expect(getSessionActionMetadata(SESSION_ACTION_SET_ATTENTION_STANDING_ID)).toMatchObject({
            titleKey: 'sessionInfo.keepInAttention',
            icon: 'bell',
        });
        expect(getSessionActionMetadata(SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID)).toMatchObject({
            titleKey: 'sessionInfo.removeFromAttention',
            icon: 'bell-slash',
        });
    });
});

describe('executeSessionAction for attention standing', () => {
    it('writes the standing the pressed id names, scoped to the target server', async () => {
        const setAttentionStanding = vi.fn(async () => ({ success: true as const }));
        const target = createTarget({ attentionStandingEnabled: true, attentionStanding: false });

        await executeSessionAction({
            actionId: SESSION_ACTION_SET_ATTENTION_STANDING_ID,
            target,
            context: { operations: { setAttentionStanding } },
        });
        await executeSessionAction({
            actionId: SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
            target,
            context: { operations: { setAttentionStanding } },
        });

        expect(setAttentionStanding.mock.calls).toEqual([
            ['session_1', true, { serverId: 'server_1' }],
            ['session_1', false, { serverId: 'server_1' }],
        ]);
    });

    it('surfaces a failed standing write instead of reporting success', async () => {
        const setAttentionStanding = vi.fn(async () => ({ success: false as const, message: 'server refused' }));

        await expect(executeSessionAction({
            actionId: SESSION_ACTION_SET_ATTENTION_STANDING_ID,
            target: createTarget({ attentionStandingEnabled: true, attentionStanding: false }),
            context: { operations: { setAttentionStanding } },
        })).rejects.toBeInstanceOf(HappyError);
    });
});

function bulkTarget(input: Partial<SessionBulkActionTarget> & Pick<SessionBulkActionTarget, 'key' | 'sessionId'>): SessionBulkActionTarget {
    return {
        serverId: 'server-a',
        active: false,
        archived: false,
        hasAdminAccess: true,
        canStop: true,
        canArchive: true,
        pinned: false,
        tags: [],
        ...input,
    };
}

describe('session bulk attention standing', () => {
    it('offers each direction only when some selected session can go that way', () => {
        const descriptorIds = (targets: readonly SessionBulkActionTarget[]) =>
            listSessionBulkActionDescriptors({ targets, tagsEnabled: false, moveEnabled: false })
                .map((descriptor) => descriptor.id);

        expect(descriptorIds([bulkTarget({ key: 'a', sessionId: 'a', standing: false })]))
            .toContain(SESSION_BULK_ACTION_IDS.setAttentionStanding);
        expect(descriptorIds([bulkTarget({ key: 'a', sessionId: 'a', standing: false })]))
            .not.toContain(SESSION_BULK_ACTION_IDS.clearAttentionStanding);
        expect(descriptorIds([bulkTarget({ key: 'b', sessionId: 'b', standing: true })]))
            .toContain(SESSION_BULK_ACTION_IDS.clearAttentionStanding);
        expect(descriptorIds([bulkTarget({ key: 'c', sessionId: 'c' })]))
            .not.toContain(SESSION_BULK_ACTION_IDS.setAttentionStanding);
    });

    it('writes standing for reachable sessions and skips the ones the action never applied to', async () => {
        const setSessionAttentionStanding = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.setAttentionStanding },
            targets: [
                bulkTarget({ key: 'a', sessionId: 'a', standing: false }),
                bulkTarget({ key: 'b', sessionId: 'b' }),
            ],
            context: { setSessionAttentionStanding, concurrencyLimit: 1 },
        });

        expect(setSessionAttentionStanding).toHaveBeenCalledTimes(1);
        expect(setSessionAttentionStanding).toHaveBeenCalledWith({
            target: expect.objectContaining({ sessionId: 'a' }),
            standing: true,
        });
        expect(result.succeeded.map((entry) => entry.target.sessionId)).toEqual(['a']);
        expect(result.skipped.map((entry) => entry.reasonCode)).toEqual(['attention_standing_unavailable']);
    });

    it('clears standing when the clear id is dispatched', async () => {
        const setSessionAttentionStanding = vi.fn(async () => undefined);

        await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.clearAttentionStanding },
            targets: [bulkTarget({ key: 'a', sessionId: 'a', standing: true })],
            context: { setSessionAttentionStanding },
        });

        expect(setSessionAttentionStanding).toHaveBeenCalledWith({
            target: expect.objectContaining({ sessionId: 'a' }),
            standing: false,
        });
    });
});

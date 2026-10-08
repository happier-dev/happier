import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildSessionRowMoreMenuItems } from './buildSessionRowActionMenuItems';
import { SESSION_ROW_ACTION_SELECT_ID } from './sessionRowActionMenuTypes';

function makeSession(): SessionListRenderableSession {
    return {
        id: 'session_1',
        active: true,
        archivedAt: null,
        owner: 'user_1',
        access: createSessionAccessFixture(),
        viewer: {
            readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
        },
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
    };
}

function makeViewOnlySession(overrides?: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        ...makeSession(),
        ...overrides,
        access: createSessionAccessFixture('view', {
            readTranscript: true,
            editSessionRecords: false,
            renameSession: false,
            archiveSession: false,
            stopSession: false,
            deleteSession: false,
        }),
    };
}

describe('buildSessionRowMoreMenuItems', () => {
    it('composes leading row actions with shared session actions and the folder chooser', () => {
        const target = createSessionActionTarget({
            session: makeSession(),
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });

        const items = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            leadingItems: [
                { id: SESSION_ROW_ACTION_SELECT_ID, title: 'Select', icon: React.createElement('Icon') },
            ],
            canMoveToFolder: true,
        });

        expect(items.map((item) => item.id)).toEqual([
            SESSION_ROW_ACTION_SELECT_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_MARK_UNREAD_ID,
            'attention-reminder',
            SESSION_ACTION_PUT_UNDER_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
            SESSION_ACTION_MOVE_TO_FOLDER_ID,
        ]);
        expect(items.at(-1)).toEqual(expect.objectContaining({
            id: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            disabled: false,
        }));
    });

    it('omits the folder action when folder movement is unavailable and no targets exist', () => {
        const target = createSessionActionTarget({
            session: makeSession(),
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });

        const items = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            canMoveToFolder: false,
        });

        expect(items.some((item) => item.id === SESSION_ACTION_MOVE_TO_FOLDER_ID)).toBe(false);
    });

    it('puts frequent session actions first and offers a concise reminder submenu', () => {
        const target = createSessionActionTarget({
            session: makeSession(),
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            attentionStandingEnabled: true,
            attentionStanding: false,
        });

        const items = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            canMoveToFolder: false,
            leadingItems: [{ id: 'session.fork', title: 'Fork session' }],
            reminderPresets: [{ rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 } }],
        });

        expect(items.map((item) => item.id)).toEqual([
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_SET_ATTENTION_STANDING_ID,
            'attention-reminder',
            'session.fork',
            SESSION_ACTION_PUT_UNDER_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
        ]);
        const reminder = items.find((item) => item.id === 'attention-reminder');
        expect(reminder?.subtitle).toBeUndefined();
        expect(reminder?.submenu?.items.map((item) => item.id)).toEqual([
            'attention-reminder:3600000',
            'attention-reminder:10800000',
            'attention-reminder:tomorrow',
            'attention-reminder:next-week',
            'attention-reminder:preset:relative_day:1:840',
            'attention-reminder:custom',
            'attention-reminder:manage-presets',
        ]);
    });

    it('offers personal reminders to a qualified view-only reader independently of the attention band', () => {
        const target = createSessionActionTarget({
            session: makeViewOnlySession(),
            serverId: 'server_1',
            currentUserId: 'user_2',
            attentionStandingEnabled: false,
        });

        const ids = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            canMoveToFolder: false,
        }).map((item) => item.id);

        expect(ids).toContain('attention-reminder');
        expect(ids).not.toContain(SESSION_ACTION_SET_ATTENTION_STANDING_ID);
    });

    it('lets an archived readable row remove its reminder without offering a replacement time', () => {
        const target = createSessionActionTarget({
            session: makeViewOnlySession({ archivedAt: 1, active: false }),
            serverId: 'server_1',
            currentUserId: 'user_2',
            attentionStandingEnabled: true,
        });

        expect(buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
        }).some((item) => item.id === 'attention-reminder')).toBe(false);

        const reminder = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            reminder: { state: 'scheduled', remindAt: 2_000_000 },
            reminderNowMs: 1_000_000,
        }).find((item) => item.id === 'attention-reminder');

        expect(reminder?.submenu?.items.map((item) => item.id)).toEqual([
            'attention-reminder:current',
            'attention-reminder:remove',
        ]);
    });

    it('shows and checks the current reminder and offers removal', () => {
        const target = createSessionActionTarget({
            session: makeSession(), serverId: 'server_1', currentUserId: 'user_1', isConnected: true,
            attentionStandingEnabled: true, attentionStanding: false,
        });
        const nowMs = new Date(2026, 8, 8, 14, 30).getTime();
        const remindAt = new Date(2026, 8, 9, 14, 0).getTime();
        const reminder = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            reminder: { state: 'scheduled', remindAt },
            reminderNowMs: nowMs,
            reminderPresets: [{ rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 840 } }],
        }).find((item) => item.id === 'attention-reminder');

        expect(reminder?.title).toContain('·');
        expect(reminder?.submenu?.items.find((item) => item.id === 'attention-reminder:preset:relative_day:1:840')?.checked).toBe(true);
        expect(reminder?.submenu?.items.at(-1)?.id).toBe('attention-reminder:remove');
    });

    it('uses the concise due-state vocabulary instead of presenting a stale scheduled date', () => {
        const target = createSessionActionTarget({
            session: makeSession(), serverId: 'server_1', currentUserId: 'user_1', isConnected: true,
            attentionStandingEnabled: false,
        });
        const reminder = buildSessionRowMoreMenuItems({
            target,
            iconColor: 'test-icon-color',
            reminder: { state: 'due', remindAt: 900 },
            reminderNowMs: 1_000,
        }).find((item) => item.id === 'attention-reminder');

        expect(reminder?.title).toBe('Reminder due');
    });

    it('inserts an exact selected timestamp when no preset matches', () => {
        const target = createSessionActionTarget({
            session: makeSession(), serverId: 'server_1', currentUserId: 'user_1', isConnected: true,
            attentionStandingEnabled: true, attentionStanding: false,
        });
        const reminder = buildSessionRowMoreMenuItems({
            target, iconColor: 'test-icon-color', reminder: { state: 'scheduled', remindAt: 2_000_000 }, reminderNowMs: 1_000_000,
        }).find((item) => item.id === 'attention-reminder');

        expect(reminder?.submenu?.items[0]).toEqual(expect.objectContaining({ id: 'attention-reminder:current', checked: true }));
    });
});

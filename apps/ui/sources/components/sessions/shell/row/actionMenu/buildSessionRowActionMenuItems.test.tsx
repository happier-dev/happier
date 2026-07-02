import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildSessionRowMoreMenuItems } from './buildSessionRowActionMenuItems';
import { SESSION_ROW_ACTION_SELECT_ID } from './sessionRowActionMenuTypes';

function makeSession(): SessionListRenderableSession {
    return {
        id: 'session_1',
        active: true,
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
    };
}

describe('buildSessionRowMoreMenuItems', () => {
    it('composes leading row actions with shared session actions and folder targets', () => {
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
            canMoveToFolder: false,
            folderMoveMenuItems: [
                { id: 'session-folder-move-root', title: 'Workspace root', icon: React.createElement('Icon') },
            ],
        });

        expect(items.map((item) => item.id)).toEqual([
            SESSION_ROW_ACTION_SELECT_ID,
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
            SESSION_ACTION_MOVE_TO_FOLDER_ID,
        ]);
        expect(items.at(-1)).toEqual(expect.objectContaining({
            id: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            disabled: false,
            submenu: expect.objectContaining({
                items: [
                    expect.objectContaining({ id: 'session-folder-move-root' }),
                ],
            }),
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
            folderMoveMenuItems: [],
        });

        expect(items.some((item) => item.id === SESSION_ACTION_MOVE_TO_FOLDER_ID)).toBe(false);
    });
});

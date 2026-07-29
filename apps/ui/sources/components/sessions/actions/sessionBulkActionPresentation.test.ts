import { describe, expect, it } from 'vitest';

import {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionTarget,
} from './sessionBulkActionTypes';
import { listSessionBulkActionDescriptors } from './sessionBulkActionPresentation';

describe('listSessionBulkActionDescriptors', () => {
    it('centralizes bulk action-bar presentation availability for mixed selected sessions', () => {
        const targets: SessionBulkActionTarget[] = [
            {
                key: 'session-a',
                sessionId: 'session-a',
                active: true,
                archived: false,
                canStop: true,
                canArchive: true,
                pinned: false,
                tags: [],
                readState: 'unread',
                canMoveToFolder: true,
            },
            {
                key: 'session-b',
                sessionId: 'session-b',
                active: false,
                archived: true,
                hasAdminAccess: true,
                pinned: true,
                tags: ['urgent'],
                readState: 'read',
            },
        ];

        const descriptors = listSessionBulkActionDescriptors({
            targets,
            tagsEnabled: true,
            moveEnabled: true,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
            SESSION_BULK_ACTION_IDS.stop,
            SESSION_BULK_ACTION_IDS.archive,
            SESSION_BULK_ACTION_IDS.unarchive,
            SESSION_BULK_ACTION_IDS.markRead,
            SESSION_BULK_ACTION_IDS.markUnread,
            SESSION_BULK_ACTION_IDS.pin,
            SESSION_BULK_ACTION_IDS.unpin,
            SESSION_BULK_ACTION_IDS.tagsAdd,
            SESSION_BULK_ACTION_IDS.tagsRemove,
            SESSION_BULK_ACTION_IDS.tagsSet,
            SESSION_BULK_ACTION_IDS.moveToFolder,
        ]);
        expect(descriptors.find((descriptor) => descriptor.id === SESSION_BULK_ACTION_IDS.stop)).toMatchObject({
            requiresConfirmation: true,
            destructive: true,
        });
        expect(descriptors.find((descriptor) => descriptor.id === SESSION_BULK_ACTION_IDS.archive)).toMatchObject({
            requiresConfirmation: true,
            destructive: true,
        });
    });

    it('does not expose read-state actions when selected targets have no available read state', () => {
        const descriptors = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'session-archived',
                    sessionId: 'session-archived',
                    archived: true,
                    readState: undefined,
                },
            ],
            tagsEnabled: false,
            moveEnabled: false,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.markRead);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.markUnread);
    });

    it('uses target permission facts for lifecycle action availability', () => {
        const descriptors = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'active-denied',
                    sessionId: 'active-denied',
                    active: true,
                    archived: false,
                    canStop: false,
                    canArchive: false,
                    hasAdminAccess: false,
                },
                {
                    key: 'archived-denied',
                    sessionId: 'archived-denied',
                    active: false,
                    archived: true,
                    canStop: false,
                    canArchive: false,
                    hasAdminAccess: false,
                },
            ],
            tagsEnabled: false,
            moveEnabled: false,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.stop);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.archive);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.unarchive);
    });

    it('fails closed when lifecycle permission facts are absent', () => {
        const descriptors = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'active-unknown-permissions',
                    sessionId: 'active-unknown-permissions',
                    active: true,
                    archived: false,
                },
                {
                    key: 'archived-unknown-permissions',
                    sessionId: 'archived-unknown-permissions',
                    active: false,
                    archived: true,
                },
            ],
            tagsEnabled: false,
            moveEnabled: false,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.stop);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.archive);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.unarchive);
    });

    it('shows move only when at least one selected item is eligible for folders', () => {
        const unavailable = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'unscoped',
                    sessionId: 'unscoped',
                    canMoveToFolder: false,
                },
            ],
            tagsEnabled: false,
            moveEnabled: true,
        });
        const mixed = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'unscoped',
                    sessionId: 'unscoped',
                    canMoveToFolder: false,
                },
                {
                    key: 'external',
                    sessionId: 'external',
                    canMoveToFolder: true,
                },
            ],
            tagsEnabled: false,
            moveEnabled: true,
        });

        expect(unavailable.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.moveToFolder);
        expect(mixed.map((descriptor) => descriptor.id)).toContain(SESSION_BULK_ACTION_IDS.moveToFolder);
    });
});

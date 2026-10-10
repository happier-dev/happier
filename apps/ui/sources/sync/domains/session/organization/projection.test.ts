import { describe, expect, it } from 'vitest';

import {
    buildSessionOrganizationProjection,
    buildSessionOrganizationProjections,
} from './projection';
import {
    buildSessionOrganizationOrderScopeKey,
    buildSessionOrganizationServerKey,
    buildSessionOrganizationSessionKey,
} from './keys';

const sessionKey = (serverId: string, sessionId: string): string =>
    buildSessionOrganizationSessionKey(serverId, sessionId);

describe('buildSessionOrganizationProjection', () => {
    it('projects only the requested server organization state in pinned order', () => {
        const projection = buildSessionOrganizationProjection({
            schemaVersionByServerId: { 'server-a': 1 },
            snapshotVersionByServerId: { 'server-a': 9 },
            pinsBySessionKey: {
                [sessionKey('server-a', 's2')]: { sessionId: 's2', sortKey: '0002', pinnedAt: 20, listPinned: true, railPinned: false },
                [sessionKey('server-a', 's1')]: { sessionId: 's1', sortKey: '0001', pinnedAt: 10, listPinned: true, railPinned: false },
                [sessionKey('server-b', 's3')]: { sessionId: 's3', sortKey: '0000', pinnedAt: 1, listPinned: true, railPinned: false },
            },
            foldersByFolderKey: {
                [buildSessionOrganizationServerKey('server-a', 'folder-a')]: {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display: null,
                    displayState: { status: 'available', value: null },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionKey: {
                [sessionKey('server-a', 's1')]: { sessionId: 's1', folderId: 'folder-a' },
            },
            tagsByTagKey: {},
            tagAssignmentsBySessionKey: {
                [sessionKey('server-a', 's1')]: { sessionId: 's1', tagIds: ['tag-a'] },
            },
            attentionStandingsBySessionKey: {
                [sessionKey('server-a', 's1')]: { sessionId: 's1', standing: true, updatedAt: 5 },
                [sessionKey('server-a', 's2')]: { sessionId: 's2', standing: false, updatedAt: 6 },
                [sessionKey('server-b', 's3')]: { sessionId: 's3', standing: true, updatedAt: 7 },
            },
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        }, 'server-a');

        expect(projection.schemaVersion).toBe(1);
        expect(projection.version).toBe(9);
        expect(projection.pinnedSessionIds).toEqual(['s1', 's2']);
        expect(projection.folderAssignmentsBySessionId).toEqual({ s1: 'folder-a' });
        expect(projection.tagAssignmentsBySessionId).toEqual({ s1: ['tag-a'] });
        // An explicit `false` is the user's "remove from Needs attention": it must survive the
        // projection intact, and another server's standings must not leak into this one.
        expect(projection.attentionStandingsBySessionId).toEqual({
            s1: { sessionId: 's1', standing: true, updatedAt: 5 },
            s2: { sessionId: 's2', standing: false, updatedAt: 6 },
        });
        expect(projection.pinsBySessionId.s3).toBeUndefined();
    });

    it('collects one qualified projection for every normalized selected Home', () => {
        const requested: string[] = [];
        const projections = buildSessionOrganizationProjections(
            [' home-a ', 'home-b', 'home-a', ''],
            (serverId) => {
                requested.push(serverId);
                return buildSessionOrganizationProjection({
                    schemaVersionByServerId: { [serverId]: 1 },
                    snapshotVersionByServerId: { [serverId]: 1 },
                    pinsBySessionKey: {},
                    foldersByFolderKey: {},
                    folderAssignmentsBySessionKey: {},
                    tagsByTagKey: {},
                    tagAssignmentsBySessionKey: {},
                    attentionStandingsBySessionKey: {},
                    orderEntriesByScopeKey: {},
                    labelsByLabelKey: {},
                }, serverId);
            },
        );

        expect(requested).toEqual(['home-a', 'home-b']);
        expect(Object.keys(projections)).toEqual(['home-a', 'home-b']);
    });

    it('keeps rail-only pins out of the list while preserving one shared personal order', () => {
        const projection = buildSessionOrganizationProjection({
            schemaVersionByServerId: {}, snapshotVersionByServerId: {},
            pinsBySessionKey: {
                [sessionKey('server-a', 'list')]: { sessionId: 'list', sortKey: 'b', pinnedAt: 2, listPinned: true, railPinned: false },
                [sessionKey('server-a', 'rail')]: { sessionId: 'rail', sortKey: 'a', pinnedAt: 1, listPinned: false, railPinned: true },
                [sessionKey('server-a', 'both')]: { sessionId: 'both', sortKey: 'c', pinnedAt: 3, listPinned: true, railPinned: true },
            }, foldersByFolderKey: {}, folderAssignmentsBySessionKey: {}, tagsByTagKey: {},
            tagAssignmentsBySessionKey: {}, attentionStandingsBySessionKey: {}, orderEntriesByScopeKey: {
                [buildSessionOrganizationOrderScopeKey({ serverId: 'server-a', scopeKind: 'pinned', scopeKey: 'pins' })]: [
                    { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 'both', sortKey: 'a' },
                    { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 'rail', sortKey: 'b' },
                    { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 'list', sortKey: 'c' },
                ],
            }, labelsByLabelKey: {},
        }, 'server-a');
        expect(projection.pinnedSessionIds).toEqual(['both', 'list']);
        expect(projection.railPinnedSessionIds).toEqual(['both', 'rail']);
        expect(Object.keys(projection.pinsBySessionId).sort()).toEqual(['both', 'list', 'rail']);
    });
});

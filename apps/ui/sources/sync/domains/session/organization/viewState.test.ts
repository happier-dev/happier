import { describe, expect, it } from 'vitest';

import {
    buildSessionOrganizationListViewState,
    buildSessionOrganizationReorderRequestFromGroupOrder,
} from './viewState';

describe('buildSessionOrganizationListViewState', () => {
    it('projects session tag assignments as display labels instead of server tag ids', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                schemaVersion: 1,
                version: 4,
                pinnedSessionIds: [],
                pinsBySessionId: {},
                foldersById: {},
                folderAssignmentsBySessionId: {},
                tagsById: {
                    tag_urgent: {
                        tagId: 'tag_urgent',
                        tagKey: 'legacy/tag/urgent',
                        sortKey: null,
                        display: { t: 'plain', v: { label: 'Urgent' } },
                        displayState: { status: 'available', value: { label: 'Urgent' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    tag_unknown_label: {
                        tagId: 'tag_unknown_label',
                        tagKey: 'legacy/tag/unknown',
                        sortKey: null,
                        display: { t: 'plain', v: {} },
                        displayState: { status: 'available', value: {} },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                tagAssignmentsBySessionId: {
                    'session-1': ['tag_urgent', 'tag_unknown_label', 'missing_tag'],
                },
                attentionStandingsBySessionId: {},
                orderEntriesByScopeKey: {},
                labelsByLabelKey: {},
            },
        });

        expect(state.sessionTagsV1).toEqual({
            'server-a:session-1': [
                {
                    tagId: 'tag_urgent',
                    display: { status: 'available', value: 'Urgent' },
                },
                {
                    tagId: 'tag_unknown_label',
                    display: {
                        status: 'locked',
                        reason: 'content_unreadable',
                    },
                },
                {
                    tagId: 'missing_tag',
                    display: {
                        status: 'locked',
                        reason: 'content_unreadable',
                    },
                },
            ],
        });
        expect(state.sessionTagDisplayStatesBySessionKey).toEqual({
            'server-a:session-1': [
                {
                    tagId: 'tag_urgent',
                    display: { status: 'available', value: 'Urgent' },
                },
                {
                    tagId: 'tag_unknown_label',
                    display: { status: 'locked', reason: 'content_unreadable' },
                },
                {
                    tagId: 'missing_tag',
                    display: { status: 'locked', reason: 'content_unreadable' },
                },
            ],
        });
    });

    it('retains locked folder, tag, and label structure without using keys or ids as names', () => {
        const locked = {
            status: 'locked' as const,
            reason: 'account_key_unavailable' as const,
        };
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: {
                schemaVersion: 1,
                version: 9,
                pinnedSessionIds: ['session-1'],
                pinsBySessionId: {},
                foldersById: {
                    'folder-private-id': {
                        folderId: 'folder-private-id',
                        folderKey: 'private/folder/key',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: null,
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                folderAssignmentsBySessionId: {
                    'session-1': 'folder-private-id',
                },
                tagsById: {
                    'tag-private-id': {
                        tagId: 'tag-private-id',
                        tagKey: 'private/tag/key',
                        sortKey: null,
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                tagAssignmentsBySessionId: {
                    'session-1': ['tag-private-id'],
                },
                attentionStandingsBySessionId: {
                    'session-1': { sessionId: 'session-1', standing: false, updatedAt: 3 },
                },
                orderEntriesByScopeKey: {
                    group: [{
                        scopeKind: 'group',
                        scopeKey: 'group',
                        itemKind: 'folder',
                        itemKey: 'folder-private-id',
                        sortKey: '0001',
                    }],
                },
                labelsByLabelKey: {
                    workspace: {
                        labelKind: 'workspace',
                        scopeKey: 'private/workspace/key',
                        display: { t: 'encrypted', c: 'ciphertext' },
                        displayState: locked,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
            },
        });

        expect(state.folderDisplayStatesById).toEqual({
            'folder-private-id': locked,
        });
        expect(state.sessionFoldersV1.folders).toEqual([
            expect.objectContaining({
                id: 'folder-private-id',
                parentId: null,
                name: '',
                workspace: null,
                displayState: locked,
            }),
        ]);
        expect(state.labelDisplayStatesByKey).toEqual({
            workspace: locked,
        });
        expect(state.workspaceLabelsV1).toEqual({
            'private/workspace/key': locked,
        });
        expect(state.sessionFolderAssignmentsBySessionKey).toEqual({
            'server-a:session-1': 'folder-private-id',
        });
        expect(state.sessionListGroupOrderV1).toEqual({
            group: ['folder:folder-private-id'],
        });
        expect(state.sessionTagsV1).toEqual({
            'server-a:session-1': [{
                tagId: 'tag-private-id',
                display: locked,
            }],
        });
        expect(state.sessionTagDisplayStatesBySessionKey['server-a:session-1'])
            .toEqual([{
                tagId: 'tag-private-id',
                display: locked,
            }]);
        // Standing is a plain boolean the surfaces join with the account default; it is keyed the
        // same way as every other session-scoped slice so a `false` cannot be read as "absent".
        expect(state.attentionStandingOverridesBySessionKey).toEqual({
            'server-a:session-1': false,
        });
    });
});

describe('buildSessionOrganizationReorderRequestFromGroupOrder', () => {
    it('accepts session keys scoped by an equivalent server profile id', () => {
        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'srv_identity',
            serverIdAliases: ['server-profile-a'],
            scopeKey: 'server:srv_identity:active:project:repo',
            itemKeys: ['server-profile-a:session-a', 'folder:folder-a', 'srv_identity:session-b'],
        });

        expect(request?.entries).toEqual([
            { itemKind: 'session', itemKey: 'session-a', sortKey: '00000001' },
            { itemKind: 'folder', itemKey: 'folder-a', sortKey: '00000002' },
            { itemKind: 'session', itemKey: 'session-b', sortKey: '00000003' },
        ]);
    });
});

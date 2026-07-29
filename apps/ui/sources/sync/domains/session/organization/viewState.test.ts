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
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    tag_unknown_label: {
                        tagId: 'tag_unknown_label',
                        tagKey: 'legacy/tag/unknown',
                        sortKey: null,
                        display: { t: 'plain', v: {} },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                tagAssignmentsBySessionId: {
                    'session-1': ['tag_urgent', 'tag_unknown_label', 'missing_tag'],
                },
                orderEntriesByScopeKey: {},
                labelsByLabelKey: {},
            },
        });

        expect(state.sessionTagsV1).toEqual({
            'server-a:session-1': ['Urgent', 'legacy/tag/unknown', 'missing_tag'],
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

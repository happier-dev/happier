import { describe, expect, it } from 'vitest';

import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    SESSION_ORGANIZATION_MAX_ID_LENGTH,
    SESSION_ORGANIZATION_SNAPSHOT_VERSION,
} from '@happier-dev/protocol';

import {
    buildLegacySessionOrganizationImportPlan,
    stripImportedLegacySessionOrganizationSettingsForServer,
} from './legacyImportPlan';

describe('buildLegacySessionOrganizationImportPlan', () => {
    it('converts current-server legacy account settings into a session organization import request', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'srv_identity',
            rawSettings: {
                pinnedSessionKeysV1: [
                    'srv_identity:session-a',
                    'other-server:session-other',
                    'session-b',
                    'srv_identity:session-a',
                ],
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: 'folder-a',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'srv_identity',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Planning',
                            createdAt: 1,
                            updatedAt: 2,
                            sortKey: 'folder-sort',
                        },
                        {
                            id: 'folder-other',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'other-server',
                                machineId: 'machine-b',
                                rootPath: '/other',
                            },
                            parentId: null,
                            name: 'Other',
                            createdAt: 1,
                            updatedAt: 2,
                        },
                    ],
                },
                sessionTagsV1: {
                    'srv_identity:session-a': ['urgent', 'review', 'urgent'],
                    'session-b': ['review'],
                    'other-server:session-other': ['ignored'],
                },
                sessionListGroupOrderV1: {
                    [PINNED_GROUP_KEY_V1]: ['srv_identity:session-b', 'folder:folder-a'],
                    'server:srv_identity:active:project:p1': ['srv_identity:session-a', 'other-server:session-other'],
                    'server:other-server:active:project:p2': ['other-server:session-other'],
                },
                sessionWorkspaceOrderV1: {
                    'server:srv_identity:workspaces': ['workspace:/repo', 'workspace:/repo-b'],
                    'server:other-server:workspaces': ['workspace:/other'],
                },
                workspaceLabelsV1: {
                    'server:srv_identity:workspaces': 'Primary',
                    'server:other-server:workspaces': 'Other',
                },
            },
        });

        expect(plan.hasLegacyOrganizationSettings).toBe(true);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
        expect(plan.request.pins).toEqual([
            { sessionId: 'session-a', sortKey: '00000001' },
            { sessionId: 'session-b', sortKey: '00000003' },
        ]);
        expect(plan.request.folders).toEqual([
            {
                folderId: 'folder-a',
                folderKey: 'folder-a',
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: 'folder-sort',
                display: {
                    t: 'plain',
                    v: {
                        name: 'Planning',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'srv_identity',
                            machineId: 'machine-a',
                            rootPath: '/repo',
                        },
                    },
                },
            },
        ]);
        expect(plan.request.tags).toEqual([
            {
                tagId: 'urgent',
                tagKey: 'urgent',
                sortKey: '00000001',
                display: { t: 'plain', v: { label: 'urgent' } },
            },
            {
                tagId: 'review',
                tagKey: 'review',
                sortKey: '00000002',
                display: { t: 'plain', v: { label: 'review' } },
            },
        ]);
        expect(plan.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['urgent', 'review'] },
            { sessionId: 'session-b', tagIds: ['review'] },
        ]);
        expect(plan.request.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['urgent', 'review'] },
            { sessionId: 'session-b', tagIds: ['review'] },
        ]);
        expect(plan.request.orderEntries).toEqual(expect.arrayContaining([
            {
                scopeKind: 'pinned',
                scopeKey: 'pins',
                itemKind: 'session',
                itemKey: 'session-b',
                sortKey: '00000001',
            },
            {
                scopeKind: 'pinned',
                scopeKey: 'pins',
                itemKind: 'folder',
                itemKey: 'folder-a',
                sortKey: '00000002',
            },
            {
                scopeKind: 'group',
                scopeKey: 'server:srv_identity:active:project:p1',
                itemKind: 'session',
                itemKey: 'session-a',
                sortKey: '00000001',
            },
            {
                scopeKind: 'workspace',
                scopeKey: 'srv_identity',
                itemKind: 'workspace',
                itemKey: '/repo',
                sortKey: '00000001',
            },
        ]));
        expect(plan.request.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:srv_identity:workspaces',
                display: { t: 'plain', v: { label: 'Primary' } },
            },
        ]);
    });

    it('maps oversized legacy folder and tag ids to provider-safe ids while preserving legacy keys', () => {
        const longFolderId = `folder-${'f'.repeat(240)}`;
        const longChildFolderId = `child-${'c'.repeat(240)}`;
        const longTagId = `tag-${'t'.repeat(240)}`;
        const longSortKey = 's'.repeat(240);

        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'srv_identity',
            rawSettings: {
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: longFolderId,
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'srv_identity',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Long folder',
                            createdAt: 10,
                            updatedAt: 20,
                            sortKey: longSortKey,
                        },
                        {
                            id: longChildFolderId,
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'srv_identity',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: longFolderId,
                            name: 'Long child',
                            createdAt: 11,
                            updatedAt: 21,
                        },
                    ],
                },
                sessionTagsV1: {
                    'srv_identity:session-a': [longTagId],
                },
                sessionListGroupOrderV1: {
                    [`folder:${longFolderId}`]: [`folder:${longChildFolderId}`, 'srv_identity:session-a'],
                },
            },
        });

        const [folder, childFolder] = plan.request.folders;
        if (!folder || !childFolder) {
            throw new Error('expected long legacy folders to be importable');
        }
        const folderId = folder.folderId;
        const childFolderId = childFolder.folderId;
        if (!folderId || !childFolderId) {
            throw new Error('expected long legacy folders to have provider-safe ids');
        }
        expect(folderId).not.toBe(longFolderId);
        expect(folderId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(folder).toEqual(expect.objectContaining({
            folderKey: longFolderId,
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: '00000001',
        }));
        expect(childFolderId).not.toBe(longChildFolderId);
        expect(childFolderId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(childFolder).toEqual(expect.objectContaining({
            folderKey: longChildFolderId,
            parentFolderId: folderId,
            parentFolderKey: longFolderId,
        }));

        const [tag] = plan.request.tags;
        if (!tag) {
            throw new Error('expected long legacy tag to be importable');
        }
        const tagId = tag.tagId;
        if (!tagId) {
            throw new Error('expected long legacy tag to have a provider-safe id');
        }
        expect(tagId).not.toBe(longTagId);
        expect(tagId.length).toBeLessThanOrEqual(SESSION_ORGANIZATION_MAX_ID_LENGTH);
        expect(tag).toEqual(expect.objectContaining({
            tagKey: longTagId,
            display: { t: 'plain', v: { label: longTagId } },
        }));
        expect(plan.request.tagAssignments).toEqual([{ sessionId: 'session-a', tagIds: [tagId] }]);
        expect(plan.request.orderEntries).toEqual([
            { scopeKind: 'group', scopeKey: `folder:${folderId}`, itemKind: 'folder', itemKey: childFolderId, sortKey: '00000001' },
            { scopeKind: 'group', scopeKey: `folder:${folderId}`, itemKind: 'session', itemKey: 'session-a', sortKey: '00000002' },
        ]);
    });

    it('keeps legacy settings marked as handled when an existing snapshot already owns every importable category', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'srv_identity',
            rawSettings: {
                pinnedSessionKeysV1: ['srv_identity:session-a'],
                sessionTagsV1: { 'srv_identity:session-a': ['urgent'] },
                sessionListGroupOrderV1: {
                    [PINNED_GROUP_KEY_V1]: ['srv_identity:session-a'],
                },
                workspaceLabelsV1: {
                    'server:srv_identity:workspaces': 'Primary',
                },
            },
            existingSnapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
                version: 1,
                pins: [{
                    sessionId: 'session-a',
                    sortKey: null,
                    pinnedAt: 1,
                }],
                folders: [],
                folderAssignments: [],
                tags: [{
                    tagId: 'urgent',
                    tagKey: 'urgent',
                    sortKey: null,
                    display: null,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                tagAssignments: [{
                    sessionId: 'session-a',
                    tagIds: ['urgent'],
                }],
                orderEntries: [{
                    scopeKind: 'pinned',
                    scopeKey: 'pins',
                    itemKind: 'session',
                    itemKey: 'session-a',
                    sortKey: '00000001',
                }],
                labels: [{
                    labelKind: 'workspace',
                    scopeKey: 'server:srv_identity:workspaces',
                    display: null,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        });

        expect(plan.hasLegacyOrganizationSettings).toBe(true);
        expect(plan.hasImportableLegacyOrganization).toBe(false);
        expect(plan.request).toEqual({
            pins: [],
            folders: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        });
        expect(plan.tagAssignments).toEqual([]);
    });

    it('keeps tag assignments importable when a retry snapshot has tags but not assignments', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'srv_identity',
            rawSettings: {
                sessionTagsV1: {
                    'srv_identity:session-a': ['urgent', 'review'],
                    'srv_identity:session-b': ['urgent'],
                },
            },
            existingSnapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
                version: 2,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [
                    {
                        tagId: 'urgent',
                        tagKey: 'urgent',
                        sortKey: '00000001',
                        display: null,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        tagId: 'review',
                        tagKey: 'review',
                        sortKey: '00000002',
                        display: null,
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                tagAssignments: [
                    {
                        sessionId: 'session-a',
                        tagIds: ['urgent'],
                    },
                ],
                orderEntries: [],
                labels: [],
            },
        });

        expect(plan.hasLegacyOrganizationSettings).toBe(true);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
        expect(plan.request.tags).toEqual([]);
        expect(plan.request.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['urgent', 'review'] },
            { sessionId: 'session-b', tagIds: ['urgent'] },
        ]);
        expect(plan.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['urgent', 'review'] },
            { sessionId: 'session-b', tagIds: ['urgent'] },
        ]);
    });

    it('imports missing legacy items when an existing snapshot only partially owns a category', () => {
        const plan = buildLegacySessionOrganizationImportPlan({
            serverId: 'srv_identity',
            rawSettings: {
                pinnedSessionKeysV1: ['srv_identity:already-pinned', 'srv_identity:missing-pin'],
                sessionListGroupOrderV1: {
                    [PINNED_GROUP_KEY_V1]: ['srv_identity:already-ordered', 'srv_identity:missing-ordered'],
                },
                workspaceLabelsV1: {
                    'server:srv_identity:workspaces': 'Existing',
                    'server:srv_identity:active:project:p1': 'Missing',
                },
            },
            existingSnapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
                version: 3,
                pins: [{
                    sessionId: 'already-pinned',
                    sortKey: '00000001',
                    pinnedAt: 1,
                }],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [{
                    scopeKind: 'pinned',
                    scopeKey: 'pins',
                    itemKind: 'session',
                    itemKey: 'already-ordered',
                    sortKey: '00000001',
                }],
                labels: [{
                    labelKind: 'workspace',
                    scopeKey: 'server:srv_identity:workspaces',
                    display: null,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        });

        expect(plan.hasLegacyOrganizationSettings).toBe(true);
        expect(plan.hasImportableLegacyOrganization).toBe(true);
        expect(plan.request.pins).toEqual([
            { sessionId: 'missing-pin', sortKey: '00000002' },
        ]);
        expect(plan.request.orderEntries).toEqual([
            {
                scopeKind: 'pinned',
                scopeKey: 'pins',
                itemKind: 'session',
                itemKey: 'missing-ordered',
                sortKey: '00000002',
            },
        ]);
        expect(plan.request.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:srv_identity:active:project:p1',
                display: { t: 'plain', v: { label: 'Missing' } },
            },
        ]);
    });

    it('strips only imported server-scope entries from legacy account settings', () => {
        const rawSettings = {
            analyticsOptOut: false,
            pinnedSessionKeysV1: [
                'srv_identity:session-a',
                'other-server:session-b',
            ],
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'folder-current',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'srv_identity',
                            machineId: 'machine-a',
                            rootPath: '/repo',
                        },
                        parentId: null,
                        name: 'Current',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'folder-other',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'other-server',
                            machineId: 'machine-b',
                            rootPath: '/other',
                        },
                        parentId: null,
                        name: 'Other',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            sessionTagsV1: {
                'srv_identity:session-a': ['current'],
                'other-server:session-b': ['other'],
            },
            sessionListGroupOrderV1: {
                [PINNED_GROUP_KEY_V1]: [
                    'srv_identity:session-a',
                    'other-server:session-b',
                    'folder:folder-current',
                ],
                'server:srv_identity:active:project:p1': ['srv_identity:session-a'],
                'server:other-server:active:project:p2': ['other-server:session-b'],
            },
            sessionWorkspaceOrderV1: {
                'server:srv_identity:workspaces': ['workspace:/repo'],
                'server:other-server:workspaces': ['workspace:/other'],
            },
            workspaceLabelsV1: {
                'server:srv_identity:workspaces': 'Current',
                'server:other-server:workspaces': 'Other',
            },
        };

        expect(stripImportedLegacySessionOrganizationSettingsForServer({
            serverId: 'srv_identity',
            rawSettings,
        })).toEqual({
            analyticsOptOut: false,
            pinnedSessionKeysV1: ['other-server:session-b'],
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'folder-other',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'other-server',
                            machineId: 'machine-b',
                            rootPath: '/other',
                        },
                        parentId: null,
                        name: 'Other',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            sessionTagsV1: {
                'other-server:session-b': ['other'],
            },
            sessionListGroupOrderV1: {
                [PINNED_GROUP_KEY_V1]: ['other-server:session-b'],
                'server:other-server:active:project:p2': ['other-server:session-b'],
            },
            sessionWorkspaceOrderV1: {
                'server:other-server:workspaces': ['workspace:/other'],
            },
            workspaceLabelsV1: {
                'server:other-server:workspaces': 'Other',
            },
        });
    });
});

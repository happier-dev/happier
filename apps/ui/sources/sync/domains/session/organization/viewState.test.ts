import { describe, expect, it } from 'vitest';

import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import type { SessionOrganizationProjection } from './types';
import { buildSessionOrganizationLabelKey } from './keys';
import {
    buildSessionOrganizationListViewState,
    applyWorkspaceDisplayToSessionListViewData,
    buildSessionOrganizationReorderRequestFromGroupOrder,
    buildSessionOrganizationReorderRequestFromWorkspaceOrder,
} from './viewState';

function projection(overrides: Partial<SessionOrganizationProjection>): SessionOrganizationProjection {
    return {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById: {},
        folderAssignmentsBySessionId: {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        appearancesBySessionId: {},
        sessionAppearancesBySessionId: {},
        sessionAppearancesSupported: false,
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
        ...overrides,
    };
}

describe('buildSessionOrganizationListViewState', () => {
    it('retains the empty session-list projection', () => {
        const items: [] = [];
        expect(applyWorkspaceDisplayToSessionListViewData(items, {})).toBe(items);
    });
    it('projects each header own-server workspace name and colour without cross-server collisions or identity churn', () => {
        const items = ['server-a', 'server-b', 'server-c'].map((serverId) => ({
            type: 'header' as const, headerKind: 'project' as const, serverId, workspaceKey: 'wl_a', title: 'Project',
        }));
        const label = { labelKind: 'workspace', scopeKey: 'wl_a', archivedAt: null, createdAt: 1, updatedAt: 1 } as const;
        const labels = {
            [buildSessionOrganizationLabelKey({ serverId: 'server-a', labelKind: 'workspace', scopeKey: 'wl_a' })]: { ...label, display: { t: 'plain', v: { label: 'Alpha', color: { kind: 'accent', key: 'blue' } } } },
            [buildSessionOrganizationLabelKey({ serverId: 'server-b', labelKind: 'workspace', scopeKey: 'wl_a' })]: { ...label, display: { t: 'plain', v: { label: 'Beta', color: { kind: 'custom', hex: '#123456' } } } },
        } as const;
        const first = applyWorkspaceDisplayToSessionListViewData(items, labels);
        expect(first?.[0]).toMatchObject({ workspaceLabel: 'Alpha', appearanceColor: { kind: 'accent', key: 'blue' } });
        expect(first?.[1]).toMatchObject({ workspaceLabel: 'Beta', appearanceColor: { kind: 'custom', hex: '#123456' } });
        expect(first?.[2]).toBe(items[2]);
        expect(applyWorkspaceDisplayToSessionListViewData(items, structuredClone(labels))).toBe(first);
        expect(applyWorkspaceDisplayToSessionListViewData(items, {})).toBe(items);
    });
    it('retains colour-only workspaces and projects names and colours independently', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: projection({
                labelsByLabelKey: {
                    a: { labelKind: 'workspace', scopeKey: 'wl_a', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#abCDEF' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
                    b: { labelKind: 'workspace', scopeKey: 'wl_b', display: { t: 'plain', v: { label: ' Project ', color: { kind: 'accent', key: 'blue' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
                    c: { labelKind: 'workspace', scopeKey: 'wl_c', display: { t: 'plain', v: { label: 'Bad colour', color: { kind: 'accent', key: 'invalid' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
                },
            }),
        });
        expect(state.workspaceLabelsV1).toEqual({ wl_b: 'Project', wl_c: 'Bad colour' });
        expect(state).toMatchObject({ workspaceColorsV1: { wl_a: { kind: 'custom', hex: '#ABCDEF' }, wl_b: { kind: 'accent', key: 'blue' } } });
    });
    it('maps server-backed pins, tags, and scoped order entries to the session-list view contracts', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: projection({
                pinnedSessionIds: ['s2', 's1'],
                tagsById: {
                    'tag-a': {
                        tagId: 'tag-a',
                        tagKey: 'opaque-tag-a',
                        sortKey: null,
                        display: { t: 'plain', v: { label: 'Urgent' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    'tag-b': {
                        tagId: 'tag-b',
                        tagKey: 'opaque-tag-b',
                        sortKey: null,
                        display: { t: 'plain', v: { label: 'Review' } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                },
                tagAssignmentsBySessionId: {
                    s1: ['tag-a', 'tag-b'],
                },
                orderEntriesByScopeKey: {
                    'server-a:pinned:pins': [
                        { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 'server-a:s1', sortKey: 'a' },
                        { scopeKind: 'pinned', scopeKey: 'pins', itemKind: 'session', itemKey: 'server-a:s2', sortKey: 'b' },
                    ],
                    'server-a:workspace:server-a': [
                        { scopeKind: 'workspace', scopeKey: 'server-a', itemKind: 'workspace', itemKey: 'repo-b', sortKey: 'b' },
                        { scopeKind: 'workspace', scopeKey: 'server-a', itemKind: 'workspace', itemKey: 'repo-a', sortKey: 'a' },
                    ],
                    'server-a:group:server:server-a:day:2026-06-30': [
                        { scopeKind: 'group', scopeKey: 'server:server-a:day:2026-06-30', itemKind: 'session', itemKey: 'server-a:s1', sortKey: 'b' },
                        { scopeKind: 'group', scopeKey: 'server:server-a:day:2026-06-30', itemKind: 'session', itemKey: 'server-a:s2', sortKey: 'a' },
                    ],
                },
            }),
        });

        expect(state.pinnedSessionKeysV1).toEqual(['server-a:s2', 'server-a:s1']);
        expect(state.sessionTagsV1).toEqual({ 'server-a:s1': ['Urgent', 'Review'] });
        expect(state.sessionListGroupOrderV1).toEqual({
            [PINNED_GROUP_KEY_V1]: ['server-a:s1', 'server-a:s2'],
            'server:server-a:day:2026-06-30': ['server-a:s2', 'server-a:s1'],
        });
        expect(state.sessionWorkspaceOrderV1).toEqual({
            [buildSessionWorkspaceOrderScopeKey('server-a')]: ['workspace:repo-a', 'workspace:repo-b'],
        });
    });

    it('maps server-backed attention standings to session-key overrides the placement policy can resolve', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: projection({
                appearancesBySessionId: {},
                sessionAppearancesBySessionId: {},
                sessionAppearancesSupported: false,
                attentionStandingsBySessionId: {
                    s1: { sessionId: 's1', standing: true, updatedAt: 20 },
                    s2: { sessionId: 's2', standing: false, updatedAt: 21 },
                },
            }),
        });

        expect(state.attentionStandingOverridesBySessionKey).toEqual({
            'server-a:s1': { sessionId: 's1', standing: true, updatedAt: 20 },
            'server-a:s2': { sessionId: 's2', standing: false, updatedAt: 21 },
        });
    });

    it('uses server-backed folder definitions only when the private display payload carries workspace context', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: projection({
                foldersById: {
                    folder_a: {
                        folderId: 'folder_a',
                        folderKey: 'legacy-folder-a',
                        parentFolderId: null,
                        parentFolderKey: null,
                        sortKey: 'a',
                        display: {
                            t: 'plain',
                            v: {
                                name: 'Planning',
                                workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
                            },
                        },
                        archivedAt: null,
                        createdAt: 10,
                        updatedAt: 11,
                    },
                },
                folderAssignmentsBySessionId: {
                    s1: 'folder_a',
                },
            }),
        });

        expect(state.sessionFoldersV1.folders).toEqual([
            expect.objectContaining({
                id: 'folder_a',
                name: 'Planning',
                workspace: { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
            }),
        ]);
        expect(state.sessionFolderAssignmentsBySessionKey).toEqual({ 'server-a:s1': 'folder_a' });
    });

    it('maps server-backed workspace labels to the session-list view contract', () => {
        const state = buildSessionOrganizationListViewState({
            serverId: 'server-a',
            projection: projection({
                labelsByLabelKey: {
                    'server-a:workspace:server:server-a:workspace:/repo-a': {
                        labelKind: 'workspace',
                        scopeKey: 'server:server-a:workspace:/repo-a',
                        display: { t: 'plain', v: { label: 'Client Project' } },
                        archivedAt: null,
                        createdAt: 10,
                        updatedAt: 11,
                    },
                    'server-a:workspace:server:server-a:workspace:/repo-b': {
                        labelKind: 'workspace',
                        scopeKey: 'server:server-a:workspace:/repo-b',
                        display: { t: 'plain', v: { label: '   ' } },
                        archivedAt: null,
                        createdAt: 10,
                        updatedAt: 11,
                    },
                    'server-a:group:group-a': {
                        labelKind: 'group',
                        scopeKey: 'group-a',
                        display: { t: 'plain', v: { label: 'Ignored group label' } },
                        archivedAt: null,
                        createdAt: 10,
                        updatedAt: 11,
                    },
                },
            }),
        });

        expect(state.workspaceLabelsV1).toEqual({
            'server:server-a:workspace:/repo-a': 'Client Project',
        });
    });
});

describe('session organization reorder request adapters', () => {
    it('maps legacy pinned and group order scopes to server-backed reorder requests', () => {
        expect(buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'server-a',
            scopeKey: PINNED_GROUP_KEY_V1,
            itemKeys: ['server-a:s2', 'server-a:s1', 'server-b:ignored'],
        })).toEqual({
            scopeKind: 'pinned',
            scopeKey: 'pins',
            entries: [
                { itemKind: 'session', itemKey: 's2', sortKey: '00000001' },
                { itemKind: 'session', itemKey: 's1', sortKey: '00000002' },
            ],
        });

        expect(buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: 'server-a',
            scopeKey: 'server:server-a:active:project:repo',
            itemKeys: ['folder:folder-a', 'server-a:s1'],
        })).toEqual({
            scopeKind: 'group',
            scopeKey: 'server:server-a:active:project:repo',
            entries: [
                { itemKind: 'folder', itemKey: 'folder-a', sortKey: '00000001' },
                { itemKind: 'session', itemKey: 's1', sortKey: '00000002' },
            ],
        });
    });

    it('maps legacy workspace order scopes to server-backed reorder requests', () => {
        expect(buildSessionOrganizationReorderRequestFromWorkspaceOrder({
            serverId: 'server-a',
            scopeKey: buildSessionWorkspaceOrderScopeKey('server-a'),
            itemKeys: ['workspace:repo-b', 'workspace:repo-a'],
        })).toEqual({
            scopeKind: 'workspace',
            scopeKey: 'server-a',
            entries: [
                { itemKind: 'workspace', itemKey: 'repo-b', sortKey: '00000001' },
                { itemKind: 'workspace', itemKey: 'repo-a', sortKey: '00000002' },
            ],
        });
    });
});

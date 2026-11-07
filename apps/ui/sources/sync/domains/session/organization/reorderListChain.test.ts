import { describe, expect, it } from 'vitest';

import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import { createSessionOrganizationDomain, type SessionOrganizationDomain } from '@/sync/store/domains/sessionOrganization';
import { buildSessionListTreeRows } from '@/components/sessions/shell/drop-resolution/buildSessionListTreeRows';
import { buildSessionListGroupOrderAfterTreeDrop } from '@/components/sessions/shell/commit/applyGroupOrderUpdate';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';
import { buildSessionOrganizationProjection } from './projection';
import { buildSessionOrganizationListViewState, buildSessionOrganizationReorderRequestFromGroupOrder } from './viewState';

const serverId = 'server-a';
const groupKey = 'server:server-a:project:repo';
const source: SessionListIndexItem[] = [
    { type: 'header', headerKind: 'active', title: 'Active', serverId },
    { type: 'header', headerKind: 'project', title: 'Repo', serverId, groupKey },
    ...['a', 'b', 'c', 'd'].map((sessionId): SessionListIndexItem => ({
        type: 'session', sessionId, serverId, section: 'active', groupKind: 'project', groupKey,
    })),
];

describe('session reorder reaches the visible list', () => {
    it('projects optimistic pinned and active group order writes into the list', () => {
        let state = {} as SessionOrganizationDomain;
        const get = () => state;
        const set = (updater: (value: SessionOrganizationDomain) => Partial<SessionOrganizationDomain>) => {
            state = { ...state, ...updater(state) };
        };
        state = createSessionOrganizationDomain({ get, set } as never);
        state.applySessionOrganizationSnapshot(serverId, {
            schemaVersion: 1, version: 1,
            pins: [{ sessionId: 'a', sortKey: 'a', pinnedAt: 1 }, { sessionId: 'b', sortKey: 'b', pinnedAt: 2 }],
            folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
        });

        const render = () => {
            const projection = buildSessionOrganizationProjection({
                schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId,
                snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId,
                pinsBySessionKey: state.sessionOrganizationPinsBySessionKey,
                foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey,
                folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
                tagsByTagKey: state.sessionOrganizationTagsByTagKey,
                tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
                attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey,
                appearancesBySessionKey: state.sessionOrganizationAppearancesBySessionKey,
                sessionAppearancesSupportedByServerId: state.sessionOrganizationSessionAppearancesSupportedByServerId,
                orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey,
                labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey,
            }, serverId);
            const view = buildSessionOrganizationListViewState({ serverId, projection });
            const items = computeVisibleSessionListIndex({
                source, resolveSessionRow: () => null, hideInactiveSessions: false,
                pinnedSessionKeysV1: view.pinnedSessionKeysV1,
                sessionListGroupOrderV1: view.sessionListGroupOrderV1,
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            }) ?? [];
            return { view, items, ids: items.filter((item) => item.type === 'session').map((item) => item.sessionId) };
        };
        const reorder = (scopeKey: string, movedId: string, beforeId: string) => {
            const { view, items } = render();
            const tree = buildSessionListTreeRows({ items });
            const movedRowId = treeRowId.session(serverId, movedId);
            const moved = tree.rowMetadataById.get(movedRowId);
            if (!moved) throw new Error('missing moved row');
            const next = buildSessionListGroupOrderAfterTreeDrop({
                tree, currentMap: view.sessionListGroupOrderV1, movedRowId,
                containerId: moved.containerId, beforeRowId: treeRowId.session(serverId, beforeId),
            });
            const itemKeys = next?.[scopeKey];
            if (!itemKeys) throw new Error(`missing order scope ${scopeKey}`);
            const request = buildSessionOrganizationReorderRequestFromGroupOrder({ serverId, scopeKey, itemKeys });
            if (!request) throw new Error('missing reorder request');
            state.applySessionOrganizationOrderScopeOptimistic(serverId, {
                scopeKind: request.scopeKind, scopeKey: request.scopeKey,
                entries: request.entries.map((entry) => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })),
            });
        };

        expect(render().ids).toEqual(['a', 'b', 'c', 'd']);
        reorder('pinned-v1', 'b', 'a');
        expect(render().ids).toEqual(['b', 'a', 'c', 'd']);
        reorder(groupKey, 'd', 'c');
        expect(render().ids).toEqual(['b', 'a', 'd', 'c']);
    });
});

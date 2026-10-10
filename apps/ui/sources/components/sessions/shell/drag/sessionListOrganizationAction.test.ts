import { describe, expect, it } from 'vitest';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { buildSessionOrganizationOrderScopeKey } from '@/sync/domains/session/organization/keys';
import { getStorage } from '@/sync/domains/state/storageStore';
import { writeSessionOrganizationGroupOrder, type SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { CommitSessionListDragIntentContext } from './commitSessionListDragIntent';
import { treeRowId } from '../drop-resolution/treeRowId';
import { createSessionListOrganizationActionAdapter, invokeSessionListOrganizationAction, registerMountedSessionListOrganizationAction } from './sessionListOrganizationAction';

describe('mounted Session organization rail projection', () => {
    it('keeps the rail projection answering after the ordinary list unmounts, without retargeting or losing other pins', async () => {
        const serverId = 'rail-home';
        const ids = ['first', 'list-only', 'last'];
        const key = (sessionId: string) => sessionAddressKey({ serverId, sessionId });
        const pinnedItems: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'pinned', title: 'Pinned', groupKey: PINNED_GROUP_KEY_V1, serverId },
            ...ids.map(sessionId => ({ type: 'session' as const, serverId, sessionId, groupKind: 'pinned' as const,
                groupKey: PINNED_GROUP_KEY_V1, pinned: true })),
        ];
        const persisted: string[][] = [];
        const mutationScope: SessionOrganizationMutationScope = {
            serverId, serverUrl: 'https://rail-home.test', serverIdAliases: [], credentials: { token: 'token', secret: 'secret' },
            requestAtEndpoint: async (path, init) => {
                expect(path).toBe('/v2/session-organization/order');
                const request = ReorderSessionOrganizationRequestSchema.parse(JSON.parse(String(init?.body)));
                expect(request.scopeKind).toBe('pinned');
                persisted.push(request.entries.map(entry => entry.itemKey));
                return Response.json({ orderEntries: request.entries.map(entry => ({ ...entry, scopeKind: request.scopeKind, scopeKey: request.scopeKey })) });
            },
        };
        const addresses = Object.fromEntries(ids.map(sessionId => [key(sessionId), { itemKind: 'session' as const, serverId, sessionId }]));
        const context: CommitSessionListDragIntentContext = {
            scope: { serverId, accountId: 'account' }, latestItems: [],
            pinnedOrganization: { items: pinnedItems, railSessionRowIds: [treeRowId.session(serverId, 'first'), treeRowId.session(serverId, 'last')] },
            sessionFoldersV1: { v: 1, folders: [] }, sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ids.map(key) },
            manualSessionOrderingEnabled: true, sessionListOrderingModeV1: 'custom', now: () => 1,
            setSessionFoldersV1: async () => { throw new Error('rail_must_not_change_folders'); },
            setSessionFolderAssignment: async () => { throw new Error('rail_must_not_assign_folders'); },
            setSessionListGroupOrderV1: async next => {
                await writeSessionOrganizationGroupOrder({ scope: mutationScope, next, orderItemAddressByItemKey: addresses });
            },
        };
        const adapter = createSessionListOrganizationActionAdapter(() => context);
        const retire = registerMountedSessionListOrganizationAction(adapter, 'rail');
        // The ordinary column can open and close while the shell's rail remains visible.
        const retireList = registerMountedSessionListOrganizationAction(async () => ({ status: 'unavailable' }));
        retireList();
        const input = { scope: context.scope, projection: 'rail', sourceKind: 'leaf', sourceRowId: treeRowId.session(serverId, 'last'),
            instructionKind: 'reorder-before', targetRowId: treeRowId.session(serverId, 'first'), containerId: PINNED_GROUP_KEY_V1,
            parentRowId: null, depth: 0, edge: 'top' };
        try {
            expect(await invokeSessionListOrganizationAction({ input, mutationScope })).toEqual({ status: 'applied' });
            expect(persisted).toEqual([['last', 'first', 'list-only']]);
            const scopeKey = buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: 'pinned', scopeKey: 'pins' });
            expect(getStorage().getState().sessionOrganizationOrderEntriesByScopeKey[scopeKey]?.map(entry => entry.itemKey))
                .toEqual(['last', 'first', 'list-only']);
            expect(await invokeSessionListOrganizationAction({ input: { ...input, scope: { serverId, accountId: 'other' } }, mutationScope }))
                .toMatchObject({ status: 'refused' });
            expect(await invokeSessionListOrganizationAction({ input: { ...input, targetRowId: treeRowId.session(serverId, 'list-only') }, mutationScope }))
                .toMatchObject({ status: 'refused' });
            expect(persisted).toHaveLength(1);
        } finally { retire(); getStorage().getState().clearSessionOrganizationForServer(serverId); }
        expect(await invokeSessionListOrganizationAction({ input, mutationScope })).toEqual({ status: 'unavailable' });
    });
});

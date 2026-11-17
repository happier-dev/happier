import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
    PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as paths,
    PluginCollectionSharingListRequestV1Schema,
    PluginCollectionSharingListResponseV1Schema,
    PluginCollectionSharingResourceV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionSharingV1';

import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useTeamSharedCollections } = await import('./useTeamSharedCollections');
const { storage } = await import('@/sync/domains/state/storage');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
    approvalWaivedSurfaces: { [ids.list]: ['ui'] },
} });
const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'example.documents', contribution: {
    id: 'documents', schemaVersion: 1, rowIdField: 'id', identityFields: [],
    schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id', 'note'], additionalProperties: false },
    serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
} });
const collectionRef = { pluginId: contract.pluginId, collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
const nativeRow = (id: string, note: string) => {
    const encoded = encodePluginCollectionLogicalValueV1({ contract, value: { id, note },
        isValidLogicalValue: (value): value is { id: string; note: string } => typeof value.id === 'string' && typeof value.note === 'string',
        encryptionMode: 'plain', material: null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    return PluginCollectionSharingResourceV1Schema.parse({ pluginId: contract.pluginId, collectionId: contract.collectionId,
        ownerAccountId: 'owner', rowId: id, access: 'view', encryptionMode: 'plain', encryptedDataKey: null,
        row: { rowId: id, revision: 1, content: encoded.content, projection: encoded.projection } });
};
const logicalRow = (id: string, note: string) => ({ ownerAccountId: 'owner', access: 'view', rowId: id, revision: 1, value: { id, note } });
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let credentialReplacement: HomeCredentialWriteRollback | null = null;
beforeEach(async () => {
    await homes.reset();
    resetTeamActionClientForTests();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Collection Team', serverUrl: 'https://collection-team.test', accountId: 'member', currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-team.test', accountId: 'member', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.setState({ settings });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    homes.answer(serverId, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { body: { access: 'readOnly', contract } });
});
afterEach(async () => {
    standardCleanup();
    await credentialReplacement?.rollback(); credentialReplacement = null;
    await connection?.dispose(); connection = undefined;
    resetTeamActionClientForTests();
    vi.restoreAllMocks();
});

describe('useTeamSharedCollections', () => {
    it('withdraws decoded rows when Home credentials replace the retained caller Account', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        homes.answer(serverId, paths.sharedWithMe, { body: PluginCollectionSharingListResponseV1Schema.parse({
            resources: [nativeRow('first', 'Account A private value')], nextCursor: null,
        }) });
        const hook = await renderHook(() => useTeamSharedCollections({ scope, address: { serverId, teamId: 'team-a' },
            collectionRef, enabled: true, pageSize: 1 }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([logicalRow('first', 'Account A private value')]));
        const reads = homes.requestsFor(paths.sharedWithMe).length;
        expect(reads).toBe(1);
        await act(async () => {
            credentialReplacement = await TokenStorage.setCredentialsForServerUrlWithRollback('https://collection-team.test', { serverId }, {
                token: createAccountTokenForTests('replacement-member', { currentAccount: true }), encryption: null,
            });
            expect(credentialReplacement).not.toBeNull();
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([]));
        await act(async () => { await hook.getCurrent().reload(); });
        expect(homes.requestsFor(paths.sharedWithMe)).toHaveLength(reads);
        await hook.unmount();
    });

    it('decodes native logical pages for the selected Team and releases hidden or absent collection demand', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        const requests: ReturnType<typeof PluginCollectionSharingListRequestV1Schema.parse>[] = [];
        let firstNote = 'First private value';
        homes.answer(serverId, paths.sharedWithMe, { select: raw => {
            const input = PluginCollectionSharingListRequestV1Schema.parse(raw);
            requests.push(input);
            return { body: PluginCollectionSharingListResponseV1Schema.parse({
                resources: input.cursor ? [nativeRow('second', 'Second private value')] : [nativeRow('first', firstNote)],
                nextCursor: input.cursor ? null : 'first-cursor',
            }) };
        } });
        const hook = await renderHook((props: { enabled: boolean; teamId: string; hasCollection: boolean }) => useTeamSharedCollections({
            scope, address: { serverId, teamId: props.teamId }, collectionRef: props.hasCollection ? collectionRef : null,
            enabled: props.enabled, pageSize: 1,
        }), { initialProps: { enabled: false, teamId: 'team-a', hasCollection: true } });
        expect(requests).toHaveLength(0);
        await hook.rerender({ enabled: true, teamId: 'team-a', hasCollection: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().rows).toEqual([logicalRow('first', firstNote)]);
        expect(requests).toEqual([{ pluginId: contract.pluginId, collectionId: contract.collectionId,
            readerContext: collectionRef, sharedWithTeamId: 'team-a', limit: 1 }]);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().rows).toEqual([logicalRow('first', firstNote), logicalRow('second', 'Second private value')]);
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(requests[1]).toEqual({ ...requests[0], cursor: 'first-cursor' });
        const loadedReads = requests.length;
        await act(async () => { publishHomeAccountChange(serverId, ['unrelated'], { teamSharedResourcesAffect: false }); });
        await flushHookEffects();
        expect(requests).toHaveLength(loadedReads);
        firstNote = 'Changed logical value';
        await act(async () => { publishHomeAccountChange(serverId, ['collection'], { teamSharedResourcesAffect: true }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([
            logicalRow('first', firstNote), logicalRow('second', 'Second private value'),
        ]));
        expect(requests).toHaveLength(loadedReads + 2);
        await hook.rerender({ enabled: true, teamId: 'team-b', hasCollection: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(requests.at(-1)).toEqual({ ...requests[0], sharedWithTeamId: 'team-b' });
        expect(hook.getCurrent().rows).toEqual([logicalRow('first', firstNote)]);
        await hook.rerender({ enabled: false, teamId: 'team-b', hasCollection: true });
        expect(hook.getCurrent().rows).toEqual([]);
        const hiddenReads = requests.length;
        publishHomeAccountChange(serverId, ['collection'], { teamSharedResourcesAffect: true });
        await hook.getCurrent().reload();
        await hook.rerender({ enabled: true, teamId: 'team-b', hasCollection: false });
        await flushHookEffects();
        expect(requests).toHaveLength(hiddenReads);
        expect(homes.requestsFor(paths.census)).toHaveLength(0);
        await hook.unmount();
    });

    it('keeps native pending and refusal outcomes visible and recovers to an empty logical page', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        const pending = createDeferred<void>();
        homes.answer(serverId, paths.sharedWithMe, { respondAfter: pending.promise,
            body: PluginCollectionSharingListResponseV1Schema.parse({ resources: [nativeRow('first', 'Private value')], nextCursor: null }) });
        const hook = await renderHook(() => useTeamSharedCollections({ scope, address: { serverId, teamId: 'team-a' },
            collectionRef, enabled: true, pageSize: 1 }));
        expect(hook.getCurrent().status).toBe('loading');
        await act(async () => { pending.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([logicalRow('first', 'Private value')]));
        homes.answer(serverId, paths.sharedWithMe, { status: 404, body: { error: 'collection_unavailable' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error?.code).toBe('collection_unavailable');
        homes.answer(serverId, paths.sharedWithMe, { body: PluginCollectionSharingListResponseV1Schema.parse({ resources: [], nextCursor: null }) });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', rows: [], error: null, hasMore: false });
        await hook.unmount();
    });
});

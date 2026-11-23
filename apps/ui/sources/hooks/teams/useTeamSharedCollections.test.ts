import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsParse } from '@/sync/domains/settings/settings';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
    PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as paths,
    PluginCollectionSharingListRequestV1Schema,
    PluginCollectionSharingListResponseV1Schema,
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
const settings = settingsParse({ actionsSettingsV1: { v: 1,
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
const identityRow = (rowId: string) => ({ ownerAccountId: 'owner', rowId });
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
    it('pages Collection addresses with a single identity request', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        const requests: unknown[] = [];
        homes.answer(serverId, paths.sharedWithMe, { select: raw => {
            requests.push(raw);
            return { body: {
                resources: [],
                identities: [{ ownerAccountId: 'owner', rowId: 'first' }],
                nextCursor: null,
            } };
        } });
        const hook = await renderHook(() => useTeamSharedCollections({
            scope, address: { serverId, teamId: 'team-a' }, collectionRef, enabled: true, pageSize: 1,
        }));
        await waitForHomeGovernance(() => expect(requests).toHaveLength(1));
        expect(requests).toEqual([{
            pluginId: contract.pluginId, collectionId: contract.collectionId,
            readerContext: collectionRef, sharedWithTeamId: 'team-a', limit: 1, projection: 'identity',
        }]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([
            { ownerAccountId: 'owner', rowId: 'first' },
        ]));
        expect(homes.requestsFor(paths.get)).toHaveLength(0);
        expect(homes.requestsFor(paths.census)).toHaveLength(0);
        await hook.unmount();
    });

    it('withdraws addresses when Home credentials replace the retained caller Account', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        homes.answer(serverId, paths.sharedWithMe, { body: PluginCollectionSharingListResponseV1Schema.parse({
            resources: [], identities: [identityRow('first')], nextCursor: null,
        }) });
        const hook = await renderHook(() => useTeamSharedCollections({ scope, address: { serverId, teamId: 'team-a' },
            collectionRef, enabled: true, pageSize: 1 }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([identityRow('first')]));
        const reads = homes.requestsFor(paths.sharedWithMe).length;
        expect(reads).toBe(1);
        await act(async () => {
            credentialReplacement = await TokenStorage.setCredentialsForServerUrlWithRollback('https://collection-team.test', { serverId }, {
                token: createAccountTokenForTests('replacement-member', { currentAccount: true }),
            });
            expect(credentialReplacement).not.toBeNull();
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([]));
        await act(async () => { await hook.getCurrent().reload(); });
        expect(homes.requestsFor(paths.sharedWithMe)).toHaveLength(reads);
        await hook.unmount();
    });

    it('pages addresses for the selected Team and releases hidden or absent collection demand', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        const requests: ReturnType<typeof PluginCollectionSharingListRequestV1Schema.parse>[] = [];
        let firstRowId = 'first';
        homes.answer(serverId, paths.sharedWithMe, { select: raw => {
            const input = PluginCollectionSharingListRequestV1Schema.parse(raw);
            requests.push(input);
            return { body: PluginCollectionSharingListResponseV1Schema.parse({
                resources: [],
                identities: [identityRow(input.cursor ? 'second' : firstRowId)],
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
        expect(hook.getCurrent().rows).toEqual([identityRow(firstRowId)]);
        expect(requests).toEqual([{ pluginId: contract.pluginId, collectionId: contract.collectionId,
            readerContext: collectionRef, sharedWithTeamId: 'team-a', limit: 1, projection: 'identity' }]);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().rows).toEqual([identityRow(firstRowId), identityRow('second')]);
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(requests[1]).toEqual({ ...requests[0], cursor: 'first-cursor' });
        const loadedReads = requests.length;
        await act(async () => { publishHomeAccountChange(serverId, ['unrelated'], { teamSharedResourcesAffect: false }); });
        await flushHookEffects();
        expect(requests).toHaveLength(loadedReads);
        firstRowId = 'replacement';
        await act(async () => { publishHomeAccountChange(serverId, ['collection'], { teamSharedResourcesAffect: true }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([
            identityRow(firstRowId), identityRow('second'),
        ]));
        expect(requests).toHaveLength(loadedReads + 2);
        await hook.rerender({ enabled: true, teamId: 'team-b', hasCollection: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(requests.at(-1)).toEqual({ ...requests[0], sharedWithTeamId: 'team-b' });
        expect(hook.getCurrent().rows).toEqual([identityRow(firstRowId)]);
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

    it('keeps native pending and refusal outcomes visible and recovers to an empty page', async () => {
        const scope = createServerAccountScope(serverId, 'member')!;
        const pending = createDeferred<void>();
        homes.answer(serverId, paths.sharedWithMe, { respondAfter: pending.promise,
            body: PluginCollectionSharingListResponseV1Schema.parse({ resources: [], identities: [identityRow('first')], nextCursor: null }) });
        const hook = await renderHook(() => useTeamSharedCollections({ scope, address: { serverId, teamId: 'team-a' },
            collectionRef, enabled: true, pageSize: 1 }));
        expect(hook.getCurrent().status).toBe('loading');
        await act(async () => { pending.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([identityRow('first')]));
        homes.answer(serverId, paths.sharedWithMe, { status: 404, body: { error: 'collection_unavailable' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error?.code).toBe('collection_unavailable');
        homes.answer(serverId, paths.sharedWithMe, { body: PluginCollectionSharingListResponseV1Schema.parse({
            resources: [], identities: [], nextCursor: null,
        }) });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', rows: [], error: null, hasMore: false });
        await hook.unmount();
    });
});

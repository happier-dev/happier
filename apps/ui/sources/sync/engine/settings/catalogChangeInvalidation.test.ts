import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildConnectedAccountCatalogPhysicalKeyV1, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { REMOTE_HOST_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { observeProviderCatalog, refreshProviderCatalog, resetProviderCatalogEngineForTests } from './providerCatalogEngine';
import { observeConnectedAccountCatalog, refreshConnectedAccountCatalog, resetConnectedAccountCatalogEngineForTests } from './connectedAccountCatalogEngine';
import { observeConnectedMetadataCatalog, refreshConnectedMetadataCatalog, resetConnectedMetadataCatalogEngineForTests } from './connectedMetadataCatalogEngine';
import { observeRemoteHostCatalog, refreshRemoteHostCatalog, resetRemoteHostCatalogEngineForTests } from './remoteHostCatalogEngine';
import { getProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { getConnectedAccountCatalogValue, resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { getRemoteHostCatalogSnapshot, resetRemoteHostCatalogSnapshotsForTests } from '@/sync/store/settings/remoteHostCatalogSnapshot';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    resetProviderCatalogEngineForTests();
    resetConnectedAccountCatalogEngineForTests();
    resetConnectedMetadataCatalogEngineForTests();
    resetRemoteHostCatalogEngineForTests();
    resetProviderCatalogSnapshotsForTests();
    resetConnectedAccountCatalogSnapshotsForTests();
    resetRemoteHostCatalogSnapshotsForTests();
    await disconnectActiveServerConnection();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});

describe('private catalog Account-change admission', () => {
    it.each(['providers', 'configurations', 'purposes', 'metadata', 'remote-hosts'] as const)(
        '%s retains admitted authority for unrelated changes, but revalidates its own rows and Account source', async domain => {
            const accountId = `catalog-wakes-${domain}`;
            let revision = 1;
            // Home HTTP and the disconnected socket are the only substituted boundaries.
            // Account admission, private-row readers, maintenance and publication all run.
            setRuntimeFetch(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
                if (path === '/v1/account/entity-rows/prompt-library') return Response.json({ status: 'listed',
                    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision,
                        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
                if (['/v1/account/entity-rows/acp', '/v1/account/entity-rows/mcp',
                    '/v1/account/entity-rows/notification-channels'].includes(path)) return Response.json({ status: 'deleted', revision });
                if (path === '/v1/account/entity-rows/provider-connections') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } });
                for (const key of ['configurations', 'purposes'] as const) {
                    if (path === `/v1/account/entity-rows/connected-accounts/${key}`) return Response.json({ status: 'present', revision,
                        content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1(key) } });
                }
                if (path === '/v1/account/entity-rows/connected-metadata/presentation'
                    || path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, entries: [] } } });
                if (path === '/v1/account/entity-rows/remote-hosts') return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, hosts: [] } } });
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            await disconnectActiveServerConnection();
            const home = await upsertAndActivateServer({ serverUrl: `https://${domain}-wakes.example.test`, name: domain });
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
            await restoreConnectionToActiveServer(credentials);
            const scope = { serverId: home.id, accountId };
            const owner = domain === 'providers' ? {
                observe: () => observeProviderCatalog(scope), refresh: () => refreshProviderCatalog(scope),
                snapshot: () => getProviderCatalogSnapshot(scope),
                rowIds: [PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1],
            } : domain === 'metadata' ? {
                observe: () => observeConnectedMetadataCatalog(scope), refresh: () => refreshConnectedMetadataCatalog(scope),
                snapshot: () => getConnectedMetadataCatalog(scope).presentation,
                rowIds: [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1],
            } : domain === 'remote-hosts' ? {
                observe: () => observeRemoteHostCatalog(scope), refresh: () => refreshRemoteHostCatalog(scope),
                snapshot: () => getRemoteHostCatalogSnapshot(scope)?.catalog, rowIds: [REMOTE_HOST_ACCOUNT_KV_KEY_V1],
            } : {
                observe: () => observeConnectedAccountCatalog(scope, domain), refresh: () => refreshConnectedAccountCatalog(scope, domain),
                snapshot: () => getConnectedAccountCatalogValue(scope, domain), rowIds: [buildConnectedAccountCatalogPhysicalKeyV1(domain)],
            };
            const release = owner.observe();
            try {
                await owner.refresh();
                await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision: 1 }));
                const before = owner.snapshot();
                for (let index = 0; index < 20; index += 1) publishHomeAccountChange(home.id, [`session-${index}`, `machine-${index}`]);
                publishHomeAccountChange(home.id, []);
                expect(owner.snapshot()).toBe(before);
                for (const entityIds of [...owner.rowIds.map(id => [id]), ['self'], undefined]) {
                    revision += 1;
                    const incumbent = owner.snapshot();
                    publishHomeAccountChange(home.id, entityIds);
                    expect(owner.snapshot()).not.toBe(incumbent);
                    await owner.refresh();
                    await vi.waitFor(() => expect(owner.snapshot()).toMatchObject({ status: 'ready', revision }));
                }
            } finally { release(); }
        },
    );
});

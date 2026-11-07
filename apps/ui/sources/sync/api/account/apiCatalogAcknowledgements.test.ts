import { describe, expect, it } from 'vitest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, CONNECTED_PRESENTATION_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostRecordV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';

installDisconnectedServerSocketBoundary();
const { getMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { getProviderCatalogSnapshot } = await import('@/sync/store/settings/providerCatalogSnapshot');
const { getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { getNotificationChannelCatalogValue } = await import('@/sync/store/settings/notificationChannelCatalogSnapshot');
const { getConnectedMetadataCatalog } = await import('@/sync/store/settings/connectedMetadataCatalogSnapshot');
const { applySavedSecretCatalogPage, getSavedSecretCatalogSnapshot } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { getRemoteHostCatalogSnapshot } = await import('@/sync/store/settings/remoteHostCatalogSnapshot');

describe('catalog mutation acknowledgement', () => {
    it.each(['database_transaction_conflict_exhausted', 'database_transaction_timeout'] as const)(
        'keeps Provider server transaction refusal %s retryable with its typed cause and no automatic replay', async errorCode => {
        let writes = 0;
        const account = await restoreServerAccountForTest({ serverUrl: 'https://provider-rollback.example.test',
            accountId: 'account-provider-rollback', request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 && init?.method === 'POST') {
                    writes += 1;
                    return Response.json({ error: errorCode, statusCode: 503 }, { status: 503 });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { writeProviderCatalogInContext } = await import('./apiProviderCatalog');
        const context = await captureLazyActionAccountContext(account.home.id);
        try {
            await expect(writeProviderCatalogInContext(context, { catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                expectedRevision: 7 })).rejects.toMatchObject({ code: 'provider_catalog_unavailable', retryable: true, action: 'retry',
                    failureCause: { phase: 'providers.connections.save', errorCode, httpStatus: 503 } });
            expect(writes).toBe(1);
        } finally { context.dispose(); await account.dispose(); }
    });

    it.each(['mcp', 'providers', 'acp', 'configurations', 'purposes', 'notifications', 'acknowledgements', 'saved-secrets', 'remote-hosts'] as const)(
        'settles %s and publishes its acknowledged row while revalidation is pending', async domain => {
            const route = domain === 'configurations' || domain === 'purposes'
                ? `/v1/account/entity-rows/connected-accounts/${domain}` : domain === 'providers'
                    ? PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 : domain === 'notifications' ? NOTIFICATION_CHANNELS_ROUTE_V1
                        : domain === 'acknowledgements' ? CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1
                            : domain === 'saved-secrets' ? '/v1/account/saved-secrets/resources/materials'
                                : domain === 'remote-hosts' ? REMOTE_HOST_ROWS_ROUTE_V1 : `/v1/account/entity-rows/${domain}`;
            const host = RemoteHostRecordV1Schema.parse({ id: 'saved-host', name: 'Saved host', ssh: { target: 'owner@example.test', authMode: 'agent' },
                createdAt: 1, updatedAt: 1, lastUsedAt: null });
            const record = domain === 'mcp' ? { v: 1, servers: [], bindings: [] }
                : domain === 'providers' ? DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1
                : domain === 'acp' ? { v: 1, definitions: [] }
                : domain === 'notifications' ? { v: 1, channels: [] }
                : domain === 'acknowledgements' ? { v: 1, entries: [] }
                : domain === 'remote-hosts' ? { v: 1, hosts: [] }
                : domain === 'configurations' ? { key: domain, value: { v: 1, entries: [] } }
                    : { key: domain, value: { v: 1, bindings: [] } };
            let committed = false;
            let refreshStarted = false;
            let releaseRead!: () => void;
            const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
            const account = await restoreServerAccountForTest({ serverUrl: `https://ack-${domain}.example.test`,
                accountId: `ack-${domain}`, request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/health') return Response.json({});
                    if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                    if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                    if (path === '/v2/account/settings/history') {
                        if (committed) { refreshStarted = true; await heldRead; }
                        return Response.json({ snapshots: [] });
                    }
                    if (path === '/v1/artifacts') return Response.json([]);
                    if (domain === 'acknowledgements' && path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) {
                        if (committed) { refreshStarted = true; await heldRead; }
                        return Response.json({ status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, entries: [] } } });
                    }
                    if (path === route) {
                        if (init?.method === 'POST') {
                            committed = true;
                            return Response.json({ status: 'updated', revision: 5, cursor: 5 });
                        }
                        if (committed) { refreshStarted = true; await heldRead; }
                        if (domain === 'saved-secrets') return Response.json({ resources: [] });
                        return Response.json({ status: 'present', revision: committed ? 5 : 4, content: { t: 'plain', v: record } });
                    }
                    return Response.json({ error: 'not_found' }, { status: 404 });
                } });
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const context = await captureLazyActionAccountContext(account.home.id);
            const scope = context.accountLifetime.scope;
            let result: unknown;
            let writing: Promise<unknown> | undefined;
            try {
                if (domain === 'mcp') {
                    const { writeMcpServerCatalogAndPublishInContext } = await import('./apiMcpServerCatalog');
                    writing = writeMcpServerCatalogAndPublishInContext(context, { catalog: { v: 1, servers: [], bindings: [] }, expectedRevision: 4 });
                } else if (domain === 'providers') {
                    const { writeProviderCatalogAndPublishInContext } = await import('./apiProviderCatalog');
                    writing = writeProviderCatalogAndPublishInContext(context, { catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, expectedRevision: 4 });
                } else if (domain === 'acp') {
                    const { writeAcpCatalogRecordAndPublishInContext } = await import('./apiAcpCatalog');
                    writing = writeAcpCatalogRecordAndPublishInContext(context, { record: { v: 1, definitions: [] }, expectedRevision: 4 });
                } else if (domain === 'notifications') {
                    const { writeNotificationChannelCatalogInContext, publishAcknowledgedNotificationChannelCatalog } = await import('./apiNotificationChannelCatalog');
                    writing = writeNotificationChannelCatalogInContext(context, { record: { v: 1, channels: [] }, expectedRevision: 4 })
                        .then(async receipt => { await publishAcknowledgedNotificationChannelCatalog(context); return receipt; });
                } else if (domain === 'acknowledgements') {
                    const { setConnectedAcknowledgementInContext } = await import('./apiConnectedMetadataCatalog');
                    writing = setConnectedAcknowledgementInContext(context, { subject: { kind: 'warning', warningId: 'acknowledged-warning',
                        scope: { kind: 'account' } }, acknowledged: true }).then(() => ({ status: 'updated', revision: 5 }));
                } else if (domain === 'saved-secrets') {
                    applySavedSecretCatalogPage({ scope, observedAt: 1, entries: [SavedSecretCatalogEntryV1Schema.parse({ ref: 'happier:shared-secret:v1:removed-secret',
                        source: 'shared_resource', relationship: 'owner', ownerAccountId: scope.accountId, name: 'Removed', kind: 'token', revision: 4,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } })] });
                    const { applySavedSecretCatalogDeletion } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
                    committed = true;
                    writing = applySavedSecretCatalogDeletion(scope, 'removed-secret').then(() => ({ status: 'updated', revision: 5 }));
                } else if (domain === 'remote-hosts') {
                    const { saveRemoteHostInContext } = await import('./apiRemoteHostCatalog');
                    writing = saveRemoteHostInContext(context, { host, expectedRevision: 4 }).then(receipt => {
                        if (!receipt.ok) throw new Error(`Unexpected remote-host refusal: ${receipt.reason}`);
                        return { status: 'updated', revision: receipt.revision };
                    });
                } else {
                    const { writeConnectedAccountCatalogRecordAndPublishInContext } = await import('./apiConnectedAccountCatalog');
                    writing = writeConnectedAccountCatalogRecordAndPublishInContext(context, { record: domain === 'configurations'
                        ? { key: 'configurations', value: { v: 1, entries: [] } } : { key: 'purposes', value: { v: 1, bindings: [] } }, expectedRevision: 4 });
                }
                void writing.then(value => { result = value; });
                await expect.poll(() => refreshStarted).toBe(true);
                expect(result).toMatchObject({ status: 'updated', revision: 5 });
                const projectedRevision = domain === 'mcp' ? getMcpServerCatalogSnapshot(scope).revision
                    : domain === 'providers' ? getProviderCatalogSnapshot(scope)?.revision
                    : domain === 'notifications' ? getNotificationChannelCatalogValue(scope).revision
                    : domain === 'acp' || domain === 'acknowledgements' || domain === 'saved-secrets' || domain === 'remote-hosts'
                        ? undefined : getConnectedAccountCatalogValue(scope, domain).revision;
                if (domain === 'acp') expect(getAcpCatalogSnapshot(scope)?.data).toEqual({ v: 1, definitions: [] });
                else if (domain === 'acknowledgements') expect(Object.values(getConnectedMetadataCatalog(scope).acknowledgementsByKey)).toContain(true);
                else if (domain === 'saved-secrets') expect(getSavedSecretCatalogSnapshot(scope)?.data).toEqual([]);
                else if (domain === 'remote-hosts') expect(getRemoteHostCatalogSnapshot(scope)?.data).toEqual([host]);
                else expect(projectedRevision).toBe(5);
            } finally {
                releaseRead();
                await writing;
                context.dispose();
                await account.dispose();
            }
        });
});

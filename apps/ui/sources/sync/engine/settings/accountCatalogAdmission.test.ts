import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ConnectedAccountCatalogRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { WebhookNotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1 } from '@happier-dev/protocol/account/settings/notificationChannels';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
await import('@/sync/ops/actions/defaultActionExecutor');
const { readProviderCatalog } = await import('@/sync/api/account/apiProviderCatalog');
const { readConnectedAccountCatalog } = await import('@/sync/api/account/apiConnectedAccountCatalog');
const { readNotificationChannelCatalogProjection } = await import('@/sync/api/account/apiNotificationChannelCatalog');
const { readConnectedMetadataCatalogProjection } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
const { readMcpServerCatalog } = await import('@/sync/api/account/apiMcpServerCatalog');
const { readAcpCatalog } = await import('@/sync/api/account/apiAcpCatalog');
const { applyProviderCatalogSnapshot, getProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } = await import('@/sync/store/settings/providerCatalogSnapshot');
const { applyConnectedAccountCatalogSnapshot, getConnectedAccountCatalogValue, resetConnectedAccountCatalogSnapshotsForTests } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { applyNotificationChannelCatalogSnapshot, getNotificationChannelCatalogValue, resetNotificationChannelCatalogSnapshotsForTests } = await import('@/sync/store/settings/notificationChannelCatalogSnapshot');
const { applyConnectedMetadataCatalogSnapshot, getConnectedMetadataCatalog } = await import('@/sync/store/settings/connectedMetadataCatalogSnapshot');

beforeEach(async () => {
    await home.reset();
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
});
afterEach(async () => {
    resetProviderCatalogSnapshotsForTests();
    resetConnectedAccountCatalogSnapshotsForTests();
    resetNotificationChannelCatalogSnapshotsForTests();
    await home.reset();
    resetRuntimeFetch();
});

describe('private catalog Account admission', () => {

    it('retains a real currentness transport refusal as unreachable for adjacent catalog readers', async () => {
        const accountId = 'adjacent-currentness-offline';
        const serverId = await home.addHome({ name: 'Adjacent offline admission', serverUrl: 'https://adjacent-currentness-offline.example.test',
            accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
        const scope = { serverId, accountId };
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { select: () => { throw new TypeError('Network request failed'); } });
        expect(await readMcpServerCatalog(scope)).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable', reason: 'unreachable' } });
    });

    it.each([401, 403])('preserves mode-endpoint HTTP %s admission for the adjacent MCP and ACP readers', async status => {
        const accountId = `adjacent-mode-denial-${status}`;
        const serverId = await home.addHome({ name: 'Adjacent catalog admission', serverUrl: `https://adjacent-mode-denial-${status}.example.test`,
            accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
        const scope = { serverId, accountId };
        home.answer(serverId, 'GET /v1/account/encryption', { select: () => { throw new TypeError('Network request failed'); } });
        expect(await readMcpServerCatalog(scope)).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable', reason: 'unreachable' } });
        home.answer(serverId, 'GET /v1/account/encryption', { status, body: { error: 'denied' } });
        const reason = status === 401 ? 'unauthorized' : 'forbidden';
        expect(await readMcpServerCatalog(scope)).toMatchObject({ status: 'unavailable', reason });
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable', reason } });
    });

    it.each([
        { status: 401, reason: 'unauthorized', error: 'denied' },
        { status: 403, reason: 'forbidden', error: 'denied' },
        { status: 400, reason: 'encryption-material-unavailable', error: 'account-encryption-recovery-required' },
    ])('withdraws every loaded projection on mode-endpoint HTTP $status but retains it on network failure', async ({ status, reason, error }) => {
        const accountId = `catalog-mode-denial-${status}`;
        const serverId = await home.addHome({ name: 'Catalog admission', serverUrl: `https://catalog-mode-denial-${status}.example.test`,
            accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
        const scope = { serverId, accountId };
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });

        const provider = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_private', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'Private provider', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] });
        const service = { pluginId: 'custom.catalog-admission', localId: 'service' };
        const configurations = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'configurations', value: { v: 1,
            entries: [{ service, modeId: 'api', revision: '1', values: { endpoint: 'https://private.example.test' }, secretRefs: {} }] } });
        const purposes = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'purposes', value: { v: 1,
            bindings: [{ purpose: { consumer: service, purpose: 'coding' }, target: { kind: 'account', account: { service, accountId: 'private-account' } } }] } });
        const channel = WebhookNotificationChannelRecordV1Schema.parse({ v: 1, id: 'private-webhook', kind: 'webhook',
            url: 'https://private.example.test/hook', topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1, signingSecretRef: null });
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 3, catalog: provider }, true);
        applyConnectedAccountCatalogSnapshot(scope, 'configurations', { status: 'ready', revision: 3, record: configurations }, true);
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 3, record: purposes }, true);
        applyNotificationChannelCatalogSnapshot(scope, { catalog: { status: 'ready', revision: 3, channels: [channel] }, rawSettings: {}, sourceSettingsVersion: 0 }, true);
        applyConnectedMetadataCatalogSnapshot(scope, {
            presentation: { status: 'ready', revision: 3, entries: [{ v: 1, subject: { kind: 'account', account: { service, accountId: 'private-account' } }, label: 'Private label' }], diagnostics: [] },
            acknowledgements: { status: 'ready', revision: 3, entries: [{ v: 1, subject: { kind: 'warning', warningId: 'private-warning', scope: { kind: 'account' } }, acknowledged: true }], diagnostics: [] }, disclosure: [],
        }, true);
        const readPrivateData = () => ({ provider: getProviderCatalogSnapshot(scope)?.data,
            configurations: getConnectedAccountCatalogValue(scope, 'configurations').value,
            purposes: getConnectedAccountCatalogValue(scope, 'purposes').value,
            channels: getNotificationChannelCatalogValue(scope).channels,
            labels: getConnectedMetadataCatalog(scope).labelsByKey,
            acknowledgements: getConnectedMetadataCatalog(scope).acknowledgementsByKey });
        const healthy = readPrivateData();
        expect(healthy.channels).toHaveLength(1);
        expect(Object.values(healthy.labels)).toEqual(['Private label']);
        const refresh = async () => {
            applyProviderCatalogSnapshot(scope, await readProviderCatalog(scope), true);
            applyConnectedAccountCatalogSnapshot(scope, 'configurations', await readConnectedAccountCatalog(scope, 'configurations'), true);
            applyConnectedAccountCatalogSnapshot(scope, 'purposes', await readConnectedAccountCatalog(scope, 'purposes'), true);
            applyNotificationChannelCatalogSnapshot(scope, await readNotificationChannelCatalogProjection(scope), true);
            applyConnectedMetadataCatalogSnapshot(scope, await readConnectedMetadataCatalogProjection(scope), true);
        };
        home.answer(serverId, 'GET /v1/account/encryption', { select: () => { throw new TypeError('Network request failed'); } });
        await refresh();
        expect(readPrivateData()).toEqual(healthy);

        home.answer(serverId, 'GET /v1/account/encryption', { status, body: { error } });
        await refresh();
        expect(getProviderCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'unavailable', reason });
        expect(getConnectedAccountCatalogValue(scope, 'configurations')).toMatchObject({ status: 'unavailable', reason });
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'unavailable', reason });
        expect(getNotificationChannelCatalogValue(scope)).toMatchObject({ status: 'unavailable', reason });
        expect(getConnectedMetadataCatalog(scope)).toMatchObject({ presentation: { status: 'unavailable', reason }, acknowledgements: { status: 'unavailable', reason } });
        expect(readPrivateData()).toEqual({ provider: null, configurations: null, purposes: null, channels: [], labels: {}, acknowledgements: {} });
        expect(home.requests.filter(request => request.path.includes('/entity-rows/'))).toEqual([]);
    });
});

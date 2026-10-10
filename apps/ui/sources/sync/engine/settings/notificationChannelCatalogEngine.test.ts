import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { NotificationChannelCatalogRecordV1Schema, NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { AccountEncryptionCurrentnessErrorResponse } from '@happier-dev/protocol/account/encryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Install genuine network/native boundaries before evaluating the shared store/Action graph.
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
await import('@/sync/ops/actions/defaultActionExecutor');
const { observeNotificationChannelCatalog, refreshNotificationChannelCatalog,
    resetNotificationChannelCatalogEngineForTests } = await import('./notificationChannelCatalogEngine');
const { getNotificationChannelCatalogValue,
    resetNotificationChannelCatalogSnapshotsForTests } = await import('@/sync/store/settings/notificationChannelCatalogSnapshot');

const accountId = 'notification-catalog-currentness-owner';
const serverUrl = 'https://notification-catalog-currentness.example.test';
let releaseObserver: (() => void) | null = null;

beforeEach(async () => {
    await home.reset();
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
    resetNotificationChannelCatalogEngineForTests();
    resetNotificationChannelCatalogSnapshotsForTests();
});
afterEach(async () => {
    releaseObserver?.();
    releaseObserver = null;
    resetNotificationChannelCatalogEngineForTests();
    resetNotificationChannelCatalogSnapshotsForTests();
    await home.reset();
    resetRuntimeFetch();
});

async function observeHealthyCatalog() {
    const serverId = await home.addHome({ name: 'Notification catalog currentness', serverUrl,
        accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
    const scope = { serverId, accountId };
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
        v: 1, id: 'healthy-webhook', kind: 'webhook', url: 'https://healthy.example.test/hook', enabled: true,
        topics: {}, readyIncludeMessageText: false, requestIncludeMessageText: true, signingSecretRef: null,
    }] });
    home.answer(serverId, 'GET /v1/account/encryption/currentness', {
        body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }),
    });
    home.answer(serverId, 'GET /v2/account/settings', { body: { version: 7, content: { t: 'plain', v: {} } } });
    home.answer(serverId, 'GET /v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, `GET ${NOTIFICATION_CHANNELS_ROUTE_V1}`, {
        body: { status: 'present', revision: 3, content: { t: 'plain', v: record } },
    });
    releaseObserver = observeNotificationChannelCatalog(scope);
    await refreshNotificationChannelCatalog(scope);
    const healthy = getNotificationChannelCatalogValue(scope);
    expect(healthy).toMatchObject({ status: 'ready', revision: 3, stale: false });
    expect(healthy.channels).toEqual(record.channels);
    return { scope, healthy };
}

const materialDenial = {
    error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_inconsistent' },
} satisfies AccountEncryptionCurrentnessErrorResponse;
const denials: readonly Readonly<{ reason: string; answer: HomeDomainAnswer }>[] = [
    { reason: 'unauthorized', answer: { status: 401, body: { error: 'denied' } } },
    { reason: 'forbidden', answer: { status: 403, body: { error: 'denied' } } },
    { reason: 'encryption-material-unavailable', answer: { status: 400, body: materialDenial } },
];

describe('notification catalog loader currentness fidelity', () => {
    it.each(denials)('retains same-Home offline continuity but withdraws after $reason', async ({ reason, answer }) => {
        const { scope, healthy } = await observeHealthyCatalog();
        home.answer(scope.serverId, 'GET /v1/account/encryption/currentness', {
            select: () => { throw new TypeError('Network request failed'); },
        });
        await refreshNotificationChannelCatalog(scope);
        const offline = getNotificationChannelCatalogValue(scope);
        expect(offline).toMatchObject({ status: 'unavailable', reason: 'unreachable', stale: true, revision: 3 });
        expect(offline.channels).toBe(healthy.channels);

        home.answer(scope.serverId, 'GET /v1/account/encryption/currentness', answer);
        await refreshNotificationChannelCatalog(scope);
        expect(getNotificationChannelCatalogValue(scope)).toMatchObject({ status: 'unavailable', reason, stale: true, channels: [] });

        home.answer(scope.serverId, 'GET /v1/account/encryption/currentness', {
            body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }),
        });
        await refreshNotificationChannelCatalog(scope);
        expect(getNotificationChannelCatalogValue(scope)).toMatchObject({ status: 'ready', stale: false, channels: healthy.channels });
    });

    it.each([true, false])('withdraws removed Home credentials with observer attached=%s', async observed => {
        const { scope } = await observeHealthyCatalog();
        const boundaryHome = home.findByServerUrl(serverUrl);
        if (!boundaryHome?.token) throw new Error('Expected this Home device-credential boundary');
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: scope.serverId }, { token: boundaryHome.token })).toBe(true);
        await refreshNotificationChannelCatalog(scope);
        if (!observed) {
            releaseObserver?.();
            releaseObserver = null;
        }
        // The harness owns native credential reads; change that boundary's answer
        // before removing the actual stored credential through its canonical writer.
        boundaryHome.token = null;
        expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId: scope.serverId })).toBe(true);
        if (!observed) releaseObserver = observeNotificationChannelCatalog(scope);
        await refreshNotificationChannelCatalog(scope);
        expect(getNotificationChannelCatalogValue(scope).channels).toEqual([]);
        expect(getNotificationChannelCatalogValue(scope)).toMatchObject({ status: 'unavailable', reason: 'unauthorized', stale: true });
    });
});

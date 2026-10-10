import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveAccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { NotificationChannelCatalogMutationV1Schema, NotificationChannelCatalogRecordV1Schema,
    NOTIFICATION_CHANNELS_ROUTE_V1, type NotificationChannelCatalogRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { PushTokensRemoteAlertProjectionV2Schema } from '@happier-dev/protocol/push/pushTokenRegistration';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

type CatalogFixture = Readonly<{ status: 'present'; record: NotificationChannelCatalogRecordV1 }>
    | Readonly<{ status: 'deleted' | 'absent' }>;

/** Metro's deferred require consumes this same real Vitest executor namespace. */
export async function loadNotificationsSettingsActionExecutorForTests() {
    const { loadVitestModuleForNodeRequire } = await import('@/dev/vitestRnShim');
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');
    return loadVitestModuleForNodeRequire(new NodeURL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
        () => import('@/sync/ops/actions/defaultActionExecutor'));
}

/** Shared network/native fixture; Settings, Sync, catalog and Action owners remain real. */
export async function restoreNotificationsSettingsCatalog(params: Readonly<{
    accountId: string; serverUrl: string; homeName?: string;
    rawSettings: Readonly<Record<string, unknown>>;
    localSettings?: Readonly<Record<string, unknown>>;
    catalog: CatalogFixture;
    features?: ReturnType<typeof createRootLayoutFeaturesResponse>;
}>) {
    let raw = { ...params.rawSettings };
    let record = NotificationChannelCatalogRecordV1Schema.parse(params.catalog.status === 'present' ? params.catalog.record : { v: 1, channels: [] });
    let authority: 'present' | 'deleted' | 'absent' = params.catalog.status;
    let revision = 3;
    let settingsVersion = 7;
    let catalogRefusal: 'conflict' | 'settings-conflict' | null = null;
    const pairedWrites: unknown[] = [];
    const settingsWrites: unknown[] = [];
    const requests: Readonly<{ path: string; method: string }>[] = [];
    const features = params.features ?? createRootLayoutFeaturesResponse();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => params.accountId, encryptionMode: 'plain' });
    const accountBearer = `Bearer e30.${Buffer.from(JSON.stringify({ sub: params.accountId })).toString('base64url')}.signature`;
    if (params.homeName) {
        // Upsert preserves an existing user label: establish it before the
        // canonical connection fixture creates its default Test Home.
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        await upsertServerProfileOnly({ serverUrl: params.serverUrl, name: params.homeName });
    }
    const home = await restoreServerAccountForTest({
        serverUrl: params.serverUrl, accountId: params.accountId,
        credentialScope: 'restored-home',
        request: async (url, init) => {
            const requestUrl = new URL(String(url));
            const path = requestUrl.pathname;
            const method = init?.method ?? 'GET';
            requests.push({ path, method });
            // An old captured transport must not see the next Account's fixture.
            // Compare the opaque credential issued by the canonical restoration
            // helper; no consumer-side JWT identity parser is introduced.
            if ((path.startsWith('/v1/account/') || path.startsWith('/v2/account/')
                || path === '/v1/artifacts' || path.startsWith('/v1/artifacts/') || path === '/v1/push-tokens')
                && new Headers(init?.headers).get('authorization') !== accountBearer)
                return Response.json({ error: 'unauthorized' }, { status: 401 });
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
            const artifactResponse = artifacts.handle(`${path}${requestUrl.search}`, init);
            if (artifactResponse) return artifactResponse;
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            if (path === '/v1/push-tokens') return Response.json(PushTokensRemoteAlertProjectionV2Schema.parse({
                v: 2, accountRemoteAlerts: { status: 'current', settingsVersion }, tokens: [],
            }));
            if (path === '/v2/account/settings' && method === 'POST') {
                const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init?.body)));
                settingsWrites.push(mutation);
                if (mutation.expectedVersion !== settingsVersion) return Response.json({ success: false, error: 'version-mismatch',
                    currentVersion: settingsVersion, currentContent: { t: 'plain', v: raw } });
                if (mutation.content?.t === 'encrypted') throw new Error('This Plain Account has no Account encryption key');
                raw = { ...(mutation.content?.v ?? {}) }; settingsVersion += 1;
                return Response.json({ success: true, version: settingsVersion });
            }
            if (path === '/v2/account/settings') return Response.json({ version: settingsVersion, content: { t: 'plain', v: raw } });
            if (path === NOTIFICATION_CHANNELS_ROUTE_V1 && method === 'POST') {
                const mutation = NotificationChannelCatalogMutationV1Schema.parse(JSON.parse(String(init?.body)));
                if (mutation.expectedRevision !== (authority === 'absent' ? 'absent' : revision) || catalogRefusal === 'conflict')
                    return Response.json({ status: 'conflict', revision });
                const paired = mutation.settingsMutation;
                if (paired && (paired.expectedSettingsVersion !== settingsVersion || catalogRefusal === 'settings-conflict'))
                    return Response.json({ status: 'settings-conflict', revision });
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain notification catalog');
                if (paired?.content?.t === 'encrypted') throw new Error('This Plain Account has no Account encryption key');
                if (paired) {
                    const nextRaw = paired.content?.v ?? {};
                    if (!sameStrictJsonValue(paired.remoteAlertPolicy, deriveAccountRemoteAlertPolicyV1(nextRaw)))
                        throw new Error('Paired Settings remote-alert projection must match its admitted raw source');
                    pairedWrites.push(paired); raw = { ...nextRaw }; settingsVersion += 1;
                }
                record = mutation.content.v; authority = 'present'; revision += 1;
                return Response.json({ status: 'updated', revision, cursor: revision, ...(paired ? { settingsVersion } : {}) });
            }
            if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json(authority === 'present'
                ? { status: 'present', revision, content: { t: 'plain', v: record } }
                : authority === 'deleted' ? { status: 'deleted', revision } : { status: 'absent' });
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    const scope = { serverId: home.home.id, accountId: params.accountId };
    // Successive fixtures deliberately change one Home's advertised features.
    // Establish that HTTP response through the real cache owner before render.
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const featureSnapshot = await getServerFeaturesSnapshot({ serverId: scope.serverId, force: true });
    if (featureSnapshot.status !== 'ready') throw new Error('Test Home feature publication did not become ready');
    const { storage } = await import('@/sync/domains/state/storage');
    await storage.getState().activateSettingsScope(scope);
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.getState().applySettings(settingsParse(raw), settingsVersion);
    if (params.localSettings) {
        const { localSettingsParse } = await import('@/sync/domains/settings/localSettings');
        storage.getState().applyLocalSettings(localSettingsParse(params.localSettings));
    }
    return { scope, storage, policy: accountSettingsParse(raw).attentionDeliveryPolicyV1, pairedWrites, settingsWrites, requests, artifacts,
        readRecord: () => record, readRaw: () => raw,
        refuseCatalogWrites: (reason: typeof catalogRefusal) => { catalogRefusal = reason; },
        dispose: home.dispose };
}

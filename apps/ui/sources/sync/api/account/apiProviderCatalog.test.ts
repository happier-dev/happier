import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { useProviderSettings } from '@/providers/hooks/useProviderSettings';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from './apiAccountEncryptionMode';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema, sealProviderConnectionsContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ProviderConnectionImportIntentV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { readProviderCatalog, readProviderCatalogInContext, writeProviderCatalog, writeProviderCatalogInContext } from './apiProviderCatalog';
import { applyProviderCatalogSnapshot, getProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { refreshProviderCatalog, resetProviderCatalogEngineForTests } from '@/sync/engine/settings/providerCatalogEngine';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    standardCleanup();
    resetProviderCatalogEngineForTests();
    resetProviderCatalogSnapshotsForTests();
    await disconnectActiveServerConnection();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});
describe('Provider catalog captured Account HTTP', () => {
    it('consumes an explicit connection import through the same captured row HTTP owner without writing a Settings mirror', async () => {
        const accountId = 'account-provider-explicit-import';
        const candidate = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_import', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'Imported connection', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        }).connections[0]!;
        let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
        let revision = 1;
        let rowWrites = 0;
        let settingsWrites = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') settingsWrites += 1;
                return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(mutation.expectedRevision).toBe(revision);
                    expect(mutation.referencedSavedSecretIds).toEqual([]);
                    expect(mutation.savedSecretRevisions).toEqual([]);
                    expect(mutation.content?.t).toBe('plain');
                    if (mutation.content?.t === 'plain') catalog = mutation.content.v;
                    rowWrites += 1;
                    revision += 1;
                    return Response.json({ status: 'updated', revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: 'https://provider-explicit-import.example.test', name: 'Provider explicit import' });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const scope = { serverId: context.serverId, accountId: context.accountId };
            const importConnection: ProviderConnectionImportIntentV1 = { candidate: { connection: candidate },
                isCurrent: context.accountLifetime.isCurrent,
                commitCatalog: async input => {
                    const receipt = await writeProviderCatalogInContext(context, input);
                    return receipt.status === 'updated' ? { status: 'applied' } : { status: 'refused', reason: receipt.status };
                },
            };
            // The same scoped snapshot publication used by mounted readers must receive
            // the opened winner, not only the pre-import destination row.
            const publication = { importConnection, onCryptoAdmission: () => {},
                onReady: (snapshot: Parameters<typeof applyProviderCatalogSnapshot>[1], isCurrent: () => boolean) =>
                    applyProviderCatalogSnapshot(scope, snapshot, isCurrent()),
            };
            const result = await readProviderCatalogInContext(context, undefined, publication);
            expect(catalog.connections).toEqual([candidate]);
            expect(result).toMatchObject({ status: 'applied', connectionId: candidate.id,
                catalog: { status: 'ready', revision: 2, catalog: { connections: [candidate], accountGrants: [] } } });
            expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'ready', revision: 2,
                data: { connections: [candidate], accountGrants: [] } });
            expect(rowWrites).toBe(1);
            expect(settingsWrites).toBe(0);
        } finally { context.dispose(); }
    });
    it('does not redisclose an opened E2EE catalog to a returning Provider reader after material loss, but preserves ordinary refresh continuity', async () => {
        const accountId = 'account-provider-key-withdrawal';
        const secret = new Uint8Array(32).fill(11);
        const material = { type: 'legacy' as const, secret };
        const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint,
        );
        const cipher = await Encryption.create(secret);
        const settingsContent = { t: 'encrypted', c: await cipher.encryptRaw({}) };
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_private', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'Encrypted Account provider', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const rowContent = sealProviderConnectionsContentV1({ mode: 'e2ee', material,
            catalog, randomBytes: length => new Uint8Array(length).fill(7) });
        let rowReads = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json({
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint', contentKeyFingerprint: fingerprint,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
            });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: settingsContent });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                expect(init?.method).not.toBe('POST');
                rowReads += 1;
                return Response.json({ status: 'present', revision: 1, content: rowContent });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: 'https://provider-key-withdrawal.example.test', name: 'Provider key withdrawal' });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, secret: encodeBase64(secret, 'base64url') };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        const scope = { serverId: home.id, accountId };
        await refreshProviderCatalog(scope);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'ready', revision: 1, data: catalog });
        let admittedReads = rowReads;
        // The incumbent mode cache also invalidates on ordinary preference/self-change refresh.
        invalidateAccountEncryptionModeCache();
        expect(getProviderCatalogSnapshot(scope)?.data).not.toBeNull();
        const beforeWithdrawal = await renderHook(() => useProviderSettings(scope));
        expect(beforeWithdrawal.getCurrent().connections).toEqual(catalog.connections);
        await beforeWithdrawal.unmount();
        expect(rowReads).toBe(admittedReads);
        // Equal Account ids on another Home do not grant or withdraw this Home's keys.
        const otherHome = await upsertServerProfile({ serverUrl: 'https://provider-other-key.example.test', name: 'Other Provider keys' });
        await TokenStorage.setCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id }, { token });
        expect(getProviderCatalogSnapshot(scope)?.data?.connections).toEqual(catalog.connections);
        expect(rowReads).toBe(admittedReads);
        const alternateCredentials = { token, secret: encodeBase64(new Uint8Array(32).fill(22), 'base64url') };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, alternateCredentials);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ stale: true, data: null });
        expect(rowReads).toBe(admittedReads);
        // Only a fresh admitted read with the original key can disclose that row again.
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        const restoredReader = await renderHook(() => useProviderSettings(scope));
        await act(async () => { await refreshProviderCatalog(scope); });
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'ready', data: catalog });
        expect(restoredReader.getCurrent().connections).toEqual(catalog.connections);
        await restoredReader.unmount();
        admittedReads = rowReads;
        // Same Account, same persisted E2EE mode, but device credentials no longer hold its key.
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token });
        // A returning screen reads the admitted snapshot during render, before its observation
        // effect can revalidate it. That first display must not borrow the withdrawn E2EE key.
        let initialConnectionIds: readonly string[] | undefined;
        const returningReader = await renderHook(() => {
            const settings = useProviderSettings(scope);
            initialConnectionIds ??= settings.connections.map(connection => connection.id);
            return settings;
        });
        expect(initialConnectionIds).toEqual([]);
        expect(returningReader.getCurrent().connections).toEqual([]);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ stale: true, data: null });
        expect(rowReads).toBe(admittedReads);
        await returningReader.unmount();
    });
    it('withdraws Provider authority when the row HTTP boundary rejects Account authorization', async () => {
        const accountId = 'account-provider-unauthorized';
        let denied = false;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                expect(init?.method).not.toBe('POST');
                return denied ? Response.json({ error: 'unauthorized' }, { status: 401 })
                    : Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: 'https://provider-unauthorized.example.test', name: 'Provider unauthorized' });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        const scope = { serverId: home.id, accountId };
        getStorage().setState({ profileScope: scope, settingsScope: scope });
        expect(await readProviderCatalog(scope)).toMatchObject({ status: 'ready', revision: 1 });
        denied = true;
        expect(await readProviderCatalog(scope)).toMatchObject({ status: 'unavailable', reason: 'unauthorized' });
    });
    it('initializes a keyless secret-free row independently of unrelated import maintenance and never replays an ambiguous write', async () => {
        const accountId = 'account-provider-row';
        let revision = 0;
        let absent = true;
        let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
        let settingsWrites = 0;
        let unknownOutcome = false;
        let rowWrites = 0;
        let readStatus = 200;
        // HTTP alone is substituted; Account admission, keys, lifetime and snapshot lifecycle stay real.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') settingsWrites += 1;
                return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    rowWrites += 1;
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    if (mutation.expectedRevision !== (absent ? 'absent' : revision)) return Response.json({ status: 'conflict', revision });
                    expect(mutation.content?.t).toBe('plain');
                    if (mutation.content?.t === 'plain') catalog = mutation.content.v;
                    revision += 1;
                    absent = false;
                    if (unknownOutcome) throw new TypeError('network disconnected after commit');
                    return Response.json({ status: 'updated', revision, cursor: revision });
                }
                if (readStatus !== 200) return Response.json({ error: 'unauthorized' }, { status: readStatus });
                if (absent) return Response.json({ status: 'absent' });
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const home = await upsertAndActivateServer({ serverUrl: 'https://provider-row-home.example.test', name: 'Provider row' });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        const scope = { serverId: home.id, accountId };
        getStorage().setState({ profileScope: scope, settingsScope: scope });
        await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(7));
        expect(await readProviderCatalog(scope)).toMatchObject({ status: 'ready', revision: 1 });
        expect(await writeProviderCatalog(scope, { catalog, expectedRevision: 1 })).toMatchObject({ status: 'updated', revision: 2 });
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'ready', revision: 2 });
        expect(getStorage().getState().settingsVersion).toBe(7);
        expect(settingsWrites).toBe(0);
        unknownOutcome = true;
        await expect(writeProviderCatalog(scope, { catalog, expectedRevision: 2 })).rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(rowWrites).toBe(3);
        expect(await readProviderCatalog(scope)).toMatchObject({ status: 'ready', revision: 3 });
        readStatus = 401;
        expect(await readProviderCatalog(scope)).toMatchObject({ status: 'unavailable', reason: 'unauthorized' });
    });
});

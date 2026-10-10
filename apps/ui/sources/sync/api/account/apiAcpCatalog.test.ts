import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, ACP_CATALOG_ACCOUNT_ROW_KEY_V1, AcpCatalogRowMutationV1Schema, sealAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeferred } from '@/dev/testkit';
import { readAcpCatalog, writeAcpCatalogRecord, updateAcpCatalogInContext } from './apiAcpCatalog';
import { refreshAcpCatalog, observeAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveVoiceConfiguredAgentTarget } from '@/voice/agent/resolveVoiceConfiguredAgentTarget';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createVoiceAgentSettingsCatalogReader } from '@/sync/ops/actions/voiceAgentSettingsCatalog';
import { createScmDiffSummarySettingsCatalogReader } from '@/sync/ops/actions/scmDiffSummarySettingsCatalog';
import { encodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import sodium from '@/encryption/libsodium.lib';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let scope: { serverId: string; accountId: string };
let raw: Record<string, unknown>;
const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review', command: 'review',
    createdAt: 1, updatedAt: 1 });
let row: unknown;
const credentialsFor = (name: string): AuthCredentials => ({ token: `e30.${Buffer.from(JSON.stringify({ sub: `account-${name}` })).toString('base64url')}.signature` });
async function activateHome(name: string) {
    await disconnectActiveServerConnection();
    const profile = await upsertAndActivateServer({ serverUrl: `https://acp-home-${name}.example.test`, name });
    const credentials = credentialsFor(name);
    await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    const next = { serverId: profile.id, accountId: `account-${name}` };
    getStorage().setState({ profileScope: next, settingsScope: next });
    return next;
}
beforeEach(async () => {
    raw = {};
    row = { status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: [definition] } } };
    setRuntimeFetch(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: raw } });
        if (path === '/v1/artifacts') return Response.json([]);
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(row);
        return new Response(null, { status: 404 });
    });
    scope = await activateHome('a');
});
afterEach(async () => {
    await standardCleanup();
    resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests();
    await disconnectActiveServerConnection(); retireActiveServerAccountScopeLifetime(); resetRuntimeFetch();
});
describe('ACP captured Account row snapshots', () => {
    it.each(['empty', 'personal-source', 'e2ee-unrelated-settings', 'data-key-unrelated-settings'] as const)('publishes the actual mounted catalog outcome for an absent row without activating source data (%s)', async (source) => {
        row = { status: 'absent' };
        raw = source === 'empty' ? {} : source === 'personal-source' ? {
            acpCatalogSettingsV1: { v: 2, backends: [{ ...definition, id: 'kiro', name: 'kiro',
                command: 'kiro-cli', args: ['acp'], transportProfile: 'kiro',
                env: { TOKEN: { t: 'savedSecret', secretId: 'old-token' } } }] },
            secrets: [{ id: 'old-token', name: 'Existing token', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'old-token' }, createdAt: 1, updatedAt: 1 }],
        } : { profiles: [], secrets: [], themePreference: 'dark', neighboringUnknown: { preserve: true } };
        const retained = raw;
        const dataKey = source === 'data-key-unrelated-settings';
        const encrypted = source === 'e2ee-unrelated-settings' || dataKey;
        const contentKeyPair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(17));
        const material = dataKey
            ? { type: 'dataKey' as const, machineKey: contentKeyPair.privateKey }
            : { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
        const settingsVersion = dataKey ? 402 : 4;
        const fingerprint = encrypted ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
                ...(dataKey ? { dataKeyPublicKey: contentKeyPair.publicKey } : {}),
            }).contentPublicKeyFingerprint) : null;
        // Both canonical credential modes open unrelated retained roots through the tagged Settings envelope.
        const storedSettings = encrypted ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
            kind: 'account_settings', material, payload: raw, randomBytes: length => new Uint8Array(length).fill(11),
        }) } : { t: 'plain' as const, v: raw };
        const mutations: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            // Other sync domains use POST for reads; count the actual ACP/source activation boundaries.
            if (init?.method === 'POST' && (path === ACP_CATALOG_ROWS_ROUTE_V1 || path === '/v2/account/settings'
                || path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']
                || path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'])) mutations.push(path);
            if (path === '/v1/account/encryption/currentness') return Response.json(encrypted
                ? { ...createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }), mode: 'e2ee',
                    contentKeyFingerprint: fingerprint, recipientEnvelopeReadiness: { status: 'available' } }
                : createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: encrypted ? 'e2ee' : 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: settingsVersion, content: storedSettings });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(row);
            if (path === '/v1/artifacts') return Response.json([]);
            return new Response(null, { status: 404 });
        });
        if (encrypted) {
            expect(raw).not.toHaveProperty('acpCatalogSettingsV1');
            await disconnectActiveServerConnection();
            const credentials: AuthCredentials = material.type === 'dataKey'
                ? { ...credentialsFor('a'), encryption: {
                    publicKey: Buffer.from(contentKeyPair.publicKey).toString('base64'),
                    machineKey: Buffer.from(material.machineKey).toString('base64'),
                } }
                : { ...credentialsFor('a'), secret: Buffer.from(material.secret).toString('base64url') };
            await TokenStorage.setCredentialsForServerUrl('https://acp-home-a.example.test', { serverId: scope.serverId }, credentials);
            await restoreConnectionToActiveServer(credentials);
            getStorage().setState({ profileScope: scope, settingsScope: scope });
            if (material.type === 'dataKey') {
                const context = await captureLazyActionAccountContext(scope.serverId);
                try {
                    const resolved = await context.resolveAccountEncryption();
                    expect(resolved.encryption?.getContentPrivateKey()).toEqual(material.machineKey);
                    expect(resolved.encryption?.contentDataKey).toEqual(contentKeyPair.publicKey);
                } finally { context.dispose(); }
            }
        }
        const hook = await renderHook(() => useAcpCatalog(scope));
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toMatchObject(source !== 'personal-source'
            ? { scope, stale: false, catalog: { status: 'ready', revision: 'absent', source: 'fresh', sourceSettingsVersion: settingsVersion,
                record: { v: 1, definitions: [] } } }
            : { scope, stale: true, data: null, catalog: { status: 'unavailable', reason: 'saved-secret-unavailable' } }));
        expect(mutations).toEqual([]);
        expect(raw).toBe(retained);
        expect(row).toEqual({ status: 'absent' });
    });
    it('keeps configured Resume facts on the genuinely captured nonfocused Account scope supplied by the Run caller', async () => {
        const invoked = scope;
        scope = await activateHome('b');
        await refreshAcpCatalog(invoked);
        const options = { agentId: 'row-review', machineId: null, serverId: invoked.serverId,
            accountScope: invoked, settings: getStorage().getState().settings, enabled: false };
        const hook = await renderHook(() => useResumeCapabilityOptions(options));
        expect(hook.getCurrent().resumeCapabilityOptions.acpCatalogSnapshot).toMatchObject({ status: 'ready', revision: 3,
            record: { definitions: [expect.objectContaining({ id: 'row-review' })] } });
    });
    it.each(['record', 'action', 'foreign-source'] as const)('promotes the captured personal bindings before atomically transferring the original ACP row and cleanup, then its numeric user delta (%s)', async (entry) => {
        const source = { ...definition, id: 'kiro', name: 'kiro', title: 'Source Kiro', command: 'kiro-cli', args: ['acp'],
            transportProfile: 'kiro', env: { TOKEN: { t: 'savedSecret' as const, secretId: 'old-token' } } };
        raw = { acpCatalogSettingsV1: { v: 2, backends: [source] }, neighboringUnknown: { preserve: true },
            secrets: [{ id: 'old-token', name: 'Existing token', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'old-token' }, createdAt: 1, updatedAt: 1 }] };
        row = { status: 'absent' };
        let settingsVersion = 4;
        let profileGuardRevision = 3;
        let sourceReads = 0;
        const promotions: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
        const deltas: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>[] = [];
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                expect(init?.method).not.toBe('POST');
                if (++sourceReads === 2 && entry === 'foreign-source') {
                    raw = { ...raw, acpCatalogSettingsV1: { v: 2, backends: [{ ...source, command: 'foreign-command' }] } };
                    settingsVersion += 1;
                }
                return Response.json({ version: settingsVersion, content: { t: 'plain', v: raw } });
            }
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: profileGuardRevision, transferControl: { status: 'absent' }, diagnostics: [] });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: profileGuardRevision });
            if (path === PROFILE_TRANSFER_ROUTE_V1 || path === REMOTE_HOST_ROWS_ROUTE_V1 || path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: promotions.map(input => ({
                resourceId: input.resourceId, encryptionMode: 'plain', recipientEnvelope: null, storedContent: input.storedContent,
                entry: { ref: formatSharedSavedSecretRefV1(input.resourceId), source: 'shared_resource', relationship: 'owner',
                    name: input.displayName, kind: input.kind, revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            })) });
            if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                const input = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init?.body)));
                promotions.push(input);
                expect(input.catalogMutations?.acp).toBeUndefined();
                expect(input.expectedSettingsVersion).toBe(4);
                expect(input.storedContent).toMatchObject({ t: 'plain', v: { value: 'old-token' } });
                expect(input.nextSettings).toMatchObject({ t: 'plain', v: { neighboringUnknown: { preserve: true } } });
                if (input.nextSettings?.t !== 'plain') throw new Error('Expected Plain source transaction');
                expect(input.nextSettings.v).toMatchObject({ acpCatalogSettingsV1: { v: 2, backends: [
                    expect.objectContaining({ title: 'Source Kiro', env: { TOKEN: { t: 'savedSecret',
                        secretId: formatSharedSavedSecretRefV1(input.resourceId) } } }),
                ] } });
                raw = input.nextSettings.v;
                settingsVersion += 1;
                profileGuardRevision += 1;
                return Response.json({ resourceId: input.resourceId, settingsVersion });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    expect(promotions).toHaveLength(1);
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    deltas.push(mutation);
                    if (mutation.expectedRevision === 'absent') {
                        expect(mutation).toMatchObject({ source: 'predecessor', sourceSettingsVersion: 5,
                            content: { t: 'plain', v: { definitions: [{ title: 'Source Kiro', runtime: { stderrRules: KIRO_ACP_STDERR_RULES },
                                env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1(promotions[0]!.resourceId) } } }] } },
                            settingsCleanup: { expectedSettingsVersion: 5 } });
                        if (mutation.settingsCleanup?.nextSettings.t !== 'plain') throw new Error('Expected atomic Plain ACP cleanup');
                        expect(mutation.settingsCleanup.nextSettings.v).not.toHaveProperty('acpCatalogSettingsV1');
                        raw = mutation.settingsCleanup.nextSettings.v;
                        settingsVersion += 1;
                    } else {
                        expect(mutation.expectedRevision).toBe(0);
                        expect(mutation).not.toHaveProperty('settingsCleanup');
                    }
                    const revision = deltas.length - 1;
                    row = { status: 'present', revision, content: mutation.content };
                    return Response.json({ status: 'updated', revision, cursor: deltas.length });
                }
                return Response.json(row);
            }
            if (['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/provider-connections',
                '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes'].includes(path)) {
                return Response.json({ status: 'absent' });
            }
            return new Response(null, { status: 404 });
        });
        const { transportProfile: _sourceTransport, ...candidate } = source;
        const record = { v: 1 as const, definitions: [{ ...candidate, title: 'User delta', runtime: { stderrRules: KIRO_ACP_STDERR_RULES } }] };
        if (entry === 'record') {
            await expect(writeAcpCatalogRecord(scope, { record, expectedRevision: 'absent' }))
                .rejects.toMatchObject({ code: 'settings-conflict' });
            expect(promotions).toEqual([]);
            expect(deltas).toEqual([]);
        }
        if (entry === 'foreign-source') {
            await expect(writeAcpCatalogRecord(scope, { record, expectedRevision: 'absent', sourceSettingsVersion: 4 }))
                .rejects.toMatchObject({ code: 'settings-conflict' });
            expect(promotions).toEqual([]);
            expect(deltas).toEqual([]);
            expect(row).toEqual({ status: 'absent' });
            expect(raw).toMatchObject({ acpCatalogSettingsV1: { backends: [expect.objectContaining({ command: 'foreign-command' })] },
                secrets: [expect.objectContaining({ id: 'old-token' })] });
            return;
        }
        if (entry === 'action') {
            const context = await captureLazyActionAccountContext(scope.serverId);
            try {
                await expect(updateAcpCatalogInContext(context, { expectedRevision: 'absent', sourceSettingsVersion: 4,
                    mutate: current => {
                        if (!current || typeof current !== 'object') throw new Error('Expected original rebound ACP source');
                        // The real Action callback receives the promoted original definitions, never the user's draft as baseline.
                        expect(Reflect.get(current, 'backends')).toEqual([expect.objectContaining({ title: 'Source Kiro',
                            env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1(promotions[0]!.resourceId) } } })]);
                        return { v: 2, backends: [{ ...candidate, title: 'User delta', runtime: { stderrRules: KIRO_ACP_STDERR_RULES },
                            env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1(promotions[0]!.resourceId) } } }] };
                    } })).resolves.toMatchObject({ revision: 1 });
            } finally { context.dispose(); }
        } else {
            await expect(writeAcpCatalogRecord(scope, { record, expectedRevision: 'absent', sourceSettingsVersion: 4 }))
                .resolves.toMatchObject({ status: 'updated', revision: 1 });
        }
        expect(promotions).toHaveLength(1);
        expect(deltas).toHaveLength(2);
        expect(deltas[1]).toEqual(expect.objectContaining({ expectedRevision: 0, content: { t: 'plain', v: { v: 1,
            definitions: [expect.objectContaining({ title: 'User delta', env: { TOKEN: { t: 'savedSecret',
                secretId: formatSharedSavedSecretRefV1(promotions[0]!.resourceId) } } })] } } }));
        expect(raw).not.toHaveProperty('acpCatalogSettingsV1');
    });
    it('reads Voice Settings choices on the invoked nonfocused Home without borrowing the active Account', async () => {
        const invoked = scope;
        scope = await activateHome('b');
        const account = await captureLazyActionAccountContext(invoked.serverId);
        try {
            expect(account.readLiveSettings()).toBeNull();
            const settings = await account.readSettings();
            expect(await createVoiceAgentSettingsCatalogReader(account)(settings))
                .toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ backendTargetKey: 'backend:row-review:configured:row-review' })]) });
        } finally { account.dispose(); }
    });
    it('transfers the exact complete predecessor before applying the user delta with the returned destination revision', async () => {
        raw = { acpCatalogSettingsV1: { v: 2, backends: [definition] }, neighboringUnknown: { preserve: true } };
        row = { status: 'absent' };
        const mutations: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                expect(init?.method).not.toBe('POST');
                return Response.json({ version: 4, content: { t: 'plain', v: raw } });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    mutations.push(mutation);
                    row = { status: 'present', revision: mutations.length, content: mutation.content };
                    return Response.json({ status: 'updated', revision: mutations.length, cursor: mutations.length });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [{ ...definition, title: 'User edit' }] },
            expectedRevision: 'absent', sourceSettingsVersion: 4 })).resolves.toMatchObject({ status: 'updated', revision: 2 });
        expect(mutations).toHaveLength(2);
        expect(mutations[0]).toMatchObject({ expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 4,
            content: { t: 'plain', v: { definitions: [definition] } }, settingsCleanup: { expectedSettingsVersion: 4,
                nextSettings: { t: 'plain', v: { neighboringUnknown: { preserve: true } } } } });
        expect(mutations[1]).toMatchObject({ expectedRevision: 1, content: { t: 'plain', v: { definitions: [{ title: 'User edit' }] } } });
        expect(mutations[1]).not.toHaveProperty('source');
        expect(mutations[1]).not.toHaveProperty('settingsCleanup');
    });
    it.each(['exact-original', 'user-delta'] as const)('retains the original predecessor ACK when its captured Account retires before the next step (%s)', async (requested) => {
        raw = { acpCatalogSettingsV1: { v: 2, backends: [definition] }, neighboringUnknown: { preserve: true } };
        row = { status: 'absent' };
        let sourceVersion = 4;
        const mutations: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                expect(init?.method).not.toBe('POST');
                return Response.json({ version: sourceVersion, content: { t: 'plain', v: raw } });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    mutations.push(mutation);
                    if (mutation.settingsCleanup?.nextSettings?.t !== 'plain') throw new Error('Expected original-source Plain cleanup');
                    raw = mutation.settingsCleanup.nextSettings.v;
                    sourceVersion += 1;
                    row = { status: 'present', revision: 1, content: mutation.content };
                    // The server committed the original source; retirement must not erase that ACK.
                    retireActiveServerAccountScopeLifetime();
                    return Response.json({ status: 'updated', revision: 1, cursor: 1 });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        const write = writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [requested === 'exact-original'
            ? definition : { ...definition, title: 'Unacknowledged user delta' }] }, expectedRevision: 'absent', sourceSettingsVersion: 4 });
        if (requested === 'exact-original') {
            await expect(write).resolves.toMatchObject({ status: 'updated', revision: 1, cursor: 1,
                cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } });
        } else {
            await expect(write).rejects.toMatchObject({ code: 'scope-retired', cause: { revision: 1, reason: 'scope-retired' } });
        }
        expect(mutations).toHaveLength(1);
        expect(mutations[0]).toMatchObject({ expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 4,
            content: { t: 'plain', v: { definitions: [definition] } } });
        expect(row).toMatchObject({ status: 'present', revision: 1, content: { t: 'plain', v: { definitions: [definition] } } });
        expect(raw).toEqual({ neighboringUnknown: { preserve: true } });
        expect(getAcpCatalogSnapshot(scope)?.catalog).not.toMatchObject({ status: 'ready', revision: 1 });
    });
    it('atomically removes an empty retained source on the first explicit save while preserving neighboring raw Settings', async () => {
        raw = { acpCatalogSettingsV1: { v: 2, backends: [] }, neighboringUnknown: { preserve: true } };
        row = { status: 'absent' };
        const mutations: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                expect(init?.method).not.toBe('POST');
                return Response.json({ version: 4, content: { t: 'plain', v: raw } });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    mutations.push(mutation);
                    row = { status: 'present', revision: 1, content: mutation.content };
                    return Response.json({ status: 'updated', revision: 1, cursor: 1 });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [definition] }, expectedRevision: 'absent', sourceSettingsVersion: 4 }))
            .resolves.toMatchObject({ status: 'updated' });
        expect(mutations).toHaveLength(1);
        expect(mutations[0]?.settingsCleanup).toEqual({ expectedSettingsVersion: 4,
            nextSettings: { t: 'plain', v: { neighboringUnknown: { preserve: true } } } });
        expect(raw).toHaveProperty('acpCatalogSettingsV1');
    });
    it.each([
        { maintenance: 'complete', surface: 'api' },
        { maintenance: 'incomplete', surface: 'api' },
        { maintenance: 'retired', surface: 'api' },
        { maintenance: 'incomplete', surface: 'ui' },
    ] as const)('preserves the acknowledged ACP transfer and reports history maintenance ($maintenance, $surface)', async ({ maintenance, surface }) => {
        raw = { acpCatalogSettingsV1: { v: 2, backends: [] }, neighboringUnknown: { preserve: true } };
        if (surface === 'ui') {
            const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
            const policy = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
                'agents.acp.backends.upsert': ['ui'],
            } });
            raw.actionsSettingsV1 = policy;
            getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: policy } });
        }
        row = { status: 'absent' };
        let sourceVersion = 4;
        let acknowledged = false;
        const recorded = { t: 'plain' as const, v: raw };
        const historyMutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: sourceVersion, content: { t: 'plain', v: raw } });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [{ version: 4,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] });
            if (path === '/v2/account/settings/history/4') return Response.json({ version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: recorded });
            if (path === '/v2/account/settings/history/4/mutate') {
                expect(acknowledged).toBe(true);
                historyMutations.push(AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body))));
                if (maintenance === 'incomplete') return new Response(null, { status: 503 });
                return Response.json({ status: 'applied' });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    row = { status: 'present', revision: 1, content: mutation.content };
                    if (mutation.settingsCleanup?.nextSettings?.t === 'plain') raw = mutation.settingsCleanup.nextSettings.v;
                    sourceVersion += 1;
                    acknowledged = true;
                    if (maintenance === 'retired') retireActiveServerAccountScopeLifetime();
                    return Response.json({ status: 'updated', revision: 1, cursor: 1 });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        const cleanup = maintenance === 'complete' ? { status: 'complete' }
            : { status: 'cleanup-pending', reason: 'history-incomplete' };
        if (surface === 'ui') {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
            await expect(createFrontDoorActionExecute(createDefaultActionExecutor())('agents.acp.backends.upsert', {
                backend: definition, expectedRevision: 'absent', sourceSettingsVersion: 4,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: scope.serverId, expectedAccountId: scope.accountId }))
                .resolves.toMatchObject({ ok: true, result: { backend: { id: definition.id }, cleanup } });
        } else {
            await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [definition] }, expectedRevision: 'absent', sourceSettingsVersion: 4 }))
                .resolves.toMatchObject({ status: 'updated', revision: 1, cleanup });
        }
        expect(historyMutations).toEqual(maintenance === 'retired' ? [] : [expect.objectContaining({ operation: expect.objectContaining({ kind: 'normalize',
            removedRoots: ['acpCatalogSettingsV1'], transferredPrivateCatalogRevisions: { acp: 1 },
            content: { t: 'plain', v: raw } }) })]);
        expect(raw).not.toHaveProperty('acpCatalogSettingsV1');
        expect(row).toMatchObject({ status: 'present', revision: 1 });
    });
    it('retries incomplete retained history through the same owner after a numeric explicit write without rereading to activate a source', async () => {
        raw = { acpCatalogSettingsV1: { v: 2, backends: [] }, neighboringUnknown: { preserve: true } };
        row = { status: 'absent' };
        const recorded = { t: 'plain' as const, v: raw };
        let sourceVersion = 4;
        let writes = 0;
        const historyMutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: sourceVersion }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: sourceVersion, content: { t: 'plain', v: raw } });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [{ version: 4,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] });
            if (path === '/v2/account/settings/history/4') return Response.json({ version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: recorded });
            if (path === '/v2/account/settings/history/4/mutate') {
                historyMutations.push(AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body))));
                return historyMutations.length === 1 ? new Response(null, { status: 503 }) : Response.json({ status: 'applied' });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    writes += 1;
                    if (mutation.settingsCleanup?.nextSettings?.t === 'plain') {
                        raw = mutation.settingsCleanup.nextSettings.v;
                        sourceVersion += 1;
                    }
                    row = { status: 'present', revision: writes, content: mutation.content };
                    return Response.json({ status: 'updated', revision: writes, cursor: writes });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [definition] }, expectedRevision: 'absent', sourceSettingsVersion: 4 }))
            .resolves.toMatchObject({ status: 'updated', revision: 1 });
        expect(historyMutations).toHaveLength(1);
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [{ ...definition, title: 'Explicit retry edit' }] }, expectedRevision: 1 }))
            .resolves.toMatchObject({ status: 'updated', revision: 2, cleanup: { status: 'complete' } });
        expect(historyMutations).toHaveLength(2);
        expect(historyMutations[1]?.operation).toMatchObject({ kind: 'normalize', removedRoots: ['acpCatalogSettingsV1'], transferredPrivateCatalogRevisions: { acp: 2 } });
        expect(writes).toBe(2);
        expect(raw).not.toHaveProperty('acpCatalogSettingsV1');
    });
    it('captures complete shared-resource revision proofs for every active ACP env reference', async () => {
        const ref = formatSharedSavedSecretRefV1('catalog-token');
        const next = { ...definition, env: { TOKEN: { t: 'savedSecret' as const, secretId: ref } } };
        let mutation: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse> | undefined;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                resourceId: 'catalog-token', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Token', kind: 'token', revision: 5,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    row = { status: 'present', revision: 4, content: mutation.content };
                    return Response.json({ status: 'updated', revision: 4, cursor: 4 });
                }
                return Response.json(row);
            }
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [next] }, expectedRevision: 3 }))
            .resolves.toMatchObject({ status: 'updated' });
        expect(mutation).toMatchObject({ referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId: 'catalog-token', expectedRevision: 5 }] });
    });
    it('refuses SCM Settings admission when captured destination inventory is incomplete', async () => {
        row = { status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: [definition, { id: 'broken' }] } } };
        const account = await captureLazyActionAccountContext(scope.serverId);
        try {
            const selected = encodeScmDiffSummaryModelOverride({ backendTargetKey: 'backend:row-review:configured:row-review', modelId: 'default' });
            expect(await createScmDiffSummarySettingsCatalogReader(account)(getStorage().getState().settings, selected)).toBeNull();
        } finally { account.dispose(); }
    });
    it('retires captured Voice Settings choices on catalog-only loading without advancing Settings', async () => {
        await refreshAcpCatalog(scope);
        const account = await captureLazyActionAccountContext(scope.serverId);
        try {
            const settings = getStorage().getState().settings;
            const catalog = await createVoiceAgentSettingsCatalogReader(account)(settings);
            expect(catalog?.isCurrent(settings)).toBe(true);
            const pending = createDeferred<Response>();
            const requested = createDeferred<void>();
            setRuntimeFetch(async url => {
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) { requested.resolve(); return pending.promise; }
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                return new Response(null, { status: 404 });
            });
            const refreshing = refreshAcpCatalog(scope);
            await requested.promise;
            expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('loading');
            expect(catalog?.isCurrent(settings)).toBe(false);
            pending.resolve(Response.json(row));
            await refreshing;
            expect(getStorage().getState().settings).toBe(settings);
        } finally { account.dispose(); }
    });
    it('refuses a direct numeric-CAS write against incomplete destination inventory before issuing a mutation', async () => {
        let posts = 0;
        const retained = { v: 1, definitions: [definition, { id: 'unknown-neighbor', env: { TOKEN: { t: 'savedSecret', secretId: 'hidden-reference' } } }] };
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') { posts += 1; return Response.json({ status: 'updated', revision: 4, cursor: 4 }); }
                return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: retained } });
            }
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [definition] }, expectedRevision: 3 }))
            .rejects.toMatchObject({ code: 'incomplete-inventory' });
        expect(posts).toBe(0);
        expect(retained.definitions).toHaveLength(2);
    });
    it('admits Voice Settings configured choices from captured destination rows and refuses incomplete facts', async () => {
        const account = await captureLazyActionAccountContext(scope.serverId);
        try {
            const settings = getStorage().getState().settings;
            const reader = createVoiceAgentSettingsCatalogReader(account);
            expect((await reader(settings))?.entries).toContainEqual(expect.objectContaining({
                backendTargetKey: 'backend:row-review:configured:row-review', title: 'Row review',
            }));
            row = { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, definitions: [definition, { id: 'broken' }] } } };
            expect(await reader(settings)).toBeNull();
        } finally { account.dispose(); }
    });
    it('retires a captured Voice Settings catalog when the Account disables its selected Agent', async () => {
        const account = await captureLazyActionAccountContext(scope.serverId);
        try {
            const current = getStorage().getState().settings;
            const settings = { ...current, voice: { ...current.voice,
                executionMachine: { ...current.voice.executionMachine, mode: 'fixed' as const, machineId: null },
            } };
            const catalog = await createVoiceAgentSettingsCatalogReader(account)(settings);
            const selected = catalog?.entries.find(entry => entry.isBuiltIn && entry.backendTargetKey !== null);
            if (!catalog || !selected?.backendTargetKey) throw new Error('Expected the real built-in catalog');
            expect(catalog.isCurrent(settings)).toBe(true);
            expect(catalog.isCurrent({ ...settings, backendEnabledByTargetKey: {
                ...settings.backendEnabledByTargetKey, [selected.backendTargetKey]: false,
            } })).toBe(false);
        } finally { account.dispose(); }
    });
    it('resolves exact Voice start targets from destination rows without the raw Settings root', async () => {
        const resumable = { ...definition, capabilities: { ...definition.capabilities, supportsLoadSession: true } };
        row = { status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: [resumable] } } };
        await refreshAcpCatalog(scope);
        expect(await resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
            agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
        } })).toMatchObject({ ok: true, kind: 'catalog', backendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' } });
    });
    it('requires destination row facts for configured resume rather than raw Settings', async () => {
        row = { status: 'present', revision: 3, content: { t: 'plain', v: { v: 1,
            definitions: [{ ...definition, capabilities: { ...definition.capabilities, supportsLoadSession: true } }] } } };
        await refreshAcpCatalog(scope);
        const options = { accountSettings: {}, acpCatalogSnapshot: getAcpCatalogSnapshot(scope)!.catalog };
        expect(canAgentResume('acp:row-review', options)).toBe(true);
    });
    it('does not give retained raw Settings resume authority when destination facts are unavailable', () => {
        const resumable = { ...definition, capabilities: { ...definition.capabilities, supportsLoadSession: true } };
        const options = { accountSettings: { acpCatalogSettingsV1: { v: 2, backends: [resumable] } },
            acpCatalogSnapshot: { status: 'unavailable' as const, reason: 'account-mode-mismatch' } };
        expect(canAgentResume('acp:row-review', options)).toBe(false);
    });
    it('updates the synchronous configured Agent consumer without advancing Settings and reuses unchanged rows', async () => {
        const settings = getStorage().getState().settings;
        await refreshAcpCatalog(scope);
        const first = getAcpCatalogSnapshot(scope);
        expect(first?.catalog.status).toBe('ready');
        expect(getResolvedBackendCatalogEntries({ enabledAgentIds: [], acpCatalogSnapshot: first!.catalog })).toMatchObject([{ backendId: 'row-review', title: 'Row review' }]);
        await refreshAcpCatalog(scope);
        expect(getAcpCatalogSnapshot(scope)?.data).toBe(first?.data);
        row = { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, definitions: [{ ...definition, title: 'Updated review' }] } } };
        await refreshAcpCatalog(scope);
        expect(getResolvedBackendCatalogEntries({ enabledAgentIds: [], acpCatalogSnapshot: getAcpCatalogSnapshot(scope)!.catalog })).toMatchObject([{ title: 'Updated review' }]);
        expect(getStorage().getState().settings).toBe(settings);
    });
    it('verifies fresh absence and preserves retained source through a read-only repair projection', async () => {
        row = { status: 'absent' };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'ready', revision: 'absent', sourceSettingsVersion: 4, record: { v: 1, definitions: [] } } });
        raw = { acpCatalogSettingsV1: { v: 2, backends: [{ ...definition, transportProfile: 'retained', auth: { support: 'status_only', statusCommand: ['check'] } }] } };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'partial', reason: 'incomplete-inventory' } });
        expect(raw.acpCatalogSettingsV1).toMatchObject({ backends: [{ transportProfile: 'retained', auth: { statusCommand: ['check'] } }] });
        raw = { acpCatalogSettingsV1: { v: 9, backends: [] } };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable', reason: 'unsupported-source-version' } });
        row = { status: 'deleted', revision: 9 };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'ready', revision: 9, record: { definitions: [] } } });
    });
    it('receives catalog-only Account wakes while Settings and unrelated domain snapshots remain unchanged', async () => {
        const release = observeAcpCatalog(scope);
        try {
            await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('ready'));
            const settingsVersion = getStorage().getState().settingsVersion;
            const first = getAcpCatalogSnapshot(scope);
            row = { status: 'present', revision: 5, content: { t: 'plain', v: { v: 1, definitions: [{ ...definition, title: 'Woken review' }] } } };
            publishHomeAccountChange(scope.serverId, [ACP_CATALOG_ACCOUNT_ROW_KEY_V1]);
            expect(getAcpCatalogSnapshot(scope)).toMatchObject({ catalog: { status: 'loading' }, data: first?.data });
            await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 5 }));
            const refreshed = getAcpCatalogSnapshot(scope);
            publishHomeAccountChange(scope.serverId, ['unrelated-session']);
            expect(getAcpCatalogSnapshot(scope)).toBe(refreshed);
            expect(getStorage().getState().settingsVersion).toBe(settingsVersion);
        } finally { release(); }
    });
    it('opens an E2EE destination row with genuine captured material and refuses a plain envelope in that Account', async () => {
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
        const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
        row = { status: 'present', revision: 3, content: sealAcpCatalogContentV1({ mode: 'e2ee', material,
            record: { v: 1, definitions: [definition] }, randomBytes: length => new Uint8Array(length).fill(11) }) };
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json({ ...createPlainAccountEncryptionCurrentnessFixture(),
                mode: 'e2ee', contentKeyFingerprint: fingerprint, recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 0 });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(row);
            if (path === '/v1/artifacts') return Response.json([]);
            return new Response(null, { status: 404 });
        });
        await disconnectActiveServerConnection();
        const credentials: AuthCredentials = { ...credentialsFor('a'), secret: Buffer.from(material.secret).toString('base64url') };
        await TokenStorage.setCredentialsForServerUrl('https://acp-home-a.example.test', { serverId: scope.serverId }, credentials);
        await restoreConnectionToActiveServer(credentials);
        getStorage().setState({ settingsScope: scope });
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'ready', record: { definitions: [definition] } } });
        row = { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, definitions: [definition] } } };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    });
    it('rejects mode mismatch before disclosure and does not publish a response from a retired Home', async () => {
        row = { status: 'present', revision: 3, content: { t: 'encrypted', c: 'opaque' } };
        expect(await readAcpCatalog(scope)).toMatchObject({ catalog: { status: 'unavailable' } });
        const pending = createDeferred<Response>();
        let issued = false;
        const original = scope;
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) { issued = true; return pending.promise; }
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return Response.json([]);
            return new Response(null, { status: 404 });
        });
        const loading = refreshAcpCatalog(original);
        await vi.waitFor(() => expect(issued).toBe(true));
        scope = await activateHome('b');
        pending.resolve(Response.json({ status: 'present', revision: 9, content: { t: 'plain', v: { v: 1, definitions: [definition] } } }));
        await loading;
        expect(getAcpCatalogSnapshot(original)?.catalog.status).not.toBe('ready');
        expect(getAcpCatalogSnapshot(scope)).toBeNull();
    });
    it('writes the row once with its captured revision and preserves unknown outcome for a lost response', async () => {
        let mutation: unknown;
        let posts = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1 && init?.method === 'POST') {
                posts += 1;
                mutation = JSON.parse(String(init.body));
                throw new Error('fixture_response_lost');
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(row);
            return new Response(null, { status: 404 });
        });
        await expect(writeAcpCatalogRecord(scope, { record: { v: 1, definitions: [definition] }, expectedRevision: 3 }))
            .rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(posts).toBe(1);
        expect(mutation).toEqual({ expectedRevision: 3, referencedSavedSecretIds: [], savedSecretRevisions: [],
            content: { t: 'plain', v: { v: 1, definitions: [definition] } } });
        expect(raw).toEqual({});
    });
});

import axios from 'axios';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsPluginSecretBinding } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretDeleteInputV1Schema, SavedSecretResourceEnvelopeRepairInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import tweetnacl from 'tweetnacl';
import { SavedSecretResourceMaterialsResponseV1Schema, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { readSavedSecretCatalogForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import type { StoredCredentials } from '@/persistence';
import { createAccountPluginSecretCustodyRouter } from './accountPluginSecretCustody';
import { createStableDeclaredPluginSecretsHost } from './secrets';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';

// Only HTTP and credential persistence are substituted; custody, CAS, crypto,
// catalog admission and resource Actions use their real production owners.
vi.mock('axios', async original => {
    const actual = await original<typeof import('axios')>();
    return { ...actual, default: { ...actual.default, get: vi.fn(), post: vi.fn(), request: vi.fn() } };
});
const persistence = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: persistence.read }));

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('plugin resource custody through real Account and resource wiring', () => {
    it.each(['plain', 'e2ee'] as const)('sets, opens, replaces and unbinds after source migration: %s', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'plugin-owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(4) } };
        persistence.read.mockResolvedValue(credentials);
        const material = credentials.encryption;
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        let raw: Record<string, unknown> = { preferredLanguage: 'fr' };
        let version = 4;
        const resources = new Map<string, SavedSecretResourceMaterialV1>();
        const absentCatalogs = new Set([PROFILE_TRANSFER_ROUTE_V1, MCP_SERVER_CATALOG_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1,
            PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`,
            `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`, REMOTE_HOST_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1,
            CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1]);
        let creates = 0;
        let currentnessUnavailable = false;
        const recipientSeed = new Uint8Array(32).fill(17);
        const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSeed).publicKey;
        const repairedEnvelopes: ReturnType<typeof SavedSecretResourceEnvelopeRepairInputV1Schema.parse>[] = [];
        const stored = () => material ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
            payload: raw, randomBytes: length => new Uint8Array(length).fill(8) }) } : { t: 'plain' as const, v: raw };
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: {} })));
        vi.mocked(axios.get).mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness' && currentnessUnavailable) throw new Error('Fixture Home unavailable');
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, updatedAt: 1, version: 1, settingsVersion: version,
                signingKeyFingerprint: null, contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null,
                recipientEnvelopeReadiness: material ? { status: 'available' } : { status: 'unavailable', reason: 'plain_account' } } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: stored(), version } };
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [...resources.values()] } };
            if (path === '/v1/account/saved-secrets/resources/envelope-census') return { status: 200, data: {
                resourceId: new URL(String(url)).searchParams.get('resourceId'), revision: 1, nextCursor: null,
                recipients: [{ account: { kind: 'account', accountId: 'team-data-member', firstName: null, lastName: null, username: null, avatarUrl: null },
                    readiness: { status: 'available', contentPublicKey: Buffer.from(recipientPublicKey).toString('base64'),
                        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientPublicKey) }, envelopeStatus: 'missing' }],
            } };
            if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] } };
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 3 } };
            if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
            if (path === '/v1/artifacts') return { status: 200, data: [] };
            if (absentCatalogs.has(path)) return { status: 200, data: { status: 'absent' } };
            throw new Error(`Unexpected fixture read: ${path}`);
        });
        vi.mocked(axios.post).mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v2/account/settings') {
                const input = AccountSettingsV2UpdateRequestSchema.parse(body);
                expect(input.expectedVersion).toBe(version);
                if (input.content?.t === 'plain' && mode === 'plain') raw = input.content.v;
                else if (input.content?.t === 'encrypted' && material) raw = AccountSettingsPersistedObjectSchema.parse(
                    openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: input.content.c })?.value);
                else throw new Error('Fixture envelope mode mismatch');
                expect(Array.isArray(raw.secrets) ? raw.secrets.length : 0).toBe(0);
                return { status: 200, data: { success: true, version: ++version } };
            }
            if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']) {
                const input = SharedSavedSecretCreateInputV1Schema.parse(body);
                expect(input.encryptionMode === mode && input.storedContent.t === (mode === 'plain' ? 'plain' : 'encrypted')).toBe(true);
                expect((input.keyEnvelopes?.length ?? 0) === (mode === 'plain' ? 0 : 1)).toBe(true);
                const envelope = input.keyEnvelopes?.[0];
                const ref = `happier:shared-secret:v1:${input.resourceId}`;
                const row = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId: input.resourceId,
                    encryptionMode: mode, storedContent: input.storedContent, recipientEnvelope: envelope ? {
                        encryptedDataKey: envelope.encryptedDataKey, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } : null,
                    entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'plugin-owner', name: input.displayName,
                        kind: input.kind, revision: 1, materialStatus: 'ready', deploymentReferenceState: 'unreferenced',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] }).resources[0]!;
                resources.set(input.resourceId, row);
                creates++;
                return { status: 200, data: { resourceId: input.resourceId, revision: 1 } };
            }
            if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.delete']) {
                const input = SharedSavedSecretDeleteInputV1Schema.parse(body);
                expect(input.expectedSettingsVersion).toBe(version);
                resources.delete(input.resourceId);
                return { status: 200, data: { resourceId: input.resourceId } };
            }
            if (path === '/v1/account/saved-secrets/resources/envelopes/repair') {
                const input = SavedSecretResourceEnvelopeRepairInputV1Schema.parse(body);
                repairedEnvelopes.push(input);
                return { status: 200, data: { resourceId: input.resourceId, revision: input.expectedRevision } };
            }
            throw new Error(`Unexpected fixture write: ${path}`);
        });
        vi.mocked(axios.request).mockImplementation(async config => config.method?.toUpperCase() === 'GET'
            ? axios.get(String(config.url), config)
            : axios.post(String(config.url), config.data, config));
        setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, settings: accountSettingsParse(raw), rawSettings: raw,
            settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
            savedSecretResources: [], savedSecretCatalogState: 'ready' });
        await runWithServerHttpBaseUrl('https://plugin-resource-fixture.test', async () => {
            const otherToken = `e30.${Buffer.from(JSON.stringify({ sub: 'other-owner' })).toString('base64url')}.signature`;
            const wrongAccountRouter = createAccountPluginSecretCustodyRouter({
                readCredentials: async () => ({ ...credentials, token: otherToken }),
                accountScopeKey: scopeKey,
            });
            const wrongAccountCustody = wrongAccountRouter.resolve({ pluginId: 'acme.example', declaration: { id: 'token', custody: 'account' } });
            if (!wrongAccountCustody) throw new Error('Fixture custody unavailable');
            const readsBeforeWrongAccountWrite = vi.mocked(axios.get).mock.calls.length;
            await expect(wrongAccountCustody.set({ secretId: 'token', value: 'fixture-material' }))
                .rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
            expect(vi.mocked(axios.get).mock.calls.length).toBe(readsBeforeWrongAccountWrite);
            expect(creates).toBe(0);
            const router = createAccountPluginSecretCustodyRouter();
            const signal = new AbortController();
            const redacted: string[] = [];
            const shared = createStableDeclaredPluginSecretsHost({ declarations: [], resolveCustody: router.resolve }).bind({ pluginId: 'acme.example',
                signal: signal.signal,
                isOccurrenceCurrent: () => true, registerRawForRedaction: value => redacted.push(value),
                sharedSaveAdmission: { id: 'database', purpose: 'data.connection', audience: { teamGrants: ['team-data'] }, assertCurrent: () => {} },
            });
            if (!shared) throw new Error('Plugin secrets must remain available without declarations');
            const sharedResult = await shared.saveShared('database', { label: 'Shared database',
                bytes: new TextEncoder().encode('\uFEFFshared-only-sentinel'), audience: { teamGrants: ['team-data'] } });
            expect(sharedResult).toEqual({ ref: expect.stringMatching(/^happier:shared-secret:v1:/), resourceRevision: 1 });
            expect(raw).toEqual({ preferredLanguage: 'fr' });
            expect(creates).toBe(1);
            redacted.length = 0;
            // A standalone resource has no plugin-id binding. Exact-ref reads
            // use the same Account/resource custody in both encryption modes.
            await expect(shared.readSavedSecret(sharedResult.ref, { resourceRevision: 1 }))
                .resolves.toBe('\uFEFFshared-only-sentinel');
            expect(redacted).toEqual(['\uFEFFshared-only-sentinel']);
            redacted.length = 0;
            await expect(shared.readSavedSecret(sharedResult.ref, { resourceRevision: 2 }))
                .rejects.toMatchObject({ code: 'secret_missing' });
            expect(redacted).toEqual([]);
            const abortedRead = new AbortController(); abortedRead.abort();
            await expect(shared.readSavedSecret(sharedResult.ref, { signal: abortedRead.signal })).rejects.toBeDefined();
            expect(redacted).toEqual([]);
            const sharedRequest = vi.mocked(axios.post).mock.calls.find(([url]) => new URL(String(url)).pathname
                === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']);
            expect(SharedSavedSecretCreateInputV1Schema.parse(sharedRequest?.[1]).teamGrants).toEqual(['team-data']);
            if (mode === 'plain') {
                const content = SharedSavedSecretCreateInputV1Schema.parse(sharedRequest?.[1]).storedContent;
                expect(content.t === 'plain' ? content.v : null).toMatchObject({ v: 1, value: '\uFEFFshared-only-sentinel' });
                expect(content.t === 'plain' ? content.v.createdByPlugin : null)
                    .toEqual({ pluginId: 'acme.example', secretId: 'database' });
                currentnessUnavailable = true;
                await expect(shared.saveShared('database', { label: 'Unavailable Home', bytes: new TextEncoder().encode('not-written'),
                    audience: { teamGrants: ['team-data'] } })).rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
                expect(creates).toBe(1);
                currentnessUnavailable = false;
            }
            if (mode === 'e2ee') {
                expect.soft(repairedEnvelopes).toHaveLength(1);
                const repaired = repairedEnvelopes[0]?.keyEnvelopes[0];
                if (repaired) {
                    expect(repaired.recipientAccountId).toBe('team-data-member');
                    const key = openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(Buffer.from(repaired.encryptedDataKey, 'base64')),
                        recipientSecretKeyOrSeed: recipientSeed });
                    if (!key) throw new Error('Shared-save recipient cannot open its envelope');
                    const created = SharedSavedSecretCreateInputV1Schema.parse(sharedRequest?.[1]);
                    expect(openSavedSecretResourceStoredContentV1({ resourceId: created.resourceId, mode: 'e2ee',
                        resourceDataKey: key, storedContent: created.storedContent })).toMatchObject({ v: 1, value: '\uFEFFshared-only-sentinel' });
                    expect(openSavedSecretResourceStoredContentV1({ resourceId: created.resourceId, mode: 'e2ee',
                        resourceDataKey: key, storedContent: created.storedContent })?.createdByPlugin)
                        .toEqual({ pluginId: 'acme.example', secretId: 'database' });
                    key.fill(0);
                }
                persistence.read.mockResolvedValue({ ...credentials, encryption: null });
                await expect(shared.saveShared('database', { label: 'No key', bytes: new TextEncoder().encode('not-written'),
                    audience: { teamGrants: ['team-data'] } })).rejects.toMatchObject({ code: 'secret_save_client_required' });
                expect(creates).toBe(1);
                persistence.read.mockResolvedValue(credentials);
            }
            // The returned ref is an ordinary resource; no plugin binding or
            // Environment mutation was created, and normal resource custody owns it.
            redacted.length = 0;
            resources.delete(sharedResult.ref.slice('happier:shared-secret:v1:'.length));
            const readCustody = router.bindReadCustody({ signal: signal.signal, isCurrent: () => true });
            if (!readCustody) throw new Error('Fixture read custody unavailable');
            let consumedRevokedMaterial = false;
            await expect(readCustody.withSecrets({
                references: [{ ref: sharedResult.ref, revision: sharedResult.resourceRevision }],
                signal: signal.signal,
            }, material => {
                consumedRevokedMaterial = true;
                return material.read(sharedResult.ref);
            })).rejects.toMatchObject({ code: 'secret_missing' });
            expect(consumedRevokedMaterial).toBe(false);
            await expect(shared.readSavedSecret(sharedResult.ref, { resourceRevision: 1 }))
                .rejects.toMatchObject({ code: 'secret_missing' });
            expect(redacted).toEqual([]);
            creates = 0;
            const custody = router.resolve({ pluginId: 'acme.example', declaration: { id: 'token', custody: 'account' } });
            if (!custody) throw new Error('Fixture custody unavailable');
            const initialWrite = await custody.set({ secretId: 'token', value: 'fixture-material' });
            expect((await custody.status('token')).revision === initialWrite.revision).toBe(true);
            expect(creates).toBe(1);
            expect(resources.size).toBe(1);
            const created = [...resources.values()][0]!;
            if (!('resourceId' in created)) throw new Error('Fixture resource unavailable');
            expect((await custody.get('token'))?.value === 'fixture-material').toBe(true);
            if (mode === 'plain') {
                const directory = await mkdtemp(join(tmpdir(), 'plugin-secret-vault-'));
                const field = join(directory, 'field');
                let nativeReads = 0;
                const source = await createSecretSourceHostFixture({ runtime: { async acquire() {
                    nativeReads += 1;
                    return { ok: true, value: await readFile(field, 'utf8') };
                } } });
                try {
                    await writeFile(field, 'vault-private-first');
                    resources.set(created.resourceId, { ...created, storedContent: { t: 'plain', v: {
                        v: 2, name: created.entry.name!, kind: 'other', source: { kind: 'external',
                            contribution: source.contribution, account: 'chosen-account', reference: 'op://vault/item/field' },
                    } } });
                    const externalRouter = createAccountPluginSecretCustodyRouter({ secretSources: source.host });
                    const externalHost = createStableDeclaredPluginSecretsHost({ declarations: [{ pluginId: 'acme.example',
                        declaration: { id: 'token', custody: 'account' } }], resolveCustody: externalRouter.resolve }).bind({
                        pluginId: 'acme.example', signal: signal.signal, isOccurrenceCurrent: () => true,
                        registerRawForRedaction: value => redacted.push(value),
                    });
                    if (!externalHost) throw new Error('Fixture secret declaration did not bind');
                    await expect(externalHost.status('token')).resolves.toMatchObject({ state: 'configured' });
                    await expect(externalHost.get('token', { sourceKind: 'inline' })).rejects.toMatchObject({
                        code: 'plugin_secret_custody_unavailable',
                    });
                    expect(nativeReads).toBe(0);
                    await expect(externalHost.get('token')).resolves.toBe('vault-private-first');
                    expect(nativeReads).toBe(1);
                    await writeFile(field, 'vault-private-rotated');
                    await expect(externalHost.readSavedSecret(created.entry.ref, { resourceRevision: 1 }))
                        .resolves.toBe('vault-private-rotated');
                    expect(nativeReads).toBe(2);
                    expect(redacted).toEqual(['vault-private-first', 'vault-private-rotated']);
                } finally {
                    resources.set(created.resourceId, created);
                    redacted.length = 0;
                    await source.dispose();
                    await rm(directory, { recursive: true, force: true });
                }
            }
            const first = resolveAccountSettingsPluginSecretBinding(raw, { pluginId: 'acme.example', localId: 'token' });
            expect(first?.createdForBinding).toBe(true);
            const replacement = await custody.set({ secretId: 'token', value: 'replacement-fixture-material' });
            expect((await custody.status('token')).revision === replacement.revision).toBe(true);
            expect(creates).toBe(2);
            expect(resources.size).toBe(1);
            expect((await custody.get('token'))?.value === 'replacement-fixture-material').toBe(true);
            await router.unbind({ pluginId: 'acme.example', secretId: 'token' });
            expect(resolveAccountSettingsPluginSecretBinding(raw, { pluginId: 'acme.example', localId: 'token' }) === null).toBe(true);
            expect(resources.size).toBe(0);
            expect(await custody.get('token')).toBeNull();
            // Another owner grants the same schema-valid material to this Account.
            // Selecting it never turns the recipient into its cleanup owner.
            resources.set(created.resourceId, { ...created, entry: { ...created.entry, relationship: 'recipient', ownerAccountId: 'other-owner',
                capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } } });
            await readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, refreshCatalog: true });
            await router.bindExisting({ pluginId: 'acme.example', secretId: 'token', savedSecretId: created.entry.ref });
            expect((await custody.get('token'))?.value === 'fixture-material').toBe(true);
            expect(resolveAccountSettingsPluginSecretBinding(raw, { pluginId: 'acme.example', localId: 'token' })?.createdForBinding).toBe(false);
            resources.set(created.resourceId, { ...created, storedContent: mode === 'plain'
                ? { t: 'encrypted', c: 'AAAA' }
                : { t: 'plain', v: { v: 1, name: created.entry.name!, kind: 'other', value: 'mismatched-fixture' } } });
            await expect(custody.get('token')).rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
            await expect(shared.readSavedSecret(created.entry.ref, { resourceRevision: 1 }))
                .rejects.toBeDefined();
            expect(redacted).toEqual([]);
            await router.unbind({ pluginId: 'acme.example', secretId: 'token' });
            expect(resources.size).toBe(1);
            expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(scopeKey);
            const previousAccount = getActiveAccountSettingsSnapshot();
            if (!previousAccount) throw new Error('Fixture Account unavailable');
            setActiveAccountSettingsSnapshot({ ...previousAccount, scopeKey: 'another-account' });
            await expect(shared.readSavedSecret(created.entry.ref, { resourceRevision: 1 }))
                .rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
            expect(redacted).toEqual([]);
        });
    });
});

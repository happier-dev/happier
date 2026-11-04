import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretUpdateInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretCatalogEntryV1Schema, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createCliPersonalSavedSecretActionExecute, updateOwnedSavedSecretResourceForOperation } from './personalSavedSecretActionHost';
import { createInvocationSavedSecretOperationContextV1 } from './savedSecretOperationContext';
import { createSavedSecretMaterializerFromSnapshotV1 } from './savedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

// HTTP is the process boundary; Account admission, resource opening, sealing and Action execution stay real.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: Object.assign(actual.default.create(), { get: vi.fn(), post: vi.fn(), request: vi.fn() }) };
});
afterEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); vi.mocked(axios.request).mockReset(); vi.unstubAllGlobals(); });

describe('personal Saved Secret key rotation', () => {
    it('describes Connected Account referrers through the same read-only census as delete', async () => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
            serverHttpBaseUrl: 'https://describe.example.test', isCurrent: async () => true,
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] } });
        const account = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' };
        const resource: SavedSecretResourceMaterialV1 = { resourceId: 'one', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Key', kind: 'apiKey', value: 'dummy-test-key' } },
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref: formatSharedSavedSecretRefV1('one'), source: 'shared_resource',
                relationship: 'owner', ownerAccountId: accountId, name: 'Key', kind: 'apiKey', revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: accountId,
                connectedAccountsV4: [{ ref: account, displayName: 'Provider name', status: 'connected', authenticationModeId: 'api-key',
                    revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationReady: true, configurationRevision: null, savedSecretResourceIds: ['one'] }] }) };
            if (path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
                content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Work credential' }] } } } };
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [resource] } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 0, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
                complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 1 } };
            // All catalog transports use their real empty-row envelope; unknown paths still fail their schema.
            if (path === PROFILE_TRANSFER_ROUTE_V1 || path.startsWith('/v1/account/')) return { status: 200, data: { status: 'absent' } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
            home: async () => { throw new Error('Describe must not mutate'); } });
        await expect(execute({ actionId: 'secrets.list', input: { secretId: 'one' }, context: { surface: 'cli' } }))
            .resolves.toMatchObject({ secrets: [{ secretId: 'one', name: 'Key' }], usedBy: [{ owner: 'connectedAccountCredential',
                referrer: { kind: 'connectedAccountCredential', id: 'work', displayName: 'Work credential' } }] });
        expect(vi.mocked(axios.get).mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/profile')).toHaveLength(1);
        await expect(execute({ actionId: 'secrets.delete', input: { secretId: 'one', expectedUpdatedAt: 1 }, context: { surface: 'cli' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'in_use', details: { references: [{ owner: 'connectedAccountCredential',
                referrer: { id: 'work', displayName: 'Work credential' } }] } });
        expect(axios.post).not.toHaveBeenCalled();
    });
    it('lists installed source declarations without acquiring native values', async () => {
        let reads = 0;
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { reads += 1; return { ok: true, value: 'private' }; },
        } });
        try {
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'secret-owner' })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, secretSources: source.host,
                serverHttpBaseUrl: 'https://list.example.test', isCurrent: async () => true,
                snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                    loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] } });
            vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
            vi.mocked(axios.get).mockImplementation(async rawUrl => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
                throw new Error(`Unexpected boundary request ${path}`);
            });
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
                home: async () => { throw new Error('List must not mutate'); } });
            await expect(execute({ actionId: 'secrets.list', input: {}, context: { surface: 'cli' } })).resolves.toEqual({
                secrets: [], sources: [{ contribution: source.contribution, title: 'Fixture vault' }],
            });
            expect(reads).toBe(0);
        } finally { await source.dispose(); }
    });

    it.each([
        { mode: 'plain', sourceKind: 'external' }, { mode: 'e2ee', sourceKind: 'external' },
        { mode: 'plain', sourceKind: 'passkey' }, { mode: 'e2ee', sourceKind: 'passkey' },
    ] as const)('imports $sourceKind through the real $mode resource sealing owner', async ({ mode, sourceKind }) => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const keys = tweetnacl.box.keyPair();
        const credentials = { token, encryption: mode === 'plain' ? null : { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://link.example.test',
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        let retainedResource: SavedSecretResourceMaterialV1 | null = null;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: retainedResource ? [retainedResource] : [] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: mode === 'plain' ? null : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: keys.secretKey }, dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: mode === 'plain' ? 'unavailable' : 'available', ...(mode === 'plain' ? { reason: 'plain_account' } : {}) } } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const source = sourceKind === 'external'
            ? { kind: 'external' as const, contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'my-account', reference: 'op://vault/item/token' }
            : { kind: 'passkey' as const, rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG', privateKey: 'BwgJ',
                algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true };
        const kind = sourceKind === 'external' ? 'token' : 'other';
        const submitted: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>[] = [];
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext, home: async ({ actionId, input }) => {
            expect(actionId).toBe('secrets.shared.create');
            const request = SharedSavedSecretCreateInputV1Schema.parse(input); submitted.push(request);
            return { resourceId: request.resourceId, revision: 1 };
        } });
        const result = await execute({ actionId: 'secrets.create', input: { name: 'Vault token', kind, source }, context: { surface: 'cli' } });
        expect(result).toMatchObject({ secretId: expect.any(String), secretRef: expect.any(String) });
        expect(submitted).toHaveLength(1);
        const request = submitted[0]!;
        const resourceDataKey = mode === 'plain' ? null : openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(request.keyEnvelopes![0]!.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: keys.secretKey });
        const opened = mode === 'plain' ? openSavedSecretResourceStoredContentV1({ resourceId: request.resourceId, mode, storedContent: request.storedContent })
            : openSavedSecretResourceStoredContentV1({ resourceId: request.resourceId, mode, storedContent: request.storedContent, resourceDataKey: resourceDataKey! });
        expect(opened).toEqual({ v: 2, name: 'Vault token', kind, source });
        if (mode === 'e2ee') expect(JSON.stringify(request)).not.toContain(sourceKind === 'passkey' ? 'BwgJ' : 'op://vault/item/token');
        expect(request.accountGrants).toEqual([]); expect(request.teamGrants).toEqual([]); expect(request.groupGrants).toEqual([]);
        const ownerEnvelope = request.keyEnvelopes?.[0];
        retainedResource = { resourceId: request.resourceId, encryptionMode: mode, storedContent: request.storedContent,
            recipientEnvelope: ownerEnvelope ? { encryptedDataKey: ownerEnvelope.encryptedDataKey,
                recipientContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint } : null,
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref: formatSharedSavedSecretRefV1(request.resourceId), source: 'shared_resource',
                relationship: 'owner', ownerAccountId: accountId, name: 'Vault token', kind, revision: 1, materialStatus: 'ready',
                audience: { accounts: [{ kind: 'account', accountId, name: null, firstName: null, lastName: null, username: null, avatarUrl: null }],
                    teams: [], groups: [] }, capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        await expect(updateOwnedSavedSecretResourceForOperation({ credentials, operationContext, resourceId: request.resourceId,
            expectedRevision: 1, nextName: 'Renamed credential', executeMutation: async input => {
                expect(input).toMatchObject({ resourceId: request.resourceId, expectedRevision: 1, displayName: 'Renamed credential' });
                return { resourceId: request.resourceId, revision: 2 };
            } })).resolves.toEqual({ resourceId: request.resourceId, revision: 2 });
        resourceDataKey?.fill(0);
    });
    it.each([
        { entry: 'action', mismatchedEnvelope: false },
        { entry: 'native', mismatchedEnvelope: false },
        { entry: 'native-default-http', mismatchedEnvelope: false },
        { entry: 'action', mismatchedEnvelope: true },
    ] as const)('rotates one retained Plain resource on an E2EE Account through $entry, mismatchedEnvelope=$mismatchedEnvelope', async ({ entry, mismatchedEnvelope }) => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const keys = tweetnacl.box.keyPair();
        const credentials = { token, encryption: { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        const resourceId = 'held-cloud-key';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const createdByPlugin = { pluginId: 'acme.cloud', secretId: 'cloud-api' };
        let resource: Extract<SavedSecretResourceMaterialV1, { resourceId: string }> = { resourceId, encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: mismatchedEnvelope ? { t: 'encrypted' as const, c: 'AA==' } : { t: 'plain' as const,
                v: { v: 1 as const, name: 'Cloud key', kind: 'apiKey' as const, value: 'old-key', createdByPlugin } },
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource' as const, relationship: 'owner' as const, ownerAccountId: accountId,
                name: 'Cloud key', kind: 'apiKey' as const, revision: 7, materialStatus: 'ready' as const,
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        const context = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://rotate.example.test',
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 4,
                loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const submitted: ReturnType<typeof SharedSavedSecretUpdateInputV1Schema.parse>[] = [];
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [resource] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1, settingsVersion: 4,
                signingKeyFingerprint: null, contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: keys.secretKey }, dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } };
            if (path === '/v1/account/saved-secrets/resources/envelope-census') return { status: 200, data: { resourceId, revision: 8, recipients: [], nextCursor: null } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const executeMutation = async (input: unknown) => {
            const update = SharedSavedSecretUpdateInputV1Schema.parse(input);
            submitted.push(update);
            const ownerEnvelope = update.keyEnvelopes?.find(envelope => envelope.recipientAccountId === accountId);
            expect(ownerEnvelope).toBeDefined();
            resource = { ...resource, encryptionMode: 'e2ee', storedContent: update.storedContent,
                recipientEnvelope: { encryptedDataKey: ownerEnvelope!.encryptedDataKey,
                    recipientContentPublicKeyFingerprint: ownerEnvelope!.recipientContentPublicKeyFingerprint },
                entry: { ...resource.entry, revision: 8 } };
            return { resourceId, revision: 8 };
        };
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext: context,
            home: async ({ actionId, input }) => {
                expect(actionId).toBe('secrets.shared.update');
                return executeMutation(input);
            },
        });
        vi.mocked(axios.request).mockImplementation(async request => {
            expect(request.url).toBe(`https://rotate.example.test${SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']}`);
            expect(request.method).toBe('POST');
            return { status: 200, data: await executeMutation(request.data) };
        });
        const signal = new AbortController().signal;
        const operation = entry === 'action'
            ? execute({ actionId: 'secrets.update', input: { secretId: resourceId, value: 'rotated-key', expectedUpdatedAt: 7 }, context: { surface: 'cli', signal } })
            : updateOwnedSavedSecretResourceForOperation({ credentials, resourceId, nextValue: 'rotated-key', operationContext: context,
                signal, ...(entry === 'native-default-http' ? {} : { executeMutation }) });
        if (mismatchedEnvelope) {
            // The canonical material-response boundary rejects the mode/envelope mismatch before any mutation.
            await expect(operation).rejects.toMatchObject({ issues: expect.arrayContaining([
                expect.objectContaining({ path: ['resources', 0] }),
            ]) });
            expect(submitted).toEqual([]);
            return;
        }
        const result = await operation;
        expect(result).toEqual(entry === 'action' ? { secretId: resourceId, updatedAt: 8 } : { resourceId, revision: 8 });
        expect(submitted).toHaveLength(1);
        const update = submitted[0]!;
        expect(update).toMatchObject({ resourceId, expectedRevision: 7, toMode: 'e2ee' });
        expect(update).not.toHaveProperty('accountGrants');
        expect(update).not.toHaveProperty('teamGrants');
        expect(update).not.toHaveProperty('groupGrants');
        const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(update.keyEnvelopes![0]!.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: keys.secretKey });
        expect(dataKey).not.toBeNull();
        expect(openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', storedContent: update.storedContent, resourceDataKey: dataKey! }))
            .toEqual({ v: 1, name: 'Cloud key', kind: 'apiKey', value: 'rotated-key', createdByPlugin });
        expect(await createSavedSecretMaterializerFromSnapshotV1(context.readSnapshot()!).resolve(ref)).toMatchObject({ status: 'ready', value: 'rotated-key' });
        dataKey!.fill(0);
    });
});

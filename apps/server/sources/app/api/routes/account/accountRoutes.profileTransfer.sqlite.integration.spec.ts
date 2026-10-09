import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildProfilePhysicalKey, encodeAccountScopedKvJson, PROFILE_TRANSFER_ACCOUNT_KV_KEY, PROFILE_ACCOUNT_KV_PREFIX } from '@/app/kv/accountScopedKv';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, formatSharedSavedSecretRefV1,
    promotePersonalSavedSecretReference, buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { signAccountContentKeyBindingV1, createAccountEncryptionMigrateProofSigningInputV1, attachAccountEncryptionMigrateProofSignatureV1,
    type AccountEncryptionMigrateUnsignedRequest } from '@happier-dev/protocol';
import { sealProfileTransferContentV1, openProfileTransferContentV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { sealProfileRecordContentV1, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { inTx } from '@/storage/inTx';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';

const record = {
    v: 1, id: 'profile-a', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: {
        v: 2, id: 'profile-a', name: 'Example', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
    } },
} satisfies ProfileRecordV1;

describe('Account Profile transfer (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-transfer-', initEncrypt: true, initFiles: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('does not synthesize fresh markers and activates genuine prepared control under source and control CAS', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7,
            settings: JSON.stringify({ t: 'plain', v: { profileEnabledById: { anthropic: false } } }) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/profiles/transfer';
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const content = { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 7, migratedLogicalRevision: 0, inventory: [] } };
        try {
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'prepare', sourceSettingsVersion: 7, expectedRevision: 'absent', inventory: [], imports: [],
                content: { ...content, v: { ...content.v, phase: 'prepared' } },
            } })).json()).toEqual({ status: 'inventory-incomplete' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'activate', sourceSettingsVersion: 7, expectedRevision: 'absent', inventory: [], content,
            } })).json()).toEqual({ status: 'inventory-incomplete' });
            await db.account.update({ where: { id: account.id }, data: { settings: JSON.stringify({ t: 'plain', v: { profiles: [] } }) } });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'activate', sourceSettingsVersion: 6, expectedRevision: 'absent', inventory: [],
                content: { ...content, v: { ...content.v, sourceSettingsVersion: 6 } },
            } })).json()).toEqual({ status: 'settings-conflict', revision: 7 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'prepare', sourceSettingsVersion: 7, expectedRevision: 'absent', inventory: [], imports: [],
                content: { ...content, v: { ...content.v, phase: 'prepared' } },
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'activate', sourceSettingsVersion: 7, expectedRevision: 0, inventory: [], content,
            } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 1, content });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
            const committedAccount = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const committedRows = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            const staleRestore = await app.inject({ method: 'POST', url: '/v2/account/settings', headers, payload: {
                expectedVersion: 7, expectedProfileTransferRevision: 'absent', content: { t: 'plain', v: { profiles: [record.definition.profile] } },
            } });
            expect(staleRestore.json()).toEqual({ success: false, error: 'profile-transfer-mismatch', currentProfileTransferRevision: 1 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(committedAccount);
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(committedRows);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('prepares imports atomically and rejects incomplete activation and retries that would rewrite an active row', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 2,
            settings: JSON.stringify({ t: 'plain', v: { profiles: [record.definition.profile] } }) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/profiles/transfer';
        const headers = { 'x-test-user-id': account.id };
        const inventory = [{ kind: 'account_row', id: record.id, revision: 0 }];
        const proof = { v: 1, phase: 'prepared', sourceSettingsVersion: 2, migratedLogicalRevision: 0, inventory };
        const imports = [{ operation: 'import', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: record }, referencedSavedSecretIds: [] }];
        const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
        try {
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 1, expectedRevision: 'absent', inventory, imports,
                content: { t: 'plain', v: { ...proof, sourceSettingsVersion: 1 } } })).json()).toEqual({ status: 'settings-conflict', revision: 2 });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            // Wrong post-write revisions must roll back the import and its guard.
            const wrongInventory = [{ ...inventory[0], revision: 5 }];
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 2, expectedRevision: 'absent', inventory: wrongInventory, imports,
                content: { t: 'plain', v: { ...proof, inventory: wrongInventory } } })).json()).toEqual({ status: 'inventory-incomplete' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 2, expectedRevision: 'absent', inventory, imports,
                content: { t: 'plain', v: proof } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await post({ operation: 'activate', sourceSettingsVersion: 2, expectedRevision: 0, inventory: [],
                content: { t: 'plain', v: { ...proof, phase: 'active', inventory: [] } } })).json()).toEqual({ status: 'inventory-incomplete' });
            expect((await post({ operation: 'activate', sourceSettingsVersion: 2, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...proof, phase: 'active' } } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            // User edits can advance a row after activation. A stale importer cannot overwrite it.
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: buildProfilePhysicalKey(record.id) } }, data: {
                version: 1, value: privacyKit.decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: { ...record, enabled: false } })!),
            } });
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 2, expectedRevision: 1, inventory, imports,
                content: { t: 'plain', v: proof } })).json()).toEqual({ status: 'already-active', revision: 1 });
            expect((await post({ operation: 'activate', sourceSettingsVersion: 2, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...proof, phase: 'active' } } })).json()).toEqual({ status: 'already-active', revision: 1 });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProfilePhysicalKey(record.id) } } })).version).toBe(1);
        } finally { await app.close(); }
    });

    it.each(['cleanup-pending', 'cleaned'] as const)('refuses activated Profile source writes without requiring a transfer revision (%s)', async (state) => {
        const retainedSource = {
            profiles: [record.definition.profile],
            secretBindingsByProfileId: { anthropic: { TOKEN: 'retained-secret' } },
        };
        const currentSettings = state === 'cleanup-pending' ? retainedSource : {};
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7,
            settings: JSON.stringify({ t: 'plain', v: currentSettings }) } });
        await db.userKVStore.create({ data: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY, version: 1,
            value: privacyKit.decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: {
                v: 1, phase: 'active', sourceSettingsVersion: 7, migratedLogicalRevision: 0, inventory: [],
            } })!) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const write = (settings: Record<string, unknown>, expectedVersion: number, expectedProfileTransferRevision?: number) =>
            app.inject({ method: 'POST', url: '/v2/account/settings', headers, payload: {
                expectedVersion, ...(expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision }),
                content: { t: 'plain', v: settings },
            } });
        try {
            const committedAccount = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const committedRows = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            for (const expectedRevision of [undefined, 1]) {
                for (const attemptedSource of [
                    { profiles: [{ ...record.definition.profile, name: 'Edited' }] },
                    { profiles: [...retainedSource.profiles, { ...record.definition.profile, id: 'profile-b' }] },
                    { secretBindingsByProfileId: { anthropic: { TOKEN: 'replacement-secret' } } },
                    { secretBindingsByProfileId: { ...retainedSource.secretBindingsByProfileId, 'profile-b': { TOKEN: 'new-secret' } } },
                ]) {
                    const refused = await write({ ...currentSettings, ...attemptedSource, analyticsOptOut: true }, 7, expectedRevision);
                    expect(refused.statusCode).toBe(400);
                    expect(refused.json()).toEqual({ error: 'invalid-params' });
                    expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(committedAccount);
                    expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(committedRows);
                    expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
                }
            }
            // Preference writes may retain exactly the source awaiting cleanup.
            expect((await write({ ...currentSettings, analyticsOptOut: true }, 7)).json()).toEqual({ success: true, version: 8 });
            // Source removal remains possible and cannot be reversed by a later replacement.
            expect((await write({ analyticsOptOut: false }, 8)).json()).toEqual({ success: true, version: 9 });
            const afterCleanup = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const snapshotsAfterCleanup = await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: 'asc' } });
            expect((await write({ ...retainedSource, analyticsOptOut: false }, 9)).json()).toEqual({ error: 'invalid-params' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(afterCleanup);
            expect(await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, orderBy: { version: 'asc' } })).toEqual(snapshotsAfterCleanup);
        } finally { await app.close(); }
    });

    it('refuses malformed stored rows instead of claiming complete empty authority', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: { profiles: [] } }) } });
        await db.userKVStore.create({ data: { accountId: account.id, key: buildProfilePhysicalKey('corrupt'), version: 0,
            value: privacyKit.decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: { v: 99 } })!) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        try {
            const result = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
                headers: { 'x-test-user-id': account.id }, payload: {
                    operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory: [], imports: [],
                    content: { t: 'plain', v: { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
                } });
            expect(result.json()).toEqual({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY } } })).toBeNull();
        } finally { await app.close(); }
    });

    it('captures retained custom enablement and explicit profile-stack source without synthesizing records', async () => {
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        try {
            for (const source of [{ profileEnabledById: { 'custom-profile': false } },
                { promptStacksV1: { v: 1, surfaces: { profilesById: {} } } }]) {
                const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: source }) } });
                const result = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
                    headers: { 'x-test-user-id': account.id }, payload: {
                        operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory: [], imports: [],
                        content: { t: 'plain', v: { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
                    } });
                expect(result.json()).toMatchObject({ status: 'updated', revision: 0 });
                expect(await db.userKVStore.count({ where: { accountId: account.id, key: { startsWith: PROFILE_ACCOUNT_KV_PREFIX } } })).toBe(0);
            }
        } finally { await app.close(); }
    });

    it('checks actual resource access, composite revisions, kind and Profile identity before preparing', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: { profiles: [record.definition.profile] } }) } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: record.id, name: 'Example' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'launch-profile.v1', profile: record.definition.profile, secretBindings: {} }) })),
            headerVersion: 2, bodyVersion: 4, dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const resourceId = crypto.randomUUID();
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Resource', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Resource', kind: 'token', value: 'private-fixture' } } }));
        const savedSecret = await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId } });
        const reference = formatSharedSavedSecretRefV1(savedSecret.id);
        const saved = { ...record, definition: { kind: 'artifact', artifactId: artifact.id }, secretBindings: { TOKEN: reference } };
        const inventory = [{ kind: 'account_row', id: record.id, revision: 0 },
            { kind: 'artifact', id: artifact.id, revision: { headerVersion: 2, bodyVersion: 4 } },
            { kind: 'saved_secret', id: savedSecret.id, revision: 1 }];
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const payload = { operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory,
            imports: [{ operation: 'import', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: saved },
                artifactRevision: { artifactId: artifact.id, headerVersion: 2, bodyVersion: 4 },
                referencedSavedSecretIds: [reference], savedSecretRevisions: [{ resourceId: savedSecret.id, expectedRevision: 1 }] }],
            content: { t: 'plain', v: { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory } } };
        const post = () => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers: { 'x-test-user-id': account.id }, payload });
        try {
            expect((await post()).json()).toEqual({ status: 'invalid-reference' });
            await db.savedSecretAccountGrant.create({ data: { resourceId: savedSecret.id, accountId: account.id, createdByAccountId: owner.id } });
            // The secret is usable but the Artifact has no grant. The whole import stays absent.
            expect((await post()).json()).toEqual({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: account.id, accessLevel: 'view', createdByAccountId: owner.id } });
            await db.artifact.update({ where: { id: artifact.id }, data: { bodyVersion: 5 } });
            expect((await post()).json()).toEqual({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            await db.artifact.update({ where: { id: artifact.id }, data: { bodyVersion: 4,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'role.v1', profileId: record.id, name: 'Example' })) } });
            expect((await post()).json()).toEqual({ status: 'invalid-reference' });
            await db.artifact.update({ where: { id: artifact.id }, data: {
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: 'different', name: 'Example' })) } });
            expect((await post()).json()).toEqual({ status: 'invalid-reference' });
            await db.artifact.update({ where: { id: artifact.id }, data: {
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: record.id, name: 'Example' })) } });
            expect((await post()).json()).toMatchObject({ status: 'updated', revision: 0 });
        } finally { await app.close(); }
    });

    it.each(['prepare', 'activate', 'masked'] as const)('requires the complete effective Artifact secret inventory (%s)', async (scenario) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const account = await db.account.create({ data: { encryptionMode: 'plain',
            settings: JSON.stringify({ t: 'plain', v: { profiles: [record.definition.profile] } }) } });
        const resourceId = crypto.randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Inherited token', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Inherited token', kind: 'token', value: 'private-fixture' } } })))
            .toMatchObject({ ok: true });
        await db.savedSecretAccountGrant.create({ data: { resourceId, accountId: account.id, createdByAccountId: owner.id } });
        const reference = formatSharedSavedSecretRefV1(resourceId);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', profileId: record.id, name: 'Example' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'launch-profile.v1',
                profile: record.definition.profile, secretBindings: { TOKEN: reference } }) })),
            headerVersion: 1, bodyVersion: 1, dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const selected: ProfileRecordV1 = { ...record, definition: { kind: 'artifact', artifactId: artifact.id },
            secretBindings: scenario === 'masked' ? { TOKEN: null } : {} };
        const omittedInventory = [{ kind: 'account_row' as const, id: record.id, revision: 0 },
            { kind: 'artifact' as const, id: artifact.id, revision: { headerVersion: 1, bodyVersion: 1 } }];
        const fullInventory = [...omittedInventory, { kind: 'saved_secret' as const, id: resourceId, revision: 1 }];
        const imports = [{ operation: 'import', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: selected },
            artifactRevision: { artifactId: artifact.id, headerVersion: 1, bodyVersion: 1 },
            referencedSavedSecretIds: scenario === 'masked' ? [] : [reference],
            savedSecretRevisions: scenario === 'masked' ? [] : [{ resourceId, expectedRevision: 1 }] }];
        const proof = (inventory: typeof fullInventory, phase: 'prepared' | 'active' = 'prepared') => ({
            v: 1, phase, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory,
        });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
            headers: { 'x-test-user-id': account.id }, payload });
        const readRows = () => db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
        try {
            if (scenario === 'activate') {
                expect((await post({ operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory: fullInventory,
                    imports, content: { t: 'plain', v: proof(fullInventory) } })).json()).toMatchObject({ status: 'updated', revision: 0 });
                // A retained prepared proof from the previous incomplete census must not gain active authority.
                await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY } },
                    data: { value: privacyKit.decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: proof(omittedInventory) })!) } });
            }
            const baseline = await readRows();
            const source = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const result = await post(scenario === 'activate'
                ? { operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory: omittedInventory,
                    content: { t: 'plain', v: proof(omittedInventory, 'active') } }
                : { operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory: omittedInventory,
                    imports, content: { t: 'plain', v: proof(omittedInventory) } });
            if (scenario === 'masked') {
                expect(result.json()).toMatchObject({ status: 'updated', revision: 0 });
                await db.savedSecretAccountGrant.deleteMany({ where: { resourceId, accountId: account.id } });
                expect((await post({ operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory: omittedInventory,
                    content: { t: 'plain', v: proof(omittedInventory, 'active') } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            } else {
                expect(result.json()).toEqual({ status: 'inventory-incomplete' });
                expect(await readRows()).toEqual(baseline);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(source);
                const preparedRevision = scenario === 'activate' ? 1 : 0;
                expect((await post({ operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: scenario === 'activate' ? 0 : 'absent',
                    inventory: fullInventory, imports: scenario === 'activate' ? [] : imports,
                    content: { t: 'plain', v: proof(fullInventory) } })).json()).toMatchObject({ status: 'updated', revision: preparedRevision });
                const preparedRows = await readRows();
                const activation = { operation: 'activate', sourceSettingsVersion: 0, expectedRevision: preparedRevision,
                    inventory: fullInventory, content: { t: 'plain', v: proof(fullInventory, 'active') } };
                await db.savedSecretResource.update({ where: { id: resourceId }, data: { revision: 2 } });
                expect((await post(activation)).json()).toEqual({ status: 'inventory-incomplete' });
                expect(await readRows()).toEqual(preparedRows);
                await db.savedSecretResource.update({ where: { id: resourceId }, data: { revision: 1 } });
                await db.savedSecretAccountGrant.deleteMany({ where: { resourceId, accountId: account.id } });
                expect((await post(activation)).json()).toEqual({ status: 'invalid-reference' });
                expect(await readRows()).toEqual(preparedRows);
                await db.savedSecretAccountGrant.create({ data: { resourceId, accountId: account.id, createdByAccountId: owner.id } });
                expect((await post(activation)).json()).toMatchObject({ status: 'updated', revision: preparedRevision + 1 });
            }
        } finally { await app.close(); }
    });

    it('qualifies Team secret access with the actual route principal during preparation and activation', async () => {
        harness.resetEnv({ HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const evidence = [{ kind: 'home_method' as const, methodId: 'email_password' }];
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain',
            settings: JSON.stringify({ t: 'plain', v: { profiles: [record.definition.profile] } }) } });
        const team = await db.team.create({ data: { name: 'Profile restricted audience',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: evidence } } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        // Genuine current Home credentials; only the verified network evidence is substituted by the incumbent testkit.
        for (const accountId of [owner.id, member.id]) {
            await db.accountIdentity.create({ data: { accountId, provider: 'email', providerUserId: `${accountId}@example.test`, profile: {} } });
            await db.accountPasswordCredential.create({ data: { accountId, credential: { v: 1, kind: 'plain_password_hash',
                hash: await hashPasswordMaterial(new TextEncoder().encode(`profile transfer fixture ${accountId}`)) } } });
        }
        const resourceId = crypto.randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Team token',
            kind: 'token', encryptionMode: 'plain', authentication: { env: process.env, authenticationAuthority: 'present_user', authenticationEvidence: evidence },
            storedContent: { t: 'plain', v: { v: 1, name: 'Team token', kind: 'token', value: 'private-fixture' } }, teamGrants: [team.id] })))
            .toMatchObject({ ok: true });
        const reference = formatSharedSavedSecretRefV1(resourceId);
        const saved = { ...record, secretBindings: { TOKEN: reference } };
        const inventory = [{ kind: 'account_row', id: record.id, revision: 0 }, { kind: 'saved_secret', id: resourceId, revision: 1 }];
        const proof = { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        const prepare = { operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory,
            imports: [{ operation: 'import', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: saved },
                referencedSavedSecretIds: [reference], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }], content: { t: 'plain', v: proof } };
        const activate = { operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory,
            content: { t: 'plain', v: { ...proof, phase: 'active' } } };
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const post = (payload: Record<string, unknown>, qualified: boolean) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
            headers: { 'x-test-user-id': member.id, ...(qualified ? { 'x-test-authentication-evidence': JSON.stringify(evidence) } : {}) }, payload });
        try {
            expect((await post(prepare, false)).json()).toEqual({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: member.id } })).toBe(0);
            expect((await post(prepare, true)).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await post(activate, false)).json()).toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles/transfer', headers: { 'x-test-user-id': member.id } })).json())
                .toMatchObject({ status: 'present', revision: 0, content: { t: 'plain', v: { phase: 'prepared' } } });
            expect((await post(activate, true)).json()).toMatchObject({ status: 'updated', revision: 1 });
        } finally { await app.close(); harness.resetEnv(); }
    });

    it('keeps E2EE authority opaque and makes lost-response replay a control CAS conflict', async () => {
        const keys = tweetnacl.box.keyPair();
        const material = { type: 'dataKey' as const, machineKey: keys.secretKey };
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', settingsVersion: 5,
            settings: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: { profiles: [] }, randomBytes: tweetnacl.randomBytes }),
            ...createSignedAccountContentBinding(keys.publicKey) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const proof = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 5, migratedLogicalRevision: 0, inventory: [] };
        const content = sealProfileTransferContentV1({ mode: 'e2ee', material, record: proof });
        const payload = { operation: 'prepare', imports: [], sourceSettingsVersion: 5, expectedRevision: 'absent', inventory: [], content };
        const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
            headers: { 'x-test-user-id': account.id }, payload });
        try {
            expect((await post({ ...payload, content: { t: 'plain', v: proof } })).json()).toEqual({ status: 'account-mode-mismatch' });
            expect((await post(payload)).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await post(payload)).json()).toEqual({ status: 'conflict', revision: 0 });
            const activeContent = sealProfileTransferContentV1({ mode: 'e2ee', material, record: { ...proof, phase: 'active' } });
            const activation = { operation: 'activate', sourceSettingsVersion: 5, expectedRevision: 0, inventory: [], content: activeContent };
            expect((await post(activation)).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await post(activation)).json()).toEqual({ status: 'conflict', revision: 1 });
            const raw = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY } } });
            expect(JSON.parse(new TextDecoder().decode(raw.value!))).toEqual(activeContent);
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles/transfer', headers: { 'x-test-user-id': account.id } })).json())
                .toEqual({ status: 'present', revision: 1, content: activeContent });
        } finally { await app.close(); }
    });

    it('keeps personal bindings staged until actual promotion remaps rows and fresh preparation captures the resource', async () => {
        const personalId = 'legacy-secret';
        const source = { profiles: [record.definition.profile], secrets: [{ id: personalId, name: 'Token', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-fixture' }, createdAt: 1, updatedAt: 7 }],
            secretBindingsByProfileId: { [record.id]: { TOKEN: personalId } } };
        const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: source }) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const saved = { ...record, secretBindings: { TOKEN: personalId } };
        const inventory = [{ kind: 'account_row', id: saved.id, revision: 0 }];
        const proof = { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer',
            headers: { 'x-test-user-id': account.id }, payload });
        try {
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory,
                imports: [{ operation: 'import', id: saved.id, expectedRevision: 'absent', content: { t: 'plain', v: saved }, referencedSavedSecretIds: ['legacy-secret'] }],
                content: { t: 'plain', v: proof } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await post({ operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...proof, phase: 'active' } } })).json()).toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles/transfer', headers: { 'x-test-user-id': account.id } })).json())
                .toMatchObject({ status: 'present', revision: 0, content: { t: 'plain', v: { phase: 'prepared' } } });
            const resourceId = crypto.randomUUID();
            const reference = formatSharedSavedSecretRefV1(resourceId);
            const rewrite = promotePersonalSavedSecretReference(source, { secretId: personalId, expectedUpdatedAt: 7, sharedSecretRef: reference }, { profileRecords: [saved] });
            const bound = rewrite.profileRecords?.[0];
            expect(bound?.secretBindings).toEqual({ TOKEN: reference });
            const promoted = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/promote',
                headers: { 'x-test-user-id': account.id,
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                payload: { resourceId, displayName: 'Token', kind: 'token', encryptionMode: 'plain',
                    storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private-fixture' } },
                    expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: rewrite.settings },
                    referenceCensus: { accountMode: 'plain', profileTransferRevision: 0,
                        profiles: { referenceGuardRevision: 0, rows: [{ id: saved.id, revision: 0 }] } },
                    profileMutations: [{ operation: 'import', id: saved.id, expectedRevision: 0, content: { t: 'plain', v: bound },
                        referencedSavedSecretIds: [reference], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }] } });
            expect(promoted.statusCode, promoted.body).toBe(200);
            expect(promoted.json()).toEqual({ resourceId, settingsVersion: 1 });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProfilePhysicalKey(saved.id) } } })).version).toBe(1);
            expect((await post({ operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...proof, phase: 'active' } } })).json()).toEqual({ status: 'settings-conflict', revision: 1 });
            const destination = [{ kind: 'account_row', id: saved.id, revision: 1 }, { kind: 'saved_secret', id: resourceId, revision: 1 }];
            const prepared = { ...proof, sourceSettingsVersion: 1, inventory: destination };
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 1, expectedRevision: 0, inventory: destination, imports: [],
                content: { t: 'plain', v: prepared } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await post({ operation: 'activate', sourceSettingsVersion: 1, expectedRevision: 1, inventory: destination,
                content: { t: 'plain', v: { ...prepared, phase: 'active' } } })).json()).toMatchObject({ status: 'updated', revision: 2 });
        } finally { await app.close(); }
    });

    it('preserves a prepared proof through real mode conversion and requires fresh preparation of advanced row revisions', async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const generatedSigning = tweetnacl.sign.keyPair();
        const signing = { publicKey: new Uint8Array(generatedSigning.publicKey), secretKey: new Uint8Array(generatedSigning.secretKey) };
        const generatedKeys = tweetnacl.box.keyPair();
        const keys = { publicKey: new Uint8Array(generatedKeys.publicKey), secretKey: new Uint8Array(generatedKeys.secretKey) };
        const material = { type: 'dataKey' as const, machineKey: keys.secretKey };
        const binding = { contentPublicKey: privacyKit.encodeBase64(keys.publicKey),
            contentPublicKeySig: privacyKit.encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: keys.publicKey })) };
        const source = { profiles: [record.definition.profile] };
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: privacyKit.encodeHex(signing.publicKey),
            contentPublicKey: keys.publicKey, contentPublicKeySig: new Uint8Array(privacyKit.decodeBase64(binding.contentPublicKeySig)), settings: JSON.stringify({ t: 'plain', v: source }) } });
        const inventory = [{ kind: 'account_row' as const, id: record.id, revision: 0 }];
        const prepared = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers, payload });
        try {
            expect((await post({ operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory,
                imports: [{ operation: 'import', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: record }, referencedSavedSecretIds: [] }],
                content: { t: 'plain', v: prepared } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            const captured = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(captured);
            const unsigned: AccountEncryptionMigrateUnsignedRequest = {
                toMode: 'e2ee', expectedAccountVersion: captured.seq, expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint, expectedSettingsVersion: captured.settingsVersion,
                settingsContent: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: source, randomBytes: tweetnacl.randomBytes }) },
                keyProof: { v: 1, publicKey: privacyKit.encodeBase64(signing.publicKey), ...binding },
                connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' },
                todos: { action: 'assert_empty' }, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
                reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
                profileRows: { items: [{ id: record.id, expectedRevision: 0, content: sealProfileRecordContentV1({ mode: 'e2ee', material, record }) }],
                    expectedReferenceGuardRevision: 0, transferControl: { expectedRevision: 0, content: sealProfileTransferContentV1({ mode: 'e2ee', material, record: prepared }) } },
            };
            const signingInput = createAccountEncryptionMigrateProofSigningInputV1({ request: unsigned, accountId: account.id, sourceMode: 'plain' });
            const request = attachAccountEncryptionMigrateProofSignatureV1({ request: unsigned,
                signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(signingInput, signing.secretKey))) });
            const converted = await app.inject({ method: 'POST', url: '/v1/account/encryption/migrate', headers, payload: request });
            expect(converted.statusCode, converted.body).toBe(200);
            expect(converted.json().profileRows).toMatchObject({ referenceGuardRevision: 0, transferControl: { status: 'present', revision: 1 },
                rows: [{ id: record.id, revision: 1 }] });
            expect(openProfileTransferContentV1({ mode: 'e2ee', material, content: converted.json().profileRows.transferControl.content })).toEqual({ status: 'opened', record: prepared });
            const current = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const staleActive = { ...prepared, phase: 'active' as const, sourceSettingsVersion: current.settingsVersion };
            expect((await post({ operation: 'activate', sourceSettingsVersion: current.settingsVersion, expectedRevision: 1, inventory,
                content: sealProfileTransferContentV1({ mode: 'e2ee', material, record: staleActive }) })).json()).toEqual({ status: 'inventory-incomplete' });
            const rebasedInventory = [{ ...inventory[0], revision: 1 }];
            const rebased = { ...prepared, sourceSettingsVersion: current.settingsVersion, inventory: rebasedInventory };
            expect((await post({ operation: 'prepare', sourceSettingsVersion: current.settingsVersion, expectedRevision: 1, inventory: rebasedInventory, imports: [],
                content: sealProfileTransferContentV1({ mode: 'e2ee', material, record: rebased }) })).json()).toMatchObject({ status: 'updated', revision: 2 });
            expect((await post({ operation: 'activate', sourceSettingsVersion: current.settingsVersion, expectedRevision: 2, inventory: rebasedInventory,
                content: sealProfileTransferContentV1({ mode: 'e2ee', material, record: { ...rebased, phase: 'active' } }) })).json()).toMatchObject({ status: 'updated', revision: 3 });
        } finally { await app.close(); }
    });
});

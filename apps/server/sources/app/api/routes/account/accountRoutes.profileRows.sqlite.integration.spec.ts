import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildProfilePhysicalKey, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, PROFILE_TRANSFER_ACCOUNT_KV_KEY,
    PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { mutateProfileRows } from '@/app/account/profiles/profileRows';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { ProfileRecordV1Schema, ProfileProviderConversionMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { getHistoricalBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol/profiles/historicalCompatibilityV1';
import { createLaunchProfilePublisherV1 } from '@happier-dev/protocol/launchProfiles/publishLaunchProfile';
import { readLaunchProfileArtifactV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { ProfileRowReadResponseV1Schema, ProfileRowMutationResponseV1Schema, openProfileRecordContentV1, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { inTx } from '@/storage/inTx';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { randomUUID } from 'node:crypto';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { migrateLegacyAiLaunchProfilesV1 } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

const record = {
    v: 1, id: 'profile-a', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile: {
        v: 2, id: 'profile-a', name: 'Example', extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
    } },
};

describe('Account Profile rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-rows-', initEncrypt: true, initFiles: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('serves a fresh keyless Profile through authenticated domain CAS without rewriting Settings', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); kvRoutes(app);
        const url = PROFILE_RECORDS_ROUTE_V1;
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, payload: { id: record.id } })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles?cursor=outside-domain', headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id, extra: true } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'create', id: record.id, expectedRevision: 'absent', referencedSavedSecretIds: [],
                content: { t: 'plain', v: { ...record, definition: { ...record.definition,
                    profile: { ...record.definition.profile, extraEnvironmentVariables: [{ name: 'TOKEN', value: 'fixture-literal', isSecret: true }] } } } },
            } })).json()).toEqual({ status: 'invalid-reference', reason: 'profile-secret-promotion-required' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'create', id: 'profile-a', expectedRevision: 'absent', content: { t: 'plain', v: record },
                referencedSavedSecretIds: [],
            } })).json()).toMatchObject({ status: 'updated', revision: 0, referenceGuardRevision: 0 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id } })).json()).toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: record } });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers: { 'x-test-user-id': other.id }, payload: { id: record.id } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'update', id: 'profile-a', expectedRevision: 0, content: { t: 'plain', v: { ...record, enabled: false } }, referencedSavedSecretIds: [],
            } })).json()).toMatchObject({ status: 'updated', revision: 1, referenceGuardRevision: 1 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id } })).json()).toMatchObject({ status: 'present', revision: 1, content: { t: 'plain', v: { enabled: false } } });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'update', id: 'profile-a', expectedRevision: 2, content: { t: 'plain', v: { ...record, enabled: false } }, referencedSavedSecretIds: [],
            } })).json()).toEqual({ status: 'conflict', revision: 1 });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles/reference-guard', headers })).json()).toEqual({ status: 'ready', revision: 1 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'GET', url: '/v1/kv?prefix=%40happier%2Faccount%2Fprofiles', headers })).statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it('does not give inactive predecessor Accounts a destination writer', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: { profiles: [] } }) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1,
                headers: { 'x-test-user-id': account.id }, payload: { id: record.id, operation: 'create', expectedRevision: 'absent', content: { t: 'plain', v: record }, referencedSavedSecretIds: [] } });
            expect(response.json()).toEqual({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('admits a lossless captured MachineLogin clone and refuses stale or edited source copies with no writes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const legacy = AIBackendProfileSchema.parse({ id: 'machine-login-source', name: 'Machine login', authMode: 'machineLogin',
            requiresMachineLoginTargetKey: 'agent:claude', requiresMachineLogin: 'claude', isBuiltIn: true,
            environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'retained' }], defaultModelMode: 'retained-model',
            defaultPermissionModeByAgent: { claude: 'default' }, compatibility: { claude: true }, createdAt: 1, updatedAt: 2 });
        const source = ProfileRecordV1Schema.parse({ ...record, id: legacy.id, definition: { kind: 'legacy', profile: legacy },
            enabled: false, secretBindings: { MASKED: null }, promptStack: [{ id: 'stack', ref: { kind: 'doc', artifactId: 'doc-kept' },
                enabled: false, placement: 'system_append' }] });
        const copied = ProfileRecordV1Schema.parse({ ...source, id: 'machine-login-copy', definition: { kind: 'legacy', profile: {
            ...legacy, id: 'machine-login-copy', name: 'Machine login copy', isBuiltIn: false, createdAt: 10, updatedAt: 10 } } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            // Seed predecessor persistence at the database boundary; ordinary authoring cannot import legacy input.
            await db.userKVStore.createMany({ data: [
                { accountId: account.id, key: buildProfilePhysicalKey(source.id), version: 0,
                    value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: source })) },
                { accountId: account.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 0, value: null },
            ] });
            const before = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            const mutation = { id: copied.id, operation: 'clone-legacy', expectedRevision: 'absent', content: { t: 'plain', v: copied },
                referencedSavedSecretIds: [], legacyCloneSource: { id: source.id, revision: 0 } };
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: {
                ...mutation, legacyCloneSource: { id: source.id, revision: 1 } } })).json()).toEqual({ status: 'conflict', revision: 0 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                content: { t: 'plain', v: { ...copied, definition: { kind: 'legacy', profile: {
                    ...(copied.definition.kind === 'legacy' ? copied.definition.profile : legacy),
                    environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'changed' }] } } } } } })).json())
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(before);
            const cloned = await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: mutation });
            expect(cloned.statusCode, cloned.body).toBe(200);
            expect(cloned.json()).toMatchObject({ status: 'updated', revision: 0, referenceGuardRevision: 1 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: copied.id } })).json())
                .toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: copied } });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: source.id } })).json())
                .toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: source } });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
        } finally { await app.close(); }
    });

    it.each([true, false])('atomically creates builtin membership and retires only its enablement source, fencing prior preference writers (source=%s)', async present => {
        const id = 'azure-openai';
        const enabledById = { 'gemini-api-key': true, ...(present ? { [id]: false } : {}) };
        const preferences = { profileEnabledById: enabledById, favoriteProfiles: [id], defaultProfileId: id,
            themePreference: 'dark', future: { keep: true } };
        const nextPreferences = { ...preferences, profileEnabledById: { 'gemini-api-key': true } };
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3,
            settings: JSON.stringify({ t: 'plain', v: preferences }) } });
        const builtin = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'legacy', profile: getBuiltInBackendProfile(id) },
            enabled: !present, promptStack: [], secretBindings: {} });
        const mutation = { id, operation: 'attach-builtin', expectedRevision: 'absent', referencedSavedSecretIds: [],
            content: { t: 'plain', v: builtin } };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: mutation })).json())
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(3);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                settingsCleanup: { expectedSettingsVersion: 2, nextSettings: { t: 'plain', v: nextPreferences } } } })).json())
                .toEqual({ status: 'settings-conflict', revision: 3 });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                settingsCleanup: { expectedSettingsVersion: 3,
                    nextSettings: { t: 'plain', v: { ...nextPreferences, favoriteProfiles: [] } } } } })).json())
                .toMatchObject({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                settingsCleanup: { expectedSettingsVersion: 3, nextSettings: { t: 'plain', v: nextPreferences } } } })).json())
                .toMatchObject({ status: 'updated', revision: 0, referenceGuardRevision: 0 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id } })).json())
                .toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: builtin } });
            expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json())
                .toMatchObject({ version: 4, content: { t: 'plain', v: nextPreferences } });
            const rows = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            expect(await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 3,
                next: { kind: 'v2', content: { t: 'plain', v: { ...preferences, profileEnabledById: { ...enabledById, [id]: true } } } } })))
                .toMatchObject({ status: 'version_mismatch', currentVersion: 4 });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(rows);
        } finally { await app.close(); }
    });

    it.each(['header', 'body'] as const)('requires a current addressed Artifact capture even when selected secret references do not change (%s)', async changed => {
        const id = 'captured-artifact-profile';
        const artifactId = randomUUID();
        const preferences = { themePreference: 'dark', future: { keep: true } };
        const settings = JSON.stringify({ t: 'plain', v: preferences });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 5, settings } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app); artifactsRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const profile = { ...record.definition.profile, id };
        const content = { kind: 'launch-profile.v1', profile, secretBindings: {} };
        const artifactHeader = { kind: 'launch-profile.v1', profileId: id, name: profile.name };
        try {
            const created = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id: artifactId, header: encodePlainArtifactStoredContent(artifactHeader),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
            expect(created.statusCode, created.body).toBe(200);
            const capturedResponse = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers });
            expect(capturedResponse.statusCode, capturedResponse.body).toBe(200);
            const captured = capturedResponse.json<{ headerVersion: number; bodyVersion: number }>();
            const changedArtifact = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifactId}`, headers, payload: changed === 'header'
                ? { header: encodePlainArtifactStoredContent({ ...artifactHeader, title: 'Changed only title' }), expectedHeaderVersion: captured.headerVersion }
                : { body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...content,
                    profile: { ...profile, updatedAt: 2 } }) }), expectedBodyVersion: captured.bodyVersion } });
            expect(changedArtifact.json()).toMatchObject({ success: true });
            const attached = ProfileRecordV1Schema.parse({ ...record, id, definition: { kind: 'artifact', artifactId } });
            const mutation = { id, operation: 'create', expectedRevision: 'absent', content: { t: 'plain', v: attached }, referencedSavedSecretIds: [] };
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: mutation })).json())
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                artifactRevision: { artifactId, headerVersion: captured.headerVersion, bodyVersion: captured.bodyVersion } } })).json())
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 5, settings });
            const currentResponse = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers });
            expect(currentResponse.statusCode, currentResponse.body).toBe(200);
            const current = currentResponse.json<{ headerVersion: number; bodyVersion: number }>();
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: { ...mutation,
                artifactRevision: { artifactId, headerVersion: current.headerVersion, bodyVersion: current.bodyVersion } } })).json())
                .toMatchObject({ status: 'updated', revision: 0, referenceGuardRevision: 0 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 5, settings });
        } finally { await app.close(); }
    });

    it('imports and addresses the exact long untrimmed predecessor identity through real SQLite and HTTP', async () => {
        const id = `  legacy/branch\\資料/😀-${'x'.repeat(300)}  `;
        const legacy = AIBackendProfileSchema.parse({ id, name: 'Retained predecessor', isBuiltIn: false, createdAt: 0, updatedAt: 0 });
        const retained = ProfileRecordV1Schema.parse({ ...record, id, definition: { kind: 'legacy', profile: legacy } });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 2,
            settings: JSON.stringify({ t: 'plain', v: { profiles: [legacy] } }) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const inventory = [{ kind: 'account_row', id, revision: 0 }];
        const control = { v: 1, phase: 'prepared', sourceSettingsVersion: 2, migratedLogicalRevision: 0, inventory };
        try {
            expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers, payload: {
                operation: 'prepare', sourceSettingsVersion: 2, expectedRevision: 'absent', inventory,
                imports: [{ id, operation: 'import', expectedRevision: 'absent', content: { t: 'plain', v: retained }, referencedSavedSecretIds: [] }],
                content: { t: 'plain', v: control },
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id,
                key: buildProfilePhysicalKey(id) } } })).version).toBe(0);
            expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers, payload: {
                operation: 'activate', sourceSettingsVersion: 2, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...control, phase: 'active' } },
            } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles', headers })).json())
                .toMatchObject({ status: 'listed', complete: true,
                    rows: [{ id, revision: 0, content: { t: 'plain', v: retained } }] });
            const url = PROFILE_RECORDS_ROUTE_V1;
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id } })).json())
                .toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: retained } });
            expect((await app.inject({ method: 'POST', url, headers, payload: { id, operation: 'update', expectedRevision: 0,
                content: { t: 'plain', v: { ...retained, enabled: false } }, referencedSavedSecretIds: [] } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
        } finally { await app.close(); }
    });

    it('keeps a retained readonly blueprint unchanged while updating its private attachment', async () => {
        const preferences = { favoriteProfiles: ['azure-openai'], profileEnabledById: { 'azure-openai': false }, future: { keep: true } };
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3,
            settings: JSON.stringify({ t: 'plain', v: preferences }) } });
        const retained = ProfileRecordV1Schema.parse({ ...record, id: 'azure-openai',
            definition: { kind: 'legacy', profile: { ...getBuiltInBackendProfile('azure-openai'), name: 'Retained predecessor preset' } } });
        await db.userKVStore.createMany({ data: [
            { accountId: account.id, key: buildProfilePhysicalKey(retained.id), version: 2,
                value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: retained })) },
            { accountId: account.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 4, value: null },
        ] });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const url = PROFILE_RECORDS_ROUTE_V1;
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'update', id: retained.id, expectedRevision: 2, referencedSavedSecretIds: [],
                content: { t: 'plain', v: { ...retained, definition: { kind: 'legacy',
                    profile: { ...getBuiltInBackendProfile('azure-openai'), name: 'Changed readonly preset' } } } },
            } })).json()).toEqual({ status: 'invalid-reference', reason: 'profile-read-only' });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: retained.id } })).json()).toMatchObject({ status: 'present', revision: 2,
                content: { t: 'plain', v: retained } });
            const next = { ...retained, promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'prompt-artifact' },
                enabled: true, placement: 'system_append' }] };
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'update', id: retained.id, expectedRevision: 2, referencedSavedSecretIds: [], content: { t: 'plain', v: next },
            } })).json()).toMatchObject({ status: 'updated', revision: 3, referenceGuardRevision: 5 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: retained.id } })).json()).toMatchObject({ status: 'present', revision: 3,
                content: { t: 'plain', v: next } });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'remove', id: retained.id, expectedRevision: 3, content: null,
                settingsCleanup: { expectedSettingsVersion: 3,
                    nextSettings: { t: 'plain', v: { ...preferences, favoriteProfiles: [], profileEnabledById: {} } } },
            } })).json()).toMatchObject({ status: 'updated', revision: 4, referenceGuardRevision: 6 });
            expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json())
                .toMatchObject({ version: 4, content: { t: 'plain', v: { ...preferences, favoriteProfiles: [], profileEnabledById: {} } } });
        } finally { await app.close(); }
    });

    it('does not let a preparation import resurrect a retained tombstone', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userKVStore.create({ data: { accountId: account.id, key: buildProfilePhysicalKey(record.id), version: 3, value: null } });
        expect(await mutateProfileRows({ accountId: account.id, mutations: [{ id: record.id, operation: 'import', expectedRevision: 3,
            content: { t: 'plain', v: { v: 1, id: record.id, definition: { kind: 'artifact', artifactId: 'retained-artifact' }, enabled: true, promptStack: [], secretBindings: {} } }, referencedSavedSecretIds: [] }] })).toEqual({ status: 'conflict', revision: 3 });
        expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProfilePhysicalKey(record.id) } } })).value).toBeNull();
    });

    it('rolls back removal and guard advancement when the preference cleanup capture is stale', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3,
            settings: JSON.stringify({ t: 'plain', v: { favoriteProfiles: ['profile-a'], themePreference: 'dark', future: { keep: true } } }),
        } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const url = PROFILE_RECORDS_ROUTE_V1;
        try {
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'create', id: record.id, expectedRevision: 'absent', content: { t: 'plain', v: record }, referencedSavedSecretIds: [],
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'remove', id: record.id, expectedRevision: 0, content: null,
                settingsCleanup: { expectedSettingsVersion: 2, nextSettings: { t: 'plain', v: { favoriteProfiles: [], themePreference: 'dark', future: { keep: true } } } },
            } })).json()).toEqual({ status: 'settings-conflict', revision: 3 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id } })).json()).toMatchObject({ status: 'present', revision: 0 });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/profiles/reference-guard', headers })).json()).toEqual({ status: 'ready', revision: 0 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(3);
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                operation: 'remove', id: record.id, expectedRevision: 0, content: null,
                settingsCleanup: { expectedSettingsVersion: 3, nextSettings: { t: 'plain', v: { favoriteProfiles: [], themePreference: 'dark', future: { keep: true } } } },
            } })).json()).toMatchObject({ status: 'updated', revision: 1, referenceGuardRevision: 1 });
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id: record.id } })).json()).toEqual({ status: 'deleted', revision: 1 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
        } finally { await app.close(); }
    });

    it('commits Provider catalog, converted Profile rows and one Settings CAS together, refusing a stale complete census without writes', async () => {
        const sourceRecord = ProfileRecordV1Schema.parse({ ...record, id: 'deepseek', enabled: false, definition: { kind: 'legacy',
            profile: AIBackendProfileSchema.parse({ id: 'deepseek', name: 'DeepSeek', isBuiltIn: true, createdAt: 0, updatedAt: 0,
                environmentVariables: [{ name: 'DEEPSEEK_BASE_URL', value: 'https://api.deepseek.com' }] }) },
            promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'prompt-artifact' }, enabled: true, placement: 'system_append' }] });
        if (sourceRecord.definition.kind !== 'legacy') throw new Error('Expected a captured legacy source');
        const migration = migrateLegacyAiLaunchProfilesV1({ themePreference: 'dark', profiles: [sourceRecord.definition.profile] }, DEFAULT_PROVIDER_SETTINGS_V1, {
            migratedAt: 20, pendingCustomProfileIds: [], candidates: [{ kind: 'connection', sourceProfileId: sourceRecord.id,
                connection: { v: 1, id: 'pc-deepseek', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                    role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic', revision: 0, createdAt: 20, updatedAt: 20 },
                removedEnvironmentVariableNames: ['DEEPSEEK_BASE_URL'], selectedModel: { agentTargetKey: 'agent:claude', modelId: 'deepseek-reasoner' } }] },
            { lastUsedProfile: null }, { profileRecordIds: [sourceRecord.id], records: [{ record: sourceRecord, revision: 2 }] });
        if (!migration.ok || !Array.isArray(migration.settings.profiles)) throw new Error('Expected the incumbent Provider translation');
        const converted = ProfileRecordV1Schema.parse({ ...sourceRecord,
            definition: { kind: 'inline', profile: migration.settings.profiles[0] } });
        const { catalog: providerCatalog, defaults } = splitProviderSettingsV1(migration.providerSettings);
        const nextSettings = { themePreference: 'light', providerDefaultModelSelectionsByAgentTargetKeyV1: defaults };
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { themePreference: 'dark' } }) } });
        const control = { v: 1, phase: 'active', sourceSettingsVersion: 3, migratedLogicalRevision: 3,
            inventory: [{ kind: 'account_row', id: sourceRecord.id, revision: 2 }] };
        await db.userKVStore.createMany({ data: [
            { accountId: account.id, key: buildProfilePhysicalKey(sourceRecord.id), version: 2, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: sourceRecord })) },
            { accountId: account.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 6, value: null },
            { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY, version: 1, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: control })) },
        ] });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const payload = ProfileProviderConversionMutationV1Schema.parse({ operation: 'provider-conversion', expectedAccountMode: 'plain', expectedSettingsVersion: 4,
            expectedProfileTransferRevision: 1, expectedReferenceGuardRevision: 6, profileCensus: [{ id: sourceRecord.id, revision: 2 }],
            providerMutation: { expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: providerCatalog }, referencedSavedSecretIds: [], savedSecretRevisions: [] },
            mutations: [{ operation: 'update', id: sourceRecord.id, expectedRevision: 2, content: { t: 'plain', v: converted }, referencedSavedSecretIds: [] }],
            nextSettings: { t: 'plain', v: nextSettings } });
        try {
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1,
                headers: { 'x-test-user-id': account.id }, payload: payload.mutations[0] })).json())
                .toEqual({ status: 'invalid-reference', reason: 'profile-read-only' });
            const before = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            const { sourceSettingsVersion: _sourceVersion, ...providerUpdate } = payload.providerMutation;
            const staleProvider = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion',
                headers: { 'x-test-user-id': account.id }, payload: ProfileProviderConversionMutationV1Schema.parse({ ...payload,
                    providerMutation: { ...providerUpdate, expectedRevision: 0 } }) });
            expect(staleProvider.json()).toEqual({ status: 'provider-conflict', revision: -1 });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(before);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
            const response = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion', headers: { 'x-test-user-id': account.id }, payload });
            expect(response.json()).toMatchObject({ status: 'updated', settingsVersion: 5, providerRevision: 0, referenceGuardRevision: 7 });
            const providerRow = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } } });
            expect(providerRow.version).toBe(0);
            expect(JSON.parse(new TextDecoder().decode(providerRow.value!))).toEqual({ t: 'plain', v: providerCatalog });
            expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers: { 'x-test-user-id': account.id } })).json())
                .toMatchObject({ version: 5, content: { t: 'plain', v: nextSettings } });
            expect(converted.definition).toMatchObject({ kind: 'inline', profile: {
                preferredModelSelection: { ref: { providerConnectionId: 'pc-deepseek', modelId: 'deepseek-reasoner' } } } });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1,
                headers: { 'x-test-user-id': account.id }, payload: { id: sourceRecord.id } })).json())
                .toEqual({ status: 'present', revision: 3, content: { t: 'plain', v: converted } });
            const committed = await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } });
            const providerConflict = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion',
                headers: { 'x-test-user-id': account.id }, payload: { ...payload, expectedSettingsVersion: 5,
                    expectedReferenceGuardRevision: 7, profileCensus: [{ id: sourceRecord.id, revision: 3 }],
                    mutations: [{ ...payload.mutations[0], expectedRevision: 3 }],
                    providerMutation: { ...payload.providerMutation, sourceSettingsVersion: 5 } } });
            expect(providerConflict.json()).toEqual({ status: 'provider-conflict', revision: 0 });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(committed);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
            if (converted.definition.kind !== 'inline') throw new Error('Expected converted inline Profile');
            const refusedProfile = ProfileRecordV1Schema.parse({ ...converted, definition: { kind: 'inline', profile: {
                ...converted.definition.profile, extraEnvironmentVariables: [{ name: 'PRIVATE_TOKEN', value: 'unpromoted', isSecret: true }],
            } } });
            const refused = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion',
                headers: { 'x-test-user-id': account.id }, payload: { ...payload, expectedSettingsVersion: 5,
                    expectedReferenceGuardRevision: 7, profileCensus: [{ id: sourceRecord.id, revision: 3 }],
                    mutations: [{ ...payload.mutations[0], expectedRevision: 3, content: { t: 'plain', v: refusedProfile } }],
                    providerMutation: { expectedRevision: 0, content: payload.providerMutation.content,
                        referencedSavedSecretIds: [], savedSecretRevisions: [] } } });
            expect(refused.json()).toEqual({ status: 'invalid-reference', reason: 'profile-secret-promotion-required' });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(committed);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
            const stale = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion', headers: { 'x-test-user-id': account.id }, payload });
            expect(stale.json().status).not.toBe('updated');
            expect(await db.userKVStore.findMany({ where: { accountId: account.id }, orderBy: { key: 'asc' } })).toEqual(committed);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
            expect((await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1,
                headers: { 'x-test-user-id': account.id }, payload: { ...payload.mutations[0], expectedRevision: 3,
                    content: { t: 'plain', v: { ...converted, enabled: true } } } })).json())
                .toMatchObject({ status: 'updated', revision: 4, referenceGuardRevision: 8 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(5);
        } finally { await app.close(); }
    });

    it('commits Provider catalog and genuine inactive Profile source cleanup without creating Profile row authority', async () => {
        const legacy = getHistoricalBuiltInAiLaunchProfileV1('deepseek');
        if (!legacy) throw new Error('Historical DeepSeek source unavailable');
        const source = { themePreference: 'dark', profiles: [legacy] };
        const migration = migrateLegacyAiLaunchProfilesV1(source, DEFAULT_PROVIDER_SETTINGS_V1, {
            migratedAt: 20, pendingCustomProfileIds: [], candidates: [{ kind: 'connection', sourceProfileId: legacy.id,
                connection: { v: 1, id: 'pc-inactive', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                    role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic', revision: 0, createdAt: 20, updatedAt: 20 } }],
        }, { lastUsedProfile: null });
        if (!migration.ok) throw new Error('Expected genuine source conversion');
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: source }) } });
        const { catalog, defaults } = splitProviderSettingsV1(migration.providerSettings);
        const nextSettings = { ...migration.settings, providerDefaultModelSelectionsByAgentTargetKeyV1: defaults };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/provider-conversion',
                headers: { 'x-test-user-id': account.id }, payload: ProfileProviderConversionMutationV1Schema.parse({
                    operation: 'provider-conversion', expectedAccountMode: 'plain', expectedSettingsVersion: 4,
                    expectedProfileTransferRevision: 'absent', expectedReferenceGuardRevision: 'absent', profileCensus: [], mutations: [],
                    providerMutation: { expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: catalog },
                        referencedSavedSecretIds: [], savedSecretRevisions: [] }, nextSettings: { t: 'plain', v: nextSettings },
                }) });
            expect(response.json()).toMatchObject({ status: 'updated', settingsVersion: 5, providerRevision: 0, rows: [], referenceGuardRevision: 'absent' });
            expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers: { 'x-test-user-id': account.id } })).json())
                .toMatchObject({ version: 5, content: { t: 'plain', v: nextSettings } });
            expect(await db.userKVStore.findMany({ where: { accountId: account.id } })).toMatchObject([
                { key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, version: 0 },
            ]);
        } finally { await app.close(); }
    });

    it('publishes a genuinely admitted private builtin through the Artifact HTTP owner while preserving private membership', async () => {
        const legacy = getHistoricalBuiltInAiLaunchProfileV1('gemini-api-key');
        if (!legacy) throw new Error('Historical Gemini fixture unavailable');
        const account = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: { profiles: [legacy] } }) } });
        const resourceId = randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId,
            displayName: 'Private Gemini key', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Private Gemini key', kind: 'token', value: 'private-fixture' } } })))
            .toMatchObject({ ok: true });
        const secretReference = formatSharedSavedSecretRefV1(resourceId);
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); artifactsRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const privateDocId = randomUUID();
        const publishedId = randomUUID();
        const createArtifact = async (artifactId: string, header: Readonly<Record<string, unknown>>, body: string) => {
            const response = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id: artifactId, header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } });
            expect(response.statusCode, response.body).toBe(200);
        };
        const readRecord = async (id: string) => {
            const response = await app.inject({ method: 'POST', url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id } });
            const row = ProfileRowReadResponseV1Schema.parse(response.json());
            if (row.status !== 'present') return null;
            const opened = openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: id, content: row.content });
            if (opened.status !== 'opened') throw new Error(opened.reason);
            return { record: opened.record, revision: row.revision };
        };
        try {
            await createArtifact(privateDocId, PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2', title: 'Private prompt' }),
                JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1, markdown: 'Private prompt', createdAtMs: 0, updatedAtMs: 0 })));
            const retained = ProfileRecordV1Schema.parse({ v: 1, id: legacy.id, definition: { kind: 'legacy', profile: legacy }, enabled: false,
                promptStack: [{ id: 'private-entry', ref: { kind: 'doc', artifactId: privateDocId }, enabled: true, placement: 'system_append' }],
                secretBindings: { GEMINI_API_KEY: secretReference } });
            const inventory = [{ kind: 'account_row', id: retained.id, revision: 0 }, { kind: 'saved_secret', id: resourceId, revision: 1 }];
            const control = { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
            expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers, payload: {
                operation: 'prepare', sourceSettingsVersion: 0, expectedRevision: 'absent', inventory,
                imports: [{ id: retained.id, operation: 'import', expectedRevision: 'absent', content: { t: 'plain', v: retained },
                    referencedSavedSecretIds: [secretReference], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }],
                content: { t: 'plain', v: control },
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/profiles/transfer', headers, payload: {
                operation: 'activate', sourceSettingsVersion: 0, expectedRevision: 0, inventory,
                content: { t: 'plain', v: { ...control, phase: 'active' } },
            } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            let captured: ProfileRecordV1 | null = null;
            const publisher = createLaunchProfilePublisherV1({ profileStore: {
                read: async id => { const current = await readRecord(id); captured = current?.record ?? null; return current; },
                updateDefinition: async input => {
                    if (!captured || captured.id !== input.profileId) throw new Error('Profile capture unavailable');
                    const artifactResponse = await app.inject({ method: 'GET', url: `/v1/artifacts/${input.artifactId}`, headers });
                    expect(artifactResponse.statusCode, artifactResponse.body).toBe(200);
                    const artifact = artifactResponse.json<{ headerVersion: number; bodyVersion: number }>();
                    const response = await app.inject({ method: 'POST', url: PROFILE_RECORDS_ROUTE_V1, headers, payload: {
                        id: input.profileId, operation: 'update', expectedRevision: input.expectedRevision,
                        content: { t: 'plain', v: { ...captured, definition: { kind: 'artifact', artifactId: input.artifactId } } },
                        referencedSavedSecretIds: [secretReference], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }],
                        artifactRevision: { artifactId: input.artifactId, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
                    } });
                    const result = ProfileRowMutationResponseV1Schema.parse(response.json());
                    if (result.status !== 'updated') throw Object.assign(new Error(`Profile publication refused: ${result.status}${'reason' in result ? ` (${result.reason})` : ''}`), { refusal: result });
                },
            }, artifactStore: {
                create: async input => { await createArtifact(publishedId, input.header, input.body); return { artifactId: publishedId }; },
                read: async artifactId => {
                    const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers });
                    if (response.statusCode === 404) return null;
                    expect(response.statusCode, response.body).toBe(200);
                    const resource = response.json<{ header: string; body: string; headerVersion: number; bodyVersion: number }>();
                    return { artifactId, header: ArtifactHeaderMetadataV1Schema.parse(decodePlainArtifactStoredContent(resource.header)),
                        body: ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(resource.body)).body,
                        revision: { headerVersion: resource.headerVersion, bodyVersion: resource.bodyVersion } };
                },
            } });
            await expect(publisher.publish({ profileId: retained.id })).resolves.toEqual({ artifactId: publishedId });
            expect(await readRecord(retained.id)).toEqual({ record: { ...retained, definition: { kind: 'artifact', artifactId: publishedId } }, revision: 1 });
            const published = await app.inject({ method: 'GET', url: `/v1/artifacts/${publishedId}`, headers });
            const resource = published.json<{ header: string; body: string }>();
            const opened = readLaunchProfileArtifactV1({ artifactId: publishedId,
                header: ArtifactHeaderMetadataV1Schema.parse(decodePlainArtifactStoredContent(resource.header)),
                body: ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(resource.body)).body });
            expect(opened).toMatchObject({ profile: { id: retained.id, environmentVariables: [] }, secretBindings: {} });
            expect(opened).not.toHaveProperty('promptStack');
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
            expect(await publisher.publish({ profileId: retained.id })).toEqual({ artifactId: publishedId });
        } finally { await app.close(); }
    });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { updateAccountEncryptionMode } from './updateAccountEncryptionMode';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1, ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema,
    sealAcpCatalogContentV1, openAcpCatalogContentV1, type AcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import tweetnacl from 'tweetnacl';
import { encodeBase64, encodeHex } from 'privacy-kit';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { signAccountContentKeyBindingV1, attachAccountEncryptionMigrateProofSignatureV1, createAccountEncryptionMigrateProofSigningInputV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    type AccountEncryptionMigrateUnsignedRequest } from '@happier-dev/protocol';

const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'configured', name: 'configured', title: 'Configured',
    command: 'configured-agent', args: ['--acp'], env: { PUBLIC_CONFIG: { t: 'literal', v: 'retained' } },
    capabilities: {}, defaultModel: 'selected-model', createdAt: 1, updatedAt: 2 }] });

describe('Account configured ACP catalog (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-acp-catalog-' });
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('serves one admitted catalog with CAS and prevents retained-source replacement', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const retained = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7,
            settings: JSON.stringify({ t: 'plain', v: { acpCatalogSettingsV1: { v: 2, backends: record.definitions } } }) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); kvRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const content = { t: 'plain', v: record };
        const initial = { expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 7, content };
        try {
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1 })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { ...initial, sourceSettingsVersion: 6 } })).json()).toEqual({ status: 'settings-conflict', revision: 7 });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': retained.id }, payload: { ...initial, content: { t: 'plain', v: { v: 1, definitions: [] } } } })).json())
                .toEqual({ status: 'source-transfer-required' });
            expect(await db.userKVStore.count({ where: { accountId: retained.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: initial })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers })).json())
                .toEqual({ status: 'present', revision: 0, content });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { expectedRevision: 1, content } })).json()).toEqual({ status: 'conflict', revision: 0 });
            expect((await app.inject({ method: 'GET', url: `/v1/kv/${encodeURIComponent(ACP_CATALOG_ACCOUNT_ROW_KEY_V1)}`, headers })).statusCode).toBe(400);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('refuses the retained empty-only mode-change ingress for populated ACP data', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: record })) } });
        expect(await updateAccountEncryptionMode({ accountId: account.id, mode: 'plain' })).toEqual({ status: 'migration_required' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe('e2ee');
    });

    it('retains raw incomplete inventory on read and refuses projection-based replacement', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const content = { t: 'plain', v: { ...record, extension: { futureCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:future' } } },
            futureEnvelopeCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:outer' } };
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 3,
            value: new TextEncoder().encode(JSON.stringify(content)) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers })).json())
                .toEqual({ status: 'present', revision: 3, content });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { expectedRevision: 3, content: { t: 'plain', v: record } } })).json())
                .toEqual({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
        } finally { await app.close(); }
    });

    it('requires complete declared and captured SavedSecret use authority before binding', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const secretId = 'happier:shared-secret:v1:missing';
        const secretRecord = AcpCatalogRecordV1Schema.parse({ ...record,
            definitions: record.definitions.map(definition => ({ ...definition, env: { TOKEN: { t: 'savedSecret', secretId } } })) });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            for (const referencedSavedSecretIds of [[], [secretId]]) {
                expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers: { 'x-test-user-id': account.id },
                    payload: { expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 0,
                        content: { t: 'plain', v: secretRecord }, referencedSavedSecretIds,
                        savedSecretRevisions: [{ resourceId: 'missing', expectedRevision: 0 }] } })).json())
                    .toEqual({ status: 'invalid-reference' });
                expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            }
        } finally { await app.close(); }
    });

    it.each(['mutation', 'conversion'] as const)('refuses replacement when an opaque ACP envelope has an outer Secret carrier (%s)', async operation => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const content = sealAcpCatalogContentV1({ record, mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(43) } });
        const retained = { ...content, futureEnvelopeCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:outer' } };
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 3,
            value: new TextEncoder().encode(JSON.stringify(retained)) } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        try {
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers })).json())
                .toEqual({ status: 'present', revision: 3, content: retained });
            if (operation === 'mutation') {
                expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                    payload: { expectedRevision: 3, content } })).json()).toEqual({ status: 'invalid-stored-content' });
            } else {
                const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
                const response = await app.inject({ method: 'POST', url: '/v1/account/encryption/migrate', headers,
                    payload: { toMode: 'plain', expectedAccountVersion: account.seq,
                        expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                        expectedSettingsVersion: 0, settingsContent: null, acpCatalog: { expectedRevision: 3, content: { t: 'plain', v: record } },
                        connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' },
                        todos: { action: 'assert_empty' }, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
                        reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' } } });
                expect(response.statusCode, response.body).toBe(400);
            }
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe('e2ee');
        } finally { await app.close(); }
    });

    it('prevents direct Settings reseeding after ACP authority, while retained legacy Accounts remain writable', async () => {
        const content = { t: 'plain' as const, v: { acpCatalogSettingsV1: { v: 2, backends: record.definitions } } };
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: record })) } });
        expect(await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 0,
            next: { kind: 'v2', content } }))).toEqual({ status: 'invalid_content' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
        const legacy = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await inTx(tx => writeAccountSettingsInTx({ tx, accountId: legacy.id, expectedVersion: 0,
            next: { kind: 'v2', content } }))).toEqual({ status: 'success', version: 1 });
        const incomplete = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify(content) } });
        await db.userKVStore.create({ data: { accountId: incomplete.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { ...record,
                hidden: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:future' } } })) } });
        expect(await inTx(tx => writeAccountSettingsInTx({ tx, accountId: incomplete.id, expectedVersion: 0,
            next: { kind: 'v2', content: { t: 'plain', v: {} } } }))).toEqual({ status: 'invalid_content' });
        expect((await db.account.findUniqueOrThrow({ where: { id: incomplete.id } })).settings).toBe(JSON.stringify(content));
    });

    it('activates only an exact captured predecessor transfer before ordinary user CAS', async () => {
        const settings = JSON.stringify({ t: 'plain', v: { acpCatalogSettingsV1: {
            v: 2, backends: record.definitions.map(definition => ({ ...definition, transportProfile: 'generic' })),
        }, unrelatedPreference: 'retained' } });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 11, settings } });
        const changedRecord = { ...record, definitions: record.definitions.map(definition => ({ ...definition, defaultModel: 'new-intent' })) };
        const initial = { expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 11,
            content: { t: 'plain', v: record }, settingsCleanup: { expectedSettingsVersion: 11,
                nextSettings: { t: 'plain', v: { unrelatedPreference: 'retained' } } } };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { ...initial, content: { t: 'plain', v: changedRecord } } })).json())
                .toEqual({ status: 'source-transfer-required' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            const wrongCleanup = await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { ...initial, settingsCleanup: { expectedSettingsVersion: 11, nextSettings: { t: 'plain', v: {} } } } });
            expect(wrongCleanup.json()).toEqual({ status: 'source-transfer-required' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settings).toBe(settings);
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: initial })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
                settings: JSON.stringify(initial.settingsCleanup.nextSettings), settingsVersion: 12 });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { expectedRevision: 0, content: { t: 'plain', v: changedRecord } } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers })).json())
                .toEqual({ status: 'present', revision: 1, content: { t: 'plain', v: changedRecord } });
        } finally { await app.close(); }
    });

    it('commits opaque E2EE source cleanup with catalog admission under the same captured Settings CAS', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(),
            settingsVersion: 11, settings: 'captured-encrypted-source' } });
        const content = sealAcpCatalogContentV1({ record, mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(43) } });
        const initial = { expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 11, content,
            settingsCleanup: { expectedSettingsVersion: 11, nextSettings: { t: 'encrypted', c: 'captured-cleaned-settings' } } };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { ...initial, sourceSettingsVersion: 10, settingsCleanup: { ...initial.settingsCleanup, expectedSettingsVersion: 10 } } })).json())
                .toEqual({ status: 'settings-conflict', revision: 11 });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers,
                payload: { ...initial, settingsCleanup: { expectedSettingsVersion: 11, nextSettings: { t: 'plain', v: {} } } } })).json())
                .toEqual({ status: 'account-mode-mismatch' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 11, settings: 'captured-encrypted-source' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: initial })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 12, settings: 'captured-cleaned-settings' });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: initial })).json())
                .toMatchObject({ status: 'conflict', revision: 0 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(12);
        } finally { await app.close(); }
    });

    it('removes an explicit empty fresh source only with exact captured cleanup and no unrelated loss', async () => {
        const settings = JSON.stringify({ t: 'plain', v: { acpCatalogSettingsV1: { v: 2, backends: [] }, unrelatedPreference: 'retained' } });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4, settings } });
        const initial = { expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 4, content: { t: 'plain', v: record } };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: initial })).json())
                .toEqual({ status: 'source-transfer-required' });
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: { ...initial,
                settingsCleanup: { expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: {} } } } })).json())
                .toEqual({ status: 'source-transfer-required' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settings).toBe(settings);
            expect((await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload: { ...initial,
                settingsCleanup: { expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: { unrelatedPreference: 'retained' } } } } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 5,
                settings: JSON.stringify({ t: 'plain', v: { unrelatedPreference: 'retained' } }) });
        } finally { await app.close(); }
    });

    it('refuses malformed, future and incomplete retained source without empty activation or cleanup', async () => {
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            for (const source of [{}, { v: 2 }, { v: 3, backends: [] }, { v: 2, backends: [],
                futureCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:future' } }]) {
                const settings = JSON.stringify({ t: 'plain', v: { acpCatalogSettingsV1: source } });
                const account = await db.account.create({ data: { encryptionMode: 'plain', settings } });
                const response = await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1,
                    headers: { 'x-test-user-id': account.id }, payload: { expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 0,
                        content: { t: 'plain', v: { v: 1, definitions: [] } }, settingsCleanup: { expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: {} } } } });
                expect(response.json()).toEqual({ status: 'source-transfer-required' });
                expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 0, settings });
            }
        } finally { await app.close(); }
    });

    it('rolls back catalog admission and hints when canonical Settings storage refuses source cleanup', async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'sealed' });
        const settings = JSON.stringify({ t: 'plain', v: { acpCatalogSettingsV1: { v: 2, backends: record.definitions } } });
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 2, settings } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: ACP_CATALOG_ROWS_ROUTE_V1, headers: { 'x-test-user-id': account.id },
                payload: { expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 2, content: { t: 'plain', v: record },
                    settingsCleanup: { expectedSettingsVersion: 2, nextSettings: { t: 'plain', v: {} } } } });
            expect(response.json()).toEqual({ status: 'invalid-stored-content' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ settingsVersion: 2, settings });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
            await app.close();
        }
    });

    it.each(['plain', 'e2ee'] as const)('guards a singleton tombstone capture during conversion without resurrecting or advancing it (%s)', async fromMode => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1' });
        const signing = tweetnacl.sign.keyPair();
        const recipient = tweetnacl.box.keyPair().publicKey;
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
        const account = await db.account.create({ data: { encryptionMode: fromMode, publicKey: encodeHex(signing.publicKey),
            contentPublicKey: recipient, contentPublicKeySig } });
        const toMode = fromMode === 'plain' ? 'e2ee' as const : 'plain' as const;
        const tombstone = await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 9, value: null } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const base = { toMode, expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0, settingsContent: null, connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' },
            machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' }, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
            reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' } } satisfies AccountEncryptionMigrateUnsignedRequest;
        const buildRequest = (acpCatalog?: { expectedRevision: number; content: null }) => {
            const request = { ...base, ...(acpCatalog ? { acpCatalog } : {}) };
            if (toMode === 'plain') return request;
            const unsigned: AccountEncryptionMigrateUnsignedRequest = { ...request, keyProof: { v: 1, publicKey: encodeBase64(signing.publicKey),
                contentPublicKey: encodeBase64(recipient), contentPublicKeySig: encodeBase64(contentPublicKeySig) } };
            return attachAccountEncryptionMigrateProofSignatureV1({ request: unsigned, signature: encodeBase64(tweetnacl.sign.detached(
                createAccountEncryptionMigrateProofSigningInputV1({ request: unsigned, accountId: account.id, sourceMode: 'plain' }), signing.secretKey)) });
        };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } };
        try {
            for (const acpCatalog of [undefined, { expectedRevision: 8, content: null }]) {
                const response = await app.inject({ ...options, payload: buildRequest(acpCatalog) });
                expect(response.statusCode, response.body).toBe(400);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(fromMode);
                expect(await db.userKVStore.findUniqueOrThrow({ where: { id: tombstone.id } })).toEqual(tombstone);
            }
            const response = await app.inject({ ...options, payload: buildRequest({ expectedRevision: 9, content: null }) });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ acpCatalog: { row: { revision: 9, content: null } } });
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: tombstone.id } })).toEqual(tombstone);
            const replay = await app.inject({ ...options, payload: buildRequest({ expectedRevision: 9, content: null }) });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('preserves harmless stored ACP metadata through Account conversion and exact replay (%s)', async fromMode => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const signing = tweetnacl.sign.keyPair();
        const recipient = tweetnacl.box.keyPair().publicKey;
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
        const account = await db.account.create({ data: { encryptionMode: fromMode, publicKey: encodeHex(signing.publicKey),
            contentPublicKey: recipient, contentPublicKeySig, settings: null } });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(43) };
        const rawRecord = { ...record, catalogMetadata: { label: 'Retained catalog', weights: [1, 2] },
            definitions: record.definitions.map(definition => ({ ...definition,
                definitionMetadata: { color: 'blue' }, capabilities: { ...definition.capabilities, capabilityMetadata: { note: 'Retained' } },
                env: { ...definition.env, PUBLIC_CONFIG: { t: 'literal' as const, v: 'retained', literalMetadata: { note: 'Retained' } } },
            })) };
        const toMode = fromMode === 'plain' ? 'e2ee' as const : 'plain' as const;
        // Genuine stored JSON can contain additive fields absent from the current ordinary-write grammar.
        const encrypted = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_acp_catalog', material,
            payload: rawRecord, randomBytes: tweetnacl.randomBytes }) };
        const plain = { t: 'plain' as const, v: rawRecord };
        const envelopeMetadata = { note: 'Retained envelope', flags: [true, false] };
        const source = { ...(fromMode === 'plain' ? plain : encrypted), envelopeMetadata };
        const content = { ...(toMode === 'plain' ? plain : encrypted), envelopeMetadata };
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 5,
            value: new TextEncoder().encode(JSON.stringify(source)) } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const base = { toMode, expectedAccountVersion: account.seq, expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint, expectedSettingsVersion: 0, settingsContent: null,
            connectedServices: { action: 'assert_empty' as const }, automations: { action: 'assert_empty' as const }, machines: { action: 'assert_empty' as const },
            todos: { action: 'assert_empty' as const }, artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
            reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const }, pets: { action: 'assert_empty' as const },
            acpCatalog: { expectedRevision: 5, content } };
        const request = toMode === 'plain' ? base : (() => {
            const unsigned: AccountEncryptionMigrateUnsignedRequest = { ...base, keyProof: { v: 1,
                publicKey: encodeBase64(signing.publicKey), contentPublicKey: encodeBase64(recipient), contentPublicKeySig: encodeBase64(contentPublicKeySig) } };
            return attachAccountEncryptionMigrateProofSignatureV1({ request: unsigned, signature: encodeBase64(tweetnacl.sign.detached(
                createAccountEncryptionMigrateProofSigningInputV1({ request: unsigned, accountId: account.id, sourceMode: 'plain' }), signing.secretKey)) });
        })();
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) }, payload: request };
        try {
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers: { 'x-test-user-id': account.id } })).json())
                .toEqual({ status: 'present', revision: 5, content: source });
            const response = await app.inject(options);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ mode: toMode, acpCatalog: { row: { revision: 6, content } } });
            const persisted = await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } });
            expect(persisted.version).toBe(6);
            expect(persisted.value && JSON.parse(new TextDecoder().decode(persisted.value))).toEqual(content);
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers: { 'x-test-user-id': account.id } })).json())
                .toEqual({ status: 'present', revision: 6, content });
            const rawTarget = content.t === 'plain' ? content.v
                : openAccountScopedBlobCiphertext({ kind: 'account_acp_catalog', material, ciphertext: content.c })?.value;
            expect(rawTarget).toEqual(rawRecord);
            const replay = await app.inject(options);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('reseals the populated ACP catalog atomically, rejecting missing, stale and wrong-mode coverage (%s)', async fromMode => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const signing = tweetnacl.sign.keyPair();
        const recipient = tweetnacl.box.keyPair().publicKey;
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
        const account = await db.account.create({ data: { encryptionMode: fromMode, publicKey: encodeHex(signing.publicKey),
            contentPublicKey: recipient, contentPublicKeySig, settings: null } });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(43) };
        const toMode = fromMode === 'plain' ? 'e2ee' as const : 'plain' as const;
        const source = sealAcpCatalogContentV1({ record, mode: fromMode, material: fromMode === 'plain' ? null : material });
        const content = sealAcpCatalogContentV1({ record, mode: toMode, material: toMode === 'plain' ? null : material });
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, version: 5,
            value: new TextEncoder().encode(JSON.stringify(source)) } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const buildRequest = (directive?: { expectedRevision: number; content: AcpCatalogContentV1 | null }) => {
            const base = { toMode, expectedAccountVersion: account.seq, expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint, expectedSettingsVersion: 0, settingsContent: null,
                connectedServices: { action: 'assert_empty' as const }, automations: { action: 'assert_empty' as const }, machines: { action: 'assert_empty' as const },
                todos: { action: 'assert_empty' as const }, artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
                reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const }, pets: { action: 'assert_empty' as const },
                ...(directive === undefined ? {} : { acpCatalog: directive }) };
            if (toMode === 'plain') return base;
            const request: AccountEncryptionMigrateUnsignedRequest = { ...base, keyProof: { v: 1,
                publicKey: encodeBase64(signing.publicKey), contentPublicKey: encodeBase64(recipient), contentPublicKeySig: encodeBase64(contentPublicKeySig) } };
            return attachAccountEncryptionMigrateProofSignatureV1({ request, signature: encodeBase64(tweetnacl.sign.detached(
                createAccountEncryptionMigrateProofSigningInputV1({ request, accountId: account.id, sourceMode: 'plain' }), signing.secretKey)) });
        };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } };
        try {
            for (const directive of [undefined, { expectedRevision: 4, content }, { expectedRevision: 5, content: source }, { expectedRevision: 5, content: null }]) {
                // A malformed wire candidate cannot pass the canonical signer; tamper only at the HTTP boundary.
                const payload = directive?.content && directive.content.t !== (toMode === 'plain' ? 'plain' : 'encrypted')
                    ? { ...buildRequest(), acpCatalog: directive } : buildRequest(directive);
                const refused = await app.inject({ ...options, payload });
                expect(refused.statusCode, refused.body).toBe(400);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(fromMode);
                expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            }
            const response = await app.inject({ ...options, payload: buildRequest({ expectedRevision: 5, content }) });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ mode: toMode, acpCatalog: { row: { revision: 6, content } } });
            const replay = await app.inject({ ...options, payload: buildRequest({ expectedRevision: 5, content }) });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
            expect((await app.inject({ method: 'GET', url: ACP_CATALOG_ROWS_ROUTE_V1, headers: { 'x-test-user-id': account.id } })).json())
                .toEqual({ status: 'present', revision: 6, content });
            expect(openAcpCatalogContentV1({ mode: toMode, material: toMode === 'plain' ? null : material, content })).toEqual({ status: 'opened', record });
        } finally { await app.close(); }
    });
});

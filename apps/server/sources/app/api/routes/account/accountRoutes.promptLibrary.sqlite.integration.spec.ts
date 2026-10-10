import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { updateAccountEncryptionMode } from './updateAccountEncryptionMode';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { encodeHex } from 'privacy-kit';
import { signAccountContentKeyBindingV1, attachAccountEncryptionMigrateProofSignatureV1, createAccountEncryptionMigrateProofSigningInputV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    type AccountEncryptionMigrateUnsignedRequest } from '@happier-dev/protocol';
import { sealPromptLibraryContentV1, openPromptLibraryContentV1, buildPromptLibraryPhysicalKeyV1,
    type AccountEncryptionMigratePromptLibraryDirectiveV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';

describe('Account prompt-library reserved rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-prompt-library-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('publishes admitted catalogs with isolated CAS, without Settings writes or a generic KV bypass', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); kvRoutes(app);
        const url = '/v1/account/entity-rows/prompt-library/role-overrides';
        const headers = { 'x-test-user-id': account.id };
        const content = { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {
            reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Review only' },
        } } } };
        try {
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 6, content } })).json())
                .toEqual({ status: 'settings-conflict', revision: 7 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 7, content } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 2, content: null } })).json())
                .toEqual({ status: 'conflict', revision: 0 });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/prompt-library', headers })).json())
                .toEqual({ status: 'listed', rows: [{ key: 'role-overrides', revision: 0, content }] });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'GET', url: '/v1/kv?prefix=%40happier%2Faccount%2Fprompt-library', headers })).statusCode).toBe(400);
            const hint = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id, kind: 'account' } });
            expect(hint.hint).toEqual({ promptLibrary: true, key: 'role-overrides', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: null } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
        } finally { await app.close(); }
    });

    it('refuses mode changes without resealing the registered prompt namespace', async () => {
        // A retained row must participate in the existing all-domain transition,
        // including the older empty-only PATCH ingress.
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/prompt-library/v1/role-overrides', version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } })),
        } });
        expect(await updateAccountEncryptionMode({ accountId: account.id, mode: 'plain' })).toEqual({ status: 'migration_required' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe('e2ee');
    });

    it.each(['plain', 'e2ee'] as const)('converts populated prompt catalogs atomically in both directions and preserves tombstones (%s source)', async fromMode => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const signing = tweetnacl.sign.keyPair();
        const recipient = tweetnacl.box.keyPair().publicKey;
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
        const account = await db.account.create({ data: { encryptionMode: fromMode, publicKey: encodeHex(signing.publicKey),
            contentPublicKey: recipient, contentPublicKeySig, settings: null } });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(41) };
        const record = { key: 'role-overrides' as const, value: { v: 1 as const, overrides: {
            reviewer: { roleId: 'reviewer', workspaceWrites: 'deny' as const, instructionsOverride: 'Keep this restriction' },
        } } };
        const toMode = fromMode === 'plain' ? 'e2ee' as const : 'plain' as const;
        const source = sealPromptLibraryContentV1({ record, mode: fromMode, material: fromMode === 'plain' ? null : material });
        const content = sealPromptLibraryContentV1({ record, mode: toMode, material: toMode === 'plain' ? null : material });
        const key = buildPromptLibraryPhysicalKeyV1(record.key);
        await db.userKVStore.create({ data: { accountId: account.id, key, version: 5, value: new TextEncoder().encode(JSON.stringify(source)) } });
        const tombstone = await db.userKVStore.create({ data: { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('folders'), version: 9, value: null } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const buildRequest = (items?: AccountEncryptionMigratePromptLibraryDirectiveV1['items']) => {
            const base = { toMode, expectedAccountVersion: account.seq, expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint, expectedSettingsVersion: 0, settingsContent: null,
                connectedServices: { action: 'assert_empty' as const }, automations: { action: 'assert_empty' as const }, machines: { action: 'assert_empty' as const },
                todos: { action: 'assert_empty' as const }, artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
                reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const }, pets: { action: 'assert_empty' as const },
                ...(items === undefined ? {} : { promptLibrary: { items } }) };
            if (toMode === 'plain') return base;
            const request: AccountEncryptionMigrateUnsignedRequest = { ...base, keyProof: { v: 1,
                publicKey: Buffer.from(signing.publicKey).toString('base64'), contentPublicKey: Buffer.from(recipient).toString('base64'),
                contentPublicKeySig: Buffer.from(contentPublicKeySig).toString('base64') } };
            const signed = createAccountEncryptionMigrateProofSigningInputV1({ request, accountId: account.id, sourceMode: 'plain' });
            return attachAccountEncryptionMigrateProofSignatureV1({ request, signature: Buffer.from(tweetnacl.sign.detached(signed, signing.secretKey)).toString('base64') });
        };
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } };
        try {
            const refusedInventories: readonly (AccountEncryptionMigratePromptLibraryDirectiveV1['items'] | undefined)[] = [undefined, [], [{ key: record.key, expectedRevision: 4, content }]];
            for (const items of refusedInventories) {
                const refused = await app.inject({ ...options, payload: buildRequest(items) });
                expect(refused.statusCode, refused.body).toBe(400);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe(fromMode);
                expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).version).toBe(5);
            }
            const response = await app.inject({ ...options, payload: buildRequest([{ key: record.key, expectedRevision: 5, content }]) });
            expect(response.statusCode, response.body).toBe(200);
            const result = response.json();
            expect(result).toMatchObject({ mode: toMode, promptLibrary: { rows: [{ key: record.key, revision: 6, content }] } });
            expect(openPromptLibraryContentV1({ mode: toMode, material: toMode === 'plain' ? null : material, key: record.key, content })).toEqual({ status: 'opened', record });
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: tombstone.key } } })).toEqual(tombstone);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });
});

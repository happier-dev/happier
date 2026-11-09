import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { AccountEncryptionMigrateSettingsHistoryInventoryPageSchema, attachAccountEncryptionMigrateProofSignatureV1,
    createAccountEncryptionMigrateProofSigningInputV1, type AccountEncryptionMigrateTodosDirective,
    type AccountEncryptionMigrateUnsignedRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { db, getDbProviderFromEnv, initDbPostgres, initDbMysql } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { auth } from '@/app/auth/auth';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { migrateAccountJsonKvEncryptionInTx, matchAccountJsonKvEncryptionMigrationPostStateInTx } from '@/app/kv/migrateAccountJsonKvEncryptionInTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountEncryptionMigrateRoutes } from '@/app/api/routes/account/registerAccountEncryptionMigrateRoutes';
import { updateAccountEncryptionMode } from '@/app/api/routes/account/updateAccountEncryptionMode';

const bytes = (content: unknown) => new TextEncoder().encode(JSON.stringify(content));
const encoded = (content: unknown) => privacyKit.encodeBase64(bytes(content));

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Task Account-mode conversion (native database)', () => {
    beforeAll(async () => {
        const expectedUrl = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!expectedUrl || process.env.DATABASE_URL !== expectedUrl) {
            throw new Error('Use the disposable native DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 't9-account-conversion-db-contract');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST', 'none');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST', 'none');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        await auth.init();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('converts the same shared row both ways with its grants and complete target key census', async () => {
        const generatedSigning = tweetnacl.sign.keyPair();
        const signing = { publicKey: new Uint8Array(generatedSigning.publicKey), secretKey: new Uint8Array(generatedSigning.secretKey) };
        const ownerContentKey = { publicKey: new Uint8Array(tweetnacl.box.keyPair().publicKey) };
        const ownerBinding = { publicKey: privacyKit.encodeHex(signing.publicKey), contentPublicKey: ownerContentKey.publicKey,
            contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: ownerContentKey.publicKey }) };
        const recipientBinding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...ownerBinding, encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { ...recipientBinding, encryptionMode: 'e2ee' } });
        const taskId = randomUUID();
        const plain = { t: 'plain', v: { id: taskId, title: 'Retained shared task', done: false, createdAt: 1, updatedAt: 1 } };
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${taskId}`, value: bytes(plain), version: 3 } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        const grant = await db.taskTeamGrant.create({ data: { taskId: row.id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const dataKey = tweetnacl.randomBytes(32);
        const envelope = (recipientAccountId: string, contentPublicKey: Uint8Array) => ({ recipientAccountId,
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
            encryptedDataKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes })) });
        const targetKeys = [envelope(owner.id, ownerBinding.contentPublicKey), envelope(recipient.id, recipientBinding.contentPublicKey)];
        const sealed = { t: 'encrypted', k: 'task', c: 'resource-ciphertext' };
        await withAuthenticatedTestApp(registerAccountEncryptionMigrateRoutes, async app => {
            const convert = async (fromMode: 'plain' | 'e2ee', toMode: 'plain' | 'e2ee', directive: AccountEncryptionMigrateTodosDirective) => {
                const current = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
                const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(current);
                const historyResponse = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/settings-history/inventory', headers: { 'x-test-user-id': owner.id } });
                expect(historyResponse.statusCode).toBe(200);
                const history = AccountEncryptionMigrateSettingsHistoryInventoryPageSchema.parse(historyResponse.json());
                const unsigned = { toMode, expectedAccountVersion: current.seq, expectedSettingsVersion: current.settingsVersion,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                    settingsContent: null, settingsHistory: { items: history.items.map(item => ({ version: item.version, expectedContent: item.content, content: null })) },
                    connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' },
                    todos: directive, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' }, reviewComments: { action: 'assert_empty' },
                    sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
                } satisfies AccountEncryptionMigrateUnsignedRequest;
                const candidate = { ...unsigned, keyProof: { v: 1 as const, publicKey: privacyKit.encodeBase64(signing.publicKey),
                    contentPublicKey: privacyKit.encodeBase64(ownerBinding.contentPublicKey), contentPublicKeySig: privacyKit.encodeBase64(ownerBinding.contentPublicKeySig) } };
                const payload = toMode === 'plain' ? unsigned : attachAccountEncryptionMigrateProofSignatureV1({ request: candidate,
                    signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(createAccountEncryptionMigrateProofSigningInputV1({ accountId: owner.id, sourceMode: fromMode, request: candidate }), signing.secretKey))) });
                const response = await app.inject({ method: 'POST', url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': owner.id }, payload });
                if (response.statusCode !== 200) throw new Error(`Task conversion refused: ${response.statusCode}`);
                return response.json();
            };
            const encryptedDirective = { action: 'migrate' as const, items: [{ key: row.key, expectedVersion: 3, value: encoded(sealed), recipientKeyEnvelopes: targetKeys }] };
            await expect(convert('plain', 'e2ee', { action: 'migrate', items: [{ ...encryptedDirective.items[0]!, recipientKeyEnvelopes: targetKeys.slice(1) }] })).rejects.toThrow();
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).encryptionMode).toBe('plain');
            expect(await db.taskKeyEnvelope.count({ where: { taskId: row.id } })).toBe(0);
            expect(await convert('plain', 'e2ee', encryptedDirective)).toMatchObject({ success: true, mode: 'e2ee' });
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ version: 4, value: bytes(sealed) });
            expect(await db.taskKeyEnvelope.count({ where: { taskId: row.id } })).toBe(2);
            expect(await inTx(tx => matchAccountJsonKvEncryptionMigrationPostStateInTx({ tx, accountId: owner.id, namespace: 'todo', toMode: 'e2ee', directive: encryptedDirective }))).toEqual({ status: 'matched' });
            expect(await convert('e2ee', 'plain', { action: 'migrate', items: [{ key: row.key, expectedVersion: 4, value: encoded(plain), recipientKeyEnvelopes: [] }] })).toMatchObject({ success: true, mode: 'plain' });
            expect(await db.userKVStore.findMany({ where: { accountId: owner.id } })).toMatchObject([{ id: row.id, key: row.key, version: 5, value: bytes(plain) }]);
            expect(await db.taskTeamGrant.findUniqueOrThrow({ where: { taskId_teamId: { taskId: row.id, teamId: team.id } } })).toEqual(grant);
            expect(await db.taskKeyEnvelope.count({ where: { taskId: row.id } })).toBe(0);
        });
    });

    it('refuses an incomplete inventory without changing content, grants, keys or Account mode', async () => {
        const binding = createSignedAccountContentBinding();
        const owner = await db.account.create({ data: { ...binding, encryptionMode: 'e2ee' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const row = await db.userKVStore.create({ data: { accountId: owner.id, key: `todo.${randomUUID()}`, version: 2,
            value: bytes({ t: 'encrypted', k: 'task', c: 'retained-resource-ciphertext' }) } });
        await db.taskAccountGrant.create({ data: { taskId: row.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const key = privacyKit.decodeBase64(privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: binding.contentPublicKey, randomBytes: tweetnacl.randomBytes })));
        await db.taskKeyEnvelope.create({ data: { taskId: row.id, recipientAccountId: owner.id, encryptedDataKey: key,
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(binding.contentPublicKey) } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.index', value: new Uint8Array([1, 2, 3]), version: 1 } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.bad', value: bytes({ t: 'encrypted' }), version: 5 } });
        const before = await Promise.all([db.account.findUniqueOrThrow({ where: { id: owner.id } }), db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } }),
            db.taskAccountGrant.findMany({ where: { taskId: row.id } }), db.taskKeyEnvelope.findMany({ where: { taskId: row.id } })]);
        const result = await inTx(tx => migrateAccountJsonKvEncryptionInTx({ tx, accountId: owner.id, namespace: 'todo', fromMode: 'e2ee', toMode: 'plain',
            directive: { action: 'migrate', items: [{ key: row.key, expectedVersion: row.version, value: encoded({ t: 'plain', v: {} }), recipientKeyEnvelopes: [] }] } }));
        expect(result).toEqual({ status: 'migration_incomplete' });
        expect(await updateAccountEncryptionMode({ accountId: owner.id, mode: 'plain' })).toEqual({ status: 'migration_required' });
        expect(await inTx(tx => migrateAccountJsonKvEncryptionInTx({ tx, accountId: owner.id, namespace: 'todo', fromMode: 'e2ee', toMode: 'plain',
            directive: { action: 'migrate', items: [
                { key: row.key, expectedVersion: row.version, value: encoded({ t: 'plain', v: {} }), recipientKeyEnvelopes: [] },
                { key: 'todo.index', expectedVersion: 1, value: encoded({ t: 'plain', v: { undoneOrder: [], completedOrder: [] } }) },
                { key: 'todo.bad', expectedVersion: 5, value: encoded({ t: 'plain', v: {} }) },
            ] } }))).toEqual({ status: 'invalid_content' });
        expect(await Promise.all([db.account.findUniqueOrThrow({ where: { id: owner.id } }), db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } }),
            db.taskAccountGrant.findMany({ where: { taskId: row.id } }), db.taskKeyEnvelope.findMany({ where: { taskId: row.id } })])).toEqual(before);
    });

    it('inventories every nonnull owner Todo row, including legacy, index and malformed content, without disclosing another Account', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const rows = await Promise.all([
            db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.index', version: 2, value: new Uint8Array([1, 2, 3]) } }),
            db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.legacy', version: 4, value: new Uint8Array([4, 5, 6]) } }),
            db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.malformed', version: 6, value: bytes({ t: 'encrypted' }) } }),
        ]);
        await db.userKVStore.create({ data: { accountId: other.id, key: 'todo.private', value: bytes({ t: 'plain', v: {} }) } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: 'todo.deleted', value: null } });
        await withAuthenticatedTestApp(registerAccountEncryptionMigrateRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/todos/inventory', headers: { 'x-test-user-id': owner.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ items: rows.sort((a, b) => a.key.localeCompare(b.key)).map(row => ({ key: row.key, version: row.version,
                value: privacyKit.encodeBase64(row.value!) })) });
            const refused = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/todos/inventory', headers: { 'x-test-user-id': owner.id, 'x-test-auth-token-kind': 'api_token' } });
            expect(refused.statusCode).toBe(403);
        });
    });

});

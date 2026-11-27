import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { encodeHex } from 'privacy-kit';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    signAccountContentKeyBindingV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { captureAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import type { Fastify as AccountApi } from '@/app/api/types';
import { registerAccountEncryptionMigrateRoutes } from './registerAccountEncryptionMigrateRoutes';
import type { AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import { AccountEncryptionMigrateTodosInventoryResponseSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { DiscussionAccountEncryptionInventoryV1Schema } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { openDiscussionTaskWrappedKeyV1 } from '@happier-dev/protocol/discussions/taskKeys';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { createDiscussion } from '@/app/discussions/mutations';
import { readDiscussionMessages } from '@/app/discussions/queries';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { buildAccountEncryptionMigrateToPlainRequest } from '../../../../../../ui/sources/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { buildAccountEncryptionMigrateToE2eeRequest } from '../../../../../../ui/sources/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest';
import { buildAccountEncryptionMigrationStorageDirectives, type AccountEncryptionMigrationStorageDirectives } from '../../../../../../ui/sources/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import { Encryption } from '../../../../../../ui/sources/sync/encryption/encryption';
import { createUiTaskResourceCrypto } from '../../../../../../ui/sources/sync/encryption/taskResourceCrypto';
import { settingsParse } from '../../../../../../ui/sources/sync/domains/settings/settings';

const seed = new Uint8Array(32).fill(7);
const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(seed).publicKey;
const credentials = { token: 'test-token', secret: Buffer.from(seed).toString('base64url') };
const storageDirectives = { machines: { action: 'assert_empty' as const }, todos: { action: 'assert_empty' as const },
    artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
    reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const }, pets: { action: 'assert_empty' as const } };

describe('UI to v7 Server conversion preserves absent Settings', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-absent-settings-', initEncrypt: true, initFiles: true });
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
    });
    afterAll(async () => { await harness?.close(); });

    async function fixture(fromMode: 'plain' | 'e2ee', rawSettings: Record<string, unknown> | null) {
        const signing = tweetnacl.sign.keyPair();
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey });
        const keyProof = { v: 1 as const, publicKey: Buffer.from(signing.publicKey).toString('base64'),
            contentPublicKey: Buffer.from(contentPublicKey).toString('base64'), contentPublicKeySig: Buffer.from(contentPublicKeySig).toString('base64'),
            sign: (input: Uint8Array) => Buffer.from(tweetnacl.sign.detached(input, signing.secretKey)).toString('base64') };
        const content = rawSettings === null ? null : fromMode === 'plain' ? storePlainAccountSettingsDbValue({ accountId: 'fixture', content: { t: 'plain', v: rawSettings } })
            : sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret: seed },
                payload: rawSettings, randomBytes: length => new Uint8Array(length).fill(9) });
        const account = await db.account.create({ data: { encryptionMode: fromMode, settings: content,
            publicKey: encodeHex(new Uint8Array(signing.publicKey)), contentPublicKey: new Uint8Array(contentPublicKey),
            contentPublicKeySig: new Uint8Array(contentPublicKeySig) } });
        const build = async (source: Record<string, unknown> | null, directives: AccountEncryptionMigrationStorageDirectives = storageDirectives) => {
            const current = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(current);
            const common = { credentials, expectedAccountVersion: current.seq, expectedSettingsVersion: current.settingsVersion,
                expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                settings: settingsParse(source ?? {}), rawSettings: source, connectedServiceProfiles: [], automations: [], storageDirectives: directives };
            // The boundary must retain the nullable Settings baseline, including a present empty object.
            return current.encryptionMode === 'e2ee' ? buildAccountEncryptionMigrateToPlainRequest({ ...common,
                fetchConnectedServiceCredentialSealed: async () => { throw new Error('No Connected Accounts in this fixture'); },
                decryptAutomationTemplateRaw: async () => { throw new Error('No Automations in this fixture'); } })
                : buildAccountEncryptionMigrateToE2eeRequest({ ...common, accountId: account.id, keyProof,
                    fetchConnectedServiceCredentialPlain: async () => { throw new Error('No Connected Accounts in this fixture'); } });
        };
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only authentication is replaced: the request is the admitted fixture Account owner.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = account.id;
            request.authAuthority = 'present_user';
            request.authTokenKind = 'account';
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        });
        const api = app as unknown as AccountApi;
        enableErrorHandlers(api);
        registerAccountEncryptionMigrateRoutes(api);
        const send = (payload: AccountEncryptionMigrateRequest) => app.inject({ method: 'POST', url: '/v1/account/encryption/migrate', payload,
            headers: buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) });
        return { account, app, build, send };
    }

    it('rejects the former client default object for a zero-row Settings inventory with the recorded HTTP refusal', async () => {
        const { account, app, build, send } = await fixture('e2ee', null);
        try {
            const formerRequest = await build({});
            const rejected = await send(formerRequest);
            expect(rejected.statusCode, rejected.body).toBe(400);
            expect(rejected.json()).toEqual({ error: 'invalid-params', reason: 'migration_inventory_changed' });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settings: true, encryptionMode: true } }))
                .toEqual({ settings: null, encryptionMode: 'e2ee' });
            const admitted = await send({ ...formerRequest, settingsContent: null });
            expect(admitted.statusCode, admitted.body).toBe(200);
        } finally { await app.close(); }
    });

    it.each([
        { fromMode: 'e2ee', absent: true }, { fromMode: 'plain', absent: true },
        { fromMode: 'e2ee', absent: false }, { fromMode: 'plain', absent: false },
    ] as const)('converts $fromMode with absent=$absent Settings through the real route', async ({ fromMode, absent }) => {
        const { account, app, build, send } = await fixture(fromMode, absent ? null : {});
        try {
            const request = await build(absent ? null : {});
            const converted = await send(request);
            expect(converted.statusCode, converted.body).toBe(200);
            const stored = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settings: true, settingsVersion: true, encryptionMode: true } });
            expect(stored.settings === null).toBe(absent);
            expect(stored.settingsVersion).toBe(account.settingsVersion + 1);
            expect(stored.encryptionMode).toBe(fromMode === 'e2ee' ? 'plain' : 'e2ee');
        } finally { await app.close(); }
    });

    it('converts an unshared Task and its comment together and rejects an incomplete pair atomically', async () => {
        const { account, app, build, send } = await fixture('plain', null);
        try {
            const taskId = crypto.randomUUID();
            const task = await db.userKVStore.create({ data: { accountId: account.id, key: `todo.${taskId}`,
                value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { id: taskId, title: 'Task', done: false, createdAt: 1, updatedAt: 1 } })) } });
            const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Private Task comment' }] };
            const reader = { actorAccountId: account.id, authentication: createPresentUserSessionAccessAuthentication() };
            const created = await createDiscussion({ ...reader, request: buildDiscussionMutationRequestBodyV1({ kind: 'create',
                creationLocalId: crypto.randomUUID(), anchor: { kind: 'task', entry: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(taskId, account.id) } },
                titleContent: { t: 'plain', v: { v: 1, title: 'Task' } }, firstMessage: { localId: crypto.randomUUID(),
                    content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] } }) });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const read = () => readDiscussionMessages({ ...reader, discussionId, messageId: created.value.firstMessage.id, includeKeyContext: true });
            const encryption = await Encryption.createFromContentKeyPair({ publicKey: contentPublicKey, machineKey: seed });
            const scope = { scope: { accountId: account.id, serverId: 'fixture-home' }, isCurrent: () => true };
            const load = async (domain: 'todos' | 'discussions') => {
                const response = await app.inject({ method: 'GET', url: `/v1/account/encryption/migrate/${domain}/inventory` });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            };
            const convert = async (fromMode: 'plain' | 'e2ee') => {
                const todos = AccountEncryptionMigrateTodosInventoryResponseSchema.parse(await load('todos')).items;
                expect(todos).toMatchObject([{ key: task.key, resource: { ownerAccountId: account.id, encryptionMode: fromMode } }]);
                const discussionsInventory = DiscussionAccountEncryptionInventoryV1Schema.parse(await load('discussions'));
                expect(discussionsInventory.items).toMatchObject([{ discussionId, taskKey: task.key }]);
                const directives = await buildAccountEncryptionMigrationStorageDirectives({ fromMode,
                    toMode: fromMode === 'plain' ? 'e2ee' : 'plain', sourceEncryption: fromMode === 'plain' ? null : encryption,
                    targetEncryption: fromMode === 'plain' ? encryption : null, scope, todos, discussionsInventory,
                    machines: [], artifacts: [], sessions: [], reviewCommentsInventory: { v: 1, items: [] },
                    sessionOrganizationInventory: { version: 0, folders: [], tags: [], labels: [] },
                    sessionSourceCredentials: fromMode === 'plain' ? { token: credentials.token } : credentials,
                    sessionTargetCredentials: fromMode === 'plain' ? credentials : null });
                return directives;
            };

            const forward = await convert('plain');
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true, encryptionMode: true } });
            for (const incompletePair of [
                { ...forward, todos: { action: 'migrate' as const, items: [] } },
                { ...forward, discussions: { items: [] } },
            ]) {
                const incomplete = await send(await build(null, incompletePair));
                expect(incomplete.statusCode, incomplete.body).toBe(400);
                expect(incomplete.json()).toEqual({ error: 'invalid-params', reason: 'migration_inventory_changed' });
                expect(await db.userKVStore.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
                expect(await db.taskKeyEnvelope.count({ where: { taskId: task.id } })).toBe(0);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject(before);
                expect(await read()).toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id, content: { t: 'plain', v: content } }] } });
            }

            const encrypt = await build(null, forward);
            const encrypted = await send(encrypt);
            expect(encrypted.statusCode, encrypted.body).toBe(200);
            const convertedTask = await db.userKVStore.findUniqueOrThrow({ where: { id: task.id } });
            const replayed = await send(encrypt);
            expect(replayed.statusCode, replayed.body).toBe(200);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { id: task.id } })).toEqual(convertedTask);
            const encryptedComment = await read();
            expect(encryptedComment).toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id, content: { t: 'encrypted' } }] } });
            if (!encryptedComment.ok || !encryptedComment.value.keyContext?.taskKey) throw new Error('Expected the Task key context');
            const { wrappedDiscussionKey, encryptedTaskKey } = encryptedComment.value.keyContext.taskKey;
            const taskDataKey = await encryption.decryptEncryptionKey(encryptedTaskKey, scope.scope);
            if (!taskDataKey) throw new Error('Task key unavailable');
            const cryptoForTask = createUiTaskResourceCrypto(encryption, scope.scope);
            const discussionDataKey = await openDiscussionTaskWrappedKeyV1(wrappedDiscussionKey, taskDataKey, cryptoForTask.open);
            expect(discussionDataKey).toHaveLength(32);

            const reverse = await convert('e2ee');
            const decrypted = await send(await build(null, reverse));
            expect(decrypted.statusCode, decrypted.body).toBe(200);
            expect(await read()).toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id, content: { t: 'plain', v: content } }] } });
            expect(await db.taskGrant.count({ where: { taskId: task.id } })).toBe(0);
            expect(await db.taskKeyEnvelope.count({ where: { taskId: task.id } })).toBe(0);
            expect(await db.discussionGrant.count({ where: { discussionId } })).toBe(0);
            expect(await db.discussionKeyEnvelope.count({ where: { discussionId } })).toBe(0);
        } finally { await app.close(); }
    });
});

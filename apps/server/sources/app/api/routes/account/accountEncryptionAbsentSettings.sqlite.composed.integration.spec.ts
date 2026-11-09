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
import { buildAccountEncryptionMigrateToPlainRequest } from '../../../../../../ui/sources/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { buildAccountEncryptionMigrateToE2eeRequest } from '../../../../../../ui/sources/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest';
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
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const build = (source: Record<string, unknown> | null) => {
            const common = { credentials, expectedAccountVersion: account.seq, expectedSettingsVersion: account.settingsVersion,
                expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                settings: settingsParse(source ?? {}), rawSettings: source, connectedServiceProfiles: [], automations: [], storageDirectives };
            // The boundary must retain the nullable Settings baseline, including a present empty object.
            return fromMode === 'e2ee' ? buildAccountEncryptionMigrateToPlainRequest({ ...common,
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
});

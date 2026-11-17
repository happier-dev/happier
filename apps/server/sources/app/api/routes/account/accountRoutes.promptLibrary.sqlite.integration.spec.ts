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
    PromptLibraryRowsListResponseV1Schema, PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1,
    type AccountEncryptionMigratePromptLibraryDirectiveV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createSavedSecretResourceInTx, deleteSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { inTx } from '@/storage/inTx';
import { migratePromptLibraryForAccountModeInTx, matchPromptLibraryAccountMigrationPostStateInTx } from '@/app/account/prompts/promptLibraryEncryptionMigration';

describe('Account prompt-library reserved rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-prompt-library-', initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('keeps known prompt context readable beside unknown stored keys (%s)', async mode => {
        const account = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(37) };
        const record = emptyPromptLibraryRecordV1('coding');
        const content = sealPromptLibraryContentV1({ mode, material, record });
        const unknownKey = `${PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1}future-skill-usage`;
        const unknownValue = new TextEncoder().encode(JSON.stringify(content));
        await db.userKVStore.createMany({ data: [
            { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('coding'), version: 3,
                value: new TextEncoder().encode(JSON.stringify(content)) },
            { accountId: account.id, key: unknownKey, version: 4, value: unknownValue },
            { accountId: account.id, key: `${unknownKey}-opaque`, version: 5, value: new Uint8Array([255]) },
            { accountId: account.id, key: `${unknownKey}-deleted`, version: 6, value: null },
        ] });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v1/account/entity-rows/prompt-library',
                headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            const wire = PromptLibraryRowsListResponseV1Schema.parse(response.json());
            expect(wire).toEqual({ status: 'listed', rows: [{ key: 'coding', revision: 3, content }] });
            const catalog = await loadPromptLibraryCatalogV1({ mode, material, readRows: async () => wire });
            expect(catalog).toMatchObject({ status: 'ready', rows: [{ record, revision: 3 }] });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: unknownKey } } }))
                .toMatchObject({ version: 4, value: unknownValue });
            expect((await app.inject({ method: 'GET', url: `/v1/account/entity-rows/prompt-library/future-skill-usage`,
                headers: { 'x-test-user-id': account.id } })).statusCode).toBe(400);
            // Display omission is not a complete conversion census. Unknown bytes
            // must still prevent an Account-mode transition or claimed post-state.
            expect(await inTx(tx => migratePromptLibraryForAccountModeInTx(tx, { accountId: account.id,
                toMode: mode === 'plain' ? 'e2ee' : 'plain' }))).toEqual({ status: 'invalid_content' });
            expect(await inTx(tx => matchPromptLibraryAccountMigrationPostStateInTx(tx, { accountId: account.id,
                toMode: mode }))).toEqual({ status: 'mismatch' });
        } finally { await app.close(); }
    });

    it.each(['corrupt', 'mismatched-key', 'wrong-mode'] as const)('still refuses a known prompt row with %s content', async scenario => {
        const mode = scenario === 'mismatched-key' ? 'plain' : 'e2ee';
        const account = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const content = { t: 'plain', v: emptyPromptLibraryRecordV1(scenario === 'mismatched-key' ? 'voice' : 'coding') };
        await db.userKVStore.create({ data: { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('coding'),
            version: 1, value: scenario === 'corrupt' ? new Uint8Array([255]) : new TextEncoder().encode(JSON.stringify(content)) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v1/account/entity-rows/prompt-library',
                headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: scenario === 'wrong-mode' ? 'account-mode-mismatch' : 'invalid-stored-content' });
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('refuses a registry token referencing a missing resource before publishing the row (%s)', async mode => {
        const account = await db.account.create({ data: { encryptionMode: mode, settingsVersion: 0,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/prompt-library/registry-sources';
        const headers = { 'x-test-user-id': account.id };
        const resourceId = 'missing-registry-token';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const content = sealPromptLibraryContentV1({ mode, material: mode === 'plain' ? null : {
            type: 'legacy', secret: new Uint8Array(32).fill(29) }, record: {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: 'private', title: 'Private', enabled: true,
                format: 'git', kinds: ['skill'], url: 'https://example.test/private.git', addedAt: 0,
                token: { secretRef: ref } }] },
        } });
        try {
            const response = await app.inject({ method: 'POST', url, headers,
                payload: { expectedRevision: 'absent', sourceSettingsVersion: 0, content,
                    referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('admits current registry token custody but refuses stale, unentitled and deleted resources through the row route', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceId = 'registry-row-token';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Token', kind: 'token', encryptionMode: 'plain', storedContent: {
                t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'fixture-private' } } }))).toMatchObject({ ok: true });
        const content = sealPromptLibraryContentV1({ mode: 'plain', material: null, record: { key: 'registry-sources', value: {
            v: 2, disabledSourceIds: [], sources: [{ id: 'private', title: 'Private', format: 'git', kinds: ['skill'],
                url: 'https://example.test/private.git', addedAt: 0, enabled: false, token: { secretRef: ref } }] } } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/prompt-library/registry-sources';
        const headers = { 'x-test-user-id': owner.id };
        const mutation = { expectedRevision: 'absent', sourceSettingsVersion: 0, content,
            referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] };
        try {
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...mutation,
                savedSecretRevisions: [{ resourceId, expectedRevision: 2 }] } })).json()).toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': other.id }, payload: mutation })).json())
                .toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'POST', url, headers, payload: mutation })).json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: null } })).json())
                .toMatchObject({ status: 'updated', revision: 1 });
            expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 1,
                expectedSettingsVersion: 0, referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
                    catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent',
                        connectedPurposes: 'absent', registrySources: 1 } } }))).toMatchObject({ ok: true });
            const { sourceSettingsVersion: _source, ...rebind } = mutation;
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...rebind, expectedRevision: 1 } })).json())
                .toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        } finally { await app.close(); }
    });

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

    // A fresh Account's first catalog read activates every absent row: one request admits them all
    // against the captured source version, instead of one write (and its witnesses) per row.
    it('initializes every absent row in one write against the captured source Settings version', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const keys = ['coding', 'voice', 'folders', 'invocations', 'contexts'] as const;
        const body = (sourceSettingsVersion: number) => ({ sourceSettingsVersion,
            rows: keys.map(key => ({ key, content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record: emptyPromptLibraryRecordV1(key) }) })) });
        const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/account/entity-rows/prompt-library',
            headers: { 'x-test-user-id': account.id }, payload });
        try {
            const { settingsVersion } = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { settingsVersion: true } });
            const stale = await post(body(settingsVersion + 1));
            expect(stale.json()).toEqual({ status: 'settings-conflict', revision: settingsVersion });
            const initialized = await post(body(settingsVersion));
            expect(initialized.statusCode).toBe(200);
            expect(initialized.json()).toMatchObject({ status: 'updated',
                rows: keys.map(key => ({ key, revision: expect.any(Number), cursor: expect.any(Number) })) });
            const listed = PromptLibraryRowsListResponseV1Schema.parse((await app.inject({ method: 'GET',
                url: '/v1/account/entity-rows/prompt-library', headers: { 'x-test-user-id': account.id } })).json());
            expect(listed.status === 'listed' ? listed.rows.map(row => row.key).sort() : listed).toEqual([...keys].sort());
            // Presence never reseeds: a second activation (a concurrent reader) loses the whole CAS.
            expect((await post(body(settingsVersion))).json()).toMatchObject({ status: 'conflict', key: expect.any(String) });
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
        const recipient = new Uint8Array(tweetnacl.box.keyPair().publicKey);
        const contentPublicKeySig = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
        const account = await db.account.create({ data: { encryptionMode: fromMode, publicKey: encodeHex(new Uint8Array(signing.publicKey)),
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

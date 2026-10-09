import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { classifyAccountScopedKvKey } from '@/app/kv/accountScopedKv';
import type { Fastify } from '@/app/api/types';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';

const route = '/v1/account/entity-rows/mcp';
const catalog = { t: 'plain' as const, v: { v: 1 as const, servers: [], bindings: [] } };

describe('MCP catalog Account row (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-mcp-catalog-', initAuth: false, initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('classifies exactly the private MCP catalog and no alternate catalog key', () => {
        expect(classifyAccountScopedKvKey('@happier/account/mcp/v1/catalog')).toEqual({ kind: 'accountMcpServerCatalog' });
        expect(classifyAccountScopedKvKey('@happier/account/mcp/v1/catalog-extra')).toEqual({ kind: 'reservedUnknown' });
    });

    it('admits keyless Plain initialization against source currentness and keeps row CAS separate from Settings', async () => {
        const { registerMcpServerCatalogRoutes } = await import('./registerMcpServerCatalogRoutes');
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
        await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
            const headers = { 'x-test-user-id': account.id };
            const read = () => app.inject({ method: 'GET', url: route, headers });
            expect((await read()).json()).toEqual({ status: 'absent' });
            const mutate = (payload: unknown) => app.inject({ method: 'POST', url: route, headers, payload });
            expect((await mutate({ expectedRevision: 'absent', sourceSettingsVersion: 2, content: catalog })).json())
                .toEqual({ status: 'settings-conflict', revision: 3 });
            expect((await read()).json()).toEqual({ status: 'absent' });
            expect((await mutate({ expectedRevision: 'absent', sourceSettingsVersion: 3, content: catalog })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect((await read()).json()).toEqual({ status: 'present', revision: 0, content: catalog });
            expect((await mutate({ expectedRevision: 1, content: null })).json()).toEqual({ status: 'conflict', revision: 0 });
            expect((await mutate({ expectedRevision: 0, content: null })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await read()).json()).toEqual({ status: 'deleted', revision: 1 });
            expect((await mutate({ expectedRevision: 'absent', sourceSettingsVersion: 3, content: catalog })).json())
                .toEqual({ status: 'conflict', revision: 1 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(3);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        });
    });

    it('refuses an encrypted envelope in Plain mode before mutation or disclosure', async () => {
        const { registerMcpServerCatalogRoutes } = await import('./registerMcpServerCatalogRoutes');
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
            const headers = { 'x-test-user-id': account.id };
            expect((await app.inject({ method: 'POST', url: route, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 0, content: { t: 'encrypted', c: 'opaque' },
            } })).json()).toEqual({ status: 'account-mode-mismatch' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/mcp/v1/catalog',
                version: 4, value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: 'opaque' })) } });
            expect((await app.inject({ method: 'GET', url: route, headers })).json()).toEqual({ status: 'account-mode-mismatch' });
        });
    });

    it('does not let a Settings write reseed an active or deleted MCP catalog', async () => {
        const { writeAccountSettingsInTx } = await import('@/app/accountSettings/writeAccountSettingsInTx');
        for (const value of [new TextEncoder().encode(JSON.stringify(catalog)), null]) {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/mcp/v1/catalog', version: 4, value } });
            const result = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 0,
                next: { kind: 'v2', content: { t: 'plain', v: { mcpServersSettingsV1: {
                    v: 1, strictMode: false, servers: [], bindings: [],
                } } } } }));
            expect(result).toEqual({ status: 'invalid_content' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
        }
    });

    it('allows pre-admission source writes, unchanged retained bytes, and cleanup after catalog authority', async () => {
        const { writeAccountSettingsInTx } = await import('@/app/accountSettings/writeAccountSettingsInTx');
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = { v: 1, strictMode: false, servers: [], bindings: [] };
        const write = (expectedVersion: number, settings: Record<string, unknown>) => inTx(tx => writeAccountSettingsInTx({
            tx, accountId: account.id, expectedVersion, next: { kind: 'v2', content: { t: 'plain', v: settings } },
        }));
        expect(await write(0, { mcpServersSettingsV1: source })).toEqual({ status: 'success', version: 1 });
        await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/mcp/v1/catalog',
            version: 1, value: null } });
        expect(await write(1, { mcpServersSettingsV1: source, unrelatedPreference: true }))
            .toEqual({ status: 'success', version: 2 });
        expect(await write(2, { unrelatedPreference: false })).toEqual({ status: 'success', version: 3 });
        expect(await write(3, { mcpServersSettingsV1: source })).toEqual({ status: 'invalid_content' });
    });

    it('preserves harmless stored MCP metadata through real Account conversion and exact replay', async () => {
        const { accountRoutes } = await import('@/app/api/routes/account/accountRoutes');
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(), settings: null } });
        const rawCatalog = { v: 1, catalogMetadata: { label: 'Retained catalog', weights: [1, 2] }, servers: [{
            id: 'metadata-server', name: 'metadata-server', transport: 'stdio', createdAt: 1, updatedAt: 2,
            serverMetadata: { color: 'blue' }, stdio: { command: 'fixture-mcp', args: [], stdioMetadata: { note: 'Retained' } },
            env: { PUBLIC_CONFIG: { t: 'literal', v: 'retained', literalMetadata: { note: 'Retained' } } },
        }], bindings: [] };
        const envelopeMetadata = { note: 'Retained envelope', flags: [true, false] };
        const source = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_mcp_catalog',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(43) }, payload: rawCatalog,
            randomBytes: tweetnacl.randomBytes }), envelopeMetadata };
        const content = { t: 'plain', v: rawCatalog, envelopeMetadata };
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/mcp/v1/catalog', version: 5,
            value: new TextEncoder().encode(JSON.stringify(source)) } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const payload = { toMode: 'plain', expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0, settingsContent: null, mcpServerCatalog: { expectedRevision: 5, content },
            connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' },
            todos: { action: 'assert_empty' }, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
            reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' } };
        await withAuthenticatedTestApp(app => accountRoutes(app as unknown as Fastify), async app => {
            const headers = { 'x-test-user-id': account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
            const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers, payload };
            const response = await app.inject(options);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ mode: 'plain', mcpServerCatalog: { revision: 6, content } });
            const persisted = await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } });
            expect(persisted.version).toBe(6);
            expect(persisted.value && JSON.parse(new TextDecoder().decode(persisted.value))).toEqual(content);
            expect((await app.inject({ method: 'GET', url: route, headers })).json()).toEqual({ status: 'present', revision: 6, content });
            const replay = await app.inject(options);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
            // Ordinary writes remain strict; stored conversion tolerance is not a new-write bypass.
            expect((await app.inject({ method: 'POST', url: route, headers, payload: { expectedRevision: 6, content } })).statusCode).toBe(400);
        });
    });

    it.each([
        ['plain', 'replace'], ['plain', 'delete'], ['e2ee', 'replace'], ['e2ee', 'delete'],
    ] as const)('refuses ordinary replacement or deletion of a retained unclassified SavedSecret carrier (%s, %s)', async (mode, operation) => {
        const { registerMcpServerCatalogRoutes } = await import('./registerMcpServerCatalogRoutes');
        const account = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const content = mode === 'plain' ? catalog : { t: 'encrypted' as const,
            c: sealAccountScopedBlobCiphertext({ kind: 'account_mcp_catalog',
                material: { type: 'legacy', secret: new Uint8Array(32).fill(43) }, payload: catalog.v, randomBytes: tweetnacl.randomBytes }) };
        const retained = { ...content,
            futureEnvelopeCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:future' } };
        const row = await db.userKVStore.create({ data: { accountId: account.id, key: '@happier/account/mcp/v1/catalog', version: 5,
            value: new TextEncoder().encode(JSON.stringify(retained)) } });
        const accountBefore = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
            const headers = { 'x-test-user-id': account.id };
            const read = await app.inject({ method: 'GET', url: route, headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toEqual({ status: 'present', revision: 5, content: retained });
            const response = await app.inject({ method: 'POST', url: route, headers, payload: {
                expectedRevision: 5, content: operation === 'replace' ? content : null,
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ status: 'invalid-stored-content' });
        });
        expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(accountBefore);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
    });
});

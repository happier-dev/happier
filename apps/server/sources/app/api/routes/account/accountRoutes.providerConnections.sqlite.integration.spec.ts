import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from './accountRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { inTx } from '@/storage/inTx';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
    sealProviderConnectionsContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

describe('Provider connection catalog Account rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-provider-connections-', initEncrypt: true, initFiles: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([false, true])('refuses source recreation after Provider catalog authority, including tombstones (%s)', async deleted => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
        await db.userKVStore.create({ data: { accountId: account.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, version: 5,
            value: deleted ? null : new TextEncoder().encode(JSON.stringify({ t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 })) } });
        const source = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} };
        const recreated = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 3,
            next: { kind: 'v2', content: { t: 'plain', v: { providerSettingsV1: source, theme: 'dark' } } } }));
        expect(recreated).toEqual({ status: 'invalid_content' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(3);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        const stale = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 2,
            next: { kind: 'v2', content: { t: 'plain', v: { theme: 'dark' } } } }));
        expect(stale).toMatchObject({ status: 'version_mismatch', currentVersion: 3 });
        const preference = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 3,
            next: { kind: 'v2', content: { t: 'plain', v: { theme: 'dark' } } } }));
        expect(preference).toEqual({ status: 'success', version: 4 });
    });

    it('allows unchanged cleanup residue and removal but rejects source edits without publishing or history writes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
        const source = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} };
        await db.account.update({ where: { id: account.id }, data: { settings: storePlainAccountSettingsDbValue({
            accountId: account.id, content: { t: 'plain', v: { providerSettingsV1: source, theme: 'light' } },
        }) } });
        await db.userKVStore.create({ data: { accountId: account.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            version: 0, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 })) } });
        const unchanged = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 3,
            next: { kind: 'v2', content: { t: 'plain', v: { providerSettingsV1: source, theme: 'dark' } } } }));
        expect(unchanged).toEqual({ status: 'success', version: 4 });
        const snapshots = await db.accountSettingsSnapshot.count({ where: { accountId: account.id } });
        const changes = await db.accountChange.count({ where: { accountId: account.id } });
        const changed = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 4,
            next: { kind: 'v2', content: { t: 'plain', v: { providerSettingsV1: { ...source, migration: {
                v: 1, completedSources: [], pendingCustomProfileIds: ['source-profile'], pendingConflicts: [],
            } }, theme: 'dark' } } } }));
        expect(changed).toEqual({ status: 'invalid_content' });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(snapshots);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(changes);
        const removed = await inTx(tx => writeAccountSettingsInTx({ tx, accountId: account.id, expectedVersion: 4,
            next: { kind: 'v2', content: { t: 'plain', v: { theme: 'dark' } } } }));
        expect(removed).toEqual({ status: 'success', version: 5 });
    });

    it('preserves scoped Provider configuration under catalog CAS without rewriting Settings or exposing public KV', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app); kvRoutes(app);
        const url = '/v1/account/entity-rows/provider-connections';
        const headers = { 'x-test-user-id': account.id };
        const catalog = {
            v: 1, connections: [{ v: 1, id: 'pc_one', source: { kind: 'contribution', contributionKey: 'happier.provider.openrouter/openrouter' },
                role: 'default', displayName: 'OpenRouter', displayNameMode: 'automatic', deployment: { kind: 'external' },
                revision: 0, createdAt: 1, updatedAt: 1 }], connectionTombstones: [],
            accountGrants: [{ v: 1, connectionId: 'pc_one', connectionSecurityFingerprint: 'connection-security:v1:test', confirmedAt: 1 }],
            machineGrants: [], secretBindingsByConnectionId: {},
            manualModelsByConnectionId: { pc_one: [{ id: 'model/a', name: 'Model A', addedAt: 1 }] },
            modelVisibilityByRef: {}, experimentalBindingConfirmations: [],
        };
        const content = { t: 'plain', v: catalog };
        const capture = { referencedSavedSecretIds: [], savedSecretRevisions: [] };
        try {
            const initial = await app.inject({ method: 'GET', url, headers });
            expect(initial.statusCode, initial.body).toBe(200);
            expect(initial.json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...capture, expectedRevision: 'absent', sourceSettingsVersion: 6, content } })).json())
                .toEqual({ status: 'settings-conflict', revision: 7 });
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...capture, expectedRevision: 'absent', sourceSettingsVersion: 7, content } })).json())
                .toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
            const undeclaredReferences = { t: 'plain', v: { ...catalog, secretBindingsByConnectionId: {
                pc_one: { account: { apiKey: 'happier:shared-secret:v1:missing-resource' } },
            } } };
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                ...capture, expectedRevision: 0, content: undeclaredReferences,
            } })).json()).toEqual({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...capture, expectedRevision: 2, content: null } })).json()).toEqual({ status: 'conflict', revision: 0 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'GET', url: '/v1/kv?prefix=%40happier%2Faccount%2Fprovider-connections', headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...capture, expectedRevision: 0, content: null } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
        } finally { await app.close(); }
    });

    it('rejects additive metadata on ordinary new Plain Provider writes without changing catalog authority', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/provider-connections';
        const headers = { 'x-test-user-id': account.id };
        const content = { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
        const capture = { referencedSavedSecretIds: [], savedSecretRevisions: [] };
        try {
            const initial = await app.inject({ method: 'POST', url, headers, payload: {
                ...capture, expectedRevision: 'absent', sourceSettingsVersion: 7, content,
            } });
            expect(initial.statusCode, initial.body).toBe(200);
            expect(initial.json()).toMatchObject({ status: 'updated', revision: 0 });
            const changes = await db.accountChange.count({ where: { accountId: account.id } });
            for (const candidate of [
                { t: 'plain', v: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, futureCatalogState: { label: 'retained metadata' } } },
                { ...content, retainedEnvelopeLabel: 'retained metadata' },
            ]) {
                const rejected = await app.inject({ method: 'POST', url, headers, payload: {
                    ...capture, expectedRevision: 0, content: candidate,
                } });
                expect(rejected.statusCode, rejected.body).toBe(400);
                expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
            }
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(changes);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it.each([true, false])('requires complete E2EE outer reference inventory before ordinary replacement (%s)', async incomplete => {
        const machineKey = new Uint8Array(32).fill(17);
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', settingsVersion: 7,
            ...createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey) } });
        const content = sealProviderConnectionsContentV1({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            mode: 'e2ee', material: { type: 'dataKey', machineKey } });
        const stored = { ...content, ...(incomplete
            ? { retainedCredential: { secretRef: 'happier:shared-secret:v1:unclassified' } }
            : { retainedEnvelopeLabel: 'harmless metadata' }) };
        const row = await db.userKVStore.create({ data: { accountId: account.id,
            key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, version: 3,
            value: new TextEncoder().encode(JSON.stringify(stored)) } });
        const app = createAuthenticatedTestApp() as Fastify;
        accountRoutes(app);
        const url = '/v1/account/entity-rows/provider-connections';
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 3, content: stored });
            const replacement = await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 3, content, referencedSavedSecretIds: [], savedSecretRevisions: [],
            } });
            expect(replacement.statusCode, replacement.body).toBe(200);
            if (incomplete) {
                expect(replacement.json()).toEqual({ status: 'invalid-stored-content' });
                expect(await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
                expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
            } else {
                expect(replacement.json()).toMatchObject({ status: 'updated', revision: 4 });
                expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 4, content });
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION }
    from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { ConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

const service = { pluginId: 'happier.connected-account.example', localId: 'cloud' };
const consumer = { pluginId: 'happier.agent.example', localId: 'coding' };
const configurations = { t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [
    { service, modeId: 'native-api', revision: 'config-1', values: { region: 'eu', adapter: { preserve: true } }, secretRefs: {} },
] } } } satisfies ConnectedAccountCatalogContentV1;
const purposes = { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [
    { purpose: { consumer, purpose: 'native-api' }, target: { kind: 'group', service, groupId: 'pool' } },
], teamResourceSelections: [
    { purpose: { consumer, purpose: 'model-api' }, teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } },
] } } } satisfies ConnectedAccountCatalogContentV1;

describe('Connected Account configuration and purpose catalogs (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-connected-catalogs-', initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([['configurations', configurations], ['purposes', purposes]] as const)(
        'admits %s initialization and isolates row CAS from Settings and another Account', async (key, content) => {
            const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
            const other = await db.account.create({ data: { encryptionMode: 'plain' } });
            const app = createAuthenticatedTestApp() as Fastify;
            accountRoutes(app); kvRoutes(app);
            const url = `/v1/account/entity-rows/connected-accounts/${key}`;
            const headers = { 'x-test-user-id': account.id };
            try {
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
                expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'absent' });
                expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 6, content } })).json())
                    .toEqual({ status: 'settings-conflict', revision: 7 });
                expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 'absent', sourceSettingsVersion: 7, content } })).json())
                    .toMatchObject({ status: 'updated', revision: 0 });
                expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 0, content });
                expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).json()).toEqual({ status: 'absent' });
                expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 2, content: null } })).json())
                    .toEqual({ status: 'conflict', revision: 0 });
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(7);
                expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
                expect((await app.inject({ method: 'GET', url: '/v1/kv?prefix=%40happier%2Faccount%2Fconnected-', headers })).statusCode).toBe(400);
                expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content: null } })).json())
                    .toMatchObject({ status: 'updated', revision: 1 });
                expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'deleted', revision: 1 });
            } finally { await app.close(); }
        },
    );

    it('preserves raw Plain neighbors for owner diagnostics and refuses addressed-domain and mode mismatch', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const url = '/v1/account/entity-rows/connected-accounts/configurations';
        const physicalKey = '@happier/account/connected-configurations/v1/catalog';
        try {
            const raw = { ...configurations, futureMetadata: { retained: true }, futureSecretId: 'opaque-outer', v: { ...configurations.v,
                value: { ...configurations.v.value, entries: [...configurations.v.value.entries,
                    { ...configurations.v.value.entries[0], modeId: null }], futureSecretId: 'opaque' } } };
            await db.userKVStore.create({ data: { accountId: account.id, key: physicalKey, version: 4,
                value: new TextEncoder().encode(JSON.stringify(raw)) } });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 4, content: raw });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 4, content: purposes } })).json())
                .toMatchObject({ status: 'invalid-stored-content' });
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: physicalKey } },
                data: { value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: 'invalid-ciphertext' })) } });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ status: 'account-mode-mismatch' });
            expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 4, content: { t: 'encrypted', c: 'invalid-ciphertext' } } })).json())
                .toMatchObject({ status: 'account-mode-mismatch' });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: physicalKey } } })).version).toBe(4);
        } finally { await app.close(); }
    });

    it.each([['configurations', configurations, 'connectedAccountServiceConfigurationsV1'],
        ['purposes', purposes, 'connectedAccountPurposeBindingsV1']] as const)(
        'prevents %s source resurrection while admitting identical residue and cleanup', async (key, content, root) => {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
            const headers = { 'x-test-user-id': account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
            const rowUrl = `/v1/account/entity-rows/connected-accounts/${key}`;
            const raw = { [root]: content.v.value, futurePreference: 'first' };
            const write = async (version: number, value: Readonly<Record<string, unknown>>) => (await app.inject({
                method: 'POST', url: '/v2/account/settings', headers,
                payload: { expectedVersion: version, content: { t: 'plain', v: value } },
            })).json();
            try {
                expect(await write(0, raw)).toMatchObject({ success: true, version: 1 });
                expect((await app.inject({ method: 'POST', url: rowUrl, headers, payload: {
                    expectedRevision: 'absent', sourceSettingsVersion: 1, content,
                } })).json()).toMatchObject({ status: 'updated', revision: 0 });
                expect(await write(1, { ...raw, futurePreference: 'second' })).toMatchObject({ success: true, version: 2 });
                expect(await write(2, { ...raw, [root]: { ...content.v.value, futureSourceField: true } }))
                    .toMatchObject({ error: 'invalid-params' });
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(2);
                expect(await write(2, { futurePreference: 'second' })).toMatchObject({ success: true, version: 3 });
                expect(await write(3, raw)).toMatchObject({ error: 'invalid-params' });
                expect((await app.inject({ method: 'POST', url: rowUrl, headers, payload: { expectedRevision: 0, content: null } })).json())
                    .toMatchObject({ status: 'updated', revision: 1 });
                expect(await write(3, raw)).toMatchObject({ error: 'invalid-params' });
                expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json())
                    .toEqual({ version: 3, content: { t: 'plain', v: { futurePreference: 'second' } } });
            } finally { await app.close(); }
        });

    it('pairs purpose-row CAS with canonical Settings CAS and refuses malformed shared references without publishing', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 3 } });
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const headers = { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const url = '/v1/account/entity-rows/connected-accounts/purposes';
        try {
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 3, content: purposes,
            } })).json()).toMatchObject({ status: 'updated', revision: 0 });
            const nextSettings = { t: 'plain', v: { futurePreference: 'preserve' } };
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 0, content: purposes, settingsMutation: { expectedSettingsVersion: 2, content: nextSettings },
            } })).json()).toEqual({ status: 'settings-conflict', revision: 3 });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ status: 'present', revision: 0 });
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 0, content: purposes, settingsMutation: { expectedSettingsVersion: 3, content: nextSettings },
            } })).json()).toMatchObject({ status: 'updated', revision: 1, settingsVersion: 4 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
            expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json())
                .toEqual({ content: nextSettings, version: 4 });
            expect(await db.accountSettingsSnapshot.findMany({ where: { accountId: account.id }, select: { version: true }, orderBy: { version: 'asc' } }))
                .toEqual([{ version: 3 }, { version: 4 }]);
            expect((await app.inject({ method: 'POST', url, headers, payload: {
                expectedRevision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
                settingsMutation: { expectedSettingsVersion: 4, content: { t: 'encrypted', c: 'wrong-account-mode' } },
            } })).json()).toMatchObject({ status: 'invalid-stored-content' });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ status: 'present', revision: 1, content: purposes });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(4);
            const malformedRef = 'happier:shared-secret:v1:';
            const content = { ...configurations, v: { ...configurations.v, value: { ...configurations.v.value,
                entries: [{ ...configurations.v.value.entries[0], secretRefs: { token: malformedRef } }],
            } } };
            expect((await app.inject({ method: 'POST', url: '/v1/account/entity-rows/connected-accounts/configurations', headers, payload: {
                expectedRevision: 'absent', sourceSettingsVersion: 4, content, referencedSavedSecretIds: [malformedRef],
            } })).json()).toMatchObject({ status: 'invalid-reference' });
            expect((await app.inject({ method: 'GET', url: '/v1/account/entity-rows/connected-accounts/configurations', headers })).json())
                .toEqual({ status: 'absent' });
        } finally { await app.close(); }
    });
});

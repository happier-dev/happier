import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION }
    from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { buildConnectedAccountCatalogPhysicalKeyV1, connectedAccountCatalogCipherKindV1,
    type ConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { applySavedSecretCatalogVoiceCredentialSourceMutationV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { inTx } from '@/storage/inTx';
import { createSavedSecretResourceInTx, setSavedSecretResourceGrantsInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

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

    it.each([configurations, purposes])('preserves original stored metadata during actual $v.key conversion and exact replay', async fixture => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1', HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none' });
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee', settings: null } });
        const key = fixture.v.key;
        const payload = { ...fixture.v, retainedWrapper: { color: 'blue' }, value: key === 'configurations'
            ? { ...fixture.v.value, retainedCatalog: { color: 'green' }, entries: configurations.v.value.entries.map(entry => ({ ...entry, retainedEntry: { color: 'red' } })) }
            : { ...fixture.v.value, retainedCatalog: { color: 'green' }, bindings: purposes.v.value.bindings.map(binding => ({ ...binding, retainedEntry: { color: 'red' } })) } };
        const source = { t: 'encrypted', retainedEnvelope: { color: 'orange' }, c: sealAccountScopedBlobCiphertext({
            kind: connectedAccountCatalogCipherKindV1(key), material: { type: 'legacy', secret: new Uint8Array(32).fill(41) },
            payload, randomBytes: length => new Uint8Array(length).fill(35),
        }) };
        const physicalKey = buildConnectedAccountCatalogPhysicalKeyV1(key);
        await db.userKVStore.create({ data: { accountId: account.id, key: physicalKey, version: 7,
            value: new TextEncoder().encode(JSON.stringify(source)) } });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(account);
        const target = { t: 'plain', v: payload, retainedEnvelope: source.retainedEnvelope };
        const field = key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes';
        const request = { toMode: 'plain', expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint, expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0, settingsContent: null,
            connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' },
            todos: { action: 'assert_empty' }, artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
            reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
            [field]: { expectedRevision: 7, content: target } };
        const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
        const options = { method: 'POST' as const, url: '/v1/account/encryption/migrate', headers: { 'x-test-user-id': account.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } };
        try {
            expect((await app.inject({ ...options, payload: { ...request,
                [field]: { expectedRevision: 7, content: { ...target, futureSecretId: formatSharedSavedSecretRefV1('unknown') } } } })).statusCode).toBe(400);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(account);
            const response = await app.inject({ ...options, payload: request });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()[field]).toEqual({ row: { revision: 8, content: target } });
            const committed = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: physicalKey } } });
            expect(JSON.parse(new TextDecoder().decode(committed.value!))).toEqual(target);
            const replay = await app.inject({ ...options, payload: request });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(response.json());
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: physicalKey } } })).toEqual(committed);
        } finally { await app.close(); }
    });

    it.each(['revoked-without-proof', 'current-with-proof', 'same-ref-current-with-proof', 'same-ref-revoked-with-proof', 'unbound-extra-proof'] as const)(
        'checks the actual paired Voice selected resource (%s) without deleting personal material', async scenario => {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const resourceId = `voice-bound-${account.id}`;
            const reference = formatSharedSavedSecretRefV1(resourceId);
            const created = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
                displayName: 'Voice credential', kind: 'apiKey', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Voice credential', kind: 'apiKey', value: 'private-voice-key' } } }));
            expect(created.ok).toBe(true);
            if (!created.ok) throw new Error('Resource fixture must be admitted');
            // The persistent grant boundary represents an already shared resource.
            await db.savedSecretAccountGrant.create({ data: { resourceId, accountId: account.id, createdByAccountId: owner.id } });
            if (scenario === 'revoked-without-proof' || scenario === 'same-ref-revoked-with-proof') {
                expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: owner.id, resourceId,
                    expectedRevision: created.value.revision, accountGrants: [], teamGrants: [], groupGrants: [] })))
                    .toMatchObject({ ok: true });
            }
            const contribution = { pluginId: 'happier.voice.openai', localId: 'realtime-openai' };
            const declaration = VoiceProviderContributionSchema.parse({ id: contribution.localId, title: 'Voice provider',
                kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
                capabilities: { turn: { cancelResponse: false, bargeIn: false } },
                credentials: { slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                    requirement: { kind: 'always' }, sources: [{ kind: 'savedSecret', secretKinds: ['apiKey'], rawGrants: [{
                        realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization'] },
                    }] }] }, client: { artifactId: 'web-runtime', exportName: 'activate' } });
            let current: Readonly<Record<string, unknown>> = { voiceSettingsV1: { credentialBindings: [{ contribution, credentialSlotId: 'api_key',
                credentialSource: { kind: 'none' }, credentialBindings: {} }] }, secrets: [] };
            const purposeValue = { v: 1 as const, bindings: [] };
            const bind = (settings: Readonly<Record<string, unknown>>, expectedSecretId: string | null) =>
                applySavedSecretCatalogVoiceCredentialSourceMutationV1(settings, { contribution, credentialSlotId: 'api_key',
                selection: { kind: 'savedSecret' }, expectedSettingsVersion: 1,
                savedSecretMutation: { kind: 'bindVoiceCredentialSavedSecret', target: { contribution, credentialSlotId: 'api_key', machineId: null },
                    secretId: reference, expectedSecretId, expectedSecretUpdatedAt: null } }, declaration,
                { profileRecords: [], connectedPurposes: purposeValue });
            const sameReference = scenario.startsWith('same-ref-');
            if (sameReference) current = bind(current, null).settings;
            const next = bind(current, sameReference ? reference : null);
            expect(next.settings.secrets).toEqual([]);
            const references = scenario === 'revoked-without-proof' ? [] : [reference];
            const captures = references.map(() => ({ resourceId, expectedRevision: created.value.revision }));
            if (scenario === 'unbound-extra-proof') {
                const unboundId = `voice-unbound-${account.id}`;
                const unbound = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId: unboundId,
                    displayName: 'Unselected credential', kind: 'apiKey', encryptionMode: 'plain',
                    storedContent: { t: 'plain', v: { v: 1, name: 'Unselected credential', kind: 'apiKey', value: 'private-unselected-key' } } }));
                expect(unbound.ok).toBe(true);
                if (!unbound.ok) throw new Error('Unbound resource fixture must be admitted');
                references.push(formatSharedSavedSecretRefV1(unboundId));
                captures.push({ resourceId: unboundId, expectedRevision: unbound.value.revision });
            }
            const admitted = scenario === 'current-with-proof' || scenario === 'same-ref-current-with-proof';
            const app = createAuthenticatedTestApp() as Fastify; accountRoutes(app);
            const headers = { 'x-test-user-id': account.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
            const url = '/v1/account/entity-rows/connected-accounts/purposes';
            const content = { t: 'plain', v: { key: 'purposes', value: purposeValue } } satisfies ConnectedAccountCatalogContentV1;
            try {
                expect((await app.inject({ method: 'POST', url: '/v2/account/settings', headers,
                    payload: { expectedVersion: 0, content: { t: 'plain', v: current } } })).json())
                    .toMatchObject({ success: true, version: 1 });
                expect((await app.inject({ method: 'POST', url, headers,
                    payload: { expectedRevision: 'absent', sourceSettingsVersion: 1, content } })).json())
                    .toMatchObject({ status: 'updated', revision: 0 });
                const result = (await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: 0, content,
                    settingsMutation: { expectedSettingsVersion: 1, content: { t: 'plain', v: next.settings } },
                    referencedSavedSecretIds: references, savedSecretRevisions: captures,
                } })).json();
                expect(result).toMatchObject(admitted
                    ? { status: 'updated', revision: 1, settingsVersion: 2 } : { status: 'invalid-reference' });
                expect((await app.inject({ method: 'GET', url, headers })).json())
                    .toMatchObject({ status: 'present', revision: admitted ? 1 : 0 });
                expect((await app.inject({ method: 'GET', url: '/v2/account/settings', headers })).json())
                    .toEqual({ version: admitted ? 2 : 1,
                        content: { t: 'plain', v: admitted ? next.settings : current } });
                expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id, version: 2 } }))
                    .toBe(admitted ? 1 : 0);
            } finally { await app.close(); }
        },
    );

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

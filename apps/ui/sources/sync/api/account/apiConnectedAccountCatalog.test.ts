import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowReadResponseV1Schema, sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { encodeBase64 } from '@/encryption/base64';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { executeConnectedServiceConfigurationActionV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { withConnectedAccountCatalogAccount, createUiConnectedServiceConfigurationCatalogHost, readConnectedAccountCatalogInContext,
    readConnectedAccountCatalog } = await import('./apiConnectedAccountCatalog');
beforeEach(async () => {
    await home.reset();
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
});
afterEach(async () => { await home.reset(); resetRuntimeFetch(); });

describe('Connected configuration Account transport', () => {
    it.each(['plain', 'e2ee'] as const)('links, replaces and clears existing Secret references in a %s Account without material reads', async accountMode => {
        const service = { pluginId: 'custom.reference-config', localId: 'service' };
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [],
            configuration: { scope: 'service', changeBehavior: 'refresh', fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] } });
        const entries = ['first', 'second'].map(id => SavedSecretCatalogEntryV1Schema.parse({ ref: `happier:shared-secret:v1:${id}`,
            source: 'shared_resource', relationship: 'owner', name: id, kind: 'token', revision: id === 'first' ? 7 : 9,
            materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }));
        const accountId = 'reference-config-owner';
        const secret = new Uint8Array(32).fill(19);
        const credentials = { token: createAccountTokenForTests(accountId),
            ...(accountMode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
        let row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
            content: sealConnectedAccountCatalogContentV1({ mode: accountMode,
                material: accountMode === 'e2ee' ? { type: 'legacy', secret } : null, record: {
            key: 'configurations', value: { v: 1, entries: [{ service, modeId: mode.id, revision: 'before', values: {}, secretRefs: {} }] },
        } }) });
        const serverId = await home.addHome({ name: 'Reference configuration', serverUrl: 'https://reference-config.test',
            accountId, credentials, currentAccount: true, accountEncryptionMode: accountMode, active: false });
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/configurations', { select: () => ({ body: row }) });
        home.answer(serverId, 'GET /v1/account/saved-secrets/resources', { body: { resources: entries } });
        const writes: ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>[] = [];
        home.answer(serverId, 'POST /v1/account/entity-rows/connected-accounts/configurations', { select: input => {
            const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(input);
            writes.push(mutation);
            if (mutation.savedSecretRevisions.some(proof => !entries.some(entry => entry.ref === `happier:shared-secret:v1:${proof.resourceId}`
                && entry.revision === proof.expectedRevision))) return { body: { status: 'invalid-reference' } };
            const revision = Number(mutation.expectedRevision) + 1;
            row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision, content: mutation.content });
            return { body: { status: 'updated', revision, cursor: revision } };
        } });
        await withConnectedAccountCatalogAccount({ serverId, accountId }, undefined, async context => {
            const host = { assertCurrent: context.assertCurrent, configurationCatalog: createUiConnectedServiceConfigurationCatalogHost(context, async () => mode),
                async request() { throw new Error('unexpected_operation'); }, async mutatePurposeBindings() {}, async resolveAgent() { return null; }, async resetQuota() {} };
            const target = { service, modeId: mode.id };
            let expectedRevision = 'before';
            for (const selection of [{ ref: entries[0]!.ref, resourceRevision: 7 }, { ref: entries[1]!.ref, resourceRevision: 9 }, null]) {
                const result = await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.replace', { ...target,
                    expectedRevision, values: {}, secretValues: {}, selectedSecrets: { token: selection } });
                expect(result).toMatchObject({ applied: true });
                const observed = await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.get', target);
                expect(observed).toMatchObject({ configuration: { secretRefs: selection ? { token: selection.ref } : {} } });
                expectedRevision = (result as { revision: string }).revision;
            }
            expect(await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.replace', { ...target,
                expectedRevision, values: {}, secretValues: {}, selectedSecrets: { token: { ref: entries[0]!.ref, resourceRevision: 6 } } }))
                .toMatchObject({ ok: false, errorCode: 'invalid-reference' });
        });
        expect(writes[0]?.savedSecretRevisions).toEqual([{ resourceId: 'first', expectedRevision: 7 }]);
        expect(writes[1]?.savedSecretRevisions).toEqual([{ resourceId: 'second', expectedRevision: 9 }]);
        expect(writes[2]?.savedSecretRevisions).toEqual([]);
        expect(home.requests.some(request => request.path.includes('/materials') || request.path.includes('/promote'))).toBe(false);
    });

    it.each(['active', 'absent-empty', 'absent-legacy', 'active-maintenance'] as const)(
        'bounds a current catalog read to its destination while retaining real source maintenance (%s)', async initial => {
        const accountId = `current-config-${initial}`;
        const sourceValue = { v: 1 as const, entries: [] };
        const root = 'connectedAccountServiceConfigurationsV1';
        let raw: Record<string, unknown> = { preferredLanguage: 'de',
            ...(initial === 'absent-legacy' || initial === 'active-maintenance' ? { [root]: sourceValue } : {}) };
        let settingsVersion = 41;
        let revision = 3;
        const record = () => ({ key: 'configurations', value: { v: 1, entries: [{
            service: { pluginId: 'custom.current', localId: 'service' }, modeId: 'manual', revision: `current-${revision}`,
            values: { endpoint: `https://current-${revision}.example.test` }, secretRefs: {},
        }] } });
        let row = ConnectedAccountCatalogRowReadResponseV1Schema.parse(initial.startsWith('active')
            ? { status: 'present', revision, content: { t: 'plain', v: record() } } : { status: 'absent' });
        const serverId = await home.addHome({ name: 'Current configuration', serverUrl: `https://${accountId}.test`,
            accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { select: () => ({
            body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }),
        }) });
        home.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version: settingsVersion, content: { t: 'plain', v: raw } } }) });
        home.answer(serverId, 'GET /v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
        const destination = '/v1/account/entity-rows/connected-accounts/configurations';
        home.answer(serverId, `GET ${destination}`, { select: () => ({ body: row }) });
        home.answer(serverId, `POST ${destination}`, { select: input => {
            const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe('absent');
            expect(mutation.sourceSettingsVersion).toBe(41);
            row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: mutation.content });
            return { body: { status: 'updated', revision: 1, cursor: 1 } };
        } });
        home.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(mutation.expectedVersion).toBe(settingsVersion);
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain source cleanup');
            raw = mutation.content.v;
            return { body: { success: true, version: ++settingsVersion } };
        } });
        const versions = Array.from({ length: 25 }, (_, index) => index + 1);
        home.answer(serverId, 'GET /v2/account/settings/history', { body: { snapshots: versions.map(version => ({
            version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
        })) } });
        for (const version of versions) {
            home.answer(serverId, `GET /v2/account/settings/history/${version}`, { body: { version,
                createdAt: '2026-01-01T00:00:00.000Z', content: { t: 'plain', v: { [root]: sourceValue, preferredLanguage: 'de' } },
            } });
            home.answer(serverId, `POST /v2/account/settings/history/${version}/mutate`, { body: { status: 'applied' } });
        }
        const before = home.requests.length;
        const scope = { serverId, accountId };
        await withConnectedAccountCatalogAccount(scope, undefined, async context => {
            const first = initial === 'active-maintenance'
                ? await readConnectedAccountCatalogInContext(context, 'configurations')
                : await readConnectedAccountCatalog(scope, 'configurations');
            expect(first).toMatchObject({ status: 'ready', revision: initial.startsWith('active') ? 3 : 1 });
            if (initial === 'active') {
                revision = 4;
                row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision, content: { t: 'plain', v: record() } });
                expect(await readConnectedAccountCatalog(scope, 'configurations')).toMatchObject({ status: 'ready', revision: 4,
                    record: { value: { entries: [{ values: { endpoint: 'https://current-4.example.test' } }] } } });
            }
        });
        const requests = home.requests.slice(before);
        const history = requests.filter(request => request.path.startsWith('/v2/account/settings/history'));
        if (initial === 'active' || initial === 'absent-empty') {
            expect(history.map(request => request.path)).toEqual([]);
            expect(requests.filter(request => request.path.startsWith('/v1/account/entity-rows/') && request.path !== destination)).toEqual([]);
        } else {
            expect(history.filter(request => /^\/v2\/account\/settings\/history\/\d+$/.test(request.path))).toHaveLength(25);
            expect(history.filter(request => request.path.endsWith('/mutate'))).toHaveLength(25);
            expect(raw).toEqual({ preferredLanguage: 'de' });
        }
        if (initial === 'active') expect(requests.filter(request => request.path === '/v2/account/settings')).toEqual([]);
    });

    it.each(['current', 'maintenance'] as const)('re-admits an opened catalog before its early publication when revocation precedes the socket event (%s)', async intent => {
        const accountId = 'held-configuration-owner';
        const serverId = await home.addHome({ name: 'Held configuration', serverUrl: 'https://held-account-config.test',
            accountId, currentAccount: true, accountEncryptionMode: 'plain', active: false });
        let revoked = false;
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { select: () => revoked
            ? { status: 401, body: { error: 'unauthorized' } } : { body: createPlainAccountEncryptionCurrentnessFixture() } });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/configurations', { select: () => {
            // The private HTTP body was admitted before this committed epoch
            // change. Its corresponding Account publication remains held.
            revoked = true;
            return { body: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                content: { t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [{
                    service: { pluginId: 'custom.private', localId: 'service' }, modeId: 'manual', revision: 'private',
                    values: { endpoint: 'https://private.example.test' }, secretRefs: {},
                }] } } } }) };
        } });
        let disclosed = false;
        await withConnectedAccountCatalogAccount({ serverId, accountId }, undefined, async context => {
            const publication = {
                onReady: catalog => { if (catalog.status === 'ready' || catalog.status === 'partial') disclosed = true; },
                hasPendingCleanup: () => true,
            } satisfies NonNullable<Parameters<typeof readConnectedAccountCatalogInContext>[3]>;
            const result = intent === 'current'
                ? await readConnectedAccountCatalog({ serverId, accountId }, 'configurations', undefined, undefined, publication)
                : await readConnectedAccountCatalogInContext(context, 'configurations', undefined, publication);
            expect(result.status).toBe('unavailable');
        });
        expect(disclosed).toBe(false);
    });

    it.each(['absent', 'absent_lost_receipt', 'deleted'] as const)('prepares a direct no-machine configuration Action through captured %s Account authority', async initial => {
        const service = { pluginId: 'custom.account-config', localId: 'service' };
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [],
            configuration: { scope: 'service', changeBehavior: 'refresh', fields: [{ id: 'endpoint', title: 'Endpoint', required: true,
                schema: { type: 'string' } }] } });
        const sourceValue = { v: 1 as const, entries: [{ service, modeId: mode.id, revision: 'retained',
            values: { endpoint: 'https://retained.example.test' }, secretRefs: {} }] };
        let raw: Readonly<Record<string, unknown>> = { futureSibling: { preserved: true }, connectedAccountServiceConfigurationsV1: sourceValue };
        let settingsVersion = 41;
        let row: ReturnType<typeof ConnectedAccountCatalogRowReadResponseV1Schema.parse> = initial === 'deleted'
            ? { status: 'deleted', revision: 7 } : { status: 'absent' };
        const serverId = await home.addHome({ name: 'Direct Account configuration', serverUrl: `https://${initial}-account-config.example.test`,
            accountId: 'config-owner', currentAccount: true, accountEncryptionMode: 'plain', active: false });
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version: settingsVersion, content: { t: 'plain', v: raw } } }) });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/configurations', { select: () => ({ body: row }) });
        home.answer(serverId, 'POST /v1/account/entity-rows/connected-accounts/configurations', { select: input => {
            const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe(row.status === 'absent' ? 'absent' : 7);
            if (mutation.expectedRevision === 'absent') expect(mutation.sourceSettingsVersion).toBe(41);
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain captured configuration');
            row = { status: 'present', revision: 7, content: mutation.content };
            return initial === 'absent_lost_receipt' && mutation.expectedRevision === 'absent'
                ? { dispatchThenFail: true } : { body: { status: 'updated', revision: 7, cursor: 7 } };
        } });
        home.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(mutation.expectedVersion).toBe(settingsVersion);
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain captured Account');
            raw = mutation.content.v;
            return { body: { success: true, version: ++settingsVersion } };
        } });
        await withConnectedAccountCatalogAccount({ serverId, accountId: 'config-owner' }, undefined, async context => {
            const host = { assertCurrent: context.assertCurrent,
                configurationCatalog: createUiConnectedServiceConfigurationCatalogHost(context, async () => mode),
                async request() { throw new Error('Unexpected machine or Account operation'); }, async mutatePurposeBindings() {},
                async resolveAgent() { return null; }, async resetQuota() { throw new Error('Unexpected machine operation'); } };
            const observed = await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.get', { service, modeId: mode.id });
            expect(observed).toMatchObject({ configuration: initial !== 'deleted'
                ? { revision: 'retained', values: sourceValue.entries[0]!.values }
                : { revision: null, values: {}, status: 'configurationRequired' } });
            expect(await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.replace', {
                service, modeId: mode.id, expectedRevision: initial !== 'deleted' ? 'retained' : null,
                values: { endpoint: 'https://updated.example.test' }, secretValues: {},
            })).toMatchObject({ applied: true });
            expect(await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.configuration.get', { service, modeId: mode.id }))
                .toMatchObject({ configuration: { values: { endpoint: 'https://updated.example.test' } } });
        });
        expect(raw).toEqual({ futureSibling: { preserved: true },
            ...(initial === 'deleted' ? { connectedAccountServiceConfigurationsV1: sourceValue } : {}) });
        const rowWrites = home.requests.filter(request => request.path === '/v1/account/entity-rows/connected-accounts/configurations'
            && request.input != null);
        expect(rowWrites).toHaveLength(initial !== 'deleted' ? 2 : 1);
        expect(home.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    });

});

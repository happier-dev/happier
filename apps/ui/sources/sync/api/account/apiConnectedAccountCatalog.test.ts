import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol';
import { executeConnectedServiceConfigurationActionV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { withConnectedAccountCatalogAccount, createUiConnectedServiceConfigurationCatalogHost } from './apiConnectedAccountCatalog';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeEach(async () => {
    await home.reset();
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
});
afterEach(async () => { await home.reset(); resetRuntimeFetch(); });

describe('Connected configuration Account transport', () => {
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

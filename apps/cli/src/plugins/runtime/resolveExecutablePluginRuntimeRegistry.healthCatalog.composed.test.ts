import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { definePlugin, HealthCheckResultV1ProtocolSchema, SavedHealthCheckSelectorV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { healthCatalogActions } from '../../../../../packages/plugins/machine-services/src/healthCatalog';

it('publishes installed health kinds through the real registry catalog Action', async () => {
    const pluginId = 'example.health-catalog';
    const machineId = 'health-catalog-machine';
    const credentials = { token: 'health-catalog-fixture', encryption: null } as const;
    // Only credential-file and Home HTTP reads are boundaries; contribution
    // admission, activation, invocation and the health service stay real.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'health-catalog-account' } };
        throw new Error(`Unexpected Home GET ${String(url)}`);
    });
    const configSchema = defineProtocolObject({}, { policy: 'closed' });
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        healthCheckKinds: { endpoint: { title: 'Installed endpoint', configSchema: configSchema.jsonSchema, action: 'finite' } },
        actions: { ...healthCatalogActions, finite: { title: 'Read saved endpoint', execution: { target: 'daemon' },
            scopes: ['machine'], surfaces: ['cli', 'plugin'], dangerLevel: 'safe', readOnly: true,
            inputSchema: SavedHealthCheckSelectorV1ProtocolSchema, resultSchema: HealthCheckResultV1ProtocolSchema,
            run: () => { throw new Error('Catalog discovery must not execute a check'); } } },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
        plugins: [{ manifest: plugin.manifest, includeAvailability: true, files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        runtimeOptions: { resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'health-catalog-home', machineId }),
            scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false }) } },
    });
    try {
        await fixture.registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'health/kinds' }]);
        expect(await fixture.registry.targetActionInvocations!.invoke({ pluginId, localId: 'health/kinds',
            surface: 'cli', input: {} })).toMatchObject({ status: 'executed', value: expect.arrayContaining([expect.objectContaining({
                pluginId, id: 'endpoint', title: 'Installed endpoint', action: 'finite',
            })]) });
    } finally { await fixture.dispose(); vi.restoreAllMocks(); }
});

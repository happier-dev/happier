import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { readDeclaredPackageAssetsV1 } from '@happier-dev/protocol/plugins/availability/packageAssetV1';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';

// Stored login is the persistence boundary. Keep declaration projection,
// activation, Action dispatch, schemas and saved-health setup real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

const draft = {
    v: 1,
    subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
    checks: [{
        checkId: 'tcp',
        kind: { pluginId: 'happier.machine.services', localId: 'tcp' },
        binding: { kind: 'healthCheck' },
        config: { host: 'service.example', port: 443 },
        periodMs: 1000,
        consecutiveFailuresBeforeAlerting: 1,
    }],
};

function runtimeOptions() {
    return {
        resolveCurrentMachineId: () => 'observer',
        scopedActionRuntime: {
            credentials: {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'health-account' })).toString('base64url')}.signature`,
                encryption: null,
                credentialProvenance: 'stored_session' as const,
            },
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }),
        },
    };
}

async function invokeSetup(runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>) {
    const executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        invokeContributedAction: createDaemonExternalActionContributedInvoker({
            acquireRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry(),
        }),
    });
    return await executor.execute('action.invoke', { action: { pluginId: plugin.manifest.id, localId: 'health/setup' }, input: draft },
        { surface: 'api', authority: 'present_user', actionCaller: { kind: 'host' } });
}

it('exposes saved health setup through the actual bundled daemon catalog', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { ...runtimeOptions(), pluginIds: [plugin.manifest.id] } });
    try {
        const result = await invokeSetup(runtime);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { v: 1, sourceConfig: draft, sourceContractVersion: 1 } });
    } finally {
        await runtime.dispose();
    }
});

it('admits API setup at the authored Action surface once its physical plugin is installed', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{
            manifest: plugin.manifest,
            files: { '.happier-plugin/daemon.js': 'export function activate() {}',
                ...Object.fromEntries(await Promise.all((readDeclaredPackageAssetsV1(plugin.manifest) ?? []).map(async resource =>
                    [resource.path, await readFile(new URL(`../../../../../packages/plugins/machine-services/${resource.path}`, import.meta.url))]))),
            },
            instantiateCommittedModule: () => ({ activate: plugin.activate }),
        }],
        runtimeOptions: runtimeOptions(),
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    try {
        const result = await invokeSetup(runtime);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { v: 1, sourceConfig: draft, sourceContractVersion: 1 } });
    } finally {
        await runtime.dispose();
    }
});

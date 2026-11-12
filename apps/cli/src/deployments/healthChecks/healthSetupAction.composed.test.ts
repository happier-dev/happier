import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import axios from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
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
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
            files: { [plugin.manifest.entrypoints.daemon.replace(/^\.\//, '')]: 'export function activate() {}',
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


it('loads default alerts through the actual mounted Health Event Action RPC', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    // Home HTTP is the boundary: preserve source selection, defaults bootstrap,
    // installed plugin activation, mounted admission and Action execution.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v2/account/settings') return { status: 200,
            data: { version: 1, content: { t: 'plain', v: {} } } };
        throw new Error(`Unexpected Health setup GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v3/automations/query') return { status: 200,
            data: { automations: [], nextCursor: null } };
        throw new Error(`Unexpected Health setup POST ${path}`);
    });
    const restoreRequest = installAxiosRequestMethodAdapter();
    const machineId = 'observer';
    const origin = { serverIdentityId: 'srv_health-setup', machineId };
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: plugin.manifest,
            files: { [plugin.manifest.entrypoints.daemon.replace(/^\.\//, '')]: 'export function activate() {}',
                ...Object.fromEntries(await Promise.all((readDeclaredPackageAssetsV1(plugin.manifest) ?? []).map(async resource =>
                    [resource.path, await readFile(new URL(`../../../../../packages/plugins/machine-services/${resource.path}`, import.meta.url))]))),
            }, instantiateCommittedModule: () => ({ activate: plugin.activate }),
        }],
        runtimeOptions: { ...runtimeOptions(), resolveCurrentMachineExecutionOriginContext: () => origin },
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    try {
        const handlers = new Map<string, RpcHandler>();
        registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => runtime.registry, resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: () => origin,
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const occurrenceId = runtime.registry.readPluginOccurrenceId?.(plugin.manifest.id);
        const sourceCustody = runtime.registry.readPluginSourceCustody?.(plugin.manifest.id);
        const materializationRef = runtime.registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id);
        if (!handler || !occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected current mounted Health Event');
        expect(runtime.registry.pluginDiagnosticsByPluginId[plugin.manifest.id] ?? []).toEqual([]);
        const result = await handler({ machineId, qualifiedActionId: `${plugin.manifest.id}/health/setup`,
            expectedContributorOccurrenceId: occurrenceId, executionSurface: 'ui',
            input: { v: 1, mode: 'preview', subject: draft.subject },
            invocation: { kind: 'mountedPluginSurface', mountedBinding: { pluginId: plugin.manifest.id,
                contributionLocalId: HEALTH_CHECK_EVENT_REFS_V1.failed.localId,
                occurrenceId, sourceCustody, materializationRef } },
        }, { signal: new AbortController().signal, callerAuthority: 'present_user' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { mode: 'preview',
            sourceConfig: { v: 1, subject: draft.subject, alerts: { channels: [], phases: ['open', 'recovered'] } } } });
    } finally { restoreRequest(); await runtime.dispose(); }
});

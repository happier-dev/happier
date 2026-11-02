import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import * as credentialPersistence from '@/persistence';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type PluginUiArtifactDigestV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

let managedServicesFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
    // Only credential persistence is substituted; the registry and managed owners stay real.
    const credentials = vi.spyOn(credentialPersistence, 'readStoredCredentials').mockResolvedValue(null);
    try {
        managedServicesFixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            contributes: createResolvedContributionRegistry({}), pluginIds: [],
        } });
    } finally { credentials.mockRestore(); }
});
afterAll(async () => { await managedServicesFixture?.dispose(); });

import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

function createRegistrar() {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    return {
        handlers,
        registrar,
    };
}

describe('portable plugin brand projection handler', () => {
    it('reads the immutable Resource-owner fact from the current runtime rather than reconstructing an icon', async () => {
        const pluginId = 'acme.brand';
        const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Acme Brand',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            brand: { iconResourceId: 'brand-icon' },
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: { required: [], optional: [] },
            contributes: {
                resources: [{
                    id: 'brand-icon',
                    kind: 'asset',
                    path: 'assets/brand.png',
                    contentType: 'image/png',
                }],
            },
        }));
        if (!manifest) throw new Error('Expected a canonical brand manifest');
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                manifestPath: '/plugins/acme.brand/.happier-plugin/plugin.json',
                daemonEntryPath: '/plugins/acme.brand/daemon.mjs',
                sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme.brand',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                },
                activationEvents: ['startup'],
                manifest,
            }],
        });
        let retired = false;
        const digest: PluginUiArtifactDigestV1 = `sha256:${'c'.repeat(64)}`;
        const getPluginBrandAsset = vi.fn((requestedPluginId: string) => {
            if (requestedPluginId !== pluginId) return undefined;
            return retired
                ? { state: 'retired' as const }
                : {
                    state: 'available' as const,
                    resource: { pluginId, localId: 'brand-icon' },
                    width: 64,
                    height: 64,
                    digest,
                };
        });
        const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
            claimReleaseLessDeclarations: async () => undefined,
            contributes: registry,
            declarationContributes: registry,
            projectManagedServices: managedServicesFixture.registry.projectManagedServices,
            targetActionInvocations: managedServicesFixture.registry.targetActionInvocations,
    readPluginOccurrenceId: managedServicesFixture.registry.readPluginOccurrenceId,
    isPluginOccurrenceCurrent: managedServicesFixture.registry.isPluginOccurrenceCurrent,
            generation: 7,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: new Map(),
            scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: {},
            activatedPluginIds: new Set(),
            activateContributionsOnDemand: async () => [],
            addRuntimeDisposable: (_pluginId, disposable) => disposable,
            createAgentInvocationServices: async () => createUnavailablePluginServices(),
            resolvePromptAssetBlocks: async () => [],
            resolveCaptureSource: async () => null,
            resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
            resolveStructuredMessage: async () => {
                throw new Error('Structured-message resolution is unavailable in this fixture');
            },
            getPluginBrandAsset,
            dispose: async () => {},
            retireConsumers: () => {},
        };

        invalidateDaemonContributionRegistryProjectionCache();
        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        await expect(handler?.({ machineId: 'machine-1' })).resolves.toMatchObject({
            protocolVersion: 1,
            projection: {
                v: 2,
                installedPackagesById: {
                    [pluginId]: {
                        brand: {
                            state: 'available',
                            resource: { pluginId, localId: 'brand-icon' },
                            width: 64,
                            height: 64,
                            digest,
                        },
                    },
                },
            },
        });
        expect(getPluginBrandAsset).toHaveBeenCalledWith(pluginId);

        // Retiring the runtime fact without changing the registry generation
        // must invalidate the short projection cache; otherwise a stale icon
        // could survive after its immutable Resource generation is fenced.
        retired = true;
        await expect(handler?.({ machineId: 'machine-1' })).resolves.toMatchObject({
            projection: {
                installedPackagesById: {
                    [pluginId]: { brand: { state: 'retired' } },
                },
            },
        });
        expect(getPluginBrandAsset).toHaveBeenCalledTimes(2);
    });
});

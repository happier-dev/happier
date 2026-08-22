import { describe, expect, it } from 'vitest';

import {
    createFeatureDecision,
    type DaemonReactNativeHostRuntimeIdentityV1,
    DaemonPluginInvocationLogReadRequestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar() {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    return { handlers, registrar };
}

function createEnabledReactNativeBundlesFeatureDecision() {
    return createFeatureDecision({
        featureId: 'plugins.ui.reactNativeBundles',
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    });
}

function createRuntimeRegistry(
    contributes: ResolvedExecutablePluginRuntimeRegistry['contributes'],
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes,
        resolvePromptAssetBlocks: async () => [],
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: async () => createUnavailablePluginServices(),
        retireConsumers: () => {},
        dispose: async () => {},
    };
}

function createRegistry(artifactDigest: PluginUiArtifactDigestV1) {
    return createResolvedContributionRegistry({
        agents: [],
        uiRenderersV2: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'runtime.plugin',
            identity: { pluginId: 'runtime.plugin', localId: 'native-panel' },
            manifestPath: '/plugins/runtime/plugin.json',
            pluginRootPath: '/plugins/runtime',
            generatedUiArtifactsManifest: {
                version: 1,
                entries: [{
                    contributionId: 'native-panel',
                    tier: 'reactNative',
                    platform: 'ios',
                    entry: 'react-native/native-panel/ios.bundle',
                    files: [{
                        relativePath: 'react-native/native-panel/ios.bundle',
                        digest: artifactDigest,
                        byteSize: 1024,
                    }],
                    digest: artifactDigest,
                    builtWith: { bundler: 'repack', version: '5.2.5' },
                    repack: {
                        containerName: 'runtime_plugin_native',
                        modulePath: './renderSurface',
                        exportName: 'renderSurface',
                    },
                    hostUiApiVersion: '1.0.0',
                    compat: { react: '19.2.0', reactNative: '0.83.4' },
                }],
            },
            definition: {
                id: 'native-panel',
                kind: 'reactNative',
                artifact: 'native-panel',
            },
        }],
    });
}

async function projectReactNativeRuntime(params?: Readonly<{
    installedReactNativeArtifactLoaderAvailable?: boolean;
    reactNativeScriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: DaemonReactNativeHostRuntimeIdentityV1;
}>) {
    const artifactDigest = computePluginUiArtifactSha256DigestV1(
        new TextEncoder().encode('// native panel'),
    );
    const registry = createRegistry(artifactDigest);
    const { handlers, registrar } = createRegistrar();
    registerSessionHandlers(registrar, process.cwd(), {
        daemonContributionRegistryProjection: {
            resolveGeneration: async () => 100,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            installedReactNativeArtifactLoaderAvailable:
                params?.installedReactNativeArtifactLoaderAvailable ?? true,
            reactNativeScriptManagerRuntimeIntegrated:
                params?.reactNativeScriptManagerRuntimeIntegrated ?? true,
            reactNativeHostRuntime:
                params && Object.hasOwn(params, 'reactNativeHostRuntime')
                    ? params.reactNativeHostRuntime
                    : {
                        platform: 'ios',
                        channel: 'internal',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: [],
                    },
        },
    });

    const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    expect(handler).toBeDefined();
    const raw = await handler!({ machineId: 'm1' });
    type PluginUiProjectionFamily = Readonly<{
        entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
    }>;
    return (raw as {
        projection: {
            familiesById?: Record<string, PluginUiProjectionFamily>;
        };
    }).projection.familiesById?.pluginUi
        ?.entriesById?.['reactNativeBundle:runtime.plugin:native-panel']?.runtime;
}

describe('registerSessionHandlers daemon contribution registry projection wiring', () => {
    it('projects installed React Native artifacts as loadable only from explicit readiness facts', async () => {
        await expect(projectReactNativeRuntime()).resolves.toMatchObject({
            state: 'loadable',
            diagnostics: [],
            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: expect.objectContaining({
                pluginId: 'runtime.plugin',
                contributionId: 'native-panel',
                platform: 'ios',
                channel: 'internal',
                projectionGeneration: 100,
            }),
        });
    });

    it('keeps React Native artifacts fallback when ScriptManager integration is not explicitly proven', async () => {
        await expect(projectReactNativeRuntime({
            reactNativeScriptManagerRuntimeIntegrated: false,
        })).resolves.toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
            decision: { state: 'fallback' },
        });
    });

    it('keeps React Native artifacts fallback when the installed-artifact loader is not explicitly proven', async () => {
        await expect(projectReactNativeRuntime({
            installedReactNativeArtifactLoaderAvailable: false,
        })).resolves.toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_installed_artifact_loader_unavailable',
            ],
            decision: { state: 'fallback' },
        });
    });

    it('blocks React Native artifacts when host runtime identity is missing', async () => {
        await expect(projectReactNativeRuntime({
            reactNativeHostRuntime: undefined,
        })).resolves.toMatchObject({
            state: 'blocked',
            diagnostics: ['generated_react_native_platform_unresolved'],
            decision: { state: 'blocked' },
        });
    });

});

describe('registerSessionHandlers plugin invocation log wiring', () => {
    it('registers a fail-closed exact-machine log handler when no live target identity is available', async () => {
        const { handlers, registrar } = createRegistrar();
        registerSessionHandlers(registrar, process.cwd());

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ);
        expect(handler).toBeDefined();
        await expect(handler!(DaemonPluginInvocationLogReadRequestV1Schema.parse({
            version: 1,
            target: {
                serverIdentityId: 'srv_plugin_logs',
                machineId: 'machine-logs',
            },
            query: { pluginId: 'acme.example' },
        }))).resolves.toEqual({
            version: 1,
            kind: 'unavailable',
            code: 'plugin_log_target_unavailable',
        });
    });
});

import { describe, expect, it } from 'vitest';

import { createFeatureDecision } from '@happier-dev/protocol';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

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
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: {},
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: () => createUnavailablePluginServices(),
        readHookEventEnvelopeV1,
        retireConsumers: () => {},
        dispose: async () => {},
    };
}

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
} as const;

function createRegistry(params: Readonly<{
    contributionDigest: string;
    artifactDigest?: string;
}>) {
    const hostAppVersion = configuration.currentCliVersion;
    const artifactDigest = params.artifactDigest ?? params.contributionDigest;
    return createResolvedContributionRegistry({
        agents: [],
        reactNativeBundles: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'runtime.plugin',
            manifestPath: '/plugins/runtime/plugin.json',
            manifestDigest: 'sha256:runtime',
            daemonEntryPath: '/plugins/runtime/daemon.mjs',
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/runtime',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'native-panel',
                bundle: {
                    platform: 'ios',
                    channel: 'internal',
                    integrity: { digest: params.contributionDigest },
                },
                entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
                compatibility: {
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    supportedPlatforms: ['ios'],
                    supportedChannels: ['internal'],
                    requiredNativeCapabilities: [],
                },
                hostApi: { minVersion: '1.0.0', methods: [] },
                nativeCapabilities: [],
                fallback: { kind: 'hostedWeb', contributionId: 'native-panel-web' },
                display,
            },
        }],
        uiArtifacts: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'runtime.plugin',
            manifestPath: '/plugins/runtime/plugin.json',
            manifestDigest: 'sha256:runtime',
            daemonEntryPath: '/plugins/runtime/daemon.mjs',
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/runtime',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                id: 'native-panel-ios',
                contributionId: 'native-panel',
                contributionFamily: 'reactNativeBundles',
                artifactKind: 'reactNativeBundle',
                platform: 'ios',
                channel: 'internal',
                integrity: { digest: artifactDigest },
                compatibility: {
                    hostAppVersion,
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    supportedChannels: ['internal'],
                    nativeCapabilities: [],
                },
                byteSize: 1024,
                contentType: 'application/javascript',
                assetPath: 'react-native/native-panel/ios.bundle.js',
            },
        }],
    });
}

async function projectReactNativeRuntime(params?: Readonly<{
    installedReactNativeArtifactLoaderAvailable?: boolean;
    reactNativeScriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: Readonly<{ platform?: string; channel?: string }>;
    contributionDigest?: string;
    artifactDigest?: string;
}>) {
    const digest = params?.contributionDigest ?? computePluginUiArtifactSha256DigestV1(
        new TextEncoder().encode('// native panel'),
    );
    const registry = createRegistry({
        contributionDigest: digest,
        ...(params?.artifactDigest ? { artifactDigest: params.artifactDigest } : {}),
    });
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
                params?.reactNativeHostRuntime ?? { platform: 'ios', channel: 'internal' },
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

    it('keeps React Native artifacts fallback when host runtime identity is missing', async () => {
        await expect(projectReactNativeRuntime({
            reactNativeHostRuntime: {},
        })).resolves.toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'react_native_host_runtime_identity_unavailable',
            ],
            decision: { state: 'fallback' },
        });
    });

    it('keeps digest-mismatched React Native artifacts unloadable even when readiness facts exist', async () => {
        const digest = computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('// native panel'));
        await expect(projectReactNativeRuntime({
            contributionDigest: digest,
            artifactDigest: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('// stale panel')),
        })).resolves.toMatchObject({
            state: 'fallback',
            decision: { state: 'fallback' },
        });
    });
});

import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { describe, expect, it } from 'vitest';

import {
    createFeatureDecision,
    DaemonPluginInvocationLogReadRequestV1Schema,
} from '@happier-dev/protocol';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
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
        resolveCaptureSource: unexpectedCaptureSourceResolution,
        resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
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

function createRegistry() {
    const entryBytes = new TextEncoder().encode('// native panel');
    const entry = 'react-native/native-panel/entry.cjs.bundle';
    const fileDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{
        relativePath: entry,
        bytes: entryBytes,
    }]);
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
                version: 2,
                entries: [{
                    artifactId: 'native-panel',
                    tier: 'reactNative',
                    entry,
                    files: [{
                        relativePath: entry,
                        digest: fileDigest,
                        byteSize: entryBytes.byteLength,
                    }],
                    digest: artifactDigest,
                    builtWith: { bundler: 'esbuild', version: '0.27.2' },
                    executable: { exports: ['renderSurface'] },
                    hostUiApiRange: '^1.0.0',
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

async function projectReactNativeRuntime() {
    const registry = createRegistry();
    const { handlers, registrar } = createRegistrar();
    registerSessionHandlers(registrar, process.cwd(), {
        daemonContributionRegistryProjection: {
            resolveGeneration: async () => 100,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            reactNativeHostRuntime: {
                platform: 'ios',
                channel: 'internal',
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
            cacheIdentity: {
                artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            },
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

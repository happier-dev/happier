import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createFeatureDecision,
    FeaturesResponseSchema,
    normalizePluginBackendCapabilitiesV1,
    type PluginAgentContributionV2,
} from '@happier-dev/protocol';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginSettingsService } from '@happier-dev/plugin-sdk/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { configuration, reloadConfiguration } from '@/configuration';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type {
    ResolvedContributionInputs,
    ResolvedReactNativeBundleContribution,
    ResolvedUiArtifactContribution,
} from '@/plugins/projection/registry/types';
import { deriveReactNativeNativeCapabilitiesDigest } from '@/plugins/install/ui/reactNativeBundles';
import { createPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import {
    createPluginStorageBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    createStablePluginSettingsOwner,
} from '@/plugins/runtime/invocation/services/settings';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createReactNativeCrashDisableStateStore } from '@/plugins/runtime/ui/reactNativeCrashDisableState';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const executePluginActionIfAvailableMock = vi.hoisted(() => vi.fn());

vi.mock('@/plugins/projection/actions/execute', () => ({
    executePluginActionIfAvailable: executePluginActionIfAvailableMock,
}));

function createRegistrar() {
    const handlers = new Map<string, (
        payload: unknown,
        context?: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(
                method: string,
                handler: (
                    payload: unknown,
                    context?: Readonly<{ signal: AbortSignal }>,
                ) => Promise<unknown>,
            ) {
                handlers.set(method, handler);
            },
        },
    };
}

function createRuntimeRegistry(
    contributes: ResolvedExecutablePluginRuntimeRegistry['contributes'],
    overrides: Partial<ResolvedExecutablePluginRuntimeRegistry> = {},
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes,
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
        resolvePromptAssetBlocks: async () => [],
        resolveStructuredMessage: async () => {
            throw new Error('Structured-message resolution is unavailable in this fixture');
        },
        dispose: async () => {},
        ...overrides,
        retireConsumers: overrides.retireConsumers ?? (() => {}),
    };
}

function createExternalAgentDefinition(params: Readonly<{
    id: string;
    title: string;
    description?: string;
}>): PluginAgentContributionV2 {
    return {
        id: params.id,
        title: params.title,
        ...(params.description ? { description: params.description } : {}),
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
            sessions: {
                open: ['create'],
                delivery: ['newTurn'],
                cancel: true,
            },
        },
    };
}

const rnDisplay = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
} as const;

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

function createDisabledReactNativeBundlesFeatureDecision() {
    return createFeatureDecision({
        featureId: 'plugins.ui.reactNativeBundles',
        state: 'disabled',
        blockedBy: 'local_policy',
        blockerCode: 'feature_disabled',
        diagnostics: ['feature_disabled'],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    });
}

const readyReactNativeBackendOpts = {
    installedReactNativeArtifactLoaderAvailable: true,
    reactNativeScriptManagerRuntimeIntegrated: true,
    reactNativeHostRuntime: {
        platform: 'ios',
        channel: 'internal',
    },
} as const;

function createReactNativeContribution(
    contributionId: string,
    digest: string,
): ResolvedReactNativeBundleContribution {
    return {
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
            id: contributionId,
            bundle: {
                platform: 'ios',
                channel: 'internal',
                integrity: { digest },
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
            fallback: { kind: 'hostedWeb', contributionId: `${contributionId}-web` },
            display: rnDisplay,
        },
    };
}

function createReactNativeArtifact(params: Readonly<{
    contributionId: string;
    artifactId: string;
    digest: string;
    hostAppVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    nativeCapabilities?: readonly string[];
    files?: readonly Readonly<{
        relativePath: string;
        digest: string;
        byteSize: number;
    }>[];
}>): ResolvedUiArtifactContribution {
    return {
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
            id: params.artifactId,
            contributionId: params.contributionId,
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: params.digest },
            compatibility: {
                hostAppVersion: params.hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: params.reactVersion,
                reactNativeVersion: params.reactNativeVersion,
                supportedChannels: ['internal'],
                nativeCapabilities: [...(params.nativeCapabilities ?? [])],
            },
            byteSize: 1024,
            contentType: 'application/javascript',
            assetPath: `react-native/${params.contributionId}/ios.bundle.js`,
            ...(params.files ? { files: [...params.files] } : {}),
        },
    };
}

describe('daemon contribution registry projection rpc handler', () => {
    it('projects current plugin SCM registrations and their canonical connected-service auth through describe', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();

        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
                        connectedAccountDescriptors: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm',
                definition: {
                    id: 'forge-account',
                    title: 'Acme Forge account',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{
                            id: 'manual',
                            kind: 'manual',
                            outcomeReconciliation: 'none',
                            fields: [{
                                id: 'token',
                                title: 'Token',
                                schema: { type: 'string' },
                                secret: true,
                            }],
                        }],
                    },
                },
            }],
            scmBackends: [{
                id: 'stacked',
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scm',
                definition: {
                    id: 'stacked',
                    title: 'Acme Stacked',
                    kind: 'stacked',
                    capabilities: ['detect', 'status'],
                },
            }],
            scmHostingProviders: [
                {
                    id: 'forge-cloud',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm',
                    definition: {
                        id: 'forge-cloud',
                        title: 'Acme Forge Cloud',
                        kind: 'acme',
                        capabilities: ['detect', 'clone'],
                        authService: 'forge-account',
                    },
                },
                {
                    id: 'forge-enterprise',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.scm',
                    definition: {
                        id: 'forge-enterprise',
                        title: 'Acme Forge Enterprise',
                        kind: 'acme',
                        capabilities: ['detect', 'clone'],
                        authService: 'forge-account',
                    },
                },
            ],
        });
        const activateContributionsOnDemand = vi.fn(async () => []);
        const runtimeRegistry = createRuntimeRegistry(registry, {
            generation: 41,
            scmBackendsById: new Map([
                ['acme.scm/stacked', {} as never],
            ]),
            scmHostingProvidersById: new Map([
                ['acme.scm/forge-cloud', {} as never],
                ['acme.scm/forge-enterprise', {} as never],
            ]),
            activateContributionsOnDemand,
        });
        const { handlers, registrar } = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 41,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toEqual(expect.any(Function));
        const raw = await handler!({ machineId: 'machine-1' });

        expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(1, [
            { pluginId: 'acme.scm', family: 'scmHostingProviders', localId: 'forge-cloud' },
            { pluginId: 'acme.scm', family: 'scmHostingProviders', localId: 'forge-enterprise' },
        ]);
        expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(2, [
            { pluginId: 'acme.scm', family: 'scmBackends', localId: 'stacked' },
        ]);
        expect(raw).toMatchObject({
            protocolVersion: 1,
            projection: {
                v: 2,
                generation: 41,
                familiesById: {
                    connectedAccounts: {
                        entriesById: {
                            'acme.scm/forge-account': {
                                id: 'forge-account',
                                serviceId: 'forge-cloud',
                                pluginId: 'acme.scm',
                                authentication: {
                                    defaultModeId: 'manual',
                                    modes: [{
                                        id: 'manual',
                                        kind: 'manual',
                                        outcomeReconciliation: 'none',
                                        fields: [{ id: 'token', title: 'Token', secret: true }],
                                    }],
                                },
                            },
                        },
                    },
                    scmBackends: {
                        entriesById: {
                            'acme.scm/stacked': {
                                id: 'acme.scm/stacked',
                                localId: 'stacked',
                                pluginId: 'acme.scm',
                                displayName: 'Acme Stacked',
                            },
                        },
                    },
                    scmHostingProviders: {
                        entriesById: {
                            'acme.scm/forge-cloud': {
                                id: 'acme.scm/forge-cloud',
                                localId: 'forge-cloud',
                                pluginId: 'acme.scm',
                                authService: { pluginId: 'acme.scm', localId: 'forge-account' },
                            },
                            'acme.scm/forge-enterprise': {
                                id: 'acme.scm/forge-enterprise',
                                localId: 'forge-enterprise',
                                pluginId: 'acme.scm',
                                authService: { pluginId: 'acme.scm', localId: 'forge-account' },
                            },
                        },
                    },
                },
            },
        });
    });

    it('delegates structured-message validation and resource reads to the leased runtime owner', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
                    });
        const resolveStructuredMessage = vi.fn(async () => ({
            model: {
                identity: {
                    pluginId: 'acme.preview',
                    localId: 'preview-card',
                    qualifiedId: 'acme.preview/preview-card',
                    generation: '7',
                },
                kind: 'acme.preview/preview-card.v1',
                title: 'Preview',
                payload: { previewId: 'preview-1' },
                renderer: {
                    identity: { pluginId: 'acme.preview', localId: 'summary-card' },
                    qualifiedId: 'acme.preview/summary-card',
                    generation: '7',
                },
                actions: [],
                resources: [{
                    identity: { pluginId: 'acme.preview', localId: 'preview-icon' },
                    qualifiedId: 'acme.preview/preview-icon',
                    generation: '7',
                }],
                fallback: { kind: 'summary' as const, template: 'Preview unavailable' },
                visible: true,
            },
            renderer: {
                identity: {
                    pluginId: 'acme.preview',
                    localId: 'summary-card',
                    qualifiedId: 'acme.preview/summary-card',
                    generation: '7',
                },
                visible: true,
                requiredHostMethods: [],
                root: { kind: 'status' as const, path: 'root', order: 0, label: 'Preview', value: 'Ready' },
                nodes: [{ kind: 'status' as const, path: 'root', order: 0, label: 'Preview', value: 'Ready' }],
            },
            resources: [{
                reference: {
                    identity: { pluginId: 'acme.preview', localId: 'preview-icon' },
                    qualifiedId: 'acme.preview/preview-icon',
                    generation: '7',
                },
                kind: 'asset' as const,
                contentType: 'image/png',
                digest: `sha256:${'a'.repeat(64)}`,
                bytes: new Uint8Array([1, 2, 3]),
            }],
        }));
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
            resolveStructuredMessage,
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE);
        expect(handler).toEqual(expect.any(Function));
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            resourceRefs: ['preview-icon'],
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).resolves.toMatchObject({
            ok: true,
            model: { renderer: { qualifiedId: 'acme.preview/summary-card' } },
            resources: [{ bytesBase64: 'AQID' }],
        });
        expect(resolveStructuredMessage).toHaveBeenCalledWith(expect.objectContaining({
            expectedGeneration: '7',
            resourceRefs: ['preview-icon'],
        }));
    });

    it('keeps the public projection revision current while retained activation leases preserve their internal generation', async () => {
        const pluginId = 'acme.retained';
        const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Retained plugin',
            description: 'Retained activation generation fixture',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'roundtrip',
                    title: 'Roundtrip',
                    scopes: ['global'],
                    surfaces: ['ui'],
                    placement: 'commandPalette',
                    dangerLevel: 'safe',
                }],
            },
        }));
        if (!manifest) throw new Error('Expected retained activation manifest fixture to normalize');
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
                        activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                manifestPath: '/plugins/acme.retained/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:retained',
                daemonEntryPath: '/plugins/acme.retained/daemon.mjs',
                sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/acme.retained',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                },
                activationEvents: ['startup'],
                manifest,
            }],
            introspectionContributions: [{
                pluginId,
                pluginVersion: '1.0.0',
                source: 'localPath',
                family: 'actions',
                identity: { kind: 'localId', localId: 'roundtrip' },
                stability: 'stable',
                registration: 'required',
                consumer: 'action-dispatch',
                platforms: ['cli'],
            }],
        });
        const resolveStructuredMessage = vi.fn(async () => ({
            model: {
                identity: {
                    pluginId,
                    localId: 'roundtrip-result',
                    qualifiedId: `${pluginId}/roundtrip-result`,
                    generation: '1',
                },
                kind: `${pluginId}/roundtrip-result.v1`,
                title: 'Roundtrip',
                payload: { message: 'retained' },
                renderer: {
                    identity: { pluginId, localId: 'roundtrip-card' },
                    qualifiedId: `${pluginId}/roundtrip-card`,
                    generation: '1',
                },
                actions: [{
                    identity: { pluginId, localId: 'roundtrip' },
                    qualifiedId: `${pluginId}/roundtrip`,
                    generation: '1',
                    enabled: true,
                }],
                resources: [{
                    identity: { pluginId, localId: 'roundtrip-icon' },
                    qualifiedId: `${pluginId}/roundtrip-icon`,
                    generation: '1',
                }],
                fallback: { kind: 'summary' as const, template: 'Retained' },
                visible: true,
            },
            renderer: {
                identity: {
                    pluginId,
                    localId: 'roundtrip-card',
                    qualifiedId: `${pluginId}/roundtrip-card`,
                    generation: '1',
                },
                visible: true,
                requiredHostMethods: [],
                root: {
                    kind: 'action' as const,
                    path: 'root',
                    order: 0,
                    action: {
                        identity: { pluginId, localId: 'roundtrip' },
                        qualifiedId: `${pluginId}/roundtrip`,
                        generation: '1',
                    },
                    label: 'Roundtrip',
                    enabled: true,
                },
                nodes: [{
                    kind: 'action' as const,
                    path: 'root',
                    order: 0,
                    action: {
                        identity: { pluginId, localId: 'roundtrip' },
                        qualifiedId: `${pluginId}/roundtrip`,
                        generation: '1',
                    },
                    label: 'Roundtrip',
                    enabled: true,
                }],
            },
            resources: [{
                reference: {
                    identity: { pluginId, localId: 'roundtrip-icon' },
                    qualifiedId: `${pluginId}/roundtrip-icon`,
                    generation: '1',
                },
                kind: 'asset' as const,
                contentType: 'image/png',
                digest: `sha256:${'a'.repeat(64)}`,
                bytes: new Uint8Array([1, 2, 3]),
            }],
        }));
        const runtimeRegistry = createRuntimeRegistry(registry, {
            generation: 1,
            targetActivationFacts: [{
                pluginId,
                pluginVersion: '1.0.0',
                source: 'localPath',
                generation: '1',
                host: 'daemon',
                platform: 'darwin',
                occurredAtMs: 10,
                status: 'active',
                required: [{ family: 'actions', localId: 'roundtrip' }],
                bound: [{ family: 'actions', localId: 'roundtrip' }],
                diagnostics: [],
            }],
            resolveStructuredMessage,
        });
        executePluginActionIfAvailableMock.mockResolvedValueOnce({
            matched: true,
            result: { ok: true, result: { retained: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 5,
            resolveInstalledPackages: async () => [],
        });

        const describe = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        await expect(describe?.({ machineId: 'machine-1' })).resolves.toMatchObject({
            projection: {
                generation: 5,
                contributionIntrospection: {
                    contributions: [{
                        contribution: { qualifiedId: `${pluginId}/actions/roundtrip` },
                        registration: { requirement: 'required', state: 'bound', generation: '1' },
                        activation: { state: 'active', generation: '1' },
                    }],
                    diagnostics: [],
                },
            },
        });

        const resolveStructured = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE);
        await expect(resolveStructured?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            kind: `${pluginId}/roundtrip-result.v1`,
            payload: { message: 'retained' },
            facts: {},
        })).resolves.toMatchObject({
            ok: true,
            model: {
                identity: { generation: '5' },
                renderer: { generation: '5' },
                actions: [{ generation: '5' }],
                resources: [{ generation: '5' }],
            },
            renderer: {
                identity: { generation: '5' },
                root: { action: { generation: '5' } },
                nodes: [{ action: { generation: '5' } }],
            },
            resources: [{ reference: { generation: '5' } }],
        });
        expect(resolveStructuredMessage).toHaveBeenCalledWith(expect.objectContaining({
            expectedGeneration: '1',
        }));

        const executeAction = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(executeAction?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            qualifiedActionId: `${pluginId}/roundtrip`,
            input: { operation: 'retained' },
            executionSurface: 'ui',
        })).resolves.toEqual({
            ok: true,
            result: { retained: true },
        });
    });

    it('fails closed before structured-message action execution when the leased generation is stale', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
                    });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '6',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            sessionId: 'session-1',
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_generation_stale',
        });
    });

    it.each(['cli', 'ui'] as const)(
        'routes browser action execution through the canonical action executor with the %s policy surface',
        async (executionSurface) => {
            const registry = createResolvedContributionRegistry({
                agents: Object.freeze([]),
                            });
            const runtimeRegistry = {
                ...createRuntimeRegistry(registry),
                generation: 7,
            };
            executePluginActionIfAvailableMock.mockResolvedValueOnce({
                matched: true,
                result: { ok: true, result: { opened: true } },
            });
            const { handlers, registrar } = createRegistrar();
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveRuntimeRegistry: async () => runtimeRegistry,
                resolveGeneration: async () => 7,
                resolveInstalledPackages: async () => [],
            });

            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            const operation = new AbortController();
            await expect(handler?.({
                machineId: 'machine-1',
                expectedGeneration: '7',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { previewId: 'preview-1' },
                sessionId: 'session-1',
                executionSurface,
            }, { signal: operation.signal })).resolves.toEqual({
                ok: true,
                result: { opened: true },
            });
            expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith({
                runtimeRegistry,
                actionId: 'acme.preview/open-preview',
                input: { previewId: 'preview-1' },
                context: {
                    surface: executionSurface,
                    defaultSessionId: 'session-1',
                    signal: operation.signal,
                },
            });
        },
    );

    it('persists generic plugin-local settings and redacts secret values from UI snapshots', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-settings-rpc-'));
        const previousHomeDir = process.env.HAPPIER_HOME_DIR;
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();

        try {
            const registry = createResolvedContributionRegistry({
                agents: Object.freeze([]),
                                settings: Object.freeze([
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.hooks',
                        manifestPath: '/plugins/acme.hooks/plugin.json',
                        manifestDigest: 'sha256:acme',
                        daemonEntryPath: '/plugins/acme.hooks/daemon.mjs',
                        definition: {
                            id: 'settings',
                            version: 1,
                            title: 'Acme settings',
                            target: { kind: 'plugin' },
                            scope: 'local',
                            fields: [
                                {
                                    id: 'endpoint',
                                    title: 'Endpoint',
                                    schema: { type: 'string', minLength: 1 },
                                },
                                {
                                    id: 'api-token',
                                    title: 'API token',
                                    schema: { type: 'string', minLength: 8, pattern: '^token-' },
                                    secret: true,
                                },
                                {
                                    id: 'enabled',
                                    title: 'Enabled',
                                    schema: { type: 'boolean' },
                                    default: true,
                                },
                            ],
                            presentation: { sections: [], subagentSections: [] },
                        },
                    },
                ]),
            });
            const [settingsDeclaration] = registry.settings ?? [];
            if (!settingsDeclaration) throw new Error('Expected settings declaration');
            const settingsPaths = resolvePluginStorePaths({ happyHomeDir });
            const stableSettingsService = createStablePluginSettingsOwner({
                recordStore: createPluginStorageBackedSettingsRecordStore({
                    storageForPlugin: (pluginId) => createPluginStorageOwner({
                        pluginId,
                        paths: settingsPaths,
                    }).local,
                }),
                broker: createStablePluginEventsBroker(),
            }).bind({
                model: createStablePluginSettingsModel({
                    pluginId: 'acme.hooks',
                    contribution: settingsDeclaration.definition,
                }),
                seed: Object.freeze({
                    plugin: Object.freeze({ id: 'acme.hooks', version: '1.0.0' }),
                    contribution: Object.freeze({
                        id: settingsDeclaration.definition.id,
                        qualifiedId: 'acme.hooks/settings/settings',
                    }),
                    generation: 'generation-1',
                    correlationId: 'settings-rpc',
                    surface: 'ui',
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                }),
            });
            const { handlers, registrar } = createRegistrar();
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                    createPluginSettingsService: () => stableSettingsService,
                }),
                resolveGeneration: async () => 1,
                resolveInstalledPackages: async () => [],
            });

            const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET);
            const getHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET);
            expect(setHandler).toEqual(expect.any(Function));
            expect(getHandler).toEqual(expect.any(Function));

            await setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'endpoint',
                value: 'https://api.example.test',
            });
            await expect(setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'api-token',
                value: 'invalid',
            })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_VALIDATION_FAILED' });
            await setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'api-token',
                value: 'token-raw-secret',
            });
            await setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'enabled',
                value: false,
            });
            await expect(setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'not-declared',
                value: 'not visible',
            })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_UNKNOWN_KEY' });

            const firstSnapshot = await getHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
            });
            expect(firstSnapshot).toMatchObject({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                storageScope: 'local',
                revision: '2',
                values: {
                    endpoint: 'https://api.example.test',
                    enabled: false,
                },
                redactedKeys: ['api-token'],
            });
            expect(JSON.stringify(firstSnapshot)).not.toContain('token-raw-secret');

            const secondSnapshot = await getHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
            });
            expect(secondSnapshot).toMatchObject({
                values: {
                    endpoint: 'https://api.example.test',
                    enabled: false,
                },
                redactedKeys: ['api-token'],
            });
            await setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'api-token',
                value: '',
            });
            const clearedSnapshot = await getHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
            });
            expect(clearedSnapshot).toMatchObject({ redactedKeys: [] });
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const localSettings = await createPluginStorageOwner({
                pluginId: 'acme.hooks',
                paths,
            }).local.get<Record<string, unknown>>('settings');
            expect(JSON.stringify(localSettings)).not.toContain('token-raw-secret');
            expect(await createPluginSecretStore({
                pluginId: 'acme.hooks',
                paths,
            }).get('api-token')).toBeNull();
        } finally {
            if (previousHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHomeDir;
            }
            reloadConfiguration();
        }
    });

    it('edits synthesized notification channel settings through the canonical settings and secrets owners', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-notification-settings-rpc-'));
        const previousHomeDir = process.env.HAPPIER_HOME_DIR;
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();

        try {
            const registry = createResolvedContributionRegistry({
                notificationChannels: Object.freeze([{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.notifications',
                    definition: {
                        id: 'webhook',
                        kind: 'webhook',
                        title: 'Webhook',
                        configurable: true,
                        settings: [{
                            id: 'endpoint',
                            title: 'Endpoint',
                            schema: { type: 'string', minLength: 1 },
                        }, {
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 8 },
                            secret: true,
                        }],
                    },
                }]),
            });
            const [channelSettings] = resolveNotificationChannelSettingsContributions(
                registry.notificationChannels ?? [],
            );
            if (!channelSettings) throw new Error('Expected synthesized notification settings');
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const settingsStorage = createPluginStorageOwner({
                pluginId: 'acme.notifications',
                paths,
            });
            const stableService = createStablePluginSettingsOwner({
                recordStore: createPluginStorageBackedSettingsRecordStore({
                    scope: 'synced',
                    storageForPlugin: () => settingsStorage.local,
                }),
                broker: createStablePluginEventsBroker(),
            }).bind({
                model: createStablePluginSettingsModel({
                    pluginId: 'acme.notifications',
                    contribution: channelSettings.definition,
                }),
                seed: Object.freeze({
                    plugin: Object.freeze({ id: 'acme.notifications', version: '1.0.0' }),
                    contribution: Object.freeze({
                        id: 'notification-channel/webhook',
                        qualifiedId: 'acme.notifications/notification-channel/webhook',
                    }),
                    generation: 'generation-1',
                    correlationId: 'settings-rpc',
                    surface: 'ui',
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                }),
            });
            await stableService.set('webhook.endpoint', 'https://initial.example.test/hook');
            const { handlers, registrar } = createRegistrar();
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                    createPluginSettingsService: () => stableService,
                }),
            });
            const getHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET);
            const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET);

            await expect(getHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.notifications',
            })).resolves.toMatchObject({
                storageScope: 'synced',
                values: {
                    'webhook.endpoint': 'https://initial.example.test/hook',
                },
                redactedKeys: [],
            });
            await expect(setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.notifications',
                fieldId: 'webhook.endpoint',
                value: 'https://updated.example.test/hook',
            })).resolves.toMatchObject({
                values: {
                    'webhook.endpoint': 'https://updated.example.test/hook',
                },
                redactedKeys: [],
            });
            await expect(setHandler?.({
                machineId: 'machine-1',
                pluginId: 'acme.notifications',
                fieldId: 'webhook.token',
                value: 'configured-token',
            })).resolves.toMatchObject({
                values: {
                    'webhook.endpoint': 'https://updated.example.test/hook',
                },
                redactedKeys: ['webhook.token'],
            });
            await expect(createPluginSecretStore({
                pluginId: 'acme.notifications',
                paths,
            }).get('webhook.token')).resolves.toBe('configured-token');
        } finally {
            if (previousHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHomeDir;
            }
            reloadConfiguration();
        }
    });

    it('forwards optional settings compare-and-set revisions to the canonical runtime owner', async () => {
        const registry = createResolvedContributionRegistry({
            settings: Object.freeze([{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.cas',
                definition: {
                    id: 'settings',
                    version: 1,
                    title: 'Settings',
                    target: { kind: 'plugin' },
                    scope: 'local',
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: true }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        let revision = 0;
        const values: Record<string, JsonValue> = {};
        const stableService: PluginSettingsService = {
            async snapshot() {
                return { revision: String(revision), values: { ...values } };
            },
            async get<T extends JsonValue = JsonValue>(id: string) {
                return Object.prototype.hasOwnProperty.call(values, id) ? values[id]! as T : null;
            },
            async set(id: string, value: JsonValue, options?: { expectedRevision?: string }) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== String(revision)) {
                    throw Object.assign(new Error('revision conflict'), {
                        code: 'plugin_settings_revision_conflict',
                    });
                }
                values[id] = value;
                revision += 1;
                return { revision: String(revision) };
            },
            async reset(id: string, options?: { expectedRevision?: string }) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== String(revision)) {
                    throw Object.assign(new Error('revision conflict'), {
                        code: 'plugin_settings_revision_conflict',
                    });
                }
                delete values[id];
                revision += 1;
                return { revision: String(revision) };
            },
            describe: () => [],
            watch: () => ({ dispose() {} }),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createPluginSettingsService: () => stableService,
            }),
        });
        const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET);

        await expect(setHandler?.({
            machineId: 'machine-1',
            pluginId: 'acme.cas',
            fieldId: 'enabled',
            value: false,
            expectedRevision: '0',
        })).resolves.toMatchObject({ revision: '1', values: { enabled: false } });
        await expect(setHandler?.({
            machineId: 'machine-1',
            pluginId: 'acme.cas',
            fieldId: 'enabled',
            value: true,
            expectedRevision: '0',
        })).rejects.toMatchObject({ code: 'plugin_settings_revision_conflict' });
    });

    it('fails closed when plugin-local settings contributions reuse a field id', async () => {
        const registry = {
            ...createResolvedContributionRegistry({}),
            settings: Object.freeze(['first', 'second'].map((id) => ({
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.collision',
                definition: {
                    id,
                    version: 1 as const,
                    title: id,
                    target: { kind: 'plugin' as const },
                    scope: 'local' as const,
                    fields: [{ id: 'shared', title: 'Shared', schema: { type: 'string' as const } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }))),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            machineId: 'machine-1',
            pluginId: 'acme.collision',
        })).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_FIELD_ID_CONFLICT',
            pluginId: 'acme.collision',
            contributionId: 'second',
            fieldId: 'shared',
        });
    });

    it('fails closed when generic settings declare an unsupported persistence scope', async () => {
        const registry = {
            ...createResolvedContributionRegistry({}),
            settings: Object.freeze([{
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.synced',
                definition: {
                    id: 'settings',
                    version: 1 as const,
                    title: 'Settings',
                    target: { kind: 'plugin' as const },
                    scope: 'project' as const,
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' as const } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            machineId: 'machine-1',
            pluginId: 'acme.synced',
        })).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
            pluginId: 'acme.synced',
            contributionId: 'settings',
        });
    });

    it('fails closed when RPC settings access encounters unevaluated availability conditions', async () => {
        const registry = {
            ...createResolvedContributionRegistry({}),
            settings: Object.freeze([{
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.conditional',
                definition: {
                    id: 'settings',
                    version: 1 as const,
                    title: 'Settings',
                    target: { kind: 'plugin' as const },
                    scope: 'local' as const,
                    fields: [{
                        id: 'enabled',
                        title: 'Enabled',
                        schema: { type: 'boolean' as const },
                        availability: {
                            when: { fact: 'session.state' as const, operator: 'equals' as const, value: 'active' },
                        },
                    }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            machineId: 'machine-1',
            pluginId: 'acme.conditional',
        })).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_AVAILABILITY_UNAVAILABLE',
            pluginId: 'acme.conditional',
            contributionId: 'settings',
            fieldId: 'enabled',
            policyCode: 'plugin_contribution_policy_fact_unavailable',
        });
    });

    it('projects metadata-only contributions without forcing executable plugin activation when no runtime registry is active', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-projection-metadata-only-'));
        const registry = createResolvedContributionRegistry({
            agents: [
                {
                    id: 'metadata.provider',
                    identity: { pluginId: 'metadata.plugin', localId: 'metadata-provider' },
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'metadata.plugin',
                    manifestPath: join(pluginRoot, 'plugin.json'),
                    manifestDigest: 'sha256:metadata',
                    daemonEntryPath: join(pluginRoot, 'missing-daemon.mjs'),
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'metadata.provider',
                        ownedBackendIds: [],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: createExternalAgentDefinition({
                            id: 'metadata.provider',
                            title: 'Metadata Provider',
                        }),
                    },
                },
            ],
                        activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'metadata.plugin',
                    manifestPath: join(pluginRoot, 'plugin.json'),
                    manifestDigest: 'sha256:metadata',
                    daemonEntryPath: join(pluginRoot, 'missing-daemon.mjs'),
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({
                        id: 'metadata.plugin',
                        displayName: 'Metadata Plugin',
                    }))!,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => registry,
            resolveGeneration: async () => 0,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        expect(raw).toEqual(expect.objectContaining({
            protocolVersion: 1,
            projection: expect.objectContaining({
                agentsById: expect.objectContaining({
                    'metadata.provider': expect.objectContaining({
                        id: 'metadata.provider',
                        title: 'Metadata Provider',
                    }),
                }),
                diagnostics: [],
            }),
        }));
    });

    it('projects the authoritative executable runtime snapshot instead of the manifest-only registry snapshot', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const manifestOnlyRegistry = createResolvedContributionRegistry({
            agents: [
                {
                    id: 'manifest-only',
                    identity: { pluginId: 'manifest.only', localId: 'manifest-only' },
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'manifest.only',
                    manifestPath: '/plugins/manifest.only/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/manifest.only/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/plugins/manifest.only',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'manifest-only',
                        ownedBackendIds: [],
                    },
                },
            ],
                    });
        const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
            ...createRuntimeRegistry(createResolvedContributionRegistry({
                agents: [
                    {
                        id: 'runtime-provider',
                        identity: { pluginId: 'runtime.plugin', localId: 'runtime-provider' },
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
                            kindVersion: 1,
                            id: 'runtime-provider',
                            ownedBackendIds: ['runtime-backend'],
                        },
                        richDefinition: {
                            provenance: 'external',
                            definition: createExternalAgentDefinition({
                                id: 'runtime-provider',
                                title: 'Runtime Provider',
                                description: 'Activated contribution',
                            }),
                        },
                    },
                ],
                resources: [
                    {
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
                            kindVersion: 1,
                            id: 'runtime-prompt',
                            type: 'prompt',
                            title: 'Runtime Prompt',
                            path: 'resources/runtime.md',
                            digest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
                            contentType: 'text/markdown',
                        },
                    },
                ],
                tools: [
                    {
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
                            kindVersion: 1,
                            id: 'runtime-tool-search',
                            name: 'runtime_search',
                            title: 'Runtime Search',
                            description: 'Search runtime resources',
                            safety: 'safe',
                            surfaces: ['mcp', 'agent'],
                            action: 'runtime-tool-search',
                            actionId: 'runtime-tool-search',
                        },
                    },
                ],
                commands: [
                    {
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
                            kindVersion: 1,
                            id: 'runtime-command-reload',
                            title: 'Reload Runtime Plugin',
                            description: 'Reload the runtime plugin',
                            path: ['runtime-reload'],
                            action: 'runtime-command-reload',
                            tmux: 'required',
                            actionId: 'runtime-command-reload',
                        },
                    },
                ],
            })),
            pluginDiagnosticsByPluginId: Object.freeze({
                'runtime.plugin': Object.freeze([
                    {
                        code: 'plugin_activation_failed' as const,
                        message: 'Activation failed once before recovering',
                    },
                ]),
            }),
        };

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => manifestOnlyRegistry,
            resolveRuntimeRegistry: async () => runtimeRegistry,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        expect(raw).toEqual(expect.objectContaining({
            projection: expect.objectContaining({
                v: 2,
                generation: expect.any(Number),
                installedPackagesById: expect.objectContaining({
                    'runtime.plugin': expect.objectContaining({
                        id: 'runtime.plugin',
                        displayName: 'Runtime Provider',
                        enabled: true,
                        source: expect.objectContaining({
                            kind: 'path',
                            locator: '/plugins/runtime',
                        }),
                        digest: 'sha256:runtime',
                    }),
                }),
                agentsById: expect.objectContaining({
                    'runtime-provider': expect.objectContaining({
                        title: 'Runtime Provider',
                    }),
                }),
                backendsById: {},
                resourcesById: expect.objectContaining({
                    'runtime.plugin/runtime-prompt': expect.objectContaining({
                        path: 'resources/runtime.md',
                    }),
                }),
                toolsById: expect.objectContaining({
                    'runtime.plugin/runtime-tool-search': expect.objectContaining({
                        title: 'Runtime Search',
                        exposesToAgent: true,
                    }),
                }),
                commandsById: expect.objectContaining({
                    'runtime.plugin/runtime-command-reload': expect.objectContaining({
                        title: 'Reload Runtime Plugin',
                        tokens: ['runtime-reload'],
                    }),
                }),
            }),
        }));
        expect((raw as { projection: { agentsById: Record<string, unknown> } }).projection.agentsById.manifest).toBeUndefined();
        expect((raw as { projection: { agentsById: Record<string, unknown> } }).projection.agentsById['manifest.only']).toBeUndefined();
    });

    it('passes provider-neutral React Native host runtime facts while keeping the loader backend fail-closed', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const compatibleContribution = createReactNativeContribution('native-compatible', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
        const staleContribution = createReactNativeContribution('native-stale', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                compatibleContribution,
                staleContribution,
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-compatible',
                    artifactId: 'native-compatible-ios',
                    digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
                createReactNativeArtifact({
                    contributionId: 'native-stale',
                    artifactId: 'native-stale-ios',
                    digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                    hostAppVersion,
                    reactVersion: '19.0.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const pluginUiFamily = (raw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi;
        const compatibleRuntime = pluginUiFamily?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;
        const staleRuntime = pluginUiFamily?.entriesById?.['reactNativeBundle:runtime.plugin:native-stale']?.runtime;

        expect(compatibleRuntime).toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_installed_artifact_loader_unavailable',
            ],
            decision: {
                state: 'fallback',
                diagnostics: [
                    'repack_script_manager_unavailable',
                    'repack_script_manager_installed_artifact_loader_unavailable',
                ],
            },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-compatible',
                artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                projectionGeneration: expect.any(Number),
            },
        });
        expect(staleRuntime).toMatchObject({
            state: 'fallback',
            diagnostics: ['runtime_mismatch'],
            decision: {
                state: 'fallback',
                reason: 'runtime_mismatch',
                diagnostics: ['runtime_mismatch'],
            },
        });
        expect(staleRuntime).not.toHaveProperty('loadPolicy');
        expect(staleRuntime).not.toHaveProperty('cacheIdentity');
    });

    it('uses request-scoped React Native host runtime identity while keeping loader readiness fail-closed without ScriptManager integration', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-request-identity', 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-request-identity',
                    artifactId: 'native-request-identity-ios',
                    digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });
        let observedHostRuntime: Record<string, unknown> | undefined;

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            installedReactNativeArtifactLoaderAvailable: true,
            resolveReactNativeCrashDisabledContributionIds: ({ pluginUiHostRuntime }) => {
                observedHostRuntime = pluginUiHostRuntime.reactNativeBundles?.hostRuntime as Record<string, unknown> | undefined;
                return [];
            },
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();
        const raw = await handler!({
            machineId: 'm1',
            reactNativeHostRuntimeIdentity: {
                platform: 'ios',
                channel: 'internal',
                availableNativeCapabilities: ['host.native.camera'],
            },
        });

        expect(observedHostRuntime).toMatchObject({
            platform: 'ios',
            channel: 'internal',
            availableNativeCapabilities: ['host.native.camera'],
        });
        expect(observedHostRuntime).not.toHaveProperty('scriptManagerRuntimeIntegrated');

        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (raw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-request-identity']?.runtime;

        expect(runtime).toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
            decision: {
                state: 'fallback',
                diagnostics: [
                    'repack_script_manager_unavailable',
                    'repack_script_manager_runtime_not_integrated',
                ],
            },
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: false,
            },
        });
        expect(runtime?.state).not.toBe('loadable');
    });

    it('flips loaderBackendAvailable on from the reported host-runtime identity readiness, not static opts', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-reported-readiness', 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-reported-readiness',
                    artifactId: 'native-reported-readiness-ios',
                    digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            // Readiness must come from the reported identity below, not static opts.
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();
        const raw = await handler!({
            machineId: 'm1',
            reactNativeHostRuntimeIdentity: {
                platform: 'ios',
                channel: 'internal',
                availableNativeCapabilities: [],
                scriptManagerRuntime: {
                    integrated: true,
                    installedArtifactLoaderAvailable: true,
                },
            },
        });

        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (raw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-reported-readiness']?.runtime;

        expect(runtime).toMatchObject({
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: true,
            },
        });
    });

    it('stays fail-closed when the reported identity omits ScriptManager readiness', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-no-readiness', 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-no-readiness',
                    artifactId: 'native-no-readiness-ios',
                    digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();
        const raw = await handler!({
            machineId: 'm1',
            reactNativeHostRuntimeIdentity: {
                platform: 'ios',
                channel: 'internal',
                availableNativeCapabilities: [],
            },
        });

        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (raw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-no-readiness']?.runtime;

        expect(runtime).toMatchObject({
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: false,
            },
        });
    });

    it('ignores caller-supplied ScriptManager readiness on projection requests', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-readiness-injection', 'sha256:1111111111111111111111111111111111111111111111111111111111111111'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-readiness-injection',
                    artifactId: 'native-readiness-injection-ios',
                    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });
        let observedHostRuntime: Record<string, unknown> | undefined;

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            installedReactNativeArtifactLoaderAvailable: true,
            resolveReactNativeCrashDisabledContributionIds: ({ pluginUiHostRuntime }) => {
                observedHostRuntime = pluginUiHostRuntime.reactNativeBundles?.hostRuntime as Record<string, unknown> | undefined;
                return [];
            },
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();
        const raw = await handler!({
            machineId: 'm1',
            reactNativeHostRuntimeIdentity: {
                platform: 'ios',
                channel: 'internal',
                availableNativeCapabilities: [],
            },
            scriptManagerRuntimeIntegrated: true,
            reactNativeScriptManagerRuntimeIntegrated: true,
        });

        expect(observedHostRuntime).toMatchObject({
            platform: 'ios',
            channel: 'internal',
            availableNativeCapabilities: [],
        });
        expect(observedHostRuntime).not.toHaveProperty('scriptManagerRuntimeIntegrated');

        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (raw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-readiness-injection']?.runtime;

        expect(runtime).toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_runtime_not_integrated',
            ],
            loadPolicy: {
                source: 'installedArtifact',
                featureEnabled: true,
                loaderBackendAvailable: false,
            },
        });
        expect(runtime?.state).not.toBe('loadable');
    });

    it('serves loadable projected React Native installed artifact bytes by generation-bound cache identity', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const contribution = createReactNativeContribution('native-compatible', digest);
        const installedArtifact = createReactNativeArtifact({
            contributionId: 'native-compatible',
            artifactId: 'native-compatible-ios',
            digest,
            hostAppVersion,
            reactVersion: '19.2.0',
            reactNativeVersion: '0.83.4',
        });
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                {
                    ...contribution,
                    definition: {
                        ...contribution.definition,
                        compatibility: {
                            ...contribution.definition.compatibility,
                            supportedChannels: ['internal', 'development'],
                        },
                    },
                },
            ],
            uiArtifacts: [
                {
                    ...installedArtifact,
                    pluginRootPath: pluginRoot,
                    definition: {
                        ...installedArtifact.definition,
                        compatibility: {
                            ...installedArtifact.definition.compatibility,
                            supportedChannels: ['internal', 'development'],
                        },
                    },
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            reactNativeHostRuntime: {
                platform: 'ios',
                channel: 'development',
            },
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;
        expect(runtime).toMatchObject({
            state: 'loadable',
            diagnostics: [],
            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: expect.objectContaining({
                pluginId: 'runtime.plugin',
                contributionId: 'native-compatible',
                artifactDigest: digest,
                channel: 'development',
                projectionGeneration: 41,
            }),
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
        });

        expect(response).toMatchObject({
            ok: true,
            cacheIdentity: runtime?.cacheIdentity,
            artifact: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-compatible',
                artifactKind: 'reactNativeBundle',
                digest,
                format: 'plainJs',
                byteSize: bundleBytes.byteLength,
            },
            bytesBase64: Buffer.from(bundleBytes).toString('base64'),
        });
    });

    it('rejects React Native artifact bytes when the declared asset path escapes the plugin root through a symlink', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-symlink-'));
        const pluginRoot = join(fixtureRoot, 'plugin');
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// escaped bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        const outsideBundlePath = join(fixtureRoot, 'outside.bundle.js');
        await writeFile(outsideBundlePath, bundleBytes);
        await symlink(outsideBundlePath, join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'));
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-compatible', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();

        await expect(artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['react_native_artifact_path_invalid'],
        });
    });

    it('does not reuse a cached React Native projection after host runtime readiness changes', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-runtime-cache', 'sha256:3333333333333333333333333333333333333333333333333333333333333333'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-runtime-cache',
                    artifactId: 'native-runtime-cache-ios',
                    digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });
        let reactNativeHostRuntime: { platform: string; channel: string } | undefined = {
            platform: 'ios',
            channel: 'internal',
        };

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            installedReactNativeArtifactLoaderAvailable: true,
            reactNativeScriptManagerRuntimeIntegrated: true,
            get reactNativeHostRuntime() {
                return reactNativeHostRuntime;
            },
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        function readRuntime(projectionRaw: unknown): Record<string, unknown> | undefined {
            return (projectionRaw as {
                projection: {
                    familiesById?: Record<string, PluginUiProjectionFamily>;
                };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['reactNativeBundle:runtime.plugin:native-runtime-cache']?.runtime;
        }

        const initialRuntime = readRuntime(await projectionHandler!({ machineId: 'm1' }));
        expect(initialRuntime).toMatchObject({
            state: 'loadable',
            diagnostics: [],
            decision: { state: 'load', reason: 'compatible' },
        });

        reactNativeHostRuntime = undefined;

        const refreshedRuntime = readRuntime(await projectionHandler!({ machineId: 'm1' }));
        expect(refreshedRuntime).toMatchObject({
            state: 'fallback',
            diagnostics: [
                'repack_script_manager_unavailable',
                'react_native_host_runtime_identity_unavailable',
            ],
            decision: {
                state: 'fallback',
                diagnostics: [
                    'repack_script_manager_unavailable',
                    'react_native_host_runtime_identity_unavailable',
                ],
            },
        });
    });

    it('does not reuse a cached React Native projection after the feature gate changes', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-feature-cache', 'sha256:4444444444444444444444444444444444444444444444444444444444444444'),
            ],
            uiArtifacts: [
                createReactNativeArtifact({
                    contributionId: 'native-feature-cache',
                    artifactId: 'native-feature-cache-ios',
                    digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
                    hostAppVersion,
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                }),
            ],
        });
        let reactNativeBundlesFeatureDecision = createEnabledReactNativeBundlesFeatureDecision();

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 53,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => reactNativeBundlesFeatureDecision,
            ...readyReactNativeBackendOpts,
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        function readRuntime(projectionRaw: unknown): Record<string, unknown> | undefined {
            return (projectionRaw as {
                projection: {
                    familiesById?: Record<string, PluginUiProjectionFamily>;
                };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['reactNativeBundle:runtime.plugin:native-feature-cache']?.runtime;
        }

        const initialRuntime = readRuntime(await projectionHandler!({ machineId: 'm1' }));
        expect(initialRuntime).toMatchObject({
            state: 'loadable',
            diagnostics: [],
            decision: { state: 'load', reason: 'compatible' },
        });

        reactNativeBundlesFeatureDecision = createDisabledReactNativeBundlesFeatureDecision();

        const refreshedRuntime = readRuntime(await projectionHandler!({ machineId: 'm1' }));
        expect(refreshedRuntime).toMatchObject({
            state: 'fallback',
            diagnostics: ['feature_disabled'],
            decision: {
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            },
        });
    });

    it('projects durable React Native crash-disabled contributions as disabled without executable load policy', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disabled-projection-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// crash-disabled bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-compatible', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 43,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            resolveReactNativeCrashDisabledContributionIds: async () => ['runtime.plugin:native-compatible'],
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

        expect(runtime).toMatchObject({
            state: 'disabled',
            diagnostics: ['crash_threshold_reached'],
            decision: {
                state: 'disabled',
                reason: 'crash_disabled',
                diagnostics: ['crash_threshold_reached'],
            },
        });
        expect(runtime).not.toHaveProperty('loadPolicy');
        expect(runtime).not.toHaveProperty('cacheIdentity');
    });

    it('rejects React Native artifact bytes when the current projection is crash-disabled', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disabled-bytes-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// crash-disabled byte request bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-compatible', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const enabledHandlers = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(enabledHandlers.registrar as never, {
            resolveGeneration: async () => 44,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });
        const projectionHandler = enabledHandlers.handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;
        expect(runtime?.cacheIdentity).toMatchObject({
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
            artifactDigest: digest,
            projectionGeneration: 44,
        });

        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const disabledHandlers = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(disabledHandlers.registrar as never, {
            resolveGeneration: async () => 44,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            resolveReactNativeCrashDisabledContributionIds: async () => ['runtime.plugin:native-compatible'],
        });

        const artifactBytesHandler = disabledHandlers.handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
        });

        expect(response).toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['react_native_projected_identity_not_found'],
        });
    });

    it('fails closed for React Native projection and byte serving when durable crash-disable state is malformed', async () => {
        const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disable-malformed-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();

        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disabled-malformed-bytes-'));
            await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
            const bundleBytes = new TextEncoder().encode('// malformed crash-disable state bundle');
            const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
            await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
            const hostAppVersion = configuration.currentCliVersion;
            const registry = createResolvedContributionRegistry({
                agents: [],
                reactNativeBundles: [
                    createReactNativeContribution('native-compatible', digest),
                ],
                uiArtifacts: [
                    {
                        ...createReactNativeArtifact({
                            contributionId: 'native-compatible',
                            artifactId: 'native-compatible-ios',
                            digest,
                            hostAppVersion,
                            reactVersion: '19.2.0',
                            reactNativeVersion: '0.83.4',
                        }),
                        pluginRootPath: pluginRoot,
                    },
                ],
            });

            const crashDisableStore = createReactNativeCrashDisableStateStore({ happyHomeDir });
            await mkdir(crashDisableStore.paths.stateDir, { recursive: true });
            await writeFile(crashDisableStore.stateFilePath, '{not-json', 'utf8');

            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 45,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            });

            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(projectionHandler).toBeDefined();
            const projectionRaw = await projectionHandler!({ machineId: 'm1' });
            type PluginUiProjectionFamily = Readonly<{
                entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
            }>;
            const runtime = (projectionRaw as {
                projection: {
                    familiesById?: Record<string, PluginUiProjectionFamily>;
                };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

            expect(runtime).toMatchObject({
                state: 'disabled',
                diagnostics: ['crash_threshold_reached'],
                decision: {
                    state: 'disabled',
                    reason: 'crash_disabled',
                    diagnostics: ['crash_threshold_reached'],
                },
            });
            expect(runtime).not.toHaveProperty('loadPolicy');
            expect(runtime).not.toHaveProperty('cacheIdentity');

            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            expect(artifactBytesHandler).toBeDefined();
            const response = await artifactBytesHandler!({
                machineId: 'm1',
                cacheIdentity: {
                    pluginId: 'runtime.plugin',
                    contributionId: 'native-compatible',
                    artifactDigest: digest,
                    hostAppVersion,
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    platform: 'ios',
                    channel: 'internal',
                    nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                    projectionGeneration: 45,
                },
            });

            expect(response).toEqual({
                ok: false,
                code: 'artifact_not_found',
                diagnostics: ['react_native_projected_identity_not_found'],
            });
        } finally {
            if (originalHappyHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
            }
            reloadConfiguration();
        }
    });

    it('persists React Native crash-disable reports and invalidates the cached projection', async () => {
        const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-report-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();

        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

            const digest = 'sha256:5555555555555555555555555555555555555555555555555555555555555555';
            const hostAppVersion = configuration.currentCliVersion;
            const registry = createResolvedContributionRegistry({
                agents: [],
                reactNativeBundles: [
                    createReactNativeContribution('native-compatible', digest),
                ],
                uiArtifacts: [
                    createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                ],
            });

            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 46,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            });

            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(projectionHandler).toBeDefined();
            const initialProjectionRaw = await projectionHandler!({ machineId: 'm1' });
            type PluginUiProjectionFamily = Readonly<{
                entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
            }>;
            const initialRuntime = (initialProjectionRaw as {
                projection: {
                    familiesById?: Record<string, PluginUiProjectionFamily>;
                };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;
            expect(initialRuntime).toMatchObject({
                state: 'loadable',
                cacheKey: expect.any(String),
                cacheIdentity: expect.objectContaining({
                    pluginId: 'runtime.plugin',
                    contributionId: 'native-compatible',
                    artifactDigest: digest,
                    projectionGeneration: 46,
                }),
            });

            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(crashReportHandler).toBeDefined();
            const reportResponse = await crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    surfaceId: 'surface_1',
                    cacheIdentity: initialRuntime?.cacheIdentity,
                    disabledReason: 'render_error_threshold',
                    crashCount: 2,
                    startupFailureCount: 0,
                    observedAtMs: 2_000,
                    diagnostics: ['threshold_reached'],
                },
            });

            expect(reportResponse).toEqual({
                protocolVersion: 1,
                ok: true,
                contributionKey: 'runtime.plugin:native-compatible',
                disabled: true,
            });
            await expect(createReactNativeCrashDisableStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
                records: {
                    'runtime.plugin:native-compatible': {
                        pluginId: 'runtime.plugin',
                        contributionId: 'native-compatible',
                        cacheKey: initialRuntime?.cacheKey,
                        artifactDigest: digest,
                        crashCount: 2,
                        startupFailureCount: 0,
                        disabled: true,
                        disabledReason: 'render_error_threshold',
                        disabledAtMs: 2_000,
                        updatedAtMs: 2_000,
                    },
                },
            });

            const refreshedProjectionRaw = await projectionHandler!({ machineId: 'm1' });
            const refreshedRuntime = (refreshedProjectionRaw as {
                projection: {
                    familiesById?: Record<string, PluginUiProjectionFamily>;
                };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

            expect(refreshedProjectionRaw).not.toBe(initialProjectionRaw);
            expect(refreshedRuntime).toMatchObject({
                state: 'disabled',
                diagnostics: ['crash_threshold_reached'],
            });
            expect(refreshedRuntime).not.toHaveProperty('loadPolicy');
            expect(refreshedRuntime).not.toHaveProperty('cacheIdentity');

            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            expect(artifactBytesHandler).toBeDefined();
            await expect(artifactBytesHandler!({
                machineId: 'm1',
                cacheIdentity: initialRuntime?.cacheIdentity,
            })).resolves.toEqual({
                ok: false,
                code: 'artifact_not_found',
                diagnostics: ['react_native_projected_identity_not_found'],
            });
        } finally {
            if (originalHappyHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
            }
            reloadConfiguration();
        }
    });

    it('rejects stale React Native crash reports without mutating durable crash-disable state', async () => {
        const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-report-stale-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();

        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

            const digest = 'sha256:6666666666666666666666666666666666666666666666666666666666666666';
            const staleDigest = 'sha256:7777777777777777777777777777777777777777777777777777777777777777';
            const hostAppVersion = configuration.currentCliVersion;
            const registry = createResolvedContributionRegistry({
                agents: [],
                reactNativeBundles: [
                    createReactNativeContribution('native-compatible', digest),
                ],
                uiArtifacts: [
                    createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                ],
            });

            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 47,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            });

            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(crashReportHandler).toBeDefined();
            const reportResponse = await crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    surfaceId: 'surface_1',
                    cacheIdentity: {
                        pluginId: 'runtime.plugin',
                        contributionId: 'native-compatible',
                        artifactDigest: staleDigest,
                        hostAppVersion,
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        platform: 'ios',
                        channel: 'internal',
                        nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                        projectionGeneration: 46,
                    },
                    disabledReason: 'startup_ack_timeout_threshold',
                    crashCount: 0,
                    startupFailureCount: 2,
                    observedAtMs: 2_000,
                },
            });

            expect(reportResponse).toEqual({
                protocolVersion: 1,
                ok: false,
                code: 'projection_identity_mismatch',
                diagnostics: ['react_native_crash_report_projection_identity_mismatch'],
            });
            await expect(createReactNativeCrashDisableStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
                records: {},
            });
        } finally {
            if (originalHappyHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
            }
            reloadConfiguration();
        }
    });

    it('uses the canonical CLI feature decision to enable React Native bundle projection', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-feature-decision-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// canonical feature decision bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-compatible', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            processEnv: {
                HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES__ENABLED: '1',
            } as NodeJS.ProcessEnv,
            resolveGeneration: async () => 42,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            // G-RC4: the RN-bundle client tier depends on the server-represented plugins.ui gate,
            // so the projection needs the server snapshot to resolve the tier loadable.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        plugins: {
                            enabled: true,
                            ui: {
                                enabled: true,
                                reactNativeBundles: { enabled: true },
                            },
                        },
                    },
                }),
            }),
            ...readyReactNativeBackendOpts,
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

        expect(runtime).toMatchObject({
            state: 'loadable',
            decision: { state: 'load' },
            cacheIdentity: expect.objectContaining({
                pluginId: 'runtime.plugin',
                contributionId: 'native-compatible',
                artifactDigest: digest,
                projectionGeneration: 42,
            }),
        });
    });

    it('refuses React Native bundle projection when the server disables the parent plugins.ui gate (D-RC3)', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-parent-disabled-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-compatible'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// parent-disabled bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-compatible', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-compatible', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-compatible',
                        artifactId: 'native-compatible-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            processEnv: {
                // Even with the daemon-local opt-in env var set, the server-disabled parent
                // plugins.ui gate must cascade to refuse the client-represented child tier.
                HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES__ENABLED: '1',
            } as NodeJS.ProcessEnv,
            resolveGeneration: async () => 42,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { plugins: { enabled: true, ui: { enabled: false } } } }),
            }),
            ...readyReactNativeBackendOpts,
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<{ runtime?: Record<string, unknown> }>>;
        }>;
        const runtime = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:native-compatible']?.runtime;

        const decision = runtime?.decision as { state?: string } | undefined;
        expect(runtime?.state).not.toBe('loadable');
        expect(decision?.state).not.toBe('load');
    });

    const createHostedWebPreviewProjectionRegistry = () => createResolvedContributionRegistry({
            agents: [],
            hostedWeb: [{
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
                    id: 'preview-web',
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    entry: { routeMode: 'hostOrigin', path: '/' },
                    bridge: { allowedMessages: ['ready'] },
                    sandbox: {
                        scripts: true,
                        sameOrigin: false,
                        popups: false,
                        topNavigation: false,
                        mixedContent: false,
                    },
                    security: {
                        allowedNavigationOrigins: [],
                        allowedCallbackOrigins: [],
                        allowedConnectOrigins: [],
                        sourceMaps: 'disabled',
                        mixedContent: 'deny',
                        csp: {
                            scriptSrc: 'selfOnly',
                            styleSrc: 'selfOnly',
                            imgSrc: 'selfOnly',
                            fontSrc: 'selfOnly',
                            connectSrc: 'selfOnly',
                            allowDataUrls: false,
                            allowBlobUrls: false,
                            allowInlineStyles: false,
                            allowEval: false,
                        },
                    },
                    fallback: { kind: 'unavailable' },
                    display: rnDisplay,
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
                    id: 'preview-web-static',
                    contributionId: 'preview-web',
                    contributionFamily: 'hostedWeb',
                    artifactKind: 'hostedWebAsset',
                    platform: 'web',
                    channel: 'internal',
                    integrity: { digest: 'sha256:8888888888888888888888888888888888888888888888888888888888888888' },
                    compatibility: {
                        hostAppVersion: configuration.currentCliVersion,
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        nativeCapabilities: [],
                    },
                    byteSize: 512,
                    contentType: 'text/html',
                    assetPath: 'hosted-web/preview-web/index.html',
                },
            }],
        });

    it('uses the canonical CLI feature decision to enable hosted-web runtime projection', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const registry = createHostedWebPreviewProjectionRegistry();

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            processEnv: {
                HAPPIER_FEATURE_PLUGINS_UI_HOSTED_WEB__ENABLED: '1',
            } as NodeJS.ProcessEnv,
            resolveGeneration: async () => 42,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            // G-RC4: the hosted-web client tier depends on the server-represented plugins.ui gate,
            // so the projection needs the server snapshot to resolve the tier loadable.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        plugins: {
                            enabled: true,
                            ui: {
                                enabled: true,
                                hostedWeb: { enabled: true },
                            },
                        },
                    },
                }),
            }),
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<Record<string, unknown>>>;
        }>;
        const entry = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['hostedWeb:runtime.plugin:preview-web'];

        expect(entry).toMatchObject({
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
            runtime: {
                state: 'available',
                decision: { state: 'render', reason: 'available' },
            },
        });
    });

    it('refuses hosted-web runtime projection when the server disables the parent plugins.ui gate (D-RC3)', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const registry = createHostedWebPreviewProjectionRegistry();

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            processEnv: {
                // The daemon-local opt-in is set, but a server-disabled parent plugins.ui gate
                // must cascade to refuse the client-represented hosted-web child tier.
                HAPPIER_FEATURE_PLUGINS_UI_HOSTED_WEB__ENABLED: '1',
            } as NodeJS.ProcessEnv,
            resolveGeneration: async () => 42,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { plugins: { enabled: true, ui: { enabled: false } } } }),
            }),
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(projectionHandler).toBeDefined();
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, Readonly<Record<string, unknown>>>;
        }>;
        const entry = (projectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['hostedWeb:runtime.plugin:preview-web'];

        const runtime = entry?.runtime as { state?: string; decision?: { state?: string } } | undefined;
        expect(runtime?.state).not.toBe('available');
        expect(runtime?.decision?.state).not.toBe('render');
    });

    it('rejects React Native artifact bytes when the current host lacks required native capabilities', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-native-cap-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-capability'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// native capability bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-capability', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const nativeCapabilities = ['host.native.camera'];
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-capability',
                        artifactId: 'native-capability-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        nativeCapabilities,
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-capability',
                artifactDigest: digest,
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest(nativeCapabilities),
                projectionGeneration: 41,
            },
        });

        expect(response).toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['missing_native_capability'],
        });
    });

    it('rejects React Native artifact bytes when the canonical feature decision is missing', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-feature-disabled-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-feature-disabled'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// feature disabled bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-feature-disabled', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-feature-disabled', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-feature-disabled',
                        artifactId: 'native-feature-disabled-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            ...readyReactNativeBackendOpts,
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-feature-disabled',
                artifactDigest: digest,
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: 41,
            },
        });

        expect(response).toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['feature_disabled'],
        });
    });

    it('rejects React Native artifact bytes when the projected cache generation is stale', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-stale-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-stale-generation'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// stale generation bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-stale-generation', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-stale-generation', digest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-stale-generation',
                        artifactId: 'native-stale-generation-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 42,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-stale-generation',
                artifactDigest: digest,
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: 41,
            },
        });

        expect(response).toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['react_native_projection_generation_mismatch'],
        });
    });

    it('rejects React Native artifact bytes when no current loadable projection owns the identity', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-orphan-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-orphan'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// orphan bundle');
        const digest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-orphan', 'ios.bundle.js'), bundleBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-orphan',
                        artifactId: 'native-orphan-ios',
                        digest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-orphan',
                artifactDigest: digest,
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: 41,
            },
        });

        expect(response).toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['react_native_projected_identity_not_found'],
        });
    });

    it('serves React Native installed artifact entry and sibling chunk files with per-file integrity', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-artifact-chunks-'));
        await mkdir(join(pluginRoot, 'react-native', 'native-chunked'), { recursive: true });
        const bundleBytes = new TextEncoder().encode('// entry bundle');
        const chunkBytes = new TextEncoder().encode('// render surface chunk');
        const bundleDigest = computePluginUiArtifactSha256DigestV1(bundleBytes);
        const chunkDigest = computePluginUiArtifactSha256DigestV1(chunkBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-chunked', 'ios.bundle.js'), bundleBytes);
        await writeFile(join(pluginRoot, 'react-native', 'native-chunked', 'src_ui_renderSurface_tsx.chunk.bundle'), chunkBytes);
        const hostAppVersion = configuration.currentCliVersion;
        const registry = createResolvedContributionRegistry({
            agents: [],
            reactNativeBundles: [
                createReactNativeContribution('native-chunked', bundleDigest),
            ],
            uiArtifacts: [
                {
                    ...createReactNativeArtifact({
                        contributionId: 'native-chunked',
                        artifactId: 'native-chunked-ios',
                        digest: bundleDigest,
                        hostAppVersion,
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        files: [
                            {
                                relativePath: 'react-native/native-chunked/ios.bundle.js',
                                digest: bundleDigest,
                                byteSize: bundleBytes.byteLength,
                            },
                            {
                                relativePath: 'react-native/native-chunked/src_ui_renderSurface_tsx.chunk.bundle',
                                digest: chunkDigest,
                                byteSize: chunkBytes.byteLength,
                            },
                        ],
                    }),
                    pluginRootPath: pluginRoot,
                },
            ],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-chunked',
                artifactDigest: bundleDigest,
                hostAppVersion,
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: 41,
            },
        });

        expect(response).toMatchObject({
            ok: true,
            artifact: {
                pluginId: 'runtime.plugin',
                contributionId: 'native-chunked',
                artifactKind: 'reactNativeBundle',
                digest: bundleDigest,
                byteSize: bundleBytes.byteLength,
            },
            bytesBase64: Buffer.from(bundleBytes).toString('base64'),
            files: [
                {
                    relativePath: 'react-native/native-chunked/ios.bundle.js',
                    digest: bundleDigest,
                    byteSize: bundleBytes.byteLength,
                    bytesBase64: Buffer.from(bundleBytes).toString('base64'),
                },
                {
                    relativePath: 'react-native/native-chunked/src_ui_renderSurface_tsx.chunk.bundle',
                    digest: chunkDigest,
                    byteSize: chunkBytes.byteLength,
                    bytesBase64: Buffer.from(chunkBytes).toString('base64'),
                },
            ],
        });

    });

    it('serves a generated React Native Web renderer from its exact complete artifact graph', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-rnw-artifact-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'react-native/panel/index.js';
        const chunkPath = 'react-native/panel/chunk.js';
        await mkdir(join(installedRoot, 'react-native', 'panel'), { recursive: true });
        const entryBytes = new TextEncoder().encode('export { renderSurface } from "./chunk.js";');
        const chunkBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        await writeFile(join(installedRoot, entryPath), entryBytes);
        await writeFile(join(installedRoot, chunkPath), chunkBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
            { relativePath: chunkPath, bytes: chunkBytes },
        ]);
        const artifactGraph = {
            contributionId: 'panel-artifact',
            tier: 'reactNative' as const,
            platform: 'web' as const,
            entry: entryPath,
            files: [
                {
                    relativePath: chunkPath,
                    digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                    byteSize: chunkBytes.byteLength,
                },
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                },
            ],
            digest: artifactDigest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'runtime.plugin',
                identity: { pluginId: 'runtime.plugin', localId: 'panel-renderer' },
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                manifestDigest: 'sha256:runtime',
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'panel-renderer',
                    kind: 'reactNative',
                    artifact: 'panel-artifact',
                },
            }],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 51,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            reactNativeHostRuntime: { platform: 'web', channel: 'internal' },
        });
        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        const runtime = (projectionRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, { runtime?: Record<string, unknown> }> }> };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime;
        expect(runtime).toMatchObject({
            state: 'loadable',
            cacheIdentity: { artifactDigest, platform: 'web', projectionGeneration: 51 },
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        const response = await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
        });

        expect(response).toEqual({
            ok: true,
            cacheIdentity: runtime?.cacheIdentity,
            artifact: {
                pluginId: 'runtime.plugin',
                contributionId: 'panel-renderer',
                artifactKind: 'reactNativeBundle',
                digest: artifactDigest,
                format: 'plainJs',
                byteSize: entryBytes.byteLength,
            },
            bytesBase64: Buffer.from(entryBytes).toString('base64'),
            files: [
                {
                    relativePath: chunkPath,
                    digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                    byteSize: chunkBytes.byteLength,
                    bytesBase64: Buffer.from(chunkBytes).toString('base64'),
                },
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytesBase64: Buffer.from(entryBytes).toString('base64'),
                },
            ],
        });

        await writeFile(
            join(installedRoot, chunkPath),
            new TextEncoder().encode('export function renderSurface() { return "tampered"; }'),
        );
        expect(await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
        })).toEqual({
            ok: false,
            code: 'artifact_integrity_failed',
            diagnostics: ['react_native_artifact_file_integrity_failed'],
        });
    });

    it('serves a generated native Voice provider client from its exact complete Re.Pack artifact graph', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-voice-artifact-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'react-native/voice-runtime-ios/index.js';
        await mkdir(join(installedRoot, 'react-native', 'voice-runtime-ios'), { recursive: true });
        const entryBytes = new TextEncoder().encode('export function activate(api) { api.voiceProviders.register("conversation", {}); }');
        await writeFile(join(installedRoot, entryPath), entryBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
        ]);
        const artifactGraph = {
            contributionId: 'voice-runtime-ios',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: entryPath,
            files: [{
                relativePath: entryPath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'repack' as const, version: '5.0.0' },
            repack: {
                containerName: 'runtime_voice_plugin_conversation',
                modulePath: './voiceRuntime',
                exportName: 'activate',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const registry = createResolvedContributionRegistry({
            agents: [],
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId: 'runtime.voice-plugin',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'runtime.voice-plugin', localId: 'conversation' },
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                manifestDigest: 'sha256:runtime',
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['ios'],
                    capabilities: {
                        readiness: { requirements: [] },
                        turn: { cancelResponse: true, bargeIn: false },
                    },
                    client: {
                        artifactId: artifactGraph.contributionId,
                        modulePath: './voiceRuntime',
                        exportName: 'activate',
                    },
                },
            }],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });
        const nativeHostRuntimeIdentity = {
            platform: 'ios' as const,
            channel: 'internal' as const,
            scriptManagerRuntime: {
                integrated: true,
                installedArtifactLoaderAvailable: true,
            },
        } as const;
        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const projectionRaw = await projectionHandler!({
            machineId: 'm1',
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        });
        const runtime = (projectionRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, { runtime?: Record<string, unknown> }> }> };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.voice-plugin:conversation']?.runtime;
        expect(runtime).toMatchObject({
            state: 'loadable',
            cacheIdentity: {
                contributionId: 'conversation',
                artifactDigest,
                platform: 'ios',
                projectionGeneration: 52,
            },
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).toEqual({
            ok: true,
            cacheIdentity: runtime?.cacheIdentity,
            artifact: {
                pluginId: 'runtime.voice-plugin',
                contributionId: 'conversation',
                artifactKind: 'reactNativeBundle',
                digest: artifactDigest,
                format: 'plainJs',
                byteSize: entryBytes.byteLength,
            },
            bytesBase64: Buffer.from(entryBytes).toString('base64'),
            files: [{
                relativePath: entryPath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
                bytesBase64: Buffer.from(entryBytes).toString('base64'),
            }],
        });

        await writeFile(join(installedRoot, entryPath), new TextEncoder().encode('tampered'));
        expect(await artifactBytesHandler!({
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).toEqual({
            ok: false,
            code: 'artifact_integrity_failed',
            diagnostics: ['react_native_artifact_file_integrity_failed'],
        });
    });

    it('reads the structured-message FeatureDecision at the projection chokepoint (fail-closed by default)', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const registry = createResolvedContributionRegistry({
            agents: [],
            structuredMessages: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'runtime.plugin',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-card',
                        title: 'Preview',
                        kind: 'runtime.plugin/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: 'summary-card',
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                    },
                },
            ],
        } as never);

        type PluginUiProjectionFamily = Readonly<{
            entriesById?: Record<string, unknown>;
        }>;
        function readStructuredMessageEntry(raw: unknown): unknown {
            return (raw as {
                projection: { familiesById?: Record<string, PluginUiProjectionFamily> };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['structuredMessage:runtime.plugin:preview-card'];
        }

        // A not-`enabled` decision (mirroring a disabled server bit) threaded
        // through the production caller omits the structured-message entry.
        const disabled = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(disabled.registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveStructuredMessagesFeatureDecision: async () => createFeatureDecision({
                featureId: 'plugins.ui.structuredMessages',
                state: 'disabled',
                blockedBy: 'server',
                blockerCode: 'feature_disabled',
                diagnostics: ['feature_disabled'],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        });
        const disabledRaw = await disabled.handlers.get(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        )!({ machineId: 'm1' });
        expect(readStructuredMessageEntry(disabledRaw)).toBeUndefined();

        // Enabled decision threaded through the production caller ⇒ entry projected.
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const enabled = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(enabled.registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveStructuredMessagesFeatureDecision: async () => createFeatureDecision({
                featureId: 'plugins.ui.structuredMessages',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
            }),
        });
        const enabledRaw = await enabled.handlers.get(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        )!({ machineId: 'm1' });
        expect(readStructuredMessageEntry(enabledRaw)).toMatchObject({
            contributionKind: 'structuredMessage',
            kind: 'runtime.plugin/preview-card.v1',
            fallback: { kind: 'summary', template: 'Preview unavailable' },
        });
    });

    it('hides plugin UI tiers in the projection when the server disables the plugin platform', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const registry = createResolvedContributionRegistry({
            agents: [],
            structuredMessages: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'runtime.plugin',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-card',
                        kind: 'runtime.plugin/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: { kind: 'host', rendererId: 'summaryCard' },
                        display: rnDisplay,
                    },
                },
            ],
        } as never);

        type PluginUiProjectionFamily = Readonly<{ entriesById?: Record<string, unknown> }>;
        function readStructuredMessageEntry(raw: unknown): unknown {
            return (raw as {
                projection: { familiesById?: Record<string, PluginUiProjectionFamily> };
            }).projection.familiesById?.pluginUi
                ?.entriesById?.['structuredMessage:runtime.plugin:preview-card'];
        }

        const structuredMessagesOptIn = { HAPPIER_FEATURE_PLUGINS_UI_STRUCTURED_MESSAGES__ENABLED: '1' } as NodeJS.ProcessEnv;

        // Server disables the plugin platform: the snapshot-threaded cascade downgrades the tier
        // even though the client tier is opted in via env. RED before §4.6 (the projection ran the
        // decision snapshot-less so the cascade never fired).
        const disabled = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(disabled.registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            processEnv: structuredMessagesOptIn,
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { plugins: { enabled: false, ui: { enabled: false } } } }),
            }),
        });
        const disabledRaw = await disabled.handlers.get(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        )!({ machineId: 'm1' });
        expect(readStructuredMessageEntry(disabledRaw)).toBeUndefined();

        // Server keeps the plugin platform enabled + client tier opted in ⇒ tier projected.
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const enabled = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(enabled.registrar as never, {
            resolveGeneration: async () => 41,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            processEnv: structuredMessagesOptIn,
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {
                        plugins: {
                            enabled: true,
                            ui: {
                                enabled: true,
                                structuredMessages: { enabled: true },
                            },
                        },
                    },
                }),
            }),
        });
        const enabledRaw = await enabled.handlers.get(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        )!({ machineId: 'm1' });
        expect(readStructuredMessageEntry(enabledRaw)).toMatchObject({
            contributionKind: 'structuredMessage',
            kind: 'runtime.plugin/preview-card.v1',
        });
    });

    it('returns a versioned projection that includes plugin provider display fields', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const inputs: ResolvedContributionInputs = {
            agents: [
                {
                    id: 'plugin-provider',
                    identity: { pluginId: 'plugin.fixture', localId: 'plugin-provider' },
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'plugin.fixture',
                    definition: {
                        kindVersion: 1,
                        id: 'plugin-provider',
                        ownedBackendIds: ['plugin-backend'],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: createExternalAgentDefinition({
                            id: 'plugin-provider',
                            title: 'Plugin Provider',
                            description: 'Plugin subtitle',
                        }),
                    },
                },
            ],
        };

        const registry = createResolvedContributionRegistry(inputs);

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => registry,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        expect(raw).toEqual(expect.objectContaining({
            protocolVersion: 1,
            projection: expect.objectContaining({
                v: 2,
                agentsById: expect.objectContaining({
                    'plugin-provider': expect.objectContaining({
                        id: 'plugin-provider',
                        title: 'Plugin Provider',
                        subtitle: 'Plugin subtitle',
                    }),
                }),
                backendsById: {},
            }),
        }));
    });

    it('projects declarative views from the current applied runtime lease across retained activation generations', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.forms',
                identity: { pluginId: 'acme.forms', localId: 'preferences-renderer' },
                manifestPath: '/plugins/acme.forms/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'preferences-renderer',
                    kind: 'declarative',
                    root: {
                        kind: 'stack',
                        children: [
                            { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
                            { kind: 'action', action: 'save', label: 'Save' },
                        ],
                    },
                    requiredHostMethods: ['executeAction'],
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.forms',
                identity: { pluginId: 'acme.forms', localId: 'preferences-view' },
                manifestPath: '/plugins/acme.forms/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'preferences-view',
                    placement: 'app.sidePanel',
                    renderer: 'preferences-renderer',
                    title: 'Preferences',
                },
            }],
            settings: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.forms',
                definition: {
                    id: 'preferences',
                    version: 1,
                    title: 'Preferences',
                    target: { kind: 'plugin' },
                    scope: 'local',
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }],
            actions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.forms',
                definition: {
                    kindVersion: 1,
                    id: 'save',
                    title: 'Save',
                    description: 'Save preferences',
                    safety: 'safe',
                    dangerLevel: 'safe',
                    placements: [],
                    slash: null,
                    bindings: null,
                    examples: null,
                    surfaces: {
                        ui: true,
                        voice: false,
                        agent: false,
                        mcp: false,
                        cli: false,
                        rpc: false,
                        sdk: false,
                    },
                    inputHints: null,
                    inputSchema: {},
                },
            }],
        });
        const actionRuntime = {
            expects: () => true,
            has: (pluginId: string, localId: string) => pluginId === 'acme.forms' && localId === 'save',
            evaluateCatalogPolicy: () => ({
                outcome: 'visible' as const,
                code: 'plugin_action_available',
                requiresCurrentIntent: false,
            }),
            invoke: vi.fn(async () => ({ status: 'executed' as const, value: null })),
            refresh: vi.fn(),
            dispose: vi.fn(),
        };
        const { handlers, registrar } = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                generation: 52,
                targetActionInvocations: actionRuntime,
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const raw = await handler!({ machineId: 'm1' });
        const entry = (raw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, unknown> }> };
        }).projection.familiesById?.pluginUi?.entriesById?.['surfacePlacement:acme.forms:preferences-view'];

        expect(entry).toMatchObject({
            generatedV2: true,
            availability: { state: 'available', reason: 'available' },
            renderer: {
                kind: 'declarative',
                contributionId: 'preferences-renderer',
                model: {
                    identity: { pluginId: 'acme.forms', localId: 'preferences-renderer', generation: '52' },
                    root: {
                        children: [
                            { kind: 'field', setting: { id: 'enabled' } },
                            { kind: 'action', enabled: true, action: { generation: '52' } },
                        ],
                    },
                },
            },
        });

        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        const retainedRegistrar = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(retainedRegistrar.registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                generation: 51,
                targetActionInvocations: actionRuntime,
            }),
        });
        const retainedRaw = await retainedRegistrar.handlers
            .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({ machineId: 'm1' });
        const retainedEntry = (retainedRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, unknown> }> };
        }).projection.familiesById?.pluginUi?.entriesById?.['surfacePlacement:acme.forms:preferences-view'];
        expect(retainedEntry).toMatchObject({
            availability: { state: 'available', reason: 'available' },
            renderer: {
                kind: 'declarative',
                contributionId: 'preferences-renderer',
                model: {
                    identity: { pluginId: 'acme.forms', localId: 'preferences-renderer', generation: '52' },
                },
            },
        });
    });

    it('exposes explicit cache invalidation for plugin reload', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection') as typeof import('./daemonContributionRegistryProjection') & {
            invalidateDaemonContributionRegistryProjectionCache?: () => void;
        };
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const inputs: ResolvedContributionInputs = {
            agents: [],
        };
        let suffix = 'one';
        const { handlers, registrar } = createRegistrar();

        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(
                createResolvedContributionRegistry({
                    ...inputs,
                    agents: [
                        {
                            id: `plugin-provider-${suffix}`,
                            identity: {
                                pluginId: 'plugin.fixture',
                                localId: `plugin-provider-${suffix}`,
                            },
                            provenance: 'external',
                            source: { kind: 'path' },
                            pluginId: 'plugin.fixture',
                            definition: {
                                kindVersion: 1,
                                id: `plugin-provider-${suffix}`,
                                ownedBackendIds: [],
                            },
                        },
                    ],
                }),
            ),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const first = await handler!({ machineId: 'm1' });
        suffix = 'two';
        const stale = await handler!({ machineId: 'm1' });
        expect(stale).toBe(first);

        expect(projectionModule.invalidateDaemonContributionRegistryProjectionCache).toEqual(expect.any(Function));
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();

        const refreshed = await handler!({ machineId: 'm1' });
        expect(refreshed).not.toBe(first);
        expect(refreshed).toEqual(expect.objectContaining({
            projection: expect.objectContaining({
                agentsById: expect.objectContaining({
                    'plugin-provider-two': expect.objectContaining({
                        id: 'plugin-provider-two',
                    }),
                }),
            }),
        }));
    });
});

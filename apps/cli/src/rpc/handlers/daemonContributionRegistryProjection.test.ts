import { access, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createFeatureDecision,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonReactNativeHostRuntimeIdentityV1,
    FeaturesResponseSchema,
    type MessageActionResolutionV1,
    normalizePluginBackendCapabilitiesV1,
    createPluginContributionIdentity,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentInputV1,
    type PluginAgentContributionV2,
    type PluginContributionPointV1,
    type PluginTargetedContributionV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import { definePlugin, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
    defineContributionPoint,
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import { configuration } from '@/configuration';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { projectPluginCatalogEntryIntrospection } from '@/plugins/projection/introspection/catalogEntry';

import type {
    ResolvedContributionInputs,
    ResolvedActionContribution,
} from '@/plugins/projection/registry/types';
import { deriveReactNativeNativeCapabilitiesDigest } from '@/plugins/install/ui/reactNativeBundles';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import {
    createDaemonPluginSecretCustodyRouter,
    createDeclaredPluginSecretsService,
    createPluginSecretCustodyRouter,
    createStableDeclaredPluginSecretsHost,
} from '@/plugins/runtime/context/secrets';
import {
    createPluginStorageBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    createStablePluginSettingsOwner,
} from '@/plugins/runtime/invocation/services/settings';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';

const executePluginActionIfAvailableMock = vi.hoisted(() => vi.fn());

vi.mock('@/plugins/projection/actions/execute', () => ({
    executePluginActionIfAvailable: executePluginActionIfAvailableMock,
}));

/**
 * This spec resets Vite's module cache for a reload-singleton fixture. A later
 * handler import can therefore hold a different `@/configuration` singleton
 * than this module's static import. Scope HOME changes through the dynamic
 * instance the handler will share, and clear its projection cache on both
 * sides of the test boundary.
 */
async function createHappyHomeDirScopeForTest(prefix: string): Promise<Readonly<{
    happyHomeDir: string;
    configuration: typeof configuration;
    restore: () => Promise<void>;
}>> {
    const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    const happyHomeDir = await mkdtemp(join(tmpdir(), prefix));
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const configurationModule = await import('@/configuration');
    configurationModule.reloadConfiguration();
    const projectionModule = await import('./daemonContributionRegistryProjection');
    projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();

    return Object.freeze({
        happyHomeDir,
        configuration: configurationModule.configuration,
        restore: async () => {
            if (previousHappyHomeDir === undefined) {
                delete process.env.HAPPIER_HOME_DIR;
            } else {
                process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;
            }
            configurationModule.reloadConfiguration();
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        },
    });
}

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

/** A syntactically valid but deliberately unbound renderer token for no-owner rejection tests. */
function createUnboundReactNativeCrashStateToken(params: Readonly<{
    contributionId: string;
    artifactDigest: string;
    pluginId?: string;
}>): Readonly<{
    mount: Readonly<{
        kind: 'destination';
        destination: Readonly<{ pluginId: string; localId: string }>;
    }>;
    renderer: Readonly<{ pluginId: string; localId: string }>;
    artifactDigest: string;
    crashStateEpoch: number;
}> {
    return Object.freeze({
        mount: Object.freeze({
            kind: 'destination',
            destination: Object.freeze({
                pluginId: params.pluginId ?? 'runtime.plugin',
                localId: 'legacy-unbound-surface',
            }),
        }),
        renderer: Object.freeze({ pluginId: params.pluginId ?? 'runtime.plugin', localId: params.contributionId }),
        artifactDigest: params.artifactDigest,
        crashStateEpoch: 0,
    });
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
        pluginDiagnosticsByPluginId: {},
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: async () => createUnavailablePluginServices(),
        resolvePromptAssetBlocks: async () => [],
        resolveStructuredMessage: async () => {
            throw new Error('Structured-message resolution is unavailable in this fixture');
        },
        dispose: async () => {},
        ...overrides,
        retireConsumers: overrides.retireConsumers ?? (() => {}),
    };
}

function createStructuredActionFixture(input: Readonly<{
    id: string;
    placementBindings: NonNullable<ResolvedActionContribution['definition']['placementBindings']>;
    executionTarget?: 'daemon' | 'client';
    operation?: NonNullable<ResolvedActionContribution['definition']['operation']>;
}>): ResolvedActionContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.preview',
        definition: {
            kindVersion: 1,
            id: input.id,
            title: input.id,
            description: null,
            safety: 'safe',
            dangerLevel: 'safe',
            execution: { target: input.executionTarget ?? 'daemon' },
            scopes: ['session', 'message'],
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
                api: false,
                plugin: false,
            },
            inputHints: null,
            inputSchema: { type: 'object', additionalProperties: true },
            outputSchema: { type: 'object', additionalProperties: true },
            contributionSurfaces: ['ui'],
            placementBindings: [...input.placementBindings],
            ...(input.operation ? { operation: input.operation } : {}),
        },
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

function createEnabledHostedWebFeatureDecision() {
    return createFeatureDecision({
        featureId: 'plugins.ui.hostedWeb',
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
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

function createActionFormConnectedAccountManifest(input: Readonly<{
    optional?: boolean;
    secondSelect?: boolean;
    pluginOnly?: boolean;
    zeroSelect?: boolean;
}> = {}) {
    const primaryAccess = {
        id: 'select-account',
        capability: 'connectedAccounts' as const,
        reason: 'Select an account for this Action form',
        scope: {
            serviceRefs: ['account'],
            operations: ['select' as const, 'use' as const],
        },
    };
    const secondAccess = {
        id: 'second-select-account',
        capability: 'connectedAccounts' as const,
        reason: 'Select a second account for this Action form',
        scope: {
            serviceRefs: ['account'],
            operations: ['select' as const],
        },
    };
    const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: 'acme.action-form',
        hostAccess: {
            required: input.optional ? [] : [primaryAccess, ...(input.secondSelect ? [secondAccess] : [])],
            optional: input.optional ? [primaryAccess, ...(input.secondSelect ? [secondAccess] : [])] : [],
        },
        contributes: {
            connectedAccountDescriptors: [{
                id: 'account',
                title: 'Account',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                    }],
                },
            }],
            actions: [{
                id: 'run',
                title: 'Run',
                scopes: ['global'],
                surfaces: input.pluginOnly ? ['plugin'] : ['ui'],
                ...(input.pluginOnly ? {} : { placementBindings: ['commandPalette'] as const }),
                dangerLevel: 'safe',
                execution: { target: 'daemon' },
                hostAccess: [primaryAccess.id, ...(input.secondSelect ? [secondAccess.id] : [])],
                connectedAccountPurposeBindings: [{
                    path: 'credentialRef',
                    purpose: primaryAccess.id,
                }],
                inputSchema: {
                    type: 'object',
                    properties: {
                        credentialRef: {
                            type: 'object',
                            properties: {
                                service: {
                                    type: 'object',
                                    properties: {
                                        pluginId: { type: 'string' },
                                        localId: { type: 'string' },
                                    },
                                    required: ['pluginId', 'localId'],
                                    additionalProperties: false,
                                },
                                accountId: { type: 'string' },
                            },
                            required: ['service', 'accountId'],
                            additionalProperties: false,
                        },
                    },
                    required: ['credentialRef'],
                    additionalProperties: false,
                },
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Connected Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                },
            }],
        },
    }));
    if (!manifest) throw new Error('Expected Connected Account Action-form manifest fixture');
    if (!input.zeroSelect) return manifest;

    // Canonical normalization rejects this state; retain it only to exercise the RPC's defensive guard.
    return {
        ...manifest,
        contributes: {
            ...manifest.contributes,
            actions: manifest.contributes.actions.map((action) => (
                action.id === 'run' ? { ...action, hostAccess: [] } : action
            )),
        },
    };
}

function createActionFormRegistry(manifest: ReturnType<typeof createActionFormConnectedAccountManifest>) {
    return createResolvedContributionRegistry({
        activationTargets: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: manifest.id,
            manifestPath: `/plugins/${manifest.id}/.happier-plugin/plugin.json`,
            daemonEntryPath: `/plugins/${manifest.id}/daemon.mjs`,
            sourceSpec: {
                kind: 'path',
                locator: `/plugins/${manifest.id}`,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            activationEvents: ['startup'],
            manifest,
        }],
    });
}

type TargetActionInvocationRuntime = NonNullable<
    ResolvedExecutablePluginRuntimeRegistry['targetActionInvocations']
>;

function createActionFormTargetInvocationRuntime(input: Readonly<{
    current?: boolean;
    isCurrent?: () => boolean;
    visible?: boolean;
}> = {}): TargetActionInvocationRuntime {
    return {
        expects: () => true,
        has: (pluginId: string, localId: string) => (
            (input.isCurrent?.() ?? input.current !== false)
            && pluginId === 'acme.action-form'
            && localId === 'run'
        ),
        evaluateCatalogPolicy: () => ({
            outcome: input.visible === false ? 'unavailable' as const : 'visible' as const,
            code: input.visible === false ? 'plugin_contribution_not_applicable' : 'plugin_action_available',
            requiresCurrentIntent: false,
        }),
        prepare: vi.fn<TargetActionInvocationRuntime['prepare']>(async () => ({
            kind: 'settled',
            result: { status: 'executed', value: null },
        })),
        invoke: vi.fn<TargetActionInvocationRuntime['invoke']>(async () => ({
            status: 'executed',
            value: null,
        })),
        refresh: vi.fn<TargetActionInvocationRuntime['refresh']>(),
        dispose: vi.fn<TargetActionInvocationRuntime['dispose']>(),
    };
}

type ActionFormOptionsResolve = DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];

async function registerActionFormOptionsHandler(input: Readonly<{
    manifest: ReturnType<typeof createActionFormConnectedAccountManifest>;
    resolveGeneration: () => Promise<number>;
    runtimeGeneration?: number;
    targetActionInvocations: TargetActionInvocationRuntime;
    listActionFormConnectedAccountOptions: ActionFormOptionsResolve;
}>) {
    const projectionModule = await import('./daemonContributionRegistryProjection');
    const { handlers, registrar } = createRegistrar();
    projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar, {
        resolveRuntimeRegistry: async () => createRuntimeRegistry(
            createActionFormRegistry(input.manifest),
            {
                generation: input.runtimeGeneration ?? 7,
                targetActionInvocations: input.targetActionInvocations,
            },
        ),
        resolveGeneration: input.resolveGeneration,
        resolveConnectedAccountPurposeBindingRuntime: () => ({
            listActionFormConnectedAccountOptions: input.listActionFormConnectedAccountOptions,
        }),
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE);
    if (!handler) throw new Error('Expected Connected Account Action-form options handler');
    return handler;
}

function createHostedWebPreviewProjectionRegistry() {
    const digest = `sha256:${'a'.repeat(64)}` as PluginUiArtifactDigestV1;
    return createResolvedContributionRegistry({
        agents: [],
        uiRenderersV2: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'runtime.plugin',
            identity: { pluginId: 'runtime.plugin', localId: 'preview-web' },
            manifestPath: '/plugins/runtime/plugin.json',
            pluginRootPath: '/plugins/runtime',
            generatedUiArtifactsManifest: {
                version: 1,
                entries: [{
                    contributionId: 'preview-web-static',
                    tier: 'hostedWeb',
                    platform: 'web',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest,
                        byteSize: 1,
                    }],
                    digest,
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: {},
                }],
            },
            definition: {
                id: 'preview-web',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'preview-web-static' },
            },
        }],
    });
}

describe('daemon contribution registry projection rpc handler', () => {
    it('derives and returns only the current Action-form Connected Account purpose scope', async () => {
        const listActionFormConnectedAccountOptions = vi.fn<ActionFormOptionsResolve>(async () => [{
            value: {
                service: { pluginId: 'acme.action-form', localId: 'account' },
                accountId: 'account-1',
            },
            label: 'Account one',
        }]);
        const handler = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions,
        });

        await expect(handler({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({
            ok: true,
            options: [{
                value: {
                    service: { pluginId: 'acme.action-form', localId: 'account' },
                    accountId: 'account-1',
                },
                label: 'Account one',
            }],
        });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledWith({
            purpose: {
                consumer: { pluginId: 'acme.action-form', localId: 'run' },
                purpose: 'select-account',
            },
            serviceRefs: [{ pluginId: 'acme.action-form', localId: 'account' }],
            signal: expect.any(AbortSignal),
        });
    });

    it('uses the public projection revision rather than a retained activation generation for Action-form Connected Account options', async () => {
        const projectionGeneration = 5;
        const listActionFormConnectedAccountOptions = vi.fn<ActionFormOptionsResolve>(async () => []);
        const handler = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => projectionGeneration,
            runtimeGeneration: 1,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions,
        });
        const request = {
            machineId: 'machine-1',
            expectedGeneration: '5',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        };

        await expect(handler(request)).resolves.toEqual({ ok: true, options: [] });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledOnce();

        await expect(handler({ ...request, expectedGeneration: '4' })).resolves.toEqual({
            ok: false,
            code: 'plugin_generation_stale',
        });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledOnce();
    });

    it('resolves a present-user core form option source for a current plugin-only target Action', async () => {
        const listActionFormConnectedAccountOptions = vi.fn<ActionFormOptionsResolve>(async () => []);
        const targetActionInvocations = createActionFormTargetInvocationRuntime({ visible: false });
        const handler = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest({ pluginOnly: true }),
            resolveGeneration: async () => 7,
            targetActionInvocations,
            listActionFormConnectedAccountOptions,
        });

        await expect(handler({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({ ok: true, options: [] });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledWith({
            purpose: {
                consumer: { pluginId: 'acme.action-form', localId: 'run' },
                purpose: 'select-account',
            },
            serviceRefs: [{ pluginId: 'acme.action-form', localId: 'account' }],
            signal: expect.any(AbortSignal),
        });
        expect(targetActionInvocations.invoke).not.toHaveBeenCalled();
    });

    it('does not invoke Action-form inventory for stale, unavailable, or ungranted declarations, while honoring an explicit field mapping', async () => {
        const request = {
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        };

        const staleList = vi.fn<ActionFormOptionsResolve>(async () => []);
        const stale = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => 8,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions: staleList,
        });
        await expect(stale(request)).resolves.toEqual({ ok: false, code: 'plugin_generation_stale' });
        expect(staleList).not.toHaveBeenCalled();

        const unmaterializedList = vi.fn<ActionFormOptionsResolve>(async () => []);
        const unmaterialized = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime({ current: false }),
            listActionFormConnectedAccountOptions: unmaterializedList,
        });
        await expect(unmaterialized(request)).resolves.toEqual({
            ok: false,
            code: 'plugin_action_form_connected_account_options_unavailable',
        });
        expect(unmaterializedList).not.toHaveBeenCalled();

        const optionalList = vi.fn<ActionFormOptionsResolve>(async () => []);
        const optional = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest({ optional: true }),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions: optionalList,
        });
        await expect(optional(request)).resolves.toEqual({
            ok: false,
            code: 'plugin_action_form_connected_account_options_unavailable',
        });
        expect(optionalList).not.toHaveBeenCalled();

        const multipleSelectList = vi.fn<ActionFormOptionsResolve>(async () => []);
        const multipleSelect = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest({ secondSelect: true }),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions: multipleSelectList,
        });
        await expect(multipleSelect(request)).resolves.toEqual({ ok: true, options: [] });
        expect(multipleSelectList).toHaveBeenCalledOnce();

        const zeroSelectList = vi.fn<ActionFormOptionsResolve>(async () => []);
        const zeroSelect = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest({ zeroSelect: true }),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions: zeroSelectList,
        });
        await expect(zeroSelect(request)).resolves.toEqual({
            ok: false,
            code: 'plugin_action_form_connected_account_options_unavailable',
        });
        expect(zeroSelectList).not.toHaveBeenCalled();
    });

    it('drops an Action-form inventory result if its projection generation changes while it resolves', async () => {
        let generation = 7;
        const listActionFormConnectedAccountOptions = vi.fn<ActionFormOptionsResolve>(async () => {
            generation = 8;
            return [];
        });
        const handler = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => generation,
            targetActionInvocations: createActionFormTargetInvocationRuntime(),
            listActionFormConnectedAccountOptions,
        });

        await expect(handler({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({ ok: false, code: 'plugin_generation_stale' });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledOnce();
    });

    it('drops an Action-form inventory result if its target registration retires while it resolves', async () => {
        let current = true;
        const listActionFormConnectedAccountOptions = vi.fn<ActionFormOptionsResolve>(async () => {
            current = false;
            return [];
        });
        const handler = await registerActionFormOptionsHandler({
            manifest: createActionFormConnectedAccountManifest(),
            resolveGeneration: async () => 7,
            targetActionInvocations: createActionFormTargetInvocationRuntime({
                isCurrent: () => current,
            }),
            listActionFormConnectedAccountOptions,
        });

        await expect(handler({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.action-form/run',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({ ok: false, code: 'plugin_generation_stale' });
        expect(listActionFormConnectedAccountOptions).toHaveBeenCalledOnce();
    });

    it('stamps projection entries from the current lease materialization, not merely its machine', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        const registry = createResolvedContributionRegistry({
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [],
            materializationIdsByPluginId: { 'acme.materialized': 'materialization-b' },
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'renderer' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Materialized' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'overview' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'overview',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Overview',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const { handlers, registrar } = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_projection_fixture',
                machineId: 'machine_projection_fixture',
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const raw = await handler!({ machineId: 'machine_projection_fixture' });

        expect(raw).toMatchObject({
            projection: {
                familiesById: {
                    pluginUi: {
                        entriesById: {
                            'surfacePlacement:acme.materialized:overview': {
                                serverIdentityId: 'srv_projection_fixture',
                                materializationRef: {
                                    machineId: 'machine_projection_fixture',
                                    materializationId: 'materialization-b',
                                    pluginId: 'acme.materialized',
                                },
                            },
                        },
                    },
                },
            },
        });
    });

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

    it('reads a packaged plugin UI resource through the leased per-plugin resource owner', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        const readUiResource = vi.fn(async (params: Readonly<{
            expectedGeneration: string;
            callerPluginId: string;
            resourceId: string;
        }>) => {
            if (params.resourceId !== 'preview-icon') {
                throw new PluginError({
                    code: 'plugin_resource_not_found',
                    message: 'Resource is not declared for this plugin',
                });
            }
            return {
                kind: 'asset' as const,
                contentType: 'image/png',
                digest: `sha256:${'a'.repeat(64)}`,
                bytes: new Uint8Array([1, 2, 3]),
            };
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
            readUiResource,
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ);
        expect(handler).toEqual(expect.any(Function));

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'preview-icon' },
        })).resolves.toMatchObject({
            ok: true,
            kind: 'asset',
            contentType: 'image/png',
            bytesBase64: 'AQID',
        });
        expect(readUiResource).toHaveBeenCalledWith(expect.objectContaining({
            callerPluginId: 'acme.preview',
            resourceId: 'preview-icon',
            expectedGeneration: '7',
        }));

        // A reference naming another plugin never reaches the resource owner:
        // the service binds per plugin, so it is not declared for this caller.
        readUiResource.mockClear();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'other.plugin', localId: 'preview-icon' },
        })).resolves.toMatchObject({ ok: false, code: 'plugin_resource_not_found', reason: 'not_found' });
        expect(readUiResource).not.toHaveBeenCalled();

        // An undeclared resource for the owning plugin still fails through the
        // same taxonomy — the rejection above is not "cross-plugin is special".
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'not-declared' },
        })).resolves.toMatchObject({ ok: false, code: 'plugin_resource_not_found', reason: 'not_found' });

        // A stale generation is refused before any read.
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '6',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'preview-icon' },
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
    });

    it('uses public Resource-read currentness and translates to the retained activation generation', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        let projectionGeneration = 7;
        let advanceProjectionAfterRead = false;
        const readUiResource = vi.fn(async (params: Readonly<{
            expectedGeneration: string;
            callerPluginId: string;
            resourceId: string;
        }>) => {
            // The retained Resource owner is activation generation 8 while
            // the public projection is generation 7. Its private contract
            // must receive the activation generation, not the public stamp.
            if (params.expectedGeneration !== '8') {
                throw new PluginError({
                    code: 'plugin_generation_stale',
                    message: 'Plugin generation is stale',
                });
            }
            if (advanceProjectionAfterRead) projectionGeneration = 8;
            return {
                kind: 'asset' as const,
                contentType: 'image/png',
                digest: `sha256:${'a'.repeat(64)}`,
                bytes: new Uint8Array([1, 2, 3]),
            };
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 8,
            readUiResource,
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => projectionGeneration,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'preview-icon' },
        })).resolves.toMatchObject({
            ok: true,
            kind: 'asset',
            bytesBase64: 'AQID',
        });
        expect(readUiResource).toHaveBeenCalledWith(expect.objectContaining({
            expectedGeneration: '8',
        }));

        advanceProjectionAfterRead = true;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'preview-icon' },
        })).resolves.toMatchObject({
            ok: false,
            code: 'plugin_generation_stale',
            reason: 'stale_generation',
        });

        readUiResource.mockClear();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'preview-icon' },
        })).resolves.toMatchObject({
            ok: false,
            code: 'plugin_generation_stale',
            reason: 'stale_generation',
        });
        expect(readUiResource).not.toHaveBeenCalled();
    });

    it('searches one current composer-reference provider through the leased registration owner', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        let projectionGeneration = 7;
        let advanceProjectionAfterSearch = false;
        const search = vi.fn(async (input: Readonly<{
            reference: Readonly<{ pluginId: string; localId: string }>;
            query: string;
            trigger: '$' | '@' | '/';
            signal: AbortSignal;
        }>) => {
            if (advanceProjectionAfterSearch) projectionGeneration = 8;
            return [{ id: 'issue:42', label: 'Issue 42', description: 'Open incident' }];
        });
        let runtimeGeneration = 7;
        let composerReferences: ResolvedExecutablePluginRuntimeRegistry['composerReferences'] = {
            list: () => [{ pluginId: 'acme.issues', localId: 'issues' }],
            search,
            resolve: vi.fn(),
        };
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            get generation() {
                return runtimeGeneration;
            },
            get composerReferences() {
                return composerReferences;
            },
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => projectionGeneration,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH);
        expect(handler).toEqual(expect.any(Function));

        const signal = new AbortController().signal;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'e\u0301',
        }, { signal })).resolves.toEqual({
            ok: true,
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            page: [{ id: 'issue:42', label: 'Issue 42', description: 'Open incident' }],
        });
        expect(search).toHaveBeenCalledWith({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            query: 'é',
            trigger: '$',
            signal,
        });

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            query: 'issue',
        }, { signal })).resolves.toMatchObject({ ok: true });
        expect(search).toHaveBeenLastCalledWith({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            query: 'issue',
            trigger: '@',
            signal,
        });
        expect(search).toHaveBeenCalledTimes(2);

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            provider: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'issue',
        })).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
        expect(search).toHaveBeenCalledTimes(2);

        search.mockClear();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '6',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'issue',
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(search).not.toHaveBeenCalled();

        // A retained activation generation is private to the lease. A current
        // public projection call remains valid after an unrelated peer update.
        runtimeGeneration = 8;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'issue',
        })).resolves.toMatchObject({ ok: true });
        expect(search).toHaveBeenCalledOnce();

        advanceProjectionAfterSearch = true;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'peer-update',
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(search).toHaveBeenCalledTimes(2);

        projectionGeneration = 7;
        runtimeGeneration = 7;
        composerReferences = undefined;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            trigger: '$',
            query: 'issue',
        })).resolves.toMatchObject({ ok: false, code: 'composer_reference_unavailable', reason: 'unavailable' });
    });

    it('prepares one current Composer attachment through the leased runtime owner without a terminal Message identity', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        let projectionGeneration = 7;
        let advanceProjectionAfterPrepare = false;
        function admit(input: Readonly<{
            phase: 'draft';
            attachments: readonly ComposerAttachmentDraftV1[];
        }>): readonly ComposerAttachmentDraftV1[];
        function admit(input: Readonly<{
            phase: 'prepared';
            attachments: readonly ComposerAttachmentInputV1[];
        }>): readonly ComposerAttachmentInputV1[];
        function admit(input:
            | Readonly<{ phase: 'draft'; attachments: readonly ComposerAttachmentDraftV1[] }>
            | Readonly<{ phase: 'prepared'; attachments: readonly ComposerAttachmentInputV1[] }>,
        ): readonly ComposerAttachmentDraftV1[] | readonly ComposerAttachmentInputV1[] {
            return input.attachments;
        }
        const prepareForSend = vi.fn(async (input: Readonly<{
            attachment: Readonly<{ pluginId: string; localId: string }>;
            request: Readonly<{
                sessionId: string;
                localId: string;
                attachments: readonly Readonly<{
                    instanceId: string;
                    key: string;
                    value: unknown;
                }>[];
            }>;
            signal: AbortSignal;
        }>) => {
            if (advanceProjectionAfterPrepare) projectionGeneration = 8;
            return {
                attachments: input.request.attachments.map((attachment) => ({
                    instanceId: attachment.instanceId,
                    status: 'ready' as const,
                    value: { ...(attachment.value as Record<string, unknown>), prepared: true },
                })),
            };
        });
        let runtimeGeneration = 7;
        let composerAttachments: ResolvedExecutablePluginRuntimeRegistry['composerAttachments'] = {
            list: () => [{ pluginId: 'acme.issues', localId: 'issue-context' }],
            isDeclared: () => true,
            requires: () => true,
            supports: async () => true,
            admit,
            prepareForSend,
            resolveForDispatch: vi.fn(),
            afterMessageAccepted: vi.fn(),
        };
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            get generation() {
                return runtimeGeneration;
            },
            get composerAttachments() {
                return composerAttachments;
            },
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => projectionGeneration,
            resolveInstalledPackages: async () => [],
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE);
        expect(handler).toEqual(expect.any(Function));

        const signal = new AbortController().signal;
        const request = {
            sessionId: 'session-1',
            localId: 'local-1',
            attachments: [{ instanceId: 'attachment-1', key: 'issue-42', value: { issueId: '42' } }],
        };
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request,
        }, { signal })).resolves.toEqual({
            ok: true,
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            result: {
                attachments: [{
                    instanceId: 'attachment-1',
                    status: 'ready',
                    value: { issueId: '42', prepared: true },
                }],
            },
        });
        expect(prepareForSend).toHaveBeenCalledWith({
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request,
            signal,
        });

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request: { ...request, messageLocalId: 'local-1' },
        })).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
        expect(prepareForSend).toHaveBeenCalledTimes(1);

        runtimeGeneration = 8;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request,
        })).resolves.toMatchObject({ ok: true });
        expect(prepareForSend).toHaveBeenCalledTimes(2);

        advanceProjectionAfterPrepare = true;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request,
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(prepareForSend).toHaveBeenCalledTimes(3);

        projectionGeneration = 7;
        runtimeGeneration = 7;
        composerAttachments = undefined;
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue-context' },
            request,
        })).resolves.toMatchObject({
            ok: false,
            code: 'composer_attachment_unavailable',
            reason: 'unavailable',
        });
    });

    it('carries a live resource invalidation over the watch triple and keeps its failures in one taxonomy', async () => {
        // The transport adapter's own decisions: a cross-plugin reference is
        // refused before the owner is asked, every owner failure lands in one
        // coarse reason vocabulary, and retirement is idempotent. The producing
        // vertical underneath is proven composed in
        // `resolveExecutablePluginRuntimeRegistry.dynamicResources.test.ts`.
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        let projectionGeneration = 5;
        let advanceProjectionAfterOpen = false;
        let advanceProjectionAfterPoll = false;
        const openUiResourceWatch = vi.fn<NonNullable<
            ResolvedExecutablePluginRuntimeRegistry['openUiResourceWatch']
        >>(async (params) => {
            if (params.expectedGeneration !== '1') {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'stale' });
            }
            if (params.resourceId !== 'live-status') {
                throw new PluginError({ code: 'plugin_resource_not_found', message: 'not declared' });
            }
            if (advanceProjectionAfterOpen) projectionGeneration = 6;
            return { subscriptionId: params.subscriptionId, digest: `sha256:${'b'.repeat(64)}` };
        });
        const pollUiResourceWatch = vi.fn<NonNullable<
            ResolvedExecutablePluginRuntimeRegistry['pollUiResourceWatch']
        >>(async (params) => {
            if (params.expectedGeneration !== '1') {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'stale' });
            }
            if (params.subscriptionId !== 'surface-1') {
                throw new PluginError({
                    code: 'plugin_resource_subscription_unknown',
                    message: 'not established',
                });
            }
            if (advanceProjectionAfterPoll) projectionGeneration = 6;
            return {
                status: 'event' as const,
                event: {
                    version: 1 as const,
                    subscriptionId: 'surface-1',
                    kind: 'invalidated' as const,
                    digest: `sha256:${'c'.repeat(64)}`,
                },
            };
        });
        const closeUiResourceWatch = vi.fn<NonNullable<
            ResolvedExecutablePluginRuntimeRegistry['closeUiResourceWatch']
        >>(() => true);
        const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 1,
            openUiResourceWatch,
            pollUiResourceWatch,
            closeUiResourceWatch,
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => projectionGeneration,
            resolveInstalledPackages: async () => [],
        });

        const open = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN);
        const next = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT);
        const close = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE);

        await expect(open?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
            resource: { pluginId: 'acme.preview', localId: 'live-status' },
        })).resolves.toMatchObject({
            ok: true,
            subscriptionId: 'surface-1',
            digest: `sha256:${'b'.repeat(64)}`,
        });

        // The signal carries a digest and no bytes: `readResource` stays the
        // single snapshot authority.
        await expect(next?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
        })).resolves.toEqual({
            ok: true,
            status: 'event',
            event: {
                version: 1,
                subscriptionId: 'surface-1',
                kind: 'invalidated',
                digest: `sha256:${'c'.repeat(64)}`,
            },
        });

        openUiResourceWatch.mockClear();
        await expect(open?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-2',
            resource: { pluginId: 'other.plugin', localId: 'live-status' },
        })).resolves.toMatchObject({ ok: false, code: 'plugin_resource_not_found', reason: 'not_found' });
        expect(openUiResourceWatch).not.toHaveBeenCalled();

        await expect(open?.({
            machineId: 'machine-1',
            expectedGeneration: '4',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-3',
            resource: { pluginId: 'acme.preview', localId: 'live-status' },
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(openUiResourceWatch).not.toHaveBeenCalled();

        pollUiResourceWatch.mockClear();
        await expect(next?.({
            machineId: 'machine-1',
            expectedGeneration: '4',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(pollUiResourceWatch).not.toHaveBeenCalled();

        await expect(next?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'never-opened',
        })).resolves.toMatchObject({ ok: false, reason: 'unknown_subscription' });

        // A poll budget outside the protocol bounds is a client mistake, not an
        // instruction to park for an arbitrary time.
        await expect(next?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
            waitMs: 10,
        })).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });

        advanceProjectionAfterOpen = true;
        openUiResourceWatch.mockClear();
        await expect(open?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-after-peer-update',
            resource: { pluginId: 'acme.preview', localId: 'live-status' },
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(openUiResourceWatch).toHaveBeenCalledWith(expect.objectContaining({
            expectedGeneration: '1',
        }));

        projectionGeneration = 5;
        advanceProjectionAfterOpen = false;
        advanceProjectionAfterPoll = true;
        pollUiResourceWatch.mockClear();
        await expect(next?.({
            machineId: 'machine-1',
            expectedGeneration: '5',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
        })).resolves.toMatchObject({ ok: false, reason: 'stale_generation' });
        expect(pollUiResourceWatch).toHaveBeenCalledWith(expect.objectContaining({
            expectedGeneration: '1',
        }));

        await expect(close?.({
            machineId: 'machine-1',
            callerPluginId: 'acme.preview',
            subscriptionId: 'surface-1',
        })).resolves.toEqual({ ok: true, closed: true });
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
                    placementBindings: ['commandPalette'],
                    dangerLevel: 'safe',
                    execution: { target: 'daemon' },
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
                registration: 'required',
                consumer: 'action-dispatch',
                platforms: ['cli'],
            }],
        });
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
            executionSurface: 'ui',
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_generation_stale',
        });
    });

    it('observes the normal tracked daemon Action invocation with stable request correlation', async () => {
        const trackedAction = createStructuredActionFixture({
            id: 'publish',
            placementBindings: [],
            operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
        });
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            actions: [trackedAction],
            immutableGenerationIdsByPluginId: {
                'acme.preview': 'contributor-generation-current',
            },
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        const observePluginExecution = vi.fn(async ({ execute }) => await execute({
            signal: new AbortController().signal,
            operationProgress: { update: vi.fn() },
        }));
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            observePluginExecution,
        });
        const run = vi.fn(async () => ({ ok: true, result: { published: true } }));
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockImplementationOnce(async (params) => {
            params.context.capturePreparedInvocation({ run });
            return { matched: true, result: { ok: true, result: null } };
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const signal = new AbortController().signal;
        const request = {
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            expectedContributorImmutableGenerationId: 'contributor-generation-current',
            requestId: 'request-1',
        } as const;

        await expect(handler?.(request, { signal })).resolves.toEqual({
            ok: true,
            result: { published: true },
        });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(observePluginExecution).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'acme.preview/publish',
            requestId: 'request-1',
        }));
    });

    it('forwards operation progress only through the host-local execution context', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        const operationProgress = { update: vi.fn() };
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValueOnce({
            matched: true,
            result: { ok: true, result: { published: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const signal = new AbortController().signal;

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
        }, { signal, localActionContext: { operationProgress } })).resolves.toEqual({
            ok: true,
            result: { published: true },
        });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({ operationProgress }),
        }));
    });

    // UI-D26: the execution surface decides target-action authorization
    // (`evaluateTargetActionPolicy` compares it against the action's declared
    // `surfaces`). An omitted field previously defaulted to `'agent'` — a value
    // the wire enum cannot even express — which BOTH denied `surfaces:['ui']`
    // actions and falsely admitted agent-only ones. The front door now requires
    // the caller to state its surface; there is nothing left to default.
    it('rejects a structured-message action request that states no execution surface', async () => {
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

        executePluginActionIfAvailableMock.mockClear();
        // Queued so a request that WRONGLY reaches the executor settles instead of
        // throwing: the failure then reports the real defect (the executor was
        // reached, on a fabricated surface) rather than a mock artefact.
        executePluginActionIfAvailableMock.mockResolvedValueOnce({
            matched: true,
            result: { ok: true, result: { opened: true } },
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_structured_message_action_request_invalid',
        });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();
    });

    it('requires matching host-presented arms for semantic Composer and Message Actions without fabricating callers, while retaining legacy routes', async () => {
        const hybrid = createStructuredActionFixture({
            id: 'hybrid',
            placementBindings: ['commandPalette', 'composer.primary', 'message.menu'],
        });
        const composerOnly = createStructuredActionFixture({
            id: 'composer-only',
            placementBindings: ['composer.more'],
        });
        const messageOnly = createStructuredActionFixture({
            id: 'message-only',
            placementBindings: ['message.menu'],
        });
        const multiComposer = createStructuredActionFixture({
            id: 'multi-composer',
            placementBindings: ['composer.primary', 'composer.slash'],
        });
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            actions: [hybrid, composerOnly, messageOnly, multiComposer],
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        const reference = {
            v: 1 as const,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'message-updated-at:1',
        };
        const messageSnapshot = {
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'message-updated-at:1',
            role: 'agent' as const,
            contentCategory: 'text' as const,
            seq: 7,
            visibleText: 'Current message text',
            structuredPresentationSummary: null,
            provenanceCategory: 'owner' as const,
        };
        const resolveMessageActionReference = vi.fn(async (): Promise<MessageActionResolutionV1> => ({
            status: 'available',
            snapshot: messageSnapshot,
        }));
        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({
            status: 'approved' as const,
            fingerprint,
        }));
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { opened: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolveMessageActionReference,
            requestCurrentIntent,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/hybrid',
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: true, result: { opened: true } });
        const legacyExecution = executePluginActionIfAvailableMock.mock.calls[0]?.[0];
        expect(legacyExecution).toEqual(expect.objectContaining({
            requestCurrentIntent,
            context: { surface: 'ui', invocationSurface: 'ui' },
        }));
        expect(legacyExecution?.context).not.toHaveProperty('caller');

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/composer-only',
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: false, code: 'plugin_action_unavailable' });
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/hybrid',
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: 'session-1' },
                    revision: 4,
                },
                mountedBinding: {
                    contributionLocalId: 'not-a-host-presented-caller',
                },
            },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_structured_message_action_request_invalid',
        });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledTimes(1);

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/hybrid',
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: 'session-1' },
                    revision: 4,
                },
            },
        })).resolves.toEqual({ ok: true, result: { opened: true } });
        const composerExecution = executePluginActionIfAvailableMock.mock.calls[1]?.[0];
        expect(composerExecution).toEqual(expect.objectContaining({
            requestCurrentIntent,
            context: { surface: 'ui', invocationSurface: 'ui', defaultSessionId: 'session-1' },
        }));
        expect(composerExecution?.context).not.toHaveProperty('caller');

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/hybrid',
            sessionId: 'session-1',
            messageActionReference: reference,
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: true, result: { opened: true } });
        const legacyMessageExecution = executePluginActionIfAvailableMock.mock.calls[2]?.[0];
        expect(legacyMessageExecution).toEqual(expect.objectContaining({
            requestCurrentIntent,
            context: expect.objectContaining({
                surface: 'ui',
                invocationSurface: 'ui',
                defaultSessionId: 'session-1',
                messageAction: messageSnapshot,
            }),
        }));
        expect(legacyMessageExecution?.context).not.toHaveProperty('caller');

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/hybrid',
            sessionId: 'session-1',
            messageActionReference: reference,
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: reference,
            },
        })).resolves.toEqual({ ok: true, result: { opened: true } });
        const messageExecution = executePluginActionIfAvailableMock.mock.calls[3]?.[0];
        expect(messageExecution).toEqual(expect.objectContaining({
            requestCurrentIntent,
            context: expect.objectContaining({
                surface: 'ui',
                invocationSurface: 'ui',
                defaultSessionId: 'session-1',
                messageAction: messageSnapshot,
            }),
        }));
        expect(messageExecution?.context).not.toHaveProperty('caller');
        expect(resolveMessageActionReference).toHaveBeenCalledTimes(2);

        executePluginActionIfAvailableMock.mockClear();
        resolveMessageActionReference.mockClear();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/message-only',
            sessionId: 'session-1',
            messageActionReference: reference,
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: false, code: 'plugin_action_unavailable' });
        expect(resolveMessageActionReference).not.toHaveBeenCalled();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/message-only',
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: 'session-1' },
                    revision: 4,
                },
            },
        })).resolves.toEqual({ ok: false, code: 'plugin_action_unavailable' });
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/composer-only',
            sessionId: 'session-1',
            messageActionReference: reference,
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: reference,
            },
        })).resolves.toEqual({ ok: false, code: 'plugin_action_unavailable' });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();

        // The exact Composer placement set is an allowlist, not a cardinality
        // limit: an Action may be presented at more than one Composer control
        // without a second selected-placement carrier on this RPC.
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/multi-composer',
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: 'session-1' },
                    revision: 4,
                },
            },
        })).resolves.toEqual({ ok: true, result: { opened: true } });
        const multiComposerExecution = executePluginActionIfAvailableMock.mock.calls[0]?.[0];
        expect(multiComposerExecution).toEqual(expect.objectContaining({
            requestCurrentIntent,
            context: { surface: 'ui', invocationSurface: 'ui', defaultSessionId: 'session-1' },
        }));
        expect(multiComposerExecution?.context).not.toHaveProperty('caller');
    });

    it('forwards omitted action input as absence and explicit null unchanged to the canonical executor', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
        };
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { applied: true } },
        });
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
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: true, result: { applied: true } });
        const omitted = executePluginActionIfAvailableMock.mock.calls[0]?.[0] as Readonly<Record<string, unknown>> | undefined;
        expect(omitted).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(omitted, 'input')).toBe(false);

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: null,
            executionSurface: 'ui',
        })).resolves.toEqual({ ok: true, result: { applied: true } });
        const explicitNull = executePluginActionIfAvailableMock.mock.calls[1]?.[0] as Readonly<Record<string, unknown>> | undefined;
        expect(explicitNull).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(explicitNull, 'input')).toBe(true);
        expect(explicitNull?.input).toBeNull();
    });

    it.each(['cli', 'ui', 'voice'] as const)(
        'maps the wire execution surface to the canonical action executor invocation surface for %s',
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
                    invocationSurface: executionSurface,
                    defaultSessionId: 'session-1',
                    signal: operation.signal,
                },
            });
        },
    );

    it('forwards the host-stamped targeted contributor generation to the canonical action executor', async () => {
        const registry = createResolvedContributionRegistry({ agents: Object.freeze([]) });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValueOnce({
            matched: true,
            result: { ok: false, errorCode: 'plugin_action_generation_retired', error: 'retired' },
        });
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
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            executionSurface: 'ui',
            expectedContributorImmutableGenerationId: 'contributor-generation-a',
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_action_generation_retired',
        });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith({
            runtimeRegistry,
            actionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            expectedContributorImmutableGenerationId: 'contributor-generation-a',
            context: {
                surface: 'ui',
                invocationSurface: 'ui',
            },
        });
    });

    it('rejects raw caller JSON and derives a plugin target capability from the current mounted binding while retaining UI current-intent origin', async () => {
        let currentMachineId = 'machine-1';
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            actions: [createStructuredActionFixture({
                id: 'composer-only-action',
                placementBindings: ['composer.primary'],
            })],
            materializationIdsByPluginId: { 'acme.mounted': 'materialization-current' },
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.mounted',
                identity: { pluginId: 'acme.mounted', localId: 'dashboard' },
                manifestPath: '/plugins/acme.mounted/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({
            status: 'approved' as const,
            fingerprint,
        }));
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { published: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_action_fixture',
                machineId: currentMachineId,
            }),
            requestCurrentIntent,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/composer-only-action',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            // A modified authenticated client can send this arbitrary JSON. It
            // must never become an Action caller at the daemon boundary.
            caller: {
                kind: 'plugin',
                pluginId: 'acme.mounted',
                contributionLocalId: 'dashboard',
            },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_structured_message_action_request_invalid',
        });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            // A mounted plugin surface is a separate current, daemon-validated
            // producer. It remains legal to invoke an Action whose host
            // presentation placement is semantic Composer-only; only a
            // host-presented invocation needs the matching host arm.
            qualifiedActionId: 'acme.preview/composer-only-action',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        })).resolves.toEqual({ ok: true, result: { published: true } });

        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith({
            runtimeRegistry,
            actionId: 'acme.preview/composer-only-action',
            input: { title: 'Ready' },
            requestCurrentIntent,
            context: {
                surface: 'ui',
                invocationSurface: 'ui',
                caller: {
                    kind: 'plugin',
                    pluginId: 'acme.mounted',
                    contribution: {
                        id: 'dashboard',
                        qualifiedId: 'acme.mounted/dashboard',
                    },
                    materialization: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                    originSurface: 'ui',
                },
                isMountedCallerCurrent: expect.any(Function),
            },
        });
        const execution = executePluginActionIfAvailableMock.mock.calls[0]?.[0] as
            | Readonly<{
                context?: Readonly<{ isMountedCallerCurrent?: () => Promise<boolean> }>;
            }>
            | undefined;
        const isMountedCallerCurrent = execution?.context?.isMountedCallerCurrent;
        if (!isMountedCallerCurrent) throw new Error('expected mounted-caller revalidation callback');
        currentMachineId = 'machine-2';
        await expect(isMountedCallerCurrent()).resolves.toBe(false);
    });

    it('admits a selected settlement only from its exact current mounted UI caller before outer Action dispatch', async () => {
        const outerAction = (pluginId: string): ResolvedActionContribution => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            definition: {
                kindVersion: 1,
                id: 'connection/create',
                title: 'Create connection',
                description: null,
                safety: 'safe',
                dangerLevel: 'safe',
                execution: { target: 'daemon' },
                scopes: ['global'],
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: {
                    ui: false,
                    voice: false,
                    agent: false,
                    mcp: false,
                    cli: false,
                    rpc: false,
                    api: false,
                    plugin: true,
                },
                inputHints: null,
                inputSchema: { type: 'object', additionalProperties: false },
                outputSchema: {
                    type: 'object',
                    properties: { prepared: { type: 'boolean' } },
                    required: ['prepared'],
                    additionalProperties: false,
                },
                contributionSurfaces: ['plugin'],
            },
        });
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            actions: [outerAction('acme.mounted'), outerAction('acme.other')],
            materializationIdsByPluginId: { 'acme.mounted': 'materialization-current' },
            immutableGenerationIdsByPluginId: { 'acme.mounted': 'mounted-generation-a' },
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.mounted',
                identity: { pluginId: 'acme.mounted', localId: 'dashboard' },
                manifestPath: '/plugins/acme.mounted/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
            resolveCurrentPluginMaterializationRef: (pluginId: string) => (
                pluginId === 'acme.mounted'
                    ? {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId,
                    }
                    : null
            ),
        };
        const selectedActionInputCarrier = {
            operation: {
                point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
                contributor: {
                    pluginId: 'acme.provider',
                    contributionId: 'github',
                    immutableGenerationId: 'provider-generation-a',
                },
                role: 'setup',
                action: { pluginId: 'acme.provider', localId: 'connection/setup' },
            },
            result: {
                kind: 'submitted' as const,
                action: { pluginId: 'acme.provider', localId: 'connection/setup' },
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: {
                        pluginId: 'acme.mounted',
                        immutableGenerationId: 'mounted-generation-a',
                    },
                    point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
                    contributor: {
                        pluginId: 'acme.provider',
                        contributionId: 'github',
                        immutableGenerationId: 'provider-generation-a',
                    },
                },
                connectedAccount: {
                    kind: 'selected' as const,
                    fieldPath: 'credentialRef',
                    ref: {
                        service: { pluginId: 'acme.github', localId: 'github' },
                        accountId: 'account-a',
                    },
                },
            },
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_action_fixture',
                machineId: 'machine-1',
            }),
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        executePluginActionIfAvailableMock.mockReset();

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.mounted/connection/create',
            input: { kind: 'create' },
            executionSurface: 'ui',
            selectedActionInputCarrier: {
                ...selectedActionInputCarrier,
                result: {
                    ...selectedActionInputCarrier.result,
                    selection: {
                        ...selectedActionInputCarrier.result.selection,
                        target: {
                            ...selectedActionInputCarrier.result.selection.target,
                            immutableGenerationId: 'mounted-generation-stale',
                        },
                    },
                },
            },
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        })).resolves.toEqual({ ok: false, code: 'plugin_selected_action_input_unavailable' });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();

        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.other/connection/create',
            input: { kind: 'create' },
            executionSurface: 'ui',
            selectedActionInputCarrier,
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        })).resolves.toEqual({ ok: false, code: 'plugin_selected_action_input_unavailable' });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();

        executePluginActionIfAvailableMock.mockResolvedValueOnce({
            matched: true,
            result: { ok: true, result: { prepared: true } },
        });
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.mounted/connection/create',
            input: { kind: 'create' },
            executionSurface: 'ui',
            selectedActionInputCarrier,
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        })).resolves.toEqual({ ok: true, result: { prepared: true } });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({ selectedActionInputCarrier }),
        }));
    });

    it('rejects a retired mounted caller binding before target Action dispatch', async () => {
        executePluginActionIfAvailableMock.mockReset();
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            materializationIdsByPluginId: { 'acme.mounted': 'materialization-current' },
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.mounted',
                identity: { pluginId: 'acme.mounted', localId: 'dashboard' },
                manifestPath: '/plugins/acme.mounted/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_action_fixture',
                machineId: 'machine-1',
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.target/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-retired',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_mounted_caller_unavailable',
        });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();
    });

    it('does not dispatch a mounted caller after same-machine rematerialization while current intent is pending', async () => {
        let settleIntent: (value: Readonly<{ status: 'approved'; fingerprint: string }>) => void = () => {
            throw new Error('current intent has not been requested');
        };
        const targetHandler = vi.fn(async () => ({ published: true }));
        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{
                pluginId: 'acme.target',
                pluginVersion: '1.0.0',
                generation: '7',
                localId: 'publish',
                definition: {
                    id: 'publish',
                    dangerLevel: 'writesRemote',
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    inputSchema: {
                        type: 'object',
                        properties: { title: { type: 'string' } },
                        required: ['title'],
                        additionalProperties: false,
                    },
                    resultSchema: {
                        type: 'object',
                        properties: { published: { type: 'boolean' } },
                        required: ['published'],
                        additionalProperties: false,
                    },
                },
                handler: targetHandler,
            }],
            resolveAuthorizationFacts: (action) => ({
                packageTrust: {
                    packageIdentity: action.qualifiedId,
                    reviewedPackageIdentity: action.qualifiedId,
                },
                generation: {
                    targetGeneration: action.generation,
                    desiredGeneration: action.generation,
                    appliedGeneration: action.generation,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            resolveHostBinding: createTargetActionHostBindingResolver(),
            createServices: createUnavailablePluginServicesFactory(),
        });
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            materializationIdsByPluginId: { 'acme.mounted': 'materialization-current' },
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.mounted',
                identity: { pluginId: 'acme.mounted', localId: 'dashboard' },
                manifestPath: '/plugins/acme.mounted/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
            targetActionInvocations,
            retirePluginConsumers: () => {},
            resolveCurrentPluginMaterializationRef: (pluginId: string) => (
                pluginId === 'acme.mounted'
                    ? {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId,
                    }
                    : null
            ),
        };
        const replacementRuntimeRegistry = {
            ...createRuntimeRegistry({
                ...registry,
                materializationIdsByPluginId: { 'acme.mounted': 'materialization-replaced' },
            }),
            generation: 8,
            resolveCurrentPluginMaterializationRef: (pluginId: string) => (
                pluginId === 'acme.mounted'
                    ? {
                        machineId: 'machine-1',
                        materializationId: 'materialization-replaced',
                        pluginId,
                    }
                    : null
            ),
        };
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => runtimeRegistry,
        });
        const bootstrapLease = await controller.acquireRuntimeRegistry();
        await bootstrapLease.release();
        vi.resetModules();
        vi.doMock('@/plugins/runtime/reload/singleton', () => ({ pluginReloadController: controller }));
        const requestCurrentIntent = vi.fn(({ fingerprint }: Readonly<{ fingerprint: string }>) => (
            new Promise<Readonly<{ status: 'approved'; fingerprint: string }>>((resolve) => {
                settleIntent = resolve;
            })
        ));
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockImplementation(async (request) => {
            const targetResult = await targetActionInvocations.invoke({
                pluginId: 'acme.target',
                localId: 'publish',
                input: request.input,
                surface: request.context.caller?.kind === 'plugin'
                    ? 'plugin'
                    : request.context.surface ?? 'cli',
                ...(request.context.invocationSurface
                    ? { invocationSurface: request.context.invocationSurface }
                    : {}),
                ...(request.context.caller ? { caller: request.context.caller } : {}),
                ...(request.context.isMountedCallerCurrent
                    ? { isMountedCallerCurrent: request.context.isMountedCallerCurrent }
                    : {}),
                ...(request.requestCurrentIntent
                    ? { requestCurrentIntent: request.requestCurrentIntent }
                    : {}),
            });
            return targetResult.status === 'executed'
                ? { matched: true, result: { ok: true, result: targetResult.value } }
                : {
                    matched: true,
                    result: {
                        ok: false,
                        errorCode: targetResult.code,
                        error: targetResult.message,
                    },
                };
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        vi.doUnmock('@/plugins/runtime/reload/singleton');
        vi.resetModules();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_action_fixture',
                machineId: 'machine-1',
            }),
            requestCurrentIntent,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const pending = handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.target/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'dashboard',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.mounted',
                    },
                },
            },
        });
        if (!pending) throw new Error('expected structured action handler');

        await vi.waitFor(() => expect(requestCurrentIntent).toHaveBeenCalledOnce());
        await controller.adoptPreparedRuntimeRegistry({
            registry: replacementRuntimeRegistry,
            changedPluginIds: ['acme.mounted'],
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });
        const fingerprint = requestCurrentIntent.mock.calls[0]?.[0]?.fingerprint;
        if (typeof fingerprint !== 'string') throw new Error('expected current-intent fingerprint');
        settleIntent({ status: 'approved', fingerprint });

        await expect(pending).resolves.toEqual({
            ok: false,
            code: 'plugin_mounted_caller_unavailable',
        });
        expect(targetHandler).not.toHaveBeenCalled();
    });

    it('derives a plugin caller from an exact current mounted voice-provider binding', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            materializationIdsByPluginId: { 'acme.voice': 'materialization-current' },
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.voice',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'acme.voice', localId: 'conversation' },
                manifestPath: '/plugins/acme.voice/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme.voice',
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['web'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                        tools: { effectCalls: 'none' },
                    },
                    client: {
                        artifactId: 'voice-ui',
                        modulePath: './voice.js',
                        exportName: 'activate',
                    },
                },
            }],
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { published: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_voice_fixture',
                machineId: 'machine-1',
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.target/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'conversation',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.voice',
                    },
                },
            },
        })).resolves.toEqual({ ok: true, result: { published: true } });

        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({
                caller: expect.objectContaining({
                    kind: 'plugin',
                    pluginId: 'acme.voice',
                    contribution: {
                        id: 'conversation',
                        qualifiedId: 'acme.voice/conversation',
                    },
                    materialization: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.voice',
                    },
                }),
            }),
        }));
    });

    it('derives a plugin caller from an exact current mounted settings-page binding', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            materializationIdsByPluginId: { 'acme.settings': 'materialization-current' },
            uiSettingsPagesV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.settings',
                identity: { pluginId: 'acme.settings', localId: 'preferences' },
                manifestPath: '/plugins/acme.settings/.happier-plugin/plugin.json',
                definition: {
                    id: 'preferences',
                    group: { kind: 'host', id: 'general' },
                    title: 'Preferences',
                    defaultRank: 0,
                    renderer: 'settings-renderer',
                },
            }],
        });
        const runtimeRegistry = { ...createRuntimeRegistry(registry), generation: 7 };
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { published: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.target/publish',
            input: { title: 'Ready' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'preferences',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.settings',
                    },
                },
            },
        })).resolves.toEqual({ ok: true, result: { published: true } });

        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({
                caller: expect.objectContaining({
                    kind: 'plugin',
                    pluginId: 'acme.settings',
                    contribution: {
                        id: 'preferences',
                        qualifiedId: 'acme.settings/preferences',
                    },
                    materialization: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-current',
                        pluginId: 'acme.settings',
                    },
                }),
            }),
        }));
    });

    it('resolves a whole-message action reference before dispatch and makes its Session snapshot authoritative', async () => {
        const registry = createResolvedContributionRegistry({
            agents: Object.freeze([]),
            actions: [createStructuredActionFixture({
                id: 'open-preview',
                placementBindings: ['message.menu'],
            })],
        });
        const runtimeRegistry = {
            ...createRuntimeRegistry(registry),
            generation: 7,
        };
        const reference = {
            v: 1 as const,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'message-updated-at:1',
        };
        const snapshot = Object.freeze({
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'message-updated-at:1',
            role: 'agent' as const,
            contentCategory: 'text' as const,
            seq: 7,
            visibleText: 'Current message text',
            structuredPresentationSummary: null,
            provenanceCategory: 'owner' as const,
        });
        const resolveMessageActionReference = vi.fn(async (): Promise<MessageActionResolutionV1> => ({
            status: 'available' as const,
            snapshot,
        }));
        executePluginActionIfAvailableMock.mockReset();
        executePluginActionIfAvailableMock.mockResolvedValue({
            matched: true,
            result: { ok: true, result: { opened: true } },
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
            resolveInstalledPackages: async () => [],
            resolveMessageActionReference,
        } as never);

        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const operation = new AbortController();
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            messageActionReference: reference,
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: reference,
            },
        }, { signal: operation.signal })).resolves.toEqual({
            ok: true,
            result: { opened: true },
        });
        expect(resolveMessageActionReference).toHaveBeenCalledWith({
            reference,
            signal: operation.signal,
        });
        expect(executePluginActionIfAvailableMock).toHaveBeenCalledWith({
            runtimeRegistry,
            actionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            context: {
                surface: 'ui',
                invocationSurface: 'ui',
                defaultSessionId: 'session-1',
                messageAction: snapshot,
                signal: operation.signal,
            },
        });

        executePluginActionIfAvailableMock.mockClear();
        resolveMessageActionReference.mockResolvedValueOnce({ status: 'stale' });
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            messageActionReference: reference,
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: reference,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_message_action_unavailable',
        });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();

        resolveMessageActionReference.mockResolvedValueOnce({
            status: 'available' as const,
            snapshot,
        });
        await expect(handler?.({
            machineId: 'machine-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            sessionId: 'different-session',
            messageActionReference: reference,
            executionSurface: 'ui',
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: reference,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'plugin_structured_message_action_request_invalid',
        });
        expect(executePluginActionIfAvailableMock).not.toHaveBeenCalled();
    });

    it('selects the declared daemon scope and redacts declared secret presence from UI snapshots', async () => {
        const { happyHomeDir, restore } = await createHappyHomeDirScopeForTest('happier-plugin-settings-rpc-');

        try {
            const registry = createResolvedContributionRegistry({
                agents: Object.freeze([]),
                                settings: Object.freeze([
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.hooks',
                        manifestPath: '/plugins/acme.hooks/plugin.json',
                        daemonEntryPath: '/plugins/acme.hooks/daemon.mjs',
                        definition: {
                            id: 'settings',
                            version: 1,
                            title: 'Acme settings',
                            target: { kind: 'plugin' },
                            scope: 'daemon',
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
                                    secret: { custody: 'daemon' },
                                },
                                {
                                    id: 'optional-token',
                                    title: 'Optional token',
                                    schema: { type: 'string' },
                                    secret: { custody: 'daemon' },
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
                    }).daemon,
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
            const deriveSecretKey = vi.fn(() => new Uint8Array(32).fill(7));
            const daemonSecretCustody = createDaemonPluginSecretCustodyRouter({
                paths: settingsPaths,
                resolveDeviceLocalSecretStorage: async () => ({ deriveSecretKey }),
            });
            const secretCustody = createPluginSecretCustodyRouter({
                daemon: daemonSecretCustody.resolve,
            });
            const daemonSecretAdministrationHost = createStableDeclaredPluginSecretsHost({
                declarations: [{
                    pluginId: 'acme.hooks',
                    declaration: { id: 'api-token', custody: 'daemon' },
                }, {
                    pluginId: 'acme.hooks',
                    declaration: { id: 'optional-token', custody: 'daemon' },
                }],
                resolveCustody: secretCustody.resolve,
            });
            let generationCurrent = true;
            const { handlers, registrar } = createRegistrar();
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                    createPluginSettingsService: ({ scope }) => (
                        scope.kind === 'daemon' ? stableSettingsService : null
                    ),
                    createPluginSecretsService: ({ pluginId, signal }) => (
                        pluginId === 'acme.hooks'
                            ? createDeclaredPluginSecretsService({
                                pluginId,
                                declarations: [
                                    { id: 'api-token', custody: 'daemon' },
                                    { id: 'optional-token', custody: 'daemon' },
                                ],
                                resolveCustody: secretCustody.resolve,
                                signal: signal ?? new AbortController().signal,
                                isGenerationCurrent: () => generationCurrent,
                                registerRawForRedaction: () => {},
                            })
                            : null
                    ),
                    createDaemonPluginSecretAdministrationPort: ({ pluginId, signal }) => (
                        pluginId === 'acme.hooks'
                            ? daemonSecretAdministrationHost.bindDaemonPluginSecretAdministrationPort({
                                pluginId,
                                signal: signal ?? new AbortController().signal,
                                isGenerationCurrent: () => generationCurrent,
                            })
                            : null
                    ),
                }),
                resolveGeneration: async () => 1,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_settings_fixture',
                    machineId: 'machine-1',
                }),
            });

            const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET);
            const getHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET);
            const secretStatusHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS);
            const secretDeleteHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE);
            expect(setHandler).toEqual(expect.any(Function));
            expect(getHandler).toEqual(expect.any(Function));
            expect(secretStatusHandler).toEqual(expect.any(Function));
            expect(secretDeleteHandler).toEqual(expect.any(Function));

            await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://api.example.test' },
            });
            await expect(setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'api-token',
                mutation: { kind: 'set', value: 'invalid' },
            })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_VALIDATION_FAILED' });
            await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'api-token',
                mutation: { kind: 'set', value: 'token-raw-secret' },
            });
            const safeConfiguredSecret = await secretStatusHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'api-token',
            });
            expect(safeConfiguredSecret).toMatchObject({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                secretId: 'api-token',
                state: 'configured',
                revision: expect.any(String),
            });
            expect(JSON.stringify(safeConfiguredSecret)).not.toContain('token-raw-secret');
            const staleSecretMutation = await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'api-token',
                mutation: { kind: 'set', value: 'token-must-not-replay' },
                expectedRevision: 'stale-secret-revision',
            });
            expect(staleSecretMutation).toMatchObject({
                status: 'conflict',
                snapshot: {
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    values: { endpoint: 'https://api.example.test' },
                    redactedKeys: ['api-token'],
                },
            });
            expect(JSON.stringify(staleSecretMutation)).not.toContain('token-must-not-replay');
            const safeConfiguredSecretAfterConflict = await secretStatusHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'api-token',
            });
            expect(safeConfiguredSecretAfterConflict).toEqual(safeConfiguredSecret);
            await expect(secretStatusHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'not-declared',
            })).rejects.toMatchObject({ code: 'plugin_secret_undeclared' });
            await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'enabled',
                mutation: { kind: 'set', value: false },
            });
            await expect(setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'not-declared',
                mutation: { kind: 'set', value: 'not visible' },
            })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_UNKNOWN_KEY' });

            const firstSnapshot = await getHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
            });
            expect(firstSnapshot).toMatchObject({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                revision: '2',
                values: {
                    endpoint: 'https://api.example.test',
                    enabled: false,
                },
                redactedKeys: ['api-token'],
            });
            expect(JSON.stringify(firstSnapshot)).not.toContain('token-raw-secret');

            const secondSnapshot = await getHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
            });
            expect(secondSnapshot).toMatchObject({
                values: {
                    endpoint: 'https://api.example.test',
                    enabled: false,
                },
                redactedKeys: ['api-token'],
            });
            await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'optional-token',
                mutation: { kind: 'set', value: '' },
            });
            const emptyStringSnapshot = await getHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
            });
            expect(emptyStringSnapshot).toMatchObject({ redactedKeys: ['api-token', 'optional-token'] });
            await setHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'optional-token',
                mutation: { kind: 'delete' },
            });
            const deletedSnapshot = await getHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
            });
            expect(deletedSnapshot).toMatchObject({ redactedKeys: ['api-token'] });
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const localSettings = await createPluginStorageOwner({
                pluginId: 'acme.hooks',
                paths,
            }).daemon.get<Record<string, unknown>>('settings');
            expect(JSON.stringify(localSettings)).not.toContain('token-raw-secret');
            expect(deriveSecretKey).toHaveBeenCalledWith({ purpose: 'plugin_secrets' });
            await expect(access(join(settingsPaths.secretsDir, 'plugin-secrets-key.v1'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
            const deletedSecret = await secretDeleteHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'api-token',
            });
            expect(deletedSecret).toMatchObject({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                secretId: 'api-token',
                state: 'missing',
                revision: expect.any(String),
            });
            generationCurrent = false;
            await expect(secretStatusHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'api-token',
            })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        } finally {
            await restore();
        }
    });

    it('routes an Account-declared origin-bound daemon secret through secret custody without a daemon Settings service', async () => {
        let configured = false;
        let revision = 'secret-r1:missing';
        const daemonSecretPort = Object.freeze({
            status: vi.fn(async () => Object.freeze({
                state: configured ? 'configured' as const : 'missing' as const,
                revision,
            })),
            set: vi.fn(async () => {
                configured = true;
                revision = 'secret-r1:configured';
                return Object.freeze({ revision });
            }),
            delete: vi.fn(async () => {
                configured = false;
                revision = 'secret-r1:missing-after-delete';
                return Object.freeze({ revision });
            }),
        });
        const registry = createResolvedContributionRegistry({
            settings: Object.freeze([{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.attached-service',
                definition: {
                    id: 'attached-service',
                    version: 1,
                    title: 'Attached service',
                    target: { kind: 'plugin' },
                    scope: 'account',
                    fields: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string' },
                    }, {
                        id: 'password',
                        title: 'Password',
                        schema: { type: 'string' },
                        secret: {
                            custody: 'daemon',
                            managedServiceOrigin: { endpointSettingId: 'endpoint' },
                        },
                    }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        const createPluginSettingsService = vi.fn();
        const createPluginSecretsService = vi.fn();
        const createDaemonPluginSecretAdministrationPort = vi.fn(() => daemonSecretPort);
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createPluginSettingsService,
                createPluginSecretsService,
                createDaemonPluginSecretAdministrationPort,
            }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        const statusHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS);
        const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SECRET_SET);
        expect(statusHandler).toEqual(expect.any(Function));
        expect(setHandler).toEqual(expect.any(Function));

        await expect(statusHandler?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.attached-service',
            secretId: 'password',
            canonicalOrigin: 'https://api.example.test',
        })).resolves.toMatchObject({ state: 'missing', revision: 'secret-r1:missing' });

        const setResult = await setHandler?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.attached-service',
            secretId: 'password',
            canonicalOrigin: 'https://api.example.test',
            value: 'must-not-return-over-the-secret-rpc',
            expectedRevision: 'secret-r1:missing',
        });
        expect(setResult).toMatchObject({ state: 'configured', revision: 'secret-r1:configured' });
        expect(JSON.stringify(setResult)).not.toContain('must-not-return-over-the-secret-rpc');
        expect(daemonSecretPort.set).toHaveBeenCalledWith(expect.objectContaining({
            secretId: 'password',
            canonicalOrigin: 'https://api.example.test',
            expectedRevision: 'secret-r1:missing',
        }));
        expect(createPluginSettingsService).not.toHaveBeenCalled();
        expect(createPluginSecretsService).not.toHaveBeenCalled();
    });

    it('releases each exact daemon Settings watch lease before a replacement registry reports an external revision', async () => {
        type SettingsListener = Parameters<ScopedSettingsService['watch']>[0];
        const registry = createResolvedContributionRegistry({
            settings: Object.freeze([{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.watch',
                definition: {
                    id: 'settings',
                    version: 1,
                    title: 'Settings',
                    target: { kind: 'plugin' },
                    scope: 'daemon',
                    fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        const createSettingsService = (revision: string) => {
            let listener: SettingsListener | null = null;
            const dispose = vi.fn();
            const watch = vi.fn<ScopedSettingsService['watch']>((next) => {
                listener = next;
                return { dispose };
            });
            const service: ScopedSettingsService = {
                async snapshot() {
                    return { scope: { kind: 'daemon' }, revision, values: { endpoint: 'private-value' } };
                },
                async get<T extends JsonValue = JsonValue>() {
                    return null as T | null;
                },
                async set() {
                    return { scope: { kind: 'daemon' }, revision };
                },
                async reset() {
                    return { scope: { kind: 'daemon' }, revision };
                },
                describe: () => [],
                watch,
            };
            return {
                service,
                watch,
                dispose,
                notify(change: Parameters<SettingsListener>[0]) {
                    listener?.(change);
                },
            };
        };
        const first = createSettingsService('settings-r1');
        const second = createSettingsService('settings-r1');
        const resolveRuntimeRegistry = vi.fn()
            .mockResolvedValueOnce(createRuntimeRegistry(registry, {
                createPluginSettingsService: () => first.service,
            }))
            .mockResolvedValueOnce(createRuntimeRegistry(registry, {
                createPluginSettingsService: () => second.service,
            }));
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry,
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
            }),
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH);
        if (!handler) throw new Error('Expected exact daemon Settings watch handler');

        await expect(handler({
            serverIdentityId: 'srv_settings_current',
            machineId: 'machine-1',
            pluginId: 'acme.watch',
            scope: { kind: 'daemon' },
        })).resolves.toEqual({ status: 'ready', revision: 'settings-r1' });
        expect(first.watch).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();

        const pending = handler({
            serverIdentityId: 'srv_settings_current',
            machineId: 'machine-1',
            pluginId: 'acme.watch',
            scope: { kind: 'daemon' },
            knownRevision: 'settings-r1',
        });
        await vi.waitFor(() => {
            expect(second.watch).toHaveBeenCalledOnce();
        });
        second.notify({
            scope: { kind: 'daemon' },
            revision: 'settings-r2',
            changedIds: ['endpoint'],
            values: { endpoint: 'must-not-cross-the-watch' },
        });

        const changed = await pending;
        expect(changed).toEqual({ status: 'changed', revision: 'settings-r2' });
        expect(JSON.stringify(changed)).not.toContain('must-not-cross-the-watch');
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(resolveRuntimeRegistry).toHaveBeenCalledTimes(2);
    });

    it.each([
        [
            RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' },
            },
        ],
        [
            RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' },
                fieldId: 'enabled',
                mutation: { kind: 'set', value: true },
            },
        ],
        [
            RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' },
            },
        ],
        [
            RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                secretId: 'api-token',
            },
        ],
        [
            RPC_METHODS.DAEMON_PLUGIN_SECRET_SET,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                secretId: 'api-token',
                value: 'must-not-reach-stale-custody',
            },
        ],
        [
            RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE,
            {
                serverIdentityId: 'srv_settings_stale',
                machineId: 'machine-1',
                pluginId: 'acme.settings',
                secretId: 'api-token',
            },
        ],
    ])('rejects a stale exact Settings target before %s can receive authority', async (method, request) => {
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(createResolvedContributionRegistry({})),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(method)?.(request)).rejects.toMatchObject({
            code: 'plugin_settings_target_not_current',
        });
    });

    it.each([
        {
            label: 'settings read',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                scope: { kind: 'daemon' },
            },
            delayedOperation: 'snapshot',
        },
        {
            label: 'settings mutation',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                scope: { kind: 'daemon' },
                fieldId: 'enabled',
                mutation: { kind: 'set', value: true },
            },
            delayedOperation: 'set',
        },
        {
            label: 'settings watch',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                scope: { kind: 'daemon' },
                // A different cursor lets the watch finish immediately after
                // its delayed canonical revision read, so the existing target
                // replacement assertion proves late status refusal.
                knownRevision: '0',
            },
            delayedOperation: 'snapshot',
        },
        {
            label: 'secret status',
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                secretId: 'token',
            },
            delayedOperation: 'status',
        },
        {
            label: 'secret creation',
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_SET,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                secretId: 'token',
                value: 'must-not-return-after-target-replacement',
            },
            delayedOperation: 'secretSet',
        },
        {
            label: 'secret deletion',
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE,
            request: {
                serverIdentityId: 'srv_settings_current',
                machineId: 'machine-1',
                pluginId: 'acme.currentness',
                secretId: 'token',
            },
            delayedOperation: 'delete',
        },
    ] as const)('fences a target replacement after an awaited $label owner effect', async ({
        method,
        request,
        delayedOperation,
    }) => {
        const targetA = {
            serverIdentityId: 'srv_settings_current',
            machineId: 'machine-1',
        } as const;
        const targetB = {
            serverIdentityId: 'srv_settings_replaced',
            machineId: 'machine-2',
        } as const;
        let currentTarget: Readonly<{ serverIdentityId: string; machineId: string }> = targetA;
        let releaseDelayedOperation!: () => void;
        const delayedOperationSettles = new Promise<void>((resolve) => {
            releaseDelayedOperation = resolve;
        });
        let signalDelayedOperationStarted!: () => void;
        const delayedOperationStarted = new Promise<void>((resolve) => {
            signalDelayedOperationStarted = resolve;
        });
        const awaitDelayedOperation = async (kind: typeof delayedOperation): Promise<void> => {
            if (kind !== delayedOperation) return;
            signalDelayedOperationStarted();
            await delayedOperationSettles;
        };
        const settings: ScopedSettingsService = {
            async snapshot() {
                await awaitDelayedOperation('snapshot');
                return {
                    scope: { kind: 'daemon' as const },
                    revision: '1',
                    values: {},
                };
            },
            async get<T extends JsonValue = JsonValue>() {
                return null as T | null;
            },
            async set(_id, _value, _options) {
                await awaitDelayedOperation('set');
                return { scope: { kind: 'daemon' as const }, revision: '2' };
            },
            async reset() {
                return { scope: { kind: 'daemon' as const }, revision: '2' };
            },
            describe: () => [],
            watch: () => ({ dispose() {} }),
        };
        const secrets: SecretsService = {
            async status() {
                await awaitDelayedOperation('status');
                return { state: 'missing', revision: '1' };
            },
            async get() {
                return '';
            },
            async set() {
                return { revision: '2' };
            },
            async delete() {
                await awaitDelayedOperation('delete');
                return { revision: '2' };
            },
        };
        const daemonSecretPort = {
            async status() {
                await awaitDelayedOperation('status');
                return { state: 'missing' as const, revision: '1' };
            },
            async set() {
                await awaitDelayedOperation('secretSet');
                return { revision: '2' };
            },
            async delete() {
                await awaitDelayedOperation('delete');
                return { revision: '2' };
            },
        };
        const registry = createResolvedContributionRegistry({
            settings: Object.freeze([{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.currentness',
                definition: {
                    id: 'settings',
                    version: 1,
                    title: 'Settings',
                    target: { kind: 'plugin' },
                    scope: 'daemon',
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createPluginSettingsService: ({ scope }) => (
                    scope.kind === 'daemon' ? settings : null
                ),
                createPluginSecretsService: () => secrets,
                createDaemonPluginSecretAdministrationPort: () => daemonSecretPort,
            }),
            resolvePluginProjectionExecutionOriginContext: async () => currentTarget,
        });

        const handler = handlers.get(method);
        if (!handler) throw new Error(`Expected ${method} handler`);
        const pending = handler(request);
        await delayedOperationStarted;
        currentTarget = targetB;
        releaseDelayedOperation();

        await expect(pending).rejects.toMatchObject({
            code: 'plugin_settings_target_not_current',
        });
    });

    it('fails closed when safe daemon-secret custody has no current runtime owner', async () => {
        const registry = createResolvedContributionRegistry({});
        const createDaemonPluginSecretAdministrationPort = vi.fn(() => null);
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createDaemonPluginSecretAdministrationPort,
            }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.unavailable',
            secretId: 'token',
        })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_SECRET_CUSTODY_UNAVAILABLE' });
        expect(createDaemonPluginSecretAdministrationPort).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.unavailable',
            signal: expect.any(AbortSignal),
        }));
    });

    it('keeps synthesized Account notification settings outside the selected-machine RPC', async () => {
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
        const createPluginSettingsService = vi.fn();
        const createPluginSecretsService = vi.fn();
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createPluginSettingsService,
                createPluginSecretsService,
            }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.notifications',
            scope: { kind: 'daemon' },
        })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE' });
        expect(createPluginSettingsService).not.toHaveBeenCalled();
        expect(createPluginSecretsService).not.toHaveBeenCalled();
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
                    scope: 'daemon',
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: true }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        let revision = 0;
        const values: Record<string, JsonValue> = {};
        const stableService: ScopedSettingsService = {
            async snapshot() {
                return {
                    scope: { kind: 'daemon' as const },
                    revision: String(revision),
                    values: { ...values },
                };
            },
            async get<T extends JsonValue = JsonValue>(id: string) {
                return Object.prototype.hasOwnProperty.call(values, id) ? values[id]! as T : null;
            },
            async set(id: string, value: JsonValue, options?: { expectedRevision?: string }) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== String(revision)) {
                    throw new PluginError({
                        code: 'plugin_settings_revision_conflict',
                        message: 'revision conflict',
                    });
                }
                values[id] = value;
                revision += 1;
                return { scope: { kind: 'daemon' as const }, revision: String(revision) };
            },
            async reset(id: string, options?: { expectedRevision?: string }) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== String(revision)) {
                    throw new PluginError({
                        code: 'plugin_settings_revision_conflict',
                        message: 'revision conflict',
                    });
                }
                delete values[id];
                revision += 1;
                return { scope: { kind: 'daemon' as const }, revision: String(revision) };
            },
            describe: () => [],
            watch: () => ({ dispose() {} }),
        };
        const { handlers, registrar } = createRegistrar();
        const requestSignals: Array<AbortSignal | undefined> = [];
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                createPluginSettingsService: ({ signal, scope }) => {
                    requestSignals.push(signal);
                    return scope.kind === 'daemon' ? stableService : null;
                },
            }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });
        const setHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET);
        const getHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET);

        const setController = new AbortController();
        await expect(setHandler?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.cas',
            scope: { kind: 'daemon' },
            fieldId: 'enabled',
            mutation: { kind: 'set', value: false },
            expectedRevision: '0',
        }, { signal: setController.signal })).resolves.toMatchObject({
            status: 'applied',
            snapshot: {
                revision: '1',
                values: { enabled: false },
            },
        });
        expect(requestSignals.at(-1)).not.toBe(setController.signal);
        expect(requestSignals.at(-1)?.aborted).toBe(true);
        expect(setController.signal.aborted).toBe(false);

        const requestControllers = Array.from({ length: 20 }, () => new AbortController());
        for (const controller of requestControllers) {
            await getHandler?.({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
                pluginId: 'acme.cas',
                scope: { kind: 'daemon' },
            }, { signal: controller.signal });
            expect(requestSignals.at(-1)).not.toBe(controller.signal);
            expect(requestSignals.at(-1)?.aborted).toBe(true);
            expect(controller.signal.aborted).toBe(false);
        }
        expect(requestSignals.slice(-20).every((signal) => signal?.aborted === true)).toBe(true);

        const abortedController = new AbortController();
        const cancellationReason = new Error('request cancelled');
        abortedController.abort(cancellationReason);
        await expect(getHandler?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.cas',
            scope: { kind: 'daemon' },
        }, { signal: abortedController.signal })).rejects.toBe(cancellationReason);
        expect(requestSignals).toHaveLength(21);

        await expect(setHandler?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.cas',
            scope: { kind: 'daemon' },
            fieldId: 'enabled',
            mutation: { kind: 'set', value: true },
            expectedRevision: '0',
        }, { signal: new AbortController().signal })).resolves.toMatchObject({
            status: 'conflict',
            snapshot: {
                revision: '1',
                values: { enabled: false },
            },
        });
    });

    it('rejects Account scope at the exact-daemon RPC instead of choosing a daemon as Account transport', async () => {
        const registry = createResolvedContributionRegistry({
            settings: Object.freeze([{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scopes',
                definition: {
                    id: 'account-settings',
                    version: 1,
                    title: 'Account settings',
                    target: { kind: 'plugin' },
                    scope: 'account',
                    fields: [{ id: 'account-enabled', title: 'Enabled', schema: { type: 'boolean' } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.scopes',
                definition: {
                    id: 'daemon-settings',
                    version: 1,
                    title: 'Daemon settings',
                    target: { kind: 'plugin' },
                    scope: 'daemon',
                    fields: [{ id: 'daemon-enabled', title: 'Enabled', schema: { type: 'boolean' } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        });
        const createPluginSettingsService = vi.fn();
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, { createPluginSettingsService }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.scopes',
            scope: { kind: 'account' },
        })).rejects.toMatchObject({ code: 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE' });
        expect(createPluginSettingsService).not.toHaveBeenCalled();
    });

    it('fails closed when daemon settings contributions reuse a field id', async () => {
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
                    scope: 'daemon' as const,
                    fields: [{ id: 'shared', title: 'Shared', schema: { type: 'string' as const } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }))),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.collision',
            scope: { kind: 'daemon' },
        })).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_FIELD_ID_CONFLICT',
            pluginId: 'acme.collision',
            contributionId: 'second',
            fieldId: 'shared',
        });
    });

    it('fails closed instead of falling back across declared Settings scopes', async () => {
        const registry = {
            ...createResolvedContributionRegistry({}),
            settings: Object.freeze([{
                provenance: 'external' as const,
                source: { kind: 'path' as const },
                pluginId: 'acme.scope-missing',
                definition: {
                    id: 'settings',
                    version: 1 as const,
                    title: 'Settings',
                    target: { kind: 'plugin' as const },
                    scope: 'daemon' as const,
                    fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' as const } }],
                    presentation: { sections: [], subagentSections: [] },
                },
            }]),
        };
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.scope-missing',
            scope: { kind: 'account' },
        })).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
            message: "Exact-daemon settings RPC does not serve Account scope for 'acme.scope-missing'",
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
                    scope: 'daemon' as const,
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
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_settings_fixture',
                machineId: 'machine-1',
            }),
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET)?.({
            serverIdentityId: 'srv_settings_fixture',
            machineId: 'machine-1',
            pluginId: 'acme.conditional',
            scope: { kind: 'daemon' },
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

    it('cold-initializes the authoritative runtime before projecting Composer surface declarations', async () => {
        const pluginId = 'acme.composer';
        const rendererId = 'summary-renderer';
        const regionId = 'summary';
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                identity: createPluginContributionIdentity({ pluginId, localId: rendererId }),
                manifestPath: '/plugins/acme.composer/.happier-plugin/plugin.json',
                definition: {
                    id: rendererId,
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Cold Composer summary' },
                },
            }],
            composerRegions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                identity: createPluginContributionIdentity({ pluginId, localId: regionId }),
                manifestPath: '/plugins/acme.composer/.happier-plugin/plugin.json',
                definition: {
                    id: regionId,
                    placement: 'beforeComposer',
                    renderer: { renderer: rendererId },
                },
            }],
            immutableGenerationIdsByPluginId: { [pluginId]: 'composer-generation' },
            materializationIdsByPluginId: { [pluginId]: 'composer-materialization' },
            activationTargets: [],
        });
        const getPluginUiResourceCapability = vi.fn(() => Object.freeze({ readable: true, dynamic: true }));
        const runtimeRegistry = createRuntimeRegistry(registry, {
            generation: 23,
            readAdmittedTargetedContributions: registry.readAdmittedTargetedContributions,
            getPluginUiResourceCapability,
        });
        const resolveRuntimeRegistry = vi.fn(async () => runtimeRegistry);
        const resolvePluginProjectionExecutionOriginContext = vi.fn(async () => ({
            serverIdentityId: 'srv_composer',
            machineId: 'machine-composer',
        }));
        const controller = createPluginReloadController({ resolveRuntimeRegistry });
        const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;
        process.env.HAPPIER_HOME_DIR = await mkdtemp(join(tmpdir(), 'happier-cold-composer-projection-'));

        vi.resetModules();
        vi.doMock('@/plugins/runtime/reload/singleton', () => ({ pluginReloadController: controller }));
        try {
            const configurationModule = await import('@/configuration');
            configurationModule.reloadConfiguration();
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache();
            const { handlers, registrar } = createRegistrar();
            projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveRegistry: async () => registry,
                resolveInstalledPackages: async () => [],
                resolveGeneration: async () => 23,
                resolvePluginProjectionExecutionOriginContext,
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            if (!handler) throw new Error('cold_composer_projection_handler_missing');

            const raw = await handler({ machineId: 'machine-composer' });

            expect(resolveRuntimeRegistry).toHaveBeenCalledExactlyOnceWith();
            expect(resolvePluginProjectionExecutionOriginContext).toHaveBeenCalledExactlyOnceWith();
            expect(getPluginUiResourceCapability).toHaveBeenCalledExactlyOnceWith(pluginId);
            expect(raw.composerSurfaceCatalog).toMatchObject([{
                contribution: { pluginId, localId: regionId },
                immutableGenerationId: 'composer-generation',
                projectionGeneration: 23,
                role: 'region',
                rendererChain: [{ pluginId, localId: rendererId }],
                selectedRenderer: {
                    identity: { pluginId, localId: rendererId },
                    renderer: {
                        kind: 'declarative',
                        contributionId: rendererId,
                    },
                    availability: { state: 'available', reason: 'available', diagnostics: [] },
                },
            }]);
        } finally {
            await controller.shutdown({ timeoutMs: 0 });
            if (previousHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;
            vi.doUnmock('@/plugins/runtime/reload/singleton');
            vi.resetModules();
        }
    });

    it('projects the current cold Event Automation composer snapshot without activating a plugin', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const registry = createResolvedContributionRegistry({
            agents: [],
            actions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.events',
                definition: {
                    kindVersion: 1,
                    id: 'configure-source',
                    title: 'Configure source',
                    description: 'Choose a repository',
                    safety: 'safe',
                    dangerLevel: 'safe',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    placements: [],
                    slash: null,
                    bindings: null,
                    examples: null,
                    surfaces: {
                        ui: false,
                        voice: false,
                        agent: false,
                        mcp: false,
                        cli: false,
                        rpc: false,
                        api: false,
                        plugin: true,
                    },
                    inputHints: null,
                    inputSchema: { type: 'object', additionalProperties: false },
                    outputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: [
                            'v',
                            'sourceInstanceId',
                            'sourceContractVersion',
                            'sourceConfig',
                            'displayLabel',
                        ],
                        properties: {
                            v: { type: 'integer', const: 1 },
                            sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
                            sourceContractVersion: { type: 'integer', const: 1 },
                            sourceConfig: { type: 'object', additionalProperties: false },
                            displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
                        },
                    },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.events',
                definition: {
                    kindVersion: 1,
                    id: 'baseline-history-gap',
                    title: 'Resume source',
                    description: 'Baseline the current source head',
                    safety: 'safe',
                    dangerLevel: 'writesLocal',
                    execution: { target: 'daemon' },
                    scopes: ['global'],
                    placements: [],
                    slash: null,
                    bindings: null,
                    examples: null,
                    surfaces: {
                        ui: false,
                        voice: false,
                        agent: false,
                        mcp: false,
                        cli: false,
                        rpc: false,
                        api: false,
                        plugin: true,
                    },
                    inputHints: null,
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { automationId: { type: 'string' } },
                        required: ['automationId'],
                    },
                    outputSchema: {
                        oneOf: [{
                            type: 'object',
                            additionalProperties: false,
                            properties: { kind: { type: 'string', const: 'baselined' } },
                            required: ['kind'],
                        }],
                    },
                },
            }],
            events: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.events',
                definition: {
                    id: 'acme.events/repository/updated',
                    localId: 'repository/updated',
                    kind: 'event',
                    title: 'Repository updated',
                    description: 'A repository changed',
                    payloadSchema: { type: 'object', additionalProperties: false },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: ['checkpointedPull'],
                            sourceConfigSchema: { type: 'object', additionalProperties: false },
                            setupActionRef: {
                                pluginId: 'acme.events',
                                localId: 'configure-source',
                            },
                            historyGapResetActionRef: {
                                pluginId: 'acme.events',
                                localId: 'baseline-history-gap',
                            },
                        },
                    },
                },
            }],
            immutableGenerationIdsByPluginId: {
                'acme.events': 'event-generation-a',
            },
        });
        const { handlers, registrar } = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => registry,
            resolveGeneration: async () => 11,
            resolveInstalledPackages: async () => [],
        });

        const raw = await handlers
            .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({ machineId: 'm1' });

        expect(raw).toMatchObject({
            protocolVersion: 1,
            automationEligibleEvents: [{
                event: {
                    id: 'acme.events/repository/updated',
                    identity: { pluginId: 'acme.events', localId: 'repository/updated' },
                    immutableGenerationId: 'event-generation-a',
                },
                setupAction: {
                    id: 'acme.events/configure-source',
                    identity: { pluginId: 'acme.events', localId: 'configure-source' },
                    immutableGenerationId: 'event-generation-a',
                },
                historyGapResetAction: {
                    id: 'acme.events/baseline-history-gap',
                    identity: { pluginId: 'acme.events', localId: 'baseline-history-gap' },
                    immutableGenerationId: 'event-generation-a',
                },
            }],
        });
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

    it('rejects a renderer graph as candidate Collection migration code when its signed artifact declaration has no migration module', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-migration-module-missing-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'react-native/panel/index.js';
        await mkdir(join(installedRoot, 'react-native', 'panel'), { recursive: true });
        const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        await writeFile(join(installedRoot, entryPath), entryBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
        ]);
        const artifactGraph = {
            contributionId: 'panel-artifact',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: entryPath,
            files: [{
                relativePath: entryPath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'repack' as const, version: '4.1.0' },
            repack: {
                containerName: 'panel',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
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
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'panel-renderer',
                    kind: 'reactNative',
                    artifact: 'panel-artifact',
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'runtime.plugin',
                identity: { pluginId: 'runtime.plugin', localId: 'panel' },
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                definition: {
                    id: 'panel',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'panel-renderer',
                    title: 'Panel',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });
        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 67,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
            reactNativeHostRuntime: {
                platform: 'ios',
                channel: 'internal',
                reactVersion: '19.2.0',
                reactNativeVersion: '0.83.4',
            },
        });
        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(projectionHandler).toBeDefined();
        expect(artifactBytesHandler).toBeDefined();
        const projection = await projectionHandler!({ machineId: 'm1' }) as {
            projection: {
                familiesById?: Record<string, {
                    entriesById?: Record<string, { runtime?: Record<string, unknown> }>;
                }>;
            };
        };
        const cacheIdentity = projection.projection.familiesById?.pluginUi?.entriesById
            ?.['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime?.cacheIdentity;
        expect(cacheIdentity).toMatchObject({ artifactDigest, projectionGeneration: 67 });

        await expect(artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'collectionMigrations',
            machineId: 'm1',
            cacheIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['generated_react_native_collection_migrations_module_missing'],
        });
    });

    it('serves an explicitly declared candidate Collection migration module after its renderer crash state is disabled', async () => {
        const { restore } = await createHappyHomeDirScopeForTest('happier-rn-candidate-migration-no-crash-state-');
        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;
            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-candidate-migration-module-'));
            const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
            const entryPath = 'react-native/panel/index.js';
            await mkdir(join(installedRoot, 'react-native', 'panel'), { recursive: true });
            const entryBytes = new TextEncoder().encode([
                'export function renderSurface() { return null; }',
                'export function collectionMigrations() { return {}; }',
            ].join('\n'));
            await writeFile(join(installedRoot, entryPath), entryBytes);
            const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
                { relativePath: entryPath, bytes: entryBytes },
            ]);
            const artifactGraph = {
                contributionId: 'panel-artifact',
                tier: 'reactNative' as const,
                platform: 'ios' as const,
                entry: entryPath,
                files: [{
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                }],
                digest: artifactDigest,
                builtWith: { bundler: 'repack' as const, version: '4.1.0' },
                repack: {
                    containerName: 'panel',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
                collectionMigrations: {
                    containerName: 'panel',
                    modulePath: './renderSurface',
                    exportName: 'collectionMigrations',
                },
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
                    pluginRootPath: pluginRoot,
                    generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                    definition: {
                        id: 'panel-renderer',
                        kind: 'reactNative',
                        artifact: 'panel-artifact',
                    },
                }],
                uiViewsV2: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'runtime.plugin',
                    identity: { pluginId: 'runtime.plugin', localId: 'panel' },
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    definition: {
                        id: 'panel',
                        container: 'appPage',
                        target: { kind: 'app' },
                        renderer: 'panel-renderer',
                        title: 'Panel',
                        instancePolicy: 'singleton',
                        headerActions: [],
                    },
                }],
            });
            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 68,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
                ...readyReactNativeBackendOpts,
                reactNativeHostRuntime: {
                    platform: 'ios',
                    channel: 'internal',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                },
            });
            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(projectionHandler).toBeDefined();
            expect(artifactBytesHandler).toBeDefined();
            expect(crashReportHandler).toBeDefined();

            const projection = await projectionHandler!({ machineId: 'm1' }) as {
                projection: {
                    familiesById?: Record<string, {
                        entriesById?: Record<string, {
                            runtime?: Record<string, unknown>;
                        }>;
                    }>;
                };
            };
            const entries = projection.projection.familiesById?.pluginUi?.entriesById ?? {};
            const cacheIdentity = entries['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime?.cacheIdentity;
            const crashState = entries['surfacePlacement:runtime.plugin:panel']?.runtime?.reactNativeCrashState as Readonly<{
                token: DaemonPluginReactNativeCrashBindingTokenV1;
                disabled: boolean;
            }> | undefined;
            expect(cacheIdentity).toMatchObject({ artifactDigest, projectionGeneration: 68 });
            expect(crashState).toMatchObject({ disabled: false });
            if (!crashState) throw new Error('Expected renderer crash state.');

            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashState.token,
                    failureOccurrenceId: '33333333-3333-4333-8333-333333333333',
                    failure: 'render_error',
                },
            })).resolves.toMatchObject({ ok: true, disabled: false });
            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashState.token,
                    failureOccurrenceId: '44444444-4444-4444-8444-444444444444',
                    failure: 'render_error',
                },
            })).resolves.toMatchObject({ ok: true, disabled: true });

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity,
                crashStateToken: crashState.token,
            })).resolves.toEqual({
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['crash_threshold_reached'],
            });
            const candidateResponse = await artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'collectionMigrations',
                machineId: 'm1',
                cacheIdentity,
            });
            expect(candidateResponse).toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'collectionMigrations',
                cacheIdentity,
            });
            expect(candidateResponse).not.toHaveProperty('crashStateToken');
        } finally {
            await restore();
        }
    });

    it('preserves static-artifact correlation but fails closed until the hosted-web frame adapter has an exact endpoint', async () => {
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
            service: {
                kind: 'staticAssets',
                assetRootId: 'hosted-web/preview-web',
            },
            artifactGraph: {
                contributionId: 'preview-web-static',
                tier: 'hostedWeb',
            },
            runtime: {
                state: 'fallback',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                decision: {
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                    diagnostics: ['hosted_web_frame_adapter_unavailable'],
                },
            },
        });
        expect(entry).not.toHaveProperty('runtimeMode');

        const readyProjectionRaw = await projectionHandler!({
            machineId: 'm1',
            hostedWebFrameCapability: {
                platform: 'web',
                adapter: 'domIframe',
            },
        });
        const readyEntry = (readyProjectionRaw as {
            projection: {
                familiesById?: Record<string, PluginUiProjectionFamily>;
            };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['hostedWeb:runtime.plugin:preview-web'];

        expect(readyEntry).toMatchObject({
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
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

    it('projects one current crash-state token per native destination and rechecks it before serving bytes', async () => {
        const {
            configuration: testConfiguration,
            restore,
        } = await createHappyHomeDirScopeForTest('happier-rn-crash-token-projection-');
        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-rn-crash-token-'));
            const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
            const entryPath = 'react-native/panel/index.js';
            await mkdir(join(installedRoot, 'react-native', 'panel'), { recursive: true });
            const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
            await writeFile(join(installedRoot, entryPath), entryBytes);
            const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
                { relativePath: entryPath, bytes: entryBytes },
            ]);
            const artifactGraph = {
                contributionId: 'panel-artifact',
                tier: 'reactNative' as const,
                platform: 'ios' as const,
                entry: entryPath,
                files: [{
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                }],
                digest: artifactDigest,
                builtWith: { bundler: 'repack' as const, version: '4.1.0' },
                repack: {
                    containerName: 'panel',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
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
                    pluginRootPath: pluginRoot,
                    generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                    definition: {
                        id: 'panel-renderer',
                        kind: 'reactNative',
                        artifact: 'panel-artifact',
                    },
                }],
                uiViewsV2: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'runtime.plugin',
                    identity: { pluginId: 'runtime.plugin', localId: 'panel' },
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    definition: {
                        id: 'panel',
                        // This native crash-state fixture runs against an iOS
                        // host; use an admitted cross-platform destination so
                        // the test reaches crash containment rather than the
                        // unrelated desktop-only details-tab gate.
                        container: 'appPage',
                        target: { kind: 'app' },
                        renderer: 'panel-renderer',
                        title: 'Panel',
                        instancePolicy: 'singleton',
                        headerActions: [],
                    },
                }],
            });

            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 64,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
                ...readyReactNativeBackendOpts,
            });
            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(projectionHandler).toBeDefined();
            expect(artifactBytesHandler).toBeDefined();
            expect(crashReportHandler).toBeDefined();

            type PluginUiEntry = Readonly<{ runtime?: Readonly<Record<string, unknown>>; availability?: unknown }>;
            const initialProjection = await projectionHandler!({ machineId: 'm1' }) as {
                projection: { familiesById?: Record<string, { entriesById?: Record<string, PluginUiEntry> }> };
            };
            const entries = initialProjection.projection.familiesById?.pluginUi?.entriesById ?? {};
            const bundleRuntime = entries['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime;
            const surfaceEntry = entries['surfacePlacement:runtime.plugin:panel'];
            const crashState = surfaceEntry?.runtime?.reactNativeCrashState as Readonly<{
                token: Readonly<Record<string, unknown>>;
                disabled: boolean;
            }> | undefined;

            expect(crashState).toEqual({
                token: {
                    mount: {
                        kind: 'destination',
                        destination: { pluginId: 'runtime.plugin', localId: 'panel' },
                    },
                    renderer: { pluginId: 'runtime.plugin', localId: 'panel-renderer' },
                    artifactDigest,
                    crashStateEpoch: 0,
                },
                disabled: false,
            });

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity: bundleRuntime?.cacheIdentity,
                crashStateToken: crashState?.token,
            })).resolves.toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                crashStateToken: crashState?.token,
            });

            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashState?.token,
                    failureOccurrenceId: '11111111-1111-4111-8111-111111111111',
                    failure: 'render_error',
                },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: true,
                token: crashState?.token,
                disabled: false,
            });
            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashState?.token,
                    failureOccurrenceId: '11111111-1111-4111-8111-111111111111',
                    failure: 'render_error',
                },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: true,
                token: crashState?.token,
                disabled: false,
            });
            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashState?.token,
                    failureOccurrenceId: '22222222-2222-4222-8222-222222222222',
                    failure: 'render_error',
                },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: true,
                token: crashState?.token,
                disabled: true,
            });

            const disabledProjection = await projectionHandler!({ machineId: 'm1' }) as {
                projection: { familiesById?: Record<string, { entriesById?: Record<string, PluginUiEntry> }> };
            };
            const disabledSurface = disabledProjection.projection.familiesById?.pluginUi
                ?.entriesById?.['surfacePlacement:runtime.plugin:panel'];
            expect(disabledSurface).toMatchObject({
                availability: {
                    state: 'disabled',
                    reason: 'crash_disabled',
                },
                runtime: {
                    reactNativeCrashState: {
                        token: crashState?.token,
                        disabled: true,
                    },
                },
            });

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity: bundleRuntime?.cacheIdentity,
                crashStateToken: crashState?.token,
            })).resolves.toEqual({
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['crash_threshold_reached'],
            });

            const resetResponse = await crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: { kind: 'reset', token: crashState?.token },
            });
            expect(resetResponse).toEqual({
                protocolVersion: 1,
                ok: true,
                token: {
                    ...crashState?.token,
                    crashStateEpoch: 1,
                },
                disabled: false,
            });
            const resetToken = (resetResponse as { token?: unknown }).token;
            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity: bundleRuntime?.cacheIdentity,
                crashStateToken: crashState?.token,
            })).resolves.toEqual({
                ok: false,
                code: 'crash_state_token_mismatch',
                diagnostics: ['react_native_crash_state_token_mismatch'],
            });
            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity: bundleRuntime?.cacheIdentity,
                crashStateToken: resetToken,
            })).resolves.toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                crashStateToken: resetToken,
            });
        } finally {
            await restore();
        }
    });

    it('serves bytes and crash report/reset only for the current Composer React Native binding', async () => {
        const { restore } = await createHappyHomeDirScopeForTest('happier-composer-rn-crash-token-');
        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

            const pluginId = 'runtime.composer';
            const immutableGenerationId = 'composer-generation-7';
            const rendererId = 'composer-renderer';
            const regionId = 'composer-region';
            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-composer-rn-crash-token-'));
            const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
            const entryPath = 'react-native/composer/index.js';
            await mkdir(join(installedRoot, 'react-native', 'composer'), { recursive: true });
            const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
            await writeFile(join(installedRoot, entryPath), entryBytes);
            const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
                { relativePath: entryPath, bytes: entryBytes },
            ]);
            const artifactGraph = {
                contributionId: 'composer-artifact',
                tier: 'reactNative' as const,
                platform: 'ios' as const,
                entry: entryPath,
                files: [{
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                }],
                digest: artifactDigest,
                builtWith: { bundler: 'repack' as const, version: '4.1.0' },
                repack: {
                    containerName: 'composer',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
                hostUiApiVersion: '1.0.0',
                compat: { react: '19.2.0', reactNative: '0.83.4' },
            };
            const registry = createResolvedContributionRegistry({
                agents: [],
                uiRenderersV2: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    identity: { pluginId, localId: rendererId },
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    pluginRootPath: pluginRoot,
                    generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                    definition: {
                        id: rendererId,
                        kind: 'reactNative',
                        artifact: 'composer-artifact',
                    },
                }],
                composerRegions: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    identity: { pluginId, localId: regionId },
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    definition: {
                        id: regionId,
                        placement: 'beforeComposer',
                        renderer: { renderer: rendererId },
                    },
                }],
                immutableGenerationIdsByPluginId: { [pluginId]: immutableGenerationId },
                materializationIdsByPluginId: { [pluginId]: 'composer-materialization' },
            });

            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 64,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
                resolvePluginProjectionExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_composer',
                    machineId: 'm1',
                }),
                ...readyReactNativeBackendOpts,
                reactNativeHostRuntime: {
                    platform: 'ios',
                    channel: 'internal',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                },
            });
            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(projectionHandler).toBeDefined();
            expect(artifactBytesHandler).toBeDefined();
            expect(crashReportHandler).toBeDefined();

            type ComposerSelectedRenderer = Readonly<{
                artifactProjection?: Readonly<{ runtime?: Readonly<{ cacheIdentity?: unknown }> }>;
                crashState?: Readonly<{
                    token: DaemonPluginReactNativeCrashBindingTokenV1;
                    disabled: boolean;
                }>;
            }>;
            const initialProjection = await projectionHandler!({ machineId: 'm1' }) as {
                composerSurfaceCatalog?: readonly Readonly<{ selectedRenderer: ComposerSelectedRenderer }>[];
            };
            const selectedRenderer = initialProjection.composerSurfaceCatalog?.[0]?.selectedRenderer;
            const cacheIdentity = selectedRenderer?.artifactProjection?.runtime?.cacheIdentity;
            const crashState = selectedRenderer?.crashState;

            expect(cacheIdentity).toMatchObject({
                pluginId,
                contributionId: rendererId,
                artifactDigest,
                projectionGeneration: 64,
            });
            expect(crashState).toEqual({
                token: {
                    mount: {
                        kind: 'composer',
                        contribution: { pluginId, localId: regionId },
                        immutableGenerationId,
                        role: 'region',
                    },
                    renderer: { pluginId, localId: rendererId },
                    artifactDigest,
                    crashStateEpoch: 0,
                },
                disabled: false,
            });
            if (!crashState || crashState.token.mount.kind !== 'composer') {
                throw new Error('Expected a current Composer crash token.');
            }
            const crashStateToken = crashState.token;

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity,
                crashStateToken,
            })).resolves.toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                crashStateToken,
            });

            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reportFailure',
                    token: crashStateToken,
                    failureOccurrenceId: '33333333-3333-4333-8333-333333333333',
                    failure: 'render_error',
                },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: true,
                token: crashStateToken,
                disabled: false,
            });

            const resetResponse = await crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: { kind: 'reset', token: crashStateToken },
            });
            expect(resetResponse).toEqual({
                protocolVersion: 1,
                ok: true,
                token: {
                    ...crashStateToken,
                    crashStateEpoch: 1,
                },
                disabled: false,
            });
            const resetToken = (resetResponse as {
                token?: DaemonPluginReactNativeCrashBindingTokenV1;
            }).token;
            if (!resetToken || resetToken.mount.kind !== 'composer') {
                throw new Error('Expected a current Composer reset token.');
            }

            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: { kind: 'reset', token: crashStateToken },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: false,
                code: 'binding_token_mismatch',
                diagnostics: ['react_native_crash_report_binding_token_mismatch'],
            });
            await expect(crashReportHandler!({
                protocolVersion: 1,
                machineId: 'm1',
                report: {
                    kind: 'reset',
                    token: {
                        ...resetToken,
                        mount: {
                            ...resetToken.mount,
                            role: 'attachmentPreview',
                        },
                    },
                },
            })).resolves.toEqual({
                protocolVersion: 1,
                ok: false,
                code: 'binding_token_mismatch',
                diagnostics: ['react_native_crash_report_binding_token_mismatch'],
            });

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity,
                crashStateToken: resetToken,
            })).resolves.toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                crashStateToken: resetToken,
            });
        } finally {
            await restore();
        }
    });

    async function setupGeneratedReactNativeWebRendererFixture(entryBytes: Uint8Array) {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-rnw-artifact-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'react-native/panel/index.js';
        const chunkPath = 'react-native/panel/chunk.js';
        await mkdir(join(installedRoot, 'react-native', 'panel'), { recursive: true });
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
            builtWith: {
                bundler: 'vite' as const,
                version: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.vite,
            },
            hostUiApiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion,
            compat: {
                react: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.react,
                reactNative: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative,
            },
        };
        const archiveLocator = '/plugin-archives/runtime.plugin.tgz';
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        const catalogManifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
            id: 'runtime.plugin',
            version: '1.0.0',
            displayName: 'Runtime Plugin',
            contributes: {
                ui: {
                    views: [{
                        id: 'panel',
                        container: 'detailsTab',
                        target: { kind: 'session' },
                        renderer: 'panel-renderer',
                        title: 'Panel',
                    }],
                    renderers: [{
                        id: 'panel-renderer',
                        kind: 'reactNative',
                        artifact: 'panel-artifact',
                    }],
                },
            },
        }));
        if (!catalogManifest) throw new Error('Expected archive catalog manifest to normalize');
        const archiveSource = {
            kind: 'archive' as const,
            locator: archiveLocator,
            trustPolicy: 'prompt' as const,
            installPolicy: 'managed_install' as const,
            resolvedPath: pluginRoot,
            manifestPath,
            resolvedVersion: '1.0.0',
        };
        const installedCatalogEntry = {
            pluginId: 'runtime.plugin',
            desiredGeneration: 'runtime-generation-51',
            appliedGeneration: 'runtime-generation-51',
            admittedIntegrity: 'sha256-runtime-plugin',
            title: 'Runtime Plugin',
            description: null,
            version: '1.0.0',
            enabled: true,
            source: archiveSource,
            install: {
                mode: 'managed_install',
                manifestVersion: '1.0.0',
                installedPath: pluginRoot,
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            manifestPath,
            manifest: catalogManifest,
            contributionIntrospection: projectPluginCatalogEntryIntrospection({
                pluginId: 'runtime.plugin',
                pluginVersion: '1.0.0',
                source: archiveSource,
                manifest: catalogManifest,
                generation: 51,
                host: 'cli',
                platform: process.platform,
                occurredAtMs: 0,
                diagnostics: [],
            }),
            diagnostics: [],
        } satisfies PluginCatalogEntry;
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'archive' },
                pluginId: 'runtime.plugin',
                identity: { pluginId: 'runtime.plugin', localId: 'panel-renderer' },
                manifestPath,
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'panel-renderer',
                    kind: 'reactNative',
                    artifact: 'panel-artifact',
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'archive' },
                pluginId: 'runtime.plugin',
                identity: { pluginId: 'runtime.plugin', localId: 'panel' },
                manifestPath,
                definition: {
                    id: 'panel',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'panel-renderer',
                    title: 'Panel',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 51,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveInstalledPackages: async () => [installedCatalogEntry],
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
        });
        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const reactNativeWebLoaderCapability = {
            integrated: true,
            installedArtifactLoaderAvailable: true,
        } as const;
        const projectionRaw = await projectionHandler!({
            machineId: 'm1',
            reactNativeWebLoaderCapability,
        });
        const parsedProjection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(projectionRaw);
        expect(parsedProjection).toMatchObject({
            projection: {
                installedPackagesById: {
                    'runtime.plugin': {
                        id: 'runtime.plugin',
                        enabled: true,
                        source: { kind: 'archive', locator: archiveLocator },
                    },
                },
            },
        });
        const runtime = (projectionRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, { runtime?: Record<string, unknown> }> }> };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime;
        const crashState = (projectionRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, { runtime?: Record<string, unknown> }> }> };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['surfacePlacement:runtime.plugin:panel']?.runtime?.reactNativeCrashState;
        expect(runtime).toMatchObject({
            state: 'loadable',
            cacheIdentity: { artifactDigest, platform: 'web', projectionGeneration: 51 },
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        return {
            artifactBytesHandler,
            runtime,
            crashState,
            artifactDigest,
            entryBytes,
            chunkBytes,
            entryPath,
            chunkPath,
            installedRoot,
            reactNativeWebLoaderCapability,
        };
    }

    it('serves a generated React Native Web renderer from its exact complete artifact graph', async () => {
        const {
            artifactBytesHandler,
            runtime,
            crashState,
            artifactDigest,
            entryBytes,
            chunkBytes,
            entryPath,
            chunkPath,
            installedRoot,
            reactNativeWebLoaderCapability,
        } = await setupGeneratedReactNativeWebRendererFixture(
            new TextEncoder().encode('export { renderSurface } from "./chunk.js";'),
        );

        const response = await artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: (crashState as { token?: unknown } | undefined)?.token,
            reactNativeWebLoaderCapability,
        });

        expect(response).toEqual({
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: (crashState as { token?: unknown } | undefined)?.token,
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
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: (crashState as { token?: unknown } | undefined)?.token,
            reactNativeWebLoaderCapability,
        })).toEqual({
            ok: false,
            code: 'artifact_integrity_failed',
            diagnostics: ['react_native_artifact_file_integrity_failed'],
        });
    });

    it('refuses to serve a generated React Native renderer whose verified entry is Hermes bytecode', async () => {
        // Hermes bytecode opens with the 64-bit little-endian magic
        // 0x1F1903C103BC1FC6. This graph is fully digest-valid and projects as
        // loadable: the only thing wrong with it is that the entry is Hermes VM
        // bytecode rather than loadable JavaScript, which is exactly what an
        // author who turns Hermes on in Re.Pack ships. The file name stays
        // `.js`, so a name-based heuristic cannot catch it.
        const {
            artifactBytesHandler,
            runtime,
            crashState,
            reactNativeWebLoaderCapability,
        } = await setupGeneratedReactNativeWebRendererFixture(new Uint8Array([
            0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
            0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]));

        expect(runtime).toMatchObject({ state: 'loadable' });
        expect(await artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: (crashState as { token?: unknown } | undefined)?.token,
            reactNativeWebLoaderCapability,
        })).toEqual({
            ok: false,
            code: 'unsupported_artifact_format',
            diagnostics: ['hermes_bytecode_unsupported'],
        });
    });

    it('serves a generated hosted-web renderer from its exact projected artifact graph', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-hosted-web-artifact-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'hosted-web/panel/index.html';
        const scriptPath = 'hosted-web/panel/assets/panel.js';
        await mkdir(join(installedRoot, 'hosted-web', 'panel', 'assets'), { recursive: true });
        const entryBytes = new TextEncoder().encode('<!doctype html><script type="module" src="./assets/panel.js"></script>');
        const scriptBytes = new TextEncoder().encode('document.body.textContent = "Hosted plugin";');
        await writeFile(join(installedRoot, entryPath), entryBytes);
        await writeFile(join(installedRoot, scriptPath), scriptBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
            { relativePath: scriptPath, bytes: scriptBytes },
        ]);
        const artifactGraph = {
            contributionId: 'panel-artifact',
            tier: 'hostedWeb' as const,
            platform: 'web' as const,
            entry: entryPath,
            files: [
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                },
                {
                    relativePath: scriptPath,
                    digest: computePluginUiArtifactSha256DigestV1(scriptBytes),
                    byteSize: scriptBytes.byteLength,
                },
            ],
            digest: artifactDigest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        };
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'runtime.plugin',
                identity: { pluginId: 'runtime.plugin', localId: 'hosted-renderer' },
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'hosted-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'panel-artifact' },
                },
            }],
        });

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 59,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveHostedWebFeatureDecision: async () => createEnabledHostedWebFeatureDecision(),
        });

        const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        const projectionRaw = await projectionHandler!({ machineId: 'm1' });
        const runtime = (projectionRaw as {
            projection: { familiesById?: Record<string, { entriesById?: Record<string, { runtime?: Record<string, unknown> }> }> };
        }).projection.familiesById?.pluginUi
            ?.entriesById?.['hostedWeb:runtime.plugin:hosted-renderer']?.runtime;
        expect(runtime).toMatchObject({
            state: 'fallback',
            artifactReadIdentity: {
                pluginId: 'runtime.plugin',
                contributionId: 'hosted-renderer',
                artifactDigest,
                platform: 'web',
                projectionGeneration: 59,
            },
        });

        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        await expect(artifactBytesHandler!({
            artifactFamily: 'hostedWeb',
            machineId: 'm1',
            cacheIdentity: {
                ...runtime?.artifactReadIdentity as Record<string, unknown>,
                projectionGeneration: 58,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['hosted_web_projection_generation_mismatch'],
        });
        await expect(artifactBytesHandler!({
            artifactFamily: 'hostedWeb',
            machineId: 'm1',
            cacheIdentity: runtime?.artifactReadIdentity,
        })).resolves.toEqual({
            ok: true,
            artifactFamily: 'hostedWeb',
            cacheIdentity: runtime?.artifactReadIdentity,
            artifact: {
                pluginId: 'runtime.plugin',
                contributionId: 'hosted-renderer',
                artifactKind: 'hostedWebAsset',
                digest: artifactDigest,
                byteSize: entryBytes.byteLength,
            },
            bytesBase64: Buffer.from(entryBytes).toString('base64'),
            files: [
                {
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                    bytesBase64: Buffer.from(entryBytes).toString('base64'),
                },
                {
                    relativePath: scriptPath,
                    digest: computePluginUiArtifactSha256DigestV1(scriptBytes),
                    byteSize: scriptBytes.byteLength,
                    bytesBase64: Buffer.from(scriptBytes).toString('base64'),
                },
            ],
        });

        await writeFile(join(installedRoot, scriptPath), new TextEncoder().encode('document.body.textContent = "tampered";'));
        await expect(artifactBytesHandler!({
            artifactFamily: 'hostedWeb',
            machineId: 'm1',
            cacheIdentity: runtime?.artifactReadIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_integrity_failed',
            diagnostics: ['hosted_web_artifact_file_integrity_failed'],
        });
    });

    it('rejects disabled or mismatched renderer tokens before reading the generated artifact graph', async () => {
        const {
            configuration: testConfiguration,
            happyHomeDir,
            restore,
        } = await createHappyHomeDirScopeForTest('happier-rn-crash-read-order-');
        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;
            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-rn-crash-read-order-artifact-'));
            const entryPath = 'react-native/panel/index.js';
            const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
            const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
                { relativePath: entryPath, bytes: entryBytes },
            ]);
            const artifactGraph = {
                contributionId: 'panel-artifact',
                tier: 'reactNative' as const,
                platform: 'ios' as const,
                entry: entryPath,
                files: [{
                    relativePath: entryPath,
                    digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                    byteSize: entryBytes.byteLength,
                }],
                digest: artifactDigest,
                builtWith: { bundler: 'repack' as const, version: '4.1.0' },
                repack: {
                    containerName: 'panel',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
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
                    pluginRootPath: pluginRoot,
                    generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                    definition: {
                        id: 'panel-renderer',
                        kind: 'reactNative',
                        artifact: 'panel-artifact',
                    },
                }],
                uiViewsV2: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'runtime.plugin',
                    identity: { pluginId: 'runtime.plugin', localId: 'panel' },
                    manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    definition: {
                        id: 'panel',
                        container: 'appPage',
                        target: { kind: 'app' },
                        renderer: 'panel-renderer',
                        title: 'Panel',
                        instancePolicy: 'singleton',
                        headerActions: [],
                    },
                }],
            });
            const { handlers, registrar } = createRegistrar();
            registerDaemonContributionRegistryProjectionHandler(registrar as never, {
                resolveGeneration: async () => 65,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
                ...readyReactNativeBackendOpts,
            });
            const projectionHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            const crashReportHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT);
            expect(projectionHandler).toBeDefined();
            expect(artifactBytesHandler).toBeDefined();
            expect(crashReportHandler).toBeDefined();

            const projectionRaw = await projectionHandler!({ machineId: 'm1' }) as {
                projection: {
                    familiesById?: Record<string, {
                        entriesById?: Record<string, { runtime?: Record<string, unknown> }>;
                    }>;
                };
            };
            const entries = projectionRaw.projection.familiesById?.pluginUi?.entriesById ?? {};
            const cacheIdentity = entries['reactNativeBundle:runtime.plugin:panel-renderer']?.runtime?.cacheIdentity;
            const crashState = entries['surfacePlacement:runtime.plugin:panel']?.runtime?.reactNativeCrashState as
                | Readonly<{
                    token: Readonly<{
                        mount: Readonly<{
                            kind: 'destination';
                            destination: Readonly<{ pluginId: string; localId: string }>;
                        }>;
                        renderer: Readonly<{ pluginId: string; localId: string }>;
                        artifactDigest: string;
                        crashStateEpoch: number;
                    }>;
                    disabled: boolean;
                }>
                | undefined;
            expect(cacheIdentity).toMatchObject({
                artifactDigest,
                projectionGeneration: 65,
            });
            expect(crashState).toMatchObject({
                token: {
                    artifactDigest,
                    crashStateEpoch: 0,
                },
                disabled: false,
            });
            if (!cacheIdentity || !crashState) throw new Error('expected renderer identity and crash state');

            for (const report of [
                { failureOccurrenceId: '33333333-3333-4333-8333-333333333333', failure: 'render_error' as const },
                { failureOccurrenceId: '44444444-4444-4444-8444-444444444444', failure: 'render_error' as const },
            ]) {
                await expect(crashReportHandler!({
                    protocolVersion: 1,
                    machineId: 'm1',
                    report: {
                        kind: 'reportFailure',
                        token: crashState.token,
                        ...report,
                    },
                })).resolves.toMatchObject({ ok: true });
            }

            const mismatchedToken = {
                ...crashState.token,
                crashStateEpoch: crashState.token.crashStateEpoch + 1,
            };
            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity,
                crashStateToken: mismatchedToken,
            })).resolves.toEqual({
                ok: false,
                code: 'crash_state_token_mismatch',
                diagnostics: ['react_native_crash_state_token_mismatch'],
            });
            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'm1',
                cacheIdentity,
                crashStateToken: crashState.token,
            })).resolves.toEqual({
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['crash_threshold_reached'],
            });

            const crashModule = await import('@/plugins/runtime/ui/reactNativeCrashDisableState');
            const crashStore = crashModule.createReactNativeCrashStateStore({ happyHomeDir });
            await expect(access(crashStore.stateFilePath)).resolves.toBeUndefined();
            expect(testConfiguration.happyHomeDir).toBe(happyHomeDir);
        } finally {
            await restore();
        }
    });

    it('serves generated Voice bytes without reconciling renderer crash persistence', async () => {
        const {
            configuration: testConfiguration,
            happyHomeDir,
            restore,
        } = await createHappyHomeDirScopeForTest('happier-voice-artifact-no-crash-state-');
        try {
            const projectionModule = await import('./daemonContributionRegistryProjection');
            projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
            const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;
            const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-voice-artifact-no-crash-state-files-'));
            const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
            const entryPath = 'react-native/voice-runtime-ios/index.js';
            await mkdir(join(installedRoot, 'react-native', 'voice-runtime-ios'), { recursive: true });
            const entryBytes = new TextEncoder().encode('export function activate() {}');
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
                    pluginRootPath: pluginRoot,
                    generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                    definition: {
                        id: 'conversation',
                        title: 'Conversation',
                        kind: 'conversation',
                        roles: ['realtime_conversation', 'turn_control'],
                        platforms: ['ios'],
                        capabilities: {
                            turn: { cancelResponse: true, bargeIn: false },
                            tools: { effectCalls: 'none' },
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
                resolveGeneration: async () => 66,
                resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
                resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
                ...readyReactNativeBackendOpts,
            });
            const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
            expect(artifactBytesHandler).toBeDefined();
            const crashModule = await import('@/plugins/runtime/ui/reactNativeCrashDisableState');
            const crashStore = crashModule.createReactNativeCrashStateStore({ happyHomeDir });
            await expect(access(crashStore.stateFilePath)).rejects.toMatchObject({ code: 'ENOENT' });

            await expect(artifactBytesHandler!({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'voiceProvider',
                machineId: 'm1',
                cacheIdentity: {
                    pluginId: 'runtime.voice-plugin',
                    contributionId: 'conversation',
                    artifactDigest,
                    hostAppVersion: testConfiguration.currentCliVersion,
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    platform: 'ios',
                    channel: 'internal',
                    nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                    projectionGeneration: 66,
                },
                reactNativeHostRuntimeIdentity: {
                    platform: 'ios',
                    channel: 'internal',
                    scriptManagerRuntime: {
                        integrated: true,
                        installedArtifactLoaderAvailable: true,
                    },
                },
            })).resolves.toMatchObject({
                ok: true,
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'voiceProvider',
            });
            await expect(access(crashStore.stateFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await restore();
        }
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
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['ios'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                        tools: { effectCalls: 'none' },
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
        await expect(artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: {
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'runtime.voice-plugin', localId: 'conversation-surface' },
                },
                renderer: { pluginId: 'runtime.voice-plugin', localId: 'conversation' },
                artifactDigest,
                crashStateEpoch: 0,
            },
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_request',
            diagnostics: ['plugin_ui_artifact_bytes_request_invalid'],
        });

        await expect(artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            crashStateToken: {
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'runtime.voice-plugin', localId: 'conversation-surface' },
                },
                renderer: { pluginId: 'runtime.voice-plugin', localId: 'conversation' },
                artifactDigest,
                crashStateEpoch: 0,
            },
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['generated_react_native_artifact_owner_not_found'],
        });

        expect(await artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).toEqual({
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
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

        const collisionRegistry = createResolvedContributionRegistry({
            agents: [],
            voiceProviders: registry.voiceProviders,
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'runtime.voice-plugin',
                identity: { pluginId: 'runtime.voice-plugin', localId: 'conversation' },
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                pluginRootPath: pluginRoot,
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    id: 'conversation',
                    kind: 'reactNative',
                    artifact: artifactGraph.contributionId,
                },
            }],
        });
        const collisionRegistration = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(collisionRegistration.registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(collisionRegistry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            ...readyReactNativeBackendOpts,
        });
        const collisionArtifactBytesHandler = collisionRegistration.handlers.get(
            RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
        );
        await expect(collisionArtifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_not_found',
            diagnostics: ['generated_react_native_artifact_owner_not_found'],
        });

        await writeFile(join(installedRoot, entryPath), new TextEncoder().encode('tampered'));
        expect(await artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
            machineId: 'm1',
            cacheIdentity: runtime?.cacheIdentity,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).toEqual({
            ok: false,
            code: 'artifact_integrity_failed',
            diagnostics: ['react_native_artifact_file_integrity_failed'],
        });
    });

    it('projects authorization for a current client Action without a daemon handler registration', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();

        const pluginId = 'runtime.client-action-policy';
        const actionId = 'open-preview';
        const authorization = {
            packageTrust: {
                packageIdentity: 'package:runtime.client-action-policy:generation-7',
                reviewedPackageIdentity: 'package:runtime.client-action-policy:generation-7',
            },
            generation: {
                targetGeneration: 'generation-7',
                desiredGeneration: 'generation-7',
                appliedGeneration: 'generation-7',
                targetGenerationMode: 'current' as const,
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        } as const;
        const registry = createResolvedContributionRegistry({
            actions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                definition: {
                    kindVersion: 1,
                    id: actionId,
                    title: 'Open preview',
                    description: null,
                    safety: 'safe',
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
                        api: false,
                        plugin: false,
                    },
                    inputHints: null,
                    inputSchema: {},
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: 'client-action-artifact',
                            modulePath: './clientAction',
                            exportName: 'activate',
                        },
                        platforms: ['web'],
                    },
                    scopes: ['session'],
                    contributionSurfaces: ['ui'],
                    placementBindings: ['detailsPanel'],
                    dangerLevel: 'safe',
                },
            }],
        });
        const resolveActionPresentUserGatePolicy = vi.fn((candidatePluginId: string, candidateActionId: string) => (
            candidatePluginId === pluginId && candidateActionId === actionId
                ? {
                    qualifiedId: `${pluginId}/actions/${actionId}`,
                    generation: 'generation-7',
                    dangerLevel: 'safe' as const,
                    scopes: ['session'],
                    surfaces: ['ui'],
                    authorization,
                }
                : null
        ));
        const { handlers, registrar } = createRegistrar();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 7,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                generation: 7,
                pluginFinalPolicyCurrentGenerationsById: new Map([[pluginId, {
                    immutableGenerationId: 'generation-7',
                    desiredImmutableGenerationId: 'generation-7',
                    appliedImmutableGenerationId: 'generation-7',
                    distribution: { kind: 'localPath' },
                    applied: true,
                    selectedAccess: [],
                }]]),
                resolveActionPresentUserGatePolicy,
            }),
        });

        const describe = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        await expect(describe!({ machineId: 'm1' })).resolves.toMatchObject({
            projection: {
                actionsById: {
                    [`${pluginId}/${actionId}`]: { authorization },
                },
            },
        });
        expect(resolveActionPresentUserGatePolicy).toHaveBeenCalledWith(pluginId, actionId);
    });

    it('serves a client Action only from its current projected target, exact origin, and declared generated Artifact', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const pluginId = 'runtime.client-action';
        const actionId = 'open-preview';
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-generated-client-action-artifact-'));
        const installedRoot = join(pluginRoot, 'dist', 'happier-plugin-ui');
        const entryPath = 'react-native/client-action-ios/index.js';
        await mkdir(join(installedRoot, 'react-native', 'client-action-ios'), { recursive: true });
        const entryBytes = new TextEncoder().encode('export function activate() {}');
        await writeFile(join(installedRoot, entryPath), entryBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryPath, bytes: entryBytes },
        ]);
        const artifactGraph = {
            contributionId: 'client-action-artifact',
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
                containerName: 'runtime_client_action',
                modulePath: './clientAction',
                exportName: 'activate',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const registry = createResolvedContributionRegistry({
            agents: [],
            materializationIdsByPluginId: { [pluginId]: 'client-action-materialization-a' },
            actions: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId,
                pluginVersion: '1.0.0',
                identity: { pluginId, localId: actionId },
                pluginRootPath: pluginRoot,
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                generatedUiArtifactsManifest: { version: 1, entries: [artifactGraph] },
                definition: {
                    kindVersion: 1,
                    id: actionId,
                    title: 'Open preview',
                    description: null,
                    safety: 'safe',
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
                        api: false,
                        plugin: false,
                    },
                    inputHints: null,
                    inputSchema: {},
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: artifactGraph.contributionId,
                            modulePath: './clientAction',
                            exportName: 'activate',
                        },
                        platforms: ['ios'],
                    },
                    scopes: ['session'],
                    contributionSurfaces: ['ui'],
                    placementBindings: ['detailsPanel'],
                    dangerLevel: 'safe',
                },
            }],
        });
        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 75,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_client_action',
                machineId: 'm1',
            }),
            ...readyReactNativeBackendOpts,
        });
        const artifactBytesHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        expect(artifactBytesHandler).toBeDefined();
        const clientContribution = {
            family: 'actions' as const,
            action: { pluginId, localId: actionId },
        };
        const cacheIdentity = {
            pluginId,
            contributionId: actionId,
            artifactDigest,
            hostAppVersion: configuration.currentCliVersion,
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
            reactNativeVersion: '0.83.4',
            platform: 'ios' as const,
            channel: 'internal',
            nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
            projectionGeneration: 75,
        };
        const nativeHostRuntimeIdentity = {
            platform: 'ios' as const,
            channel: 'internal' as const,
            scriptManagerRuntime: {
                integrated: true,
                installedArtifactLoaderAvailable: true,
            },
        } as const;

        await expect(artifactBytesHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'clientContribution',
            machineId: 'm1',
            cacheIdentity,
            clientContribution,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).resolves.toEqual({
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'clientContribution',
            cacheIdentity,
            clientContribution,
            artifact: {
                pluginId,
                contributionId: actionId,
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

        const noOriginRegistry = createResolvedContributionRegistry({
            agents: [],
            actions: registry.actions,
        });
        const noOriginRegistration = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(noOriginRegistration.registrar as never, {
            resolveGeneration: async () => 75,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(noOriginRegistry),
            resolveReactNativeBundlesFeatureDecision: async () => createEnabledReactNativeBundlesFeatureDecision(),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_client_action',
                machineId: 'm1',
            }),
            ...readyReactNativeBackendOpts,
        });
        const noOriginHandler = noOriginRegistration.handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ);
        await expect(noOriginHandler!({
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'clientContribution',
            machineId: 'm1',
            cacheIdentity,
            clientContribution,
            reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['client_contribution_execution_origin_unavailable'],
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
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.forms',
                identity: { pluginId: 'acme.forms', localId: 'preferences-view' },
                manifestPath: '/plugins/acme.forms/.happier-plugin/plugin.json',
                definition: {
                    id: 'preferences-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'preferences-renderer',
                    title: 'Preferences',
                    instancePolicy: 'singleton',
                    headerActions: [],
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
                    scope: 'daemon',
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
                    execution: { target: 'daemon' },
                    placements: [],
                    scopes: ['settings'],
                    placementBindings: ['detailsPanel'],
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
                        api: false,
                        plugin: false,
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
            prepare: vi.fn<TargetActionInvocationRuntime['prepare']>(async () => ({
                kind: 'settled',
                result: { status: 'executed', value: null },
            })),
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
                getPluginUiResourceCapability: (pluginId) => pluginId === 'acme.forms'
                    ? Object.freeze({ readable: true, dynamic: true })
                    : Object.freeze({ readable: false, dynamic: false }),
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
            runtime: {
                resourceCapability: { readable: true, dynamic: true },
            },
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

    it('projects the current Composer surface catalog with daemon-selected renderer and execution facts', async () => {
        const pluginId = 'acme.composer';
        const generation = 'composer-generation';
        const rendererId = 'incident-region';
        const regionId = 'incident';
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                identity: createPluginContributionIdentity({ pluginId, localId: rendererId }),
                manifestPath: '/plugins/acme.composer/.happier-plugin/plugin.json',
                definition: {
                    id: rendererId,
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Current incident' },
                },
            }],
            composerRegions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                identity: createPluginContributionIdentity({ pluginId, localId: regionId }),
                manifestPath: '/plugins/acme.composer/.happier-plugin/plugin.json',
                definition: {
                    id: regionId,
                    placement: 'beforeComposer',
                    renderer: { renderer: rendererId },
                },
            }],
            immutableGenerationIdsByPluginId: { [pluginId]: generation },
            materializationIdsByPluginId: { [pluginId]: 'composer-materialization' },
            activationTargets: [],
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 52,
            resolveRuntimeRegistry: async () => createRuntimeRegistry(registry, {
                generation: 52,
                getPluginUiResourceCapability: () => Object.freeze({ readable: true, dynamic: true }),
            }),
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_composer',
                machineId: 'machine-composer',
            }),
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        if (!handler) throw new Error('composer_surface_catalog_handler_missing');

        const raw = await handler({ machineId: 'machine-composer' });

        expect(raw).toMatchObject({
            composerSurfaceCatalog: [{
                contribution: { pluginId, localId: regionId },
                immutableGenerationId: generation,
                projectionGeneration: 52,
                role: 'region',
                rendererChain: [{ pluginId, localId: rendererId }],
                selectedRenderer: {
                    identity: { pluginId, localId: rendererId },
                    renderer: {
                        kind: 'declarative',
                        contributionId: rendererId,
                        model: expect.objectContaining({ visible: true }),
                    },
                    availability: { state: 'available', reason: 'available', diagnostics: [] },
                },
                executionOrigin: {
                    serverIdentityId: 'srv_composer',
                    materializationRef: {
                        machineId: 'machine-composer',
                        materializationId: 'composer-materialization',
                        pluginId,
                    },
                },
                resourceCapability: { readable: true, dynamic: true },
                contributorTargetedContributions: {
                    target: { pluginId, immutableGenerationId: generation },
                    points: [],
                },
            }],
        });
    });

    it('derives one cold admitted target snapshot per exact mounted generation without leaking a prior target cache entry', async () => {
        const targetA = 'acme.target-a';
        const targetB = 'acme.target-b';
        const contributor = 'acme.contributor';
        const providerProtocol = { id: 'provider', version: 1 } as const;
        const providerProtocolV2 = { id: 'provider', version: 2 } as const;
        const actionResult = defineProtocolObject({}, { policy: 'closed' });
        const descriptor = defineProtocolObject({
            name: defineProtocolString(),
        }, { policy: 'closed' });
        const detailInput = defineProtocolObject({}, { policy: 'closed' });
        const targetADefinition = definePlugin({
            id: targetA,
            version: '1.0.0',
            contributionPoints: {
                providers: defineContributionPoint([
                    defineContributionProtocol({
                        ...providerProtocol,
                        descriptor,
                        operations: {
                            setup: {
                                required: true,
                                input: { kind: 'contributorDefined' },
                                resultSchema: actionResult,
                                action: { surface: 'plugin', dangerLevel: 'safe' },
                            },
                        },
                        surfaces: {
                            detail: {
                                required: true,
                                inputSchema: detailInput,
                                presentation: 'content',
                            },
                        },
                    }),
                    defineContributionProtocol({
                        ...providerProtocolV2,
                        operations: {
                            setup: {
                                required: true,
                                input: { kind: 'contributorDefined' },
                                resultSchema: actionResult,
                                action: { surface: 'plugin', dangerLevel: 'safe' },
                            },
                        },
                    }),
                ], { maxContributionsPerContributor: 2 }),
            },
        });
        const targetAManifest = readCanonicalPluginManifest(targetADefinition.manifest);
        const targetAPoint = targetAManifest?.contributes.pluginContributionPoints?.[0];
        if (!targetAPoint) throw new Error('Expected target contribution point');
        const targetBPoint: PluginContributionPointV1 = {
            id: 'tools',
            maxContributionsPerContributor: 1,
            protocols: [{
                ...providerProtocol,
                operations: {
                    setup: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: { type: 'object' },
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                },
            }],
        };
        const contribution: PluginTargetedContributionV1 = {
            id: 'provider-a',
            target: { pluginId: targetA, pointId: targetAPoint.id },
            protocol: providerProtocol,
            descriptor: { name: 'Provider A' },
            operations: { setup: 'setup' },
            surfaces: { detail: { renderer: 'provider-detail' } },
        };
        const contributionWithoutSurfaces: PluginTargetedContributionV1 = {
            id: 'provider-v2',
            target: { pluginId: targetA, pointId: targetAPoint.id },
            protocol: providerProtocolV2,
            operations: { setup: 'setup' },
        };
        const contributorManifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
            id: contributor,
            contributes: {
                actions: [{
                    id: 'setup',
                    title: 'Setup',
                    scopes: ['global'],
                    surfaces: ['plugin'],
                    dangerLevel: 'safe',
                    execution: { target: 'daemon' },
                    resultSchema: { type: 'object' },
                }],
            },
        }));
        if (!contributorManifest) throw new Error('Expected targeted contributor fixture to normalize');
        const [contributorAction] = buildPluginContributionRegistry({
            loadedPlugins: [{
                pluginId: contributor,
                pluginRootPath: '/plugins/contributor',
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                daemonEntryPath: '/plugins/contributor/daemon.mjs',
                devDaemonEntryPath: null,
                sourceSpec: {
                    kind: 'path',
                    locator: '/plugins/contributor',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                },
                manifest: contributorManifest,
            }],
        }).actions;
        if (!contributorAction) throw new Error('Expected targeted contributor Action fixture to project');
        const registry = createResolvedContributionRegistry({
            actions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: contributor,
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                definition: contributorAction.definition,
            }],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: contributor,
                identity: createPluginContributionIdentity({ pluginId: contributor, localId: 'provider-detail' }),
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                definition: {
                    id: 'provider-detail',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Provider detail' },
                },
            }],
            pluginContributionPoints: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: targetA,
                    identity: createPluginContributionIdentity({ pluginId: targetA, localId: targetAPoint.id }),
                    manifestPath: '/plugins/target-a/.happier-plugin/plugin.json',
                    definition: targetAPoint,
                    semanticPointRefs: targetADefinition.contributionPoints.providers.protocols,
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: targetB,
                    identity: createPluginContributionIdentity({ pluginId: targetB, localId: targetBPoint.id }),
                    manifestPath: '/plugins/target-b/.happier-plugin/plugin.json',
                    definition: targetBPoint,
                },
            ],
            targetedPluginContributions: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: contributor,
                identity: createPluginContributionIdentity({ pluginId: contributor, localId: contribution.id }),
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                definition: contribution,
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: contributor,
                identity: createPluginContributionIdentity({
                    pluginId: contributor,
                    localId: contributionWithoutSurfaces.id,
                }),
                manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
                definition: contributionWithoutSurfaces,
            }],
            immutableGenerationIdsByPluginId: {
                [targetA]: 'target-a-generation',
                [targetB]: 'target-b-generation',
                [contributor]: 'contributor-generation',
            },
            materializationIdsByPluginId: {
                [contributor]: 'contributor-materialization',
            },
            activationTargets: [],
        });
        const activateContributionsOnDemand = vi.fn(async () => []);
        const runtime = createRuntimeRegistry(registry, {
            activateContributionsOnDemand,
            readAdmittedTargetedContributions: registry.readAdmittedTargetedContributions,
            generation: 19,
            getPluginUiResourceCapability: () => Object.freeze({ readable: true, dynamic: true }),
        });
        const { handlers, registrar } = createRegistrar();
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache();
        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveGeneration: async () => 19,
            resolveRuntimeRegistry: async () => runtime,
            resolvePluginProjectionExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_targeted',
                machineId: 'm1',
            }),
        });
        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        if (!handler) throw new Error('targeted_projection_handler_missing');

        const targetAResponse = await handler({
            machineId: 'm1',
            mountedTarget: { pluginId: targetA, immutableGenerationId: 'target-a-generation' },
        });
        expect(targetAResponse).toMatchObject({
            targetedContributions: {
                target: { pluginId: targetA, immutableGenerationId: 'target-a-generation' },
                points: [{
                    pointId: 'providers',
                    protocols: [
                        {
                            protocol: providerProtocol,
                            contributions: [{
                                contributor: {
                                    pluginId: contributor,
                                    contributionId: 'provider-a',
                                    immutableGenerationId: 'contributor-generation',
                                },
                                descriptor: { name: 'Provider A' },
                                operations: [{
                                    point: { pointId: 'providers', protocol: providerProtocol },
                                    contributor: {
                                        pluginId: contributor,
                                        contributionId: 'provider-a',
                                        immutableGenerationId: 'contributor-generation',
                                    },
                                    role: 'setup',
                                    action: { pluginId: contributor, localId: 'setup' },
                                }],
                                surfaces: [{
                                    point: { pointId: 'providers', protocol: providerProtocol },
                                    contributor: {
                                        pluginId: contributor,
                                        contributionId: 'provider-a',
                                        immutableGenerationId: 'contributor-generation',
                                    },
                                    role: 'detail',
                                    presentation: 'content',
                                }],
                            }],
                        },
                        {
                            protocol: providerProtocolV2,
                            contributions: [{
                                contributor: {
                                    pluginId: contributor,
                                    contributionId: 'provider-v2',
                                    immutableGenerationId: 'contributor-generation',
                                },
                                operations: [{
                                    point: { pointId: 'providers', protocol: providerProtocolV2 },
                                    contributor: {
                                        pluginId: contributor,
                                        contributionId: 'provider-v2',
                                        immutableGenerationId: 'contributor-generation',
                                    },
                                    role: 'setup',
                                    action: { pluginId: contributor, localId: 'setup' },
                                }],
                                surfaces: [],
                            }],
                        },
                    ],
                }],
            },
        });
        const projectedDetail = targetAResponse.targetedContributions
            ?.points[0]?.protocols[0]?.contributions[0]?.surfaces?.[0];
        expect(projectedDetail).not.toHaveProperty('inputSchema');
        expect(projectedDetail).not.toHaveProperty('rendererChain');
        expect(projectedDetail).not.toHaveProperty('materializationId');
        expect(targetAResponse).toMatchObject({
            targetedSurfaceMounts: [{
                kind: 'targetedSurface',
                target: { pluginId: targetA, immutableGenerationId: 'target-a-generation' },
                point: { pointId: 'providers', protocol: providerProtocol },
                contributor: {
                    pluginId: contributor,
                    contributionId: 'provider-a',
                    immutableGenerationId: 'contributor-generation',
                },
                role: 'detail',
                presentation: 'content',
                inputSchema: { type: 'object' },
                rendererChain: [{ pluginId: contributor, localId: 'provider-detail' }],
                selectedRenderer: {
                    identity: { pluginId: contributor, localId: 'provider-detail' },
                    renderer: {
                        kind: 'declarative',
                        contributionId: 'provider-detail',
                        model: expect.objectContaining({ visible: true }),
                    },
                    availability: { state: 'available', reason: 'available', diagnostics: [] },
                },
                executionOrigin: {
                    serverIdentityId: 'srv_targeted',
                    materializationRef: {
                        machineId: 'm1',
                        materializationId: 'contributor-materialization',
                        pluginId: contributor,
                    },
                },
                resourceCapability: { readable: true, dynamic: true },
                contributorTargetedContributions: {
                    target: {
                        pluginId: contributor,
                        immutableGenerationId: 'contributor-generation',
                    },
                    points: [],
                },
            }],
        });
        expect(targetAResponse.targetedSurfaceMounts?.[0]).not.toHaveProperty('descriptor');
        expect(targetAResponse.targetedSurfaceMounts?.[0]).not.toHaveProperty('operations');

        const targetBResponse = await handler({
            machineId: 'm1',
            mountedTarget: { pluginId: targetB, immutableGenerationId: 'target-b-generation' },
        });
        expect(targetBResponse).toMatchObject({
            targetedContributions: {
                target: { pluginId: targetB, immutableGenerationId: 'target-b-generation' },
                points: [{
                    pointId: 'tools',
                    protocols: [{ protocol: providerProtocol, contributions: [] }],
                }],
            },
        });

        const targetAAgain = await handler({
            machineId: 'm1',
            mountedTarget: { pluginId: targetA, immutableGenerationId: 'target-a-generation' },
        });
        expect(targetAAgain).toMatchObject({
            targetedContributions: {
                target: { pluginId: targetA, immutableGenerationId: 'target-a-generation' },
            },
        });
        expect(activateContributionsOnDemand).not.toHaveBeenCalled();
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

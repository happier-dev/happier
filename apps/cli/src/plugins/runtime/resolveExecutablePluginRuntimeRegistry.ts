import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
} from '../projection/registry/sources/generatedBundledPlugins';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '../projection/registry/sources/generatedBundledPluginArtifacts';
import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '../projection/registry/types';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    evaluatePluginFinalPolicy,
    readHookEventEnvelopeV1,
    resolveAttentionDeliveryPolicyDecision,
    type PluginStructuredMessageDescriptorV1,
} from '@happier-dev/protocol';

import {
    activatePluginRuntimeRegistry,
    type ActivatedPluginRuntimeRegistry,
    type SupervisedPluginActivationAttempt,
} from './lifecycle/manager';
import { createBundledActivationSourceResolver } from './bundledActivationSource';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../scm/pluginBackends/runtimeRegistry';
import type {
    PluginDaemonModuleNamespace,
    ResolvedPluginHookHandler,
} from './types';
import type { PluginActivationSource } from './activationSources';
import {
    collectActivationTargets,
    type ActivationTarget,
} from './lifecycle/activation/targets';
import {
    createDeclarativeAcpAgentRuntimeRegistry,
    createTargetAgentRuntimeRegistry,
} from './lifecycle/contributions/targetAgents';
import { createTargetVoiceSpeechRegistry } from './lifecycle/contributions/targetVoiceSpeech';
import {
    projectPluginMcpDiscoveryWarnings,
    projectPluginMcpDiscoveryWarningsToLegacyDetection,
} from './lifecycle/contributions/targetMcp';
import { buildTargetActionInvocationRegistry } from './invocation/buildTargetActionRegistry';
import { resolveCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import type { createTargetActionInvocationRegistry } from './invocation/targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from './invocation/services/production';
import type { StablePluginConnectedAccountsOwner } from './invocation/services/connectedAccounts';
import type {
    QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createStablePluginResourcesOwner } from './invocation/services/resources';
import {
    resolveStablePluginStructuredMessageConsumer,
    type StablePluginStructuredMessageResolution,
} from './invocation/services/structuredMessageConsumer';
import {
    addMcpAvailablePluginInvocationServiceBinding,
} from './invocation/services/factory';
import {
    createStablePluginMcpHost,
    type DeclaredTransportConnector,
    type StablePluginMcpFinalPolicyEffect,
} from './invocation/services/mcp';
import { createStableDeclaredMcpTransportConnector } from './invocation/services/mcpDeclaredTransport';
import { createPluginInvocationUi } from './invocation/services/ui';
import {
    PluginError,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { type PluginEventsService, type PluginInterceptedRequest, type PluginInterceptorResult, type PluginMcpDiscoveryResult, type PluginMcpServerRef, type PluginSettingsService } from '@happier-dev/plugin-sdk/runtime';
import type { FetchRuntimeServiceV1 } from './exec/privateContract';
import type {
    McpDiscoveryProviderReturnV1,
    McpResolveForSessionInputV1,
    McpServerSpecV1,
} from '@happier-dev/plugin-sdk/experimental/mcp';
import type { TargetRequestInterceptorBinding } from './lifecycle/contributions/targetRequestInterceptors';
import type {
    CreateAgentInvocationServices,
    PluginInvocationServicesSeed,
} from './invocation/services/types';
import { withPluginInvocationServiceBindingAvailability } from './invocation/services/unavailable';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import {
    createConnectedAccountContributionRegistry,
    type ConnectedAccountRuntimeLease,
} from './connectedAccounts/contributionRegistry';
import {
    createConnectedAccountHostRuntimeInvoker,
    type ConnectedAccountHostRuntimeInvoker,
} from './connectedAccounts/runtimeInvoker';
import {
    resolveHostOwnedConnectedAccountConfiguredOrigins,
} from './connectedAccounts/configuredOrigins';
import type { StablePluginManagedDependenciesHost } from './invocation/services/managedDependencies';
import { composeProviderBindingProcessAccess } from './providerBindings/invocationAccess';
import { createStablePluginManagedDependenciesHost } from './invocation/services/managedDependencies';
import { createV2ManagedDependencySourceModelFromRegistry } from './invocation/services/managedDependencySourceModel';
import { createProductionManagedDependencySourceAdapter } from './invocation/services/managedDependencySourceAdapters';
import { createStableManagedExecutableResolver } from './invocation/services/managedExecutableResolver';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { createPluginAgentCliReadinessService } from './context/agents';
import {
    createPluginExecSystemToolResolver,
} from './exec/system/tools/resolveGrant';
import {
    createAgentCliHostResolutionEnvironment,
    createAgentCliSystemToolService,
} from './exec/system/tools/agentCliBinding';
import { projectPluginSystemToolContributions } from './exec/system/tools/definitions';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk/runtime';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { resolveExecutableManagedDependenciesRegistry } from '../projection/registry/managedDependencyExecutables';
import { resolvePluginStorePaths } from '../store/paths';
import { resolveNotificationChannelSettingsContributions } from '../settings/notificationChannelSettings';
import {
    createPluginNetworkEffectScopeRegistry,
    type PluginAccessSelection,
} from '../store/install/accessScopeRegistry';
import {
    projectConnectedAccountPurposeDeclarationsToHostAccess,
} from './hostAccess/resolve';
import { isPluginHostAccessRequestAuthorizedBySelection } from './hostAccess/resourceSelection';
import { readCurrentCommittedPluginGenerations } from '../store/registry/generationStore';
import { reconcilePluginGenerationCustodyRetirement } from '../store/registry/generationCustodyRetirement';
import { logger } from '@/ui/logger';
import { bindPromptAssetContributionBlocks } from '@/agent/prompting/contributions/bindPromptAssetContributionBlocks';
import type { PromptBlockV1 } from '@happier-dev/protocol';
import {
    resolveTargetActionResourceSelectionFacts,
    type ContributionPolicyFacts,
    type TargetActionAuthorizationFacts,
} from './policy/evaluate';
import {
    resolvePluginFinalPolicyAuthorizationFacts,
    type PluginFinalPolicyCurrentGeneration,
} from './policy/facts';
import type { ResolvedTargetAction } from './invocation/actionExecutor';
import {
    createStablePluginFetchHost,
    isLiteralPrivateNetworkHostname,
    type StablePluginFetchFinalPolicyEffect,
} from './fetch/service';
import {
    createVoiceAccountPluginFetchCredentialBindingHost,
} from './fetch/voiceAccountCredentialBinding';
import { createGlobalFetchRuntime } from './fetch/globalFetchRuntime';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import {
    createPluginMcpSessionResolver,
} from './context/mcp';
import {
    createPluginHostedMcpServerHandle,
    createPluginHostedMcpServerRegistry,
} from '@/mcp/createPluginHostedMcpServerHandle';
import { startPluginHostedMcpLoopbackServer } from '@/mcp/hosted/startPluginHostedMcpLoopbackServer';
import type {
    McpSessionResolutionInput,
    PluginMcpSessionResolver,
    ResolvedSessionMcpServer,
} from '@/mcp/runtimeTypes';
import {
    getActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type PluginRuntimeGenerationAuthority = NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;

export type PluginRuntimeActivationRegistryLease = Readonly<{
    registry: ActivatedPluginRuntimeRegistry;
    pluginIds: ReadonlySet<string>;
    retain(): PluginRuntimeActivationRegistryLease;
    release(options?: Parameters<ActivatedPluginRuntimeRegistry['dispose']>[0]): Promise<void>;
}>;

export type PluginContributionRuntimeLifecycle = Readonly<{
    generation: string;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

function createPluginRuntimeActivationRegistryLeaseOwner(
    registry: ActivatedPluginRuntimeRegistry,
    pluginIds: ReadonlySet<string> = registry.activatedPluginIds,
    dispose: (options?: Parameters<ActivatedPluginRuntimeRegistry['dispose']>[0]) => Promise<void> = async (options) => {
        await registry.dispose(options);
    },
): Readonly<{ retain(): PluginRuntimeActivationRegistryLease }> {
    let references = 0;
    let disposed = false;
    let disposal: Promise<void> | null = null;
    const owner = {
        retain(): PluginRuntimeActivationRegistryLease {
            if (disposed) throw new Error('Plugin runtime activation registry lease is already disposed');
            references += 1;
            let released = false;
            return Object.freeze({
                registry,
                pluginIds,
                retain: () => owner.retain(),
                async release(options) {
                    if (released) return;
                    released = true;
                    references -= 1;
                    if (references !== 0) return;
                    disposed = true;
                    disposal ??= dispose(options);
                    await disposal;
                },
            });
        },
    };
    return Object.freeze(owner);
}

type PluginRuntimeInvocationServicesLease = Readonly<{
    release(): Promise<void>;
}>;

function createPluginRuntimeInvocationServicesLeaseOwner(
    dispose: () => Promise<void>,
): Readonly<{ retain(): PluginRuntimeInvocationServicesLease }> {
    let references = 0;
    let disposed = false;
    let disposal: Promise<void> | null = null;
    const owner = {
        retain(): PluginRuntimeInvocationServicesLease {
            if (disposed) throw new Error('Plugin runtime invocation-services lease is already disposed');
            references += 1;
            let released = false;
            return Object.freeze({
                async release() {
                    if (released) return;
                    released = true;
                    references -= 1;
                    if (references !== 0) return;
                    disposed = true;
                    disposal ??= dispose();
                    await disposal;
                },
            });
        },
    };
    return Object.freeze(owner);
}

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    // Includes internal merged contribution surfaces (`catalogEntry`).
    contributes: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    generation?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['generation'];
    targetActivationFacts?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['targetActivationFacts'];
    targetActionInvocations?: ReturnType<typeof createTargetActionInvocationRegistry>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    agentRuntimesByAgentId: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['agentRuntimesByAgentId'];
    daemonAuthBridgesByServiceId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['daemonAuthBridgesByServiceId'];
    notificationCategoriesById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['notificationCategoriesById'];
    notificationChannelsById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['notificationChannelsById'];
    scmHostingProvidersById: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmHostingProvidersById'];
    scmBackendsById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendsById'];
    scmBackendRegistrations?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendRegistrations'];
    requestInterceptors?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requestInterceptors'];
    invokeRequestInterceptor?(
        binding: TargetRequestInterceptorBinding,
        request: PluginInterceptedRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginInterceptorResult>;
    mcpServers?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['mcpServers'];
    mcpDiscoveryProviders?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['mcpDiscoveryProviders'];
    voiceSpeechProviders?: ReturnType<typeof createTargetVoiceSpeechRegistry>;
    networkAllowedPluginIds?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['networkAllowedPluginIds'];
    networkAllowedUrlOriginsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['networkAllowedUrlOriginsByPluginId'];
    processSpawnAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['processSpawnAllowedPathsByPluginId'];
    systemToolDefinitionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['systemToolDefinitionsByPluginId'];
    envAllowedNamesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['envAllowedNamesByPluginId'];
    filesystemReadAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemReadAllowedPathsByPluginId'];
    filesystemWriteAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemWriteAllowedPathsByPluginId'];
    permissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['permissionsByPluginId'];
    permissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['permissionDeclarationsByPluginId'];
    requiredPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requiredPermissionsByPluginId'];
    requiredPermissionDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requiredPermissionDeclarationsByPluginId'];
    runtimeCapabilitiesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['runtimeCapabilitiesByPluginId'];
    eventDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventDeclarationsByPluginId'];
    eventSubscriptionPermissionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventSubscriptionPermissionsByPluginId'];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    /** Applied package admission facts. Real registries provide them; partial
     * consumer fixtures may omit them and consumers must then fail closed. */
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
    /**
     * Resolves the existing generation owner for one exact projected contribution.
     * Consumers must fail closed when the contribution is not admitted/current.
     */
    resolveContributionRuntimeLifecycle?(input: Readonly<{
        pluginId: string;
        manifestDigest: string;
    }>): PluginContributionRuntimeLifecycle | null;
    /** Canonical validated optional HostAccess selections for this prepared registry generation. */
    resolveOptionalAccess?(pluginId: string): readonly PluginAccessSelection[];
    activatedPluginIds: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatedPluginIds'];
    activateContributionsOnDemand: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activateContributionsOnDemand'];
    /** Internal preparation capability. Real resolved registries provide it; partial
     * consumer fixtures may omit it because ordinary invocation never calls it. */
    activatePluginsForValidation?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatePluginsForValidation'];
    connectedAccountContributions?: ReturnType<typeof createConnectedAccountContributionRegistry>;
    resolveConnectedAccountRuntime?(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease>;
    connectedAccountRuntimeInvoker?: ConnectedAccountHostRuntimeInvoker;
    resolveQualifiedConnectedAccountEstablishedRuntimeOwner?():
        Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'> | null;
    resolveConnectedAccountPurposeBindingOwner?():
        Pick<StablePluginConnectedAccountsOwner, 'materialize'> | null;
    managedDependencies?: StablePluginManagedDependenciesHost;
    addRuntimeDisposable?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['addRuntimeDisposable'];
    createPluginSettingsService?(params: Readonly<{
        pluginId: string;
        signal?: AbortSignal;
    }>): PluginSettingsService | null;
    createPluginEventsService?(params: Readonly<{
        pluginId: string;
        pluginVersion: string;
        signal?: AbortSignal;
    }>): PluginEventsService | null;
    createPluginFetchServiceV1?(params: Readonly<{
        pluginId: string;
        pluginVersion: string;
        signal: AbortSignal;
    }>): FetchRuntimeServiceV1 | null;
    createPluginMcpSessionResolver?(
        params: Readonly<{
            pluginId: string;
            pluginVersion: string;
            signal?: AbortSignal;
            addDisposable?: (disposable: Readonly<{
                dispose(): void | Promise<void>;
            }>) => unknown;
            resolveHostSession(
                input: McpSessionResolutionInput,
            ): Promise<Readonly<{
                bindingId: string;
                sessionId: string;
                directory: string;
                servers: readonly ResolvedSessionMcpServer[];
                currentSession: HostCurrentSessionUiServices;
            }> | null>;
        }>,
    ): PluginMcpSessionResolver | null;
    discoverMcpServersForDetection?(params: Readonly<{
        pluginId: string;
        localId: string;
        input: McpResolveForSessionInputV1;
        signal: AbortSignal;
    }>): Promise<McpDiscoveryProviderReturnV1>;
    createAgentInvocationServices: CreateAgentInvocationServices;
    /** Host-private cancellation boundary for consumers of this resolved registry. */
    retirementSignal?: AbortSignal;
    readHookEventEnvelopeV1: typeof readHookEventEnvelopeV1;
    resolvePromptAssetBlocks(params: Readonly<{
        agentId: string;
        selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
        sessionId?: string;
        featureIds?: readonly string[];
        machineId?: string;
        projectId?: string;
        signal?: AbortSignal;
    }>): Promise<readonly PromptBlockV1[]>;
    resolveStructuredMessage?(params: Readonly<{
        expectedGeneration: string;
        kind: string;
        payload: JsonValue;
        resourceRefs?: NonNullable<PluginStructuredMessageDescriptorV1['actions']>;
        facts: ContributionPolicyFacts;
        signal?: AbortSignal;
    }>): Promise<StablePluginStructuredMessageResolution>;
    /** Synchronously fences invocation capabilities while resource disposal remains lease-delayed. */
    retireConsumers(): void;
    /** Fences only the named plugin generations while retained peer generations remain usable. */
    retirePluginConsumers?(pluginIds: readonly string[]): void;
    retainActivationRegistryComponentsExcluding?(
        pluginIds: ReadonlySet<string>,
    ): readonly PluginRuntimeActivationRegistryLease[];
    /** Host-private changed-plugin activation retained across an unchanged-facts
     * durable base retry. */
    retainPreparedActivationRegistryComponents?(): readonly PluginRuntimeActivationRegistryLease[];
    dispose: (params?: Readonly<{
        timeoutMs?: number;
        onError?: (event: Readonly<{
            pluginId: string;
            phase: 'runtime_disposables' | 'registered_disposables';
            error: unknown;
        }>) => void;
    }>) => Promise<void>;
}>;

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneLegacyMcpHandlerInput(value: unknown): JsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new PluginError({
            code: 'plugin_mcp_input_invalid',
            message: 'MCP tool input must be strict JSON',
        });
    }
    return JSON.parse(encoded) as JsonValue;
}

function mergePluginDiagnostics(
    left: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    right: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    const merged: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
    const pluginIds = new Set([
        ...Object.keys(left),
        ...Object.keys(right),
    ]);

    for (const pluginId of pluginIds) {
        merged[pluginId] = Object.freeze([
            ...(left[pluginId] ?? []),
            ...(right[pluginId] ?? []),
        ]);
    }

    return merged;
}

function resolveManagedDependencyHostPlatform(): 'darwin' | 'linux' | 'win32' {
    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
        return process.platform;
    }
    throw new PluginError({
        code: 'plugin_managed_dependency_platform_unsupported',
        message: 'Managed dependencies are unavailable on this host platform',
    });
}

function mergeActivatedContributes(
    base: ResolvedContributionRegistry,
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>,
): ResolvedContributionRegistry {
    const contributionKey = (contribution: Readonly<{ pluginId?: string; definition: Readonly<{ id: string }> }>): string => (
        contribution.pluginId
            ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId: contribution.pluginId,
                localId: contribution.definition.id,
            }))
            : contribution.definition.id
    );
    const baseActionIds = new Set(base.actions.map(contributionKey));
    const activatedActions = activated.actions.filter((action) => !baseActionIds.has(contributionKey(action)));
    const baseToolIds = new Set((base.tools ?? []).map(contributionKey));
    const activatedTools = activated.tools.filter((tool) => !baseToolIds.has(contributionKey(tool)));
    const baseCommandIds = new Set((base.commands ?? []).map(contributionKey));
    const activatedCommands = activated.commands.filter((command) => !baseCommandIds.has(contributionKey(command)));

    if (
        activatedActions.length === 0
        && activatedTools.length === 0
        && activatedCommands.length === 0
    ) {
        return base;
    }

    return createResolvedContributionRegistry({
        ...base,
        actions: Object.freeze([
            ...base.actions,
            ...activatedActions,
        ]),
        tools: Object.freeze([
            ...(base.tools ?? []),
            ...activatedTools,
        ]),
        commands: Object.freeze([
            ...(base.commands ?? []),
            ...activatedCommands,
        ]),
    });
}

async function resolveCommittedRelativePath(rootPath: string, candidatePath: string): Promise<string | null> {
    const resolvedRoot = await realpath(resolve(rootPath));
    const resolvedCandidate = await realpath(resolve(candidatePath));
    const relativePath = relative(resolvedRoot, resolvedCandidate);
    if (
        relativePath === ''
        || relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath)
    ) {
        return null;
    }
    return relativePath.split(sep).join('/');
}

async function assertCommittedResourceActivationIdentity(params: Readonly<{
    candidate: ResolvedContributionRegistry;
    canonical: ResolvedContributionRegistry;
    committed: NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;
}>): Promise<void> {
    // A caller may supply a deliberately scoped registry (for example one Agent engine).
    // Validate every resource-bearing plugin admitted by that scope, but do not make unrelated
    // committed plugins a prerequisite for constructing the scoped runtime.
    const resourcePluginIds = new Set([
        ...params.candidate.resources.flatMap((resource) => (
            resource.pluginId && params.committed.generations.has(resource.pluginId) ? [resource.pluginId] : []
        )),
        ...(params.candidate.promptAssets ?? []).flatMap((asset) => (
            params.committed.generations.has(asset.pluginId) ? [asset.pluginId] : []
        )),
    ]);
    for (const pluginId of resourcePluginIds) {
        const committedGeneration = params.committed.generations.get(pluginId)!;
        const admittedPaths = new Set(committedGeneration.record.files.map((file) => file.relativePath));
        const canonicalTargets = params.canonical.activationTargets.filter((target) => target.pluginId === pluginId);
        const candidateTargets = params.candidate.activationTargets.filter((target) => target.pluginId === pluginId);
        const isBundledArtifact = canonicalTargets.some((target) => target.source.kind === 'bundled');

        for (const target of canonicalTargets) {
            if (target.manifestDigest !== committedGeneration.record.manifestDigest) {
                throw new Error(`Committed resource activation identity manifest digest mismatch for '${pluginId}'`);
            }
            if (target.source.kind === 'bundled') {
                if (target.daemonEntryPath && target.sourceSpec?.locator !== target.daemonEntryPath) {
                    throw new Error(`Bundled resource activation package identity mismatch for '${pluginId}'`);
                }
                continue;
            }
            const manifestRelativePath = await resolveCommittedRelativePath(
                committedGeneration.rootPath,
                target.manifestPath,
            );
            if (manifestRelativePath !== '.happier-plugin/plugin.json') {
                throw new Error(
                    `Committed resource activation identity manifest path mismatch for '${pluginId}': ${manifestRelativePath ?? '<outside-generation>'}`,
                );
            }
            if (!admittedPaths.has(manifestRelativePath)) {
                throw new Error(`Committed resource activation identity manifest inventory mismatch for '${pluginId}'`);
            }
            for (const entryPath of [target.daemonEntryPath, target.devDaemonEntryPath]) {
                if (!entryPath) continue;
                const entryRelativePath = await resolveCommittedRelativePath(committedGeneration.rootPath, entryPath);
                if (!entryRelativePath || !admittedPaths.has(entryRelativePath)) {
                    throw new Error(`Committed resource activation identity runtime entry inventory mismatch for '${pluginId}'`);
                }
            }
        }

        const identity = async (target: (typeof canonicalTargets)[number]): Promise<string> => JSON.stringify({
            provenance: target.provenance,
            source: target.source,
            manifestPath: isBundledArtifact ? target.manifestPath : await realpath(resolve(target.manifestPath)),
            manifestDigest: target.manifestDigest,
            daemonEntryPath: isBundledArtifact
                ? target.daemonEntryPath
                : (target.daemonEntryPath ? await realpath(resolve(target.daemonEntryPath)) : null),
            devDaemonEntryPath: isBundledArtifact
                ? target.devDaemonEntryPath
                : (target.devDaemonEntryPath ? await realpath(resolve(target.devDaemonEntryPath)) : null),
            sourceSpec: target.sourceSpec,
            activationEvents: target.activationEvents ?? [],
            manifest: target.manifest,
        });
        const canonicalIdentities = (await Promise.all(canonicalTargets.map(identity))).sort();
        const candidateIdentities = (await Promise.all(candidateTargets.map(identity))).sort();
        if (JSON.stringify(candidateIdentities) !== JSON.stringify(canonicalIdentities)) {
            throw new Error(`Committed resource activation identity candidate mismatch for '${pluginId}'`);
        }
    }
}

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{
        happyHomeDir?: string;
        contributes?: ResolvedContributionRegistry;
        generation?: number;
        pluginIds?: readonly string[];
        generationAuthority?: PluginRuntimeGenerationAuthority;
        onActivationAttempt?: (attempt: SupervisedPluginActivationAttempt) => void | Promise<void>;
        connectedAccounts?: StablePluginConnectedAccountsOwner;
        qualifiedConnectedAccountEstablishedRuntimeOwner?:
            Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
        retainedActivationRegistryLeases?: readonly PluginRuntimeActivationRegistryLease[];
        preparedActivationRegistryLeases?: readonly PluginRuntimeActivationRegistryLease[];
        recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? 0;
    const contributes = params?.contributes
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    const committed = params?.generationAuthority ?? await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
        {
            bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
            isolateInvalidInstalledGenerations: true,
        },
    );
    if (!params?.generationAuthority && committed?.commit) {
        try {
            const retirement = await reconcilePluginGenerationCustodyRetirement({
                paths: resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
                commit: committed.commit,
            });
            if (retirement.status === 'authentication-unavailable') {
                logger.warn('[PLUGIN RUNTIME] Obsolete generation custody retirement awaits authentication');
            } else if (retirement.failures.length > 0) {
                logger.warn('[PLUGIN RUNTIME] Obsolete generation custody retirement remains pending', {
                    failures: retirement.failures,
                });
            }
        } catch (error) {
            logger.warn('[PLUGIN RUNTIME] Obsolete generation custody reconciliation failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    const immutableArtifactEntryPathsByPackageName = new Map(
        BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.flatMap((artifact) => {
            const admitted = committed?.generations.get(artifact.record.pluginId);
            return admitted
                ? [[artifact.packageName, join(admitted.rootPath, ...artifact.packageEntryRelativePath.split('/'))] as const]
                : [];
        }),
    );
    const resolveBundledActivationSource = createBundledActivationSourceResolver({
        bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
        immutableArtifactPackageNames: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.map((artifact) => artifact.packageName),
        immutableArtifactEntryPathsByPackageName,
        unavailableImmutableArtifactPackageNames: committed?.unavailableBundledPackageNames,
    });
    const resolveCommittedActivationSource = (
        target: ActivationTarget,
    ): PluginActivationSource<PluginDaemonModuleNamespace> | null => {
        const bundled = resolveBundledActivationSource(target);
        if (bundled) return bundled;
        if (!committed) return null;
        const admitted = committed.generations.get(target.pluginId);
        if (!admitted?.installation?.trust) return null;
        const useDevelopmentEntry = target.sourceSpec?.devWatch === true && Boolean(target.devDaemonEntryPath);
        const targetEntryPath = useDevelopmentEntry
            ? target.devDaemonEntryPath
            : (target.daemonEntryPath ?? target.devDaemonEntryPath);
        if (!targetEntryPath) return null;
        const entryPath = realpathSync(resolve(targetEntryPath));
        const generationRootPath = realpathSync(admitted.rootPath);
        const relativeEntryPath = relative(generationRootPath, entryPath);
        if (
            relativeEntryPath === ''
            || relativeEntryPath === '..'
            || relativeEntryPath.startsWith(`..${sep}`)
            || isAbsolute(relativeEntryPath)
        ) {
            throw new Error(`Committed plugin activation entry '${entryPath}' escapes immutable generation '${generationRootPath}' for '${target.pluginId}'`);
        }
        const portableEntryPath = relativeEntryPath.split(sep).join('/');
        if (!admitted.record.files.some((file) => file.relativePath === portableEntryPath)) {
            throw new Error(`Committed plugin activation entry is absent from immutable generation for '${target.pluginId}'`);
        }
        return {
            kind: 'file_backed',
            entryPath,
            ...(useDevelopmentEntry ? {
                devEntryPath: entryPath,
                useDevelopmentEntry: true,
            } : {}),
            trustPolicy: target.sourceSpec?.trustPolicy,
            committedAuthorization: {
                pluginId: target.pluginId,
                immutableGenerationId: admitted.immutableGenerationId,
                distribution: admitted.installation.source.distribution,
                trust: admitted.installation.trust,
                admittedIntegrity: admitted.installation.source.admittedIntegrity,
                packageDigest: admitted.record.packageDigest,
                isCurrent: committed.isCurrent,
            },
        };
    };
    const committedContributes = committed
        ? (params?.generationAuthority
            ? contributes
            : params?.contributes
            ? await resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir })
            : contributes)
        : null;
    if (committed && committedContributes) {
        await assertCommittedResourceActivationIdentity({
            candidate: contributes,
            canonical: committedContributes,
            committed,
        });
    }
    // Activation only registers handlers. Their invocation-service view is
    // late-bound here because the canonical owner needs the completed
    // activation registry to construct its event/MCP/resource hosts.
    let invocationServiceOwners: ReturnType<typeof createProductionPluginInvocationServiceOwners>;
    let disposeInvocationServiceOwners: () => Promise<void> = async () => {};
    let resolvedRuntimeRegistryOwner: ResolvedExecutablePluginRuntimeRegistry | null = null;
    const retainedActivationRegistryLeases = [...(params?.retainedActivationRegistryLeases ?? [])];
    const immutableGenerationIdsByPluginId = new Map(
        [...(committed?.generations.entries() ?? [])].map(([pluginId, admitted]) => [
            pluginId,
            admitted.immutableGenerationId,
        ]),
    );
    for (const target of collectActivationTargets(contributes)) {
        if (
            immutableGenerationIdsByPluginId.has(target.pluginId)
            || target.sourceSpec.kind !== 'bundled'
        ) {
            continue;
        }
        immutableGenerationIdsByPluginId.set(
            target.pluginId,
            `bundled-runtime:${generation}:${target.manifestDigest}`,
        );
    }
    let adoptActivationComponent: (component: Readonly<{
        pluginId: string;
        registry: ActivatedPluginRuntimeRegistry;
    }>) => void = () => {
        throw new Error('Plugin runtime activation component custody is not ready');
    };
    const activationParams: Omit<
        Parameters<typeof activatePluginRuntimeRegistry>[0],
        'pluginIds' | 'retainedRegistries'
    > = {
        contributes,
        generation,
        immutableGenerationIdsByPluginId,
        activationAdmissionFailuresByPluginId: new Map(
            [...(committed?.rejectedGenerations.entries() ?? [])].map(([pluginId, rejected]) => [
                pluginId,
                Object.freeze({
                    immutableGenerationId: rejected.immutableGenerationId,
                    message: rejected.message,
                    isCurrent: committed!.isCurrent,
                }),
            ]),
        ),
        happyHomeDir: params?.happyHomeDir,
        resolveActivationSource: resolveCommittedActivationSource,
        ...(params?.onActivationAttempt ? { onActivationAttempt: params.onActivationAttempt } : {}),
        adoptActivationComponent: (component) => adoptActivationComponent(component),
        invocationServices: {
            createOrdinaryServiceBinding(bindingGeneration, id) {
                return invocationServiceOwners.createOrdinaryServiceBinding(bindingGeneration, id);
            },
            createServices(seed, binding) {
                return invocationServiceOwners.createServices(seed, binding);
            },
            resolveInvocationHostPolicy(target, context) {
                return invocationServiceOwners.resolveInvocationHostPolicy(target, context);
            },
        },
    };
    const preparedActivationRegistryLeaseOwners: Array<Readonly<{
        retain(): PluginRuntimeActivationRegistryLease;
    }>> = (params?.preparedActivationRegistryLeases ?? []).map((lease) => (
        Object.freeze({ retain: () => lease.retain() })
    ));
    const activationInvocationServicesOwner = createPluginRuntimeInvocationServicesLeaseOwner(
        async () => await disposeInvocationServiceOwners(),
    );
    const createActivationComponentOwner = (
        registry: ActivatedPluginRuntimeRegistry,
        pluginIds: ReadonlySet<string>,
    ) => {
        const invocationServicesLease = activationInvocationServicesOwner.retain();
        return createPluginRuntimeActivationRegistryLeaseOwner(
            registry,
            pluginIds,
            async (options) => {
                const results = await Promise.allSettled([
                    registry.dispose(options),
                    invocationServicesLease.release(),
                ]);
                const failures = results.flatMap((result) => (
                    result.status === 'rejected' ? [result.reason] : []
                ));
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        'Failed to dispose plugin activation component',
                    );
                }
            },
        );
    };
    let preparingActivationComponents = (params?.pluginIds?.length ?? 0) > 0;
    adoptActivationComponent = ({ pluginId, registry }) => {
        const componentOwner = createActivationComponentOwner(
            registry,
            new Set([pluginId]),
        );
        retainedActivationRegistryLeases.push(componentOwner.retain());
        if (preparingActivationComponents) {
            preparedActivationRegistryLeaseOwners.push(componentOwner);
        }
    };
    const composedInvocationServicesLease = activationInvocationServicesOwner.retain();
    let activatedRegistry: ActivatedPluginRuntimeRegistry;
    try {
        activatedRegistry = await activatePluginRuntimeRegistry({
            ...activationParams,
            ...(params?.pluginIds === undefined ? {} : { pluginIds: params.pluginIds }),
            retainedRegistries: retainedActivationRegistryLeases.map((lease) => lease.registry),
        });
    } catch (error) {
        const cleanup = await Promise.allSettled([
            ...retainedActivationRegistryLeases.map((lease) => lease.release()),
            composedInvocationServicesLease.release(),
        ]);
        const cleanupFailures = cleanup.flatMap((result) => (
            result.status === 'rejected' ? [result.reason] : []
        ));
        if (cleanupFailures.length > 0) {
            throw new AggregateError(
                [error, ...cleanupFailures],
                'Plugin activation component preparation and cleanup failed',
            );
        }
        throw error;
    } finally {
        preparingActivationComponents = false;
    }
    const composedOwner = createPluginRuntimeActivationRegistryLeaseOwner(
        activatedRegistry,
        new Set(retainedActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds])),
        async (options) => {
            const results = await Promise.allSettled([
                activatedRegistry.dispose(options),
                ...retainedActivationRegistryLeases.map((lease) => lease.release(options)),
                composedInvocationServicesLease.release(),
            ]);
            const failures = results.flatMap((result) => (
                result.status === 'rejected' ? [result.reason] : []
            ));
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, 'Failed to dispose composed plugin activation registry');
            }
        },
    );
    const activationRegistryLease = composedOwner.retain();
    const authoritativeContributes = mergeActivatedContributes(contributes, activatedRegistry);
    const committedResourceGenerations = new Map(
        [...(committed?.generations.entries() ?? [])].map(([pluginId, generation]) => [
            pluginId,
            Object.freeze({
                pluginId,
                immutableGenerationId: generation.immutableGenerationId,
                rootPath: generation.rootPath,
                files: generation.record.files,
            }),
        ]),
    );
    // Some runtime callers provide an already-resolved registry for their own
    // projection lifecycle. Resource authority must not be inherited from that
    // optional handoff: re-resolve the store-owned current projection before
    // joining declarations to the durable commit. The authoritative execution
    // scope still bounds which canonical resource plugins this runtime may expose.
    const admittedResourcePluginIds = new Set([
        ...authoritativeContributes.resources.flatMap((resource) => (
            resource.pluginId ? [resource.pluginId] : []
        )),
        ...(authoritativeContributes.promptAssets ?? []).map((asset) => asset.pluginId),
    ]);
    const committedResourceContributes = (committedContributes?.resources ?? authoritativeContributes.resources)
        .filter((resource) => (
            resource.pluginId !== undefined && admittedResourcePluginIds.has(resource.pluginId)
        ));
    const resourcesOwner = committed && committedResourceGenerations.size > 0
        ? await createStablePluginResourcesOwner({
            registry: {
                generationId: String(activatedRegistry.generation),
                resources: committedResourceContributes.flatMap((resource) => {
                    if (resource.pluginId === undefined) return [];
                    const generation = committed?.generations.get(resource.pluginId);
                    if (!generation) return [];
                    if (resource.manifestDigest !== generation.record.manifestDigest) {
                        throw new Error(`Committed resource manifest identity mismatch for '${resource.pluginId}'`);
                    }
                    return [Object.freeze({ ...resource, pluginRootPath: generation.rootPath })];
                }),
            },
            generations: committedResourceGenerations,
            isCommittedGenerationCurrent: committed.isCurrent,
        })
        : undefined;
    for (const asset of authoritativeContributes.promptAssets ?? []) {
        const assetGeneration = committed?.generations.get(asset.pluginId);
        if (assetGeneration && asset.manifestDigest !== assetGeneration.record.manifestDigest) {
            throw new Error(`Committed prompt asset manifest identity mismatch for '${asset.pluginId}'`);
        }
    }
    let allRuntimeConsumersRetired = false;
    const allRuntimeConsumerRetirement = new AbortController();
    const retiredRuntimeConsumerPluginIds = new Set<string>();
    const runtimeConsumerLifecycles = new Map<string, Readonly<{
        controller: AbortController;
        isCurrent(): boolean;
        retirementSignal: AbortSignal;
    }>>();
    const createRetiredPluginGenerationError = (pluginId: string): PluginError => new PluginError({
        code: 'plugin_generation_stale',
        message: `Plugin runtime generation '${pluginId}' retired`,
    });
    const resolveRuntimeConsumerLifecycle = (pluginId: string) => {
        const existing = runtimeConsumerLifecycles.get(pluginId);
        if (existing) return existing;
        const controller = new AbortController();
        const lifecycle = Object.freeze({
            controller,
            isCurrent: () => (
                !allRuntimeConsumersRetired
                && !retiredRuntimeConsumerPluginIds.has(pluginId)
            ),
            retirementSignal: controller.signal,
        });
        runtimeConsumerLifecycles.set(pluginId, lifecycle);
        if (allRuntimeConsumersRetired || retiredRuntimeConsumerPluginIds.has(pluginId)) {
            controller.abort(createRetiredPluginGenerationError(pluginId));
        }
        return lifecycle;
    };
    const isPluginConsumerCurrent = (pluginId: string): boolean => (
        resolveRuntimeConsumerLifecycle(pluginId).isCurrent()
    );
    const composePluginConsumerSignal = (
        pluginId: string,
        callerSignal?: AbortSignal,
    ): AbortSignal => {
        const retirementSignal = resolveRuntimeConsumerLifecycle(pluginId).retirementSignal;
        return callerSignal
            ? AbortSignal.any([callerSignal, retirementSignal])
            : retirementSignal;
    };
    const retirePluginConsumers = (pluginIds: readonly string[]): void => {
        for (const pluginId of new Set(pluginIds)) {
            retiredRuntimeConsumerPluginIds.add(pluginId);
            const lifecycle = resolveRuntimeConsumerLifecycle(pluginId);
            if (!lifecycle.controller.signal.aborted) {
                lifecycle.controller.abort(createRetiredPluginGenerationError(pluginId));
            }
        }
    };
    const buildAgentRuntimeRegistry = () => createDeclarativeAcpAgentRuntimeRegistry({
        agents: authoritativeContributes.agents,
        registered: createTargetAgentRuntimeRegistry({
            agents: authoritativeContributes.agents,
            activationTargets: collectActivationTargets(authoritativeContributes),
            targetRegistrations: activatedRegistry.targetRegistrations,
            immutableGenerationIdsByPluginId,
            isGenerationActive: () => !allRuntimeConsumersRetired,
            resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
            createAgentInvocationServices(agentParams) {
                if (!resolvedRuntimeRegistryOwner) {
                    throw new Error(
                        'Executable plugin runtime registry is not ready for Agent invocation',
                    );
                }
                return resolvedRuntimeRegistryOwner
                    .createAgentInvocationServices(agentParams);
            },
            onDuplicate() {
                // Each component activation validates its registrations against
                // the complete authoritative Agent graph and owns diagnostics.
            },
        }),
        generation: String(activatedRegistry.generation),
        immutableGenerationIdsByPluginId,
        isGenerationActive: () => !allRuntimeConsumersRetired,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
    });
    const agentRuntimesByAgentId = buildAgentRuntimeRegistry();
    const refreshAgentRuntimeRegistry = (): void => {
        const next = buildAgentRuntimeRegistry();
        agentRuntimesByAgentId.clear();
        for (const [agentId, lease] of next) {
            agentRuntimesByAgentId.set(agentId, lease);
        }
    };
    const systemToolDefinitionsByPluginId = new Map(
        activatedRegistry.systemToolDefinitionsByPluginId,
    );
    const systemToolServicesByPluginId = new Map<
        string,
        ReturnType<typeof createPluginExecSystemToolResolver>
    >();
    const refreshSystemToolRegistries = (): void => {
        const declarativeAcpPluginIds = new Set(
            [...agentRuntimesByAgentId.values()]
                .filter((lease) => !activatedRegistry.agentRuntimesByAgentId.has(lease.agentId))
                .map((lease) => lease.pluginId),
        );
        const nextDefinitionsByPluginId = new Map(
            activatedRegistry.systemToolDefinitionsByPluginId,
        );
        for (const tool of authoritativeContributes.systemTools ?? []) {
            if (!tool.pluginId || !declarativeAcpPluginIds.has(tool.pluginId)) continue;
            const existing = nextDefinitionsByPluginId.get(tool.pluginId) ?? Object.freeze([]);
            if (existing.some((definition) => definition.id === tool.definition.id)) continue;
            nextDefinitionsByPluginId.set(
                tool.pluginId,
                Object.freeze([...existing, tool.definition]),
            );
        }
        systemToolDefinitionsByPluginId.clear();
        systemToolServicesByPluginId.clear();
        for (const [pluginId, definitions] of nextDefinitionsByPluginId) {
            systemToolDefinitionsByPluginId.set(pluginId, definitions);
            systemToolServicesByPluginId.set(
                pluginId,
                createPluginExecSystemToolResolver({
                    definitions: projectPluginSystemToolContributions(definitions),
                    // Stable invocation services consume the returned launch
                    // immediately; no V1 grant identity crosses this boundary.
                    registerGrant() {},
                }),
            );
        }
    };
    const agentCliService = createPluginAgentCliReadinessService();
    refreshSystemToolRegistries();
    const emptySystemToolService = createPluginExecSystemToolResolver({
        definitions: Object.freeze([]),
        registerGrant() {},
    });
    function createMcpTargetContext(contextParams: Readonly<{
        ref: PluginMcpServerRef;
        family: 'mcp.servers' | 'mcp.discoveryProviders';
        entry: (typeof activatedRegistry.targetRegistrations)[number];
        pluginVersion: string;
        callerSeed: PluginInvocationServicesSeed;
        signal?: AbortSignal;
    }>): PluginInvocationContext {
        const runtimeSeed = Object.freeze({
            plugin: Object.freeze({ id: contextParams.ref.pluginId, version: contextParams.pluginVersion }),
            contribution: Object.freeze({
                id: contextParams.ref.localId,
                qualifiedId: `${contextParams.ref.pluginId}/${contextParams.family}/${contextParams.ref.localId}`,
            }),
            generation: contextParams.entry.generation,
            correlationId: randomUUID(),
            surface: 'mcp' as const,
            ...(contextParams.callerSeed.session ? { session: contextParams.callerSeed.session } : {}),
            ...(contextParams.callerSeed.currentSession
                ? { currentSession: contextParams.callerSeed.currentSession }
                : {}),
            signal: contextParams.signal ?? contextParams.callerSeed.signal,
            isGenerationCurrent: () => (
                contextParams.callerSeed.isGenerationCurrent()
                && activatedRegistry.targetRegistrations.includes(contextParams.entry)
            ),
        });
        const serviceBinding = addMcpAvailablePluginInvocationServiceBinding(
            invocationServiceOwners.createOrdinaryServiceBinding(
                contextParams.entry.generation,
                `${runtimeSeed.contribution.qualifiedId}:binding`,
            ),
        );
        const services = invocationServiceOwners.createServices(runtimeSeed, serviceBinding);
        return Object.freeze({
            plugin: runtimeSeed.plugin,
            contribution: runtimeSeed.contribution,
            surface: runtimeSeed.surface,
            ...(runtimeSeed.session ? { session: runtimeSeed.session } : {}),
            signal: runtimeSeed.signal,
            services,
            ui: createPluginInvocationUi({
                currentSession: runtimeSeed.session ? runtimeSeed.currentSession ?? null : null,
                signal: runtimeSeed.signal,
                isGenerationCurrent: runtimeSeed.isGenerationCurrent,
            }),
        });
    }
    const mcpDiscoveryAttachments = new Map<string, Readonly<{
        servers: NonNullable<PluginMcpDiscoveryResult['servers']>;
        warnings: NonNullable<PluginMcpDiscoveryResult['warnings']>;
    }>>();
    const mcpDiscoveryAttachmentKey = (
        correlationId: string,
        ref: Readonly<{ pluginId: string; localId: string }>,
    ) => `${correlationId}\0${ref.pluginId}\0${ref.localId}`;
    let declaredMcpTransportConnector: DeclaredTransportConnector | null = null;
    const mcpHost = createStablePluginMcpHost({
        generation: String(activatedRegistry.generation),
        servers: authoritativeContributes.mcpServers ?? Object.freeze([]),
        discoveryProviders: authoritativeContributes.mcpDiscoveryProviders ?? Object.freeze([]),
        async activateOnDemand(ref, family) {
            await activateContributionsOnDemand([{
                pluginId: ref.pluginId,
                family,
                localId: ref.localId,
            }]);
        },
        readServer(ref) {
            const entry = [...activatedRegistry.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === ref.pluginId
                && candidate.generation === String(activatedRegistry.generation)
                && candidate.registration.family === 'mcp.servers'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'mcp.servers') return null;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === ref.pluginId
                && fact.generation === entry.generation
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) return null;
            const runtime = entry.registration.value;
            return Object.freeze({
                generation: entry.generation,
                qualifiedId: `${ref.pluginId}/${ref.localId}`,
                isCurrent: () => activatedRegistry.targetRegistrations.includes(entry),
                async listTools(request, callerSeed, options) {
                    const context = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    return await runtime.listTools(request, context, options);
                },
                async callTool(request, callerSeed, options) {
                    const context = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    return await runtime.callTool(request, context, options);
                },
            });
        },
        readDiscoveryProvider(ref) {
            const entry = [...activatedRegistry.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === ref.pluginId
                && candidate.generation === String(activatedRegistry.generation)
                && candidate.registration.family === 'mcp.discoveryProviders'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'mcp.discoveryProviders') return null;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === ref.pluginId
                && fact.generation === entry.generation
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) return null;
            const discover = entry.registration.value;
            return Object.freeze({
                generation: entry.generation,
                qualifiedId: `${ref.pluginId}/${ref.localId}`,
                isCurrent: () => activatedRegistry.targetRegistrations.includes(entry),
                async discover(query, callerSeed, options) {
                    const context = createMcpTargetContext({
                        ref, family: 'mcp.discoveryProviders', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    const inputQuery = query.input !== undefined
                        && isJsonRecord(query.input)
                        && typeof query.input.query === 'string'
                        ? query.input.query
                        : undefined;
                    const inputRecord = query.input !== undefined && isJsonRecord(query.input)
                        ? query.input
                        : null;
                    const result = await discover(Object.freeze({
                        ...(inputQuery === undefined ? {} : { query: inputQuery }),
                        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                        ...(query.limit === undefined ? {} : { limit: query.limit }),
                        ...(callerSeed.session ? { sessionId: callerSeed.session.id } : {}),
                        ...(typeof inputRecord?.accountId === 'string' ? { accountId: inputRecord.accountId } : {}),
                        ...(typeof inputRecord?.workspaceId === 'string' ? { workspaceId: inputRecord.workspaceId } : {}),
                        ...(typeof inputRecord?.directory === 'string' ? { directory: inputRecord.directory } : {}),
                    }), context);
                    mcpDiscoveryAttachments.set(
                        mcpDiscoveryAttachmentKey(callerSeed.correlationId, ref),
                        Object.freeze({
                            servers: Object.freeze([...(result.servers ?? [])]),
                            warnings: projectPluginMcpDiscoveryWarnings(result.warnings),
                        }),
                    );
                    return Object.freeze({
                        items: Object.freeze([...(result.items ?? [])]),
                        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
                    });
                },
            });
        },
        connectDeclaredTransport: async (connectorParams) => {
            if (!declaredMcpTransportConnector) {
                throw new PluginError({
                    code: 'plugin_mcp_transport_unavailable',
                    message: 'Declared MCP transport is unavailable',
                });
            }
            return await declaredMcpTransportConnector(connectorParams);
        },
        isDeclaredTransportAvailable: (declaration) => (
            declaration.definition.kind === 'static'
            && (
                declaration.definition.transport.kind === 'http'
                || declaration.definition.transport.kind === 'stdio'
            )
        ),
        revalidateFinalPolicy: async (effect) => await revalidateStableMcpFinalPolicy(effect),
    });
    const stableFetchHost = createStablePluginFetchHost({
        adapter: createGlobalFetchRuntime(),
        credentialBindingHost: createVoiceAccountPluginFetchCredentialBindingHost({
            voiceProviders: authoritativeContributes.voiceProviders ?? Object.freeze([]),
            // App-client requests are account-scoped and must not inherit a
            // daemon machine's credential override.
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
        }),
        interceptorRegistry: {
            declarations: Object.freeze((authoritativeContributes.requestInterceptors ?? []).flatMap((entry) => (
                entry.pluginId
                    ? [Object.freeze({ pluginId: entry.pluginId, contribution: entry.definition })]
                    : []
            ))),
            activateContributionsOnDemand,
            readBindings: () => Object.freeze((activatedRegistry.requestInterceptors ?? []).map((binding) => Object.freeze({
                pluginId: binding.pluginId,
                contribution: binding.contribution,
                invoke: async (
                    request: PluginInterceptedRequest,
                    signal: AbortSignal | undefined,
                ) => await invokeRequestInterceptor(binding, request, signal),
            }))),
        },
        revalidateFinalPolicy: async (effect) => await revalidateStableFetchFinalPolicy(effect),
    });
    const managedDependencySourceModel = createV2ManagedDependencySourceModelFromRegistry({
        registry: {
            generationId: String(activatedRegistry.generation),
            managedDependencies: authoritativeContributes.managedDependencies ?? Object.freeze([]),
        },
        platform: resolveManagedDependencyHostPlatform(),
        architecture: process.arch,
    });
    const managedDependencies = createStablePluginManagedDependenciesHost({
        // V2 request semantics remain source-model owned. Complete managed
        // PyPI sources also project through the same installables descriptor
        // owner used by capability/UI installation.
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(
            authoritativeContributes.managedDependencies ?? Object.freeze([]),
        ),
        sourceModel: managedDependencySourceModel,
        getSettings: () => ({}),
        resolveAdapter: getRuntimeInstallableAdapter,
        resolveSourceAdapter: createProductionManagedDependencySourceAdapter,
        async removeManagedInstall() {
            throw new PluginError({
                code: 'plugin_managed_dependency_remove_unsupported',
                message: 'Managed dependency removal is unavailable for this source',
            });
        },
        async removeManagedSource({ adapter }) {
            if (!adapter.removeManagedInstall) {
                throw new PluginError({
                    code: 'plugin_managed_dependency_remove_unsupported',
                    message: 'Managed dependency removal is unavailable for this source',
                });
            }
            await adapter.removeManagedInstall();
        },
    });
    const systemToolContext = createDaemonSpawnToolResolutionContext({ processEnv: process.env });
    const executableResolver = createStableManagedExecutableResolver({
        systemTools: authoritativeContributes.systemTools ?? Object.freeze([]),
        managedDependencies,
        async resolveSystemTool(request) {
            const resolved = await systemToolContext.resolveSystemTool({
                toolId: request.toolId,
                lookupNames: request.executableNames,
                reason: 'Execute a plugin-declared system tool',
            });
            if (!resolved.ok) {
                throw new PluginError({ code: 'plugin_system_tool_unavailable', message: 'System tool is unavailable' });
            }
            return Object.freeze({
                toolId: request.toolId,
                command: resolved.command,
                args: resolved.args,
                env: Object.freeze({ PATH: '' }),
            });
        },
    });
    declaredMcpTransportConnector = createStableDeclaredMcpTransportConnector({
        resolveExecutable: executableResolver,
    });
    invocationServiceOwners = createProductionPluginInvocationServiceOwners({
        ...(params?.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
        ...(params?.connectedAccounts ? { connectedAccounts: params.connectedAccounts } : {}),
        async authorizeSecretAccess(effect) {
            if (
                effect.signal?.aborted
                || !isPluginConsumerCurrent(effect.pluginId)
                || effect.generation !== String(activatedRegistry.generation)
                || !activatedRegistry.activatedPluginIds.has(effect.pluginId)
            ) return false;
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === effect.pluginId
            ));
            if (!target) return false;
            const currentAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
                { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
            );
            if (!currentAuthority || !await currentAuthority.isCurrent()) return false;
            const current = resolveCurrentFinalPolicyGeneration(
                effect.pluginId,
                target.manifestDigest,
                currentAuthority,
            );
            const matchingScopes = effect.scopes.filter((scope) => (
                scope.secretIds.includes(effect.secretId)
                && (effect.access === 'status' || scope.access.includes(effect.access))
            ));
            if (matchingScopes.length === 0) return false;
            const authorizedByRequiredScope = matchingScopes.some((scope) => scope.required);
            const authorizedOptionalScope = authorizedByRequiredScope
                ? null
                : matchingScopes.find((scope) => {
                    if (scope.required) return false;
                    const optionalRequest = target.manifest.hostAccess.optional.find((request) => (
                        request.id === scope.accessId
                        && request.capability === 'secrets'
                        && request.scope.secretIds.includes(effect.secretId)
                        && (
                            effect.access === 'status'
                            || request.scope.access.includes(effect.access)
                        )
                    ));
                    return optionalRequest !== undefined
                        && isPluginHostAccessRequestAuthorizedBySelection({
                            pluginId: effect.pluginId,
                            request: optionalRequest,
                            required: false,
                            optionalAccess: current?.selectedAccess ?? Object.freeze([]),
                        });
                }) ?? null;
            const selected = authorizedByRequiredScope || authorizedOptionalScope !== null;
            const authorizationFacts = resolvePluginFinalPolicyAuthorizationFacts({
                pluginId: effect.pluginId,
                targetManifestDigest: target.manifestDigest,
                current,
                ...(authorizedByRequiredScope ? {} : {
                    resourceSelections: [Object.freeze({
                        id: authorizedOptionalScope?.accessId ?? matchingScopes[0]!.accessId,
                        required: true,
                        requestedResourceId: `secret:${effect.secretId}:${effect.access}`,
                        ...(selected ? { selectedResourceId: `secret:${effect.secretId}:${effect.access}` } : {}),
                    })],
                }),
            });
            const decision = evaluatePluginFinalPolicy({
                ...authorizationFacts,
                serviceAvailability: [Object.freeze({
                    id: 'secrets',
                    required: true,
                    status: 'available' as const,
                })],
                currentIntent: 'notRequired',
            });
            return decision.outcome === 'visible'
                && !effect.signal?.aborted
                && isPluginConsumerCurrent(effect.pluginId)
                && effect.generation === String(activatedRegistry.generation)
                && activatedRegistry.activatedPluginIds.has(effect.pluginId)
                && await currentAuthority.isCurrent();
        },
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess ?? Object.freeze([]);
        },
        async isGenerationCurrent(action) {
            return isPluginConsumerCurrent(action.pluginId)
                && action.generation === String(activatedRegistry.generation)
                && activatedRegistry.activatedPluginIds.has(action.pluginId)
                && (!committed || await committed.isCurrent());
        },
        storagePaths: resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
        settingsDeclarations: [
            ...(authoritativeContributes.settings ?? []),
            ...resolveNotificationChannelSettingsContributions(
                authoritativeContributes.notificationChannels ?? [],
            ),
        ].flatMap((entry) => (
            entry.pluginId
                ? [Object.freeze({ pluginId: entry.pluginId, contribution: entry.definition })]
                : []
        )),
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
        permissionDeclarationsByPluginId: activatedRegistry.permissionDeclarationsByPluginId,
        activePluginIds: activatedRegistry.activatedPluginIds,
        notifications: {
            categories: authoritativeContributes.notifications ?? Object.freeze([]),
            channels: authoritativeContributes.notificationChannels ?? Object.freeze([]),
            preferencePolicy: {
                read(preference) {
                    const snapshot = getActiveAccountSettingsSnapshot();
                    const enabled = preference.channelKind === 'plugin'
                        ? true
                        : resolveAttentionDeliveryPolicyDecision({
                            policy: snapshot?.settings.attentionDeliveryPolicyV1,
                            event: preference.eventIds[0] ?? preference.categoryId,
                            channel: preference.channelKind,
                            now: new Date(),
                        }).delivery !== 'suppress';
                    return Object.freeze({
                        enabled,
                        revision: snapshot
                            ? `${snapshot.scopeKey ?? snapshot.source}:${snapshot.settingsVersion}`
                            : 'unavailable',
                    });
                },
                watch(preference) {
                    const unsubscribe = subscribeActiveAccountSettingsSnapshot(() => {
                        preference.listener();
                    });
                    return Object.freeze({ dispose: unsubscribe });
                },
            },
            async activateChannel(ref) {
                await activateContributionsOnDemand([{
                    pluginId: ref.pluginId,
                    family: 'notificationChannels',
                    localId: ref.localId,
                }]);
            },
            readChannel(ref, callerSeed) {
                const entry = [...activatedRegistry.targetRegistrations].reverse().find((candidate) => (
                    candidate.pluginId === ref.pluginId
                    && candidate.generation === callerSeed.generation
                    && candidate.registration.family === 'notificationChannels'
                    && candidate.registration.localId === ref.localId
                ));
                if (!entry || entry.registration.family !== 'notificationChannels') return null;
                const sender = entry.registration.value;
                const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                    fact.pluginId === ref.pluginId
                    && fact.generation === entry.generation
                    && fact.status === 'active'
                ))?.pluginVersion;
                if (!pluginVersion) return null;
                const channelTarget = authoritativeContributes.activationTargets.find((target) => (
                    target.pluginId === ref.pluginId
                    && target.manifest.contributes.notificationChannels?.some((channel) => (
                        channel.id === ref.localId
                    )) === true
                ));
                if (!channelTarget) return null;
                const channelHostAccessRequests = Object.freeze([
                    ...channelTarget.manifest.hostAccess.required.map((request) => Object.freeze({
                        request,
                        required: true,
                    })),
                    ...channelTarget.manifest.hostAccess.optional.map((request) => Object.freeze({
                        request,
                        required: false,
                    })),
                ]);
                return Object.freeze({
                    generation: entry.generation,
                    isCurrent: async () => (
                        isPluginConsumerCurrent(ref.pluginId)
                        && callerSeed.isGenerationCurrent()
                        && activatedRegistry.targetRegistrations.includes(entry)
                        && committed !== null
                        && await committed.isCurrent()
                    ),
                    async send(request, signal) {
                        const channelSeed = Object.freeze({
                            plugin: Object.freeze({ id: ref.pluginId, version: pluginVersion }),
                            contribution: Object.freeze({
                                id: ref.localId,
                                qualifiedId: `${ref.pluginId}/notificationChannels/${ref.localId}`,
                            }),
                            generation: entry.generation,
                            correlationId: randomUUID(),
                            surface: callerSeed.surface,
                            ...(callerSeed.session ? { session: callerSeed.session } : {}),
                            ...(callerSeed.currentSession
                                ? { currentSession: callerSeed.currentSession }
                                : {}),
                            signal: composePluginConsumerSignal(ref.pluginId, signal),
                            isGenerationCurrent: () => (
                                callerSeed.isGenerationCurrent()
                                && activatedRegistry.targetRegistrations.includes(entry)
                            ),
                        });
                        const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                            entry.generation,
                            `${channelSeed.contribution.qualifiedId}:binding`,
                            channelHostAccessRequests,
                        );
                        const services = invocationServiceOwners.createServices(channelSeed, serviceBinding);
                        const context: PluginInvocationContext = Object.freeze({
                            plugin: channelSeed.plugin,
                            contribution: channelSeed.contribution,
                            surface: channelSeed.surface,
                            ...(channelSeed.session ? { session: channelSeed.session } : {}),
                            signal: channelSeed.signal,
                            services,
                            ui: createPluginInvocationUi({
                                currentSession: callerSeed.session
                                    ? callerSeed.currentSession ?? null
                                    : null,
                                signal: channelSeed.signal,
                                isGenerationCurrent: channelSeed.isGenerationCurrent,
                            }),
                        });
                        return await Reflect.apply(sender, undefined, [request, context]);
                    },
                });
            },
        },
        mcp: mcpHost,
        fetch: stableFetchHost,
        ...(resourcesOwner ? { resources: resourcesOwner } : {}),
        exec: {
            agentCli: agentCliService,
            systemToolsForPlugin(pluginId) {
                return systemToolServicesByPluginId.get(pluginId) ?? emptySystemToolService;
            },
            resolveExecutable: executableResolver,
            async resolvePath() {
                throw new PluginError({
                    code: 'plugin_exec_cwd_unavailable',
                    message: 'Plugin working-directory resolution requires an authorized filesystem owner',
                });
            },
        },
        managed: {
            dependenciesHost: managedDependencies,
            dependencyGeneration: managedDependencySourceModel.generationId,
        },
    });
    disposeInvocationServiceOwners = async () => await invocationServiceOwners.dispose();
    const declaredEventSubscriptionBindings = new Map<string, Awaited<ReturnType<
        typeof invocationServiceOwners.bindDeclaredEventSubscriptions
    >>>();
    function refreshDeclaredEventSubscriptionBindings(): void {
        for (const entry of activatedRegistry.targetRegistrations) {
            if (entry.registration.family !== 'events') continue;
            const key = `${entry.pluginId}\u0000${entry.generation}\u0000${entry.registration.localId}`;
            if (declaredEventSubscriptionBindings.has(key)) continue;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === entry.pluginId
                && fact.generation === entry.generation
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) {
                throw new Error(`Active event subscription '${entry.pluginId}/${entry.registration.localId}' has no activation identity`);
            }
            const registration = entry.registration;
            const binding = invocationServiceOwners.bindDeclaredEventSubscriptions({
                registrations: [Object.freeze({
                    pluginId: entry.pluginId,
                    pluginVersion,
                    generation: entry.generation,
                    localId: registration.localId,
                    handler: (payload, context) => Reflect.apply(registration.value, undefined, [payload, context]),
                })],
                isGenerationCurrent: () => (
                    isPluginConsumerCurrent(entry.pluginId)
                    && activatedRegistry.targetRegistrations.includes(entry)
                    && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                ),
                createContext(contextInput) {
                    const seed = Object.freeze({
                        plugin: Object.freeze({ id: contextInput.pluginId, version: contextInput.pluginVersion }),
                        contribution: Object.freeze({
                            id: contextInput.localId,
                            qualifiedId: `${contextInput.pluginId}/events/${contextInput.localId}`,
                        }),
                        generation: contextInput.generation,
                        correlationId: randomUUID(),
                        surface: 'cli' as const,
                        signal: composePluginConsumerSignal(entry.pluginId, contextInput.signal),
                        isGenerationCurrent: () => (
                            !contextInput.signal.aborted
                            && isPluginConsumerCurrent(entry.pluginId)
                            && activatedRegistry.targetRegistrations.includes(entry)
                            && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                        ),
                    });
                    const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                        seed.generation,
                        `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                    );
                    const services = invocationServiceOwners.createServices(seed, serviceBinding);
                    return Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationUi({
                            currentSession: null,
                            signal: seed.signal,
                            isGenerationCurrent: seed.isGenerationCurrent,
                        }),
                    });
                },
            });
            declaredEventSubscriptionBindings.set(key, binding);
        }
    }
    refreshDeclaredEventSubscriptionBindings();
    const resolveCurrentFinalPolicyGeneration = (
        pluginId: string,
        targetManifestDigest: string,
        authority: PluginRuntimeGenerationAuthority | null = committed,
    ): PluginFinalPolicyCurrentGeneration | null => {
        const activationTarget = authoritativeContributes.activationTargets.find((target) => (
            target.pluginId === pluginId && target.manifestDigest === targetManifestDigest
        ));
        const admitted = authority?.generations.get(pluginId);
        if (!admitted) {
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(pluginId);
            if (
                !activationTarget
                || activationTarget.sourceSpec.kind !== 'bundled'
                || !immutableGenerationId
            ) {
                return null;
            }
            return Object.freeze({
                immutableGenerationId,
                packageDigest:
                    activationTarget.sourceSpec.resolvedDigest
                    ?? activationTarget.manifestDigest,
                manifestDigest: activationTarget.manifestDigest,
                distribution: 'bundled',
                applied: Boolean(
                    activatedRegistry.activatedPluginIds.has(pluginId)
                    && activatedRegistry.targetActivationFacts.some((fact) => (
                        fact.pluginId === pluginId
                        && fact.generation === String(activatedRegistry.generation)
                        && fact.status === 'active'
                    )),
                ),
                selectedAccess: Object.freeze([]),
            });
        }
        const activationApplied = activationTarget
            ? Boolean(
                targetManifestDigest === admitted.record.manifestDigest
                && activatedRegistry.activatedPluginIds.has(pluginId)
                && activatedRegistry.targetActivationFacts.some((fact) => (
                    fact.pluginId === pluginId
                    && fact.generation === String(activatedRegistry.generation)
                    && fact.status === 'active'
                )),
            )
            : Boolean(
                admitted.installation?.enabled === true
                && targetManifestDigest === admitted.record.manifestDigest
            );
        return Object.freeze({
            immutableGenerationId: admitted.immutableGenerationId,
            packageDigest: admitted.record.packageDigest,
            manifestDigest: admitted.record.manifestDigest,
            distribution: admitted.installation?.source.distribution ?? 'bundled',
            applied: activationApplied,
            selectedAccess: Object.freeze([...(admitted.installation?.optionalAccess ?? [])]),
        });
    };
    const resolveContributionRuntimeLifecycle = (input: Readonly<{
        pluginId: string;
        manifestDigest: string;
    }>): PluginContributionRuntimeLifecycle | null => {
        const current = resolveCurrentFinalPolicyGeneration(
            input.pluginId,
            input.manifestDigest,
        );
        if (
            !current
            || current.manifestDigest !== input.manifestDigest
        ) {
            return null;
        }
        const lifecycle = resolveRuntimeConsumerLifecycle(input.pluginId);
        return Object.freeze({
            generation: current.immutableGenerationId,
            isCurrent: () => {
                const refreshed = resolveCurrentFinalPolicyGeneration(
                    input.pluginId,
                    input.manifestDigest,
                );
                return lifecycle.isCurrent()
                    && refreshed?.immutableGenerationId === current.immutableGenerationId
                    && refreshed.manifestDigest === input.manifestDigest;
            },
            retirementSignal: lifecycle.retirementSignal,
        });
    };
    const revalidateStableMcpFinalPolicy = async (
        effect: StablePluginMcpFinalPolicyEffect,
    ): Promise<void> => {
        const pluginId = effect.seed.plugin.id;
        if (
            !isPluginConsumerCurrent(pluginId)
            || effect.seed.generation !== String(activatedRegistry.generation)
            || !effect.seed.isGenerationCurrent()
            || !activatedRegistry.activatedPluginIds.has(pluginId)
        ) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation is no longer current',
            });
        }
        const target = authoritativeContributes.activationTargets.find((candidate) => (
            candidate.pluginId === pluginId
        ));
        if (!target) {
            throw new PluginError({
                code: 'plugin_final_package_untrusted',
                message: 'Plugin package identity is unavailable',
            });
        }
        const currentAuthority = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
            { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
        );
        if (currentAuthority && !await currentAuthority.isCurrent()) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const current = resolveCurrentFinalPolicyGeneration(
            pluginId,
            target.manifestDigest,
            currentAuthority,
        );
        if (!current) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const hostOwnedDiscovery = effect.operation === 'discover'
            && effect.seed.plugin.id === effect.ref.pluginId
            && effect.seed.contribution.qualifiedId
                === `${effect.ref.pluginId}/mcp.discoveryProviders/${effect.ref.localId}`;
        const resourceSelections = hostOwnedDiscovery
            ? Object.freeze([])
            : (() => {
                const operation = effect.operation === 'connect'
                    ? null
                    : effect.operation === 'list'
                        ? 'listTools' as const
                        : effect.operation;
                const requestAllowsEffect = (request: (typeof target.manifest.hostAccess.required)[number]) => {
                    if (request.capability !== 'mcp') return false;
                    const operationAllowed = operation === null
                        ? request.scope.operations.some((candidate) => candidate === 'listTools' || candidate === 'callTools')
                        : request.scope.operations.includes(operation);
                    if (!operationAllowed) return false;
                    return request.scope.serverRefs.some((reference) => (
                        typeof reference === 'string'
                            ? reference === effect.ref.localId && pluginId === effect.ref.pluginId
                            : reference.pluginId === effect.ref.pluginId && reference.localId === effect.ref.localId
                    ));
                };
                if (target.manifest.hostAccess.required.some(requestAllowsEffect)) return Object.freeze([]);
                const optionalRequest = target.manifest.hostAccess.optional.find(requestAllowsEffect);
                const selected = optionalRequest === undefined
                    ? null
                    : isPluginHostAccessRequestAuthorizedBySelection({
                        pluginId,
                        request: optionalRequest,
                        required: false,
                        optionalAccess: current?.selectedAccess ?? Object.freeze([]),
                    })
                        ? optionalRequest
                        : null;
                const resourceId = `mcp:${effect.ref.pluginId}/${effect.ref.localId}:${effect.operation}`;
                return Object.freeze([Object.freeze({
                    id: optionalRequest?.id ?? resourceId,
                    required: true,
                    requestedResourceId: resourceId,
                    ...(selected ? { selectedResourceId: resourceId } : {}),
                })]);
            })();
        const authorizationFacts = resolvePluginFinalPolicyAuthorizationFacts({
            pluginId,
            targetManifestDigest: target.manifestDigest,
            current,
            resourceSelections,
        });
        const decision = evaluatePluginFinalPolicy({
            ...authorizationFacts,
            serviceAvailability: [Object.freeze({
                id: 'mcp',
                required: true,
                status: 'available' as const,
            })],
            currentIntent: 'notRequired',
        });
        if (decision.outcome !== 'visible') {
            throw new PluginError({ code: decision.code, message: 'MCP operation is not currently authorized' });
        }
    };
    const revalidateStableFetchFinalPolicy = async (
        effect: StablePluginFetchFinalPolicyEffect,
    ): Promise<void> => {
        const pluginId = effect.seed.plugin.id;
        if (
            !isPluginConsumerCurrent(pluginId)
            || effect.seed.generation !== String(activatedRegistry.generation)
            || !effect.seed.isGenerationCurrent()
            || !activatedRegistry.activatedPluginIds.has(pluginId)
        ) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation is no longer current',
            });
        }
        const target = authoritativeContributes.activationTargets.find((candidate) => (
            candidate.pluginId === pluginId
        ));
        if (!target) {
            throw new PluginError({
                code: 'plugin_final_package_untrusted',
                message: 'Plugin package identity is unavailable',
            });
        }
        let url: URL;
        try {
            url = new URL(effect.request.url);
        } catch {
            throw new PluginError({
                code: 'plugin_final_resource_not_selected',
                message: 'Fetch URL is not currently authorized',
            });
        }
        if (
            (url.protocol !== 'http:' && url.protocol !== 'https:')
            || url.username.length > 0
            || url.password.length > 0
        ) {
            throw new PluginError({
                code: 'plugin_final_resource_not_selected',
                message: 'Fetch URL is not currently authorized',
            });
        }
        const method = (effect.request.method ?? 'GET').toUpperCase();
        const supportedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
        if (!supportedMethods.has(method)) {
            throw new PluginError({
                code: 'plugin_final_resource_not_selected',
                message: 'Fetch method is not currently authorized',
            });
        }
        const currentAuthority = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
            { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
        );
        if (currentAuthority && !await currentAuthority.isCurrent()) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const current = resolveCurrentFinalPolicyGeneration(
            pluginId,
            target.manifestDigest,
            currentAuthority,
        );
        if (!current) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const effectScope = Object.freeze({
            targets: Object.freeze([Object.freeze({ kind: 'fixedOrigin' as const, origin: url.origin })]),
            methods: Object.freeze([method]),
            ...(isLiteralPrivateNetworkHostname(url.hostname) ? { privateNetwork: true as const } : {}),
        });
        const accessScopeRegistry = createPluginNetworkEffectScopeRegistry();
        const matchingBoundScopes = (effect.serviceBinding.networkScopes ?? []).filter((scope) => (
            scope.origins.includes(url.origin)
            && (scope.methods === undefined || scope.methods.some((candidate) => candidate === method))
            && (!isLiteralPrivateNetworkHostname(url.hostname) || scope.privateNetwork)
        ));
        const requestAllowsEffect = (request: (typeof target.manifest.hostAccess.required)[number]) => {
            if (request.capability !== 'network') return false;
            const matchingSemanticScope = matchingBoundScopes.find((scope) => {
                const connectedAccountService = scope.connectedAccountService;
                if (scope.accessId !== request.id || !connectedAccountService) return false;
                return request.scope.targets.some((candidate) => {
                    if (candidate.kind !== 'connectedAccountOrigin') return false;
                    const service = typeof candidate.service === 'string'
                        ? { pluginId, localId: candidate.service }
                        : candidate.service;
                    return service.pluginId === connectedAccountService.pluginId
                        && service.localId === connectedAccountService.localId;
                });
            });
            if (matchingSemanticScope) return true;
            if (!matchingBoundScopes.some((scope) => scope.accessId === request.id)) return false;
            const comparison = accessScopeRegistry.compare('network', effectScope, request.scope);
            return comparison.relation === 'exact' || comparison.relation === 'narrower';
        };
        const requiredRequest = target.manifest.hostAccess.required.find(requestAllowsEffect);
        const optionalRequest = requiredRequest
            ? undefined
            : target.manifest.hostAccess.optional.find(requestAllowsEffect);
        const optionalRequestAuthorized = optionalRequest !== undefined
            && isPluginHostAccessRequestAuthorizedBySelection({
                pluginId,
                request: optionalRequest,
                required: false,
                optionalAccess: current?.selectedAccess ?? Object.freeze([]),
            });
        const resourceSelections = requiredRequest || optionalRequestAuthorized
            ? Object.freeze([])
            : Object.freeze([Object.freeze({
                id: optionalRequest?.id ?? `network:${url.origin}:${method}`,
                required: true,
                requestedResourceId: `network:${url.origin}:${method}`,
            })]);
        const authorizationFacts = resolvePluginFinalPolicyAuthorizationFacts({
            pluginId,
            targetManifestDigest: target.manifestDigest,
            current,
            resourceSelections,
        });
        const decision = evaluatePluginFinalPolicy({
            ...authorizationFacts,
            serviceAvailability: [Object.freeze({
                id: 'fetch',
                required: true,
                status: 'available' as const,
            })],
            currentIntent: 'notRequired',
        });
        if (decision.outcome !== 'visible') {
            throw new PluginError({ code: decision.code, message: 'Fetch operation is not currently authorized' });
        }
    };
    const resolveTargetActionAuthorizationFacts = (
        action: ResolvedTargetAction,
    ): TargetActionAuthorizationFacts => {
        const activationTarget = authoritativeContributes.activationTargets.find((target) => (
            target.pluginId === action.pluginId
            && target.manifest.contributes.actions.some((candidate) => candidate.id === action.localId)
        ));
        const targetManifestDigest = activationTarget?.manifestDigest ?? 'uncommitted';
        return resolvePluginFinalPolicyAuthorizationFacts({
            pluginId: action.pluginId,
            targetManifestDigest,
            current: resolveCurrentFinalPolicyGeneration(action.pluginId, targetManifestDigest),
            resourceSelections: resolveTargetActionResourceSelectionFacts(action),
        });
    };
    const targetActionInvocations = buildTargetActionInvocationRegistry({
        contributes: authoritativeContributes,
        generation: activatedRegistry.generation,
        targetRegistrations: activatedRegistry.targetRegistrations,
        targetActivationFacts: activatedRegistry.targetActivationFacts,
        resolveAuthorizationFacts: resolveTargetActionAuthorizationFacts,
        resolveHostBinding: invocationServiceOwners.resolveHostBinding,
        resolveHostPolicy: invocationServiceOwners.resolveHostPolicy,
        createServices: invocationServiceOwners.createServices,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
        resolveCurrentSessionUi: resolveCurrentSessionUiBinding,
    });
    const voiceSpeechProviders = createTargetVoiceSpeechRegistry({
        generation: activatedRegistry.generation,
        targetRegistrations: activatedRegistry.targetRegistrations,
        isGenerationActive: (pluginId) => isPluginConsumerCurrent(pluginId),
    });
    const projectHookHandlers = (
        handlers: readonly ResolvedPluginHookHandler[],
    ): readonly ResolvedPluginHookHandler[] => Object.freeze(handlers.map((resolved) => Object.freeze({
        ...resolved,
        async handler(event?: unknown, context?: unknown) {
            if (!isPluginConsumerCurrent(resolved.pluginId)) {
                throw new Error(`Plugin '${resolved.pluginId}' hook handler is no longer active`);
            }
            const contextRecord = context && typeof context === 'object' && !Array.isArray(context)
                ? context as Readonly<Record<string, unknown>>
                : {};
            const callerSignal = contextRecord.signal instanceof AbortSignal
                ? contextRecord.signal
                : undefined;
            const scopedContext = Object.freeze({
                ...contextRecord,
                signal: composePluginConsumerSignal(resolved.pluginId, callerSignal),
            });
            const result = await resolved.handler(event, scopedContext);
            if (!isPluginConsumerCurrent(resolved.pluginId)) {
                throw new Error(`Plugin '${resolved.pluginId}' hook handler is no longer active`);
            }
            return result;
        },
    })));
    const hookHandlersByHookId = new Map(
        [...activatedRegistry.hookHandlersByHookId].map(([hookId, handlers]) => (
            [hookId, projectHookHandlers(handlers)] as const
        )),
    );
    const pluginDiagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {
        ...mergePluginDiagnostics(
            authoritativeContributes.pluginDiagnosticsByPluginId,
            activatedRegistry.pluginDiagnosticsByPluginId,
        ),
    };

    function readCurrentScmBackendDiagnostics(): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
        return createPluginScmBackendRegistryFromRuntimeRegistry({
            contributes: authoritativeContributes,
            scmBackendsById: activatedRegistry.scmBackendsById,
            scmBackendRegistrations: activatedRegistry.scmBackendRegistrations,
            envAllowedNamesByPluginId: activatedRegistry.envAllowedNamesByPluginId,
        }).diagnosticsByPluginId;
    }

    function refreshPluginDiagnostics(
        pluginId: string,
        scmDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    ): void {
        pluginDiagnosticsByPluginId[pluginId] = Object.freeze([
            ...(authoritativeContributes.pluginDiagnosticsByPluginId[pluginId] ?? []),
            ...(activatedRegistry.activatedPluginIds.has(pluginId)
                ? (scmDiagnosticsByPluginId[pluginId] ?? [])
                : []),
            ...(activatedRegistry.pluginDiagnosticsByPluginId[pluginId] ?? []),
        ]);
    }

    const initialScmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
    for (const pluginId of activatedRegistry.activatedPluginIds) {
        refreshPluginDiagnostics(pluginId, initialScmDiagnosticsByPluginId);
    }
    const pluginFinalPolicyCurrentGenerationsById = new Map<string, PluginFinalPolicyCurrentGeneration>();
    function refreshPluginFinalPolicyCurrentGeneration(pluginId: string): void {
        const generation = committed?.generations.get(pluginId);
        if (!generation) {
            pluginFinalPolicyCurrentGenerationsById.delete(pluginId);
            return;
        }
        const current = resolveCurrentFinalPolicyGeneration(pluginId, generation.record.manifestDigest);
        if (current) {
            pluginFinalPolicyCurrentGenerationsById.set(pluginId, current);
        } else {
            pluginFinalPolicyCurrentGenerationsById.delete(pluginId);
        }
    }
    for (const [pluginId] of committed?.generations ?? []) {
        refreshPluginFinalPolicyCurrentGeneration(pluginId);
    }

    function mergeActivatedHookHandlers(): void {
        for (const [hookId, handlers] of activatedRegistry.hookHandlersByHookId.entries()) {
            hookHandlersByHookId.set(hookId, projectHookHandlers(handlers));
        }
    }

    async function invokeRequestInterceptor(
        binding: TargetRequestInterceptorBinding,
        request: PluginInterceptedRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginInterceptorResult> {
        const seed = Object.freeze({
            plugin: Object.freeze({ id: binding.pluginId, version: binding.pluginVersion }),
            contribution: Object.freeze({
                id: binding.contribution.id,
                qualifiedId: `${binding.pluginId}/requestInterceptors/${binding.contribution.id}`,
            }),
            generation: binding.generation,
            correlationId: randomUUID(),
            surface: 'agent' as const,
            signal: composePluginConsumerSignal(binding.pluginId, signal),
            isGenerationCurrent: () => (
                isPluginConsumerCurrent(binding.pluginId)
                && activatedRegistry.activatedPluginIds.has(binding.pluginId)
            ),
        });
        const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
            binding.generation,
            `${seed.contribution.qualifiedId}:binding`,
        );
        const services = invocationServiceOwners.createServices(seed, serviceBinding);
        const context: PluginInvocationContext = Object.freeze({
            plugin: seed.plugin,
            contribution: seed.contribution,
            surface: seed.surface,
            signal: seed.signal,
            services,
            ui: createPluginInvocationUi({
                currentSession: null,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            }),
        });
        return await Reflect.apply(binding.handler, undefined, [request, context]);
    }

    async function activateContributionsOnDemand(
        demands: Parameters<typeof activatedRegistry.activateContributionsOnDemand>[0],
    ): Promise<Awaited<ReturnType<typeof activatedRegistry.activateContributionsOnDemand>>> {
        const results = await activatedRegistry.activateContributionsOnDemand(demands);
        // Lazy activation publishes into the generation-owned registration/fact
        // arrays. Rebuild the complete immutable action index before exposing
        // the activation result so dispatch can never observe a half-published
        // target generation or fall through to the retired legacy path.
        targetActionInvocations.refresh();
        refreshDeclaredEventSubscriptionBindings();
        mergeActivatedHookHandlers();
        refreshAgentRuntimeRegistry();
        refreshSystemToolRegistries();
        const scmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
        for (const result of results) {
            refreshPluginFinalPolicyCurrentGeneration(result.pluginId);
            refreshPluginDiagnostics(result.pluginId, scmDiagnosticsByPluginId);
        }
        return results;
    }

    async function activatePluginsForValidation(
        pluginIds: readonly string[],
    ): Promise<Awaited<ReturnType<typeof activatedRegistry.activatePluginsForValidation>>> {
        const results = await activatedRegistry.activatePluginsForValidation(pluginIds);
        targetActionInvocations.refresh();
        refreshDeclaredEventSubscriptionBindings();
        mergeActivatedHookHandlers();
        refreshAgentRuntimeRegistry();
        refreshSystemToolRegistries();
        const scmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
        for (const result of results) {
            refreshPluginFinalPolicyCurrentGeneration(result.pluginId);
            refreshPluginDiagnostics(result.pluginId, scmDiagnosticsByPluginId);
        }
        return results;
    }

    const connectedAccountContributions = createConnectedAccountContributionRegistry({
        generation: String(activatedRegistry.generation),
        immutableGenerationIdsByPluginId,
        descriptors: authoritativeContributes.connectedAccountDescriptors ?? Object.freeze([]),
        async activateOnDemand(ref) {
            await activateContributionsOnDemand([{
                pluginId: ref.pluginId,
                family: 'connectedAccountDescriptors',
                localId: ref.localId,
            }]);
        },
        readRegistrations: () => activatedRegistry.targetRegistrations.flatMap((entry) => (
            entry.registration.family === 'connectedAccountDescriptors'
                ? [Object.freeze({
                    pluginId: entry.pluginId,
                    generation: entry.generation,
                    localId: entry.registration.localId,
                    runtime: entry.registration.value,
                })]
                : []
        )),
        isGenerationCurrent: isPluginConsumerCurrent,
    });
    const connectedAccountRuntimeInvoker = createConnectedAccountHostRuntimeInvoker({
        resolveRuntime: connectedAccountContributions.resolve,
        resolvePlugin(pluginId) {
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === pluginId
            ));
            if (!target) return null;
            return Object.freeze({
                version: target.manifest.version,
                hostAccessRequests: Object.freeze([
                    ...target.manifest.hostAccess.required.map((request) => Object.freeze({
                        request,
                        required: true,
                    })),
                    ...target.manifest.hostAccess.optional.map((request) => Object.freeze({
                        request,
                        required: false,
                    })),
                ]),
            });
        },
        resolveHostPolicy: invocationServiceOwners.resolveInvocationHostPolicy,
        createServices: invocationServiceOwners.createServices,
        resolveHostOwnedConfiguredOrigins(service, configuration) {
            const contribution = connectedAccountContributions.list().find(
                (candidate) => (
                    candidate.ref.pluginId === service.pluginId
                    && candidate.ref.localId === service.localId
                ),
            );
            if (!contribution) {
                throw new Error(
                    'Connected-account configured origin descriptor is unavailable',
                );
            }
            return resolveHostOwnedConnectedAccountConfiguredOrigins({
                service,
                descriptor: contribution.descriptor,
                configuration,
            });
        },
    });
    let consumersRetired = false;
    const connectedAccountPurposeBindingOwner = params?.connectedAccounts
        ? Object.freeze({
            materialize: params.connectedAccounts.materialize,
        })
        : null;
    const retireConsumers = (): void => {
        if (consumersRetired) return;
        consumersRetired = true;
        allRuntimeConsumersRetired = true;
        for (const pluginId of runtimeConsumerLifecycles.keys()) {
            retirePluginConsumers([pluginId]);
        }
        allRuntimeConsumerRetirement.abort(
            new Error('Executable plugin runtime registry consumer retired'),
        );
        invocationServiceOwners.retireConnectedAccountConsumers();
        targetActionInvocations.dispose();
        connectedAccountContributions.dispose();
    };

    const resolvedRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
        contributes: authoritativeContributes,
        generation: activatedRegistry.generation,
        targetActivationFacts: activatedRegistry.targetActivationFacts,
        targetActionInvocations,
        retirementSignal: allRuntimeConsumerRetirement.signal,
        hookHandlersByHookId,
        agentRuntimesByAgentId,
        daemonAuthBridgesByServiceId: activatedRegistry.daemonAuthBridgesByServiceId ?? new Map(),
        notificationCategoriesById: activatedRegistry.notificationCategoriesById,
        notificationChannelsById: activatedRegistry.notificationChannelsById,
        scmHostingProvidersById: activatedRegistry.scmHostingProvidersById,
        scmBackendsById: activatedRegistry.scmBackendsById,
        scmBackendRegistrations: activatedRegistry.scmBackendRegistrations,
        requestInterceptors: activatedRegistry.requestInterceptors,
        invokeRequestInterceptor,
        mcpServers: activatedRegistry.mcpServers,
        mcpDiscoveryProviders: activatedRegistry.mcpDiscoveryProviders,
        voiceSpeechProviders,
        networkAllowedPluginIds: activatedRegistry.networkAllowedPluginIds,
        networkAllowedUrlOriginsByPluginId: activatedRegistry.networkAllowedUrlOriginsByPluginId,
        processSpawnAllowedPathsByPluginId: activatedRegistry.processSpawnAllowedPathsByPluginId,
        systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId: activatedRegistry.envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId: activatedRegistry.filesystemReadAllowedPathsByPluginId,
        filesystemWriteAllowedPathsByPluginId: activatedRegistry.filesystemWriteAllowedPathsByPluginId,
        permissionsByPluginId: activatedRegistry.permissionsByPluginId,
        permissionDeclarationsByPluginId: activatedRegistry.permissionDeclarationsByPluginId,
        requiredPermissionsByPluginId: activatedRegistry.requiredPermissionsByPluginId,
        requiredPermissionDeclarationsByPluginId: activatedRegistry.requiredPermissionDeclarationsByPluginId,
        runtimeCapabilitiesByPluginId: activatedRegistry.runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
        eventSubscriptionPermissionsByPluginId: activatedRegistry.eventSubscriptionPermissionsByPluginId,
        pluginDiagnosticsByPluginId,
        pluginFinalPolicyCurrentGenerationsById,
        resolveContributionRuntimeLifecycle,
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess
                ?? Object.freeze([]);
        },
        activatedPluginIds: activatedRegistry.activatedPluginIds,
        activateContributionsOnDemand,
        activatePluginsForValidation,
        connectedAccountContributions,
        resolveConnectedAccountRuntime: connectedAccountContributions.resolve,
        connectedAccountRuntimeInvoker,
        resolveQualifiedConnectedAccountEstablishedRuntimeOwner() {
            return !allRuntimeConsumersRetired
                ? params?.qualifiedConnectedAccountEstablishedRuntimeOwner ?? null
                : null;
        },
        resolveConnectedAccountPurposeBindingOwner() {
            return !allRuntimeConsumersRetired
                ? connectedAccountPurposeBindingOwner
                : null;
        },
        managedDependencies,
        addRuntimeDisposable: activatedRegistry.addRuntimeDisposable,
        createPluginFetchServiceV1(fetchParams) {
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === fetchParams.pluginId
                && candidate.manifest.version === fetchParams.pluginVersion
            ));
            if (!target) return null;
            const generation = String(activatedRegistry.generation);
            const baseBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                generation,
                `${fetchParams.pluginId}/legacy/fetch:binding`,
            );
            const networkAllowed = activatedRegistry.networkAllowedPluginIds.has(fetchParams.pluginId);
            const allowedOrigins = Object.freeze([
                ...(activatedRegistry.networkAllowedUrlOriginsByPluginId.get(fetchParams.pluginId) ?? []),
            ].sort());
            const binding = networkAllowed && allowedOrigins.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        baseBinding,
                        { serviceId: 'fetch', availability: 'available' },
                    ),
                    networkOrigins: allowedOrigins,
                })
                : baseBinding;
            const seed: PluginInvocationServicesSeed = Object.freeze({
                plugin: Object.freeze({
                    id: fetchParams.pluginId,
                    version: fetchParams.pluginVersion,
                }),
                contribution: Object.freeze({
                    id: 'fetch',
                    qualifiedId: `${fetchParams.pluginId}/legacy/fetch`,
                }),
                generation,
                correlationId: randomUUID(),
                surface: 'agent',
                signal: composePluginConsumerSignal(fetchParams.pluginId, fetchParams.signal),
                isGenerationCurrent: () => (
                    isPluginConsumerCurrent(fetchParams.pluginId)
                    && activatedRegistry.activatedPluginIds.has(fetchParams.pluginId)
                    && activatedRegistry.targetActivationFacts.some((fact) => (
                        fact.pluginId === fetchParams.pluginId
                        && fact.generation === generation
                        && fact.status === 'active'
                    ))
                ),
            });
            return stableFetchHost.bindRuntime(seed, binding);
        },
        createPluginMcpSessionResolver(mcpParams) {
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === mcpParams.pluginId
                && candidate.manifest.version === mcpParams.pluginVersion
            ));
            if (!target) return null;
            const generation = String(activatedRegistry.generation);
            const isGenerationCurrent = () => (
                isPluginConsumerCurrent(mcpParams.pluginId)
                && activatedRegistry.activatedPluginIds.has(mcpParams.pluginId)
                && activatedRegistry.targetActivationFacts.some((fact) => (
                    fact.pluginId === mcpParams.pluginId
                    && fact.generation === generation
                    && fact.status === 'active'
                ))
            );
            const hostedRegistry = createPluginHostedMcpServerRegistry();
            const sessionAttachments = new Map<string, Promise<Readonly<{
                resolved: ResolvedSessionMcpServer;
                dispose(): Promise<void>;
            }>>>();
            let attachmentDisposalPromise: Promise<void> | null = null;
            const disposeSessionAttachments = () => {
                attachmentDisposalPromise ??= (async () => {
                    const results = await Promise.allSettled(
                        [...sessionAttachments.values()].map(async (attachment) => {
                            await (await attachment).dispose();
                        }),
                    );
                    sessionAttachments.clear();
                    const failures = results.flatMap((result) => (
                        result.status === 'rejected' ? [result.reason] : []
                    ));
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(failures, 'MCP session attachment cleanup failed');
                    }
                })();
                return attachmentDisposalPromise;
            };
            activatedRegistry.addRuntimeDisposable(mcpParams.pluginId, Object.freeze({
                dispose: disposeSessionAttachments,
            }));
            return createPluginMcpSessionResolver({
                resolveForSession: async (input) => {
                    const hostSession = await mcpParams.resolveHostSession(input);
                    if (!hostSession || !isGenerationCurrent() || mcpParams.signal?.aborted) {
                        return Object.freeze([]);
                    }
                    const seed: PluginInvocationServicesSeed = Object.freeze({
                        plugin: Object.freeze({
                            id: mcpParams.pluginId,
                            version: mcpParams.pluginVersion,
                        }),
                        contribution: Object.freeze({
                            id: 'mcp.session',
                            qualifiedId: `${mcpParams.pluginId}/mcp/session`,
                        }),
                        generation,
                        correlationId: randomUUID(),
                        surface: 'agent',
                        session: Object.freeze({ id: hostSession.sessionId }),
                        currentSession: hostSession.currentSession,
                        signal: mcpParams.signal ?? new AbortController().signal,
                        isGenerationCurrent,
                    });
                    const stableService = mcpHost.bind(seed);
                    const available = await stableService.list({
                        sessionId: hostSession.sessionId,
                    });
                    const projected: ResolvedSessionMcpServer[] = [...hostSession.servers];
                    for (const item of available.items) {
                        if (item.state !== 'available') continue;
                        const attachmentKey = [
                            mcpParams.pluginId,
                            generation,
                            hostSession.sessionId,
                            hostSession.bindingId,
                            item.ref.pluginId,
                            item.ref.localId,
                        ].join('\0');
                        let attachment = sessionAttachments.get(attachmentKey);
                        if (!attachment) {
                            attachment = (async () => {
                                const client = await stableService.connect(item.ref, {
                                    sessionId: hostSession.sessionId,
                                    elicitation: {
                                        mode: 'hostMediated',
                                        sessionId: hostSession.sessionId,
                                    },
                                });
                                try {
                                    const tools = await client.listTools();
                                    const spec: McpServerSpecV1 = Object.freeze({
                                        id: `stable-${randomUUID()}`,
                                        name: item.title,
                                        transport: Object.freeze({
                                            kind: 'hosted',
                                            exposure: Object.freeze({
                                                kind: 'loopbackHttp',
                                                requested: true,
                                            }),
                                        }),
                                        hosted: Object.freeze({
                                            tools: Object.freeze(tools.items.map((tool) => Object.freeze({
                                                name: `happier.proxy_${createHash('sha256')
                                                    .update(`${item.ref.pluginId}\0${item.ref.localId}\0${tool.name}`)
                                                    .digest('hex')
                                                    .slice(0, 24)}`,
                                                ...(tool.description === undefined ? {} : { description: tool.description }),
                                                inputSchema: tool.inputSchema,
                                                ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
                                                async handler(args: unknown, context: Readonly<{ signal: AbortSignal }>) {
                                                    const result = await client.callTool(
                                                        tool.name,
                                                        cloneLegacyMcpHandlerInput(args),
                                                        { signal: context.signal },
                                                    );
                                                    return Object.freeze({
                                                        content: Object.freeze([Object.freeze({
                                                            type: 'text' as const,
                                                            text: JSON.stringify(result),
                                                        })]),
                                                    });
                                                },
                                            }))),
                                        }),
                                    });
                                    const handle = await createPluginHostedMcpServerHandle({
                                        pluginId: mcpParams.pluginId,
                                        spec,
                                        registry: hostedRegistry,
                                        startRuntimeEndpoint: startPluginHostedMcpLoopbackServer,
                                    });
                                    if (!handle.endpoint || handle.endpoint.kind !== 'loopbackHttp') {
                                        await handle.dispose();
                                        throw new PluginError({
                                            code: 'plugin_mcp_transport_unavailable',
                                            message: 'Hosted MCP session attachment is unavailable',
                                        });
                                    }
                                    let disposed = false;
                                    const dispose = async () => {
                                        if (disposed) return;
                                        disposed = true;
                                        sessionAttachments.delete(attachmentKey);
                                        const results = await Promise.allSettled([
                                            handle.dispose(),
                                            client.dispose(),
                                        ]);
                                        const failures = results.flatMap((result) => (
                                            result.status === 'rejected' ? [result.reason] : []
                                        ));
                                        if (failures.length > 0) {
                                            throw new AggregateError(failures, 'MCP session attachment cleanup failed');
                                        }
                                    };
                                    const resolved: ResolvedSessionMcpServer = Object.freeze({
                                        id: `${item.ref.pluginId}/${item.ref.localId}`,
                                        name: item.title,
                                        transport: Object.freeze({
                                            kind: 'http',
                                            url: handle.endpoint.url,
                                        }),
                                        scope: Object.freeze({
                                            sessionId: hostSession.sessionId,
                                            directory: hostSession.directory,
                                        }),
                                    });
                                    const owned = Object.freeze({ resolved, dispose });
                                    mcpParams.addDisposable?.(owned);
                                    return owned;
                                } catch (error) {
                                    await Promise.resolve(client.dispose()).catch(() => {});
                                    throw error;
                                }
                            })().catch((error) => {
                                sessionAttachments.delete(attachmentKey);
                                throw error;
                            });
                            sessionAttachments.set(attachmentKey, attachment);
                        }
                        projected.push((await attachment).resolved);
                    }
                    return Object.freeze(projected.sort((left, right) => (
                        left.id.localeCompare(right.id) || left.name.localeCompare(right.name)
                    )));
                },
            });
        },
        async discoverMcpServersForDetection(detectionParams) {
            const declaration = (authoritativeContributes.mcpDiscoveryProviders ?? []).find((candidate) => (
                candidate.pluginId === detectionParams.pluginId
                && candidate.definition.id === detectionParams.localId
            ));
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === detectionParams.pluginId
            ));
            if (!declaration || !target) {
                throw new PluginError({
                    code: 'plugin_mcp_discovery_provider_undeclared',
                    message: 'MCP discovery provider is not declared',
                });
            }
            const generation = String(activatedRegistry.generation);
            const correlationId = randomUUID();
            const ref = Object.freeze({
                pluginId: detectionParams.pluginId,
                localId: detectionParams.localId,
            });
            const attachmentKey = mcpDiscoveryAttachmentKey(correlationId, ref);
            const seed: PluginInvocationServicesSeed = Object.freeze({
                plugin: Object.freeze({
                    id: detectionParams.pluginId,
                    version: target.manifest.version,
                }),
                contribution: Object.freeze({
                    id: detectionParams.localId,
                    qualifiedId: `${detectionParams.pluginId}/mcp.discoveryProviders/${detectionParams.localId}`,
                }),
                generation,
                correlationId,
                surface: 'cli',
                ...(detectionParams.input.sessionId
                    ? { session: Object.freeze({ id: detectionParams.input.sessionId }) }
                    : {}),
                signal: composePluginConsumerSignal(detectionParams.pluginId, detectionParams.signal),
                // Discovery is itself an activation demand. The generation may
                // be current before this provider has published its binding;
                // the stable MCP owner demands it and final policy then
                // revalidates activation/currentness before peer execution.
                isGenerationCurrent: () => isPluginConsumerCurrent(detectionParams.pluginId),
            });
            try {
                await mcpHost.bind(seed).discover(ref, {
                    input: Object.freeze({
                        ...(detectionParams.input.accountId === undefined
                            ? {}
                            : { accountId: detectionParams.input.accountId }),
                        ...(detectionParams.input.workspaceId === undefined
                            ? {}
                            : { workspaceId: detectionParams.input.workspaceId }),
                        ...(detectionParams.input.directory === undefined
                            ? {}
                            : { directory: detectionParams.input.directory }),
                    }),
                }, { signal: detectionParams.signal });
                const attachment = mcpDiscoveryAttachments.get(attachmentKey);
                return Object.freeze({
                    servers: attachment?.servers ?? Object.freeze([]),
                    warnings: projectPluginMcpDiscoveryWarningsToLegacyDetection(
                        declaration.definition.metadata?.agentId,
                        attachment?.warnings,
                    ),
                });
            } finally {
                mcpDiscoveryAttachments.delete(attachmentKey);
            }
        },
        createPluginSettingsService(settingsParams) {
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === settingsParams.pluginId
            ));
            if (!target) return null;
            const signal = composePluginConsumerSignal(
                settingsParams.pluginId,
                settingsParams.signal,
            );
            const seed = Object.freeze({
                plugin: Object.freeze({ id: settingsParams.pluginId, version: target.manifest.version }),
                contribution: Object.freeze({ id: 'settings', qualifiedId: `${settingsParams.pluginId}/settings` }),
                generation: String(activatedRegistry.generation),
                correlationId: randomUUID(),
                surface: 'ui' as const,
                signal,
                isGenerationCurrent: () => (
                    !signal.aborted
                    && isPluginConsumerCurrent(settingsParams.pluginId)
                ),
            });
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                seed.generation,
                `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
            );
            const services = invocationServiceOwners.createServices(seed, binding);
            return services.availability('settings').status === 'available' ? services.settings : null;
        },
        createPluginEventsService(eventParams) {
            const signal = composePluginConsumerSignal(
                eventParams.pluginId,
                eventParams.signal,
            );
            const seed = Object.freeze({
                plugin: Object.freeze({ id: eventParams.pluginId, version: eventParams.pluginVersion }),
                contribution: Object.freeze({ id: 'events', qualifiedId: `${eventParams.pluginId}/events` }),
                generation: String(activatedRegistry.generation),
                correlationId: randomUUID(),
                surface: 'agent' as const,
                signal,
                isGenerationCurrent: () => (
                    !signal.aborted
                    && isPluginConsumerCurrent(eventParams.pluginId)
                    && activatedRegistry.activatedPluginIds.has(eventParams.pluginId)
                ),
            });
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                seed.generation,
                `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
            );
            const services = invocationServiceOwners.createServices(seed, binding);
            return services.availability('events').status === 'available' ? services.events : null;
        },
        createAgentInvocationServices(agentParams) {
            const declaredAgent = authoritativeContributes.agents.find((candidate) => (
                candidate.pluginId === agentParams.pluginId
                && candidate.id === agentParams.agentId
            ));
            if (!declaredAgent) {
                throw new PluginError({
                    code: 'plugin_agent_operation_undeclared',
                    message: `Agent '${agentParams.agentId}' is not declared by plugin '${agentParams.pluginId}'`,
                });
            }
            const currentGeneration = String(activatedRegistry.generation);
            if (agentParams.generation !== currentGeneration || !agentParams.isGenerationCurrent()) {
                throw new PluginError({
                    code: 'plugin_generation_stale',
                    message: `Agent '${agentParams.agentId}' belongs to a retired plugin generation`,
                });
            }
            const agentCliSystemTool = declaredAgent.catalogEntry?.agentCliSystemTool;
            const agentSystemTools = agentCliSystemTool
                ? (() => {
                    const definitions = projectPluginSystemToolContributions(
                        systemToolDefinitionsByPluginId.get(agentParams.pluginId) ?? Object.freeze([]),
                    );
                    const definition = definitions.find(
                        (candidate) => candidate.toolId === agentCliSystemTool.toolId,
                    );
                    const delegate = systemToolServicesByPluginId.get(agentParams.pluginId);
                    if (!definition || !delegate) {
                        throw new PluginError({
                            code: 'plugin_agent_cli_system_tool_unavailable',
                            message: `Agent '${agentParams.agentId}' CLI system tool is unavailable`,
                        });
                    }
                    return createAgentCliSystemToolService({
                        agentId: agentParams.agentId,
                        runtimeSpec: declaredAgent.runtimeSpec
                            ?? (() => {
                                throw new PluginError({
                                    code: 'plugin_agent_cli_runtime_metadata_unavailable',
                                    message: `Agent '${agentParams.agentId}' CLI runtime metadata is unavailable`,
                                });
                            })(),
                        binding: agentCliSystemTool,
                        definition,
                        processEnv: createAgentCliHostResolutionEnvironment({
                            processEnv: process.env,
                            ...(params?.happyHomeDir
                                ? { happyHomeDir: params.happyHomeDir }
                                : {}),
                        }),
                        delegate,
                    });
                })()
                : undefined;
            const storePaths = resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir });
            const seed = Object.freeze({
                plugin: Object.freeze({ id: agentParams.pluginId, version: agentParams.pluginVersion }),
                contribution: Object.freeze({
                    id: agentParams.agentId,
                    qualifiedId: `${agentParams.pluginId}/agents/${agentParams.agentId}`,
                }),
                generation: agentParams.generation,
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                ...(agentParams.session ? {
                    session: Object.freeze({ id: agentParams.session.id }),
                    currentSession: agentParams.session.current,
                } : {}),
                signal: agentParams.signal,
                isGenerationCurrent: () => (
                    isPluginConsumerCurrent(agentParams.pluginId)
                    && agentParams.isGenerationCurrent()
                ),
            });
            const requiredHostAccess = composeProviderBindingProcessAccess({
                requests: declaredAgent.hostAccess?.required ?? [],
                providerRequirements: declaredAgent.definition.providerRequirements,
                environment: agentParams.environment,
                providerBindingActive: agentParams.providerBindingActive === true,
            });
            const admittedEnvironmentKeys = Object.keys(agentParams.environment ?? {});
            const invocationHostAccess = admittedEnvironmentKeys.length === 0
                ? requiredHostAccess
                : requiredHostAccess.map((request) => request.capability === 'process'
                    ? Object.freeze({
                        ...request,
                        scope: Object.freeze({
                            ...request.scope,
                            envKeys: [
                                ...new Set([
                                    ...(request.scope.envKeys ?? []),
                                    ...admittedEnvironmentKeys,
                                ]),
                            ],
                        }),
                    })
                    : request);
            const connectedAccountHostAccess = projectConnectedAccountPurposeDeclarationsToHostAccess(
                declaredAgent.richDefinition?.definition.connectedAccounts ?? Object.freeze([]),
            );
            return invocationServiceOwners.createOperationServices(seed, {
                filesystemRoots: Object.freeze({
                    pluginData: join(storePaths.storageDir, agentParams.pluginId, 'fs'),
                    workspace: agentParams.cwd,
                    projects: new Map(),
                }),
                hostAccessRequests: Object.freeze([
                    ...invocationHostAccess.map((request) => Object.freeze({ request, required: true })),
                    ...connectedAccountHostAccess,
                ]),
                ...(agentParams.environment ? { environment: agentParams.environment } : {}),
                ...(agentSystemTools ? { systemTools: agentSystemTools } : {}),
            });
        },
        readHookEventEnvelopeV1,
        async resolvePromptAssetBlocks(promptParams) {
            const agents = authoritativeContributes.agents.filter((agent) => (
                agent.id === promptParams.agentId && agent.pluginId
            ));
            if (agents.length === 0) return Object.freeze([]);
            if (agents.length !== 1) {
                throw new Error(`Prompt asset Agent identity '${promptParams.agentId}' is ambiguous`);
            }
            const agent = agents[0]!;
            return await bindPromptAssetContributionBlocks({
                registry: {
                    generationId: String(activatedRegistry.generation),
                    promptAssets: authoritativeContributes.promptAssets ?? [],
                },
                resources: resourcesOwner,
                agent: { pluginId: agent.pluginId!, localId: agent.definition.id },
                ...(promptParams.selectedAsset ? { selectedAsset: promptParams.selectedAsset } : {}),
                signal: promptParams.signal ?? new AbortController().signal,
                isGenerationCurrent: () => isPluginConsumerCurrent(agent.pluginId!),
                facts: {
                    'plugin.enabled': true,
                    'session.exists': Boolean(promptParams.sessionId),
                    'session.agentId': promptParams.agentId,
                    'project.exists': Boolean(promptParams.projectId),
                    'browser.exists': false,
                    'host.platform': 'desktop',
                    'host.feature': Object.freeze([...(promptParams.featureIds ?? [])]),
                    ...(promptParams.machineId ? { 'machine.id': promptParams.machineId } : {}),
                    ...(promptParams.projectId ? { 'project.id': promptParams.projectId } : {}),
                },
            });
        },
        async resolveStructuredMessage(messageParams) {
            if (allRuntimeConsumersRetired) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
            }
            const generation = String(activatedRegistry.generation);
            const consumer = resolveStablePluginStructuredMessageConsumer({
                registry: authoritativeContributes,
                currentGeneration: generation,
                expectedGeneration: messageParams.expectedGeneration,
                kind: messageParams.kind,
                payload: messageParams.payload,
                ...(messageParams.resourceRefs ? { resourceRefs: messageParams.resourceRefs } : {}),
                facts: messageParams.facts,
            });
            if (consumer.model.resources.length === 0) {
                return Object.freeze({ ...consumer, resources: Object.freeze([]) });
            }
            if (!resourcesOwner) {
                throw new PluginError({
                    code: 'plugin_resource_service_unavailable',
                    message: 'Committed plugin resources are unavailable',
                });
            }
            const signal = messageParams.signal ?? new AbortController().signal;
            const resources = await Promise.all(consumer.model.resources.map(async (reference) => {
                if (!resourcesOwner.hasPlugin(reference.identity.pluginId)) {
                    throw new PluginError({
                        code: 'plugin_resource_service_unavailable',
                        message: 'Committed plugin resources are unavailable',
                    });
                }
                const service = resourcesOwner.bind({
                    pluginId: reference.identity.pluginId,
                    generation,
                    signal,
                    isGenerationCurrent: () => isPluginConsumerCurrent(reference.identity.pluginId),
                });
                const value = await service.read(reference.identity.localId, { signal });
                return Object.freeze({ reference, ...value });
            }));
            return Object.freeze({ ...consumer, resources: Object.freeze(resources) });
        },
        async dispose(options) {
            retireConsumers();
            const [subscriptionsResult, activationResult] = await Promise.allSettled([
                Promise.all([...declaredEventSubscriptionBindings.values()].map((binding) => binding.dispose())),
                activationRegistryLease.release({
                    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                    ...(options?.onError ? {
                        onError(event) {
                            switch (event.phase) {
                                case 'runtime_disposables':
                                case 'registered_disposables':
                                    options.onError?.({ pluginId: event.pluginId, phase: event.phase, error: event.error });
                                    break;
                                case 'target_activation':
                                    break;
                            }
                        },
                    } : {}),
                }),
            ]);
            declaredEventSubscriptionBindings.clear();
            const failures = [subscriptionsResult, activationResult]
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) => result.reason);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, 'Failed to dispose executable plugin runtime registry owners');
            }
        },
        retirePluginConsumers,
        retireConsumers,
        retainActivationRegistryComponentsExcluding: (excludedPluginIds) => Object.freeze(
            retainedActivationRegistryLeases
                .filter((lease) => (
                    lease.pluginIds.size > 0
                    && [...lease.pluginIds].every((pluginId) => !excludedPluginIds.has(pluginId))
                ))
                .map((lease) => lease.retain()),
        ),
        ...(preparedActivationRegistryLeaseOwners.length > 0 ? {
            retainPreparedActivationRegistryComponents: () => Object.freeze(
                preparedActivationRegistryLeaseOwners.map((owner) => owner.retain()),
            ),
        } : {}),
    };
    resolvedRuntimeRegistryOwner = resolvedRuntimeRegistry;
    return resolvedRuntimeRegistry;
}

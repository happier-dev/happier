import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
    BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
} from '../projection/registry/sources/generatedBundledPlugins';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '../projection/registry/sources/generatedBundledPluginArtifacts';
import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import {
    projectAgentDaemonSpawnHooksCatalogEntry,
} from '../projection/registry/agentCatalogEntryHooks';
import {
    collectUnresolvedTargetedContributionSemanticTargetPluginIds,
    dropTargetedContributionAdmissionDiagnostics,
} from '../projection/registry/targetedContributions';
import type {
    ResolvedContributionRegistry,
    ResolvedManagedProviderRuntime,
    ResolvedProviderCatalogParsers,
} from '../projection/registry/types';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    evaluatePluginFinalPolicy,
    isDynamicPluginResourceContributionV2,
    McpDetectedProviderV1Schema,
    normalizePluginAccountCollectionContractsV1,
    PluginMachineExecutionOriginV1Schema,
    PluginMachineMaterializationRefV1Schema,
    resolveProviderManagedRuntimeDeclarationV1,
    createProviderManagedPurposeBindingsEqualityKeyV1,
    resolveAttentionDeliveryPolicyDecision,
    QualifiedConnectedAccountPurposeBindingsV1Schema,
    SessionExecutionTargetV1Schema,
    qualifiedPurposeKey,
    type QualifiedConnectedAccountPurposeBindingsV1,
    type ConnectedAccountRequestAuthUseV1,
    ProviderRuntimeBindingBasisV1Schema,
    type ProviderRuntimeBindingBasisV1,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginMachineMaterializationRefV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionContractRefV1,
    type PluginReleaseRefV1,
    type PluginUiArtifactDigestV1,
    type AutomationEventSourcesListTransportV1,
    type PluginResourceContextV1,
    type PluginActionPresentUserGatePolicy,
    readContributedProviderCatalogParserIds,
} from '@happier-dev/protocol';
import type { DaemonMcpServersDetectWarningV1, HostSemanticEventV1 } from '@happier-dev/protocol';
import type { HostStructuredMessageDescriptorV1 } from './invocation/services/structuredMessageDescriptor';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

import {
    activatePluginRuntimeRegistry,
    type ActivatedPluginRuntimeRegistry,
} from './lifecycle/manager';
import {
    createBundledActivationSourceResolver,
    prepareBundledExecutableGenerationAdmission,
    resolveCurrentHostBundledImmutableArtifacts,
    selectBundledExecutableImmutableArtifacts,
} from './bundledActivationSource';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../scm/pluginBackends/runtimeRegistry';
import type {
    PluginDaemonModuleNamespace,
    PreparedPluginActivationGraph,
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
import type {
    AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import type {
    ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import { createTargetVoiceSpeechRegistry } from './lifecycle/contributions/targetVoiceSpeech';
import { createTargetComposerAttachmentRegistry } from './lifecycle/contributions/targetComposerAttachments';
import { createTargetComposerReferenceRegistry } from './lifecycle/contributions/targetComposerReferences';
import { revalidateVoiceSpeechHttpEndpoint } from './lifecycle/contributions/voiceSpeechHttpPolicy';
import { projectTargetProviderRuntimes } from './lifecycle/contributions/targetProviders';
import { createTargetPromptAssetAdapterRegistry } from './lifecycle/contributions/targetPromptAssets';
import {
    projectExternalSessionSourceRefusalDiagnostics,
} from './lifecycle/contributions/externalSessionSourceRefusals';
import { buildTargetActionInvocationRegistry } from './invocation/buildTargetActionRegistry';
import { executeContributedAction } from './invocation/actions/executeContributedAction';
import { createHostContributedActionInvoker } from './invocation/actions/hostContributedActionInvoker';
import {
    resolveCurrentSessionCapabilityBinding,
    resolveCurrentSessionUiBinding,
} from '@/session/presentation/currentSessionUiBindings';
import { readStoredCredentials } from '@/persistence';
import { createPluginSessionsInventory } from '@/session/services/pluginSessionsInventory';
import { executePluginSessionMessageAction } from '@/session/services/executePluginSessionMessageAction';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import {
    createCurrentGlobalExternalSessionsAuthorBinding,
    createCurrentGlobalExternalSessionsAuthorService,
} from '@/session/external/currentGlobalAuthorService';
import type {
    CurrentGlobalExternalSessionsRouter,
} from '@/session/external/currentGlobalRouting';
import type { ExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import {
    createPluginSessionHandleCapabilitiesFactory,
} from '@/session/services/pluginSessionHandleCapabilities';
import { createUnavailablePluginServices } from './invocation/services/unavailable';
import { projectOrdinaryPluginSessionLiveCapabilities } from './context/session/ordinaryPluginSessionLiveCapabilities';
import type { createTargetActionInvocationRegistry } from './invocation/targetActionRegistry';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    createAutomationEventAdoptedDefinitionSetHostV1,
} from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import type {
    AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1,
} from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSet';
import {
    createProductionPluginInvocationServiceOwners,
    type ManagedProviderRuntimeInvocationServices,
} from './invocation/services/production';
import { createStablePluginComposerContentOwner } from './invocation/services/composerContent';
import type { InvokeContributedAction } from './invocation/services/actions';
import type { StableTargetedContributionsOwner } from './invocation/services/targetedContributions';
import {
    createStablePluginDaemonDatabaseHost,
    type PluginDaemonDatabaseCapability,
    type PluginDaemonDatabaseLimitsPolicy,
    type PluginDaemonDatabasePreparedContract,
    type PluginDaemonDatabaseQuiescence,
    type PluginDaemonDatabaseRuntimeProjection,
} from './context/daemonDatabase';
import {
    createAccountPluginDataStorageHost,
    type CollectionMigrationCandidateHandle,
    type AccountPluginDataStorageHostDependencies,
} from './context/accountPluginDataStorage';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import {
    collectResolvedGeneratedReactNativeArtifactOwners,
    findGeneratedReactNativeCollectionMigrationsModule,
} from '../projection/registry/ui/generatedUiArtifactOwners';
import { resolveManifestHostAccessRequests } from './hostAccess/manifestRequests';
import { createPluginResourceAccountStorageResolver } from './hostAccess/resolve';
import type { StablePluginConnectedAccountsOwner } from './invocation/services/connectedAccounts';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
    QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
    createStableImmutablePluginResourcesOwner,
    createStablePluginResourcesOwner,
    type ResolveSessionResourceAccess,
    type ResourceSessionAccessWitness,
    type StablePluginResourcesOwner,
} from './invocation/services/resources';
import {
    createStablePluginUiResourceWatchOwner,
    type PluginUiResourceWatchPollResult,
} from './invocation/services/uiResourceWatch';
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
import { createPluginInvocationPresentation } from './invocation/services/interactions';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from './invocation/lifetime';
import {
    PluginError,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { readTargetedContributionPointSemanticRefs } from '@happier-dev/plugin-sdk/host/targeted-contributions';
import { type PluginEvents } from '@happier-dev/plugin-sdk/events';
import { type McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint, type McpDiscoveryRequest as PluginMcpDiscoveryRequest, type McpDiscoveryResult as PluginMcpDiscoveryResult, type McpServerRef as PluginMcpServerRef } from '@happier-dev/plugin-sdk/mcp';
import { type PluginResourceKind, type PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import type {
    ScopedSettingsService,
    SettingsScopeRef,
} from '@happier-dev/plugin-sdk/settings';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { DeclaredDaemonPluginSecretAdministrationPort } from './context/secrets';
import type { ResolvedMcpEndpointDiscoveryResult } from '@/mcp/runtimeTypes';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
    TargetPluginInterceptorResult as PluginInterceptorResult,
    TargetRequestInterceptorBinding,
} from './lifecycle/contributions/targetRequestInterceptors';
import type {
    CreateAgentInvocationServices,
    PluginInvocationServicesSeed,
    PluginProviderOperationsSource,
} from './invocation/services/types';
import {
    withPluginInvocationServiceBindingAvailability,
} from './invocation/services/unavailable';
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
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from './runner/loadRetainedAgentRuntimeLeaf';
import type {
    AgentSessionRunnerBindingV1,
} from './runner/agentSessionRunnerFactoryBinding';
import { createStablePluginManagedDependenciesHost } from './invocation/services/managedDependencies';
import { createV2ManagedDependencySourceModel } from './invocation/services/managedDependencySourceModel';
import { createProductionManagedDependencySourceAdapter } from './invocation/services/managedDependencySourceAdapters';
import { createStableManagedExecutableResolver } from './invocation/services/managedExecutableResolver';
import {
    createRetainedRunnerManagedDependenciesHost,
} from './invocation/services/retainedRunnerManagedDependencies';
import { createManagedServiceProcessSupervisorHost } from './invocation/services/managedProcessSupervisor';
import {
    createManagedServicesOwner,
    type ManagedProviderExplicitStartOperationInput,
    type ManagedProviderExplicitStartOperationResult,
} from './invocation/services/managedServicesOwner';
import { createDeclaredManagedServiceSecretResolver } from './invocation/services/declaredManagedServiceSecret';
import {
    createManagedServiceCredentialFileOwner,
} from './invocation/services/managedServiceCredentialFileOwner';
import type {
    ManagedProviderOperationAuthority,
} from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import {
    readExactLiveRunnerManagedDependencyRetention,
} from '@/daemon/agentRuntime/runnerManagedDependencyRetention';
import {
    mergeRunnerManagedDependencyRetentionV1,
    type RunnerManagedDependencyRetentionV1,
} from './runner/runnerManagedDependencyRetention';
import { createPluginAgentCliReadinessService } from './context/agents';
import {
    createPluginExecSystemToolResolver,
} from './exec/system/tools/resolveGrant';
import {
    createAgentCliHostResolutionEnvironment,
    createAgentCliSystemToolService,
    createRetainedAgentCliSystemToolService,
} from './exec/system/tools/agentCliBinding';
import type {
    BoundAgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { projectPluginSystemToolContributions } from './exec/system/tools/definitions';
import type {
    PluginContributionRef,
    PluginServices,
} from '@happier-dev/plugin-sdk';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { resolveManagedProviderRuntimeExecutable } from '@/providers/lifecycle/resolveManagedProviderRuntimeLaunch';
import { resolveExecutableManagedDependenciesRegistry } from '../projection/registry/managedDependencyExecutables';
import { resolvePluginStorePaths } from '../store/paths';
import {
    resolveNotificationChannelSettingsContributions,
} from '../settings/notificationChannelSettings';
import { collectDeclaredPluginSecrets } from './context/declaredPluginSecrets';
import {
    type PluginAccessSelection,
} from '../store/install/accessScopeRegistry';
import {
    projectConnectedAccountPurposeDeclarationsToHostAccess,
} from './hostAccess/resolve';
import { isPluginHostAccessRequestAuthorizedBySelection } from './hostAccess/resourceSelection';
import {
    assertContainedRegularGenerationFile,
    prepareImmutablePluginGeneration,
    persistValidatedAgentSessionRunnerFactories,
    readCurrentCommittedPluginGenerations,
    readPreparedImmutablePluginGeneration,
} from '../store/registry/generationStore';
import { readPluginManifest } from '../manifest/read';
import { ingestCanonicalPluginManifest } from '../manifest/ingest';
import { pluginSourceProvenanceForKind } from '../manifest/sourceProvenance';
import { serializeCanonicalPluginManifest } from '../manifest/serialize';
import { projectPluginAuthorModule } from '../authoring/sourceModule';
import {
    loadPluginModule,
    resolvePluginModuleCandidatePaths,
    resolvePluginModuleLoadMode,
} from './loadPluginModule';
import { projectPluginFailureText } from './lifecycle/utils';
import { reconcilePluginGenerationCustodyRetirement } from '../store/registry/generationCustodyRetirement';
import { logger } from '@/ui/logger';
import { bindPromptAssetContributionBlocks } from '@/agent/prompting/contributions/bindPromptAssetContributionBlocks';
import type { PromptBlockV1 } from '@happier-dev/protocol';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import {
    resolveInvocationContributionPolicyFacts,
    resolveTargetActionAvailability,
    resolveTargetActionResourceSelectionFacts,
    type ContributionPolicyFacts,
    type TargetActionAuthorizationFacts,
} from './policy/evaluate';
import {
    resolvePluginFinalPolicyAuthorizationFacts,
    type PluginFinalPolicyCurrentGeneration,
} from './policy/facts';
import {
    resolveCatalogTargetActionPolicy,
    resolvePresentUserGatePolicy,
    type ResolvedTargetAction,
} from './invocation/actionExecutor';
import {
    createStablePluginHttpHost,
    type StablePluginHttpFinalPolicyEffect,
} from './fetch/service';
import {
    createVoiceAccountPluginHttpCredentialBindingHost,
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
import type { PluginHostedMcpServerSpec } from '@/mcp/hosted/runtimeTypes';
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

export type ResolvedManagedProviderRuntimeInvocationServices =
    ManagedProviderRuntimeInvocationServices & Readonly<{
        bootstrap: Readonly<{
            identity: PluginContributionRef;
            activationGeneration: string;
            immutableGenerationId: string;
            manifestAuthority: 'external' | 'bundled_first_party';
            operationClaimId: string;
            requestAuth: Readonly<{
                capabilityPath: string;
                requestAuthUses:
                    readonly ConnectedAccountRequestAuthUseV1[];
            }> | null;
        }>;
        adoptService?(serviceId: string): Promise<void>;
        cleanup(): void | Promise<void>;
    }>;

export type ManagedProviderSessionCustodyBinding = Readonly<{
    managedServices:
        ManagedProviderRuntimeInvocationServices['managedServices'];
    projectEndpointAccess:
        ManagedProviderRuntimeInvocationServices['projectEndpointAccess'];
    adoptService(serviceId: string): Promise<void>;
    cleanup?(): void | Promise<void>;
}>;

export type ManagedProviderRuntimeOperationClaim = Readonly<
    | {
        kind: 'explicitStart';
        machineId: string;
    }
    | {
        kind: 'sessionDemand';
        sessionId: string;
        runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
        bindSessionCustody(
            scope: RetainedManagedProviderRuntimeInvocationScope,
            dependencies: ManagedProviderRuntimeInvocationServices[
                'managedServices'
            ]['dependencies'],
        ): Promise<ManagedProviderSessionCustodyBinding>;
    }
>;

/**
 * Host-private result from the canonical SVC09 explicit-start operation
 * claim. A caller may join the winner's pending or settled effect only when
 * its exact authorization input is still current.
 */
export type ManagedProviderExplicitStartJoinResult =
    ManagedProviderExplicitStartOperationResult;

export type ManagedProviderExplicitStartJoinInput = Readonly<{
    identity: PluginContributionRef;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    machineId: string;
    isCurrent(): boolean;
    establish: ManagedProviderExplicitStartOperationInput['establish'];
}>;

export type RetainedManagedProviderRuntimeInvocationScope = Readonly<{
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    identity: PluginContributionRef;
    activationGeneration: string;
    immutableGenerationId: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    operationClaimId: string;
}>;

export type ManagedProviderAdoptedPublicOutcome = Readonly<{
    operationClaimId: string;
    serviceId: string;
    endpointTemplateIds: readonly string[];
    endpoints: readonly Readonly<{
        endpointTemplateId: string;
        servicePath: string;
    }>[];
    endpointAccess: 'runnerProjected';
}>;

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    // Includes internal merged contribution surfaces (`catalogEntry`).
    contributes: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    generation?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['generation'];
    targetActivationFacts?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['targetActivationFacts'];
    targetActionInvocations?: ReturnType<typeof createTargetActionInvocationRegistry>;
    /**
     * Current manifest Action policy projection. Unlike daemon invocation,
     * this is intentionally independent of target handler registration.
     */
    resolveActionPresentUserGatePolicy?(
        pluginId: string,
        localId: string,
    ): PluginActionPresentUserGatePolicy | null;
    /**
     * Cold target-owned contribution snapshots, stamped only with committed
     * immutable generations. Reading this never activates either plugin.
     */
    readAdmittedTargetedContributions?: NonNullable<
        ResolvedContributionRegistry['readAdmittedTargetedContributions']
    >;
    /**
     * The resolved runtime's one dispatch-time caller-materialization owner.
     * Partial consumer fixtures may omit it and must then fail closed.
     */
    resolveCurrentPluginMaterializationRef?(
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null;
    /**
     * The resolved runtime's one committed immutable-generation currentness
     * owner. Unlike a materialization, this is available before demand
     * activation; partial consumer fixtures may omit it and must then fail
     * closed.
     */
    resolveCurrentPluginImmutableGenerationId?(
        pluginId: string,
    ): Promise<string | null>;
    /**
     * The same runtime owner resolves the exact live target contribution that
     * asserted a mediated permission decision.
     */
    resolveCurrentMediatorContributionMaterializationRef?(
        mediator: Readonly<{
            pluginId: string;
            contributionLocalId: string;
        }>,
    ): PluginMachineMaterializationRefV1 | null;
    /**
     * The same runtime owner combines a fresh server/machine context with the
     * exact current materialization. Callers cannot construct this origin.
     */
    resolveCurrentPluginExecutionOrigin?(
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<PluginMachineExecutionOriginV1 | null>;
    /**
     * Host-private exact candidate preparation. It reuses the committed
     * module loader and Account Data stage host; it neither activates a
     * plugin nor exposes the daemon immutable generation to a caller.
     */
    prepareCollectionMigrationCandidates?(input: Readonly<{
        source: Readonly<{
            release: PluginReleaseRefV1;
            collectionContracts: readonly NormalizedPluginAccountCollectionContractV1[];
        }>;
        candidate: Readonly<{
            release: PluginReleaseRefV1;
            artifactDigest: PluginUiArtifactDigestV1;
            origin: PluginMachineExecutionOriginV1;
            collectionContracts: readonly PluginCollectionContractRefV1[];
        }>;
        signal: AbortSignal;
        isRequestCurrent(): boolean | Promise<boolean>;
    }>): Promise<
        | Readonly<{
            kind: 'prepared';
            bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
        }>
        | Readonly<{
            kind: 'unavailable';
            code:
                | 'candidate_contract_mismatch'
                | 'candidate_currentness_changed'
                | 'candidate_preparation_unavailable';
        }>
    >;
    /**
     * Retires exact persisted stages through current Account authority only.
     * Its input intentionally contains no executable target/generation fact.
     */
    retireCollectionMigrationCandidates?(input: Readonly<{
        bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
        signal: AbortSignal;
        isRequestCurrent(): boolean | Promise<boolean>;
    }>): Promise<void>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    agentRuntimesByAgentId: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['agentRuntimesByAgentId'];
    scmHostingProvidersById: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmHostingProvidersById'];
    scmBackendsById?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendsById'];
    scmBackendRegistrations?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['scmBackendRegistrations'];
    requestInterceptors?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['requestInterceptors'];
    invokeRequestInterceptor?(
        binding: TargetRequestInterceptorBinding,
        request: PluginInterceptedRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginInterceptorResult>;
    voiceSpeechProviders?: ReturnType<typeof createTargetVoiceSpeechRegistry>;
    composerReferences?: ReturnType<typeof createTargetComposerReferenceRegistry>;
    composerAttachments?: ReturnType<typeof createTargetComposerAttachmentRegistry>;
    promptAssetAdapters?: ReadonlyMap<string, PromptAssetAdapter>;
    systemToolDefinitionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['systemToolDefinitionsByPluginId'];
    envAllowedNamesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['envAllowedNamesByPluginId'];
    filesystemReadAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemReadAllowedPathsByPluginId'];
    runtimeCapabilitiesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['runtimeCapabilitiesByPluginId'];
    eventDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventDeclarationsByPluginId'];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    /** Applied package admission facts. Real registries provide them; partial
     * consumer fixtures may omit them and consumers must then fail closed. */
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
    /** Exact current-generation owner for one admitted Voice provider. */
    resolveVoiceProviderRuntimeLifecycle?(
        identity: PluginContributionIdentityV1,
    ): PluginContributionRuntimeLifecycle | null;
    /** Canonical validated optional HostAccess selections for this prepared registry generation. */
    resolveOptionalAccess?(pluginId: string): readonly PluginAccessSelection[];
    /**
     * The daemon's retained server features snapshot, as supplied to this resolved
     * runtime. Plugin-facing feature decisions read it through the canonical
     * decision owner; a partial fixture may omit it and then decides only
     * client-represented features.
     */
    resolveServerFeaturesSnapshot?(): CliServerFeaturesSnapshot | undefined;
    activatedPluginIds: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatedPluginIds'];
    activateContributionsOnDemand: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activateContributionsOnDemand'];
    /** Host-private exact-demand acquisition for a managed Provider runtime.
     * Partial consumer fixtures may omit it until they consume managed Providers. */
    acquireManagedProviderRuntime?(
        ref: PluginContributionRef,
    ): Promise<ResolvedManagedProviderRuntime | null>;
    /** Host-private exact-demand acquisition for a Provider's contributed
     * catalog wire formats. Partial consumer fixtures may omit it. */
    acquireProviderCatalogParsers?(
        ref: PluginContributionRef,
    ): Promise<ResolvedProviderCatalogParsers | null>;
    createManagedProviderRuntimeInvocationServices?(input: Readonly<{
        identity: PluginContributionRef;
        purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
        operationClaim?: ManagedProviderRuntimeOperationClaim;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ResolvedManagedProviderRuntimeInvocationServices | null>;
    /**
     * Joins the one SVC09-owned explicit managed-Provider operation claim.
     * This is intentionally host-private: callers supply the launch closure,
     * while the managed-service semantic owner decides whether it wins.
     */
    runManagedProviderExplicitStart?(
        input: ManagedProviderExplicitStartJoinInput,
    ): Promise<ManagedProviderExplicitStartJoinResult>;
    createRetainedManagedProviderRuntimeInvocationServices?(input: Readonly<{
        scope: RetainedManagedProviderRuntimeInvocationScope;
        signal: AbortSignal;
        isCurrent(): boolean;
        readAdoptedPublicOutcome():
            Promise<ManagedProviderAdoptedPublicOutcome | null>;
        revalidatePolicy(): Promise<boolean>;
    }>): Promise<ResolvedManagedProviderRuntimeInvocationServices | null>;
    /** Internal preparation capability. Real resolved registries provide it; partial
     * consumer fixtures may omit it because ordinary invocation never calls it. */
    activatePluginsForValidation?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatePluginsForValidation'];
    /** DATA-DAEMON-DB's one named candidate preparation step. */
    prepareDaemonDatabases?(input: Readonly<{
        pluginIds: readonly string[];
        incumbentContractsByPluginId?: ReadonlyMap<
            string,
            readonly PluginDaemonDatabasePreparedContract[]
        >;
    }>): Promise<void>;
    /** Candidate preparation quiesces only exact incumbent database owners. */
    quiesceDaemonDatabases?(pluginIds: readonly string[]): Promise<PluginDaemonDatabaseQuiescence>;
    /** Exact adopted fixture callbacks available only to the next candidate. */
    readPreparedDaemonDatabaseContracts?(
        pluginId: string,
    ): readonly PluginDaemonDatabasePreparedContract[];
    /** Capability/diagnostic view of the injected measured database policy. */
    readDaemonDatabaseCapability?(pluginId: string): PluginDaemonDatabaseCapability;
    connectedAccountContributions?: ReturnType<typeof createConnectedAccountContributionRegistry>;
    resolveConnectedAccountRuntime?(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | null>;
    connectedAccountRuntimeInvoker?: ConnectedAccountHostRuntimeInvoker;
    resolveQualifiedConnectedAccountEstablishedRuntimeOwner?():
        Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'> | null;
    resolveConnectedAccountPurposeBindingOwner?():
        Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'materialize'> | null;
    managedDependencies?: StablePluginManagedDependenciesHost;
    /**
     * Retained-runner custody entry point. It attests the exact G declaration
     * before deriving only G-required HostAccess and declared Account purposes
     * for the lower-level managed-dependency owner.
     */
    reserveManagedDependencyRetention?(
        retainedAgent: AgentSessionRunnerBindingV1,
    ): Promise<ReturnType<
        StablePluginManagedDependenciesHost['reserveRunnerRetention']
    >>;
    addRuntimeDisposable?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['addRuntimeDisposable'];
    createPluginSettingsService?(params: Readonly<{
        pluginId: string;
        scope: SettingsScopeRef;
        signal?: AbortSignal;
    }>): ScopedSettingsService | null;
    /** UI projection may observe presence or mutate declared secrets, never read them. */
    createPluginSecretsService?(params: Readonly<{
        pluginId: string;
        signal?: AbortSignal;
    }>): SecretsService | null;
    /**
     * Private daemon-secret custody control. It does not use the SDK Secrets
     * surface and therefore cannot select an origin-bound secret unscoped.
     */
    createDaemonPluginSecretAdministrationPort?(params: Readonly<{
        pluginId: string;
        signal?: AbortSignal;
    }>): DeclaredDaemonPluginSecretAdministrationPort | null;
    createPluginEventsService?(params: Readonly<{
        pluginId: string;
        pluginVersion: string;
        signal?: AbortSignal;
    }>): PluginEvents | null;
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
        input: PluginMcpDiscoveryRequest;
        signal: AbortSignal;
    }>): Promise<ResolvedMcpEndpointDiscoveryResult>;
    createAgentInvocationServices: CreateAgentInvocationServices;
    createRetainedRunnerAgentInvocationServices?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            sessionId: string;
            managedDependencyRetention?:
                RunnerManagedDependencyRetentionV1;
            correlationId: string;
            cwd: string;
            environment: Readonly<Record<string, string>>;
            agentCliLaunch?: BoundAgentCliLaunchSpec;
            providerBindingActive: boolean;
            signal: AbortSignal;
            isGenerationCurrent(): boolean;
        }>,
    ): Promise<Readonly<{
        services: PluginServices;
        resourceDescriptors: Readonly<Record<
            string,
            ReturnType<PluginServices['resources']['describe']>
        >>;
        subscriptionCapabilities: Readonly<{
            settingsWatch: boolean;
            eventSubscriptions: readonly PluginContributionRef[];
            resourceWatches: readonly string[];
            notificationPreferencesWatch: boolean;
        }>;
    }>>;
    /** Host-private current-global Actions projection for an exact retained
     * Runner Agent identity. Plugin-contribution action refs remain
     * generation-private and never enter this path. */
    createRetainedRunnerAgentCurrentGlobalActionsService?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            sessionId: string;
            correlationId: string;
            signal: AbortSignal;
            isGenerationCurrent(): boolean;
        }>,
    ): Promise<PluginServices['actions']>;
    /** Host-private current-global MCP projection for an exact retained
     * Runner Agent identity. The selected registry owns current lookup. */
    createRetainedRunnerAgentCurrentGlobalMcpService?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            sessionId: string;
            correlationId: string;
            signal: AbortSignal;
            isGenerationCurrent(): boolean;
        }>,
    ): Promise<PluginServices['mcp']>;
    /** Host-private current-global External Sessions projection for an exact
     * retained Runner Agent identity. Synchronous capabilities remain a
     * conservative Runner-local hint; async operations use this owner. */
    createRetainedRunnerAgentCurrentGlobalExternalSessionsService?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            sessionId: string;
            correlationId: string;
            signal: AbortSignal;
            isGenerationCurrent(): boolean;
        }>,
    ): Promise<PluginServices['sessions']['external']>;
    /** Host-private cancellation boundary for consumers of this resolved registry. */
    retirementSignal?: AbortSignal;
    /** Internal daemon-lifetime broker shared by every registry generation. */
    stableEventsBroker?: import('./invocation/services/events').StablePluginEventsBroker;
    publishHostEvent?(event: HostSemanticEventV1): void;
    /**
     * The bounded capability fact from the exact admitted Resource owner.
     * It is absent when this runtime has no Resource owner; callers must then
     * fail closed rather than reconstruct it from projection metadata.
     */
    getPluginUiResourceCapability?(
        pluginId: string,
    ): ReturnType<StablePluginResourcesOwner['getPluginUiResourceCapability']>;
    /**
     * Consumes the Account change carrier's current Session-access proof. The
     * exact Resource owner retires its own contexts; callers supply neither a
     * Resource inventory nor a per-Session detail result.
     */
    applyResourceSessionAccessWitness?(params: ResourceSessionAccessWitness): void;
    /**
     * The display-only brand fact from the exact admitted Resource owner.
     * It is absent when this runtime has no Resource owner; consumers must not
     * reopen the package or derive a competing brand representation.
     */
    getPluginBrandAsset?(
        pluginId: string,
    ): ReturnType<StablePluginResourcesOwner['getPluginBrandAsset']>;
    resolvePromptAssetBlocks(params: Readonly<{
        agentId: string;
        selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
        sessionId?: string;
        featureIds?: readonly string[];
        machineId?: string;
        projectId?: string;
        /** Static prompt assembly may defer these plugins to per-turn composition. */
        excludePluginIds?: readonly string[];
        signal?: AbortSignal;
    }>): Promise<readonly PromptBlockV1[]>;
    /**
     * Read one declared plugin resource for a mounted plugin UI surface (§3.6).
     *
     * The reference is caller-scoped: the resource service is bound to
     * `callerPluginId`, so a reference naming another plugin resolves to nothing
     * and fails with the ordinary `plugin_resource_not_found` taxonomy. This is
     * the same per-plugin bind every other resource consumer uses; no second
     * resource authority is introduced.
     */
    readUiResource?(params: Readonly<{
        expectedGeneration: string;
        callerPluginId: string;
        resourceId: string;
        /** Host-stamped exact target context; contextual Resources require it. */
        context?: PluginResourceContextV1;
        signal?: AbortSignal;
    }>): Promise<Readonly<{
        kind: PluginResourceKind;
        contentType: string;
        digest: string;
        bytes: Uint8Array;
    }>>;
    /**
     * EU-4b: establish, poll and retire one live resource subscription for a
     * mounted plugin UI surface. Caller-scoped exactly like `readUiResource`,
     * and absent when this generation admits no resources at all.
     */
    openUiResourceWatch?(params: Readonly<{
        expectedGeneration: string;
        callerPluginId: string;
        subscriptionId: string;
        resourceId: string;
        /** Host-stamped exact target context; contextual Resources require it. */
        context?: PluginResourceContextV1;
    }>): Promise<Readonly<{ subscriptionId: string; digest: string }>>;
    pollUiResourceWatch?(params: Readonly<{
        expectedGeneration: string;
        callerPluginId: string;
        subscriptionId: string;
        waitMs?: number;
        signal?: AbortSignal;
    }>): Promise<PluginUiResourceWatchPollResult>;
    closeUiResourceWatch?(params: Readonly<{
        callerPluginId: string;
        subscriptionId: string;
    }>): boolean;
    resolveStructuredMessage?(params: Readonly<{
        expectedGeneration: string;
        kind: string;
        payload: JsonValue;
        resourceRefs?: NonNullable<HostStructuredMessageDescriptorV1['actions']>;
        facts: ContributionPolicyFacts;
        signal?: AbortSignal;
    }>): Promise<StablePluginStructuredMessageResolution>;
    /** Synchronously fences invocation capabilities while resource disposal remains lease-delayed. */
    retireConsumers(): void;
    /** Fences only the named plugin generations while retained peer generations remain usable. */
    retirePluginConsumers?(pluginIds: readonly string[]): void;
    /** Boundedly settles changed generation-scoped background work before replacement starts. */
    settleRetiredBackgroundServices?(pluginIds: readonly string[]): Promise<void>;
    /** Starts committed background work after this registry is adopted/current. */
    startAdoptedBackgroundServices?(): void;
    /** Makes this registry's declared event handlers effect-capable at the
     * synchronous daemon publication boundary. */
    publishDeclaredEventSubscriptions?(): void;
    /** Fences this registry's live push subscriptions — declared event handlers
     * and mounted UI resource watches — synchronously while lease-delayed
     * registry disposal remains pending. */
    retireLiveSubscriptionConsumers?(): void;
    /** This registry's public current-global External Sessions authority. The
     * reload controller publishes exactly one of these at a time and the
     * daemon-lifetime router reads whichever is published now. */
    currentGlobalExternalSessionsTarget?: CurrentGlobalExternalSessionsRouter;
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

/**
 * Author-source preparation owns normalization. The executable registry only
 * reads that candidate-local carrier; the Data host still validates the
 * runtime/static correspondence at its private boundary.
 */
function readPreparedDaemonDatabaseRuntimeProjection(
    module: PluginDaemonModuleNamespace | undefined,
): PluginDaemonDatabaseRuntimeProjection {
    const projection = module?.daemonDatabases;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
        return Object.freeze({}) as PluginDaemonDatabaseRuntimeProjection;
    }
    return projection as PluginDaemonDatabaseRuntimeProjection;
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

function projectPluginMcpDiscoveredEndpoints(
    endpoints: PluginMcpDiscoveryResult['endpoints'],
): readonly PluginMcpDiscoveredEndpoint[] {
    return Object.freeze((endpoints ?? []).map((endpoint) => Object.freeze({
        id: endpoint.id,
        name: endpoint.name,
        kind: endpoint.kind,
        url: endpoint.url,
    })));
}

function projectPluginMcpDiscoveryWarnings(
    warnings: PluginMcpDiscoveryResult['warnings'],
): NonNullable<PluginMcpDiscoveryResult['warnings']> {
    return Object.freeze((warnings ?? []).map((warning) => Object.freeze({
        code: warning.code,
        ...(warning.path === undefined ? {} : { path: warning.path }),
        ...(warning.detail === undefined ? {} : { detail: warning.detail }),
    })));
}

function projectPluginMcpDiscoveryWarningsToLegacyDetection(
    provider: unknown,
    warnings: PluginMcpDiscoveryResult['warnings'],
): readonly DaemonMcpServersDetectWarningV1[] {
    const parsedProvider = McpDetectedProviderV1Schema.safeParse(provider);
    if (!parsedProvider.success) return Object.freeze([]);
    return Object.freeze(projectPluginMcpDiscoveryWarnings(warnings).map((warning) => Object.freeze({
        provider: parsedProvider.data,
        ...warning,
    })));
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
    immutableGenerationIdsByPluginId: ReadonlyMap<string, string>,
    isPluginRuntimeCurrent: (pluginId: string) => boolean,
): ResolvedContributionRegistry {
    const activationTargets = base.activationTargets ?? Object.freeze([]);
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
    const providerRuntimeRegistrations = activated.targetRegistrations.filter((entry) => (
        entry.generation === String(activated.generation)
        && entry.registration.family === 'providers'
    ));
    const projectedProviders = projectTargetProviderRuntimes({
        providers: base.providers ?? [],
        activationTargets,
        targetRegistrations: providerRuntimeRegistrations,
        activationGeneration: String(activated.generation),
        immutableGenerationIdsByPluginId,
        isRegistrationCurrent: (entry) => (
            isPluginRuntimeCurrent(entry.pluginId)
            && activated.activatedPluginIds.has(entry.pluginId)
            && activated.targetRegistrations.includes(entry)
        ),
    });
    const providers = projectedProviders.providers;
    let registeredAgentSpawnHooksProjected = false;
    const agents = base.agents.map((agent) => {
        const runtime = activated.agentRuntimesByAgentId.get(agent.id);
        const agentPluginId = agent.identity?.pluginId ?? agent.pluginId;
        if (
            !runtime?.daemonSpawnHooks
            || !agent.catalogEntry
            || agentPluginId !== runtime.pluginId
            || runtime.generation !== String(activated.generation)
            || !runtime.isCurrent()
            || !isPluginRuntimeCurrent(runtime.pluginId)
            || !activated.activatedPluginIds.has(runtime.pluginId)
        ) {
            return agent;
        }
        if (agent.catalogEntry.getDaemonSpawnHooks) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered daemon spawn hook owners`,
            );
        }
        registeredAgentSpawnHooksProjected = true;
        return Object.freeze({
            ...agent,
            catalogEntry: Object.freeze({
                ...agent.catalogEntry,
                ...projectAgentDaemonSpawnHooksCatalogEntry(runtime.daemonSpawnHooks),
            }),
        });
    });

    if (
        activatedActions.length === 0
        && activatedTools.length === 0
        && activatedCommands.length === 0
        && providerRuntimeRegistrations.length === 0
        && !registeredAgentSpawnHooksProjected
    ) {
        return base.activationTargets === activationTargets
            ? base
            : Object.freeze({ ...base, activationTargets });
    }

    return createResolvedContributionRegistry({
        ...base,
        activationTargets,
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
        agents: registeredAgentSpawnHooksProjected
            ? Object.freeze(agents)
            : base.agents,
        providers,
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            base.pluginDiagnosticsByPluginId,
            projectedProviders.diagnosticsByPluginId,
        ),
    });
}

async function resolveCommittedRelativePath(rootPath: string, candidatePath: string): Promise<string | null> {
    const resolvedRoot = await realpath(resolve(rootPath));
    const resolvedCandidate = await realpath(resolve(candidatePath));
    const relativePath = relative(resolvedRoot, resolvedCandidate);
    if (
        resolvedCandidate === resolvedRoot
        || !isCanonicalAbsolutePathInsideRoot(resolvedRoot, resolvedCandidate)
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
            if (manifestRelativePath !== committedGeneration.record.manifestRelativePath) {
                throw new Error(
                    `Committed resource activation identity manifest path mismatch for '${pluginId}': ${manifestRelativePath ?? '<outside-generation>'}`,
                );
            }
            if (!admittedPaths.has(manifestRelativePath)) {
                throw new Error(`Committed resource activation identity manifest inventory mismatch for '${pluginId}'`);
            }
            await assertContainedRegularGenerationFile(
                committedGeneration.rootPath,
                manifestRelativePath,
                `Committed resource manifest for '${pluginId}'`,
            );
            for (const entryPath of [target.daemonEntryPath, target.devDaemonEntryPath]) {
                if (!entryPath) continue;
                const entryRelativePath = await resolveCommittedRelativePath(committedGeneration.rootPath, entryPath);
                if (!entryRelativePath || !admittedPaths.has(entryRelativePath)) {
                    throw new Error(`Committed resource activation identity runtime entry inventory mismatch for '${pluginId}'`);
                }
                await assertContainedRegularGenerationFile(
                    committedGeneration.rootPath,
                    entryRelativePath,
                    `Committed resource runtime entry for '${pluginId}'`,
                );
            }
        }

        const identity = async (target: (typeof canonicalTargets)[number]): Promise<string> => JSON.stringify({
            provenance: target.provenance,
            source: target.source,
            manifestPath: isBundledArtifact ? target.manifestPath : await realpath(resolve(target.manifestPath)),
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
        /** Daemon-owned live machine identity for host-stamped nested Action callers. */
        resolveCurrentMachineId?: () => string | null;
        /** Existing daemon-local transfer carrier for host-authored media bytes. */
        resolveComposerMediaStageTransferRpcHandler?: () => RpcHandlerInvoker | null;
        /** Fresh server/machine identity; never a retained feature snapshot. */
        resolveCurrentMachineExecutionOriginContext?: (
            signal?: AbortSignal,
        ) => Promise<CurrentMachineExecutionOriginContext | null>;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        pluginIds?: readonly string[];
        generationAuthority?: PluginRuntimeGenerationAuthority;
        preparedActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginActivationGraph>;
        /** Daemon startup injects the measured Background Indexer policy. */
        daemonDatabaseLimits?: PluginDaemonDatabaseLimitsPolicy;
        connectedAccounts?: StablePluginConnectedAccountsOwner;
        /** Canonical current Account resolver for dynamic target-Action form refs. */
        actionFormConnectedAccounts?: Pick<
            ConnectedAccountPurposeBindingOwner,
            'resolveBindingIntent'
        > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>>;
        /** Process-owned Account/system boundary dependencies for the canonical host. */
        accountStorageDependencies?: AccountPluginDataStorageHostDependencies;
        /**
         * The daemon's one retained server features snapshot. Every plugin-facing
         * consumer of a server-represented feature decision reads it from here, so
         * the host never grows a second features cache or currentness path.
         */
        resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
        providers?: PluginProviderOperationsSource;
        managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
        qualifiedConnectedAccountEstablishedRuntimeOwner?:
            Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
        retainedActivationRegistryLeases?: readonly PluginRuntimeActivationRegistryLease[];
        preparedActivationRegistryLeases?: readonly PluginRuntimeActivationRegistryLease[];
        recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
        stableEventsBroker?: import('./invocation/services/events').StablePluginEventsBroker;
        runtimeActionExecute?: RuntimeActionExecute;
        /** Controller-lifetime target-local observer owner; never generation-local. */
        targetedContributions?: StableTargetedContributionsOwner;
        managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
        externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
        resolveExternalSessionCurrentMachineId?: () => string | null;
        externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
        externalSessionsActiveServerDir?: string;
        externalSessionsActiveServerId?: string;
        /**
         * Daemon/controller-lifetime public current-global External Sessions
         * router. Long-lived plugin contexts built by this registry capture it
         * instead of this registry's own owner, so an unchanged plugin that
         * outlives a peer Agent replacement keeps resolving the published
         * generation. Absent it (an ephemeral or scoped registry with no
         * controller), this registry is the only authority and targets itself.
         */
        currentGlobalExternalSessionsRouter?: CurrentGlobalExternalSessionsRouter;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? 0;
    const pluginStorePaths = resolvePluginStorePaths({
        happyHomeDir: params?.happyHomeDir,
    });
    // DATA-DAEMON-DB has one registry-generation-local owner. It remains
    // unavailable until daemon startup injects the measured policy; this
    // resolver supplies no fallback quota or alternative activation path.
    const daemonDatabaseHost = createStablePluginDaemonDatabaseHost({
        paths: pluginStorePaths,
        ...(params?.daemonDatabaseLimits
            ? { daemonDatabaseLimits: params.daemonDatabaseLimits }
            : {}),
    });
    const managedServiceCredentialFiles =
        createManagedServiceCredentialFileOwner({
            rootDir: join(
                pluginStorePaths.secretsDir,
                'managed-services',
            ),
        });
    let contributes = params?.contributes
        ?? await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        });
    const bundledExecutableImmutableArtifacts =
        selectBundledExecutableImmutableArtifacts({
            artifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
            activationTargets: contributes.activationTargets,
        });
    if (!params?.generationAuthority) {
        await prepareBundledExecutableGenerationAdmission({
            artifacts: bundledExecutableImmutableArtifacts,
        });
    }
    const bundledImmutableArtifactsForCurrentHost =
        resolveCurrentHostBundledImmutableArtifacts({
            artifacts: bundledExecutableImmutableArtifacts,
        });
    const committed = params?.generationAuthority ?? await readCurrentCommittedPluginGenerations(
        pluginStorePaths,
        {
            bundledArtifacts: bundledExecutableImmutableArtifacts,
            isolateInvalidInstalledGenerations: true,
        },
    );
    const committedImmutableGenerationIdsByPluginId = new Map(
        [...(committed?.generations.entries() ?? [])].map(([pluginId, admitted]) => [
            pluginId,
            admitted.immutableGenerationId,
        ]),
    );
    if (!params?.generationAuthority && committed?.commit) {
        try {
            const retirement = await reconcilePluginGenerationCustodyRetirement({
                paths: pluginStorePaths,
                commit: committed.commit,
                retainedCurrentHostGenerationIds:
                    bundledImmutableArtifactsForCurrentHost.map(
                        (artifact) => artifact.record.immutableGenerationId,
                    ),
            });
            if (retirement.status === 'authentication-unavailable') {
                logger.warn('[PLUGIN RUNTIME] Obsolete generation custody retirement awaits authentication');
            } else if (retirement.failures.length > 0) {
                logger.warn('[PLUGIN RUNTIME] Obsolete generation custody retirement remains pending', {
                    failures: retirement.failures.map((failure) => ({
                        generationId: failure.generationId,
                        message: projectPluginFailureText(new Error(failure.message)),
                    })),
                });
            }
        } catch (error) {
            logger.warn('[PLUGIN RUNTIME] Obsolete generation custody reconciliation failed', {
                error: projectPluginFailureText(error),
            });
        }
    }
    // The publisher installs the daemon runtime bundle, and the session-runner leaves it
    // stages beside it, outside the compiler's output directory. Activation and relative
    // runner-module resolution both anchor on that published entry, not on the package
    // root export, which is the compiler's own emit and is used only to resolve the
    // installed plugin root.
    const immutableArtifactEntryPathsByPackageName = new Map(
        bundledImmutableArtifactsForCurrentHost.flatMap((artifact) => {
            const admitted = committed?.generations.get(artifact.record.pluginId);
            const entryRelativePath =
                artifact.daemonEntryRelativePath ?? artifact.packageEntryRelativePath;
            return admitted
                ? [[artifact.packageName, join(admitted.rootPath, ...entryRelativePath.split('/'))] as const]
                : [];
        }),
    );
    const immutableArtifactRootPathsByPackageName = new Map(
        bundledImmutableArtifactsForCurrentHost.flatMap((artifact) => {
            const admitted = committed?.generations.get(artifact.record.pluginId);
            return admitted
                ? [[artifact.packageName, admitted.rootPath] as const]
                : [];
        }),
    );
    const immutableArtifactRecordsByPackageName = new Map(
        bundledImmutableArtifactsForCurrentHost.flatMap((artifact) => {
            const admitted = committed?.generations.get(artifact.record.pluginId);
            return admitted
                ? [[artifact.packageName, admitted.record] as const]
                : [];
        }),
    );
    const resolveBundledActivationSource = createBundledActivationSourceResolver({
        bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
        immutableArtifactPackageNames: bundledImmutableArtifactsForCurrentHost.map(
            (artifact) => artifact.packageName,
        ),
        immutableArtifactEntryPathsByPackageName,
        immutableArtifactRootPathsByPackageName,
        immutableArtifactRecordsByPackageName,
        unavailableImmutableArtifactPackageNames: committed?.unavailableBundledPackageNames,
        pluginStorePaths,
    });
    const activatedManifestAuthorityByPluginId = new Map<
        string,
        'external' | 'bundled_first_party'
    >();
    const resolveCommittedActivationSource = (
        target: ActivationTarget,
        options: Readonly<{
            recordActivatedManifestAuthority?: boolean;
        }> = {},
    ): PluginActivationSource<PluginDaemonModuleNamespace> | null => {
        const bundled = resolveBundledActivationSource(target);
        if (bundled) {
            if (options.recordActivatedManifestAuthority !== false) {
                activatedManifestAuthorityByPluginId.set(
                    target.pluginId,
                    'bundled_first_party',
                );
            }
            return bundled;
        }
        if (!committed) return null;
        const admitted = committed.generations.get(target.pluginId);
        if (!admitted?.installation?.trust) return null;
        const installation = admitted.installation;
        const trust = installation.trust;
        if (!trust) return null;
        const useDevelopmentEntry = target.sourceSpec?.devWatch === true && Boolean(target.devDaemonEntryPath);
        const targetEntryPath = useDevelopmentEntry
            ? target.devDaemonEntryPath
            : (target.daemonEntryPath ?? target.devDaemonEntryPath);
        if (!targetEntryPath) return null;
        const entryPath = realpathSync(resolve(targetEntryPath));
        const generationRootPath = realpathSync(admitted.rootPath);
        const relativeEntryPath = relative(generationRootPath, entryPath);
        if (
            entryPath === generationRootPath
            || !isCanonicalAbsolutePathInsideRoot(generationRootPath, entryPath)
        ) {
            throw new Error(`Committed plugin activation entry '${entryPath}' escapes immutable generation '${generationRootPath}' for '${target.pluginId}'`);
        }
        const portableEntryPath = relativeEntryPath.split(sep).join('/');
        if (!admitted.record.files.some((file) => file.relativePath === portableEntryPath)) {
            throw new Error(`Committed plugin activation entry is absent from immutable generation for '${target.pluginId}'`);
        }
        const committedAuthorization = Object.freeze({
            pluginId: target.pluginId,
            immutableGenerationId: admitted.immutableGenerationId,
            distribution: installation.source.distribution,
            trust,
            isCurrent: committed.isCurrent,
        });
        const preparedActivationGraph = params?.preparedActivationGraphsByPluginId?.get(
            target.pluginId,
        );
        if (preparedActivationGraph && (
            preparedActivationGraph.immutableGenerationId !== admitted.immutableGenerationId
            || realpathSync(resolve(preparedActivationGraph.rootPath)) !== generationRootPath
            || realpathSync(resolve(preparedActivationGraph.entryPath)) !== entryPath
        )) {
            throw new Error(
                `Prepared plugin activation graph identity does not match admitted immutable generation for '${target.pluginId}'`,
            );
        }
        const resolveRelativeModule: NonNullable<
            PluginActivationSource<PluginDaemonModuleNamespace>['resolveRelativeModule']
        > = async (module) => {
            const candidateBase = resolve(dirname(entryPath), module);
            const loadMode = resolvePluginModuleLoadMode({
                entryPath,
                useDevelopmentEntry,
            });
            const extensionCandidates = resolvePluginModuleCandidatePaths({
                candidateBase,
                loadMode,
            });
            let modulePath: string | null = null;
            let lexicalModulePath: string | null = null;
            for (const candidate of extensionCandidates) {
                try {
                    const candidateMetadata = await lstat(candidate);
                    if (
                        !candidateMetadata.isSymbolicLink()
                        && !candidateMetadata.isFile()
                    ) {
                        continue;
                    }
                    modulePath = await realpath(candidate);
                    lexicalModulePath = candidate;
                    break;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            if (!modulePath) {
                throw new Error(
                    `Runner module '${module}' was not found in immutable generation for '${target.pluginId}'`,
                );
            }
            if (!lexicalModulePath) {
                throw new Error(
                    `Runner module '${module}' lost its immutable path identity for '${target.pluginId}'`,
                );
            }
            const beforeModuleMetadata = await lstat(lexicalModulePath);
            if (
                beforeModuleMetadata.isSymbolicLink()
                || !beforeModuleMetadata.isFile()
            ) {
                throw new Error(
                    `Runner module '${module}' must be a real immutable file for '${target.pluginId}'`,
                );
            }
            const relativeModulePath = relative(generationRootPath, modulePath);
            if (
                modulePath === generationRootPath
                || !isCanonicalAbsolutePathInsideRoot(generationRootPath, modulePath)
            ) {
                throw new Error(
                    `Runner module '${module}' escapes immutable generation for '${target.pluginId}'`,
                );
            }
            if (modulePath === entryPath) {
                throw new Error(
                    `Runner module '${module}' must be a leaf distinct from the plugin activation entry`,
                );
            }
            const normalizedModulePath = relativeModulePath.split(sep).join('/');
            const inventoryFile = admitted.record.files.find(
                (file) => file.relativePath === normalizedModulePath,
            );
            if (!inventoryFile) {
                throw new Error(
                    `Runner module '${module}' is absent from immutable generation inventory for '${target.pluginId}'`,
                );
            }
            await assertContainedRegularGenerationFile(
                generationRootPath,
                normalizedModulePath,
                `Runner module '${module}'`,
            );
            if (beforeModuleMetadata.size !== inventoryFile.byteLength) {
                throw new Error(
                    `Runner module '${module}' failed immutable generation structural inventory verification for '${target.pluginId}'`,
                );
            }
            if (!await committed.isCurrent()) {
                throw new Error(
                    `Runner module '${module}' generation is no longer current for '${target.pluginId}'`,
                );
            }
            const resolvedLoadMode = resolvePluginModuleLoadMode({
                entryPath: modulePath,
                useDevelopmentEntry,
            });
            const moduleNamespace = await loadPluginModule({
                source: {
                    kind: 'file_backed',
                    entryPath: modulePath,
                    ...(useDevelopmentEntry
                        ? { devEntryPath: modulePath, useDevelopmentEntry: true }
                        : {}),
                    committedAuthorization,
                    ...(preparedActivationGraph
                        ? { generationScope: preparedActivationGraph.generationScope }
                        : {}),
                },
                ...(resolvedLoadMode === 'immutable-js'
                    ? { nativeFileUrlMode: 'canonical' as const }
                    : {}),
            });
            await assertContainedRegularGenerationFile(
                generationRootPath,
                normalizedModulePath,
                `Runner module '${module}'`,
            );
            const afterModuleMetadata = await lstat(lexicalModulePath);
            if (
                afterModuleMetadata.isSymbolicLink()
                || !afterModuleMetadata.isFile()
                || afterModuleMetadata.dev !== beforeModuleMetadata.dev
                || afterModuleMetadata.ino !== beforeModuleMetadata.ino
                || afterModuleMetadata.size !== inventoryFile.byteLength
                || afterModuleMetadata.mtimeMs
                    !== beforeModuleMetadata.mtimeMs
                || afterModuleMetadata.ctimeMs
                    !== beforeModuleMetadata.ctimeMs
                || !await committed.isCurrent()
            ) {
                throw new Error(
                    `Runner module '${module}' generation changed during import for '${target.pluginId}'`,
                );
            }
            return Object.freeze({
                module: moduleNamespace,
                normalizedModulePath,
                loadMode: resolvedLoadMode,
            });
        };
        if (options.recordActivatedManifestAuthority !== false) {
            activatedManifestAuthorityByPluginId.set(
                target.pluginId,
                'external',
            );
        }
        if (preparedActivationGraph) {
            return {
                kind: 'prepared',
                module: preparedActivationGraph.module,
                committedAuthorization,
                resolveRelativeModule,
                persistValidatedAgentSessionRunnerFactories: async (facts) => {
                    await persistValidatedAgentSessionRunnerFactories({
                        paths: resolvePluginStorePaths({
                            happyHomeDir: params?.happyHomeDir,
                        }),
                        record: admitted.record,
                        manifestAuthority: 'external',
                        factories: facts,
                    });
                },
            };
        }
        return {
            kind: 'file_backed',
            entryPath,
            ...(useDevelopmentEntry ? {
                devEntryPath: entryPath,
                useDevelopmentEntry: true,
            } : {}),
            trustPolicy: target.sourceSpec?.trustPolicy,
            committedAuthorization,
            resolveRelativeModule,
            persistValidatedAgentSessionRunnerFactories: async (facts) => {
                await persistValidatedAgentSessionRunnerFactories({
                    paths: resolvePluginStorePaths({
                        happyHomeDir: params?.happyHomeDir,
                    }),
                    record: admitted.record,
                    manifestAuthority: 'external',
                    factories: facts,
                });
            },
        };
    };
    const semanticTargetPluginIds = collectUnresolvedTargetedContributionSemanticTargetPluginIds({
        pluginContributionPoints: contributes.pluginContributionPoints ?? [],
        targetedPluginContributions: contributes.targetedPluginContributions ?? [],
        immutableGenerationIdsByPluginId: Object.freeze(Object.fromEntries(
            committedImmutableGenerationIdsByPluginId,
        )),
    });
    const semanticPointRefsByPluginId = new Map<
        string,
        ReturnType<typeof readTargetedContributionPointSemanticRefs>
    >();
    const activationTargetsByPluginId = new Map(
        contributes.activationTargets
            .filter((target) => target.provenance === 'external')
            .map((target) => [target.pluginId, target] as const),
    );
    for (const pluginId of semanticTargetPluginIds) {
        const target = activationTargetsByPluginId.get(pluginId);
        if (!target || !committed) continue;
        try {
            const source = resolveCommittedActivationSource(target, {
                recordActivatedManifestAuthority: false,
            });
            if (!source || source.kind === 'bundled') continue;
            const module = await loadPluginModule({ source });
            if (!await committed.isCurrent()) continue;
            const moduleManifest = ingestCanonicalPluginManifest(module.manifest, {
                manifestAuthority: 'external',
                // Same record, same provenance as the committed manifest this
                // is compared against: a local working tree is not a published
                // artifact, so the reserved-namespace rule must not silently
                // drop its semantic contribution points.
                sourceProvenance: pluginSourceProvenanceForKind(target.sourceSpec?.kind),
                // The committed JSON manifest already passed the current-host
                // compatibility gate. This is an exact identity check, not a
                // second compatibility decision on a module definition.
                enforceEngineCompatibility: false,
            });
            if (!moduleManifest.ok
                || serializeCanonicalPluginManifest(moduleManifest.manifest)
                    !== serializeCanonicalPluginManifest(target.manifest)) {
                continue;
            }
            const semanticPointRefs = readTargetedContributionPointSemanticRefs(
                module.manifest,
            );
            if (semanticPointRefs.length > 0) {
                semanticPointRefsByPluginId.set(pluginId, semanticPointRefs);
            }
        } catch {
            // The cold registry retains its fail-closed unavailable diagnostic.
            // Loading module definitions adds no activation or fallback path.
        }
    }
    if (committed) {
        try {
            if (!await committed.isCurrent()) {
                semanticPointRefsByPluginId.clear();
            }
        } catch {
            semanticPointRefsByPluginId.clear();
        }
    }
    const pluginContributionPoints = contributes.pluginContributionPoints?.map((point) => {
        const targetRefs = semanticPointRefsByPluginId.get(point.pluginId);
        if (!targetRefs) return point;
        const semanticPointRefs = targetRefs.filter((ref) => (
            ref.targetPluginId === point.pluginId
            && ref.id === point.definition.id
            && point.definition.protocols.some((protocol) => (
                protocol.id === ref.protocol.id
                && protocol.version === ref.protocol.version
            ))
        ));
        return semanticPointRefs.length === 0
            ? point
            : Object.freeze({
                ...point,
                semanticPointRefs: Object.freeze([...semanticPointRefs]),
            });
    });
    contributes = createResolvedContributionRegistry({
        ...contributes,
        ...(pluginContributionPoints ? { pluginContributionPoints } : {}),
        // The first normalization can precede durable generation selection and
        // external definition hydration. Re-run every targeted admission fact
        // only from this one committed snapshot.
        pluginDiagnosticsByPluginId: dropTargetedContributionAdmissionDiagnostics(
            contributes.pluginDiagnosticsByPluginId,
        ),
        immutableGenerationIdsByPluginId: Object.freeze(Object.fromEntries(
            committedImmutableGenerationIdsByPluginId,
        )),
    });
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
    let targetActionInvocations: ReturnType<typeof createTargetActionInvocationRegistry> | null = null;
    let disposeInvocationServiceOwners: () => Promise<void> = async () => {};
    let resolvedRuntimeRegistryOwner: ResolvedExecutablePluginRuntimeRegistry | null = null;
    const retainedActivationRegistryLeases = [...(params?.retainedActivationRegistryLeases ?? [])];
    const retainedActivationPluginIds = new Set(
        retainedActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds]),
    );
    // A scoped runtime can still project every committed Resource declaration,
    // but its activation work remains scoped to the caller's requested
    // components. Dynamic Resource admission below joins only declarations
    // backed by those requested or retained components.
    const scopedActivationPluginIds = params?.pluginIds === undefined
        ? undefined
        : Object.freeze([...new Set(params.pluginIds)].sort());
    const scopedResourceActivationPluginIds = scopedActivationPluginIds === undefined
        ? null
        : new Set([
            ...scopedActivationPluginIds,
            ...retainedActivationPluginIds,
        ]);
    const immutableGenerationIdsByPluginId = new Map(
        committedImmutableGenerationIdsByPluginId,
    );
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
        adoptActivationComponent: (component) => adoptActivationComponent(component),
        invocationServices: {
            createOrdinaryServiceBinding(
                bindingGeneration,
                id,
                hostAccessRequests,
                contributionQualifiedId,
            ) {
                return invocationServiceOwners.createOrdinaryServiceBinding(
                    bindingGeneration,
                    id,
                    hostAccessRequests,
                    contributionQualifiedId,
                );
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
    let preparingActivationComponents = (scopedActivationPluginIds?.length ?? 0) > 0;
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
            ...(scopedActivationPluginIds === undefined ? {} : { pluginIds: scopedActivationPluginIds }),
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
    let allRuntimeConsumersRetired = false;
    const retiredRuntimeConsumerPluginIds = new Set<string>();
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
    const authoritativeContributes = mergeActivatedContributes(
        contributes,
        activatedRegistry,
        immutableGenerationIdsByPluginId,
        (pluginId) => (
            !allRuntimeConsumersRetired
            && !retiredRuntimeConsumerPluginIds.has(pluginId)
        ),
    );
    const resolveExactActivationTarget = (pluginId: string) => {
        const targets = authoritativeContributes.activationTargets.filter((target) => (
            target.pluginId === pluginId
        ));
        return targets.length === 1 ? targets[0]! : null;
    };
    const canonicalResourceActivationTargets =
        committedContributes?.activationTargets
        ?? authoritativeContributes.activationTargets;
    const resolveCanonicalResourceActivationTarget = (pluginId: string) => {
        const targets = canonicalResourceActivationTargets.filter((target) => (
            target.pluginId === pluginId
        ));
        return targets.length === 1 ? targets[0]! : null;
    };
    const committedResourceGenerations = new Map(
        [...(committed?.generations.entries() ?? [])].map(([pluginId, generation]) => {
            const target = resolveCanonicalResourceActivationTarget(pluginId);
            return [
                pluginId,
                Object.freeze({
                    pluginId,
                    immutableGenerationId: generation.immutableGenerationId,
                    rootPath: generation.rootPath,
                    files: generation.record.files,
                    ...(target?.manifest.brand?.iconResourceId === undefined
                        ? {}
                        : { brandIconResourceId: target.manifest.brand.iconResourceId }),
                }),
            ];
        }),
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
            resource.pluginId !== undefined
            && admittedResourcePluginIds.has(resource.pluginId)
            // Full catalog projection deliberately retains unrelated dynamic
            // declarations during a scoped candidate. Do not make a cold
            // plugin's producer an install prerequisite; do keep a requested
            // plugin's declaration so the strict Resource owner rejects a
            // missing producer instead of silently omitting it.
            && (
                !isDynamicPluginResourceContributionV2(resource.definition)
                || scopedResourceActivationPluginIds === null
                || scopedResourceActivationPluginIds.has(resource.pluginId)
            )
        ));
    const hasCommittedResourceActivationTarget = (pluginId: string): boolean => (
        canonicalResourceActivationTargets.filter((target) => (
            target.pluginId === pluginId
        )).length === 1
    );
    const resolveServerFeaturesSnapshot = params?.resolveServerFeaturesSnapshot;
    const accountStorageHost = createAccountPluginDataStorageHost({
        contracts: (authoritativeContributes.accountCollections ?? Object.freeze([]))
            .map((entry) => entry.definition),
        ...(params?.accountStorageDependencies ?? {}),
        // Collection admission and plugin-facing feature decisions consume the SAME
        // daemon snapshot resolver; the host does not keep a second one.
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
    });
    const bindDynamicResourceAccountStorage = createPluginResourceAccountStorageResolver({
        accountStorage: accountStorageHost,
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess ?? Object.freeze([]);
        },
    });
    // §3.6.1: the dynamic arm of the resource family is bound to the runtime
    // producer its plugin registered during activation. The packaged arm has no
    // producer and contributes nothing here.
    const dynamicResourceProducers = activatedRegistry.targetRegistrations.flatMap((entry) => (
        entry.registration.family === 'resources'
            ? (() => {
                const target = resolveCanonicalResourceActivationTarget(entry.pluginId);
                if (!target) {
                    throw new Error(`Resource activation target is unavailable for '${entry.pluginId}'`);
                }
                const declaration = target?.manifest.contributes.resources.find((resource) => (
                    resource.id === entry.registration.localId
                ));
                if (!declaration || !isDynamicPluginResourceContributionV2(declaration)) {
                    throw new Error(
                        `Dynamic resource declaration is unavailable for '${entry.pluginId}/${entry.registration.localId}'`,
                    );
                }
                return [Object.freeze({
                pluginId: entry.pluginId,
                localId: entry.registration.localId,
                hostAccessRequests: resolveManifestHostAccessRequests({
                    manifest: target.manifest,
                    pluginId: entry.pluginId,
                    contribution: {
                        family: 'resources',
                        localId: entry.registration.localId,
                    },
                    requestIds: declaration.hostAccess,
                }),
                runtime: entry.registration.value,
                })];
            })()
            : []
    ));
    const resourcesOwner = committed && committedResourceGenerations.size > 0
        ? await createStablePluginResourcesOwner({
            registry: {
                resources: committedResourceContributes.flatMap((resource) => {
                    if (resource.pluginId === undefined) return [];
                    const generation = committed?.generations.get(resource.pluginId);
                    if (!generation) return [];
                    if (!hasCommittedResourceActivationTarget(resource.pluginId)) {
                        throw new Error(`Committed resource activation target is unavailable for '${resource.pluginId}'`);
                    }
                    return [Object.freeze({ ...resource, pluginRootPath: generation.rootPath })];
                }),
            },
            generations: committedResourceGenerations,
            immutableGenerationIdsByPluginId:
                committedImmutableGenerationIdsByPluginId,
            dynamicProducers: dynamicResourceProducers,
            bindDynamicResourceAccountStorage,
            ...(params?.resolveSessionResourceAccess
                ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
                : {}),
            isCommittedGenerationCurrent: committed.isCurrent,
        })
        : undefined;
    for (const asset of authoritativeContributes.promptAssets ?? []) {
        const assetGeneration = committed?.generations.get(asset.pluginId);
        if (assetGeneration && !hasCommittedResourceActivationTarget(asset.pluginId)) {
            throw new Error(`Committed prompt asset activation target is unavailable for '${asset.pluginId}'`);
        }
    }
    const allRuntimeConsumerRetirement = new AbortController();
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
    const resolveCurrentPluginImmutableGenerationId = async (
        pluginId: string,
    ): Promise<string | null> => {
        // Immutable generation identity comes only from the committed
        // authority. In particular, do not use the activation-local bundled
        // fallback: it is not a materialization or a durable admitted identity.
        if (!isPluginConsumerCurrent(pluginId) || !committed) return null;
        const admitted = committed.generations.get(pluginId);
        if (!admitted) return null;
        try {
            if (!await committed.isCurrent() || !isPluginConsumerCurrent(pluginId)) {
                return null;
            }
        } catch {
            return null;
        }
        return admitted.immutableGenerationId;
    };
    const resolveCurrentPluginMaterializationRef = (
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null => {
        // This is the canonical materialization/currentness owner. A retired,
        // disabled, or non-activated plugin cannot keep supplying an old
        // materialization merely because a caller retained its id.
        if (
            !isPluginConsumerCurrent(pluginId)
            || !activatedRegistry.activatedPluginIds.has(pluginId)
        ) {
            return null;
        }
        let machineId: string | null | undefined;
        try {
            machineId = params?.resolveCurrentMachineId?.();
        } catch {
            return null;
        }
        const materialization = PluginMachineMaterializationRefV1Schema.safeParse({
            machineId,
            materializationId:
                authoritativeContributes.materializationIdsByPluginId?.[pluginId],
            pluginId,
        });
        return materialization.success ? Object.freeze(materialization.data) : null;
    };
    const resolveCurrentMediatorContributionMaterializationRef = (
        mediator: Readonly<{
            pluginId: string;
            contributionLocalId: string;
        }>,
    ): PluginMachineMaterializationRefV1 | null => {
        const materialization = resolveCurrentPluginMaterializationRef(mediator.pluginId);
        if (!materialization) return null;
        const registered = activatedRegistry.targetRegistrations.some((entry) => (
            entry.pluginId === mediator.pluginId
            && entry.generation === String(activatedRegistry.generation)
            && entry.registration.localId === mediator.contributionLocalId
        ));
        return registered ? materialization : null;
    };
    const sameMaterialization = (
        left: PluginMachineMaterializationRefV1,
        right: PluginMachineMaterializationRefV1,
    ): boolean => (
        left.pluginId === right.pluginId
        && left.machineId === right.machineId
        && left.materializationId === right.materializationId
    );
    const revalidatePluginActionCallerMaterialization = async (
        candidate: PluginMachineMaterializationRefV1,
    ): Promise<boolean> => {
        const current = resolveCurrentPluginMaterializationRef(candidate.pluginId);
        return current !== null && sameMaterialization(current, candidate);
    };
    const revalidatePluginActionCallerImmutableGeneration = async (
        candidate: Readonly<{ pluginId: string; immutableGenerationId: string }>,
    ): Promise<boolean> => (
        (await resolveCurrentPluginImmutableGenerationId(candidate.pluginId))
        === candidate.immutableGenerationId
    );
    const resolveCurrentPluginExecutionOrigin = async (
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<PluginMachineExecutionOriginV1 | null> => {
        signal?.throwIfAborted();
        if (!params?.resolveCurrentMachineExecutionOriginContext) return null;
        const beforeMaterialization = resolveCurrentPluginMaterializationRef(pluginId);
        if (!beforeMaterialization) return null;
        let context: CurrentMachineExecutionOriginContext | null;
        try {
            context = await params.resolveCurrentMachineExecutionOriginContext(signal);
        } catch {
            return null;
        }
        signal?.throwIfAborted();
        const afterMaterialization = resolveCurrentPluginMaterializationRef(pluginId);
        if (
            !context
            || !afterMaterialization
            || !sameMaterialization(beforeMaterialization, afterMaterialization)
            || context.machineId !== afterMaterialization.machineId
        ) return null;
        const origin = PluginMachineExecutionOriginV1Schema.safeParse({
            serverIdentityId: context.serverIdentityId,
            materializationRef: afterMaterialization,
        });
        return origin.success ? Object.freeze({
            serverIdentityId: origin.data.serverIdentityId,
            materializationRef: Object.freeze({ ...origin.data.materializationRef }),
        }) : null;
    };
    const collectionContractMatchesRef = (
        contract: NormalizedPluginAccountCollectionContractV1,
        ref: PluginCollectionContractRefV1,
    ): boolean => (
        contract.pluginId === ref.pluginId
        && contract.collectionId === ref.collectionId
        && contract.schemaVersion === ref.schemaVersion
        && contract.contractDigest === ref.contractDigest
    );
    const sameCollectionContractSet = (
        left: readonly NormalizedPluginAccountCollectionContractV1[],
        right: readonly PluginCollectionContractRefV1[],
    ): boolean => (
        left.length === right.length
        && left.every((contract) => right.some((ref) => collectionContractMatchesRef(contract, ref)))
    );
    const sameExecutionOrigin = (
        left: PluginMachineExecutionOriginV1,
        right: PluginMachineExecutionOriginV1,
    ): boolean => (
        left.serverIdentityId === right.serverIdentityId
        && sameMaterialization(left.materializationRef, right.materializationRef)
    );
    const resolveExactCurrentCollectionMigrationArtifactDigest = (input: Readonly<{
        pluginId: string;
        releaseVersion: string;
        artifactDigest: PluginUiArtifactDigestV1;
    }>): PluginUiArtifactDigestV1 | null => {
        const matches = collectResolvedGeneratedReactNativeArtifactOwners(authoritativeContributes)
            .flatMap((owner) => {
                if (
                    owner.kind !== 'renderer'
                    || owner.pluginId !== input.pluginId
                    || owner.pluginVersion !== input.releaseVersion
                ) return [];
                return (['web', 'ios', 'android'] as const).flatMap((platform) => {
                    const migration = findGeneratedReactNativeCollectionMigrationsModule({
                        owner,
                        platform,
                    });
                    return migration.entry?.digest === input.artifactDigest
                        ? [migration.entry]
                        : [];
                });
            });
        // The digest is a public stage identity only after it has been resolved
        // from a current, committed generated graph with the declared migration
        // export. A request cannot mint a parallel stage namespace by varying
        // this opaque value.
        return matches[0]?.digest ?? null;
    };
    const prepareCollectionMigrationCandidates = async (input: Readonly<{
        source: Readonly<{
            release: PluginReleaseRefV1;
            collectionContracts: readonly NormalizedPluginAccountCollectionContractV1[];
        }>;
        candidate: Readonly<{
            release: PluginReleaseRefV1;
            artifactDigest: PluginUiArtifactDigestV1;
            origin: PluginMachineExecutionOriginV1;
            collectionContracts: readonly PluginCollectionContractRefV1[];
        }>;
        signal: AbortSignal;
        isRequestCurrent(): boolean | Promise<boolean>;
    }>): Promise<
        | Readonly<{
            kind: 'prepared';
            bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
        }>
        | Readonly<{
            kind: 'unavailable';
            code:
                | 'candidate_contract_mismatch'
                | 'candidate_currentness_changed'
                | 'candidate_preparation_unavailable';
        }>
    > => {
        const unavailable = (
            code: 'candidate_contract_mismatch' | 'candidate_currentness_changed' | 'candidate_preparation_unavailable',
        ) => Object.freeze({ kind: 'unavailable' as const, code });
        if (input.source.release.pluginId !== input.candidate.release.pluginId) {
            return unavailable('candidate_contract_mismatch');
        }
        const pluginId = input.candidate.release.pluginId;
        const immutableGenerationId = await resolveCurrentPluginImmutableGenerationId(pluginId);
        if (!immutableGenerationId) return unavailable('candidate_currentness_changed');
        const isCandidateCurrent = async (): Promise<boolean> => {
            if (input.signal.aborted) return false;
            let requestCurrent = false;
            try {
                requestCurrent = await input.isRequestCurrent();
            } catch {
                return false;
            }
            if (!requestCurrent || input.signal.aborted) return false;
            try {
                const [currentGenerationId, currentOrigin] = await Promise.all([
                    resolveCurrentPluginImmutableGenerationId(pluginId),
                    resolveCurrentPluginExecutionOrigin(pluginId, input.signal),
                ]);
                return !input.signal.aborted
                    && currentGenerationId === immutableGenerationId
                    && currentOrigin !== null
                    && sameExecutionOrigin(currentOrigin, input.candidate.origin);
            } catch {
                return false;
            }
        };
        if (!await isCandidateCurrent()) return unavailable('candidate_currentness_changed');

        const target = resolveExactActivationTarget(pluginId);
        if (
            !target
            || target.manifest.version !== input.candidate.release.version
        ) {
            return unavailable('candidate_contract_mismatch');
        }
        const artifactDigest = resolveExactCurrentCollectionMigrationArtifactDigest({
            pluginId,
            releaseVersion: input.candidate.release.version,
            artifactDigest: input.candidate.artifactDigest,
        });
        if (!artifactDigest) {
            return unavailable('candidate_contract_mismatch');
        }

        let projected: ReturnType<typeof projectPluginAuthorModule>;
        try {
            const source = resolveCommittedActivationSource(target, {
                recordActivatedManifestAuthority: false,
            });
            if (!source) return unavailable('candidate_preparation_unavailable');
            if (source.kind === 'bundled' && source.prepare) {
                try {
                    await source.prepare();
                } catch {
                    // Match the canonical activation loader's one bounded
                    // bundled-preparation retry without creating another loader.
                    await source.prepare();
                }
            }
            if (!await isCandidateCurrent()) return unavailable('candidate_currentness_changed');
            const module = await loadPluginModule({
                source,
                ...(source.kind === 'bundled'
                    ? { cacheKey: `generation:${immutableGenerationId}` }
                    : {}),
            });
            if (!await isCandidateCurrent()) return unavailable('candidate_currentness_changed');
            // This validates the static manifest and callback projection but
            // intentionally never invokes `activate`.
            projected = projectPluginAuthorModule(module);
        } catch {
            return !await isCandidateCurrent()
                ? unavailable('candidate_currentness_changed')
                : unavailable('candidate_preparation_unavailable');
        }
        if (
            serializeCanonicalPluginManifest(projected.manifest)
                !== serializeCanonicalPluginManifest(target.manifest)
        ) {
            return unavailable('candidate_contract_mismatch');
        }

        let targetContracts: readonly NormalizedPluginAccountCollectionContractV1[];
        try {
            targetContracts = normalizePluginAccountCollectionContractsV1({
                pluginId,
                contributions: projected.manifest.contributes.accountCollections,
            });
        } catch {
            return unavailable('candidate_contract_mismatch');
        }
        if (!sameCollectionContractSet(targetContracts, input.candidate.collectionContracts)) {
            return unavailable('candidate_contract_mismatch');
        }

        const stages: CollectionMigrationCandidateHandle[] = [];
        const bindings: PluginCollectionCandidatePreparationBindingV1[] = [];
        const retireStages = async (): Promise<void> => {
            await Promise.all(stages.map(async (stage) => {
                try {
                    await stage.retire();
                } catch {
                    // Each handle retains only its exact already-admitted
                    // Account authority; a later Availability retry owns any
                    // durable cleanup that could not complete here.
                }
            }));
        };
        try {
            for (const sourceContract of input.source.collectionContracts) {
                if (
                    sourceContract.pluginId !== input.source.release.pluginId
                    || !await isCandidateCurrent()
                ) {
                    await retireStages();
                    return unavailable('candidate_currentness_changed');
                }
                const targetContract = targetContracts.find((contract) => (
                    contract.collectionId === sourceContract.collectionId
                ));
                if (!targetContract) {
                    await retireStages();
                    return unavailable('candidate_contract_mismatch');
                }
                const binding: PluginCollectionCandidatePreparationBindingV1 = Object.freeze({
                    source: Object.freeze({
                        pluginId: sourceContract.pluginId,
                        collectionId: sourceContract.collectionId,
                        schemaVersion: sourceContract.schemaVersion,
                        contractDigest: sourceContract.contractDigest,
                    }),
                    target: Object.freeze({
                        pluginId: targetContract.pluginId,
                        collectionId: targetContract.collectionId,
                        schemaVersion: targetContract.schemaVersion,
                        contractDigest: targetContract.contractDigest,
                    }),
                    candidate: Object.freeze({
                        releaseVersion: input.candidate.release.version,
                        artifactDigest,
                    }),
                });
                const stage = accountStorageHost.createCollectionMigrationCandidate({
                    binding,
                    sourceContract,
                    targetContract,
                    declarations: projected.manifest.contributes.accountCollections,
                    runtime: projected.module.collectionMigrations,
                    signal: input.signal,
                    isGenerationCurrent: isCandidateCurrent,
                });
                stages.push(stage);
                await stage.prepare();
                bindings.push(binding);
            }
            if (!await isCandidateCurrent()) {
                await retireStages();
                return unavailable('candidate_currentness_changed');
            }
            return Object.freeze({
                kind: 'prepared' as const,
                bindings: Object.freeze(bindings),
            });
        } catch {
            await retireStages();
            return !await isCandidateCurrent()
                ? unavailable('candidate_currentness_changed')
                : unavailable('candidate_preparation_unavailable');
        }
    };
    const retireCollectionMigrationCandidates = async (input: Readonly<{
        bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
        signal: AbortSignal;
        isRequestCurrent(): boolean | Promise<boolean>;
    }>): Promise<void> => {
        const isCurrent = async (): Promise<boolean> => {
            if (input.signal.aborted) return false;
            try {
                return await input.isRequestCurrent() && !input.signal.aborted;
            } catch {
                return false;
            }
        };
        if (!await isCurrent()) {
            throw new Error('Collection candidate retirement request is no longer current');
        }
        const results = await Promise.allSettled(input.bindings.map(async (binding) => {
            await accountStorageHost.retireCollectionMigrationCandidate({
                binding,
                signal: input.signal,
                isCurrent,
            });
        }));
        if (!await isCurrent()) {
            throw new Error('Collection candidate retirement request is no longer current');
        }
        if (results.some((result) => result.status === 'rejected')) {
            throw new Error('Collection candidate retirement is unavailable');
        }
    };
    /**
     * EU-4b: the daemon half of the live-resource transport for mounted plugin
     * UI surfaces. It exists only when this generation has an admitted resource
     * owner, so a generation with no resources advertises no watch at all.
     */
    const uiResourceWatches = resourcesOwner
        ? createStablePluginUiResourceWatchOwner({
            generation: String(activatedRegistry.generation),
            resources: resourcesOwner,
            isPluginConsumerCurrent,
            ...(params?.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        })
        : undefined;
    const composePluginConsumerSignal = (
        pluginId: string,
        callerSignal?: AbortSignal,
    ): AbortSignal => {
        const retirementSignal = resolveRuntimeConsumerLifecycle(pluginId).retirementSignal;
        return callerSignal
            ? AbortSignal.any([callerSignal, retirementSignal])
            : retirementSignal;
    };
    const prepareDaemonDatabases = async (input: Readonly<{
        pluginIds: readonly string[];
        incumbentContractsByPluginId?: ReadonlyMap<
            string,
            readonly PluginDaemonDatabasePreparedContract[]
        >;
    }>): Promise<void> => {
        for (const pluginId of [...new Set(input.pluginIds)].sort()) {
            const target = resolveExactActivationTarget(pluginId);
            const declarations = target?.manifest.contributes.daemonDatabases ?? Object.freeze([]);
            if (declarations.length === 0) continue;
            const lifecycle = resolveRuntimeConsumerLifecycle(pluginId);
            const graph = params?.preparedActivationGraphsByPluginId?.get(pluginId);
            const incumbentContracts = input.incumbentContractsByPluginId?.get(pluginId);
            await daemonDatabaseHost.prepare({
                pluginId,
                generation: String(activatedRegistry.generation),
                signal: lifecycle.retirementSignal,
                isGenerationCurrent: lifecycle.isCurrent,
                declarations,
                runtime: readPreparedDaemonDatabaseRuntimeProjection(graph?.module),
                ...(incumbentContracts
                    ? { incumbentContracts }
                    : {}),
            });
        }
    };
    const quiesceDaemonDatabases = async (
        pluginIds: readonly string[],
    ): Promise<PluginDaemonDatabaseQuiescence> => await daemonDatabaseHost.quiesce(pluginIds);
    const retirePluginConsumers = (pluginIds: readonly string[]): void => {
        activatedRegistry.retireBackgroundServices(pluginIds);
        for (const pluginId of new Set(pluginIds)) {
            retiredRuntimeConsumerPluginIds.add(pluginId);
            resourcesOwner?.retirePlugin(pluginId);
            const lifecycle = resolveRuntimeConsumerLifecycle(pluginId);
            if (!lifecycle.controller.signal.aborted) {
                lifecycle.controller.abort(createRetiredPluginGenerationError(pluginId));
            }
        }
    };
    const buildPromptAssetAdapterRegistry = () => createTargetPromptAssetAdapterRegistry({
        generation: activatedRegistry.generation,
        promptAssets: (authoritativeContributes.promptAssets ?? []).map((asset) => Object.freeze({
            pluginId: asset.pluginId,
            localId: asset.definition.id,
            ...(asset.definition.adapterDescriptor
                ? { adapterDescriptor: asset.definition.adapterDescriptor }
                : {}),
        })),
        targetRegistrations: activatedRegistry.targetRegistrations,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
    });
    // Prompt Asset adapters are re-projected on every on-demand activation, so a
    // mis-authored adapter's refusal is recorded here and folded into the plugin's
    // diagnostics by `refreshPluginDiagnostics` below.
    let promptAssetProjectionDiagnosticsByPluginId:
        Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> = Object.freeze({});
    const initialPromptAssetAdapterRegistry = buildPromptAssetAdapterRegistry();
    promptAssetProjectionDiagnosticsByPluginId =
        initialPromptAssetAdapterRegistry.diagnosticsByPluginId;
    const promptAssetAdapters = new Map(initialPromptAssetAdapterRegistry.adapters);
    const refreshPromptAssetAdapterRegistry = (): void => {
        const next = buildPromptAssetAdapterRegistry();
        promptAssetProjectionDiagnosticsByPluginId = next.diagnosticsByPluginId;
        promptAssetAdapters.clear();
        for (const [assetTypeId, adapter] of next.adapters) {
            promptAssetAdapters.set(assetTypeId, adapter);
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
            async createAgentInvocationServices(agentParams) {
                if (!resolvedRuntimeRegistryOwner) {
                    throw new Error(
                        'Executable plugin runtime registry is not ready for Agent invocation',
                    );
                }
                return await resolvedRuntimeRegistryOwner
                    .createAgentInvocationServices(agentParams);
            },
            ...(params?.managedEndpointRead
                ? { managedEndpointRead: params.managedEndpointRead }
                : {}),
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
    const sessionCredentials = await readStoredCredentials();
    const configuredExternalSessionAgentDemands = Object.freeze(
        authoritativeContributes.agents.flatMap((agent) => (
            agent.pluginId
            && agent.richDefinition?.definition.surfaces?.externalSession.sources
                .some((source) => (source.instances?.length ?? 0) > 0) === true
                ? [Object.freeze({
                    pluginId: agent.pluginId,
                    family: 'agents' as const,
                    localId: agent.identity?.localId ?? agent.id,
                })]
                : []
        )),
    );
    let currentGlobalExternalSessions: Awaited<
        ReturnType<typeof createCurrentGlobalExternalSessionsAuthorService>
    > | null = null;
    type CurrentGlobalExternalSessionsPublicationBasis = Readonly<{
        contributionGenerationId: string;
        agents: readonly Readonly<{
            agentId: string;
            pluginId: string | null;
            identity: PluginContributionIdentityV1 | null;
            externalSessionDefinition: unknown;
            runtimeGeneration: string;
            immutableGenerationId: string | null;
        }>[];
    }>;
    let currentGlobalExternalSessionsPublicationBasis:
        CurrentGlobalExternalSessionsPublicationBasis | null = null;
    // A single lazy plugin activation can satisfy several public calls. Each
    // caller still reaches this publication boundary, so serialize the owner
    // replacement rather than letting stale pre-await snapshots publish.
    let currentGlobalExternalSessionsPublicationTail: Promise<void> = Promise.resolve();
    // One Agent whose own provider leaf refuses its configured source must not
    // remove the External Sessions service from every other Agent and every
    // other plugin. The configured-source owner drops just that candidate and
    // names it here, through the same per-plugin refusal seam the activation
    // owner uses to isolate a throwing `activate()` — with a non-blocking code,
    // see `externalSessionSourceRefusals.ts`. Republished wholesale on every
    // rebuild, like the Prompt Asset registry.
    let externalSessionProjectionDiagnosticsByPluginId:
        Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> = Object.freeze({});
    const readExternalSessionsFailureCause = (error: unknown): string | null => {
        const cause = (error as { cause?: unknown } | null | undefined)?.cause;
        if (cause === undefined || cause === null) return null;
        return cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : String(cause);
    };
    const refreshCurrentGlobalExternalSessionsAuthorUnlocked = async (): Promise<void> => {
        if (!sessionCredentials) return;
        const activeAgents = authoritativeContributes.agents.flatMap((agent) => {
            const lease = agentRuntimesByAgentId.get(agent.id);
            if (
                !lease?.externalSessions
                || !lease.isCurrent()
                || agent.richDefinition?.definition.surfaces?.externalSession.sources
                    .some((source) => (source.instances?.length ?? 0) > 0) !== true
            ) {
                return [];
            }
            return [Object.freeze({ agent, lease })];
        });
        if (activeAgents.length === 0) {
            currentGlobalExternalSessions?.dispose();
            currentGlobalExternalSessions = null;
            currentGlobalExternalSessionsPublicationBasis = null;
            externalSessionProjectionDiagnosticsByPluginId = Object.freeze({});
            return;
        }
        const agents = Object.freeze(activeAgents.map(({ agent }) => agent));
        // Account revisions are owned by the live configured-source materializer
        // within this service. Rebuilding here would create a second Account
        // lifecycle owner and unnecessarily retire active author operations.
        const publicationBasis: CurrentGlobalExternalSessionsPublicationBasis = Object.freeze({
            contributionGenerationId: String(activatedRegistry.generation),
            agents: Object.freeze(activeAgents.map(({ agent, lease }) => Object.freeze({
                agentId: agent.id,
                pluginId: agent.pluginId ?? null,
                identity: agent.identity ?? null,
                externalSessionDefinition:
                    agent.richDefinition?.definition.surfaces?.externalSession ?? null,
                runtimeGeneration: lease.generation,
                immutableGenerationId: lease.immutableGenerationId ?? null,
            }))),
        });
        if (
            currentGlobalExternalSessions
            && currentGlobalExternalSessionsPublicationBasis
            && isDeepStrictEqual(
                currentGlobalExternalSessionsPublicationBasis,
                publicationBasis,
            )
        ) {
            return;
        }
        const previous = currentGlobalExternalSessions;
        try {
            const next = await createCurrentGlobalExternalSessionsAuthorService({
                contributionGenerationId: publicationBasis.contributionGenerationId,
                agents,
                ...(params?.externalSessionsActiveServerDir
                    ? { activeServerDir: params.externalSessionsActiveServerDir }
                    : {}),
                ...(params?.externalSessionsActiveServerId
                    ? { activeServerId: params.externalSessionsActiveServerId }
                    : {}),
                readCredentials: readStoredCredentials,
                resolveMachineId: () =>
                    params?.resolveExternalSessionCurrentMachineId?.() ?? null,
                resolveAgentRuntime(agentId) {
                    const lease = agentRuntimesByAgentId.get(agentId);
                    if (!lease?.externalSessions || !lease.isCurrent()) return null;
                    const agent = agents.find((candidate) => candidate.id === agentId);
                    const writerSafety = agent?.richDefinition?.definition
                        .surfaces?.externalSession.externalLinkedTakeover?.writerSafety
                        ?? 'unsupported';
                    return Object.freeze({
                        generationId: lease.generation,
                        immutableGenerationId: lease.immutableGenerationId ?? null,
                        retirementSignal: lease.retirementSignal,
                        isCurrent: lease.isCurrent,
                        surface: createAgentExternalSessionsExecutionSurface(
                            lease.externalSessions,
                            writerSafety,
                        ),
                    });
                },
                ...(params?.externalSessionHostOperationOwner
                    ? {
                        externalSessionHostOperationOwner:
                            params.externalSessionHostOperationOwner,
                    }
                    : {}),
                isCurrent: () => !allRuntimeConsumersRetired,
            });
            currentGlobalExternalSessions = next;
            currentGlobalExternalSessionsPublicationBasis = publicationBasis;
            externalSessionProjectionDiagnosticsByPluginId =
                projectExternalSessionSourceRefusalDiagnostics(agents, next.sourceRefusals);
            previous?.dispose();
        } catch (error) {
            // Only a host-integrity failure reaches here now — an unreadable
            // Account, or a malformed/undeclared/duplicate configured source the
            // host itself owns. Those make the host's own view of which sources
            // exist untrustworthy, so the service still fails closed; a single
            // Agent's provider refusal no longer takes this path. Never silent:
            // this is the only record of why every caller now sees unavailable.
            previous?.dispose();
            currentGlobalExternalSessions = null;
            currentGlobalExternalSessionsPublicationBasis = null;
            externalSessionProjectionDiagnosticsByPluginId = Object.freeze({});
            logger.warn(
                '[PLUGIN RUNTIME] Current-global External Sessions service is unavailable',
                {
                    contributionGenerationId: publicationBasis.contributionGenerationId,
                    agentIds: agents.map((agent) => agent.id),
                    error: error instanceof Error ? error.message : String(error),
                    ...(typeof (error as { code?: unknown } | null)?.code === 'string'
                        ? { code: (error as unknown as { code: string }).code }
                        : {}),
                    // The typed code alone is what hid this failure before; the
                    // owner attaches the real rebuild failure as `cause`.
                    ...(readExternalSessionsFailureCause(error) === null
                        ? {}
                        : { cause: readExternalSessionsFailureCause(error) }),
                },
            );
        }
    };
    /**
     * This registry's own public current-global authority. It becomes THE
     * authority only while this registry is the published one; long-lived
     * callers reach it through the daemon-lifetime router below.
     */
    const currentGlobalExternalSessionsTarget: CurrentGlobalExternalSessionsRouter =
        Object.freeze({
            resolveCurrent: () => currentGlobalExternalSessions,
            activateConfiguredSources: async (agentId?: string) => {
                // Callers address an Agent by its host routing id; an
                // activation demand names the Agent's durable
                // `{pluginId, localId}` contribution identity. Resolve one to
                // the other through the catalog instead of comparing a routing
                // id to a local id, which never matches for an installed Agent
                // or for a bundled Agent whose manifest id is cased
                // differently.
                const identity = agentId
                    ? authoritativeContributes.agentDefinitionsById
                        .get(agentId)?.identity
                    : undefined;
                const demands = agentId
                    ? (identity
                        ? configuredExternalSessionAgentDemands.filter(
                            (demand) => demand.pluginId === identity.pluginId
                                && demand.localId === identity.localId,
                        )
                        : [])
                    : configuredExternalSessionAgentDemands;
                if (demands.length === 0) return;
                await activateContributionsOnDemand(demands);
            },
        });
    const publicCurrentGlobalExternalSessions: CurrentGlobalExternalSessionsRouter =
        params?.currentGlobalExternalSessionsRouter
        ?? currentGlobalExternalSessionsTarget;
    const refreshCurrentGlobalExternalSessionsAuthor = async (): Promise<void> => {
        const previousPublication = currentGlobalExternalSessionsPublicationTail;
        let releasePublication!: () => void;
        currentGlobalExternalSessionsPublicationTail = new Promise<void>((resolve) => {
            releasePublication = resolve;
        });
        try {
            await previousPublication;
            await refreshCurrentGlobalExternalSessionsAuthorUnlocked();
        } finally {
            releasePublication();
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
        family: 'mcp.servers' | 'mcp.discoverySources';
        entry: (typeof activatedRegistry.targetRegistrations)[number];
        pluginVersion: string;
        callerSeed: PluginInvocationServicesSeed;
        signal?: AbortSignal;
    }>): Readonly<{
        context: PluginInvocationContext;
        lifetime: PluginInvocationLifetime;
    }> {
        const lifetime = createPluginInvocationLifetime(
            contextParams.signal ?? contextParams.callerSeed.signal,
        );
        const immutableGenerationId = immutableGenerationIdsByPluginId.get(
            contextParams.ref.pluginId,
        );
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
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isGenerationCurrent: () => (
                contextParams.callerSeed.isGenerationCurrent()
                && activatedRegistry.targetRegistrations.includes(contextParams.entry)
            ),
        });
        const presentationOwner = runtimeSeed.session
            && runtimeSeed.currentSession
            && immutableGenerationId
            ? Object.freeze({
                pluginId: runtimeSeed.plugin.id,
                contributionId: runtimeSeed.contribution.id,
                generationId: immutableGenerationId,
                invocationId: runtimeSeed.correlationId,
            })
            : undefined;
        try {
            const serviceBinding = addMcpAvailablePluginInvocationServiceBinding(
                invocationServiceOwners.createOrdinaryServiceBinding(
                    contextParams.entry.generation,
                    `${runtimeSeed.contribution.qualifiedId}:binding`,
                    [],
                    runtimeSeed.contribution.qualifiedId,
                ),
            );
            const services = invocationServiceOwners.createServices(runtimeSeed, serviceBinding);
            return Object.freeze({
                context: Object.freeze({
                    plugin: runtimeSeed.plugin,
                    contribution: runtimeSeed.contribution,
                    surface: runtimeSeed.surface,
                    ...(runtimeSeed.session ? { session: runtimeSeed.session } : {}),
                    signal: runtimeSeed.signal,
                    services,
                    ui: createPluginInvocationPresentation({
                        currentSession: runtimeSeed.session ? runtimeSeed.currentSession ?? null : null,
                        signal: runtimeSeed.signal,
                        isGenerationCurrent: runtimeSeed.isGenerationCurrent,
                        ...(presentationOwner ? { presentationOwner } : {}),
                    }),
                }),
                lifetime,
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }
    const mcpDiscoveryAttachments = new Map<string, Readonly<{
        endpoints: NonNullable<PluginMcpDiscoveryResult['endpoints']>;
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
        discoverySources: authoritativeContributes.mcpDiscoverySources ?? Object.freeze([]),
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
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.listTools(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async callTool(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.callTool(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async listResources(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.listResources(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async listResourceTemplates(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.listResourceTemplates(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async readResource(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.readResource(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async subscribeResource(request, listener, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.subscribeResource(request, listener, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async listPrompts(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.listPrompts(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
                async getPrompt(request, callerSeed, options) {
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return await runtime.getPrompt(request, context, options);
                    } finally {
                        lifetime.complete();
                    }
                },
            });
        },
        readDiscoverySource(ref) {
            const entry = [...activatedRegistry.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === ref.pluginId
                && candidate.generation === String(activatedRegistry.generation)
                && candidate.registration.family === 'mcp.discoverySources'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'mcp.discoverySources') return null;
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
                    const { context, lifetime } = createMcpTargetContext({
                        ref, family: 'mcp.discoverySources', entry, pluginVersion, callerSeed,
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
                    try {
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
                                endpoints: projectPluginMcpDiscoveredEndpoints(result.endpoints),
                                warnings: projectPluginMcpDiscoveryWarnings(result.warnings),
                            }),
                        );
                        return Object.freeze({
                            items: Object.freeze([...(result.items ?? [])]),
                            ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
                        });
                    } finally {
                        lifetime.complete();
                    }
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
    const currentGlobalRequestInterceptorRegistry = Object.freeze({
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
    });
    const stableHttpHost = createStablePluginHttpHost({
        adapter: createGlobalFetchRuntime(),
        redactInterceptorText({ seed, value }) {
            return invocationServiceOwners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, value);
        },
        recordDisclosureMismatch({ seed, mismatch }) {
            invocationServiceOwners.recordHostDiagnostic(seed, {
                code: 'plugin_host_access_disclosure_mismatch',
                severity: 'warning',
                message: 'Network operation is outside the plugin manifest disclosure',
                details: mismatch,
            });
        },
        credentialBindingHost: createVoiceAccountPluginHttpCredentialBindingHost({
            voiceProviders: authoritativeContributes.voiceProviders ?? Object.freeze([]),
            // App-client requests are account-scoped and must not inherit a
            // daemon machine's credential override.
            credentialResolver: createVoiceCredentialResolver({ machineId: null }),
            recordResponseDiagnostic(seed, diagnostic) {
                invocationServiceOwners.recordHostDiagnostic(seed, {
                    code: 'plugin_voice_account_operation_response_rejected',
                    severity: 'warning',
                    message: 'Voice account operation response rejected',
                    details: diagnostic,
                });
            },
        }),
        interceptorRegistry: currentGlobalRequestInterceptorRegistry,
        revalidateFinalPolicy: async (effect) => await revalidateStableHttpFinalPolicy(effect),
    });
    const managedDependencySourceModel = createV2ManagedDependencySourceModel({
        platform: resolveManagedDependencyHostPlatform(),
        architecture: process.arch,
        contributions: authoritativeContributes.managedDependencies ?? Object.freeze([]),
    });
    const managedDependencies = createStablePluginManagedDependenciesHost({
        // V2 request semantics remain source-model owned. Complete managed
        // PyPI sources also project through the same installables descriptor
        // owner used by capability/UI installation.
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(
            authoritativeContributes.managedDependencies ?? Object.freeze([]),
        ),
        sourceModel: managedDependencySourceModel,
        immutableGenerationIdsByPluginId:
            committedImmutableGenerationIdsByPluginId,
        readLiveRunnerRetention:
            readExactLiveRunnerManagedDependencyRetention,
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
    const resolveDeclaredSystemTool = async (request: Readonly<{
        toolId: string;
        executableNames: readonly string[];
    }>) => {
        const resolved = await systemToolContext.resolveSystemTool({
            toolId: request.toolId,
            lookupNames: request.executableNames,
            reason: 'Execute a plugin-declared system tool',
        });
        if (!resolved.ok) {
            throw new PluginError({
                code: 'plugin_system_tool_unavailable',
                message: 'System tool is unavailable',
            });
        }
        return Object.freeze({
            toolId: request.toolId,
            command: resolved.command,
            args: resolved.args,
            env: Object.freeze({ PATH: '' }),
        });
    };
    const executableResolver = createStableManagedExecutableResolver({
        systemTools: authoritativeContributes.systemTools ?? Object.freeze([]),
        managedDependencies,
        resolveSystemTool: resolveDeclaredSystemTool,
        async resolvePackagedRuntimeBinary(ref) {
            const command = await resolveManagedProviderRuntimeExecutable(ref);
            if (!command) {
                throw new PluginError({
                    code: 'plugin_packaged_runtime_binary_unavailable',
                    message: 'Packaged managed Provider runtime binary is unavailable',
                });
            }
            return Object.freeze({ command });
        },
    });
    const daemonManagedServiceProcessSupervisorHost = createManagedServiceProcessSupervisorHost({
        custodyOwner: 'daemon',
    });
    const daemonManagedServicesOwner = createManagedServicesOwner({
        processSupervisorHost: daemonManagedServiceProcessSupervisorHost,
        dependencies: (scope) => managedDependencies.bind(scope.pluginId),
        resolveDeclaredSecret: createDeclaredManagedServiceSecretResolver(),
        registerRawForRedaction(scope, value) {
            const correlationId = scope.operationId?.trim();
            if (!correlationId) {
                throw new PluginError({
                    code: 'plugin_managed_service_unavailable',
                    message: 'Managed-service redaction scope is unavailable',
                });
            }
            invocationServiceOwners.registerRawForRedaction({
                plugin: Object.freeze({ id: scope.pluginId }),
                generation: scope.generation,
                correlationId,
            }, value);
        },
        resolveScope(seed, context) {
            const managedProvider = context?.managedProvider;
            const retainedManagedProviderScope = Boolean(
                managedProvider
                && seed.contributionQualifiedId
                    === `${seed.pluginId}/providers/${managedProvider.providerLocalId}`
                && managedProvider.isCurrent() === true
                && seed.isGenerationCurrent(),
            );
            if (
                seed.pluginId.trim().length === 0
                || !seed.contributionQualifiedId.startsWith(
                    `${seed.pluginId}/`,
                )
                || (
                    !retainedManagedProviderScope
                    && (
                        seed.generation
                            !== String(activatedRegistry.generation)
                        || !isPluginConsumerCurrent(seed.pluginId)
                        || !seed.isGenerationCurrent()
                    )
                )
            ) return null;
            return Object.freeze({
                ...seed,
                ...(context?.declaredSecretReadPort
                    ? {
                        declaredSecretReadPort:
                            context.declaredSecretReadPort,
                    }
                    : {}),
            });
        },
    });
    declaredMcpTransportConnector = createStableDeclaredMcpTransportConnector({
        resolveExecutable: executableResolver,
    });
    await refreshCurrentGlobalExternalSessionsAuthor();
    let automationEventAdoptedDefinitionOwners: readonly Readonly<{
        caller: PluginMachineMaterializationRefV1;
        transport: AutomationEventSourcesListTransportV1;
        owner: AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1;
    }>[] = Object.freeze([]);
    if (sessionCredentials) {
        const sourceTargets = authoritativeContributes.activationTargets.filter((target) => (
            activatedRegistry.activatedPluginIds.has(target.pluginId)
            && (target.manifest.contributes.events ?? []).some((event) => (
                event.kind === 'event'
                && event.automation?.eligible === true
                && event.automation.source.supportedObservationTransports.some((transport) => (
                    transport === 'checkpointedPull' || transport === 'durablePush'
                ))
            ))
        ));
        const adoptedOwners: Array<Readonly<{
            caller: PluginMachineMaterializationRefV1;
            transport: AutomationEventSourcesListTransportV1;
            owner: AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1;
        }>> = [];
        for (const target of sourceTargets) {
            const caller = resolveCurrentPluginMaterializationRef(target.pluginId);
            if (!caller) continue;
            const lifecycle = resolveRuntimeConsumerLifecycle(target.pluginId);
            const transportKinds = new Set<'checkpointedPull' | 'durablePush'>();
            for (const event of target.manifest.contributes.events ?? []) {
                if (event.kind !== 'event' || event.automation?.eligible !== true) continue;
                for (const supportedTransport of event.automation.source.supportedObservationTransports) {
                    transportKinds.add(supportedTransport);
                }
            }
            for (const transportKind of transportKinds) {
                const transport: AutomationEventSourcesListTransportV1 = transportKind === 'checkpointedPull'
                    ? { kind: 'checkpointedPull' }
                    : { kind: 'durablePush' };
                const owner = createAutomationEventAdoptedDefinitionSetHostV1({
                    credentials: sessionCredentials,
                    caller,
                    transport,
                    generationSignal: lifecycle.retirementSignal,
                    isGenerationCurrent: () => {
                        const current = resolveCurrentPluginMaterializationRef(target.pluginId);
                        return lifecycle.isCurrent()
                            && current !== null
                            && sameMaterialization(current, caller);
                    },
                    revalidateCallerMaterialization: revalidatePluginActionCallerMaterialization,
                });
                // Warm the snapshot here, but never gate registration on it.
                // A transient first catalog read would otherwise drop the one
                // generation-local owner for the whole plugin generation, so
                // every later admission and source list would fail with no
                // recovery short of a restart. The owner hydrates its snapshot
                // through its own single-flight refresh on first use.
                await owner.refresh(lifecycle.retirementSignal);
                adoptedOwners.push(Object.freeze({ caller, transport, owner }));
            }
        }
        automationEventAdoptedDefinitionOwners = Object.freeze(adoptedOwners);
    }
    const resolveAutomationEventAdoptedDefinitionSet = automationEventAdoptedDefinitionOwners.length > 0
        ? (
            caller: PluginMachineMaterializationRefV1,
            transport: AutomationEventSourcesListTransportV1,
        ): AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 | null => {
            const current = resolveCurrentPluginMaterializationRef(caller.pluginId);
            if (current === null || !sameMaterialization(current, caller)) return null;
            const owner = automationEventAdoptedDefinitionOwners.find((candidate) => (
                sameMaterialization(candidate.caller, caller)
                && candidate.transport.kind === transport.kind
            ));
            return owner?.owner ?? null;
        }
        : undefined;
    const resolveAutomationEventHistoryGapSource = resolveAutomationEventAdoptedDefinitionSet
        ? async (request: Readonly<{
            pluginId: string;
            eventLocalIds: readonly string[];
            reset: import('@happier-dev/protocol').PluginEventAutomationHistoryGapResetActionInputV1;
            signal: AbortSignal;
            isCurrent(): boolean;
        }>) => {
            request.signal.throwIfAborted();
            if (!request.isCurrent()) return null;
            const caller = resolveCurrentPluginMaterializationRef(request.pluginId);
            if (!caller) return null;
            const owner = resolveAutomationEventAdoptedDefinitionSet(caller, {
                kind: 'checkpointedPull',
            });
            if (!owner) return null;
            const definition = await owner.readCurrentCheckpointedPullSource({
                reset: request.reset,
                signal: request.signal,
            });
            request.signal.throwIfAborted();
            const currentCaller = resolveCurrentPluginMaterializationRef(request.pluginId);
            if (
                definition === null
                || !request.isCurrent()
                || currentCaller === null
                || !sameMaterialization(caller, currentCaller)
                || definition.eventRef.pluginId !== request.pluginId
                || !request.eventLocalIds.includes(definition.eventRef.localId)
            ) return null;
            return Object.freeze({
                eventLocalId: definition.eventRef.localId,
                sourceConfig: structuredClone(definition.sourceConfig),
            });
        }
        : undefined;
    const invokeContributedAction = (async (request) => {
        const runtimeRegistry = resolvedRuntimeRegistryOwner;
        if (!runtimeRegistry) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_registry_unavailable',
                message: 'Plugin action registry is not yet committed',
                actionHandlerInvocation: 'notStarted' as const,
            });
        }
        const attempt = await executeContributedAction({
            runtimeRegistry,
            actionId: buildQualifiedPluginContributionKey(
                createPluginContributionIdentity({
                    pluginId: request.action.pluginId,
                    localId: request.action.localId,
                }),
            ),
            input: request.input,
            ...(request.captureExecutionOrigin ? { captureExecutionOrigin: true as const } : {}),
            ...(request.expectedExecutionOrigin === undefined
                ? {}
                : { expectedExecutionOrigin: request.expectedExecutionOrigin }),
            ...(request.admittedTargetedOperation === undefined
                ? {}
                : {
                    admittedTargetedOperation: request.admittedTargetedOperation,
                }),
            context: {
                surface: request.surface,
                ...(request.originSurface ? { originSurface: request.originSurface } : {}),
                caller: request.caller,
                ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
                signal: request.signal,
            },
        });
        if (!attempt.matched) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_handler_missing',
                message: 'No declared contributed action matches the exact plugin reference',
                actionHandlerInvocation: 'notStarted' as const,
            });
        }
        if (attempt.result.ok) {
            if (request.captureExecutionOrigin && !attempt.result.executionOrigin) {
                return Object.freeze({
                    status: 'failed' as const,
                    code: 'plugin_action_execution_origin_unavailable',
                    message: 'Current target execution origin is unavailable',
                });
            }
            return Object.freeze({
                status: 'executed' as const,
                value: attempt.result.result,
                ...(request.captureExecutionOrigin
                    ? { executionOrigin: attempt.result.executionOrigin }
                    : {}),
            });
        }
        return Object.freeze({
            status: 'failed' as const,
            code: attempt.result.errorCode,
            message: attempt.result.error,
            ...(attempt.result.retryable === undefined
                ? {}
                : { retryable: attempt.result.retryable }),
            ...(attempt.result.data === undefined
                ? {}
                : { data: attempt.result.data }),
            ...(attempt.result.actionHandlerInvocation === undefined
                ? {}
                : { actionHandlerInvocation: attempt.result.actionHandlerInvocation }),
        });
    }) satisfies InvokeContributedAction;
    const pluginActionExecutor = sessionCredentials
        ? createCliActionExecutorFromCredentials({
            credentials: sessionCredentials,
            readCredentials: readStoredCredentials,
            readRegisteredPromptAssetAdapters: () => promptAssetAdapters,
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerImmutableGeneration,
            invokeContributedAction: createHostContributedActionInvoker({
                invokeContributedAction,
                revalidatePluginActionCallerMaterialization,
                revalidatePluginActionCallerImmutableGeneration,
            }),
            ...(resolveAutomationEventAdoptedDefinitionSet
                ? { resolveAutomationEventAdoptedDefinitionSet }
                : {}),
            ...(params?.runtimeActionExecute
                ? { runtimeActionExecute: params.runtimeActionExecute }
                : {}),
            ...(params?.externalSessionPluginAdmissionOwner
                ? {
                    externalSessionPluginAdmissionOwner:
                        params.externalSessionPluginAdmissionOwner,
                }
                : {}),
            // Read at dispatch, never at construction: this registry's own
            // Composer attachment target is built below, and a plugin
            // `SessionHandle.send` reaches it only while executing an Action.
            resolveComposerAttachmentSendPreparation: () => composerAttachments,
        })
        : null;
    const resolveCurrentComposerExecutionTarget = () => {
        let machineId: string | null | undefined;
        try {
            machineId = params?.resolveCurrentMachineId?.();
        } catch {
            return null;
        }
        const target = SessionExecutionTargetV1Schema.safeParse({
            serverId: configuration.activeServerId,
            machineId,
        });
        return target.success ? Object.freeze(target.data) : null;
    };
    const composerExecutionTarget = resolveCurrentComposerExecutionTarget();
    const composerContent = composerExecutionTarget
        ? createStablePluginComposerContentOwner({
            executionTarget: composerExecutionTarget,
            resolveCurrentExecutionTarget: resolveCurrentComposerExecutionTarget,
            resolveTransferRpcHandler: () => (
                params?.resolveComposerMediaStageTransferRpcHandler?.() ?? null
            ),
        })
        : null;
    const resolveDaemonPluginFileSystemRoots = (pluginId: string) => {
        const pluginData = join(pluginStorePaths.storageDir, pluginId, 'fs');
        return Object.freeze({
            pluginData,
            // Daemon contributions have no ambient workspace. Keep the
            // mandatory SDK root map inside the same plugin-owned directory.
            workspace: pluginData,
            projects: new Map<string, string>(),
        });
    };
    invocationServiceOwners = createProductionPluginInvocationServiceOwners({
        ...(params?.stableEventsBroker
            ? { eventsBroker: params.stableEventsBroker }
            : {}),
        ...(pluginActionExecutor ? { actionExecutor: pluginActionExecutor } : {}),
        resolveCurrentPluginMaterializationRef,
        invokeContributedAction,
        ...(params?.targetedContributions
            ? { targetedContributions: params.targetedContributions }
            : {}),
        ...(composerContent ? { composerContent } : {}),
        resolveFilesystemRoots: resolveDaemonPluginFileSystemRoots,
        ...(params?.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
        ...(params?.connectedAccounts ? { connectedAccounts: params.connectedAccounts } : {}),
        ...(params?.providers ? { providers: params.providers } : {}),
        managedServiceCredentialFiles,
        ...(sessionCredentials ? {
            sessions: {
                bind(seed, binding, interactions, filesystemRoots) {
                    const immutableGenerationId = immutableGenerationIdsByPluginId.get(seed.plugin.id);
                    if (!immutableGenerationId) {
                        return createUnavailablePluginServices().sessions;
                    }
                    return createPluginSessionsInventory({
                        executeMessageAction: async ({ sessionId, request, signal }) => (
                            await executePluginSessionMessageAction({
                                execute: async (actionId, input, context) => (
                                    await pluginActionExecutor!.execute(actionId, input, context)
                                ),
                                pluginId: seed.plugin.id,
                                contributionLocalId: seed.contribution.id,
                                ...(seed.resolveCurrentPluginMaterializationRef
                                    ? {
                                        resolveCallerMaterialization:
                                            seed.resolveCurrentPluginMaterializationRef,
                                    }
                                    : {}),
                                sessionId,
                                request,
                                signal,
                            })
                        ),
                        credentials: sessionCredentials,
                        signal: seed.signal,
                        readCredentials: readStoredCredentials,
                        currentSessionId: seed.session?.id ?? null,
                        sessionScopes: binding.sessionScopes ?? Object.freeze([]),
                        isCurrent: seed.isGenerationCurrent,
                        external: createCurrentGlobalExternalSessionsAuthorBinding({
                            pluginId: seed.plugin.id,
                            signal: seed.signal,
                            isGenerationCurrent:
                                seed.isGenerationCurrent,
                            ...(params?.externalSessionsActiveServerDir
                                ? {
                                    activeServerDir:
                                        params.externalSessionsActiveServerDir,
                                }
                                : {}),
                            ...(params?.externalSessionPluginAdmissionOwner?.takeoverStart
                                ? {
                                    takeoverStart:
                                        params.externalSessionPluginAdmissionOwner.takeoverStart,
                                }
                                : {}),
                            resolveCurrent: () =>
                                publicCurrentGlobalExternalSessions.resolveCurrent(),
                            activateConfiguredSources: async (agentId) =>
                                await publicCurrentGlobalExternalSessions
                                    .activateConfiguredSources(agentId),
                        }),
                        createHandleCapabilities: ({ sessionId, readSummary }) => (
                            createPluginSessionHandleCapabilitiesFactory({
                                credentials: sessionCredentials,
                                readCredentials: readStoredCredentials,
                                caller: {
                                    pluginId: seed.plugin.id,
                                    contributionId: seed.contribution.id,
                                    immutableGenerationId,
                                    runtimeId: seed.contribution.qualifiedId,
                                },
                                signal: seed.signal,
                                isCurrent: seed.isGenerationCurrent,
                                readAgentId: async (_boundSessionId, signal) => (
                                    (await readSummary({ signal })).agentId ?? null
                                ),
                                resolveLiveCapabilities: (boundSessionId) => {
                                    const live = resolveCurrentSessionCapabilityBinding(boundSessionId);
                                    return live
                                        ? projectOrdinaryPluginSessionLiveCapabilities({
                                            live,
                                            interactions,
                                            ...(filesystemRoots ? { filesystemRoots } : {}),
                                            ...(binding.filesystemScopes
                                                ? { filesystemScopes: binding.filesystemScopes }
                                                : {}),
                                        })
                                        : null;
                                },
                            })(sessionId)
                        ),
                    });
                },
            },
        } : {}),
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess ?? Object.freeze([]);
        },
        async isGenerationCurrent(action) {
            return isPluginConsumerCurrent(action.pluginId)
                && action.generation === String(activatedRegistry.generation)
                && activatedRegistry.activatedPluginIds.has(action.pluginId)
                && (!committed || await committed.isCurrent());
        },
        storagePaths: pluginStorePaths,
        daemonDatabase: daemonDatabaseHost,
        accountStorage: accountStorageHost,
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
        onPluginSettingsUnavailable({ pluginId, error }) {
            logger.warn('[PLUGIN RUNTIME] Settings are unavailable: the declared settings could not be modelled', {
                pluginId,
                reason: projectPluginFailureText(
                    error instanceof Error ? error : new Error(String(error)),
                ),
            });
        },
        secretDeclarations: collectDeclaredPluginSecrets(
            authoritativeContributes.activationTargets,
            {
                onSecretDeclarationRefused({ pluginId, secretId }) {
                    logger.warn('[PLUGIN RUNTIME] Declared secret is unavailable: contradictory custody declarations', {
                        pluginId,
                        secretId,
                    });
                },
            },
        ),
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
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
                const isChannelLocallyCurrent = (): boolean => (
                    isPluginConsumerCurrent(ref.pluginId)
                    && callerSeed.isGenerationCurrent()
                    && activatedRegistry.targetRegistrations.includes(entry)
                );
                const isChannelCurrent = async (): Promise<boolean> => {
                    if (!isChannelLocallyCurrent()) return false;
                    if (!committed || !await committed.isCurrent()) return false;
                    return isChannelLocallyCurrent();
                };
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
                    isCurrent: isChannelCurrent,
                    async send(request, signal) {
                        const lifetime = createPluginInvocationLifetime(
                            composePluginConsumerSignal(ref.pluginId, signal),
                        );
                        const immutableGenerationId = immutableGenerationIdsByPluginId.get(ref.pluginId);
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
                            signal: lifetime.signal,
                            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                            isGenerationCurrent: isChannelLocallyCurrent,
                        });
                        const presentationOwner = channelSeed.session
                            && channelSeed.currentSession
                            && immutableGenerationId
                            ? Object.freeze({
                                pluginId: channelSeed.plugin.id,
                                contributionId: channelSeed.contribution.id,
                                generationId: immutableGenerationId,
                                invocationId: channelSeed.correlationId,
                            })
                            : undefined;
                        try {
                            const hostPolicy = invocationServiceOwners.resolveInvocationHostPolicy({
                                pluginId: ref.pluginId,
                                generation: entry.generation,
                                qualifiedId: channelSeed.contribution.qualifiedId,
                            }, {
                                hostAccessRequests: channelHostAccessRequests,
                                surface: channelSeed.surface,
                                signal: channelSeed.signal,
                            });
                            const services = invocationServiceOwners.createServices(
                                channelSeed,
                                Object.freeze({
                                    ...hostPolicy.serviceBinding,
                                    accountStorageCurrentness: isChannelCurrent,
                                }),
                            );
                            const context: PluginInvocationContext = Object.freeze({
                                plugin: channelSeed.plugin,
                                contribution: channelSeed.contribution,
                                surface: channelSeed.surface,
                                ...(channelSeed.session ? { session: channelSeed.session } : {}),
                                signal: channelSeed.signal,
                                services,
                                ui: createPluginInvocationPresentation({
                                    currentSession: callerSeed.session
                                        ? callerSeed.currentSession ?? null
                                        : null,
                                    signal: channelSeed.signal,
                                    isGenerationCurrent: channelSeed.isGenerationCurrent,
                                    ...(presentationOwner ? { presentationOwner } : {}),
                                }),
                            });
                            return await Reflect.apply(sender, undefined, [request, context]);
                        } finally {
                            lifetime.complete();
                        }
                    },
                });
            },
        },
        mcp: mcpHost,
        http: stableHttpHost,
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
        managedServices: daemonManagedServicesOwner,
    });
    disposeInvocationServiceOwners = async () => {
        currentGlobalExternalSessions?.dispose();
        currentGlobalExternalSessions = null;
        currentGlobalExternalSessionsPublicationBasis = null;
        const results = await Promise.allSettled([
            invocationServiceOwners.dispose(),
            daemonManagedServicesOwner.dispose(),
            daemonDatabaseHost.close(),
        ]);
        const failures = results.flatMap((result) => (
            result.status === 'rejected' ? [result.reason] : []
        ));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                'Failed to dispose executable plugin invocation-service owners',
            );
        }
    };
    const declaredEventSubscriptionBindings = new Map<string, Awaited<ReturnType<
        typeof invocationServiceOwners.bindDeclaredEventSubscriptions
    >>>();
    let declaredEventSubscriptionsPublished = false;
    const publishDeclaredEventSubscriptions = (): void => {
        if (allRuntimeConsumersRetired) return;
        declaredEventSubscriptionsPublished = true;
    };
    /**
     * Fence every live push subscription this generation owns, synchronously,
     * at the moment it stops being the current authority.
     *
     * Declared event handlers and mounted UI resource watches are the same
     * category of consumer: neither is in-flight leased work, and both must
     * stop the instant a successor is adopted. A parked `watch.next` poll is
     * also what makes this urgent rather than cosmetic — its RPC handler holds a
     * runtime-registry lease for the whole poll, so a superseded generation that
     * did not fence it here could not be disposed until the poll's own budget
     * expired, and the observer would sit on a stale view for that whole time
     * instead of resynchronizing against the successor.
     */
    const retireLiveSubscriptionConsumers = (): void => {
        declaredEventSubscriptionsPublished = false;
        uiResourceWatches?.retire();
    };
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
                isEffectCapable: () =>
                    declaredEventSubscriptionsPublished,
                createContext(contextInput) {
                    const lifetime = createPluginInvocationLifetime(
                        composePluginConsumerSignal(entry.pluginId, contextInput.signal),
                    );
                    const seed = Object.freeze({
                        plugin: Object.freeze({ id: contextInput.pluginId, version: contextInput.pluginVersion }),
                        contribution: Object.freeze({
                            id: contextInput.localId,
                            qualifiedId: `${contextInput.pluginId}/events/${contextInput.localId}`,
                        }),
                        generation: contextInput.generation,
                        correlationId: randomUUID(),
                        surface: 'cli' as const,
                        ...(contextInput.sessionId
                            ? {
                                session: Object.freeze({
                                    id: contextInput.sessionId,
                                }),
                            }
                            : {}),
                        signal: lifetime.signal,
                        redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                        isGenerationCurrent: () => (
                            !contextInput.signal.aborted
                            && declaredEventSubscriptionsPublished
                            && isPluginConsumerCurrent(entry.pluginId)
                            && activatedRegistry.targetRegistrations.includes(entry)
                            && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                        ),
                    });
                    try {
                        const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                            seed.generation,
                            `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                            [],
                            seed.contribution.qualifiedId,
                        );
                        const services = invocationServiceOwners.createServices(seed, serviceBinding);
                        return Object.freeze({
                            context: Object.freeze({
                                plugin: seed.plugin,
                                contribution: seed.contribution,
                                surface: seed.surface,
                                ...(seed.session
                                    ? { session: seed.session }
                                    : {}),
                                signal: seed.signal,
                                services,
                                ui: createPluginInvocationPresentation({
                                    currentSession: null,
                                    signal: seed.signal,
                                    isGenerationCurrent: seed.isGenerationCurrent,
                                }),
                            }),
                            complete: () => lifetime.complete(),
                        });
                    } catch (error) {
                        lifetime.complete();
                        throw error;
                    }
                },
            });
            declaredEventSubscriptionBindings.set(key, binding);
        }
    }
    refreshDeclaredEventSubscriptionBindings();
    const resolveCurrentFinalPolicyGeneration = (
        pluginId: string,
        authority: PluginRuntimeGenerationAuthority | null = committed,
    ): PluginFinalPolicyCurrentGeneration | null => {
        const activationTarget = resolveExactActivationTarget(pluginId);
        const target = committed?.generations.get(pluginId);
        const desired = authority?.generations.get(pluginId);
        const registryImmutableGenerationId = immutableGenerationIdsByPluginId.get(pluginId);
        if (
            !activationTarget
            || !target
            || target.record.pluginId !== pluginId
            || target.immutableGenerationId !== registryImmutableGenerationId
        ) return null;
        const activationApplied = Boolean(
            activatedRegistry.activatedPluginIds.has(pluginId)
            && activatedRegistry.targetActivationFacts.some((fact) => (
                fact.pluginId === pluginId
                && fact.generation === String(activatedRegistry.generation)
                && fact.status === 'active'
            )),
        );
        const desiredGeneration = desired?.installation?.enabled === false
            ? null
            : desired?.immutableGenerationId ?? null;
        const appliedGeneration = activationApplied && desiredGeneration !== null
            ? target.immutableGenerationId
            : null;
        const distribution = target.installation?.source.distribution
            ?? (activationTarget.sourceSpec.kind === 'bundled' ? 'bundled' : null);
        if (!distribution) return null;
        return Object.freeze({
            immutableGenerationId: target.immutableGenerationId,
            desiredImmutableGenerationId: desiredGeneration,
            appliedImmutableGenerationId: appliedGeneration,
            distribution,
            applied: appliedGeneration === target.immutableGenerationId,
            selectedAccess: Object.freeze([...(desired?.installation?.optionalAccess ?? [])]),
        });
    };
    const resolveVoiceProviderRuntimeLifecycle = (
        identity: PluginContributionIdentityV1,
    ): PluginContributionRuntimeLifecycle | null => {
        const providers = (authoritativeContributes.voiceProviders ?? []).filter((provider) => (
            provider.identity.pluginId === identity.pluginId
            && provider.identity.localId === identity.localId
        ));
        if (providers.length !== 1) return null;
        const current = resolveCurrentFinalPolicyGeneration(identity.pluginId);
        if (
            !current
        ) {
            return null;
        }
        const lifecycle = resolveRuntimeConsumerLifecycle(identity.pluginId);
        return Object.freeze({
            generation: current.immutableGenerationId,
            isCurrent: () => {
                const refreshed = resolveCurrentFinalPolicyGeneration(identity.pluginId);
                return lifecycle.isCurrent()
                    && refreshed?.immutableGenerationId === current.immutableGenerationId;
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
        const target = resolveExactActivationTarget(pluginId);
        if (!target) {
            throw new PluginError({
                code: 'plugin_final_package_untrusted',
                message: 'Plugin package identity is unavailable',
            });
        }
        const currentAuthority = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
            { bundledArtifacts: bundledExecutableImmutableArtifacts },
        );
        if (currentAuthority && !await currentAuthority.isCurrent()) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const current = resolveCurrentFinalPolicyGeneration(
            pluginId,
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
                === `${effect.ref.pluginId}/mcp.discoverySources/${effect.ref.localId}`;
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
                    const references = effect.operation === 'discover'
                        ? request.scope.discoverySourceRefs
                        : request.scope.serverRefs;
                    return references.some((reference) => (
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
            current,
            targetGenerationMode: 'retained',
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
    const revalidateStableHttpFinalPolicy = async (
        effect: StablePluginHttpFinalPolicyEffect,
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
        const target = resolveExactActivationTarget(pluginId);
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
            { bundledArtifacts: bundledExecutableImmutableArtifacts },
        );
        if (currentAuthority && !await currentAuthority.isCurrent()) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const current = resolveCurrentFinalPolicyGeneration(
            pluginId,
            currentAuthority,
        );
        if (!current) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin generation authority is unavailable',
            });
        }
        const authorizationFacts = resolvePluginFinalPolicyAuthorizationFacts({
            pluginId,
            current,
            targetGenerationMode: 'retained',
            // Network declarations are cooperative disclosure. Exact selected
            // Connected Account origins/currentness are rechecked by the
            // stable HTTP owner before this trust/generation decision.
            resourceSelections: Object.freeze([]),
        });
        const decision = evaluatePluginFinalPolicy({
            ...authorizationFacts,
            serviceAvailability: [Object.freeze({
                id: 'http',
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
        const activationTarget = resolveExactActivationTarget(action.pluginId);
        const current = activationTarget?.manifest.contributes.actions.some(
            (candidate) => candidate.id === action.localId,
        )
            ? resolveCurrentFinalPolicyGeneration(action.pluginId)
            : null;
        return resolvePluginFinalPolicyAuthorizationFacts({
            pluginId: action.pluginId,
            current,
            resourceSelections: resolveTargetActionResourceSelectionFacts(action),
        });
    };
    const resolveActionPresentUserGatePolicy = (
        pluginId: string,
        localId: string,
    ): PluginActionPresentUserGatePolicy | null => {
        try {
            const activationTarget = resolveExactActivationTarget(pluginId);
            const definition = activationTarget?.manifest.contributes.actions.find(
                (candidate) => candidate.id === localId,
            );
            const current = definition
                ? resolveCurrentFinalPolicyGeneration(pluginId)
                : null;
            if (!activationTarget || !definition || !current) return null;
            const availability = resolveTargetActionAvailability({
                availability: definition.availability,
                facts: resolveInvocationContributionPolicyFacts(),
            });
            const action = resolveCatalogTargetActionPolicy({
                pluginId,
                localId,
                generation: current.immutableGenerationId,
                dangerLevel: definition.dangerLevel,
                scopes: definition.scopes,
                surfaces: definition.surfaces,
                hostAccessRequests: resolveManifestHostAccessRequests({
                    manifest: activationTarget.manifest,
                    pluginId,
                    contribution: { family: 'actions', localId },
                    requestIds: definition.hostAccess ?? [],
                }),
                ...(availability === undefined ? {} : { availability }),
                ...(definition.confirmation === undefined
                    ? {}
                    : { confirmation: definition.confirmation }),
                resolveHostPolicy: invocationServiceOwners.resolveHostPolicy,
            });
            return resolvePresentUserGatePolicy(
                action,
                resolveTargetActionAuthorizationFacts(action),
            );
        } catch {
            return null;
        }
    };
    targetActionInvocations = buildTargetActionInvocationRegistry({
        contributes: authoritativeContributes,
        immutableGenerationIdsByPluginId,
        resolveCurrentPluginMaterializationRef,
        resolveCurrentPluginImmutableGenerationId,
        targetRegistrations: activatedRegistry.targetRegistrations,
        targetActivationFacts: activatedRegistry.targetActivationFacts,
        resolveAuthorizationFacts: resolveTargetActionAuthorizationFacts,
        resolvePresentUserGatePolicy: resolveActionPresentUserGatePolicy,
        resolveHostBinding: invocationServiceOwners.resolveHostBinding,
        resolveHostPolicy: invocationServiceOwners.resolveHostPolicy,
        createServices: invocationServiceOwners.createServices,
        redactDiagnosticText: invocationServiceOwners.redactDiagnosticText,
        completeDiagnosticScope: invocationServiceOwners.completeDiagnosticScope,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
        resolveCurrentSessionUi: resolveCurrentSessionUiBinding,
        ...(params?.actionFormConnectedAccounts
            ? { actionFormConnectedAccounts: params.actionFormConnectedAccounts }
            : {}),
        ...(resolveAutomationEventHistoryGapSource
            ? { resolveAutomationEventHistoryGapSource }
            : {}),
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess
                ?? Object.freeze([]);
        },
    });
    const committedTargetActionInvocations = targetActionInvocations;
    const voiceSpeechProviders = createTargetVoiceSpeechRegistry({
        generation: activatedRegistry.generation,
        voiceProviders: authoritativeContributes.voiceProviders ?? Object.freeze([]),
        targetRegistrations: activatedRegistry.targetRegistrations,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
        createHttp(input) {
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === input.pluginId
                && fact.generation === input.generation
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) {
                throw new Error(`Voice speech contribution '${input.pluginId}/${input.localId}' has no active plugin identity`);
            }
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.localId,
                    qualifiedId: `${input.pluginId}/voiceProviders/${input.localId}`,
                }),
                generation: input.generation,
                correlationId: randomUUID(),
                surface: 'cli' as const,
                signal: input.signal,
                isGenerationCurrent: () => (
                    !input.signal.aborted
                    && input.isCurrent()
                    && activatedRegistry.activatedPluginIds.has(input.pluginId)
                ),
            });
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                seed.generation,
                `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                [],
                seed.contribution.qualifiedId,
            );
            return stableHttpHost.bind(seed, binding, {
                revalidateFinalPolicy: async (effect) => {
                    await revalidateStableHttpFinalPolicy(effect);
                    if (input.endpointPolicy) {
                        await revalidateVoiceSpeechHttpEndpoint({
                            policy: input.endpointPolicy,
                            requestUrl: effect.request.url,
                        });
                    }
                },
            });
        },
    });
    const composerReferences = createTargetComposerReferenceRegistry({
        composerReferences: authoritativeContributes.composerReferences ?? Object.freeze([]),
        targetRegistrations: activatedRegistry.targetRegistrations,
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
    });
    const composerAttachments = createTargetComposerAttachmentRegistry({
        targetRegistrations: activatedRegistry.targetRegistrations,
        declaredAttachments: (authoritativeContributes.composerAttachments ?? Object.freeze([])).map((entry) => Object.freeze({
            attachment: entry.identity,
            title: entry.definition.title,
            cardinality: entry.definition.cardinality,
            valueSchema: entry.definition.valueSchema,
            ...(entry.definition.preparedValueSchema === undefined
                ? {}
                : { preparedValueSchema: entry.definition.preparedValueSchema }),
            ...(entry.definition.runtime === undefined
                ? {}
                : { runtime: entry.definition.runtime }),
        })),
        resolveGenerationLifecycle: resolveRuntimeConsumerLifecycle,
        async activateAttachmentOnDemand(attachment) {
            await activateContributionsOnDemand([{
                pluginId: attachment.pluginId,
                family: 'composerAttachments',
                localId: attachment.localId,
            }]);
        },
        createInvocationContext(input) {
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === input.attachment.pluginId
                && fact.generation === input.generation
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) {
                throw new Error(`Active Composer attachment '${input.attachment.pluginId}/${input.attachment.localId}' has no activation identity`);
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(input.attachment.pluginId);
            const currentSession = resolveCurrentSessionUiBinding(input.sessionId);
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.attachment.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.attachment.localId,
                    qualifiedId: `${input.attachment.pluginId}/composerAttachments/${input.attachment.localId}`,
                }),
                generation: input.generation,
                correlationId: randomUUID(),
                surface: 'cli' as const,
                session: Object.freeze({ id: input.sessionId }),
                signal: lifetime.signal,
                redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                isGenerationCurrent: () => (
                    !input.signal.aborted
                    && input.isCurrent()
                    && activatedRegistry.activatedPluginIds.has(input.attachment.pluginId)
                ),
            });
            const presentationOwner = currentSession && immutableGenerationId
                ? Object.freeze({
                    pluginId: seed.plugin.id,
                    contributionId: seed.contribution.id,
                    generationId: immutableGenerationId,
                    invocationId: seed.correlationId,
                })
                : undefined;
            try {
                const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                    seed.generation,
                    `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                    [],
                    seed.contribution.qualifiedId,
                );
                const services = invocationServiceOwners.createServices(seed, serviceBinding);
                return Object.freeze({
                    context: Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        session: seed.session,
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: currentSession ?? null,
                            signal: seed.signal,
                            isGenerationCurrent: seed.isGenerationCurrent,
                            ...(presentationOwner ? { presentationOwner } : {}),
                        }),
                    }),
                    complete: () => lifetime.complete(),
                });
            } catch (error) {
                lifetime.complete();
                throw error;
            }
        },
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

    // Provider contributions activate on demand, so a mis-authored Provider
    // registration is refused after the authoritative merge already ran. Keep
    // that plugin's own author-actionable refusal here so it survives every
    // later diagnostic refresh instead of being silently dropped.
    const providerProjectionDiagnosticsByPluginId:
        Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

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
            ...(providerProjectionDiagnosticsByPluginId[pluginId] ?? []),
            ...(promptAssetProjectionDiagnosticsByPluginId[pluginId] ?? []),
            ...(externalSessionProjectionDiagnosticsByPluginId[pluginId] ?? []),
        ]);
    }

    function recordProviderProjectionRefusals(
        pluginId: string,
        refusalsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    ): void {
        const refusals = refusalsByPluginId[pluginId] ?? [];
        const existing = providerProjectionDiagnosticsByPluginId[pluginId] ?? [];
        const added = refusals.filter((diagnostic) => !existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        )));
        if (added.length === 0) return;
        providerProjectionDiagnosticsByPluginId[pluginId] = Object.freeze([...existing, ...added]);
        refreshPluginDiagnostics(pluginId, readCurrentScmBackendDiagnostics());
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
        const current = resolveCurrentFinalPolicyGeneration(pluginId);
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
        const lifetime = createPluginInvocationLifetime(
            composePluginConsumerSignal(binding.pluginId, signal),
        );
        const seed = Object.freeze({
            plugin: Object.freeze({ id: binding.pluginId, version: binding.pluginVersion }),
            contribution: Object.freeze({
                id: binding.contribution.id,
                qualifiedId: `${binding.pluginId}/requestInterceptors/${binding.contribution.id}`,
            }),
            generation: binding.generation,
            correlationId: randomUUID(),
            surface: 'agent' as const,
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isGenerationCurrent: () => (
                isPluginConsumerCurrent(binding.pluginId)
                && activatedRegistry.activatedPluginIds.has(binding.pluginId)
            ),
        });
        try {
            const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                binding.generation,
                `${seed.contribution.qualifiedId}:binding`,
                [],
                seed.contribution.qualifiedId,
            );
            const services = invocationServiceOwners.createServices(seed, serviceBinding);
            const context: PluginInvocationContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                signal: seed.signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal: seed.signal,
                    isGenerationCurrent: seed.isGenerationCurrent,
                }),
            });
            return await Reflect.apply(binding.handler, undefined, [request, context]);
        } finally {
            lifetime.complete();
        }
    }

    async function activateContributionsOnDemand(
        demands: Parameters<typeof activatedRegistry.activateContributionsOnDemand>[0],
    ): Promise<Awaited<ReturnType<typeof activatedRegistry.activateContributionsOnDemand>>> {
        const results = await activatedRegistry.activateContributionsOnDemand(demands);
        // Lazy activation publishes into the generation-owned registration/fact
        // arrays. Rebuild the complete immutable action index before exposing
        // the activation result so dispatch can never observe a half-published
        // target generation or fall through to the retired legacy path.
        committedTargetActionInvocations.refresh();
        refreshDeclaredEventSubscriptionBindings();
        mergeActivatedHookHandlers();
        refreshAgentRuntimeRegistry();
        refreshSystemToolRegistries();
        refreshPromptAssetAdapterRegistry();
        // The External Sessions author service invokes each configured Agent's
        // `resolveSource` leaf while it is built, and that leaf needs this
        // generation's Agent CLI system-tool services. Publish the synchronous
        // registries first so a lazily activated Agent is not rejected with
        // `plugin_agent_cli_system_tool_unavailable`, which would fail the whole
        // current-global service closed for every caller.
        await refreshCurrentGlobalExternalSessionsAuthor();
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
        committedTargetActionInvocations.refresh();
        refreshDeclaredEventSubscriptionBindings();
        mergeActivatedHookHandlers();
        refreshAgentRuntimeRegistry();
        refreshSystemToolRegistries();
        refreshPromptAssetAdapterRegistry();
        // The External Sessions author service invokes each configured Agent's
        // `resolveSource` leaf while it is built, and that leaf needs this
        // generation's Agent CLI system-tool services. Publish the synchronous
        // registries first so a lazily activated Agent is not rejected with
        // `plugin_agent_cli_system_tool_unavailable`, which would fail the whole
        // current-global service closed for every caller.
        await refreshCurrentGlobalExternalSessionsAuthor();
        const scmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
        for (const result of results) {
            refreshPluginFinalPolicyCurrentGeneration(result.pluginId);
            refreshPluginDiagnostics(result.pluginId, scmDiagnosticsByPluginId);
        }
        return results;
    }

    async function acquireManagedProviderRuntime(
        ref: PluginContributionRef,
    ): Promise<ResolvedManagedProviderRuntime | null> {
        const provider = (authoritativeContributes.providers ?? []).find((candidate) => (
            candidate.identity.pluginId === ref.pluginId
            && candidate.identity.localId === ref.localId
        ));
        const target = resolveExactActivationTarget(ref.pluginId);
        if (
            !target
            || provider?.definition.managedRuntime?.kind !== 'managed'
        ) return null;

        await activateContributionsOnDemand([{
            pluginId: ref.pluginId,
            family: 'providers',
            localId: ref.localId,
        }]);
        const projected = projectTargetProviderRuntimes({
            providers: Object.freeze([provider]),
            activationTargets: Object.freeze([target]),
            targetRegistrations: activatedRegistry.targetRegistrations.filter((entry) => (
                entry.pluginId === ref.pluginId
                && entry.registration.family === 'providers'
                && entry.registration.localId === ref.localId
            )),
            activationGeneration: String(activatedRegistry.generation),
            immutableGenerationIdsByPluginId,
            isRegistrationCurrent: (entry) => (
                isPluginConsumerCurrent(entry.pluginId)
                && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                && activatedRegistry.targetRegistrations.includes(entry)
            ),
        });
        recordProviderProjectionRefusals(ref.pluginId, projected.diagnosticsByPluginId);
        const managedRuntime = projected.providers[0]?.managedRuntime ?? null;
        return managedRuntime?.isCurrent() === true ? managedRuntime : null;
    }

    /**
     * Acquires the exact activation-owned catalog wire formats a Provider
     * contributes. Provider contributions activate on demand, so the catalog
     * probe reaches the plugin through the same demand path the managed runtime
     * uses rather than a second registry.
     */
    async function acquireProviderCatalogParsers(
        ref: PluginContributionRef,
    ): Promise<ResolvedProviderCatalogParsers | null> {
        const provider = (authoritativeContributes.providers ?? []).find((candidate) => (
            candidate.identity.pluginId === ref.pluginId
            && candidate.identity.localId === ref.localId
        ));
        const target = resolveExactActivationTarget(ref.pluginId);
        if (
            !target
            || !provider
            || readContributedProviderCatalogParserIds(
                provider.definition as unknown as Readonly<Record<string, unknown>>,
            ).length === 0
        ) return null;

        await activateContributionsOnDemand([{
            pluginId: ref.pluginId,
            family: 'providers',
            localId: ref.localId,
        }]);
        const projected = projectTargetProviderRuntimes({
            providers: Object.freeze([provider]),
            activationTargets: Object.freeze([target]),
            targetRegistrations: activatedRegistry.targetRegistrations.filter((entry) => (
                entry.pluginId === ref.pluginId
                && entry.registration.family === 'providers'
                && entry.registration.localId === ref.localId
            )),
            activationGeneration: String(activatedRegistry.generation),
            immutableGenerationIdsByPluginId,
            isRegistrationCurrent: (entry) => (
                isPluginConsumerCurrent(entry.pluginId)
                && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                && activatedRegistry.targetRegistrations.includes(entry)
            ),
        });
        recordProviderProjectionRefusals(ref.pluginId, projected.diagnosticsByPluginId);
        const catalogParsers = projected.providers[0]?.catalogParsers ?? null;
        return catalogParsers?.isCurrent() === true ? catalogParsers : null;
    }

    function createExplicitManagedProviderOperationClaimId(
        identity: PluginContributionRef,
        machineId: string,
    ): string | null {
        const normalizedMachineId = machineId.trim();
        return normalizedMachineId
            ? JSON.stringify([
                'managed-provider-explicit-start',
                normalizedMachineId,
                identity.pluginId,
                identity.localId,
            ])
            : null;
    }

    async function runManagedProviderExplicitStart(
        input: ManagedProviderExplicitStartJoinInput,
    ): Promise<ManagedProviderExplicitStartJoinResult> {
        const identity = input.identity;
        const provider = (authoritativeContributes.providers ?? []).find(
            (candidate) => (
                candidate.identity.pluginId === identity.pluginId
                && candidate.identity.localId === identity.localId
            ),
        );
        if (
            !provider
            || provider.definition.managedRuntime?.kind !== 'managed'
            || !resolveExactActivationTarget(identity.pluginId)
        ) {
            return Object.freeze({ status: 'unavailable' as const });
        }
        let operationId: string | null;
        let purposeBindingsEqualityKey: string;
        try {
            operationId = createExplicitManagedProviderOperationClaimId(
                identity,
                input.machineId,
            );
            purposeBindingsEqualityKey =
                createProviderManagedPurposeBindingsEqualityKeyV1(
                    input.purposeBindings,
                );
        } catch {
            return Object.freeze({ status: 'unavailable' as const });
        }
        if (!operationId) {
            return Object.freeze({ status: 'unavailable' as const });
        }
        let inputCurrent: boolean;
        try {
            inputCurrent = input.isCurrent() === true;
        } catch {
            inputCurrent = false;
        }
        if (!inputCurrent) {
            return Object.freeze({ status: 'not_current' as const });
        }
        const runtime = await acquireManagedProviderRuntime(identity);
        if (!runtime) {
            return Object.freeze({ status: 'unavailable' as const });
        }
        const readsOperationCurrent = (): boolean => {
            try {
                return input.isCurrent() === true
                    && runtime.isCurrent() === true
                    && isPluginConsumerCurrent(identity.pluginId)
                    && activatedRegistry.activatedPluginIds.has(
                        identity.pluginId,
                    );
            } catch {
                return false;
            }
        };
        if (!readsOperationCurrent()) {
            return Object.freeze({ status: 'not_current' as const });
        }
        return await daemonManagedServicesOwner.runManagedProviderExplicitStart({
            operationId,
            pluginId: identity.pluginId,
            contributionQualifiedId:
                `${identity.pluginId}/providers/${identity.localId}`,
            generation: runtime.activationGeneration,
            purposeBindingsEqualityKey,
            isCurrent: readsOperationCurrent,
            establish: input.establish,
        });
    }

    async function createManagedProviderRuntimeInvocationServicesInternal(
        input: Readonly<{
            identity: PluginContributionRef;
            purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
            operationClaim?: ManagedProviderRuntimeOperationClaim;
            retained?: Readonly<{
                declaration: ReturnType<
                    typeof resolveProviderManagedRuntimeDeclarationV1
                >;
                pluginVersion: string;
                activationGeneration: string;
                immutableGenerationId: string;
                manifestAuthority:
                    'external' | 'bundled_first_party';
                requiredHostAccess:
                    readonly import('@happier-dev/protocol')
                        .PluginHostAccessRequestV2[];
                operationClaimId: string;
            }>;
            signal: AbortSignal;
            isCurrent(): boolean;
        }>,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | null> {
        const target = input.retained
            ? null
            : resolveExactActivationTarget(input.identity.pluginId);
        const targetProvider = target?.manifest.contributes.providers.find(
            (candidate) => candidate.id === input.identity.localId,
        );
        const rawDeclaration = input.retained?.declaration
            ?? targetProvider?.managedRuntime;
        if (
            rawDeclaration?.kind !== 'managed'
            || (!target && !input.retained)
            || input.signal.aborted
        ) return null;
        const declaration = resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: input.identity,
            managedRuntime: rawDeclaration,
        });
        const purposeBindings =
            QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
                input.purposeBindings,
            );
        const declarationsByPurpose = new Map(
            declaration.connectedAccounts.map((entry) => [
                entry.purpose,
                entry,
            ]),
        );
        const bindingPurposeKeys = new Set<string>();
        for (const binding of purposeBindings.bindings) {
            const entry = declarationsByPurpose.get(binding.purpose.purpose);
            const targetService = binding.target.kind === 'account'
                ? binding.target.account.service
                : binding.target.service;
            const purposeKey = qualifiedPurposeKey(binding.purpose);
            if (
                binding.purpose.consumer.pluginId !== input.identity.pluginId
                || binding.purpose.consumer.localId !== input.identity.localId
                || !entry
                || entry.service.pluginId !== targetService.pluginId
                || entry.service.localId !== targetService.localId
                || bindingPurposeKeys.has(purposeKey)
            ) return null;
            bindingPurposeKeys.add(purposeKey);
        }
        if (declaration.connectedAccounts.some((entry) => (
            entry.required === true
            && !purposeBindings.bindings.some((binding) => (
                binding.purpose.purpose === entry.purpose
            ))
        ))) return null;
        const purposes = Object.freeze(
            declaration.connectedAccounts.map((entry) => Object.freeze({
                consumer: Object.freeze({
                    pluginId: input.identity.pluginId,
                    localId: input.identity.localId,
                }),
                purpose: entry.purpose,
            })),
        );
        const qualifiedRequestAuthUses = Object.freeze(
            declaration.requestAuthUses.map((use) => Object.freeze({
                purpose: Object.freeze({
                    consumer: Object.freeze({
                        pluginId: input.identity.pluginId,
                        localId: input.identity.localId,
                    }),
                    purpose: use.purpose,
                }),
                materialization: Object.freeze({
                    ...use.materialization,
                    headerNames: Object.freeze([
                        ...use.materialization.headerNames,
                    ]),
                }),
            })),
        );
        const runtime = input.retained
            ? Object.freeze({
                activationGeneration:
                    input.retained.activationGeneration,
                immutableGenerationId:
                    input.retained.immutableGenerationId,
                isCurrent: input.isCurrent,
            })
            : await acquireManagedProviderRuntime(input.identity);
        if (!runtime) return null;
        const activeProviderRegistration = input.retained
            ? null
            : activatedRegistry.targetRegistrations.find((entry) => (
                entry.pluginId === input.identity.pluginId
                && entry.generation === runtime.activationGeneration
                && entry.registration.family === 'providers'
                && entry.registration.localId === input.identity.localId
            ));
        if (!input.retained && !activeProviderRegistration) return null;
        const manifestAuthority = input.retained?.manifestAuthority
            ?? activatedManifestAuthorityByPluginId.get(
                input.identity.pluginId,
            );
        if (!manifestAuthority) return null;
        const readsInvocationCurrent = (): boolean => {
            try {
                return !input.signal.aborted
                    && input.isCurrent() === true
                    && runtime.isCurrent() === true
                    && (
                        input.retained !== undefined
                        || isPluginConsumerCurrent(input.identity.pluginId)
                    );
            } catch {
                return false;
            }
        };
        if (!readsInvocationCurrent()) return null;
        const operationClaimId = input.retained?.operationClaimId ?? (() => {
            if (!input.operationClaim) {
                return `managed-provider-bounded:${randomUUID()}`;
            }
            if (input.operationClaim.kind === 'explicitStart') {
                return createExplicitManagedProviderOperationClaimId(
                    input.identity,
                    input.operationClaim.machineId,
                );
            }
            const sessionId = input.operationClaim.sessionId.trim();
            return sessionId
                ? JSON.stringify([
                    'managed-provider-session-demand',
                    sessionId,
                    input.identity.pluginId,
                    input.identity.localId,
                    runtime.activationGeneration,
                    runtime.immutableGenerationId,
                    manifestAuthority,
                ])
                : null;
        })();
        if (!operationClaimId) return null;
        const lifetime = createPluginInvocationLifetime(
            input.retained
                ? input.signal
                : composePluginConsumerSignal(
                    input.identity.pluginId,
                    input.signal,
                ),
        );
        let operationAuthority: Awaited<ReturnType<
            ManagedProviderOperationAuthority['activate']
        >> | null = null;
        if (purposes.length > 0) {
            if (!params?.managedProviderOperationAuthority) {
                lifetime.complete();
                return null;
            }
            try {
                operationAuthority =
                    await params.managedProviderOperationAuthority.activate({
                        identity: input.identity,
                        operationId: operationClaimId,
                        purposes,
                        purposeBindings,
                        requestAuthUses: qualifiedRequestAuthUses,
                        isCurrent: readsInvocationCurrent,
                    });
            } catch {
                lifetime.complete();
                return null;
            }
        }
        const requestAuth = operationAuthority?.requestAuth ?? null;
        const seed = Object.freeze({
            plugin: Object.freeze({
                id: input.identity.pluginId,
                version: input.retained?.pluginVersion
                    ?? target!.manifest.version,
            }),
            contribution: Object.freeze({
                id: input.identity.localId,
                qualifiedId:
                    `${input.identity.pluginId}/providers/${input.identity.localId}`,
            }),
            generation: runtime.activationGeneration,
            correlationId: randomUUID(),
            surface: 'cli' as const,
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isGenerationCurrent: readsInvocationCurrent,
        });
        const storePaths = resolvePluginStorePaths({
            happyHomeDir: params?.happyHomeDir,
        });
        const services = invocationServiceOwners
            .createManagedProviderRuntimeInvocationServices(seed, {
                filesystemRoots: Object.freeze({
                    pluginData: join(
                        storePaths.storageDir,
                        input.identity.pluginId,
                        'fs',
                    ),
                    workspace: join(
                        storePaths.storageDir,
                        input.identity.pluginId,
                        'fs',
                    ),
                    projects: new Map(),
                }),
                managedProviderRuntime: Object.freeze({
                    realm: 'managedProviderStart' as const,
                    providerLocalId: input.identity.localId,
                    operationClaimId,
                    requestAuth,
                    isCurrent: readsInvocationCurrent,
                }),
                ...(operationAuthority?.exactPurposeBindingSubjectId
                    ? {
                        exactPurposeBindingSubjectId:
                            operationAuthority.exactPurposeBindingSubjectId,
                    }
                    : {}),
                hostAccessRequests: Object.freeze([
                    ...(input.retained?.requiredHostAccess
                        ?? target!.manifest.hostAccess.required)
                        .filter((request) => (
                            request.capability === 'process'
                        ))
                        .map((request) => Object.freeze({
                            request,
                            required: true,
                        })),
                    ...projectConnectedAccountPurposeDeclarationsToHostAccess(
                        declaration.connectedAccounts ?? [],
                    ),
                ]),
            });
        if (!services) {
            lifetime.complete();
            await operationAuthority?.cleanup().catch(() => undefined);
            return null;
        }
        let cleaned = false;
        let cleanupPromise: Promise<void> | null = null;
        let lifetimeCompleted = false;
        let operationAuthorityCleaned = operationAuthority === null;
        return Object.freeze({
            ...services,
            bootstrap: Object.freeze({
                identity: Object.freeze({ ...input.identity }),
                activationGeneration: runtime.activationGeneration,
                immutableGenerationId: runtime.immutableGenerationId,
                manifestAuthority,
                operationClaimId,
                requestAuth: requestAuth
                    ? Object.freeze({
                        capabilityPath: requestAuth.capabilityPath,
                        requestAuthUses:
                            requestAuth.requestAuthUses,
                    })
                    : null,
            }),
            async cleanup() {
                if (cleaned) return;
                if (cleanupPromise) return await cleanupPromise;
                const attempt = (async () => {
                    if (!lifetimeCompleted) {
                        lifetime.complete();
                        lifetimeCompleted = true;
                    }
                    if (!operationAuthorityCleaned) {
                        await operationAuthority!.cleanup();
                        operationAuthorityCleaned = true;
                    }
                    cleaned = true;
                })();
                cleanupPromise = attempt;
                try {
                    await attempt;
                } finally {
                    if (!cleaned && cleanupPromise === attempt) {
                        cleanupPromise = null;
                    }
                }
            },
        });
    }

    async function createManagedProviderRuntimeInvocationServices(
        input: Readonly<{
            identity: PluginContributionRef;
            purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
            operationClaim?: ManagedProviderRuntimeOperationClaim;
            signal: AbortSignal;
            isCurrent(): boolean;
        }>,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | null> {
        const invocation =
            await createManagedProviderRuntimeInvocationServicesInternal(
            input,
        );
        if (!invocation || input.operationClaim?.kind !== 'sessionDemand') {
            return invocation;
        }
        let runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
        try {
            runtimeBindingBasis = ProviderRuntimeBindingBasisV1Schema.parse(
                input.operationClaim.runtimeBindingBasis,
            );
        } catch {
            await Promise.resolve(invocation.cleanup())
                .catch(() => undefined);
            return null;
        }
        const provider = (authoritativeContributes.providers ?? []).find(
            (candidate) => (
                candidate.identity.pluginId === input.identity.pluginId
                && candidate.identity.localId === input.identity.localId
            ),
        );
        const declaration = provider?.definition.managedRuntime?.kind
            === 'managed'
            ? resolveProviderManagedRuntimeDeclarationV1({
                implementationIdentity: input.identity,
                managedRuntime: provider.definition.managedRuntime,
            })
            : null;
        const endpoint = provider?.definition.endpointTemplates.find(
            (candidate) => candidate.id
                === runtimeBindingBasis.endpoint.endpointTemplateId,
        );
        if (
            runtimeBindingBasis.deployment.kind !== 'managedLocal'
            || !isDeepStrictEqual(
                runtimeBindingBasis.deployment.implementationIdentity,
                input.identity,
            )
            || !declaration
            || !isDeepStrictEqual(
                runtimeBindingBasis.deployment.managedRuntime,
                declaration,
            )
            || endpoint?.protocol !== runtimeBindingBasis.endpoint.protocol
            || !isDeepStrictEqual(
                runtimeBindingBasis.deployment.purposeBindings,
                QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
                    input.purposeBindings,
                ),
            )
        ) {
            await Promise.resolve(invocation.cleanup())
                .catch(() => undefined);
            return null;
        }
        if (invocation.bootstrap.manifestAuthority === 'bundled_first_party') {
            const admitted = committed?.generations.get(
                invocation.bootstrap.identity.pluginId,
            );
            const exactActivationTarget = resolveExactActivationTarget(
                invocation.bootstrap.identity.pluginId,
            );
            const exactGeneratedArtifact =
                BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find((artifact) => (
                    artifact.record.pluginId
                        === invocation.bootstrap.identity.pluginId
                    && artifact.record.immutableGenerationId
                        === invocation.bootstrap.immutableGenerationId
                ));
            if (
                !admitted
                || admitted.installation !== undefined
                || !exactActivationTarget
                || exactActivationTarget.source.kind !== 'bundled'
                || !exactGeneratedArtifact
                || !isDeepStrictEqual(
                    admitted.record,
                    exactGeneratedArtifact.record,
                )
            ) {
                await Promise.resolve(invocation.cleanup())
                    .catch(() => undefined);
                return null;
            }
            try {
                await prepareImmutablePluginGeneration({
                    paths: resolvePluginStorePaths({
                        happyHomeDir: params?.happyHomeDir,
                    }),
                    sourceRootPath: admitted.rootPath,
                    record: admitted.record,
                });
            } catch {
                await Promise.resolve(invocation.cleanup())
                    .catch(() => undefined);
                return null;
            }
        }
        const scope: RetainedManagedProviderRuntimeInvocationScope =
            Object.freeze({
                sessionId: input.operationClaim.sessionId,
                runtimeBindingBasis,
                identity: invocation.bootstrap.identity,
                activationGeneration:
                    invocation.bootstrap.activationGeneration,
                immutableGenerationId:
                    invocation.bootstrap.immutableGenerationId,
                manifestAuthority:
                    invocation.bootstrap.manifestAuthority,
                operationClaimId:
                    invocation.bootstrap.operationClaimId,
            });
        let custody: ManagedProviderSessionCustodyBinding;
        try {
            custody = await input.operationClaim.bindSessionCustody(
                scope,
                invocation.managedServices.dependencies,
            );
        } catch {
            await Promise.resolve(invocation.cleanup())
                .catch(() => undefined);
            return null;
        }
        let cleaned = false;
        let cleanupPromise: Promise<void> | null = null;
        let custodyCleaned = custody.cleanup === undefined;
        let invocationCleaned = false;
        return Object.freeze({
            ...invocation,
            managedServices: custody.managedServices,
            projectEndpointAccess:
                custody.projectEndpointAccess,
            adoptService: custody.adoptService,
            async cleanup() {
                if (cleaned) return;
                if (cleanupPromise) return await cleanupPromise;
                const attempt = (async () => {
                    const outcomes = await Promise.allSettled([
                        (async () => {
                            if (custodyCleaned) return;
                            await custody.cleanup!();
                            custodyCleaned = true;
                        })(),
                        (async () => {
                            if (invocationCleaned) return;
                            await invocation.cleanup();
                            invocationCleaned = true;
                        })(),
                    ]);
                    const failures = outcomes.flatMap((outcome) =>
                        outcome.status === 'rejected'
                            ? [outcome.reason]
                            : []);
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            'Managed Provider Session custody cleanup failed',
                        );
                    }
                    cleaned = true;
                })();
                cleanupPromise = attempt;
                try {
                    await attempt;
                } finally {
                    if (!cleaned && cleanupPromise === attempt) {
                        cleanupPromise = null;
                    }
                }
            },
        });
    }

    async function createRetainedManagedProviderRuntimeInvocationServices(
        input: Readonly<{
            scope: RetainedManagedProviderRuntimeInvocationScope;
            signal: AbortSignal;
            isCurrent(): boolean;
            readAdoptedPublicOutcome():
                Promise<ManagedProviderAdoptedPublicOutcome | null>;
            revalidatePolicy(): Promise<boolean>;
        }>,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | null> {
        if (input.signal.aborted || !input.isCurrent()) return null;
        let adoptedPublicOutcome: ManagedProviderAdoptedPublicOutcome;
        try {
            const candidate = await input.readAdoptedPublicOutcome();
            if (
                !candidate
                || candidate.operationClaimId
                    !== input.scope.operationClaimId
                || candidate.serviceId.trim().length === 0
                || candidate.endpointAccess !== 'runnerProjected'
                || candidate.endpointTemplateIds.length === 0
                || new Set(candidate.endpointTemplateIds).size
                    !== candidate.endpointTemplateIds.length
                || candidate.endpoints.length
                    !== candidate.endpointTemplateIds.length
                || candidate.endpoints.some((endpoint, index) => (
                    endpoint.endpointTemplateId
                        !== candidate.endpointTemplateIds[index]
                    || !endpoint.servicePath.startsWith('/')
                ))
            ) return null;
            adoptedPublicOutcome = Object.freeze({
                ...candidate,
                endpointTemplateIds: Object.freeze([
                    ...candidate.endpointTemplateIds,
                ]),
                endpoints: Object.freeze(candidate.endpoints.map(
                    (endpoint) => Object.freeze({ ...endpoint }),
                )),
            });
            if (await input.revalidatePolicy() !== true) return null;
        } catch {
            return null;
        }
        const scope = input.scope;
        const identity = createPluginContributionIdentity(scope.identity);
        const sessionId = scope.sessionId.trim();
        const activationGeneration = scope.activationGeneration.trim();
        const immutableGenerationId = scope.immutableGenerationId.trim();
        const manifestAuthority = scope.manifestAuthority;
        const runtimeBindingBasis =
            ProviderRuntimeBindingBasisV1Schema.parse(
                scope.runtimeBindingBasis,
            );
        if (
            !sessionId
            || !activationGeneration
            || !immutableGenerationId
            || (
                manifestAuthority !== 'external'
                && manifestAuthority !== 'bundled_first_party'
            )
            || runtimeBindingBasis.deployment.kind !== 'managedLocal'
            || !adoptedPublicOutcome.endpointTemplateIds.includes(
                runtimeBindingBasis.endpoint.endpointTemplateId,
            )
            || !isDeepStrictEqual(
                runtimeBindingBasis.deployment.implementationIdentity,
                identity,
            )
        ) return null;
        const operationClaimId = JSON.stringify([
            'managed-provider-session-demand',
            sessionId,
            identity.pluginId,
            identity.localId,
            activationGeneration,
            immutableGenerationId,
            manifestAuthority,
        ]);
        if (scope.operationClaimId !== operationClaimId) return null;

        const storePaths = resolvePluginStorePaths({
            happyHomeDir: params?.happyHomeDir,
        });
        let generation: Awaited<ReturnType<
            typeof readPreparedImmutablePluginGeneration
        >>;
        try {
            generation = await readPreparedImmutablePluginGeneration({
                paths: storePaths,
                immutableGenerationId,
            });
        } catch {
            return null;
        }
        if (generation.record.pluginId !== identity.pluginId) return null;
        try {
            await assertContainedRegularGenerationFile(
                generation.rootPath,
                generation.record.manifestRelativePath,
                'Managed Provider generation manifest',
            );
        } catch {
            return null;
        }
        const manifest = await readPluginManifest({
            manifestPath: join(
                generation.rootPath,
                ...generation.record.manifestRelativePath.split('/'),
            ),
            manifestAuthority,
            sourceProvenance: generation.record.sourceProvenance,
        });
        const provider = manifest.ok
            ? manifest.manifest.contributes.providers.find(
                (candidate) => candidate.id === identity.localId,
            )
            : undefined;
        if (
            !manifest.ok
            || manifest.manifest.id !== identity.pluginId
            || provider?.managedRuntime?.kind !== 'managed'
        ) return null;
        const declaration = resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: identity,
            managedRuntime: provider.managedRuntime,
        });
        const endpoint = provider.endpointTemplates.find(
            (candidate) => candidate.id
                === runtimeBindingBasis.endpoint.endpointTemplateId,
        );
        if (
            !declaration.endpointTemplateIds.includes(
                runtimeBindingBasis.endpoint.endpointTemplateId,
            )
            || endpoint?.protocol !== runtimeBindingBasis.endpoint.protocol
            || !isDeepStrictEqual(
                declaration,
                runtimeBindingBasis.deployment.managedRuntime,
            )
        ) return null;
        if (!input.isCurrent()) return null;
        const invocation =
            await createManagedProviderRuntimeInvocationServicesInternal({
                identity,
                purposeBindings:
                    runtimeBindingBasis.deployment.purposeBindings,
                retained: Object.freeze({
                    declaration,
                    pluginVersion: manifest.manifest.version,
                    activationGeneration,
                    immutableGenerationId,
                    manifestAuthority,
                    requiredHostAccess:
                        manifest.manifest.hostAccess.required,
                    operationClaimId,
                }),
                signal: input.signal,
                isCurrent: input.isCurrent,
            });
        if (!invocation) return null;
        try {
            if (
                input.signal.aborted
                || !input.isCurrent()
                || !isDeepStrictEqual(
                    await input.readAdoptedPublicOutcome(),
                    adoptedPublicOutcome,
                )
                || await input.revalidatePolicy() !== true
            ) {
                await invocation.cleanup();
                return null;
            }
        } catch {
            await Promise.resolve(invocation.cleanup())
                .catch(() => undefined);
            return null;
        }
        return invocation;
    }

    const connectedAccountContributions = createConnectedAccountContributionRegistry({
        generation: String(activatedRegistry.generation),
        immutableGenerationIdsByPluginId,
        descriptors: authoritativeContributes.connectedAccountDescriptors ?? Object.freeze([]),
        onDescriptorUnavailable(ref) {
            logger.warn('[PLUGIN RUNTIME] Connected Account is unavailable: plugin generation was not admitted', {
                pluginId: ref.pluginId,
                localId: ref.localId,
                reason: projectPluginFailureText(new Error(
                    committed?.rejectedGenerations.get(ref.pluginId)?.message
                    ?? 'The plugin has no admitted immutable generation in this runtime',
                )),
            });
        },
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
            const target = resolveExactActivationTarget(pluginId);
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
        registerRawForRedaction: invocationServiceOwners.registerRawForRedaction,
        redactDiagnosticText(seed, value) {
            return invocationServiceOwners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, value);
        },
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
            getBinding: params.connectedAccounts.getBinding,
            materialize: params.connectedAccounts.materialize,
        })
        : null;
    // One currentness/generation guard for every live-resource call, so a
    // retired or replaced generation cannot answer a poll it no longer owns.
    function requireCurrentUiResourceWatches(expectedGeneration: string) {
        if (allRuntimeConsumersRetired) {
            throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
        }
        if (expectedGeneration !== String(activatedRegistry.generation)) {
            throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
        }
        if (!uiResourceWatches) {
            throw new PluginError({
                code: 'plugin_resource_service_unavailable',
                message: 'Committed plugin resources are unavailable',
            });
        }
        return uiResourceWatches;
    }

    const retireConsumers = (): void => {
        if (consumersRetired) return;
        consumersRetired = true;
        retireLiveSubscriptionConsumers();
        allRuntimeConsumersRetired = true;
        for (const pluginId of runtimeConsumerLifecycles.keys()) {
            retirePluginConsumers([pluginId]);
        }
        allRuntimeConsumerRetirement.abort(
            new Error('Executable plugin runtime registry consumer retired'),
        );
        invocationServiceOwners.retireConnectedAccountConsumers();
        committedTargetActionInvocations.dispose();
        connectedAccountContributions.dispose();
    };

    const verifyRetainedRunnerAgentServiceBinding = async (
        binding: AgentSessionRunnerBindingV1,
        unavailableCode: string,
    ) => {
        try {
            return await verifyRunnerAgentBindingAgainstGeneration({
                paths: resolvePluginStorePaths({
                    happyHomeDir: params?.happyHomeDir,
                }),
                binding,
            });
        } catch {
            throw new PluginError({
                code: unavailableCode,
                message:
                    'Exact retained Runner Agent generation bytes are unavailable',
            });
        }
    };

    const retainedAgentHostAccessRequests = (
        attested: Awaited<ReturnType<
            typeof verifyRunnerAgentBindingAgainstGeneration
        >>,
    ) => Object.freeze([
        ...attested.manifest.hostAccess.required.map((request) =>
            Object.freeze({ request, required: true }),
        ),
        ...attested.manifest.hostAccess.optional.map((request) =>
            Object.freeze({ request, required: false }),
        ),
        ...projectConnectedAccountPurposeDeclarationsToHostAccess(
            attested.declaredAgent.connectedAccounts ?? Object.freeze([]),
        ),
    ]);

    const requireCurrentGlobalRetainedAgentTarget = (
        binding: AgentSessionRunnerBindingV1,
    ) => {
        const target = resolveExactActivationTarget(binding.pluginId);
        if (!target) {
            throw new PluginError({
                code: 'plugin_services_current_global_unavailable',
                message:
                    `Current global services for retained Agent '${binding.agentId}' are unavailable`,
            });
        }
        return target;
    };

    const currentGlobalHostAccessRequests = (
        target: ReturnType<typeof requireCurrentGlobalRetainedAgentTarget>,
        binding: AgentSessionRunnerBindingV1,
    ) => Object.freeze([
        ...target.manifest.hostAccess.required.map((request) =>
            Object.freeze({ request, required: true }),
        ),
        ...target.manifest.hostAccess.optional.map((request) =>
            Object.freeze({ request, required: false }),
        ),
        ...projectConnectedAccountPurposeDeclarationsToHostAccess(
            target.manifest.contributes.agents.find(
                (candidate) => candidate.id === binding.localAgentId,
            )?.connectedAccounts ?? Object.freeze([]),
        ),
    ]);

    /**
     * One exact-current projection identity for daemon/UI consumers. Settings
     * and SDK services may build an ordinary binding from it; secret-native
     * daemon custody consumes this identity directly without a Settings model.
     */
    const createProjectionPluginInvocationSeed = (input: Readonly<{
        pluginId: string;
        signal?: AbortSignal;
    }>): PluginInvocationServicesSeed | null => {
        const target = resolveExactActivationTarget(input.pluginId);
        if (!target) return null;
        const signal = composePluginConsumerSignal(input.pluginId, input.signal);
        return Object.freeze({
            plugin: Object.freeze({
                id: input.pluginId,
                version: target.manifest.version,
            }),
            contribution: Object.freeze({
                id: 'settings',
                qualifiedId: `${input.pluginId}/settings`,
            }),
            generation: String(activatedRegistry.generation),
            correlationId: randomUUID(),
            surface: 'ui' as const,
            signal,
            isGenerationCurrent: () => (
                !signal.aborted && isPluginConsumerCurrent(input.pluginId)
            ),
        });
    };

    /**
     * One projection-facing ordinary service path. It preserves declaration
     * ownership while giving Settings and SDK consumers only their narrow
     * service surface.
     */
    const createProjectionPluginServices = (input: Readonly<{
        pluginId: string;
        signal?: AbortSignal;
    }>) => {
        const seed = createProjectionPluginInvocationSeed(input);
        if (!seed) return null;
        const binding = invocationServiceOwners.createOrdinaryServiceBinding(
            seed.generation,
            `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
            [],
            seed.contribution.qualifiedId,
        );
        return invocationServiceOwners.createServices(seed, binding);
    };

    const resolvedRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
        contributes: authoritativeContributes,
        generation: activatedRegistry.generation,
        targetActivationFacts: activatedRegistry.targetActivationFacts,
        targetActionInvocations: committedTargetActionInvocations,
        resolveActionPresentUserGatePolicy,
        ...(authoritativeContributes.readAdmittedTargetedContributions
            ? { readAdmittedTargetedContributions: authoritativeContributes.readAdmittedTargetedContributions }
            : {}),
        resolveCurrentPluginMaterializationRef,
        resolveCurrentPluginImmutableGenerationId,
        resolveCurrentMediatorContributionMaterializationRef,
        ...(params?.resolveCurrentMachineExecutionOriginContext
            ? { resolveCurrentPluginExecutionOrigin }
            : {}),
        prepareCollectionMigrationCandidates,
        retireCollectionMigrationCandidates,
        retirementSignal: allRuntimeConsumerRetirement.signal,
        stableEventsBroker:
            invocationServiceOwners.stableEventsBroker,
        publishHostEvent(event) {
            invocationServiceOwners.publishHostEvent(event);
        },
        hookHandlersByHookId,
        agentRuntimesByAgentId,
        scmHostingProvidersById: activatedRegistry.scmHostingProvidersById,
        scmBackendsById: activatedRegistry.scmBackendsById,
        scmBackendRegistrations: activatedRegistry.scmBackendRegistrations,
        requestInterceptors: activatedRegistry.requestInterceptors,
        invokeRequestInterceptor,
        voiceSpeechProviders,
        composerReferences,
        composerAttachments,
        promptAssetAdapters,
        systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId: activatedRegistry.envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId: activatedRegistry.filesystemReadAllowedPathsByPluginId,
        runtimeCapabilitiesByPluginId: activatedRegistry.runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
        pluginDiagnosticsByPluginId,
        pluginFinalPolicyCurrentGenerationsById,
        resolveVoiceProviderRuntimeLifecycle,
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess
                ?? Object.freeze([]);
        },
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
        activatedPluginIds: activatedRegistry.activatedPluginIds,
        activateContributionsOnDemand,
        acquireManagedProviderRuntime,
        acquireProviderCatalogParsers,
        runManagedProviderExplicitStart,
        createManagedProviderRuntimeInvocationServices,
        createRetainedManagedProviderRuntimeInvocationServices,
        activatePluginsForValidation,
        prepareDaemonDatabases,
        quiesceDaemonDatabases,
        readPreparedDaemonDatabaseContracts(pluginId) {
            return daemonDatabaseHost.readPreparedContracts(pluginId);
        },
        readDaemonDatabaseCapability(pluginId) {
            return daemonDatabaseHost.readCapability(pluginId);
        },
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
        async reserveManagedDependencyRetention(retainedAgent) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    retainedAgent,
                    'plugin_services_retained_managed_dependency_unavailable',
                );
            return managedDependencies.reserveRunnerRetention(
                verified.binding,
                retainedAgentHostAccessRequests(verified),
            );
        },
        addRuntimeDisposable: activatedRegistry.addRuntimeDisposable,
        createPluginMcpSessionResolver(mcpParams) {
            const target = resolveExactActivationTarget(mcpParams.pluginId);
            if (!target || target.manifest.version !== mcpParams.pluginVersion) return null;
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
                                    const spec: PluginHostedMcpServerSpec = Object.freeze({
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
            const declaration = (authoritativeContributes.mcpDiscoverySources ?? []).find((candidate) => (
                candidate.pluginId === detectionParams.pluginId
                && candidate.definition.id === detectionParams.localId
            ));
            const target = authoritativeContributes.activationTargets.find((candidate) => (
                candidate.pluginId === detectionParams.pluginId
            ));
            if (!declaration || !target) {
                throw new PluginError({
                    code: 'plugin_mcp_discovery_source_undeclared',
                    message: 'MCP discovery source is not declared',
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
                    qualifiedId: `${detectionParams.pluginId}/mcp.discoverySources/${detectionParams.localId}`,
                }),
                generation,
                correlationId,
                surface: 'cli',
                ...(detectionParams.input.sessionId
                    ? { session: Object.freeze({ id: detectionParams.input.sessionId }) }
                    : {}),
                signal: composePluginConsumerSignal(detectionParams.pluginId, detectionParams.signal),
                // Discovery is itself an activation demand. The generation may
                // be current before this source has published its binding;
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
                    endpoints: attachment?.endpoints ?? Object.freeze([]),
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
            const services = createProjectionPluginServices(settingsParams);
            return services?.availability('settings').status === 'available'
                ? services.settings.forScope(settingsParams.scope)
                : null;
        },
        createPluginSecretsService(secretParams) {
            const services = createProjectionPluginServices(secretParams);
            return services?.availability('secrets').status === 'available'
                ? services.secrets
                : null;
        },
        createDaemonPluginSecretAdministrationPort(secretParams) {
            const seed = createProjectionPluginInvocationSeed(secretParams);
            return seed
                ? invocationServiceOwners.bindDaemonPluginSecretAdministrationPort(seed)
                : null;
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
                [],
                seed.contribution.qualifiedId,
            );
            const services = invocationServiceOwners.createServices(seed, binding);
            return services.availability('events').status === 'available' ? services.events.plugin : null;
        },
        async createRetainedRunnerAgentCurrentGlobalActionsService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                );
            if (!agentParams.isGenerationCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${verified.binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }
            const currentTarget =
                requireCurrentGlobalRetainedAgentTarget(
                    verified.binding,
                );
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: currentTarget.pluginId,
                    version: currentTarget.manifest.version,
                }),
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        `${verified.binding.pluginId}/agents/${verified.binding.localAgentId}`,
                }),
                generation: String(activatedRegistry.generation),
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({
                    id: agentParams.sessionId,
                }),
                signal: agentParams.signal,
                isGenerationCurrent:
                    agentParams.isGenerationCurrent,
            });
            const binding =
                invocationServiceOwners
                    .createOrdinaryServiceBinding(
                        seed.generation,
                        `${seed.contribution.qualifiedId}:${seed.correlationId}:current-global-actions`,
                        [],
                        seed.contribution.qualifiedId,
                    );
            return invocationServiceOwners
                .createServices(seed, binding)
                .actions;
        },
        async createRetainedRunnerAgentCurrentGlobalMcpService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                );
            if (!agentParams.isGenerationCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${verified.binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }
            const currentTarget =
                requireCurrentGlobalRetainedAgentTarget(
                    verified.binding,
                );
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: currentTarget.pluginId,
                    version: currentTarget.manifest.version,
                }),
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        `${verified.binding.pluginId}/agents/${verified.binding.localAgentId}`,
                }),
                generation: String(activatedRegistry.generation),
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({
                    id: agentParams.sessionId,
                }),
                signal: agentParams.signal,
                isGenerationCurrent:
                    agentParams.isGenerationCurrent,
            });
            const policy = invocationServiceOwners
                .resolveInvocationHostPolicy({
                    pluginId: currentTarget.pluginId,
                    generation: seed.generation,
                    qualifiedId:
                        seed.contribution.qualifiedId,
                }, {
                    hostAccessRequests:
                        currentGlobalHostAccessRequests(
                            currentTarget,
                            verified.binding,
                        ),
                    surface: seed.surface,
                    sessionId: agentParams.sessionId,
                    signal: seed.signal,
                });
            return invocationServiceOwners
                .createServices(seed, policy.serviceBinding)
                .mcp;
        },
        async createRetainedRunnerAgentCurrentGlobalExternalSessionsService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                );
            if (!agentParams.isGenerationCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${verified.binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }
            const currentTarget =
                requireCurrentGlobalRetainedAgentTarget(
                    verified.binding,
                );
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: currentTarget.pluginId,
                    version: currentTarget.manifest.version,
                }),
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        `${verified.binding.pluginId}/agents/${verified.binding.localAgentId}`,
                }),
                generation: String(activatedRegistry.generation),
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({
                    id: agentParams.sessionId,
                }),
                signal: agentParams.signal,
                isGenerationCurrent:
                    agentParams.isGenerationCurrent,
            });
            const policy = invocationServiceOwners
                .resolveInvocationHostPolicy({
                    pluginId: currentTarget.pluginId,
                    generation: seed.generation,
                    qualifiedId:
                        seed.contribution.qualifiedId,
                }, {
                    hostAccessRequests:
                        currentGlobalHostAccessRequests(
                            currentTarget,
                            verified.binding,
                        ),
                    surface: seed.surface,
                    sessionId: agentParams.sessionId,
                    signal: seed.signal,
                });
            return invocationServiceOwners
                .createServices(seed, policy.serviceBinding)
                .sessions.external;
        },
        async createRetainedRunnerAgentInvocationServices(agentParams) {
            const storePaths = resolvePluginStorePaths({
                happyHomeDir: params?.happyHomeDir,
            });
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_managed_dependency_unavailable',
                );
            const {
                binding,
                generation,
                manifest,
                manifestAuthority,
                declaredAgent,
            } = verified;
            if (!agentParams.isGenerationCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }

            const retainedHostAccess =
                retainedAgentHostAccessRequests(verified);
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: binding.pluginId,
                    version: binding.pluginVersion,
                }),
                contribution: Object.freeze({
                    id: binding.localAgentId,
                    qualifiedId: `${binding.pluginId}/agents/${binding.localAgentId}`,
                }),
                generation: binding.immutableGenerationId,
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({ id: agentParams.sessionId }),
                signal: agentParams.signal,
                isGenerationCurrent: agentParams.isGenerationCurrent,
            });
            const composedHostAccess = composeProviderBindingProcessAccess({
                requests: retainedHostAccess.map(
                    ({ request }) => request,
                ),
                providerRequirements:
                    declaredAgent.providerRequirements ?? null,
                environment: agentParams.environment,
                providerBindingActive: agentParams.providerBindingActive,
            });
            const invocationHostAccess = composedHostAccess.map(
                (request, index) => Object.freeze({
                    request,
                    required:
                        retainedHostAccess[index]!
                            .required,
                }),
            );
            const systemToolDefinitions = projectPluginSystemToolContributions(
                manifest.contributes.systemTools ?? [],
            );
            const genericSystemTools = createPluginExecSystemToolResolver({
                definitions: systemToolDefinitions,
                registerGrant() {},
            });
            const agentCliSystemTool = (
                agentParams.agentCliLaunch?.localAgentId
                    === binding.localAgentId
            )
                ? declaredAgent.catalog?.agentCliSystemTool
                : undefined;
            const systemTools = agentCliSystemTool
                ? (() => {
                    const definition = systemToolDefinitions.find(
                        (candidate) => candidate.toolId === agentCliSystemTool.toolId,
                    );
                    if (!definition) {
                        throw new PluginError({
                            code: 'plugin_agent_cli_system_tool_unavailable',
                            message: `Agent '${binding.agentId}' CLI system tool is unavailable`,
                        });
                    }
                    return createRetainedAgentCliSystemToolService({
                        agentId: binding.agentId,
                        binding: agentCliSystemTool,
                        definition,
                        launch: agentParams.agentCliLaunch!.spec,
                        delegate: genericSystemTools,
                    });
                })()
                : genericSystemTools;
            const retainedManagedDependencies =
                await createRetainedRunnerManagedDependenciesHost({
                    paths: storePaths,
                    binding,
                    hostAccessRequests: retainedHostAccess,
                    retention:
                        mergeRunnerManagedDependencyRetentionV1(
                            agentParams.managedDependencyRetention,
                        ),
                    agentManifestAuthority: manifestAuthority,
                    env: process.env,
                });
            const retainedExecutableResolver =
                createStableManagedExecutableResolver({
                    systemTools: (manifest.contributes.systemTools ?? [])
                        .map(
                            (definition) => Object.freeze({
                                provenance:
                                    manifestAuthority
                                        === 'bundled_first_party'
                                        ? 'first_party' as const
                                        : 'external' as const,
                                source: Object.freeze({
                                    kind:
                                        manifestAuthority
                                            === 'bundled_first_party'
                                            ? 'bundled' as const
                                            : 'path' as const,
                                }),
                                pluginId: binding.pluginId,
                                definition,
                            }),
                        ),
                    managedDependencies:
                        retainedManagedDependencies,
                    resolveSystemTool:
                        resolveDeclaredSystemTool,
                });
            const eventDeclarationsByPluginId = new Map(
                activatedRegistry.eventDeclarationsByPluginId,
            );
            eventDeclarationsByPluginId.set(
                binding.pluginId,
                Object.freeze([
                    ...(manifest.contributes.events ?? []),
                ]),
            );
            const activePluginIds = new Set(
                activatedRegistry.activatedPluginIds,
            );
            activePluginIds.add(binding.pluginId);
            const retainedResourcesOwner =
                (manifest.contributes.resources ?? []).length > 0
                    ? await createStableImmutablePluginResourcesOwner({
                        generationId:
                            binding.immutableGenerationId,
                        pluginId: binding.pluginId,
                        rootPath: generation.rootPath,
                        files: generation.record.files,
                        declarations:
                            manifest.contributes.resources ?? [],
                        ...(manifest.brand?.iconResourceId === undefined
                            ? {}
                            : { brandIconResourceId: manifest.brand.iconResourceId }),
                        isGenerationCurrent:
                            agentParams.isGenerationCurrent,
                    })
                    : null;
            const services = invocationServiceOwners.createOperationServices(
                seed,
                {
                    filesystemRoots: Object.freeze({
                        pluginData: join(
                            storePaths.storageDir,
                            binding.pluginId,
                            'fs',
                        ),
                        workspace: agentParams.cwd,
                        projects: new Map(),
                    }),
                    hostAccessRequests:
                        Object.freeze(invocationHostAccess),
                    executionRealm: 'runner',
                    resolveExecutable:
                        retainedExecutableResolver,
                    // Launch-time Provider/profile environment is runner-only.
                    // Stable daemon services rematerialize current account and
                    // HostAccess facts through their owning services.
                    environment: Object.freeze({}),
                    systemTools,
                    settingsDeclarations: Object.freeze(
                        (manifest.contributes.settings ?? []).map(
                            (contribution) => Object.freeze({
                                pluginId: binding.pluginId,
                                contribution,
                            }),
                        ),
                    ),
                    secretDeclarations: collectDeclaredPluginSecrets([
                        Object.freeze({
                            pluginId: binding.pluginId,
                            manifest,
                        }),
                    ]),
                    eventDeclarationsByPluginId,
                    activePluginIds,
                    resources: retainedResourcesOwner,
                    // Exact G HostAccess scopes and the live daemon turn
                    // authority fence the stable binary-safe transport.
                    // Request interception is installation-wide current-global
                    // policy, while Voice credentials and final policy remain
                    // separate G-incompatible private callback authorities.
                    httpBinding: Object.freeze({
                        interceptorRegistry:
                            currentGlobalRequestInterceptorRegistry,
                        credentialBindingHost: null,
                        revalidateFinalPolicy: null,
                    }),
                    notificationCategories: Object.freeze(
                        (manifest.contributes.notifications ?? [])
                            .map((definition) => Object.freeze({
                                pluginId:
                                    binding.pluginId,
                                definition,
                            })),
                    ),
                },
            );
            const resourceDescriptors: Record<
                string,
                ReturnType<PluginServices['resources']['describe']>
            > = {};
            if (
                services.availability('resources').status
                    === 'available'
            ) {
                for (
                    const resource
                    of manifest.contributes.resources ?? []
                ) {
                    resourceDescriptors[resource.id] =
                        services.resources.describe(resource.id);
                }
            }
            const eventSubscriptions = Object.freeze(
                (manifest.contributes.events ?? []).flatMap(
                    (entry): PluginContributionRef[] => {
                        if (entry.kind !== 'subscription') return [];
                        if (entry.target.kind !== 'plugin') return [];
                        return [
                            typeof entry.target.event === 'string'
                                ? Object.freeze({
                                    pluginId:
                                        binding.pluginId,
                                    localId: entry.target.event,
                                })
                                : Object.freeze({
                                    ...entry.target.event,
                                }),
                        ];
                    },
                ),
            );
            return Object.freeze({
                services,
                resourceDescriptors:
                    Object.freeze(resourceDescriptors),
                subscriptionCapabilities: Object.freeze({
                    settingsWatch:
                        services.availability('settings').status
                            === 'available',
                    eventSubscriptions,
                    resourceWatches: Object.freeze([]),
                    notificationPreferencesWatch:
                        services.availability('notifications').status
                            === 'available',
                }),
            });
        },
        async createAgentInvocationServices(agentParams) {
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
            // Callers address an Agent by its host routing id, which is
            // qualified for an installed Agent and differently cased for some
            // bundled ones. A plugin-contribution identity is always
            // `{pluginId, localId}`, so it is resolved from the Agent's own
            // durable identity here rather than re-read from the routing id.
            const agentLocalId = declaredAgent.identity?.localId ?? agentParams.agentId;
            const seed = Object.freeze({
                plugin: Object.freeze({ id: agentParams.pluginId, version: agentParams.pluginVersion }),
                contribution: Object.freeze({
                    id: agentLocalId,
                    qualifiedId: `${agentParams.pluginId}/agents/${agentLocalId}`,
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
        ...(resourcesOwner ? {
            getPluginUiResourceCapability(pluginId: string) {
                return resourcesOwner.getPluginUiResourceCapability(pluginId);
            },
            applyResourceSessionAccessWitness(params: ResourceSessionAccessWitness) {
                resourcesOwner.applySessionAccessWitness(params);
            },
            getPluginBrandAsset(pluginId: string) {
                return resourcesOwner.getPluginBrandAsset(pluginId);
            },
        } : {}),
        async resolvePromptAssetBlocks(promptParams) {
            const agents = authoritativeContributes.agents.filter((agent) => (
                agent.id === promptParams.agentId && agent.pluginId
            ));
            if (agents.length === 0) return Object.freeze([]);
            if (agents.length !== 1) {
                throw new Error(`Prompt asset Agent identity '${promptParams.agentId}' is ambiguous`);
            }
            const agent = agents[0]!;
            const excludedPluginIds = new Set(
                promptParams.excludePluginIds ?? [],
            );
            return await bindPromptAssetContributionBlocks({
                promptAssets: (authoritativeContributes.promptAssets ?? [])
                    .filter((asset) => !excludedPluginIds.has(asset.pluginId)),
                resolveContributionGeneration: (pluginId) => (
                    immutableGenerationIdsByPluginId.get(pluginId) ?? null
                ),
                resources: resourcesOwner,
                agent: {
                    pluginId: agent.pluginId!,
                    localId: agent.identity?.localId ?? agent.definition.id,
                },
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
        async readUiResource(resourceParams) {
            if (allRuntimeConsumersRetired) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
            }
            const generation = String(activatedRegistry.generation);
            if (resourceParams.expectedGeneration !== generation) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
            }
            if (!resourcesOwner || !resourcesOwner.hasPlugin(resourceParams.callerPluginId)) {
                throw new PluginError({
                    code: 'plugin_resource_service_unavailable',
                    message: 'Committed plugin resources are unavailable',
                });
            }
            const signal = resourceParams.signal ?? new AbortController().signal;
            const isResourceBindingCurrent = () => (
                !allRuntimeConsumersRetired
                && resourceParams.expectedGeneration === String(activatedRegistry.generation)
                && isPluginConsumerCurrent(resourceParams.callerPluginId)
            );
            const assertResourceBindingCurrent = (): void => {
                if (signal.aborted) {
                    throw new PluginError({
                        code: 'plugin_resource_aborted',
                        message: 'Resource operation was aborted',
                    });
                }
                if (!isResourceBindingCurrent()) {
                    throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
                }
            };
            assertResourceBindingCurrent();
            const service = await resourcesOwner.bindForResource({
                pluginId: resourceParams.callerPluginId,
                resourceId: resourceParams.resourceId,
                signal,
                isGenerationCurrent: isResourceBindingCurrent,
                ...(resourceParams.context === undefined ? {} : { context: resourceParams.context }),
            });
            assertResourceBindingCurrent();
            return await service.read(resourceParams.resourceId, { signal });
        },
        async openUiResourceWatch(watchParams) {
            const watches = requireCurrentUiResourceWatches(watchParams.expectedGeneration);
            return await watches.open({
                callerPluginId: watchParams.callerPluginId,
                subscriptionId: watchParams.subscriptionId,
                resourceId: watchParams.resourceId,
                ...(watchParams.context === undefined ? {} : { context: watchParams.context }),
            });
        },
        async pollUiResourceWatch(watchParams) {
            const watches = requireCurrentUiResourceWatches(watchParams.expectedGeneration);
            return await watches.next({
                callerPluginId: watchParams.callerPluginId,
                subscriptionId: watchParams.subscriptionId,
                ...(watchParams.waitMs === undefined ? {} : { waitMs: watchParams.waitMs }),
                ...(watchParams.signal ? { signal: watchParams.signal } : {}),
            });
        },
        closeUiResourceWatch(watchParams) {
            if (!uiResourceWatches) return false;
            return uiResourceWatches.close({
                callerPluginId: watchParams.callerPluginId,
                subscriptionId: watchParams.subscriptionId,
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
                const isResourceBindingCurrent = () => (
                    !allRuntimeConsumersRetired
                    && messageParams.expectedGeneration === String(activatedRegistry.generation)
                    && isPluginConsumerCurrent(reference.identity.pluginId)
                );
                const assertResourceBindingCurrent = (): void => {
                    if (signal.aborted) {
                        throw new PluginError({
                            code: 'plugin_resource_aborted',
                            message: 'Resource operation was aborted',
                        });
                    }
                    if (!isResourceBindingCurrent()) {
                        throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
                    }
                };
                assertResourceBindingCurrent();
                const service = await resourcesOwner.bindForResource({
                    pluginId: reference.identity.pluginId,
                    resourceId: reference.identity.localId,
                    signal,
                    isGenerationCurrent: isResourceBindingCurrent,
                });
                assertResourceBindingCurrent();
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
        settleRetiredBackgroundServices: async (pluginIds) => {
            await activatedRegistry.settleRetiredBackgroundServices(pluginIds);
        },
        startAdoptedBackgroundServices: () => activatedRegistry.startAdoptedBackgroundServices(),
        publishDeclaredEventSubscriptions,
        retireLiveSubscriptionConsumers,
        currentGlobalExternalSessionsTarget,
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

import { createHash, randomUUID } from 'node:crypto';
import type { DaemonPluginStoredImageReadRequest } from '@happier-dev/protocol';
import { projectPluginSessionAccessIdentity } from '@happier-dev/protocol';
import type { PluginUiReadStoredImageResultV1 } from '@happier-dev/protocol/plugins/ui';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { sessionMediaToStructuredImageInput, verifySessionStructuredImageInput } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
    createPluginRuntimeOccurrenceId,
    type PluginRuntimeOccurrenceId,
    type PluginRuntimeSlotOccurrence,
} from './runtimeSlots';
import { retireAccountLifetimePluginPermissionGrantsForPlugin } from './lifecycle/permissions/pluginPermissionGrantListReader';
import {
    pluginSourceCustodyEqual,
    resolvePluginSourceCustody,
    type PluginSourceCustody,
} from './sourceAuthority';
import {
    projectReleaseLessPluginDeclarations,
    type ReleaseLessPluginDeclaration,
} from '@/plugins/availability/releaseLessDeclarations';
import {
    assemblePluginRuntimeActivation,
    type PluginRuntimeActivationRegistryLease,
} from './composition/activationAssembly';
import { assemblePluginRuntimeConsumers } from './composition/consumerAssembly';
import {
    assembleConnectedAccountRuntime,
    projectConnectedAccountPurposeBindingOwner,
} from './composition/connectedAccountAssembly';
import { assembleAutomationRuntime } from './composition/automationAssembly';
import { attestRetainedManagedProvider } from './composition/retainedProviderAssembly';
import type { PreparedPluginDevelopmentActivationGraph } from '@/plugins/authoring/sourceModule';
import {
    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
    BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
    BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
} from '../projection/registry/sources/generatedBundledPluginManifests';
import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '../projection/registry/projectManifestAgentContribution';
import { resolveAgentContributionQualifiedId } from '../projection/registry/agentRoutingIdentity';
import {
    projectAgentCliAuthCatalogEntry,
    projectAgentCliSessionCommandCatalogEntry,
    projectAgentConnectedAccountLaunchCatalogEntry,
    projectAgentDaemonSpawnHooksCatalogEntry,
    projectAgentExperimentalVendorResumeSupportCatalogEntry,
    projectAgentPreflightSessionControlsCatalogEntry,
    projectAgentProviderCliAttachCatalogEntry,
    projectAgentSessionStartupCatalogEntry,
    projectAgentTerminalPromptSubmitVerificationCatalogEntry,
} from '../projection/registry/agentCatalogEntryHooks';
import {
    dropTargetedContributionAdmissionDiagnostics,
} from '../projection/registry/targetedContributions';
import type {
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedManagedProviderRuntime,
    ResolvedProviderCatalogParsers,
} from '../projection/registry/types';
import {
    buildQualifiedPluginContributionKey,
    arePluginMachineMaterializationRefsEqual,
    createPluginContributionIdentity,
    evaluatePluginFinalPolicy,
    isDynamicPluginResourceContributionV2,
    McpDetectedProviderV1Schema,
    normalizePluginAccountCollectionContractsV1,
    PluginMachineExecutionOriginV1Schema,
    PluginMachineMaterializationRefV1Schema,
    TargetActionApprovalReplayPlacementV1Schema,
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
    type TargetActionApprovalReplayPlacementV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionContractRefV1,
    type PluginReleaseRefV1,
    type PluginUiArtifactDigestV1,
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
    resolvePackagedBundledActivationPaths,
} from './bundledActivationSource';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../scm/pluginBackends/runtimeRegistry';
import { createPluginActivationSourceResolver } from './pluginActivationSource';
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
    ManagedServiceSessionBaseUrlResolver,
    ManagedServiceSessionClientAccessResolver,
} from './invocation/services/managedServiceEndpointProjection';
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
import { executeContributedAction, type ClientContributedActionExecutor } from './invocation/actions/executeContributedAction';
import { createHostContributedActionInvoker } from './invocation/actions/hostContributedActionInvoker';
import {
    resolveCurrentSessionCapabilityBinding,
    resolveCurrentSessionUiBinding,
} from '@/session/presentation/currentSessionUiBindings';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createPluginSessionsInventory } from '@/session/services/pluginSessionsInventory';
import { executePluginSessionMessageAction } from '@/session/services/executePluginSessionMessageAction';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import {
    createCurrentGlobalExternalSessionsAuthorBinding,
    createCurrentGlobalExternalSessionsAuthorService,
} from '@/session/external/currentGlobalAuthorService';
import type {
    ConfiguredExternalSessionSourceAgentContribution,
} from '@/session/external/configuredSourceMaterializer';
import type {
    ConfiguredExternalSessionSourceRefusal,
} from '@/session/external/configuredSourceRegistry';
import {
    resolveHostApplicableExternalSessionsPublicScopes,
    type CurrentGlobalExternalSessionsRouter,
} from '@/session/external/currentGlobalRouting';
import type { ExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import {
    createPluginSessionHandleCapabilitiesFactory,
} from '@/session/services/pluginSessionHandleCapabilities';
import { createUnavailablePluginServices } from './invocation/services/unavailable';
import { projectOrdinaryPluginSessionLiveCapabilities } from './context/session/ordinaryPluginSessionLiveCapabilities';
import type { createTargetActionInvocationRegistry } from './invocation/targetActionRegistry';
import {
    createCliActionExecutorFromCredentials,
    type CliActionMachineAdmissionTransport,
} from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    createProductionPluginInvocationServiceOwners,
    type ManagedProviderRuntimeInvocationServices,
} from './invocation/services/production';
import { readPluginSettingsValuesWithDefaults } from './invocation/services/settings';
import type {
    PluginAccountSettingsRecordAdapter,
} from './invocation/services/settings';
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
    collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners,
    findGeneratedReactNativeCollectionMigrationsModule,
} from '../projection/registry/ui/generatedUiArtifactOwners';
import {
    resolveManifestHostAccessRequests,
    resolveManifestHostAccessRequestsForQualifiedContribution,
} from './hostAccess/manifestRequests';
import { createPluginResourceAccountStorageResolver } from './hostAccess/resolve';
import type { StablePluginConnectedAccountsOwner } from './invocation/services/connectedAccounts';
import type { StablePluginNotificationsOwner } from './invocation/services/notifications';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
    QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
    createStableImmutablePluginResourcesOwner,
    createStableRetainedPluginResourcesOwner,
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
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
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
    AgentInvocationTurnAdmissionWitness,
    CreateAgentInvocationServices,
    PluginInvocationServicesSeed,
    PluginProviderOperationsSource,
} from './invocation/services/types';
import {
    withPluginInvocationServiceBindingAvailability,
} from './invocation/services/unavailable';
import {
    createHostSessionPresentationOwner,
    type HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import type {
    createConnectedAccountContributionRegistry,
    ConnectedAccountRuntimeLease,
} from './connectedAccounts/contributionRegistry';
import type {
    createConnectedAccountHostRuntimeInvoker,
    ConnectedAccountHostRuntimeInvoker,
} from './connectedAccounts/runtimeInvoker';
import type { StablePluginManagedDependenciesHost } from './invocation/services/managedDependencies';
import { composeProviderBindingProcessAccess } from './providerBindings/invocationAccess';
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from './runner/loadRetainedAgentRuntimeLeaf';
import type {
    AgentSessionRunnerBindingV1,
} from './runner/agentSessionRunnerFactoryBinding';
import { verifyAgentSessionRunnerBindingV1 } from './runner/agentSessionRunnerFactoryBinding';
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
    ManagedServiceCredentialFileOwner,
} from './invocation/services/managedServicesAdapter';
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
import { resolveAuthoritativePackagedRuntimeCustody } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import {
    resolveManagedProviderRuntimeExecutable,
} from '@/providers/lifecycle/resolveManagedProviderRuntimeLaunch';
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
    ImmutablePluginGenerationRecordSchema,
    readCurrentCommittedPluginGenerations,
    readCurrentPluginHardRevocationRevision,
    readPreparedImmutablePluginGeneration,
} from '../store/registry/generationStore';
import {
    resolveCurrentInstalledPluginGenerationRuntimeExecutable,
} from './installedGenerationRuntimeExecutable';
import { readPluginManifest } from '../manifest/read';
import { ingestCanonicalPluginManifest } from '../manifest/ingest';
import { pluginSourceProvenanceForKind } from '../manifest/sourceProvenance';
import { serializeCanonicalPluginManifest } from '../manifest/serialize';
import { projectPluginAuthorModule } from '../authoring/sourceModule';
import { loadPluginModule } from './loadPluginModule';
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
    type PluginFinalPolicyCurrentRuntime,
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
import {
    createGlobalFetchRuntime,
    type GlobalFetchRuntimeDependencies,
} from './fetch/globalFetchRuntime';
import type { PluginNetworkAddressResolver } from './fetch/originLocality';
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

export type PluginContributionRuntimeLifecycle = Readonly<{
    occurrenceId: string;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export type ResolvedManagedProviderRuntimeInvocationServices =
    ManagedProviderRuntimeInvocationServices & Readonly<{
        bootstrap: Readonly<{
            identity: PluginContributionRef;
            occurrenceId: string;
            sourceCustody: PluginSourceCustody;
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
        kind: 'providerBroker';
        operation:
            | Readonly<{ kind: 'session'; sessionId: string }>
            | Readonly<{
                kind: 'execution_run';
                executionRunId: string;
            }>
            | Readonly<{
                kind: 'external_api_key';
                externalApiKeyId: string;
                operationId: string;
                assignedAccountId: string;
                assignedTeamMembershipId: string;
            }>
            | Readonly<{
                kind: 'resource_test';
                actorAccountId: string;
                requestId: string;
            }>;
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
    retirementGroup?: ManagedProviderExplicitStartOperationInput['retirementGroup'];
    identity: PluginContributionRef;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    machineId: string;
    operationClaim?: Extract<
        ManagedProviderRuntimeOperationClaim,
        { kind: 'providerBroker' }
    >;
    signal?: AbortSignal;
    isCurrent(): boolean;
    revalidateRetainedCurrentness?(signal?: AbortSignal): Promise<boolean>;
    establish: ManagedProviderExplicitStartOperationInput['establish'];
}>;

export type RetainedManagedProviderRuntimeInvocationScope = Readonly<{
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    identity: PluginContributionRef;
    occurrenceId: string;
    sourceCustody: PluginSourceCustody;
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
    /**
     * Durable installed-catalog revision from which this runtime was resolved.
     * Controller-published leases use it only to avoid joining two different
     * current snapshots; partial fixtures without this fact fail closed there.
     */
    durableRevision?: number;
    generation?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['generation'];
    readPluginOccurrenceId?(pluginId: string): PluginRuntimeOccurrenceId | null;
    isPluginOccurrenceCurrent?(
        pluginId: string,
        occurrenceId: PluginRuntimeOccurrenceId,
    ): boolean;
    readPluginSourceCustody?(pluginId: string): PluginSourceCustody | null;
    targetActivationFacts?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['targetActivationFacts'];
    targetActionInvocations?: ReturnType<typeof createTargetActionInvocationRegistry>;
    /** Existing authenticated machine reverse RPC; the answering UI owns client execution. */
    executeClientAction?: ClientContributedActionExecutor;
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
     * Machine materializations of daemon-selected plugins that no install
     * registry record reports; the Availability reporter adds them.
     */
    readReleaseLessMaterializations?(): readonly NonNullable<
        ReleaseLessPluginDeclaration['runtimeMaterialization']
    >[];
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
     * The same runtime owner resolves the exact daemon placement required by
     * a durable API Action approval. Unlike an SDK execution origin, this
     * placement deliberately has no plugin materialization component.
     */
    resolveCurrentPluginApprovalReplayPlacement?(
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<TargetActionApprovalReplayPlacementV1 | null>;
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
    pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels' | 'sendHostNotification'>;
    promptAssetAdapters?: ReadonlyMap<string, PromptAssetAdapter>;
    systemToolDefinitionsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['systemToolDefinitionsByPluginId'];
    envAllowedNamesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['envAllowedNamesByPluginId'];
    filesystemReadAllowedPathsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['filesystemReadAllowedPathsByPluginId'];
    runtimeCapabilitiesByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['runtimeCapabilitiesByPluginId'];
    eventDeclarationsByPluginId?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['eventDeclarationsByPluginId'];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    /** Applied package admission facts. Real registries provide them; partial
     * consumer fixtures may omit them and consumers must then fail closed. */
    pluginFinalPolicyCurrentRuntimesById?: ReadonlyMap<string, PluginFinalPolicyCurrentRuntime>;
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
    resolveCaptureSource(reference: PluginContributionIdentityV1): Promise<Readonly<{
            declaration: import('@happier-dev/protocol/plugins/contributions/v2').PluginCaptureSourceContributionV1;
        runtime: import('@happier-dev/plugin-sdk').PluginCaptureSourceRuntime;
        occurrenceId: string;
        retirementSignal: AbortSignal;
        isCurrent(): boolean;
    }> | null>;
    /**
     * Activates one declared Agent through the canonical target owner and
     * returns its generation-fenced internal catalog projection. This avoids
     * publishing a second mutable catalog for daemon compatibility consumers.
     */
    acquireAgentCatalogEntry?(agentId: string): Promise<ResolvedCatalogEntry | null>;
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
    retireManagedProviderExplicitStart?(input: Readonly<{
        identity: PluginContributionRef;
        machineId: string;
        operationClaim?: Extract<
            ManagedProviderRuntimeOperationClaim,
            { kind: 'providerBroker' }
        >;
    }>): Promise<boolean>;
    retireManagedProviderExternalApiKey?(input: Readonly<{
        identity: PluginContributionRef;
        externalApiKeyId: string;
        operationId: string;
    }>): Promise<boolean>;
    revalidateManagedProviderExplicitStarts?(signal?: AbortSignal): Promise<number>;
    retireManagedProviderExplicitStarts?(
        lifecycleKind: 'publicExplicitStart' | 'providerBroker',
    ): Promise<number>;
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
    /**
     * Fences one plugin whose readiness was rejected after activation and records
     * its one typed `plugin_activation_failed` diagnostic, leaving retained peers
     * serving. Real resolved registries provide it; partial consumer fixtures may
     * omit it because ordinary invocation never calls it.
     */
    recordPluginActivationFailure?: (pluginId: string, message: string) => void | Promise<void>;
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
        Pick<
            StablePluginConnectedAccountsOwner,
            'getBinding' | 'materialize' | 'watch' | 'listAccounts'
        > | null;
    /** Host-private credential-file custody shared by managed services and Agent launch. */
    resolveManagedServiceCredentialFileOwner?(): ManagedServiceCredentialFileOwner | null;
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
    /** Exact retained-G structural declarations for daemon-replacement recovery. */
    acquireRetainedRunnerAgentPurposeContributions?(params: Readonly<{
        binding: AgentSessionRunnerBindingV1;
        pluginHardRevocationRevision: number;
    }>): Promise<Readonly<{
        contributes: ResolvedContributionRegistry;
        isCurrent(): boolean;
        release(): Promise<void>;
    }> | null>;
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
            isOccurrenceCurrent(): boolean;
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
            readActiveTurnAdmissionWitness?():
                AgentInvocationTurnAdmissionWitness | null;
            isOccurrenceCurrent(): boolean;
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
            isOccurrenceCurrent(): boolean;
        }>,
    ): Promise<PluginServices['mcp']>;
    /** Public current-global External Sessions service for a retained Runner
     * Agent. The retained identity remains the caller's hard-revocation
     * boundary; every method routes through the published current owner. */
    createRetainedRunnerAgentCurrentGlobalExternalSessionsService?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            sessionId: string;
            correlationId: string;
            signal: AbortSignal;
            isOccurrenceCurrent(): boolean;
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
        expectedCallerOccurrenceId: string;
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
    readUiStoredImage?(params: DaemonPluginStoredImageReadRequest & Readonly<{ signal?: AbortSignal }>): Promise<PluginUiReadStoredImageResultV1>;
    /**
     * EU-4b: establish, poll and retire one live resource subscription for a
     * mounted plugin UI surface. Caller-scoped exactly like `readUiResource`,
     * and absent when this generation admits no resources at all.
     */
    openUiResourceWatch?(params: Readonly<{
        expectedCallerOccurrenceId: string;
        callerPluginId: string;
        subscriptionId: string;
        resourceId: string;
        /** Host-stamped exact target context; contextual Resources require it. */
        context?: PluginResourceContextV1;
    }>): Promise<Readonly<{ subscriptionId: string; digest: string }>>;
    pollUiResourceWatch?(params: Readonly<{
        expectedCallerOccurrenceId: string;
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
        expectedContributorOccurrenceId: string;
        kind: string;
        payload: JsonValue;
        resourceRefs?: NonNullable<HostStructuredMessageDescriptorV1['actions']>;
        facts: ContributionPolicyFacts;
        signal?: AbortSignal;
    }>): Promise<StablePluginStructuredMessageResolution>;
    /** Synchronously fences invocation capabilities while resource disposal remains lease-delayed. */
    retireConsumers(): void;
    /** Makes the named plugin occurrences unavailable at their owning commit/publication boundary. */
    fencePluginConsumers?(pluginIds: readonly string[]): void;
    /**
     * Notifies the slot owner when this registry fences one plugin occurrence
     * (publication fence, terminal activation failure, readiness isolation).
     */
    subscribePluginOccurrenceFence?(
        listener: (pluginId: string, occurrenceId: PluginRuntimeOccurrenceId) => void,
    ): () => void;
    /**
     * Idempotently fences named plugin occurrences, then settles their
     * occurrence-scoped durable consumers after a replacement publishes.
     */
    retirePluginConsumers?(pluginIds: readonly string[]): Promise<void>;
    /** Boundedly settles changed occurrence-scoped background work before replacement starts. */
    settleRetiredBackgroundServices?(pluginIds: readonly string[]): Promise<void>;
    /** Starts committed background work after this registry is adopted/current. */
    startAdoptedBackgroundServices?(): void;
    /** Makes this registry's declared event handlers effect-capable at the
     * synchronous daemon publication boundary. */
    publishDeclaredEventSubscriptions?(): void;
    /** Fences this registry's live push subscriptions — declared event handlers
     * and mounted UI resource watches — synchronously while lease-delayed
     * registry disposal remains pending. */
    retireLiveSubscriptionConsumers?(pluginIds?: readonly string[]): void;
    /** This registry's public current-global External Sessions authority. The
     * reload controller publishes exactly one of these at a time and the
     * daemon-lifetime router reads whichever is published now. */
    currentGlobalExternalSessionsTarget?: CurrentGlobalExternalSessionsRouter;
    /** Retains one serving plugin's activation component for a successor registry. */
    retainPluginActivationComponent?(pluginId: string): PluginRuntimeActivationRegistryLease | null;
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
    resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver,
    resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver,
    resolveAgentPluginSettings?: (input: Readonly<{
        pluginId: string;
        localAgentId: string;
    }>) => Promise<AgentCliSessionCommandPluginSettingsV1 | null>,
): ResolvedContributionRegistry {
    const activationTargets = base.activationTargets ?? Object.freeze([]);
    // Declarative role and workflow sources share the executable occurrence
    // fence while a predecessor registry is retained during publication.
    const withCurrentDeclarativeSources = (registry: ResolvedContributionRegistry): ResolvedContributionRegistry => {
        const roles = registry.roles ?? [];
        const workflows = registry.workflows ?? [];
        const inputTypes = registry.inputTypes ?? [];
        const dragSources = registry.dragSources ?? [];
        const dropTargets = registry.dropTargets ?? [];
        if (roles.length === 0 && workflows.length === 0 && inputTypes.length === 0
            && dragSources.length === 0 && dropTargets.length === 0) return registry;
        return Object.freeze({
            ...registry,
            get roles() {
                return Object.freeze(roles.filter((role) => isPluginRuntimeCurrent(role.pluginId)));
            },
            get workflows() {
                return Object.freeze(workflows.filter((workflow) => isPluginRuntimeCurrent(workflow.pluginId)));
            },
            get inputTypes() {
                return Object.freeze(inputTypes.filter((type) => isPluginRuntimeCurrent(type.pluginId)));
            },
            get dragSources() {
                return Object.freeze(dragSources.filter((source) => isPluginRuntimeCurrent(source.pluginId)));
            },
            get dropTargets() {
                return Object.freeze(dropTargets.filter((target) => isPluginRuntimeCurrent(target.pluginId)));
            },
        });
    };
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
        entry.registration.family === 'providers'
        && activated.isPluginOccurrenceCurrent(entry.pluginId, entry.occurrenceId)
    ));
    const projectedProviders = projectTargetProviderRuntimes({
        providers: base.providers ?? [],
        activationTargets,
        targetRegistrations: providerRuntimeRegistrations,
        sourceCustodiesByPluginId: new Map(
            [...activated.activatedPluginIds].flatMap((pluginId) => {
                const sourceCustody = activated.readPluginSourceCustody(pluginId);
                return sourceCustody ? [[pluginId, sourceCustody] as const] : [];
            }),
        ),
        isRegistrationCurrent: (entry) => (
            isPluginRuntimeCurrent(entry.pluginId)
            && activated.activatedPluginIds.has(entry.pluginId)
            && activated.readPluginOccurrenceId(entry.pluginId) === entry.occurrenceId
        ),
    });
    const providers = projectedProviders.providers;
    const systemToolsByPluginId = new Map<
        string,
        Array<NonNullable<typeof base.systemTools>[number]['definition']>
    >();
    for (const systemTool of base.systemTools ?? []) {
        if (!systemTool.pluginId) continue;
        const existing = systemToolsByPluginId.get(systemTool.pluginId) ?? [];
        systemToolsByPluginId.set(systemTool.pluginId, [...existing, systemTool.definition]);
    }
    let registeredAgentRuntimeCatalogHooksProjected = false;
    const agents = base.agents.map((agent) => {
        const runtime = activated.agentRuntimesByAgentId.get(agent.id);
        const agentPluginId = agent.identity?.pluginId ?? agent.pluginId;
        if (
            (!runtime?.daemonSpawnHooks
                && !runtime?.providerCliAttach
                && !runtime?.cliSessionCommand
                && !runtime?.cliAuth
                && !runtime?.connectedAccountLaunch
                && !runtime?.preflightSessionControls
                && !runtime?.terminalPromptSubmitVerification
                && !runtime?.sessionStartup
                && !runtime?.vendorResumeSupport)
            || !agent.catalogEntry
            || agentPluginId !== runtime.pluginId
            || !runtime.isCurrent()
            || !isPluginRuntimeCurrent(runtime.pluginId)
            || !activated.activatedPluginIds.has(runtime.pluginId)
        ) {
            return agent;
        }
        if (runtime.daemonSpawnHooks && agent.catalogEntry.getDaemonSpawnHooks) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered daemon spawn hook owners`,
            );
        }
        if (runtime.providerCliAttach && agent.catalogEntry.resolveHostAgentRuntimeSurfaces) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered provider CLI attach owners`,
            );
        }
        if (runtime.sessionStartup && agent.catalogEntry.shouldUseDeferredSessionStartup) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered deferred startup owners`,
            );
        }
        if (runtime.vendorResumeSupport && agent.catalogEntry.getVendorResumeSupport) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered vendor resume owners`,
            );
        }
        if (
            runtime.connectedAccountLaunch
            && (
                agent.catalogEntry.connectedAccountRequestAuthUses
                || agent.catalogEntry.connectedAccountFileEnvironmentUses
                || agent.catalogEntry.connectedAccountEnvironmentUses
                || agent.catalogEntry.connectedAccountSwitchContinuity
                || agent.catalogEntry.getConnectedServiceStateSharingDescriptor
                || agent.catalogEntry.getConnectedServiceRuntimeAuthAdapter
                || agent.catalogEntry.verifyResumeReachable
            )
        ) {
            throw new Error(
                `Agent '${agent.id}' has competing private and activation-registered connected-account launch owners`,
            );
        }
        const switchContinuity = runtime.connectedAccountLaunch?.switchContinuity;
        if (switchContinuity) {
            const declaredServiceIds = agent.catalogEntry.connectedAccountServiceIds ?? [];
            if (declaredServiceIds.length === 0) {
                throw new Error(
                    `Agent '${agent.id}' registers connected-account switch continuity without a manifest-owned Connected Account service`,
                );
            }
            const undeclaredStateSharingServiceId =
                switchContinuity.providerStateSharingRequired?.serviceIds?.find(
                    (serviceId) => !declaredServiceIds.includes(
                        buildQualifiedPluginContributionKey({
                            pluginId: agentPluginId,
                            localId: serviceId,
                        }),
                    ),
                );
            if (undeclaredStateSharingServiceId) {
                throw new Error(
                    `Agent '${agent.id}' connected-account switch continuity requires undeclared service '${undeclaredStateSharingServiceId}'`,
                );
            }
        }
        if (runtime.preflightSessionControls && agent.catalogEntry.getPreflightSessionControlsProbeAdapter) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered preflight probe owners`,
            );
        }
        if (
            runtime.terminalPromptSubmitVerification
            && agent.catalogEntry.getTerminalPromptSubmitVerificationPolicy
        ) {
            throw new Error(
                `Agent '${agent.id}' has competing private and activation-registered terminal prompt owners`,
            );
        }
        registeredAgentRuntimeCatalogHooksProjected = true;
        return Object.freeze({
            ...agent,
            catalogEntry: Object.freeze({
                ...agent.catalogEntry,
                ...(runtime.daemonSpawnHooks
                    ? projectAgentDaemonSpawnHooksCatalogEntry(runtime.daemonSpawnHooks)
                    : {}),
                ...(runtime.providerCliAttach
                    ? projectAgentProviderCliAttachCatalogEntry({
                        agentId: agent.id,
                        pluginId: runtime.pluginId,
                        localAgentId: runtime.localAgentId,
                        providerCliAttach: runtime.providerCliAttach,
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        ...(resolveAgentPluginSettings
                            ? {
                                resolvePluginSettings: () => resolveAgentPluginSettings({
                                    pluginId: runtime.pluginId,
                                    localAgentId: runtime.localAgentId,
                                }),
                            }
                            : {}),
                        ...(resolveManagedServiceSessionBaseUrl
                            ? { resolveManagedServiceSessionBaseUrl }
                            : {}),
                        ...(resolveManagedServiceSessionClientAccess
                            ? { resolveManagedServiceSessionClientAccess }
                            : {}),
                    })
                    : {}),
                ...(runtime.cliSessionCommand
                    ? projectAgentCliSessionCommandCatalogEntry({
                        agentId: agent.id,
                        cliSessionCommand: runtime.cliSessionCommand,
                        isCurrent: runtime.isCurrent,
                        ...(resolveAgentPluginSettings
                            ? {
                                resolvePluginSettings: () => resolveAgentPluginSettings({
                                    pluginId: runtime.pluginId,
                                    localAgentId: runtime.localAgentId,
                                }),
                            }
                            : {}),
                    })
                    : {}),
                ...(runtime.cliAuth && agent.cliMetadata
                    ? projectAgentCliAuthCatalogEntry({
                        agentId: agent.id,
                        pluginId: runtime.pluginId,
                        cliAuth: runtime.cliAuth,
                        cli: agent.cliMetadata,
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        hostAccess: agent.hostAccess,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.connectedAccountLaunch
                    ? projectAgentConnectedAccountLaunchCatalogEntry({
                        pluginId: runtime.pluginId,
                        agentId: agent.id,
                        connectedAccountLaunch: runtime.connectedAccountLaunch,
                        hostAccess: agent.hostAccess,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.preflightSessionControls
                    ? projectAgentPreflightSessionControlsCatalogEntry({
                        agentId: agent.id,
                        preflightSessionControls: runtime.preflightSessionControls,
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        retirementSignal: runtime.retirementSignal,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.terminalPromptSubmitVerification
                    ? projectAgentTerminalPromptSubmitVerificationCatalogEntry({
                        terminalPromptSubmitVerification: runtime.terminalPromptSubmitVerification,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.sessionStartup
                    ? projectAgentSessionStartupCatalogEntry({
                        sessionStartup: runtime.sessionStartup,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.vendorResumeSupport
                    ? projectAgentExperimentalVendorResumeSupportCatalogEntry({
                        vendorResumeSupport: runtime.vendorResumeSupport,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
            }),
        });
    });

    if (
        activatedActions.length === 0
        && activatedTools.length === 0
        && activatedCommands.length === 0
        && providerRuntimeRegistrations.length === 0
        && !registeredAgentRuntimeCatalogHooksProjected
    ) {
        return withCurrentDeclarativeSources(base.activationTargets === activationTargets
            ? base
            : Object.freeze({ ...base, activationTargets }));
    }

    return withCurrentDeclarativeSources(createResolvedContributionRegistry({
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
        agents: registeredAgentRuntimeCatalogHooksProjected
            ? Object.freeze(agents)
            : base.agents,
        providers,
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            base.pluginDiagnosticsByPluginId,
            projectedProviders.diagnosticsByPluginId,
        ),
    }));
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
        if (!committedGeneration.record) {
            throw new Error(
                `Committed resource activation generation record is unavailable for '${pluginId}'`,
            );
        }
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

/**
 * The two process-owned boundaries every plugin HTTP request finally crosses:
 * the DNS answer that admits an origin, and the socket that must connect to
 * exactly that answer. They travel together because pinning is only meaningful
 * for the addresses the admission decision validated, and a composed host that
 * substitutes one without the other would still leave the machine.
 */
export type PluginRuntimeNetworkDependencies = Readonly<{
    resolveNetworkAddresses?: PluginNetworkAddressResolver;
}> & GlobalFetchRuntimeDependencies;

export type PluginRuntimeMachineAdmissionTransport = CliActionMachineAdmissionTransport;

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{
        happyHomeDir?: string;
        /** The daemon start owner's absolute readiness deadline; absent on reload. */
        startupDeadlineAtMs?: number;
        contributes?: ResolvedContributionRegistry;
        generation?: number;
        /** Daemon-owned live machine identity for host-stamped nested Action callers. */
        resolveCurrentMachineId?: () => string | null;
        executeClientAction?: ClientContributedActionExecutor;
        /** Existing authenticated Machine admission authority for protected Session input. */
        machineAdmissionTransport?: PluginRuntimeMachineAdmissionTransport;
        /** Existing daemon-local transfer carrier for host-authored media bytes. */
        resolveComposerMediaStageTransferRpcHandler?: () => RpcHandlerInvoker | null;
        /** Fresh server/machine identity; never a retained feature snapshot. */
        resolveCurrentMachineExecutionOriginContext?: (
            signal?: AbortSignal,
        ) => Promise<CurrentMachineExecutionOriginContext | null>;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        pluginIds?: readonly string[];
        generationAuthority?: PluginRuntimeGenerationAuthority;
        resolveDevelopmentSourceAuthority?: Parameters<
            typeof createBundledActivationSourceResolver
        >[0]['resolveDevelopmentSourceAuthority'];
        preparedActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginActivationGraph>;
        preparedDevelopmentActivationGraphsByPluginId?: ReadonlyMap<
            string,
            PreparedPluginDevelopmentActivationGraph
        >;
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
        /**
         * The serving occurrence of every unchanged admitted plugin, from the
         * runtime owner's slot map. A successor keeps these identities even
         * for a plugin that has no activation component to retain yet.
         */
        servingPluginOccurrences?: ReadonlyMap<string, PluginRuntimeSlotOccurrence>;
        preparedActivationRegistryLeases?: readonly PluginRuntimeActivationRegistryLease[];
        recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
        stableEventsBroker?: import('./invocation/services/events').StablePluginEventsBroker;
        runtimeActionExecute?: RuntimeActionExecute;
        /**
         * Exact host-admitted Action authority for a scoped executable registry.
         * When present, every nested plugin Action uses this credential/policy
         * pair and this registry never consults ambient CLI Account storage.
         */
        scopedActionRuntime?: Readonly<{
            credentials: StoredCredentials | null;
            actionsSettingsProvider: RuntimeActionSettingsProvider;
        }>;
        /** Controller-lifetime target-local observer owner; never generation-local. */
        targetedContributions?: StableTargetedContributionsOwner;
        managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
        resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver;
        resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver;
        externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
        resolveExternalSessionCurrentMachineId?: () => string | null;
        externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
        externalSessionsActiveServerDir?: string;
        externalSessionsActiveServerId?: string;
        /**
         * Daemon/controller-lifetime public current-global External Sessions
         * router. Production registry construction always provides it. A
         * registry without the controller router has no public External
         * Sessions authority; it must never silently target itself.
         */
        currentGlobalExternalSessionsRouter?: CurrentGlobalExternalSessionsRouter;
        /** Invalidates projections after a same-generation lazy activation fails terminally. */
        onTerminalActivationFailure?: (pluginId: string) => void;
        /** Process-owned network boundaries for this registry's one plugin HTTP host. */
        networkDependencies?: PluginRuntimeNetworkDependencies;
        /** Testable port for the canonical Account plugin-settings persistence owner. */
        accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? 0;
    const scopedActionRuntime = params?.scopedActionRuntime;
    const readSessionCredentials = scopedActionRuntime
        ? async () => scopedActionRuntime.credentials
        : readStoredCredentials;
    const accountCredentialAuthority = scopedActionRuntime
        ? Object.freeze({
            readCredentials: readSessionCredentials,
            actionsSettingsProvider: scopedActionRuntime.actionsSettingsProvider,
        })
        : undefined;
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
    const committed = params?.generationAuthority ?? await readCurrentCommittedPluginGenerations(
        pluginStorePaths,
        {
            isolateInvalidInstalledGenerations: true,
        },
    );
    const committedImmutableGenerationIdsByPluginId = new Map(
        [...(committed?.generations.entries() ?? [])].map(([pluginId, admitted]) => [
            pluginId,
            admitted.immutableGenerationId,
        ]),
    );
    let retainedActivationRegistryLeases = [
        ...(params?.retainedActivationRegistryLeases ?? []),
    ];
    if (!params?.generationAuthority && committed?.commit) {
        try {
            const retirement = await reconcilePluginGenerationCustodyRetirement({
                paths: pluginStorePaths,
                commit: committed.commit,
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
    const packagedRuntimeRoot = resolveAuthoritativePackagedRuntimeCustody();
    const packagedActivationPaths = packagedRuntimeRoot
        ? resolvePackagedBundledActivationPaths({
            runtimeRoot: packagedRuntimeRoot.root,
            activationTargets: contributes.activationTargets.filter((target) => (
                params?.pluginIds === undefined || params.pluginIds.includes(target.pluginId)
            )),
            metadata: BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
            locators: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
        })
        : null;
    const resolveBundledActivationSource = createBundledActivationSourceResolver({
        bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
        immutableArtifactPackageNames: packagedActivationPaths
            ? [...packagedActivationPaths.entryPathsByPackageName.keys()]
            : [],
        ...(packagedActivationPaths
            ? {
                immutableArtifactEntryPathsByPackageName:
                    packagedActivationPaths.entryPathsByPackageName,
                immutableArtifactRootPathsByPackageName:
                    packagedActivationPaths.rootPathsByPackageName,
            }
            : {}),
        ...(params?.resolveDevelopmentSourceAuthority
            ? { resolveDevelopmentSourceAuthority: params.resolveDevelopmentSourceAuthority }
            : {}),
        ...(packagedRuntimeRoot
            ? {
                packagedRuntime: packagedRuntimeRoot.packagedRuntime,
            }
            : {}),
    });
    const activatedManifestAuthorityByPluginId = new Map<
        string,
        'external' | 'bundled_first_party'
    >();
    const resolveCommittedActivationSource = createPluginActivationSourceResolver({
        committed,
        resolveBundledActivationSource,
        ...(params?.preparedActivationGraphsByPluginId
            ? { preparedActivationGraphsByPluginId: params.preparedActivationGraphsByPluginId }
            : {}),
        ...(params?.preparedDevelopmentActivationGraphsByPluginId
            ? { preparedDevelopmentActivationGraphsByPluginId: params.preparedDevelopmentActivationGraphsByPluginId }
            : {}),
        ...(params?.happyHomeDir !== undefined ? { happyHomeDir: params.happyHomeDir } : {}),
        activatedManifestAuthorityByPluginId,
    });
    const activationTargets = collectActivationTargets(contributes);
    const candidatePluginIds = params?.pluginIds === undefined
        ? new Set([
            ...activationTargets.map((target) => target.pluginId),
            ...contributes.agents.flatMap((agent) => agent.pluginId ? [agent.pluginId] : []),
            ...(contributes.roles ?? []).map((role) => role.pluginId),
            ...(contributes.workflows ?? []).map((workflow) => workflow.pluginId),
            ...(contributes.inputTypes ?? []).map((type) => type.pluginId),
            ...(contributes.dragSources ?? []).map((source) => source.pluginId),
            ...(contributes.dropTargets ?? []).map((target) => target.pluginId),
        ])
        : new Set([
            ...params.pluginIds,
            ...retainedActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds]),
            ...(params.servingPluginOccurrences?.keys() ?? []),
        ]);
    const candidateOccurrenceIdsByPluginId = new Map<string, PluginRuntimeOccurrenceId>();
    const admittedPluginSourceCustodiesByPluginId = new Map<string, PluginSourceCustody>();
    for (const pluginId of candidatePluginIds) {
        const target = activationTargets.find((candidate) => candidate.pluginId === pluginId);
        // A plugin this candidate no longer declares (removal) has no occurrence.
        if (!target
            && !contributes.agents.some((agent) => agent.pluginId === pluginId)
            && !(contributes.roles ?? []).some((role) => role.pluginId === pluginId)
            && !(contributes.workflows ?? []).some((workflow) => workflow.pluginId === pluginId)
            && !(contributes.inputTypes ?? []).some((type) => type.pluginId === pluginId)
            && !(contributes.dragSources ?? []).some((source) => source.pluginId === pluginId)
            && !(contributes.dropTargets ?? []).some((dropTarget) => dropTarget.pluginId === pluginId)) continue;
        const activationSource = target
            ? resolveCommittedActivationSource(target, { recordActivatedManifestAuthority: false })
            : null;
        let candidateSourceCustody = activationSource?.sourceAuthority
            ? resolvePluginSourceCustody(activationSource.sourceAuthority)
            : null;
        const admitted = committed?.generations.get(pluginId);
        if (!candidateSourceCustody && admitted?.installation?.trust) {
            candidateSourceCustody = {
                kind: 'managed',
                immutableGenerationId: admitted.immutableGenerationId,
                installSource: admitted.installation.source.distribution.kind,
            };
        }
        // A retained component keeps its occurrence unless this candidate binds
        // it to different custody. A peer the candidate does not re-source (an
        // unchanged development plugin has no prepared graph here) keeps the
        // retained component's identity.
        const retainedIdentity = retainedActivationRegistryLeases.flatMap((lease) => {
            if (!lease.pluginIds.has(pluginId)) return [];
            const occurrenceId = lease.registry.readPluginOccurrenceId(pluginId);
            const sourceCustody = lease.registry.readPluginSourceCustody(pluginId);
            return occurrenceId
                && sourceCustody
                && (!candidateSourceCustody || pluginSourceCustodyEqual(sourceCustody, candidateSourceCustody))
                ? [{ occurrenceId, sourceCustody }]
                : [];
        }).at(0) ?? (() => {
            // An unchanged plugin with no component to retain (declared but not
            // activated yet) keeps the identity its slot serves.
            if (params?.pluginIds?.includes(pluginId)) return undefined;
            const serving = params?.servingPluginOccurrences?.get(pluginId);
            if (!serving) return undefined;
            if (
                candidateSourceCustody
                && serving.sourceCustody
                && !pluginSourceCustodyEqual(serving.sourceCustody, candidateSourceCustody)
            ) return undefined;
            const sourceCustody = serving.sourceCustody ?? candidateSourceCustody;
            return sourceCustody
                ? { occurrenceId: serving.occurrenceId, sourceCustody }
                : undefined;
        })();
        candidateOccurrenceIdsByPluginId.set(
            pluginId,
            retainedIdentity?.occurrenceId ?? createPluginRuntimeOccurrenceId(pluginId),
        );
        if (retainedIdentity) {
            admittedPluginSourceCustodiesByPluginId.set(pluginId, retainedIdentity.sourceCustody);
            continue;
        }
        if (activationSource?.sourceAuthority) {
            admittedPluginSourceCustodiesByPluginId.set(
                pluginId,
                candidateSourceCustody!,
            );
            continue;
        }
        if (candidateSourceCustody) {
            admittedPluginSourceCustodiesByPluginId.set(pluginId, candidateSourceCustody);
        }
    }
    // Daemon-selected plugins with Account-scoped declarations claim a
    // release-less Account intent and execute through this machine
    // materialization; it is the same caller-materialization owner below.
    const releaseLessDeclarationsByPluginId = projectReleaseLessPluginDeclarations({
        activationTargets,
        sourceCustodiesByPluginId: admittedPluginSourceCustodiesByPluginId,
        registryMaterializationIdsByPluginId: contributes.materializationIdsByPluginId ?? {},
        observedAt: Date.now(),
    });
    contributes = createResolvedContributionRegistry({
        ...contributes,
        materializationIdsByPluginId: Object.freeze({
            ...(contributes.materializationIdsByPluginId ?? {}),
            ...Object.fromEntries([...releaseLessDeclarationsByPluginId].map(([pluginId, declaration]) => (
                [pluginId, declaration.materializationId] as const
            ))),
        }),
        // The first normalization can precede durable generation selection and
        // immutable generation selection. Re-run every targeted admission fact
        // only from this one committed manifest snapshot.
        pluginDiagnosticsByPluginId: dropTargetedContributionAdmissionDiagnostics(
            contributes.pluginDiagnosticsByPluginId,
        ),
        immutableGenerationIdsByPluginId: Object.freeze(Object.fromEntries(
            committedImmutableGenerationIdsByPluginId,
        )),
        occurrenceIdsByPluginId: Object.freeze(Object.fromEntries(
            candidateOccurrenceIdsByPluginId,
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
    // Agent CLI declarations are projected before the generation-owned
    // invocation/Settings owner is constructed. Keep this late-bound closure
    // so launch callbacks read from that one owner when they execute.
    let resolveAgentPluginSettings: (input: Readonly<{
        pluginId: string;
        localAgentId: string;
    }>) => Promise<AgentCliSessionCommandPluginSettingsV1 | null> = async () => null;
    let targetActionInvocations: ReturnType<typeof createTargetActionInvocationRegistry> | null = null;
    let disposeInvocationServiceOwners: () => Promise<void> = async () => {};
    let resolvedRuntimeRegistryOwner: ResolvedExecutablePluginRuntimeRegistry | null = null;
    // Holds `fenceTerminalActivationFailure` below, published once the
    // projections it refreshes exist. Until then this registry has nothing to
    // fence: its initial build reads the activation facts a failure already
    // wrote.
    let terminalActivationFailureFence:
        ((pluginId: string) => Promise<void>) | null = null;
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
    const activationParams: Omit<
        Parameters<typeof activatePluginRuntimeRegistry>[0],
        'pluginIds' | 'retainedRegistries' | 'adoptActivationComponent'
    > = {
        contributes,
        generation,
        ...(params?.startupDeadlineAtMs === undefined
            ? {} : { startupDeadlineAtMs: params.startupDeadlineAtMs }),
        immutableGenerationIdsByPluginId,
        occurrenceIdsByPluginId: candidateOccurrenceIdsByPluginId,
        admittedPluginSourceCustodiesByPluginId,
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
        // Route terminal activation failures through this registry's fence
        // before the host callback, so
        // no reader keeps seeing a fenced plugin's applied generation, stale
        // diagnostics, or live consumer generation.
        onTerminalActivationFailure: (pluginId: string) => {
            void terminalActivationFailureFence?.(pluginId).catch((error: unknown) => {
                logger.warn('[PLUGIN RUNTIME] Terminal activation-failure fencing failed', {
                    pluginId,
                    error: projectPluginFailureText(error),
                });
            });
            params?.onTerminalActivationFailure?.(pluginId);
        },
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
    const activationAssembly = await assemblePluginRuntimeActivation({
        activationParams,
        ...(scopedActivationPluginIds === undefined
            ? {}
            : { scopedPluginIds: scopedActivationPluginIds }),
        retainedLeases: retainedActivationRegistryLeases,
        preparedLeases: params?.preparedActivationRegistryLeases,
        disposeInvocationServices: async () => await disposeInvocationServiceOwners(),
    });
    const activatedRegistry = activationAssembly.activatedRegistry;
    const activationRegistryLease = activationAssembly.activationRegistryLease;
    const preparedActivationRegistryLeaseOwners =
        activationAssembly.preparedActivationRegistryLeaseOwners;
    retainedActivationRegistryLeases =
        activationAssembly.retainedActivationRegistryLeases;
    let resourcesOwner: Awaited<ReturnType<typeof createStablePluginResourcesOwner>> | undefined;
    const pluginOccurrenceFenceListeners =
        new Set<(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId) => void>();
    const consumerAssembly = assemblePluginRuntimeConsumers({
        activatedRegistry,
        onFencePlugin(pluginId) {
            const fencedOccurrenceId = readCurrentPluginOccurrenceId(pluginId)!;
            retireAccountLifetimePluginPermissionGrantsForPlugin(pluginId);
            resourcesOwner?.retirePlugin(pluginId);
            invocationServiceOwners.retireEphemeralStorageOccurrence(
                fencedOccurrenceId,
                pluginId,
            );
            if (!fencedOccurrenceId) return;
            for (const listener of pluginOccurrenceFenceListeners) {
                listener(pluginId, fencedOccurrenceId);
            }
        },
        retirePluginDatabases: async (pluginIds) => {
            await daemonDatabaseHost.retire(pluginIds);
        },
    });
    const authoritativeContributes = mergeActivatedContributes(
        contributes,
        activatedRegistry,
        immutableGenerationIdsByPluginId,
        (pluginId) => (
            consumerAssembly.isPluginCurrent(pluginId)
        ),
        params?.resolveManagedServiceSessionBaseUrl,
        params?.resolveManagedServiceSessionClientAccess,
        resolveAgentPluginSettings,
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
                    ...(target?.manifest.brand?.monochrome === undefined
                        ? {}
                        : { brandMonochrome: target.manifest.brand.monochrome }),
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
        contracts: scopedActionRuntime
            ? Object.freeze([])
            : (authoritativeContributes.accountCollections ?? Object.freeze([]))
                .map((entry) => entry.definition),
        ...(params?.accountStorageDependencies ?? {}),
        ...(accountCredentialAuthority
            ? {
                readCredentials: accountCredentialAuthority.readCredentials,
                isCurrentAccount: () => false,
                resolveAccountScopeKey: () => null,
                subscribeChanges: () => () => {},
            }
            : {}),
        // Collection admission and plugin-facing feature decisions consume the SAME
        // daemon snapshot resolver; the host does not keep a second one.
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
        // Bundled first-party and development/drop-in custody is selected by
        // this daemon, not by a portable Account release, so only those claim
        // a release-less Account intent with their admitted manifest.
        resolveReleaseLessDeclaration: (pluginId) => (
            scopedActionRuntime ? null : releaseLessDeclarationsByPluginId.get(pluginId)?.manifest ?? null
        ),
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
                occurrenceId: entry.occurrenceId,
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
    resourcesOwner = committed && (
        committedResourceGenerations.size > 0 || dynamicResourceProducers.length > 0
    )
        ? await createStablePluginResourcesOwner({
            ...(params?.startupDeadlineAtMs === undefined
                ? {} : { startupDeadlineAtMs: params.startupDeadlineAtMs }),
            registry: {
                resources: committedResourceContributes.flatMap((resource) => {
                    if (resource.pluginId === undefined) return [];
                    if (
                        scopedActionRuntime
                        && isDynamicPluginResourceContributionV2(resource.definition)
                        && (resource.definition.hostAccess?.length ?? 0) > 0
                    ) return [];
                    const generation = committed?.generations.get(resource.pluginId);
                    if (!generation && !isDynamicPluginResourceContributionV2(resource.definition)) return [];
                    if (!hasCommittedResourceActivationTarget(resource.pluginId)) {
                        throw new Error(`Committed resource activation target is unavailable for '${resource.pluginId}'`);
                    }
                    const target = resolveCanonicalResourceActivationTarget(resource.pluginId)!;
                    return [Object.freeze({
                        ...resource,
                        pluginRootPath: generation?.rootPath ?? dirname(target.manifestPath),
                    })];
                }),
            },
            generations: committedResourceGenerations,
            dynamicOccurrenceIdsByPluginId: new Map(
                committedResourceContributes.flatMap((resource) => {
                    if (
                        resource.pluginId === undefined
                        || !isDynamicPluginResourceContributionV2(resource.definition)
                    ) return [];
                    const occurrenceId = activatedRegistry.readPluginOccurrenceId(resource.pluginId);
                    return occurrenceId ? [[resource.pluginId, occurrenceId] as const] : [];
                }),
            ),
            isDynamicOccurrenceCurrent: (pluginId, occurrenceId) => (
                activatedRegistry.isPluginOccurrenceCurrent(
                    pluginId,
                    occurrenceId as PluginRuntimeOccurrenceId,
                )
            ),
            dynamicProducers: scopedActionRuntime
                ? dynamicResourceProducers.filter((producer) => (
                    producer.hostAccessRequests.length === 0
                ))
                : dynamicResourceProducers,
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
    const resolveRuntimeConsumerLifecycle = consumerAssembly.resolveLifecycle;
    const isPluginConsumerCurrent = consumerAssembly.isPluginCurrent;
    const readCurrentPluginOccurrenceId = consumerAssembly.readPluginOccurrenceId;
    const isCurrentPluginOccurrence = (pluginId: string, occurrenceId: string): boolean => (
        readCurrentPluginOccurrenceId(pluginId) === occurrenceId
    );
    const readCurrentPluginSourceCustody = consumerAssembly.readPluginSourceCustody;
    const captureCurrentPluginOccurrence = (
        pluginId: string,
    ): Readonly<{
        occurrenceId: PluginRuntimeOccurrenceId;
        sourceCustody: PluginSourceCustody;
    }> | null => {
        if (
            !isPluginConsumerCurrent(pluginId)
            || !activatedRegistry.activatedPluginIds.has(pluginId)
        ) return null;
        const occurrenceId = readCurrentPluginOccurrenceId(pluginId);
        if (!occurrenceId) return null;
        const sourceCustody = readCurrentPluginSourceCustody(pluginId);
        if (
            !sourceCustody
            || !isCurrentPluginOccurrence(pluginId, occurrenceId)
        ) return null;
        return Object.freeze({ occurrenceId, sourceCustody });
    };
    const isCapturedPluginOccurrenceCurrent = (input: Readonly<{
        pluginId: string;
        occurrenceId: PluginRuntimeOccurrenceId;
    }>): boolean => isPluginConsumerCurrent(input.pluginId)
        && isCurrentPluginOccurrence(input.pluginId, input.occurrenceId);
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
            && isCurrentPluginOccurrence(entry.pluginId, entry.occurrenceId)
            && entry.registration.localId === mediator.contributionLocalId
        ));
        return registered ? materialization : null;
    };
    const revalidatePluginActionCallerMaterialization = async (
        candidate: PluginMachineMaterializationRefV1,
    ): Promise<boolean> => {
        const current = resolveCurrentPluginMaterializationRef(candidate.pluginId);
        return current !== null && arePluginMachineMaterializationRefsEqual(current, candidate);
    };
    const revalidatePluginActionCallerOccurrence = async (
        candidate: Readonly<{ pluginId: string; occurrenceId: string }>,
    ): Promise<boolean> => isCurrentPluginOccurrence(
        candidate.pluginId,
        candidate.occurrenceId as PluginRuntimeOccurrenceId,
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
            || !arePluginMachineMaterializationRefsEqual(beforeMaterialization, afterMaterialization)
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
    const resolveCurrentPluginApprovalReplayPlacement = async (
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<TargetActionApprovalReplayPlacementV1 | null> => {
        signal?.throwIfAborted();
        if (!params?.resolveCurrentMachineExecutionOriginContext) return null;
        const captured = captureCurrentPluginOccurrence(pluginId);
        if (!captured) return null;
        let context: CurrentMachineExecutionOriginContext | null;
        try {
            context = await params.resolveCurrentMachineExecutionOriginContext(signal);
        } catch {
            return null;
        }
        signal?.throwIfAborted();
        if (
            !context
            || !isCapturedPluginOccurrenceCurrent({
                pluginId,
                occurrenceId: captured.occurrenceId,
            })
        ) return null;
        const placement = TargetActionApprovalReplayPlacementV1Schema.safeParse({
            serverId: context.serverIdentityId,
            machineId: context.machineId,
        });
        return placement.success ? Object.freeze({ ...placement.data }) : null;
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
        && arePluginMachineMaterializationRefsEqual(left.materializationRef, right.materializationRef)
    );
    const resolveCollectionCandidateModuleCacheKey = (
        source: PluginActivationSource<PluginDaemonModuleNamespace>,
    ): string | undefined => {
        if (source.kind !== 'bundled' || !source.sourceAuthority) return undefined;
        switch (source.sourceAuthority.kind) {
            case 'managed':
                return `managed:${source.sourceAuthority.immutableGenerationId}`;
            case 'bundled_first_party':
                return `packaged-runtime:${JSON.stringify(source.sourceAuthority.packagedRuntime)}`;
            case 'development':
                return [
                    'development',
                    source.sourceAuthority.registeredRootId,
                    source.sourceAuthority.observedRevision,
                ].join(':');
        }
    };
    const resolveExactCurrentCollectionMigrationArtifactDigest = (input: Readonly<{
        pluginId: string;
        releaseVersion: string;
        artifactDigest: PluginUiArtifactDigestV1;
    }>): PluginUiArtifactDigestV1 | null => {
        const matches = collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners(authoritativeContributes)
            .flatMap((owner) => {
                if (
                    owner.pluginId !== input.pluginId
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
        const captured = captureCurrentPluginOccurrence(pluginId);
        if (!captured) return unavailable('candidate_currentness_changed');
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
                const currentOrigin = await resolveCurrentPluginExecutionOrigin(pluginId, input.signal);
                return !input.signal.aborted
                    && isCapturedPluginOccurrenceCurrent({
                        pluginId,
                        occurrenceId: captured.occurrenceId,
                    })
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
            const sourceCustody = source.sourceAuthority
                ? resolvePluginSourceCustody(source.sourceAuthority)
                : null;
            if (
                !sourceCustody
                || !pluginSourceCustodyEqual(sourceCustody, captured.sourceCustody)
            ) return unavailable('candidate_currentness_changed');
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
            const cacheKey = resolveCollectionCandidateModuleCacheKey(source);
            const module = await loadPluginModule({
                source,
                ...(cacheKey ? { cacheKey } : {}),
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
                    isOccurrenceCurrent: isCandidateCurrent,
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
            resources: resourcesOwner,
            isPluginConsumerCurrent,
            readPluginOccurrenceId: (pluginId) => readCurrentPluginOccurrenceId(pluginId),
            ...(params?.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        })
        : undefined;
    const composePluginConsumerSignal = consumerAssembly.composeSignal;
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
                occurrenceId: readCurrentPluginOccurrenceId(pluginId)!,
                signal: lifecycle.retirementSignal,
                isOccurrenceCurrent: lifecycle.isCurrent,
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
    const fencePluginConsumers = (pluginIds: readonly string[]): void => {
        consumerAssembly.fencePlugins(pluginIds);
        uiResourceWatches?.retirePlugins(pluginIds);
    };
    const retirePluginConsumers = consumerAssembly.retirePlugins;
    const buildPromptAssetAdapterRegistry = () => createTargetPromptAssetAdapterRegistry({
        promptAssets: (authoritativeContributes.promptAssets ?? []).map((asset) => Object.freeze({
            pluginId: asset.pluginId,
            localId: asset.definition.id,
            ...(asset.definition.adapterDescriptor
                ? { adapterDescriptor: asset.definition.adapterDescriptor }
                : {}),
        })),
        targetRegistrations: activatedRegistry.targetRegistrations,
        resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
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
    const createAgentInvocationServices: CreateAgentInvocationServices = async (
        agentParams,
    ) => {
        if (!resolvedRuntimeRegistryOwner) {
            throw new Error(
                'Executable plugin runtime registry is not ready for Agent invocation',
            );
        }
        return await resolvedRuntimeRegistryOwner
            .createAgentInvocationServices(agentParams);
    };
    const buildAgentRuntimeRegistry = () => createDeclarativeAcpAgentRuntimeRegistry({
        // A cold manifest declaration becomes executable only after this
        // registry admitted its ordinary plugin slot. This also keeps a
        // deliberately scoped registry from synthesizing runtimes for
        // unrelated manifests that have no occurrence in the scope.
        agents: authoritativeContributes.agents.filter((agent) => (
            !agent.pluginId || readCurrentPluginOccurrenceId(agent.pluginId) !== null
        )),
        registered: createTargetAgentRuntimeRegistry({
            agents: authoritativeContributes.agents,
            activationTargets: collectActivationTargets(authoritativeContributes),
            targetRegistrations: activatedRegistry.targetRegistrations,
            immutableGenerationIdsByPluginId,
            readPluginOccurrenceId: readCurrentPluginOccurrenceId,
            readPluginSourceCustody: readCurrentPluginSourceCustody,
            isOccurrenceCurrent: consumerAssembly.isOccurrenceCurrent,
            resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
            createAgentInvocationServices,
            ...(params?.managedEndpointRead
                ? { managedEndpointRead: params.managedEndpointRead }
                : {}),
            onDuplicate() {
                // Each component activation validates its registrations against
                // the complete authoritative Agent graph and owns diagnostics.
            },
        }),
        immutableGenerationIdsByPluginId,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        isOccurrenceCurrent: consumerAssembly.isOccurrenceCurrent,
        resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
        createAgentInvocationServices,
    });
    const agentRuntimesByAgentId = buildAgentRuntimeRegistry();
    const refreshAgentRuntimeRegistry = (): void => {
        const next = buildAgentRuntimeRegistry();
        agentRuntimesByAgentId.clear();
        for (const [agentId, lease] of next) {
            agentRuntimesByAgentId.set(agentId, lease);
        }
    };
    const sessionCredentials = await readSessionCredentials();
    const configuredExternalSessionAgentDemands = scopedActionRuntime
        ? Object.freeze([])
        : Object.freeze(
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
        agents: readonly Readonly<{
            agentId: string;
            pluginId: string | null;
            identity: PluginContributionIdentityV1 | null;
            externalSessionDefinition: unknown;
            occurrenceId: string;
            sourceCustody: PluginSourceCustody;
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
        if (scopedActionRuntime) return;
        if (!sessionCredentials) return;
        const activeAgents = authoritativeContributes.agents.flatMap((agent) => {
            const lease = agentRuntimesByAgentId.get(agent.id);
            if (
                !lease?.externalSessions
                || !lease.sourceCustody
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
            refreshExternalSessionProjectionDiagnostics(
                Object.freeze([]),
                Object.freeze([]),
            );
            return;
        }
        const agents = Object.freeze(activeAgents.map(({ agent }) => agent));
        // Account revisions are owned by the live configured-source materializer
        // within this service. Rebuilding here would create a second Account
        // lifecycle owner and unnecessarily retire active author operations.
        const publicationBasis: CurrentGlobalExternalSessionsPublicationBasis = Object.freeze({
            agents: Object.freeze(activeAgents.flatMap(({ agent, lease }) => {
                const sourceCustody = lease.sourceCustody;
                if (!sourceCustody) return [];
                return [Object.freeze({
                agentId: agent.id,
                pluginId: agent.pluginId ?? null,
                identity: agent.identity ?? null,
                externalSessionDefinition:
                    agent.richDefinition?.definition.surfaces?.externalSession ?? null,
                occurrenceId: lease.occurrenceId,
                sourceCustody,
                })];
            })),
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
                agents,
                ...(params?.externalSessionsActiveServerDir
                    ? { activeServerDir: params.externalSessionsActiveServerDir }
                    : {}),
                ...(params?.externalSessionsActiveServerId
                    ? { activeServerId: params.externalSessionsActiveServerId }
                    : {}),
                readCredentials: readSessionCredentials,
                resolveMachineId: () =>
                    params?.resolveExternalSessionCurrentMachineId?.() ?? null,
                resolveAgentRuntime(agentId) {
                    const lease = agentRuntimesByAgentId.get(agentId);
                    if (!lease?.externalSessions || !lease.sourceCustody || !lease.isCurrent()) return null;
                    const agent = agents.find((candidate) => candidate.id === agentId);
                    const writerSafety = agent?.richDefinition?.definition
                        .surfaces?.externalSession.externalLinkedTakeover?.writerSafety
                        ?? 'unsupported';
                    return Object.freeze({
                        occurrenceId: lease.occurrenceId,
                        sourceCustody: lease.sourceCustody,
                        retirementSignal: lease.retirementSignal,
                        isCurrent: lease.isCurrent,
                        surface: createAgentExternalSessionsExecutionSurface(
                            lease.externalSessions,
                            writerSafety,
                            // Both takeover storage modes resolve their
                            // post-admission launch through this exact
                            // generation's takeover contribution, so the
                            // capability projection may only advertise what
                            // this lease admitted.
                            Boolean(lease.externalSessionTakeover),
                        ),
                    });
                },
                ...(params?.externalSessionHostOperationOwner
                    ? {
                        externalSessionHostOperationOwner:
                            params.externalSessionHostOperationOwner,
                    }
                    : {}),
                onSourceRefusalsChanged: (refusals) => {
                    refreshExternalSessionProjectionDiagnostics(agents, refusals);
                },
                isCurrent: consumerAssembly.isOccurrenceCurrent,
            });
            currentGlobalExternalSessions = next;
            currentGlobalExternalSessionsPublicationBasis = publicationBasis;
            refreshExternalSessionProjectionDiagnostics(agents, next.sourceRefusals);
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
            refreshExternalSessionProjectionDiagnostics(
                Object.freeze([]),
                Object.freeze([]),
            );
            logger.warn(
                '[PLUGIN RUNTIME] Current-global External Sessions service is unavailable',
                {
                    agentOccurrences: publicationBasis.agents.map((agent) => ({
                        agentId: agent.agentId,
                        occurrenceId: agent.occurrenceId,
                    })),
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
            readPublicCallerAccess: (caller) => {
                const target = resolveExactActivationTarget(caller.pluginId);
                const hostAccessRequests = target
                    ? resolveManifestHostAccessRequestsForQualifiedContribution({
                        manifest: target.manifest,
                        pluginId: target.pluginId,
                        contribution: caller.contribution,
                    })
                    : null;
                if (!target || !hostAccessRequests) {
                    return { status: 'unavailable' };
                }
                const policy = invocationServiceOwners
                    .resolveInvocationHostPolicy({
                        pluginId: target.pluginId,
                        occurrenceId: readCurrentPluginOccurrenceId(target.pluginId)!,
                        qualifiedId: caller.contribution.qualifiedId,
                    }, {
                        hostAccessRequests,
                        surface: caller.surface,
                        ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
                    });
                if (policy.serviceBinding.availability.sessions === 'denied') {
                    return { status: 'denied' };
                }
                if (policy.serviceBinding.availability.sessions !== 'available') {
                    return { status: 'unavailable' };
                }
                // Preserve the resolved Session scopes instead of collapsing
                // them to availability: the author binding enforces the
                // ratified read/control mapping against them, with
                // machine/project restrictions applied against host context.
                return {
                    status: 'available',
                    scopes: resolveHostApplicableExternalSessionsPublicScopes({
                        scopes: policy.serviceBinding.sessionScopes
                            ?? Object.freeze([]),
                        resolveCurrentMachineId: () =>
                            params?.resolveExternalSessionCurrentMachineId?.() ?? null,
                    }),
                };
            },
        });
    const publicCurrentGlobalExternalSessions = scopedActionRuntime
        ? undefined
        : params?.currentGlobalExternalSessionsRouter;
    /**
     * The public External Sessions service has one router binding regardless of
     * whether it came from an ordinary SDK context or a retained Runner. The
     * caller's generation remains a hard-revocation boundary, while source
     * choice and HostAccess are deliberately re-read from the current global
     * owner by each service method.
    */
    const bindCurrentGlobalExternalSessionsForPublicCaller = (input: Readonly<{
        pluginId: string;
        contribution: Readonly<{
            id: string;
            qualifiedId: string;
        }>;
        surface: string;
        sessionId?: string;
        signal: AbortSignal;
        isOccurrenceCurrent(): boolean;
    }>) => createCurrentGlobalExternalSessionsAuthorBinding({
        pluginId: input.pluginId,
        signal: input.signal,
        isOccurrenceCurrent: input.isOccurrenceCurrent,
        ...(params?.externalSessionsActiveServerDir
            ? { activeServerDir: params.externalSessionsActiveServerDir }
            : {}),
        ...(params?.externalSessionPluginAdmissionOwner?.takeoverStart
            ? {
                takeoverStart:
                    params.externalSessionPluginAdmissionOwner.takeoverStart,
            }
            : {}),
        resolveCurrent: () =>
            publicCurrentGlobalExternalSessions?.resolveCurrent() ?? null,
        activateConfiguredSources: async (agentId) =>
            await publicCurrentGlobalExternalSessions
                ?.activateConfiguredSources(agentId),
        readCurrentPublicAccess: () =>
            publicCurrentGlobalExternalSessions
                ?.readPublicCallerAccess?.({
                    pluginId: input.pluginId,
                    contribution: input.contribution,
                    surface: input.surface,
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                }) ?? { status: 'unavailable' },
    });
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
        const occurrenceId = readCurrentPluginOccurrenceId(contextParams.ref.pluginId);
        const sourceCustody = readCurrentPluginSourceCustody(contextParams.ref.pluginId);
        if (!occurrenceId || !sourceCustody) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin runtime identity is unavailable',
            });
        }
        const runtimeSeed = Object.freeze({
            plugin: Object.freeze({ id: contextParams.ref.pluginId, version: contextParams.pluginVersion }),
            contribution: Object.freeze({
                id: contextParams.ref.localId,
                qualifiedId: `${contextParams.ref.pluginId}/${contextParams.family}/${contextParams.ref.localId}`,
            }),
            occurrenceId,
            sourceCustody,
            correlationId: randomUUID(),
            surface: 'mcp' as const,
            ...(contextParams.callerSeed.session ? { session: contextParams.callerSeed.session } : {}),
            ...(contextParams.callerSeed.currentSession
                ? { currentSession: contextParams.callerSeed.currentSession }
                : {}),
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isOccurrenceCurrent: () => (
                contextParams.callerSeed.isOccurrenceCurrent()
                && isCurrentPluginOccurrence(contextParams.ref.pluginId, occurrenceId)
                && activatedRegistry.targetRegistrations.includes(contextParams.entry)
            ),
        });
        const presentationOwner = runtimeSeed.session
            && runtimeSeed.currentSession
            && immutableGenerationId
            ? createHostSessionPresentationOwner({
                pluginId: runtimeSeed.plugin.id,
                contributionId: runtimeSeed.contribution.id,
                generationId: immutableGenerationId,
                invocationId: runtimeSeed.correlationId,
            })
            : undefined;
        try {
            const serviceBinding = addMcpAvailablePluginInvocationServiceBinding(
                invocationServiceOwners.createOrdinaryServiceBinding(
                    occurrenceId,
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
                    invokedAtMs: lifetime.invokedAtMs,
                    ...(runtimeSeed.session ? { session: runtimeSeed.session } : {}),
                    signal: runtimeSeed.signal,
                    services,
                    ui: createPluginInvocationPresentation({
                        currentSession: runtimeSeed.session ? runtimeSeed.currentSession ?? null : null,
                        signal: runtimeSeed.signal,
                        isOccurrenceCurrent: runtimeSeed.isOccurrenceCurrent,
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
                && isCurrentPluginOccurrence(candidate.pluginId, candidate.occurrenceId)
                && candidate.registration.family === 'mcp.servers'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'mcp.servers') return null;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === ref.pluginId
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) return null;
            const runtime = entry.registration.value;
            return Object.freeze({
                occurrenceId: entry.occurrenceId,
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
                && isCurrentPluginOccurrence(candidate.pluginId, candidate.occurrenceId)
                && candidate.registration.family === 'mcp.discoverySources'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'mcp.discoverySources') return null;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === ref.pluginId
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) return null;
            const discover = entry.registration.value;
            return Object.freeze({
                occurrenceId: entry.occurrenceId,
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
        adapter: createGlobalFetchRuntime(
            params?.networkDependencies?.openPinnedStream
                ? { openPinnedStream: params.networkDependencies.openPinnedStream }
                : {},
        ),
        ...(params?.networkDependencies?.resolveNetworkAddresses
            ? { resolveNetworkAddresses: params.networkDependencies.resolveNetworkAddresses }
            : {}),
        redactInterceptorText({ seed, value }) {
            return invocationServiceOwners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                occurrenceId: seed.occurrenceId,
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
        isCurrent: consumerAssembly.isOccurrenceCurrent,
        // V2 request semantics remain source-model owned. Complete managed
        // PyPI sources also project through the same installables descriptor
        // owner used by capability/UI installation.
        installablesRegistry: resolveExecutableManagedDependenciesRegistry(
            authoritativeContributes.managedDependencies ?? Object.freeze([]),
        ),
        sourceModel: managedDependencySourceModel,
        immutableGenerationIdsByPluginId:
            committedImmutableGenerationIdsByPluginId,
        sourceCustodiesByPluginId: new Map(
            // Source declarations are admitted before their runtime is demanded.
            // Retention must include those owners even while they remain inactive.
            [...new Set(managedDependencySourceModel.snapshot().dependencies.map(
                (dependency) => dependency.identity.pluginId,
            ))].flatMap((pluginId) => {
                const sourceCustody = readCurrentPluginSourceCustody(pluginId);
                return sourceCustody ? [[pluginId, sourceCustody] as const] : [];
            }),
        ),
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
        async resolvePackagedRuntimeBinary(ref, context) {
            const provider = (authoritativeContributes.providers ?? []).find(
                (candidate) => (
                    candidate.identity.pluginId === context.pluginId
                    && candidate.identity.localId === context.providerLocalId
                ),
            );
            let command: string | null = null;
            if (provider?.provenance === 'external') {
                const generation = committed?.generations.get(context.pluginId);
                if (committed && generation?.installation) {
                    command = await resolveCurrentInstalledPluginGenerationRuntimeExecutable({
                        executable: ref,
                        rootPath: generation.rootPath,
                        files: generation.record.files,
                        isCurrent: async () => {
                            try {
                                return context.isCurrent()
                                    && isPluginConsumerCurrent(context.pluginId)
                                    && await committed.isCurrent()
                                    && context.isCurrent()
                                    && isPluginConsumerCurrent(context.pluginId);
                            } catch {
                                return false;
                            }
                        },
                    });
                }
            } else if (provider?.provenance === 'first_party') {
                command = await resolveManagedProviderRuntimeExecutable(ref);
            }
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
                occurrenceId: scope.occurrenceId,
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
                && seed.isOccurrenceCurrent(),
            );
            if (
                seed.pluginId.trim().length === 0
                || !seed.contributionQualifiedId.startsWith(
                    `${seed.pluginId}/`,
                )
                || (
                    !retainedManagedProviderScope
                    && (
                        seed.occurrenceId
                            !== readCurrentPluginOccurrenceId(seed.pluginId)
                        || !isPluginConsumerCurrent(seed.pluginId)
                        || !seed.isOccurrenceCurrent()
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
    const automationAssembly = await assembleAutomationRuntime({
        credentials: sessionCredentials,
        activationTargets: authoritativeContributes.activationTargets,
        activatedPluginIds: activatedRegistry.activatedPluginIds,
        resolveCurrentMaterialization: resolveCurrentPluginMaterializationRef,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        resolveConsumerLifecycle: resolveRuntimeConsumerLifecycle,
        revalidateCallerMaterialization: revalidatePluginActionCallerMaterialization,
        revalidateCallerOccurrence: revalidatePluginActionCallerOccurrence,
    });
    const automationEventAdoptedDefinitionOwners =
        automationAssembly.adoptedDefinitionOwners;
    const resolveAutomationEventAdoptedDefinitionSet =
        automationAssembly.resolveAdoptedDefinitionSet;
    const resolveAutomationEventHistoryGapSource =
        automationAssembly.resolveHistoryGapSource;
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
            ...(request.requiredDangerLevel ? { requiredDangerLevel: request.requiredDangerLevel } : {}),
            ...(params?.scopedActionRuntime
                ? {
                    actionsSettings:
                        params.scopedActionRuntime.actionsSettingsProvider.getActionsSettings(),
                }
                : {}),
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
                ...(request.initiatingActionCaller ? { initiatingActionCaller: request.initiatingActionCaller } : {}),
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
            readCredentials: readSessionCredentials,
            ...(params?.scopedActionRuntime
                ? { actionsSettingsProvider: params.scopedActionRuntime.actionsSettingsProvider }
                : {}),
            ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
            ...(params?.machineAdmissionTransport
                ? { machineAdmissionTransport: params.machineAdmissionTransport }
                : {}),
            readRegisteredPromptAssetAdapters: () => promptAssetAdapters,
            resolvePluginNotifications: () => invocationServiceOwners.notifications,
            revalidatePluginActionCallerMaterialization,
            invokeContributedAction: createHostContributedActionInvoker({
                invokeContributedAction,
                revalidatePluginActionCallerMaterialization,
                revalidatePluginActionCallerOccurrence,
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
        ...(params?.accountSettingsRecordAdapter
            ? { accountSettingsRecordAdapter: params.accountSettingsRecordAdapter }
            : {}),
        ...(accountCredentialAuthority ? { accountCredentialAuthority } : {}),
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
                    if (!seed.occurrenceId || !seed.sourceCustody) {
                        return createUnavailablePluginServices().sessions;
                    }
                    const occurrenceId = seed.occurrenceId;
                    const sourceCustody = seed.sourceCustody;
                    return createPluginSessionsInventory({
                        executeMessageAction: async ({ sessionId, request, signal }) => (
                            await executePluginSessionMessageAction({
                                execute: async (actionId, input, context) => (
                                    await pluginActionExecutor!.execute(actionId, input, context)
                                ),
                                pluginId: seed.plugin.id,
                                contributionLocalId: seed.contribution.id,
                                occurrenceId,
                                sourceCustody,
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
                        readCredentials: readSessionCredentials,
                        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
                        currentSessionId: seed.session?.id ?? null,
                        sessionScopes: binding.sessionScopes ?? Object.freeze([]),
                        isCurrent: seed.isOccurrenceCurrent,
                        external: bindCurrentGlobalExternalSessionsForPublicCaller({
                            pluginId: seed.plugin.id,
                            contribution: seed.contribution,
                            surface: seed.surface,
                            signal: seed.signal,
                            isOccurrenceCurrent:
                                seed.isOccurrenceCurrent,
                            ...(seed.session?.id
                                ? { sessionId: seed.session.id }
                                : {}),
                        }),
                        createHandleCapabilities: ({ sessionId, readSummary }) => (
                            createPluginSessionHandleCapabilitiesFactory({
                                credentials: sessionCredentials,
                                readCredentials: readSessionCredentials,
                                caller: {
                                    pluginId: seed.plugin.id,
                                    contributionId: seed.contribution.id,
                                    sourceCustody,
                                    runtimeId: seed.contribution.qualifiedId,
                                },
                                signal: seed.signal,
                                isCurrent: seed.isOccurrenceCurrent,
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
        async isOccurrenceCurrent(action) {
            return isPluginConsumerCurrent(action.pluginId)
                && action.occurrenceId === readCurrentPluginOccurrenceId(action.pluginId)
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
                    if (scopedActionRuntime) {
                        return Object.freeze({
                            enabled: true,
                            revision: 'unavailable',
                        });
                    }
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
                    if (scopedActionRuntime) {
                        return Object.freeze({ dispose: () => {} });
                    }
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
                    && isCurrentPluginOccurrence(candidate.pluginId, candidate.occurrenceId)
                    && candidate.registration.family === 'notificationChannels'
                    && candidate.registration.localId === ref.localId
                ));
                if (!entry || entry.registration.family !== 'notificationChannels') return null;
                const sender = entry.registration.value;
                const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                    fact.pluginId === ref.pluginId
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
                    isCurrentPluginOccurrence(ref.pluginId, entry.occurrenceId)
                    && (callerSeed === undefined || callerSeed.isOccurrenceCurrent())
                    && activatedRegistry.targetRegistrations.includes(entry)
                );
                const isChannelCurrent = async (): Promise<boolean> => {
                    if (!isChannelLocallyCurrent()) return false;
                    if (!committed || !await committed.isCurrent()) return false;
                    return isChannelLocallyCurrent();
                };
                const channelHostAccessRequests = resolveManifestHostAccessRequests({
                    manifest: channelTarget.manifest,
                    pluginId: ref.pluginId,
                    contribution: {
                        family: 'notificationChannels',
                        localId: ref.localId,
                    },
                });
                return Object.freeze({
                    occurrenceId: entry.occurrenceId,
                    retirementSignal: resolveRuntimeConsumerLifecycle(ref.pluginId).retirementSignal,
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
                            occurrenceId: entry.occurrenceId,
                            correlationId: randomUUID(),
                            surface: callerSeed?.surface ?? 'background',
                            ...(callerSeed?.session ? { session: callerSeed.session } : {}),
                            ...(callerSeed?.currentSession
                                ? { currentSession: callerSeed.currentSession }
                                : {}),
                            signal: lifetime.signal,
                            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                            isOccurrenceCurrent: isChannelLocallyCurrent,
                        });
                        const presentationOwner = channelSeed.session
                            && channelSeed.currentSession
                            && immutableGenerationId
                            ? createHostSessionPresentationOwner({
                                pluginId: channelSeed.plugin.id,
                                contributionId: channelSeed.contribution.id,
                                generationId: immutableGenerationId,
                                invocationId: channelSeed.correlationId,
                            })
                            : undefined;
                        try {
                            const hostPolicy = invocationServiceOwners.resolveInvocationHostPolicy({
                                pluginId: ref.pluginId,
                                occurrenceId: entry.occurrenceId,
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
                                invokedAtMs: lifetime.invokedAtMs,
                                ...(channelSeed.session ? { session: channelSeed.session } : {}),
                                signal: channelSeed.signal,
                                services,
                                ui: createPluginInvocationPresentation({
                                    currentSession: callerSeed?.session
                                        ? callerSeed.currentSession ?? null
                                        : null,
                                    signal: channelSeed.signal,
                                    isOccurrenceCurrent: channelSeed.isOccurrenceCurrent,
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
        if (!consumerAssembly.isOccurrenceCurrent()) return;
        declaredEventSubscriptionsPublished = true;
    };
    /**
     * Hand declared event delivery to the successor synchronously at
     * publication, while retiring mounted UI watches only for occurrences that
     * were actually replaced. A parked `watch.next` poll holds a registry lease,
     * so a changed occurrence must still receive its terminal result immediately;
     * an unchanged peer remains bound to the stable watch owner across reloads.
     */
    const retireLiveSubscriptionConsumers = (pluginIds?: readonly string[]): void => {
        // Declared handlers are handed from the predecessor registry to the
        // successor at this same synchronous publication boundary. Mounted UI
        // watches instead stay with their exact occurrence and therefore retire
        // only when that owning plugin changed.
        declaredEventSubscriptionsPublished = false;
        if (pluginIds) uiResourceWatches?.retirePlugins(pluginIds);
        else uiResourceWatches?.retire();
    };
    function refreshDeclaredEventSubscriptionBindings(): void {
        for (const entry of activatedRegistry.targetRegistrations) {
            if (entry.registration.family !== 'events') continue;
            const key = `${entry.pluginId}\u0000${entry.occurrenceId}\u0000${entry.registration.localId}`;
            if (declaredEventSubscriptionBindings.has(key)) continue;
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === entry.pluginId
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
                    occurrenceId: entry.occurrenceId,
                    localId: registration.localId,
                    handler: (payload, context) => Reflect.apply(registration.value, undefined, [payload, context]),
                })],
                isOccurrenceCurrent: () => (
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
                        occurrenceId: contextInput.occurrenceId,
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
                        isOccurrenceCurrent: () => (
                            !contextInput.signal.aborted
                            && declaredEventSubscriptionsPublished
                            && isPluginConsumerCurrent(entry.pluginId)
                            && activatedRegistry.targetRegistrations.includes(entry)
                            && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                        ),
                    });
                    try {
                        const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                            seed.occurrenceId,
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
                                invokedAtMs: lifetime.invokedAtMs,
                                ...(seed.session
                                    ? { session: seed.session }
                                    : {}),
                                signal: seed.signal,
                                services,
                                ui: createPluginInvocationPresentation({
                                    currentSession: null,
                                    signal: seed.signal,
                                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
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
    const resolveCurrentFinalPolicyRuntime = (
        pluginId: string,
    ): PluginFinalPolicyCurrentRuntime | null => {
        const activationTarget = resolveExactActivationTarget(pluginId);
        // Final-policy readers retain the exact admitted runtime identity after
        // terminal fencing so they can distinguish `applied: false` from an
        // unknown plugin. Public currentness readers still fail closed through
        // the consumer assembly once this occurrence is retired.
        const occurrenceId = activatedRegistry.readPluginOccurrenceId(pluginId);
        const sourceCustody = activatedRegistry.readPluginSourceCustody(pluginId);
        if (
            !activationTarget
            || !occurrenceId
            || !sourceCustody
        ) return null;
        const activationApplied = Boolean(
            activatedRegistry.activatedPluginIds.has(pluginId)
            && activatedRegistry.targetActivationFacts.some((fact) => (
                fact.pluginId === pluginId
                && fact.status === 'active'
            )),
        );
        const desiredOccurrenceId = isPluginConsumerCurrent(pluginId)
            ? occurrenceId
            : null;
        const appliedOccurrenceId = activationApplied
            ? occurrenceId
            : null;
        return Object.freeze({
            occurrenceId,
            sourceCustody,
            desiredOccurrenceId,
            appliedOccurrenceId,
            applied: appliedOccurrenceId === occurrenceId,
            selectedAccess: Object.freeze([
                ...(committed?.generations.get(pluginId)?.installation?.optionalAccess ?? []),
            ]),
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
        const current = resolveCurrentFinalPolicyRuntime(identity.pluginId);
        if (
            !current
        ) {
            return null;
        }
        const lifecycle = resolveRuntimeConsumerLifecycle(identity.pluginId);
        return Object.freeze({
            occurrenceId: current.occurrenceId,
            isCurrent: () => {
                const refreshed = resolveCurrentFinalPolicyRuntime(identity.pluginId);
                return lifecycle.isCurrent()
                    && refreshed?.occurrenceId === current.occurrenceId;
            },
            retirementSignal: lifecycle.retirementSignal,
        });
    };
    const revalidateStableMcpFinalPolicy = async (
        effect: StablePluginMcpFinalPolicyEffect,
    ): Promise<void> => {
        const pluginId = effect.seed.plugin.id;
        const current = resolveCurrentFinalPolicyRuntime(pluginId);
        if (
            !current?.applied
            || effect.seed.occurrenceId !== current.occurrenceId
            || !effect.seed.sourceCustody
            || !pluginSourceCustodyEqual(
                effect.seed.sourceCustody,
                current.sourceCustody,
            )
        ) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin runtime is no longer current',
            });
        }
        const target = resolveExactActivationTarget(pluginId);
        if (!target) {
            throw new PluginError({
                code: 'plugin_final_package_untrusted',
                message: 'Plugin package identity is unavailable',
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
        const current = resolveCurrentFinalPolicyRuntime(pluginId);
        if (
            !current?.applied
            || effect.seed.occurrenceId !== current.occurrenceId
            || !effect.seed.sourceCustody
            || !pluginSourceCustodyEqual(
                effect.seed.sourceCustody,
                current.sourceCustody,
            )
        ) {
            throw new PluginError({
                code: 'plugin_final_generation_retired',
                message: 'Plugin runtime is no longer current',
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
            ? resolveCurrentFinalPolicyRuntime(action.pluginId)
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
                ? resolveCurrentFinalPolicyRuntime(pluginId)
                : null;
            if (!activationTarget || !definition || !current) return null;
            const availability = resolveTargetActionAvailability({
                availability: definition.availability,
                facts: resolveInvocationContributionPolicyFacts(),
            });
            const action = resolveCatalogTargetActionPolicy({
                pluginId,
                localId,
                occurrenceId: current.occurrenceId,
                sourceCustody: current.sourceCustody,
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
        readRuntimeRegistry: () => resolvedRuntimeRegistryOwner,
        resolveCurrentPluginMaterializationRef,
        readCurrentPluginOccurrenceId,
        readCurrentPluginSourceCustody,
        targetRegistrations: activatedRegistry.targetRegistrations,
        readTargetActivationFacts: () => activatedRegistry.targetActivationFacts,
        resolveAuthorizationFacts: resolveTargetActionAuthorizationFacts,
        resolvePresentUserGatePolicy: resolveActionPresentUserGatePolicy,
        resolveHostBinding: invocationServiceOwners.resolveHostBinding,
        resolveHostPolicy: invocationServiceOwners.resolveHostPolicy,
        createServices: invocationServiceOwners.createServices,
        redactDiagnosticText: invocationServiceOwners.redactDiagnosticText,
        completeDiagnosticScope: invocationServiceOwners.completeDiagnosticScope,
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
        voiceProviders: authoritativeContributes.voiceProviders ?? Object.freeze([]),
        targetRegistrations: activatedRegistry.targetRegistrations,
        readPluginOccurrenceId: activatedRegistry.readPluginOccurrenceId,
        resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
        createHttp(input) {
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === input.pluginId
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
                occurrenceId: input.occurrenceId,
                correlationId: randomUUID(),
                surface: 'cli' as const,
                signal: input.signal,
                isOccurrenceCurrent: () => (
                    !input.signal.aborted
                    && input.isCurrent()
                    && activatedRegistry.activatedPluginIds.has(input.pluginId)
                ),
            });
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                seed.occurrenceId,
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
        resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
        createInvocationContext(input) {
            const pluginVersion = [...activatedRegistry.targetActivationFacts].reverse().find((fact) => (
                fact.pluginId === input.reference.pluginId
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) {
                throw new Error(`Active Composer reference '${input.reference.pluginId}/${input.reference.localId}' has no activation identity`);
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(input.reference.pluginId);
            const currentSession = input.sessionId ? resolveCurrentSessionUiBinding(input.sessionId) : null;
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.reference.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.reference.localId,
                    qualifiedId: `${input.reference.pluginId}/composerReferences/${input.reference.localId}`,
                }),
                occurrenceId: input.occurrenceId,
                correlationId: randomUUID(),
                surface: 'cli' as const,
                ...(input.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
                signal: lifetime.signal,
                redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                isOccurrenceCurrent: () => (
                    !input.signal.aborted
                    && input.isCurrent()
                    && activatedRegistry.activatedPluginIds.has(input.reference.pluginId)
                ),
            });
            const presentationOwner = currentSession && immutableGenerationId
                ? createHostSessionPresentationOwner({
                    pluginId: seed.plugin.id,
                    contributionId: seed.contribution.id,
                    generationId: immutableGenerationId,
                    invocationId: seed.correlationId,
                })
                : undefined;
            try {
                const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                    seed.occurrenceId,
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
                        invokedAtMs: lifetime.invokedAtMs,
                        ...(input.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: currentSession ?? null,
                            signal: seed.signal,
                            isOccurrenceCurrent: seed.isOccurrenceCurrent,
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
        resolveOccurrenceLifecycle: resolveRuntimeConsumerLifecycle,
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
                && fact.status === 'active'
            ))?.pluginVersion;
            if (!pluginVersion) {
                throw new Error(`Active Composer attachment '${input.attachment.pluginId}/${input.attachment.localId}' has no activation identity`);
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(input.attachment.pluginId);
            const currentSession = input.scope.kind === 'session'
                ? resolveCurrentSessionUiBinding(input.scope.sessionId)
                : null;
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.attachment.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.attachment.localId,
                    qualifiedId: `${input.attachment.pluginId}/composerAttachments/${input.attachment.localId}`,
                }),
                occurrenceId: input.occurrenceId,
                correlationId: randomUUID(),
                surface: 'cli' as const,
                scope: input.scope,
                ...(input.scope.kind === 'session'
                    ? { session: Object.freeze({ id: input.scope.sessionId }) }
                    : {}),
                signal: lifetime.signal,
                redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                isOccurrenceCurrent: () => (
                    !input.signal.aborted
                    && input.isCurrent()
                    && activatedRegistry.activatedPluginIds.has(input.attachment.pluginId)
                ),
            });
            const presentationOwner = currentSession && immutableGenerationId
                ? createHostSessionPresentationOwner({
                    pluginId: seed.plugin.id,
                    contributionId: seed.contribution.id,
                    generationId: immutableGenerationId,
                    invocationId: seed.correlationId,
                })
                : undefined;
            try {
                const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                    seed.occurrenceId,
                    `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                    [],
                    seed.contribution.qualifiedId,
                );
                const services = invocationServiceOwners.createServices(seed, serviceBinding);
                const scope = input.scope;
                const context = scope.kind === 'session'
                    ? Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        invokedAtMs: lifetime.invokedAtMs,
                        scope,
                        session: Object.freeze({ id: scope.sessionId }),
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: currentSession ?? null,
                            signal: seed.signal,
                            isOccurrenceCurrent: seed.isOccurrenceCurrent,
                            ...(presentationOwner ? { presentationOwner } : {}),
                        }),
                    })
                    : Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: seed.surface,
                        invokedAtMs: lifetime.invokedAtMs,
                        scope,
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: null,
                            signal: seed.signal,
                            isOccurrenceCurrent: seed.isOccurrenceCurrent,
                        }),
                    });
                return Object.freeze({
                    context,
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

    /**
     * The configured-source lifecycle is the sole Account-revision owner. Its
     * admitted refusal facts refresh this existing registry diagnostics map in
     * place, including the previous owners whose snapshot must be cleared.
     */
    function refreshExternalSessionProjectionDiagnostics(
        agents: readonly ConfiguredExternalSessionSourceAgentContribution[],
        refusals: readonly ConfiguredExternalSessionSourceRefusal[],
    ): void {
        const previousPluginIds = Object.keys(
            externalSessionProjectionDiagnosticsByPluginId,
        );
        const next = projectExternalSessionSourceRefusalDiagnostics(agents, refusals);
        externalSessionProjectionDiagnosticsByPluginId = next;
        const affectedPluginIds = new Set([
            ...previousPluginIds,
            ...Object.keys(next),
            ...agents.flatMap((agent) => (
                agent.identity ? [agent.identity.pluginId] : []
            )),
        ]);
        const scmDiagnosticsByPluginId = readCurrentScmBackendDiagnostics();
        for (const pluginId of affectedPluginIds) {
            refreshPluginDiagnostics(pluginId, scmDiagnosticsByPluginId);
        }
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
    /**
     * Derived on read from the same live activation owner the internal
     * final-policy checks consult. A materialized copy would be a second
     * decision-maker for one authorization fact: every future path that mutates
     * activation and forgets to refresh it would keep publishing `applied: true`
     * for a plugin the activation owner already dropped.
     */
    function resolveCurrentPluginFinalPolicyRuntimes():
    ReadonlyMap<string, PluginFinalPolicyCurrentRuntime> {
        const currentRuntimes = new Map<string, PluginFinalPolicyCurrentRuntime>();
        for (const [pluginId] of committed?.generations ?? []) {
            const current = resolveCurrentFinalPolicyRuntime(pluginId);
            if (current) currentRuntimes.set(pluginId, current);
        }
        return currentRuntimes;
    }
    // The activation owner has already recorded the one `unavailable` fact and
    // dropped the plugin from the activated set, so the derived final-policy
    // generation is already fenced for every reader. Refresh the diagnostics
    // projection, which is materialized, then retire the plugin's live consumer
    // generation and release its per-plugin activation component. A terminally
    // fenced component cannot serve a successor, so retaining its cleanup and
    // runtime-disposable custody until whole-registry shutdown has no owner.
    async function fenceTerminalActivationFailure(pluginId: string): Promise<void> {
        refreshPluginDiagnostics(pluginId, readCurrentScmBackendDiagnostics());
        const activationComponentLeases = retainedActivationRegistryLeases.filter((lease) => (
            lease.pluginIds.size === 1 && lease.pluginIds.has(pluginId)
        ));
        const retireConsumers = retirePluginConsumers([pluginId]);
        const cleanupResults = await Promise.allSettled([
            retireConsumers,
            activatedRegistry.settleRetiredBackgroundServices([pluginId]),
            ...activationComponentLeases.map((lease) => lease.release()),
        ]);
        const failures = cleanupResults.flatMap((result) => (
            result.status === 'rejected' ? [result.reason] : []
        ));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `Failed to settle terminal activation failure for plugin '${pluginId}'`,
            );
        }
    }
    terminalActivationFailureFence = fenceTerminalActivationFailure;

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
        const occurrenceId = readCurrentPluginOccurrenceId(binding.pluginId);
        const sourceCustody = readCurrentPluginSourceCustody(binding.pluginId);
        const seed = Object.freeze({
            plugin: Object.freeze({ id: binding.pluginId, version: binding.pluginVersion }),
            contribution: Object.freeze({
                id: binding.contribution.id,
                qualifiedId: `${binding.pluginId}/requestInterceptors/${binding.contribution.id}`,
            }),
            occurrenceId: binding.occurrenceId,
            ...(occurrenceId ? { occurrenceId } : {}),
            ...(sourceCustody ? { sourceCustody } : {}),
            resolveCurrentPluginMaterializationRef: () =>
                resolveCurrentPluginMaterializationRef(binding.pluginId),
            correlationId: randomUUID(),
            surface: 'agent' as const,
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isOccurrenceCurrent: () => (
                isPluginConsumerCurrent(binding.pluginId)
                && activatedRegistry.activatedPluginIds.has(binding.pluginId)
            ),
        });
        try {
            const serviceBinding = invocationServiceOwners.createOrdinaryServiceBinding(
                binding.occurrenceId,
                `${seed.contribution.qualifiedId}:binding`,
                [],
                seed.contribution.qualifiedId,
            );
            const services = invocationServiceOwners.createServices(seed, serviceBinding);
            const context: PluginInvocationContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal: seed.signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal: seed.signal,
                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
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
            refreshPluginDiagnostics(result.pluginId, scmDiagnosticsByPluginId);
        }
        return results;
    }

    async function acquireAgentCatalogEntry(
        agentId: string,
    ): Promise<ResolvedCatalogEntry | null> {
        const declared = authoritativeContributes.agents.find((agent) => agent.id === agentId);
        if (!declared?.catalogEntry) return null;
        if (!declared.identity) return declared.catalogEntry;
        await activateContributionsOnDemand([{
            pluginId: declared.identity.pluginId,
            family: 'agents',
            localId: declared.identity.localId,
        }]);
        const projected = mergeActivatedContributes(
            contributes,
            activatedRegistry,
            immutableGenerationIdsByPluginId,
            (pluginId) => isPluginConsumerCurrent(pluginId),
            params?.resolveManagedServiceSessionBaseUrl,
            params?.resolveManagedServiceSessionClientAccess,
            resolveAgentPluginSettings,
        );
        return projected.agents.find((agent) => agent.id === agentId)?.catalogEntry ?? null;
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
            refreshPluginDiagnostics(result.pluginId, scmDiagnosticsByPluginId);
        }
        return results;
    }

    // Isolating a rejected readiness participant is only half of the contract:
    // an isolated plugin that stays advertised as ready is exactly the fail-open
    // this fence exists to close. The activation owner records the one typed
    // diagnostic and drops the plugin from the activated set; retiring its
    // consumers and settling its activation component here fences and cleans
    // the failed generation while its peers keep serving.
    async function recordPluginActivationFailure(pluginId: string, message: string): Promise<void> {
        activatedRegistry.recordPluginActivationFailure(pluginId, message);
        await fenceTerminalActivationFailure(pluginId);
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
            sourceCustodiesByPluginId: new Map(
                readCurrentPluginSourceCustody(ref.pluginId)
                    ? [[ref.pluginId, readCurrentPluginSourceCustody(ref.pluginId)!]]
                    : [],
            ),
            isRegistrationCurrent: (entry) => (
                isPluginConsumerCurrent(entry.pluginId)
                && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                && readCurrentPluginOccurrenceId(entry.pluginId) === entry.occurrenceId
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
            sourceCustodiesByPluginId: new Map(
                readCurrentPluginSourceCustody(ref.pluginId)
                    ? [[ref.pluginId, readCurrentPluginSourceCustody(ref.pluginId)!]]
                    : [],
            ),
            isRegistrationCurrent: (entry) => (
                isPluginConsumerCurrent(entry.pluginId)
                && activatedRegistry.activatedPluginIds.has(entry.pluginId)
                && readCurrentPluginOccurrenceId(entry.pluginId) === entry.occurrenceId
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

    function resolveExplicitManagedProviderOperationClaimId(input: Readonly<{
        identity: PluginContributionRef;
        machineId: string;
        operationClaim?: Extract<
            ManagedProviderRuntimeOperationClaim,
            { kind: 'providerBroker' }
        >;
    }>): string | null {
        const operation = input.operationClaim?.operation;
        if (!operation) {
            return createExplicitManagedProviderOperationClaimId(
                input.identity,
                input.machineId,
            );
        }
        const operationIdentity = operation.kind === 'session'
            ? operation.sessionId.trim()
            : operation.kind === 'execution_run'
                ? operation.executionRunId.trim()
                : operation.kind === 'external_api_key'
                    ? JSON.stringify([operation.externalApiKeyId, operation.operationId])
                    : operation.requestId.trim();
        return createManagedProviderBrokerOperationClaimId({
            identity: input.identity,
            operationKind: operation.kind,
            operationIdentity,
        });
    }

    function createManagedProviderBrokerOperationClaimId(input: Readonly<{
        identity: PluginContributionRef;
        operationKind: 'session' | 'execution_run' | 'external_api_key' | 'resource_test';
        operationIdentity: string;
    }>): string | null {
        const operationIdentity = input.operationIdentity.trim();
        if (!operationIdentity) return null;
        return JSON.stringify([
            'managed-provider-broker',
            input.operationKind,
            operationIdentity,
            input.identity.pluginId,
            input.identity.localId,
        ]);
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
            operationId = resolveExplicitManagedProviderOperationClaimId({
                identity,
                machineId: input.machineId,
                ...(input.operationClaim
                    ? { operationClaim: input.operationClaim }
                    : {}),
            });
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
        // Runtime acquisition has one owner: the public managed Provider lifecycle
        // coordinator invoked by `input.establish`. Pre-acquiring it here made a
        // permanently missing/integrity-rejected runtime collapse into the joiner's
        // generic `unavailable` result before that coordinator could return its
        // existing `managed_provider_runtime_unavailable` outcome. The registry
        // generation itself is already the exact SVC09 operation generation; this
        // closure only fences that admitted generation and the caller authority.
        const readsOperationCurrent = (): boolean => {
            try {
                return input.isCurrent() === true
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
            ...(input.retirementGroup ? { retirementGroup: input.retirementGroup } : {}),
            operationId,
            pluginId: identity.pluginId,
            contributionQualifiedId:
                `${identity.pluginId}/providers/${identity.localId}`,
            occurrenceId: readCurrentPluginOccurrenceId(identity.pluginId)!,
            purposeBindingsEqualityKey,
            ...(input.signal ? { signal: input.signal } : {}),
            lifecycleKind: input.operationClaim
                ? 'providerBroker'
                : 'publicExplicitStart',
            ...(input.revalidateRetainedCurrentness
                ? {
                    revalidateRetainedCurrentness:
                        input.revalidateRetainedCurrentness,
                }
                : {}),
            isCurrent: readsOperationCurrent,
            establish: input.establish,
        });
    }

    async function retireManagedProviderExplicitStart(input: Readonly<{
        identity: PluginContributionRef;
        machineId: string;
        operationClaim?: Extract<
            ManagedProviderRuntimeOperationClaim,
            { kind: 'providerBroker' }
        >;
    }>): Promise<boolean> {
        const operationId = resolveExplicitManagedProviderOperationClaimId(
            input,
        );
        if (!operationId) return false;
        return await daemonManagedServicesOwner
            .retireManagedProviderExplicitStart({
                operationId,
                pluginId: input.identity.pluginId,
                contributionQualifiedId:
                    `${input.identity.pluginId}/providers/${input.identity.localId}`,
            });
    }

    async function retireManagedProviderExternalApiKey(input: Readonly<{
        identity: PluginContributionRef;
        externalApiKeyId: string;
        operationId: string;
    }>): Promise<boolean> {
        const operationId = createManagedProviderBrokerOperationClaimId({
            identity: input.identity,
            operationKind: 'external_api_key',
            operationIdentity: JSON.stringify([input.externalApiKeyId, input.operationId]),
        });
        if (!operationId) return false;
        return await daemonManagedServicesOwner.retireManagedProviderExplicitStart({
            operationId,
            pluginId: input.identity.pluginId,
            contributionQualifiedId:
                `${input.identity.pluginId}/providers/${input.identity.localId}`,
        });
    }

    async function revalidateManagedProviderExplicitStarts(
        signal?: AbortSignal,
    ): Promise<number> {
        return await daemonManagedServicesOwner
            .revalidateManagedProviderExplicitStarts(signal);
    }

    async function retireManagedProviderExplicitStarts(
        lifecycleKind: 'publicExplicitStart' | 'providerBroker',
    ): Promise<number> {
        return await daemonManagedServicesOwner
            .retireManagedProviderExplicitStarts(lifecycleKind);
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
                occurrenceId: string;
                sourceCustody: PluginSourceCustody;
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
                activationOccurrenceId:
                    input.retained.occurrenceId,
                sourceCustody: input.retained.sourceCustody,
                isCurrent: input.isCurrent,
            })
            : await acquireManagedProviderRuntime(input.identity);
        if (!runtime) return null;
        const activeProviderRegistration = input.retained
            ? null
            : activatedRegistry.targetRegistrations.find((entry) => (
                entry.pluginId === input.identity.pluginId
                && entry.occurrenceId === runtime.activationOccurrenceId
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
            if (input.operationClaim.kind === 'providerBroker') {
                return resolveExplicitManagedProviderOperationClaimId({
                    identity: input.identity,
                    machineId: '',
                    operationClaim: input.operationClaim,
                });
            }
            const sessionId = input.operationClaim.sessionId.trim();
            return sessionId
                ? JSON.stringify([
                    'managed-provider-session-demand',
                    sessionId,
                    input.identity.pluginId,
                    input.identity.localId,
                    runtime.activationOccurrenceId,
                    readCurrentPluginSourceCustody(
                        input.identity.pluginId,
                    ),
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
            occurrenceId: runtime.activationOccurrenceId,
            sourceCustody: runtime.sourceCustody,
            correlationId: randomUUID(),
            surface: 'cli' as const,
            signal: lifetime.signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isOccurrenceCurrent: readsInvocationCurrent,
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
        const bootstrapOccurrenceId = input.retained?.occurrenceId
            ?? readCurrentPluginOccurrenceId(input.identity.pluginId);
        const bootstrapSourceCustody = input.retained?.sourceCustody
            ?? readCurrentPluginSourceCustody(input.identity.pluginId);
        if (!bootstrapOccurrenceId || !bootstrapSourceCustody) {
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
                occurrenceId: bootstrapOccurrenceId,
                sourceCustody: bootstrapSourceCustody,
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
        const deployment = runtimeBindingBasis.deployment;
        if (
            deployment.kind !== 'managedLocal'
            || buildQualifiedPluginContributionKey(
                deployment.implementationIdentity,
            ) !== buildQualifiedPluginContributionKey(input.identity)
            || !declaration
            || !isDeepStrictEqual(
                deployment.managedRuntime,
                declaration,
            )
            || endpoint?.protocol !== runtimeBindingBasis.endpoint.protocol
            || !isDeepStrictEqual(
                deployment.purposeBindings,
                QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
                    input.purposeBindings,
                ),
            )
        ) {
            await Promise.resolve(invocation.cleanup())
                .catch(() => undefined);
            return null;
        }
        const scope: RetainedManagedProviderRuntimeInvocationScope =
            Object.freeze({
                sessionId: input.operationClaim.sessionId,
                runtimeBindingBasis,
                identity: invocation.bootstrap.identity,
                occurrenceId: invocation.bootstrap.occurrenceId,
                sourceCustody: invocation.bootstrap.sourceCustody,
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
        const retainedProvider = await attestRetainedManagedProvider({
            paths: resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
            sessionId: scope.sessionId,
            identity: scope.identity,
            occurrenceId: scope.occurrenceId,
            sourceCustody: scope.sourceCustody,
            manifestAuthority: scope.manifestAuthority,
            runtimeBindingBasis: scope.runtimeBindingBasis,
        });
        if (
            !retainedProvider
            || !adoptedPublicOutcome.endpointTemplateIds.includes(
                retainedProvider.runtimeBindingBasis.endpoint.endpointTemplateId,
            )
        ) return null;
        if (!input.isCurrent()) return null;
        const invocation =
            await createManagedProviderRuntimeInvocationServicesInternal({
                identity: retainedProvider.identity,
                purposeBindings:
                    retainedProvider.runtimeBindingBasis.deployment.purposeBindings,
                retained: Object.freeze({
                    declaration: retainedProvider.declaration,
                    pluginVersion: retainedProvider.pluginVersion,
                    occurrenceId: retainedProvider.occurrenceId,
                    sourceCustody: retainedProvider.sourceCustody,
                    manifestAuthority: retainedProvider.manifestAuthority,
                    requiredHostAccess:
                        retainedProvider.requiredHostAccess,
                    operationClaimId: scope.operationClaimId,
                }),
                signal: input.signal,
                isCurrent: input.isCurrent,
            });
        if (!invocation) return null;
        try {
            if (
                input.signal.aborted
                || !input.isCurrent()
                || await retainedProvider.assertStillAvailable().then(
                    () => false,
                    () => true,
                )
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

    const connectedAccountAssembly = assembleConnectedAccountRuntime({
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
        descriptors: authoritativeContributes.connectedAccountDescriptors ?? Object.freeze([]),
        onDescriptorUnavailable(ref, error) {
            logger.warn('[PLUGIN RUNTIME] Connected Account descriptor is unavailable', {
                pluginId: ref.pluginId,
                localId: ref.localId,
                reason: projectPluginFailureText(error ?? new Error(
                    committed?.rejectedGenerations.get(ref.pluginId)?.message
                    ?? 'The plugin has no admitted occurrence or source custody in this runtime',
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
                    occurrenceId: entry.occurrenceId,
                    localId: entry.registration.localId,
                    runtime: entry.registration.value,
                })]
                : []
        )),
        invocationServiceOwners,
        resolvePlugin(ref) {
            const target = resolveExactActivationTarget(ref.pluginId);
            if (
                !target
                || !target.manifest.contributes.connectedAccountDescriptors.some(
                    (candidate) => candidate.id === ref.localId,
                )
            ) return null;
            return Object.freeze({
                version: target.manifest.version,
                hostAccessRequests: resolveManifestHostAccessRequests({
                    manifest: target.manifest,
                    pluginId: target.pluginId,
                    contribution: {
                        family: 'connectedAccountDescriptors',
                        localId: ref.localId,
                    },
                }),
            });
        },
        networkDependencies: params?.networkDependencies,
    });
    const connectedAccountContributions = connectedAccountAssembly.contributions;
    const connectedAccountRuntimeInvoker = connectedAccountAssembly.invoker;
    let consumersRetired = false;
    const connectedAccountPurposeBindingOwner =
        projectConnectedAccountPurposeBindingOwner(params?.connectedAccounts);
    // One occurrence guard for every live-resource call, so a retired or
    // replaced plugin cannot answer a poll it no longer owns.
    function requireCurrentUiResourceWatches(
        pluginId: string,
        expectedOccurrenceId: string,
    ) {
        if (!consumerAssembly.isOccurrenceCurrent()) {
            throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
        }
        if (!isCurrentPluginOccurrence(pluginId, expectedOccurrenceId)) {
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
        consumerAssembly.retireAll(
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
            const verifiedBinding = verifyAgentSessionRunnerBindingV1(binding);
            if (verifiedBinding.sourceCustody.kind === 'development') {
                const currentSourceCustody = readCurrentPluginSourceCustody(
                    verifiedBinding.pluginId,
                );
                const currentOccurrenceId = readCurrentPluginOccurrenceId(
                    verifiedBinding.pluginId,
                );
                const target = resolveExactActivationTarget(
                    verifiedBinding.pluginId,
                );
                const declaredAgent = target?.manifest.contributes.agents.find(
                    (candidate) => candidate.id === verifiedBinding.localAgentId,
                );
                if (
                    !currentSourceCustody
                    || !currentOccurrenceId
                    || !pluginSourceCustodyEqual(
                        currentSourceCustody,
                        verifiedBinding.sourceCustody,
                    )
                    || !target
                    || target.manifest.version !== verifiedBinding.pluginVersion
                    || !declaredAgent
                ) {
                    throw new Error('Development retained Agent is not available from the current trusted slot');
                }
                return Object.freeze({
                    binding: verifiedBinding,
                    sourceKind: 'development' as const,
                    rootPath: dirname(dirname(target.manifestPath)),
                    cacheIdentity: currentOccurrenceId,
                    assertStillAvailable: async () => {
                        const latestCustody = readCurrentPluginSourceCustody(
                            verifiedBinding.pluginId,
                        );
                        if (
                            !latestCustody
                            || !pluginSourceCustodyEqual(
                                latestCustody,
                                verifiedBinding.sourceCustody,
                            )
                        ) {
                            throw new Error('Development retained Agent source custody is no longer current');
                        }
                    },
                    manifest: target.manifest,
                    manifestAuthority: target.provenance === 'first_party'
                        ? 'bundled_first_party' as const
                        : 'external' as const,
                    declaredAgent,
                });
            }
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
            typeof verifyRetainedRunnerAgentServiceBinding
        >>,
    ) => Object.freeze([
        ...resolveManifestHostAccessRequests({
            manifest: attested.manifest,
            pluginId: attested.binding.pluginId,
            contribution: {
                family: 'agents',
                localId: attested.binding.localAgentId,
            },
        }),
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
        localAgentId: string,
    ) => Object.freeze([
        ...resolveManifestHostAccessRequests({
            manifest: target.manifest,
            pluginId: target.pluginId,
            contribution: { family: 'agents', localId: localAgentId },
        }),
        ...projectConnectedAccountPurposeDeclarationsToHostAccess(
            target.manifest.contributes.agents.find(
                (candidate) => candidate.id === localAgentId,
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
            occurrenceId: readCurrentPluginOccurrenceId(input.pluginId)!,
            correlationId: randomUUID(),
            surface: 'ui' as const,
            signal,
            isOccurrenceCurrent: () => (
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
            seed.occurrenceId,
            `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
            [],
            seed.contribution.qualifiedId,
        );
        return invocationServiceOwners.createServices(seed, binding);
    };

    resolveAgentPluginSettings = async ({ pluginId, localAgentId }) => {
        // An Agent may consume only its own declarations. Account and daemon
        // remain distinct records; no key merge or precedence rule exists.
        const scopes = new Set<'account' | 'daemon'>();
        for (const entry of authoritativeContributes.settings ?? []) {
            if (entry.pluginId !== pluginId || entry.definition.target.kind !== 'agent') continue;
            const target = entry.definition.target.agent;
            const matches = typeof target === 'string'
                ? target === localAgentId
                : target.pluginId === pluginId && target.localId === localAgentId;
            if (matches) scopes.add(entry.definition.scope);
        }
        if (scopes.size === 0) return null;
        const services = createProjectionPluginServices({ pluginId });
        if (!services || services.availability('settings').status !== 'available') return null;
        const snapshot: { -readonly [Scope in keyof AgentCliSessionCommandPluginSettingsV1]: AgentCliSessionCommandPluginSettingsV1[Scope] } = {};
        for (const scope of scopes) {
            try {
                snapshot[scope] = await readPluginSettingsValuesWithDefaults(
                    services.settings.forScope({ kind: scope }),
                );
            } catch {
                // One unavailable scope cannot be substituted with or merged
                // into the other. The exact available record remains useful.
            }
        }
        return snapshot.account || snapshot.daemon ? Object.freeze(snapshot) : null;
    };

    const resolvedRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
        contributes: authoritativeContributes,
        durableRevision: committed?.commit?.revision ?? -1,
        generation: activatedRegistry.generation,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        // Component retirement changes the activation facts at the lifecycle
        // owner. Do not freeze the startup snapshot into the resolved registry.
        // Ordinary finite background-runner settlement remains diagnostic-only.
        get targetActivationFacts() {
            return activatedRegistry.targetActivationFacts;
        },
        targetActionInvocations: committedTargetActionInvocations,
        ...(params?.executeClientAction ? { executeClientAction: params.executeClientAction } : {}),
        resolveActionPresentUserGatePolicy,
        ...(authoritativeContributes.readAdmittedTargetedContributions
            ? { readAdmittedTargetedContributions: authoritativeContributes.readAdmittedTargetedContributions }
            : {}),
        resolveCurrentPluginMaterializationRef,
        resolveCurrentMediatorContributionMaterializationRef,
        readReleaseLessMaterializations: () => Object.freeze([...releaseLessDeclarationsByPluginId.values()]
            .flatMap((declaration) => (
                declaration.runtimeMaterialization
                && activatedRegistry.activatedPluginIds.has(declaration.runtimeMaterialization.pluginId)
                    ? [declaration.runtimeMaterialization]
                    : []
            ))),
        ...(params?.resolveCurrentMachineExecutionOriginContext
            ? {
                resolveCurrentPluginExecutionOrigin,
                resolveCurrentPluginApprovalReplayPlacement,
            }
            : {}),
        prepareCollectionMigrationCandidates,
        retireCollectionMigrationCandidates,
        retirementSignal: consumerAssembly.allRetirementSignal,
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
        ...(invocationServiceOwners.notifications
            ? { pluginNotifications: invocationServiceOwners.notifications }
            : {}),
        promptAssetAdapters,
        systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId: activatedRegistry.envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId: activatedRegistry.filesystemReadAllowedPathsByPluginId,
        runtimeCapabilitiesByPluginId: activatedRegistry.runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId: activatedRegistry.eventDeclarationsByPluginId,
        pluginDiagnosticsByPluginId,
        get pluginFinalPolicyCurrentRuntimesById() {
            return resolveCurrentPluginFinalPolicyRuntimes();
        },
        resolveVoiceProviderRuntimeLifecycle,
        resolveOptionalAccess(pluginId) {
            return committed?.generations.get(pluginId)?.installation?.optionalAccess
                ?? Object.freeze([]);
        },
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
        get activatedPluginIds() {
            return activatedRegistry.activatedPluginIds;
        },
        activateContributionsOnDemand,
        acquireAgentCatalogEntry,
        async resolveCaptureSource(reference) {
            const target = authoritativeContributes.activationTargets.find(candidate => candidate.pluginId === reference.pluginId);
            const declaration = target?.manifest.contributes.captureSources?.find(candidate => candidate.id === reference.localId);
            if (!declaration) return null;
            await activateContributionsOnDemand([{ pluginId: reference.pluginId, family: 'captureSources', localId: reference.localId }]);
            const entry = activatedRegistry.targetRegistrations.find(candidate => candidate.pluginId === reference.pluginId
                && candidate.registration.family === 'captureSources' && candidate.registration.localId === reference.localId);
            if (!entry || entry.registration.family !== 'captureSources' || !isCurrentPluginOccurrence(reference.pluginId, entry.occurrenceId)) return null;
            const lifecycle = resolveRuntimeConsumerLifecycle(reference.pluginId);
            return Object.freeze({ declaration, runtime: entry.registration.value, occurrenceId: entry.occurrenceId,
                retirementSignal: lifecycle.retirementSignal,
                isCurrent: () => lifecycle.isCurrent() && isCurrentPluginOccurrence(reference.pluginId, entry.occurrenceId)
                    && activatedRegistry.targetRegistrations.includes(entry),
            });
        },
        acquireManagedProviderRuntime,
        acquireProviderCatalogParsers,
        runManagedProviderExplicitStart,
        retireManagedProviderExplicitStart,
        retireManagedProviderExternalApiKey,
        revalidateManagedProviderExplicitStarts,
        retireManagedProviderExplicitStarts,
        createManagedProviderRuntimeInvocationServices,
        createRetainedManagedProviderRuntimeInvocationServices,
        activatePluginsForValidation,
        recordPluginActivationFailure,
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
            return consumerAssembly.isOccurrenceCurrent()
                ? params?.qualifiedConnectedAccountEstablishedRuntimeOwner ?? null
                : null;
        },
        resolveConnectedAccountPurposeBindingOwner() {
            return consumerAssembly.isOccurrenceCurrent()
                ? connectedAccountPurposeBindingOwner
                : null;
        },
        resolveManagedServiceCredentialFileOwner() {
            return consumerAssembly.isOccurrenceCurrent()
                ? managedServiceCredentialFiles
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
            const occurrenceId = readCurrentPluginOccurrenceId(mcpParams.pluginId);
            const sourceCustody = readCurrentPluginSourceCustody(mcpParams.pluginId);
            if (!occurrenceId || !sourceCustody) return null;
            const isOccurrenceCurrent = () => (
                isPluginConsumerCurrent(mcpParams.pluginId)
                && activatedRegistry.activatedPluginIds.has(mcpParams.pluginId)
                && activatedRegistry.targetActivationFacts.some((fact) => (
                    fact.pluginId === mcpParams.pluginId
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
                    if (!hostSession || !isOccurrenceCurrent() || mcpParams.signal?.aborted) {
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
                        occurrenceId,
                        sourceCustody,
                        correlationId: randomUUID(),
                        surface: 'agent',
                        session: Object.freeze({ id: hostSession.sessionId }),
                        currentSession: hostSession.currentSession,
                        signal: mcpParams.signal ?? new AbortController().signal,
                        isOccurrenceCurrent,
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
                            occurrenceId,
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
            const occurrenceId = readCurrentPluginOccurrenceId(detectionParams.pluginId);
            if (!occurrenceId) {
                throw new PluginError({
                    code: 'plugin_generation_stale',
                    message: 'MCP discovery source occurrence is no longer current',
                });
            }
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
                occurrenceId,
                sourceCustody: readCurrentPluginSourceCustody(detectionParams.pluginId) ?? undefined,
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
                isOccurrenceCurrent: () => isPluginConsumerCurrent(detectionParams.pluginId),
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
                occurrenceId: readCurrentPluginOccurrenceId(eventParams.pluginId)!,
                correlationId: randomUUID(),
                surface: 'agent' as const,
                signal,
                isOccurrenceCurrent: () => (
                    !signal.aborted
                    && isPluginConsumerCurrent(eventParams.pluginId)
                    && activatedRegistry.activatedPluginIds.has(eventParams.pluginId)
                ),
            });
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                seed.occurrenceId,
                `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                [],
                seed.contribution.qualifiedId,
            );
            const services = invocationServiceOwners.createServices(seed, binding);
            return services.availability('events').status === 'available' ? services.events.plugin : null;
        },
        async acquireRetainedRunnerAgentPurposeContributions(input) {
            const paths = resolvePluginStorePaths({
                happyHomeDir: params?.happyHomeDir,
            });
            const readHardRevocationRevision = async () =>
                await readCurrentPluginHardRevocationRevision({
                    paths,
                    pluginId: input.binding.pluginId,
                });
            if (
                await readHardRevocationRevision()
                    !== input.pluginHardRevocationRevision
            ) return null;
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    input.binding,
                    'plugin_services_retained_generation_untrusted',
                );
            if (
                await readHardRevocationRevision()
                    !== input.pluginHardRevocationRevision
            ) return null;

            const provenance = verified.manifestAuthority
                === 'bundled_first_party'
                ? 'first_party' as const
                : 'external' as const;
            const retainedAgent = projectManifestAgentContribution({
                definition: verified.declaredAgent,
                provenance,
                source: {
                    kind: provenance === 'first_party'
                        ? 'bundled'
                        : 'package',
                },
                pluginId: verified.binding.pluginId,
            });
            if (retainedAgent.id !== verified.binding.agentId) return null;
            const retainedContributes = createResolvedContributionRegistry({
                agents: Object.freeze([retainedAgent]),
                actions: Object.freeze([]),
                resources: Object.freeze([]),
                activationTargets: Object.freeze([]),
                immutableGenerationIdsByPluginId:
                    verified.binding.sourceCustody.kind === 'managed'
                        ? Object.freeze({
                            [verified.binding.pluginId]:
                                verified.binding.sourceCustody
                                    .immutableGenerationId,
                        })
                        : Object.freeze({}),
            });
            let released = false;
            return Object.freeze({
                contributes: retainedContributes,
                // The Session marker/authority document retains G. Current H/I
                // may move without invalidating G; hard revocation is fenced by
                // the daemon authority owner and the double revision read above.
                isCurrent: () => !released,
                async release() {
                    released = true;
                },
            });
        },
        async createRetainedRunnerAgentCurrentGlobalActionsService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                );
            if (!agentParams.isOccurrenceCurrent()) {
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
            const currentOccurrenceId = readCurrentPluginOccurrenceId(
                verified.binding.pluginId,
            );
            const currentSourceCustody = readCurrentPluginSourceCustody(
                verified.binding.pluginId,
            );
            if (!currentOccurrenceId || !currentSourceCustody) {
                throw new PluginError({
                    code: 'plugin_services_current_global_unavailable',
                    message: `Current global services for retained Agent '${verified.binding.agentId}' are unavailable`,
                });
            }
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: currentTarget.pluginId,
                    version: currentTarget.manifest.version,
                }),
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: verified.binding.pluginId,
                            localId: verified.binding.localAgentId,
                        }),
                }),
                occurrenceId: currentOccurrenceId,
                sourceCustody: currentSourceCustody,
                resolveCurrentPluginMaterializationRef: () =>
                    resolveCurrentPluginMaterializationRef(
                        currentTarget.pluginId,
                    ),
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({
                    id: agentParams.sessionId,
                }),
                signal: agentParams.signal,
                ...(agentParams.readActiveTurnAdmissionWitness
                    ? {
                        readActiveTurnAdmissionWitness:
                            agentParams.readActiveTurnAdmissionWitness,
                    }
                    : {}),
                isOccurrenceCurrent:
                    agentParams.isOccurrenceCurrent,
            });
            const binding =
                invocationServiceOwners
                    .createOrdinaryServiceBinding(
                        seed.occurrenceId,
                        `${seed.contribution.qualifiedId}:${seed.correlationId}:current-global-actions`,
                        [],
                        seed.contribution.qualifiedId,
                    );
            return invocationServiceOwners.createServices(seed, binding).actions;
        },
        async createRetainedRunnerAgentCurrentGlobalMcpService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                );
            if (!agentParams.isOccurrenceCurrent()) {
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
            const currentOccurrenceId = readCurrentPluginOccurrenceId(
                verified.binding.pluginId,
            );
            const currentSourceCustody = readCurrentPluginSourceCustody(
                verified.binding.pluginId,
            );
            if (!currentOccurrenceId || !currentSourceCustody) {
                throw new PluginError({
                    code: 'plugin_services_current_global_unavailable',
                    message: `Current global services for retained Agent '${verified.binding.agentId}' are unavailable`,
                });
            }
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: currentTarget.pluginId,
                    version: currentTarget.manifest.version,
                }),
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: verified.binding.pluginId,
                            localId: verified.binding.localAgentId,
                        }),
                }),
                occurrenceId: currentOccurrenceId,
                sourceCustody: currentSourceCustody,
                resolveCurrentPluginMaterializationRef: () =>
                    resolveCurrentPluginMaterializationRef(
                        currentTarget.pluginId,
                    ),
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({
                    id: agentParams.sessionId,
                }),
                signal: agentParams.signal,
                isOccurrenceCurrent:
                    agentParams.isOccurrenceCurrent,
            });
            const policy = invocationServiceOwners
                .resolveInvocationHostPolicy({
                    pluginId: currentTarget.pluginId,
                    occurrenceId: seed.occurrenceId,
                    qualifiedId:
                        seed.contribution.qualifiedId,
                }, {
                    hostAccessRequests:
                        currentGlobalHostAccessRequests(
                            currentTarget,
                            verified.binding.localAgentId,
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
            if (!agentParams.isOccurrenceCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${verified.binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }
            return bindCurrentGlobalExternalSessionsForPublicCaller({
                pluginId: verified.binding.pluginId,
                contribution: Object.freeze({
                    id: verified.binding.localAgentId,
                    qualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: verified.binding.pluginId,
                            localId: verified.binding.localAgentId,
                        }),
                }),
                surface: 'agent',
                sessionId: agentParams.sessionId,
                signal: agentParams.signal,
                isOccurrenceCurrent: agentParams.isOccurrenceCurrent,
            });
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
                manifest,
                manifestAuthority,
                declaredAgent,
            } = verified;
            if (!agentParams.isOccurrenceCurrent()) {
                throw new PluginError({
                    code:
                        'plugin_services_retained_generation_untrusted',
                    message:
                        `Retained Agent '${binding.agentId}' no longer has exact live daemon-service authority`,
                });
            }

            const retainedHostAccess =
                retainedAgentHostAccessRequests(verified);
            const currentSourceCustody = readCurrentPluginSourceCustody(
                binding.pluginId,
            );
            const currentOccurrenceId = currentSourceCustody
                && pluginSourceCustodyEqual(
                    currentSourceCustody,
                    binding.sourceCustody,
                )
                ? readCurrentPluginOccurrenceId(binding.pluginId)
                : null;
            const retainedInvocationOccurrenceId = currentOccurrenceId
                ?? createPluginRuntimeOccurrenceId(binding.pluginId);
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: binding.pluginId,
                    version: binding.pluginVersion,
                }),
                contribution: Object.freeze({
                    id: binding.localAgentId,
                    qualifiedId: resolveAgentContributionQualifiedId({
                        pluginId: binding.pluginId,
                        localId: binding.localAgentId,
                    }),
                }),
                occurrenceId: retainedInvocationOccurrenceId,
                sourceCustody: binding.sourceCustody,
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                session: Object.freeze({ id: agentParams.sessionId }),
                signal: agentParams.signal,
                isOccurrenceCurrent: agentParams.isOccurrenceCurrent,
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
            const retainedManagedDependencies = binding.sourceCustody.kind === 'development'
                ? managedDependencies
                : await createRetainedRunnerManagedDependenciesHost({
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
                    ? verified.sourceKind === 'managed'
                        ? await createStableImmutablePluginResourcesOwner({
                        generationId: binding.sourceCustody.kind === 'managed'
                            ? binding.sourceCustody.immutableGenerationId
                            : verified.cacheIdentity,
                        pluginId: binding.pluginId,
                        rootPath: verified.rootPath,
                        files: (await readPreparedImmutablePluginGeneration({
                            paths: storePaths,
                            immutableGenerationId:
                                binding.sourceCustody.kind === 'managed'
                                    ? binding.sourceCustody.immutableGenerationId
                                    : verified.cacheIdentity,
                        })).record.files,
                        declarations:
                            manifest.contributes.resources ?? [],
                        ...(manifest.brand?.iconResourceId === undefined
                            ? {}
                            : { brandIconResourceId: manifest.brand.iconResourceId }),
                        ...(manifest.brand?.monochrome === undefined
                            ? {}
                            : { brandMonochrome: manifest.brand.monochrome }),
                        isOccurrenceCurrent:
                            agentParams.isOccurrenceCurrent,
                    })
                        : await createStableRetainedPluginResourcesOwner({
                            sourceIdentity: verified.cacheIdentity,
                            pluginId: binding.pluginId,
                            rootPath: verified.rootPath,
                            declarations:
                                manifest.contributes.resources ?? [],
                            ...(manifest.brand?.iconResourceId === undefined
                                ? {}
                                : { brandIconResourceId: manifest.brand.iconResourceId }),
                            ...(manifest.brand?.monochrome === undefined
                                ? {}
                                : { brandMonochrome: manifest.brand.monochrome }),
                            isSourceCurrent:
                                agentParams.isOccurrenceCurrent,
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
            const currentOccurrenceId = readCurrentPluginOccurrenceId(agentParams.pluginId);
            if (
                !currentOccurrenceId
                || agentParams.occurrenceId !== currentOccurrenceId
                || !agentParams.isOccurrenceCurrent()
            ) {
                throw new PluginError({
                    code: 'plugin_generation_stale',
                    message: `Agent '${agentParams.agentId}' belongs to a retired plugin generation`,
                });
            }
            const agentCliSystemTool = declaredAgent.catalogEntry?.agentCliSystemTool;
            const declaredAgentLocalId = declaredAgent.identity?.localId ?? declaredAgent.id;
            if (
                agentParams.agentCliLaunch
                && agentParams.agentCliLaunch.localAgentId !== declaredAgentLocalId
            ) {
                throw new PluginError({
                    code: 'plugin_agent_cli_system_tool_unavailable',
                    message: `Agent '${agentParams.agentId}' CLI launch binding does not match its declared identity`,
                });
            }
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
                    return agentParams.agentCliLaunch
                        ? createRetainedAgentCliSystemToolService({
                            agentId: agentParams.agentId,
                            binding: agentCliSystemTool,
                            definition,
                            launch: agentParams.agentCliLaunch.spec,
                            delegate,
                        })
                        : createAgentCliSystemToolService({
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
            const currentSession = agentParams.currentSession ?? agentParams.session?.current;
            const sourceCustody = readCurrentPluginSourceCustody(agentParams.pluginId);
            const seed = Object.freeze({
                plugin: Object.freeze({ id: agentParams.pluginId, version: agentParams.pluginVersion }),
                contribution: Object.freeze({
                    id: agentLocalId,
                    qualifiedId: resolveAgentContributionQualifiedId({
                        pluginId: agentParams.pluginId,
                        localId: agentLocalId,
                    }),
                }),
                occurrenceId: currentOccurrenceId,
                correlationId: agentParams.correlationId,
                surface: 'agent' as const,
                ...(sourceCustody ? { sourceCustody } : {}),
                ...(agentParams.session ? {
                    session: Object.freeze({ id: agentParams.session.id }),
                } : {}),
                ...(currentSession ? { currentSession } : {}),
                signal: agentParams.signal,
                isOccurrenceCurrent: () => (
                    isCurrentPluginOccurrence(agentParams.pluginId, currentOccurrenceId)
                    && agentParams.isOccurrenceCurrent()
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
                resolveContributionOccurrence: (pluginId) => (
                    activatedRegistry.readPluginOccurrenceId(pluginId)
                ),
                isContributionOccurrenceCurrent: (pluginId, occurrenceId) => (
                    activatedRegistry.isPluginOccurrenceCurrent(pluginId, occurrenceId)
                ),
                resources: resourcesOwner,
                agent: {
                    pluginId: agent.pluginId!,
                    localId: agent.identity?.localId ?? agent.definition.id,
                },
                ...(promptParams.selectedAsset ? { selectedAsset: promptParams.selectedAsset } : {}),
                signal: promptParams.signal ?? new AbortController().signal,
                isOccurrenceCurrent: () => isPluginConsumerCurrent(agent.pluginId!),
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
            if (!consumerAssembly.isOccurrenceCurrent()) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
            }
            if (!isCurrentPluginOccurrence(
                resourceParams.callerPluginId,
                resourceParams.expectedCallerOccurrenceId,
            )) {
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
                consumerAssembly.isOccurrenceCurrent()
                && isCurrentPluginOccurrence(
                    resourceParams.callerPluginId,
                    resourceParams.expectedCallerOccurrenceId,
                )
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
                isOccurrenceCurrent: isResourceBindingCurrent,
                ...(resourceParams.context === undefined ? {} : { context: resourceParams.context }),
            });
            assertResourceBindingCurrent();
            return await service.read(resourceParams.resourceId, { signal });
        },
        async readUiStoredImage(imageParams) {
            const current = () => !imageParams.signal?.aborted && consumerAssembly.isOccurrenceCurrent()
                && isCurrentPluginOccurrence(imageParams.callerPluginId, imageParams.expectedCallerOccurrenceId);
            const assertCurrent = () => {
                if (!current()) throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin image reader retired' });
            };
            assertCurrent();
            const target = resolveExactActivationTarget(imageParams.callerPluginId);
            if (!target) throw new PluginError({ code: 'plugin_session_scope_unavailable', message: 'Plugin Session read scope is unavailable' });
            const policy = invocationServiceOwners.resolveInvocationHostPolicy({
                pluginId: target.pluginId, occurrenceId: imageParams.expectedCallerOccurrenceId,
                qualifiedId: `${target.pluginId}/ui/stored-image`,
            }, {
                hostAccessRequests: [
                    ...target.manifest.hostAccess.required.map((request) => ({ request, required: true })),
                    ...target.manifest.hostAccess.optional.map((request) => ({ request, required: false })),
                ],
                surface: 'ui', sessionId: imageParams.media.file.sessionId,
                ...(imageParams.signal ? { signal: imageParams.signal } : {}),
            });
            if (policy.serviceBinding.availability.sessions !== 'available') {
                throw new PluginError({ code: 'plugin_session_scope_unavailable', message: 'Plugin Session read scope is unavailable' });
            }
            const credentials = await readSessionCredentials();
            if (!credentials) throw new PluginError({ code: 'plugin_sessions_not_authenticated', message: 'Session image read requires an Account' });
            const [raw, account] = await Promise.all([
                fetchSessionById({ token: credentials.token, sessionId: imageParams.media.file.sessionId }),
                fetchAccountEncryptionCurrentness(credentials),
            ]);
            assertCurrent();
            if (!raw || (raw.encryptionMode !== 'plain' && raw.encryptionMode !== 'e2ee') || raw.encryptionMode !== account.mode) {
                throw new PluginError({ code: 'plugin_session_media_encryption_mismatch', message: 'Session image encryption mode is unavailable or inconsistent' });
            }
            const metadata = tryDecryptSessionPresentationMetadataView({ credentials, rawSession: raw, accountEncryptionMode: account.mode });
            if (!metadata || typeof metadata.path !== 'string') {
                throw new PluginError({ code: 'plugin_session_media_unavailable', message: 'Session image metadata is unavailable' });
            }
            const verification = await verifySessionStructuredImageInput({
                cwd: metadata.path, sessionId: raw.id, image: sessionMediaToStructuredImageInput(imageParams.media),
                maxBytes: configuration.filesUploadMaxFileBytes,
                pluginAccess: {
                    scopes: policy.serviceBinding.sessionScopes ?? [],
                    session: projectPluginSessionAccessIdentity(raw, metadata),
                    accountEncryptionMode: account.mode, sessionEncryptionMode: raw.encryptionMode,
                },
            });
            assertCurrent();
            if (verification.status !== 'verified') throw new PluginError({ code: 'plugin_session_media_unavailable', message: 'Session image is outside the declared read scope or unavailable' });
            return { bytesBase64: verification.bytes.toString('base64'), mimeType: 'image/png', width: imageParams.media.width, height: imageParams.media.height };
        },
        async openUiResourceWatch(watchParams) {
            const watches = requireCurrentUiResourceWatches(
                watchParams.callerPluginId,
                watchParams.expectedCallerOccurrenceId,
            );
            return await watches.open({
                callerPluginId: watchParams.callerPluginId,
                subscriptionId: watchParams.subscriptionId,
                resourceId: watchParams.resourceId,
                ...(watchParams.context === undefined ? {} : { context: watchParams.context }),
            });
        },
        async pollUiResourceWatch(watchParams) {
            const watches = requireCurrentUiResourceWatches(
                watchParams.callerPluginId,
                watchParams.expectedCallerOccurrenceId,
            );
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
            if (!consumerAssembly.isOccurrenceCurrent()) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
            }
            const consumer = resolveStablePluginStructuredMessageConsumer({
                registry: authoritativeContributes,
                expectedContributorOccurrenceId: messageParams.expectedContributorOccurrenceId,
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
                    consumerAssembly.isOccurrenceCurrent()
                    && authoritativeContributes.occurrenceIdsByPluginId?.[consumer.model.identity.pluginId]
                        === messageParams.expectedContributorOccurrenceId
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
                    isOccurrenceCurrent: isResourceBindingCurrent,
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
        fencePluginConsumers,
        subscribePluginOccurrenceFence(listener) {
            pluginOccurrenceFenceListeners.add(listener);
            return () => {
                pluginOccurrenceFenceListeners.delete(listener);
            };
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
        // A retired plugin's activation component is fenced, not reusable: its
        // background services, runtime disposables and generation lifecycle are
        // already retired here. Donating it would re-merge its `active` facts and
        // handlers into the successor registry and silently undo the fence.
        retainPluginActivationComponent: (pluginId) => {
            if (consumerAssembly.isPluginRetired(pluginId)) return null;
            return retainedActivationRegistryLeases.find((lease) => (
                lease.pluginIds.size === 1 && lease.pluginIds.has(pluginId)
            ))?.retain() ?? null;
        },
        ...(preparedActivationRegistryLeaseOwners.length > 0 ? {
            retainPreparedActivationRegistryComponents: () => Object.freeze(
                preparedActivationRegistryLeaseOwners.map((owner) => owner.retain()),
            ),
        } : {}),
    };
    resolvedRuntimeRegistryOwner = resolvedRuntimeRegistry;
    // The first current-global publication invokes every configured Agent's
    // `resolveSource` leaf, and that leaf reaches back through this registry's
    // own Agent invocation services. Publishing it before the owner above is
    // assigned made each leaf reject with `agent_error`, so a registry whose
    // Agents were already activated published a permanently sourceless owner:
    // the publication basis was recorded, so no later same-basis refresh could
    // repair it. Keep this the last construction step.
    await refreshCurrentGlobalExternalSessionsAuthor();
    return resolvedRuntimeRegistry;
}

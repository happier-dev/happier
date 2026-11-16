import { deploymentUnavailableDiagnostic } from '@/deployments/deploymentFailure';
import { createAccountMachineSourceDeclarationReader } from './invocation/actions/accountMachineSourceDeclarations';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createProductionPluginSettingsHostFactory } from './invocation/services/settingsHost';
import { createStablePluginEventsBroker } from './invocation/services/events';
import { resolveAgentPluginSettingsFromService } from './agentPluginSettings';
import { prepareAgentAuxiliaryNativeOperation } from './agentAuxiliaryNativeOperation';

import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { createCommittedContributedActionDefinitionLister, listRuntimeContributedActionDefinitions } from './invocation/actions/createCommittedContributedActionDeps';
import type { PluginReloadController } from './reload/controller';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterResolutionV1 } from './lifecycle/contributions/targetProjectNativeAdapters';
import type { ProjectNativeAdapterRoleV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { ResolvedPluginExecutable } from './invocation/services/exec';
import { authorizePluginExecLaunchForHost } from './invocation/services/exec';
import { createHostScmCommandRunner, type ScmCommandRunner } from '@/scm/runtime';
import { createHash, randomUUID } from 'node:crypto';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { DaemonPluginStoredImageReadRequest } from '@happier-dev/protocol';
import { projectPluginSessionAccessIdentity } from '@happier-dev/protocol/sessions/pluginAccess';
import type { PluginUiReadStoredImageResultV1 } from '@happier-dev/protocol/plugins/ui';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionPresentationMetadataView, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { sessionMediaToStructuredImageInput, verifySessionStructuredImageInput } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SharedManagedProviderGatewayBinding } from './invocation/services/managedServicesAdapter';
import type { ManagedServicesInvocationOwner } from './invocation/services/managedServicesAdapter';
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
import { createCredentialedConnectedAccountAuthenticationHost } from './connectedAccounts/authenticationHost';
import { observePluginConfigurationActivation } from './lifecycle/activation/configuration';
import {
    assembleConnectedAccountRuntime,
    projectConnectedAccountPurposeBindingOwner,
} from './composition/connectedAccountAssembly';
import { createMcpSignInConnectedAccountRegistration } from '@/mcp/oauth/mcpSignInRuntime';
import { assembleAutomationRuntime } from './composition/automationAssembly';
import { createCliHealthCheckSourceSnapshotReader } from '@/session/actions/workflowTriggers';
import { createSavedHealthChecksHost } from '@/deployments/healthChecks/savedHealthChecks';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { publishSavedServiceHealthResult } from '@/deployments/healthChecks/publishServiceHealth';
import { createPluginWebhookHeartbeatClient } from './webhooks/heartbeatClient';
import { createCurrentDomainEdgeObservation } from '@/deployments/healthChecks/currentDomainEdgeObservation';
import { readAdoptedHealthCheckBatch } from '@/deployments/healthChecks/readAdoptedHealthCheckBatch';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createAutomationEventStoredDefinitionsHttpTransportV1 } from './automations/automationEventAdoptedDefinitionSetHost';
import type { AutomationEventSourcesListTransportV1 } from '@happier-dev/protocol';
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
import { projectManifestAgentAcpCatalogPreflight, projectManifestAgentContribution } from '../projection/registry/projectManifestAgentContribution';
import { projectNativeAgentCliRuntimeDescriptor } from '../projection/registry/agentCliMetadata';
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
    ResolvedProviderContribution,
    ResolvedProviderUsageParsers,
} from '../projection/registry/types';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { arePluginMachineMaterializationRefsEqual, arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { resolvePluginMachineExecutionOrigin } from './resolvePluginMachineExecutionOrigin';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { evaluatePluginFinalPolicy } from '@happier-dev/protocol/plugins/actions/policy';
import { isDynamicPluginResourceContributionV2 } from '@happier-dev/protocol/plugins/contributions/v2';
import { McpDetectedProviderV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { normalizePluginAccountCollectionContractsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { TargetActionApprovalReplayPlacementV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { resolveProviderManagedRuntimeDeclarationV1, createProviderManagedPurposeBindingsEqualityKeyV1, createProviderManagedRuntimeBindingEqualityKeyV1 } from '@happier-dev/protocol/providers/contributions';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createPluginNativeNotificationDelivery } from '@/notifications/activity/pluginNativeNotificationDelivery';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { QualifiedConnectedAccountPurposeBindingsV1Schema, qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { SessionExecutionTargetV1Schema } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { QualifiedConnectedAccountPurposeBindingsV1, ConnectedAccountRequestAuthUseV1, ProviderRuntimeBindingBasisV1, PluginContributionIdentityV1, PluginMachineExecutionOriginV1, PluginMachineMaterializationRefV1, TargetActionApprovalReplayPlacementV1, NormalizedPluginAccountCollectionContractV1, PluginCollectionCandidatePreparationBindingV1, PluginCollectionContractRefV1, PluginReleaseRefV1, PluginUiArtifactDigestV1, PluginResourceContextV1, PluginActionPresentUserGatePolicy } from '@happier-dev/protocol';
import { ProviderRuntimeBindingBasisV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { readContributedProviderCatalogParserIds, readContributedProviderUsageParserIds } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { DaemonMcpServersDetectWarningV1, HostSemanticEventV1 } from '@happier-dev/protocol';
import type { HostStructuredMessageDescriptorV1 } from './invocation/services/structuredMessageDescriptor';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

import {
    activatePluginRuntimeRegistry,
    type ActivatedPluginRuntimeRegistry,
} from './lifecycle/manager';
import {
    createBundledActivationSourceResolver,
    resolveBundledActivationSourceRepoRoot,
    resolvePackagedBundledActivationPaths,
} from './bundledActivationSource';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../../scm/pluginBackends/runtimeRegistry';
import { createPluginActivationSourceResolver } from './pluginActivationSource';
import { resolveAccountPluginActivationSources, type AccountPluginActivationSourcesInput } from './accountPluginActivationSource';
import { getResolvedContributionRegistry } from '../projection/registry/builtIn/snapshot';
import type {
    PluginDaemonModuleNamespace,
    PreparedPluginActivationGraph,
    ResolvedPluginHookHandler,
} from './types';
import type { PluginActivationSource } from './activationSources';
import {
    projectAdmittedBackgroundServicePlugin,
    type AdmittedBackgroundServicePlugin,
} from './lifecycle/contributions/backgroundServiceProcessSource';
import {
    collectActivationTargets,
    deriveActivationTargetRegistrationRights,
    isAutomaticActivationSuppressedByMachineRoles,
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
import { createTargetSecretSources } from './lifecycle/contributions/targetSecretSources';
import { revalidateVoiceSpeechHttpEndpoint } from './lifecycle/contributions/voiceSpeechHttpPolicy';
import { projectTargetProviderRuntimes } from './lifecycle/contributions/targetProviders';
import {
    projectExternalSessionSourceRefusalDiagnostics,
} from './lifecycle/contributions/externalSessionSourceRefusals';
import { buildTargetActionInvocationRegistry } from './invocation/buildTargetActionRegistry';
import { createDeploymentTargetRoleAdmissionHost } from '@/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { createDynamicResourceActionBinding } from './invocation/services/resourceActions';
import { executeContributedAction, type ClientContributedActionExecutor } from './invocation/actions/executeContributedAction';
import { createHostContributedActionInvoker } from './invocation/actions/hostContributedActionInvoker';
import {
    resolveCurrentSessionCapabilityBinding,
    resolveCurrentSessionUiBinding,
} from '@/session/presentation/currentSessionUiBindings';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { materializePluginSessionAttachment } from '@/session/attachments/materializePluginSessionAttachment';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createPluginSessionsInventory } from '@/session/services/pluginSessionsInventory';
import { executePluginSessionMessageAction } from '@/session/services/executePluginSessionMessageAction';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import {
    createCurrentGlobalExternalSessionsAuthorBinding,
    createCurrentGlobalExternalSessionsAuthorService,
} from '@/session/external/currentGlobalAuthorService';
import { createContributionOwnedManagedServiceEndpointReadHostCache } from '@/session/external/contributionOwnedManagedServiceEndpointRead';
import type { ConfiguredExternalSessionSourceAgentContribution } from '@/session/external/configuredSourceMaterializer';
import type { ConfiguredExternalSessionSourceRefusal } from '@/session/external/configuredSourceRegistry';
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
import { createAccountPluginSettingsRecordStorage } from './context/accountPluginSettingsRecordStorage';
import type {
    PluginAccountSettingsRecordAdapter,
} from './invocation/services/settings';
import { createStablePluginComposerContentOwner } from './invocation/services/composerContent';
import { projectContributedActionExecuteResult, type InvokeContributedAction } from './invocation/services/actions';
import type { StableTargetedContributionsOwner } from './invocation/services/targetedContributions';
import { createManifestTargetedContributionsService, mergeTargetedContributionManifestDeclarations, type TargetedContributionManifestSnapshot } from '@happier-dev/cli-common/plugins/registration';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { invokeAccountMachineSourceAction, resolveAccountMachineSourceActionMachine } from './invocation/actions/accountMachineActionTransport';
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
import { readHomeWebappUrl } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
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
    type StableDynamicPluginResourceProducer,
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
    createStablePluginMcpHost,
    invokePeer,
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
    isPluginError,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { type PluginEvents } from '@happier-dev/plugin-sdk/events';
import { type McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint, type McpDiscoveryRequest as PluginMcpDiscoveryRequest, type McpDiscoveryResult as PluginMcpDiscoveryResult, type McpServerRef as PluginMcpServerRef } from '@happier-dev/plugin-sdk/mcp';
import { type PluginResourceKind } from '@happier-dev/plugin-sdk/resources';
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
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
    PluginProviderOperationsSource,
} from './invocation/services/types';

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
    loadRetainedAgentRuntimeLeaf,
    verifyRunnerAgentBindingAgainstGeneration,
    type RetainedRunnerAgentServiceBinding,
} from './runner/loadRetainedAgentRuntimeLeaf';
import { isRunnerPinnedDevelopmentAgentSource, retainedAgentSourceMatchesRunner } from './retainedPluginSourceAttestation';
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
    createDeclaredAgentCliSystemToolService,
    readMemberAgentCliLaunchContext,
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
import { logger } from '@/ui/logger';
import { bindPromptAssetContributionBlocks } from '@/agent/prompting/contributions/bindPromptAssetContributionBlocks';
import type { OptionalPromptAssetUnavailable } from '@/agent/prompting/contributions/resolvePromptAssetContributionBlocks';
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
} from './fetch/service';
import { createConnectedAccountPluginHttpPurposeHost } from './fetch/connectedAccountPurpose';
import {
    createVoiceAccountPluginHttpCredentialBindingHost,
} from './fetch/voiceAccountCredentialBinding';
import {
    createGlobalFetchRuntime,
} from './fetch/globalFetchRuntime';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import {
    createPluginMcpSessionResolver,
} from './context/mcp';
import { projectPluginMcpServerItems } from '@/mcp/runtime/pluginMcpServerItems';
import { mcpPluginItemIdV1, parseMcpPluginItemIdV1, type McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { PluginExecutionScopeV1 } from '@happier-dev/protocol';
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
    getActiveAccountSettingsSnapshotLifetimeToken,
    resolveActiveAccountConfiguredExternalSessionSourceRevision,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createExplicitManagedProviderOperationClaimId, resolveExplicitManagedProviderOperationClaimId, createManagedProviderBrokerOperationClaimId, qualifyManagedProviderRequestAuthUses, isSharedProviderAdmission } from './providerBindings/operationClaims';
import type { PluginRuntimeGenerationAuthority, PluginContributionRuntimeLifecycle, ResolvedExecutablePluginRuntimeRegistry, PluginRuntimeMachineAdmissionTransport } from './composition/executableTypes';
import type { ResolvedManagedProviderRuntimeInvocationServices, ManagedProviderSessionCustodyBinding, ManagedProviderSessionBootstrapPreparation, ManagedProviderRuntimeOperationClaim, ManagedProviderExplicitStartJoinResult, ManagedProviderExplicitStartJoinInput, RetainedManagedProviderRuntimeInvocationScope, ManagedProviderAdoptedPublicOutcome, ManagedProviderInvocationAccountAuthority } from './providerBindings/runtimeTypes';
import { mergePluginDiagnostics, projectActivatedAgentContributions, mergeActivatedContributes } from './composition/activatedContributions';
import { assertCommittedResourceActivationIdentity } from './lifecycle/activation/committedResourceIdentity';
import { isJsonRecord, cloneLegacyMcpHandlerInput, projectPluginMcpDiscoveredEndpoints, projectPluginMcpDiscoveryWarnings, projectPluginMcpDiscoveryWarningsToLegacyDetection } from './invocation/mcpDiscoveryProjection';

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

function resolveManagedDependencyHostPlatform(): 'darwin' | 'linux' | 'win32' {
    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
        return process.platform;
    }
    throw new PluginError({
        code: 'plugin_managed_dependency_platform_unsupported',
        message: 'Managed dependencies are unavailable on this host platform',
    });
}

export async function resolveExecutablePluginRuntimeRegistry(
    params?: Readonly<{
        agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
        /** Source and lifetime of the authenticated invoking Account process. */
        accountExecution?: Pick<AccountPluginActivationSourcesInput, 'credentials' | 'serverUrl' | 'isCurrent' | 'isCredentialCurrent'>
            & Readonly<{ machineId?: string; explicitMachineId?: string; serverId?: string; serverIdentityId?: string;
                savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1 }>;
        signal?: AbortSignal;
        /** Daemon startup joins Account policy/catalog readiness before executable assembly. */
        awaitAccountSettingsReadiness?: () => Promise<void>;
        readSpawnFailureLimits?: import('@/processes/spawnFailure/classifySpawnFailure').SpawnFailureLimitsReader;
        happyHomeDir?: string;
        contributes?: ResolvedContributionRegistry;
        generation?: number;
        /** Daemon-owned live machine identity for host-stamped nested Action callers. */
        resolveCurrentMachineId?: () => string | null;
        /** Existing daemon Machine/Account attribution owner; no requester fallback. */
        readDaemonRequesterWorkAttribution?: () => RequesterWorkAttributionV1 | null;
        ensureEnvironmentServices?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
        acquireServiceExportForward?: import('@/deployments/targets/ownServer/ownServerDeploymentHostRuntime').OwnServerDeploymentRuntimeHostInput['acquireServiceExportForward'];
        executeClientAction?: ClientContributedActionExecutor;
        /** Existing authenticated Machine admission authority for protected Session input. */
        machineAdmissionTransport?: PluginRuntimeMachineAdmissionTransport;
        externalActionHomeBinding?: ExternalActionHomeBinding;
        /** Captured daemon custody for deployment admission; does not select an execution realm. */
        deploymentAccountExecution?: Parameters<typeof createDeploymentTargetRoleAdmissionHost>[1]['accountExecution'];
        /** Existing daemon-local transfer carrier for host-authored media bytes. */
        resolveComposerMediaStageTransferRpcHandler?: () => RpcHandlerInvoker | null;
        /** Fresh server/machine identity; never a retained feature snapshot. */
        resolveCurrentMachineExecutionOriginContext?: (
            signal?: AbortSignal,
        ) => Promise<CurrentMachineExecutionOriginContext | null>;
        resolveSessionResourceAccess?: ResolveSessionResourceAccess;
        /** The daemon's server-verified Account id, owned by its Machine connection. */
        resolveAuthenticatedAccountId?: (signal?: AbortSignal) => Promise<string>;
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
        > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings' | 'resolveBindingIntentSelection'>>;
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
            savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
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
        /** The existing daemon publication owner for retained callers' next Action. */
        runtimeRegistryController?: Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'tryAcquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'>;
        /** Credential materializers held by the containing operation, independently of Account Action execution. */
        connectedAccountRuntimeRegistry?: Parameters<typeof createDeploymentTargetRoleAdmissionHost>[1]['connectedAccountRuntimeRegistry'];
        /** Invalidates projections after a same-generation lazy activation fails terminally. */
        onTerminalActivationFailure?: (pluginId: string) => void;
        /** Testable port for the canonical Account plugin-settings persistence owner. */
        accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
    }>,
): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const generation = params?.generation ?? 0;
    const scopedActionRuntime = params?.scopedActionRuntime;
    const readSessionCredentials = params?.accountExecution
        ? async () => await params.accountExecution!.isCredentialCurrent?.() === false
            ? null : params.accountExecution!.credentials
        : scopedActionRuntime
        ? async () => scopedActionRuntime.credentials
        : readStoredCredentials;
    const capturedSavedSecretOperationContext = params?.accountExecution?.savedSecretOperationContext
        ?? scopedActionRuntime?.savedSecretOperationContext;
    const savedSecretOperationContext = capturedSavedSecretOperationContext
        ? Object.freeze({ ...capturedSavedSecretOperationContext,
            get secretSources() { return resolvedRuntimeRegistryOwner?.secretSources; } })
        : undefined;
    const accountCredentialAuthority = scopedActionRuntime || params?.accountExecution
        ? Object.freeze({
            readCredentials: readSessionCredentials,
            actionsSettingsProvider: scopedActionRuntime?.actionsSettingsProvider
                ?? createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKey(params!.accountExecution!.credentials) }),
            ...(savedSecretOperationContext
                ? { savedSecretOperationContext }
                : {}),
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
        ?? (params?.accountExecution ? getResolvedContributionRegistry() : await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
            accountStorageDependencies: params?.accountStorageDependencies,
        }));
    const committed = params?.accountExecution ? null : params?.generationAuthority ?? await readCurrentCommittedPluginGenerations(
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
    // One scope for every plugin this registry may admit: an incremental
    // re-resolution keeps retained and serving occurrences, which must load
    // from the same packaged closure as the plugins it re-resolves.
    const scopedCandidatePluginIds = params?.pluginIds === undefined
        ? undefined
        : new Set([
            ...params.pluginIds,
            ...retainedActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds]),
            ...(params.servingPluginOccurrences?.keys() ?? []),
        ]);
    const packagedRuntimeRoot = resolveAuthoritativePackagedRuntimeCustody();
    const packagedActivationPaths = packagedRuntimeRoot
        ? resolvePackagedBundledActivationPaths({
            runtimeRoot: packagedRuntimeRoot.root,
            activationTargets: contributes.activationTargets.filter((target) => (
                scopedCandidatePluginIds === undefined || scopedCandidatePluginIds.has(target.pluginId)
            )),
            metadata: BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
            locators: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
        })
        : null;
    const resolveBundledActivationSource = createBundledActivationSourceResolver({
        bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
        bundledDeclarations: contributes.pluginDeclarations,
        ...(params?.signal ? { signal: params.signal } : {}),
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
                packagedRuntimeRoot: packagedRuntimeRoot.root,
            }
            : {}),
    });
    const activatedManifestAuthorityByPluginId = new Map<
        string,
        'external' | 'bundled_first_party'
    >();
    const accountActivationSources = params?.accountExecution
        ? await resolveAccountPluginActivationSources({
            ...params.accountExecution, contributes, paths: pluginStorePaths,
            machineEnabledById: (await (await import('@/plugins/store/registry/currentState'))
                .createPluginRegistryStateStore({ happyHomeDir: params?.happyHomeDir }).readSnapshot()).bundledPluginEnabledById,
            resolveBundledActivationSource,
            ...(params.signal ? { signal: params.signal } : {}),
        }) : null;
    if (accountActivationSources) contributes = accountActivationSources.contributes;
    const resolveInstalledActivationSource = createPluginActivationSourceResolver({
        committed,
        resolveBundledActivationSource,
        ...(params?.resolveDevelopmentSourceAuthority
            ? { resolveDevelopmentSourceAuthority: params.resolveDevelopmentSourceAuthority }
            : {}),
        ...(params?.preparedActivationGraphsByPluginId
            ? { preparedActivationGraphsByPluginId: params.preparedActivationGraphsByPluginId }
            : {}),
        ...(params?.preparedDevelopmentActivationGraphsByPluginId
            ? { preparedDevelopmentActivationGraphsByPluginId: params.preparedDevelopmentActivationGraphsByPluginId }
            : {}),
        ...(params?.happyHomeDir !== undefined ? { happyHomeDir: params.happyHomeDir } : {}),
        activatedManifestAuthorityByPluginId,
    });
    const resolveCommittedActivationSource: typeof resolveInstalledActivationSource = accountActivationSources
        ? (target) => accountActivationSources.sourcesByPluginId.get(target.pluginId) ?? null
        : resolveInstalledActivationSource;
    const activationTargets = collectActivationTargets(contributes, params?.accountExecution ? 'account' : undefined);
    const candidatePluginIds = scopedCandidatePluginIds ?? new Set([
            ...activationTargets.map((target) => target.pluginId),
            ...(contributes.pluginDeclarations ?? []).map((declaration) => declaration.pluginId),
            ...contributes.agents.flatMap((agent) => agent.pluginId ? [agent.pluginId] : []),
            ...(contributes.roles ?? []).map((role) => role.pluginId),
            ...(contributes.workflows ?? []).map((workflow) => workflow.pluginId),
            ...(contributes.inputTypes ?? []).map((type) => type.pluginId),
            ...(contributes.dragSources ?? []).map((source) => source.pluginId),
            ...(contributes.dropTargets ?? []).map((target) => target.pluginId),
        ]);
    const candidateOccurrenceIdsByPluginId = new Map<string, PluginRuntimeOccurrenceId>();
    const admittedPluginSourceCustodiesByPluginId = new Map<string, PluginSourceCustody>();
    for (const pluginId of candidatePluginIds) {
        const target = activationTargets.find((candidate) => candidate.pluginId === pluginId);
        const declaration = contributes.pluginDeclarations?.find((candidate) => candidate.pluginId === pluginId);
        // A plugin this candidate no longer declares (removal) has no occurrence.
        if (!target
            && !declaration
            && !contributes.agents.some((agent) => agent.pluginId === pluginId)
            && !(contributes.roles ?? []).some((role) => role.pluginId === pluginId)
            && !(contributes.workflows ?? []).some((workflow) => workflow.pluginId === pluginId)
            && !(contributes.inputTypes ?? []).some((type) => type.pluginId === pluginId)
            && !(contributes.dragSources ?? []).some((source) => source.pluginId === pluginId)
            && !(contributes.dropTargets ?? []).some((dropTarget) => dropTarget.pluginId === pluginId)) continue;
        const activationSource = accountActivationSources?.sourcesByPluginId.get(pluginId)
            ?? (target ? resolveCommittedActivationSource(target, { recordActivatedManifestAuthority: false }) : null);
        let candidateSourceCustody = activationSource?.sourceAuthority
            ? resolvePluginSourceCustody(activationSource.sourceAuthority)
            : null;
        // Client-only declarations have no daemon module to resolve or load,
        // but use the same admitted package/development custody as executable
        // peers. A bundled id alone never establishes source authority.
        if (!candidateSourceCustody && !target && declaration?.sourceSpec.kind === 'bundled') {
            const metadata = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find((candidate) => (
                candidate.pluginId === pluginId
                && candidate.packageName === declaration.sourceSpec.locator
            ));
            if (metadata) {
                if (packagedRuntimeRoot) {
                    candidateSourceCustody = Object.freeze({
                        kind: 'bundled_first_party', packagedRuntime: packagedRuntimeRoot.packagedRuntime,
                    });
                } else {
                    const authority = params?.resolveDevelopmentSourceAuthority?.({
                        pluginId,
                        rootPath: resolve(resolveBundledActivationSourceRepoRoot(import.meta.url), 'packages', 'plugins', metadata.pluginPackageId),
                    });
                    if (authority) candidateSourceCustody = resolvePluginSourceCustody(authority);
                }
            }
        }
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
        // Every admitted occurrence must have fresh or retained source custody.
        // A target without either is isolated from this serving registry rather
        // than poisoning unrelated contribution projections during publication.
        if (!candidateSourceCustody && !retainedIdentity) continue;
        candidateOccurrenceIdsByPluginId.set(
            pluginId,
            retainedIdentity?.occurrenceId ?? createPluginRuntimeOccurrenceId(pluginId),
        );
        if (retainedIdentity) {
            admittedPluginSourceCustodiesByPluginId.set(pluginId, retainedIdentity.sourceCustody);
            // Retained activation does not load this source again. Its exact
            // admitted manifest authority still belongs to the source resolver,
            // rather than disappearing with the predecessor's private map.
            if (target && activationSource?.sourceAuthority
                && pluginSourceCustodyEqual(resolvePluginSourceCustody(activationSource.sourceAuthority), retainedIdentity.sourceCustody)) {
                resolveCommittedActivationSource(target);
            }
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
    // materialization through the caller-materialization owner below. This
    // declaration does not grant install-registry projection authority.
    const releaseLessDeclarationsByPluginId = projectReleaseLessPluginDeclarations({
        activationTargets: contributes.pluginDeclarations ?? activationTargets,
        sourceCustodiesByPluginId: admittedPluginSourceCustodiesByPluginId,
        registryMaterializationIdsByPluginId: contributes.materializationIdsByPluginId ?? {},
        observedAt: Date.now(),
    });
    contributes = createResolvedContributionRegistry({
        ...contributes,
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
        includeDefaults?: boolean;
        signal?: AbortSignal;
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
    // Startup activation stays scoped to requested components. Resource
    // admission also retains serving peers, including dormant occurrences
    // that will only register a producer when demanded.
    const scopedActivationPluginIds = params?.pluginIds === undefined
        ? undefined
        : Object.freeze([...new Set(params.pluginIds)].sort());
    const scopedResourcePluginIds = scopedActivationPluginIds === undefined
        ? null
        : new Set([
            ...scopedActivationPluginIds,
            ...retainedActivationPluginIds,
            // An unchanged dormant plugin has a serving occurrence but no
            // activation component to retain. Keep its declared Resources
            // available for demand without activating it during replacement.
            ...(params?.servingPluginOccurrences?.keys() ?? []),
        ]);
    const immutableGenerationIdsByPluginId = new Map(
        committedImmutableGenerationIdsByPluginId,
    );
    let captureActivatedPluginConsumerPreparation: ((pluginId: string) => () => Promise<void>) | undefined;
    const activationParams: Omit<
        Parameters<typeof activatePluginRuntimeRegistry>[0],
        'pluginIds' | 'retainedRegistries' | 'adoptActivationComponent'
    > = {
        contributes,
        generation,
        immutableGenerationIdsByPluginId,
        occurrenceIdsByPluginId: candidateOccurrenceIdsByPluginId,
        admittedPluginSourceCustodiesByPluginId,
        ...(params?.accountExecution ? { isActivationCurrent: params.accountExecution.isCurrent, executionRealm: 'account' as const } : {}),
        activationAdmissionFailuresByPluginId: new Map(
            [...(committed?.rejectedGenerations.entries() ?? [])].map(([pluginId, rejected]) => [
                pluginId,
                Object.freeze({
                    immutableGenerationId: rejected.immutableGenerationId,
                    message: rejected.message,
                    cause: rejected.cause,
                }),
            ]),
        ),
        happyHomeDir: params?.happyHomeDir,
        resolveActivationSource(target) {
            const source = resolveCommittedActivationSource(target);
            // Admission must establish custody before activate() can publish
            // callable Actions. Consumer refresh retains its invariant check;
            // an unavailable source is isolated by the activation owner instead.
            if (source
                && !source.sourceAuthority
                && !admittedPluginSourceCustodiesByPluginId.has(target.pluginId)
                && derivePluginDaemonContributionRegistrationRights(target.manifest.contributes)
                    .some((right) => right.family === 'actions')) {
                throw new Error(`Plugin '${target.pluginId}' lacks admitted source custody for daemon Actions`);
            }
            return source;
        },
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
        captureActivatedPluginConsumerPreparation: pluginId => captureActivatedPluginConsumerPreparation?.(pluginId),
        invocationServices: {
            resolveCurrentPluginMaterializationRef(pluginId) {
                return resolveCurrentPluginMaterializationRef(pluginId);
            },
            createOrdinaryServiceBinding(bindingGeneration, id) {
                return invocationServiceOwners.createOrdinaryServiceBinding(
                    bindingGeneration,
                    id,
                );
            },
            createServices(seed, binding) {
                return invocationServiceOwners.createServices(seed, binding);
            },
            prepareBackgroundServiceProcessLocalPolicy(seed, binding) {
                return invocationServiceOwners.prepareBackgroundServiceProcessLocalPolicy(seed, binding);
            },
            resolveInvocationHostPolicy(target, context) {
                return invocationServiceOwners.resolveInvocationHostPolicy(target, context);
            },
        },
    };
    if (params?.awaitAccountSettingsReadiness) await params.awaitAccountSettingsReadiness();
    params?.signal?.throwIfAborted();
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
    const resolveAgentPreflightLifecycle = (pluginId: string) => {
        const lifecycle = consumerAssembly.resolveLifecycle(pluginId);
        return {
            isCurrent: lifecycle.isCurrent,
            // Catalog processes must retire before daemon RPC draining can
            // postpone registry disposal. Ordinary admitted writes keep their
            // existing drain lifetime; only preflight borrows this signal.
            retirementSignal: params?.signal
                ? AbortSignal.any([lifecycle.retirementSignal, params.signal])
                : lifecycle.retirementSignal,
        };
    };
    const authoritativeContributes = mergeActivatedContributes(
        contributes,
        activatedRegistry,
        immutableGenerationIdsByPluginId,
        (pluginId) => (
            consumerAssembly.isPluginCurrent(pluginId)
        ),
        params?.resolveManagedServiceSessionBaseUrl,
        params?.resolveManagedServiceSessionClientAccess,
        (input) => resolveAgentPluginSettings(input),
        bindAgentPreflightManagedServices,
        resolveAgentPreflightManagedExecutable,
        resolveAgentPreflightLifecycle,
        params?.agentIsolation,
    );
    const resolveExactActivationTarget = (pluginId: string) => {
        const targets = authoritativeContributes.activationTargets.filter((target) => (
            target.pluginId === pluginId
        ));
        return targets.length === 1 || (targets.length > 0 && targets.every(target => target.account && target.manifest === targets[0]!.manifest))
            ? targets[0]! : null;
    };
    const canonicalResourceActivationTargets =
        committedContributes?.activationTargets
        ?? authoritativeContributes.activationTargets;
    const resolveCanonicalResourceActivationTarget = (pluginId: string, localId?: string) => {
        const targets = canonicalResourceActivationTargets.filter((target) => (
            target.pluginId === pluginId
            && (localId === undefined || deriveActivationTargetRegistrationRights(target)
                .some(right => right.family === 'resources' && right.localId === localId))
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
                || (
                    (resource.definition.execution?.target ?? 'daemon') === (params?.accountExecution ? 'account' : 'daemon')
                    &&
                    // A restored development declaration can precede source
                    // re-admission. Only the canonical admission map grants
                    // Resource authority; declarations alone cannot bind it.
                    candidateOccurrenceIdsByPluginId.has(resource.pluginId)
                    && (
                        scopedResourcePluginIds === null
                        || scopedResourcePluginIds.has(resource.pluginId)
                    )
                )
            )
        ));
    const hasCommittedResourceActivationTarget = (pluginId: string): boolean => {
        const targets = canonicalResourceActivationTargets.filter((target) => (
            target.pluginId === pluginId
        ));
        return targets.length === 1 || (targets.length > 0 && targets.every(target => target.account
            && target.manifest === targets[0]!.manifest));
    };
    const resolveServerFeaturesSnapshot = params?.resolveServerFeaturesSnapshot;
    // Both portable and release-less preparation load the exact module through
    // the canonical activation source/loader, without activating it.
    const loadCollectionMigrationModule = async (
        source: NonNullable<ReturnType<typeof resolveCommittedActivationSource>>,
        target: Parameters<typeof resolveCommittedActivationSource>[0],
    ) => {
        if (source.kind === 'bundled' && source.prepare) {
            try { await source.prepare(); } catch { await source.prepare(); }
        }
        const cacheKey = resolveCollectionCandidateModuleCacheKey(source);
        const module = await loadPluginModule({ source, ...(cacheKey ? { cacheKey } : {}) });
        // A prepared graph already projected its author manifest at admission;
        // its executable namespace contains callbacks, not a second manifest.
        return projectPluginAuthorModule(source.kind === 'prepared'
            ? { ...module, manifest: target.manifest }
            : module);
    };
    const accountStorageHost = createAccountPluginDataStorageHost({
        contracts: scopedActionRuntime
            ? Object.freeze([])
            : (authoritativeContributes.accountCollections ?? Object.freeze([]))
                .map((entry) => entry.definition),
        ...(params?.accountStorageDependencies ?? {}),
        ...(accountCredentialAuthority && !params?.accountExecution
            ? {
                readCredentials: accountCredentialAuthority.readCredentials,
                isCurrentAccount: () => false,
                resolveAccountScopeKey: () => null,
                subscribeChanges: () => () => {},
            }
            : {}),
        ...(params?.accountExecution ? {
            readCredentials: readSessionCredentials,
            isCurrentAccount: async () => await params.accountExecution!.isCredentialCurrent?.() !== false
                && params.accountExecution!.isCurrent(),
            resolveAccountScopeKey: () => resolveAccountSettingsScopeKey(params.accountExecution!.credentials),
            resolveBaseUrl: () => params.accountExecution!.serverUrl,
        } : {}),
        // Collection admission and plugin-facing feature decisions consume the SAME
        // daemon snapshot resolver; the host does not keep a second one.
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
        // Bundled first-party and development/drop-in custody is selected by
        // this daemon, not by a portable Account release, so only those claim
        // a release-less Account intent with their admitted manifest.
        resolveReleaseLessDeclaration: (pluginId) => (
            scopedActionRuntime || !releaseLessDeclarationsByPluginId.get(pluginId)?.claimsAccountIntent
                ? null : releaseLessDeclarationsByPluginId.get(pluginId)?.manifest ?? null
        ),
        resolveReleaseLessCollectionMigrations: async (pluginId) => {
            const declaration = releaseLessDeclarationsByPluginId.get(pluginId)?.manifest;
            const target = resolveExactActivationTarget(pluginId);
            if (scopedActionRuntime || !declaration || !target) return null;
            const source = resolveCommittedActivationSource(target, { recordActivatedManifestAuthority: false });
            if (!source) return null;
            const projected = await loadCollectionMigrationModule(source, target);
            if (serializeCanonicalPluginManifest(projected.manifest) !== serializeCanonicalPluginManifest(declaration)) return null;
            return projected.module.collectionMigrations;
        },
    });
    const bindDynamicResourceAccountStorage = createPluginResourceAccountStorageResolver({
        accountStorage: accountStorageHost,
    });
    // §3.6.1: the dynamic arm of the resource family is bound to the runtime
    // producer its plugin registered during activation. The packaged arm has no
    // producer and contributes nothing here.
    const dynamicResourceProducers = committedResourceContributes.flatMap((resource): StableDynamicPluginResourceProducer[] => {
        if (!resource.pluginId || !isDynamicPluginResourceContributionV2(resource.definition)) return [];
        const pluginId = resource.pluginId;
        const localId = resource.definition.id;
        const target = resolveCanonicalResourceActivationTarget(pluginId, localId);
        if (!target) throw new Error(`Resource activation target is unavailable for '${pluginId}'`);
        const readRegisteredRuntime = () => {
            const entry = [...activatedRegistry.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === pluginId
                && candidate.registration.family === 'resources'
                && candidate.registration.localId === localId
            ));
            if (!entry || entry.registration.family !== 'resources'
                || !activatedRegistry.isPluginOccurrenceCurrent(pluginId, entry.occurrenceId)) {
                throw new PluginError({ code: 'plugin_resource_producer_unavailable',
                    message: 'Dynamic resource has no current registered runtime producer' });
            }
            return entry.registration.value;
        };
        const cold = !activatedRegistry.targetActivationFacts.some((fact) => fact.pluginId === pluginId);
        const revalidateResourceSource = async (signal: AbortSignal) => {
            if (accountActivationSources && !await accountActivationSources.revalidate(pluginId, signal)) {
                signal.throwIfAborted();
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Account Resource custody is no longer current' });
            }
        };
        type DynamicRuntime = StableDynamicPluginResourceProducer['runtime'];
        // Host-private preparation adds the optional method only when the
        // admitted registration supplies it; absence is not an undefined arm.
        const runtime: { -readonly [Key in keyof DynamicRuntime]: DynamicRuntime[Key] } = {
            async read(options) {
                await revalidateResourceSource(options.signal);
                return await readRegisteredRuntime().read(options);
            },
            observe(invalidate, options) { return readRegisteredRuntime().observe(invalidate, options); },
        };
        return [Object.freeze({
            pluginId, localId,
            hostAccessRequests: resolveManifestHostAccessRequests({
                manifest: target.manifest, pluginId,
                contribution: { family: 'resources', localId },
                requestIds: resource.definition.hostAccess,
            }),
            // Activation facts also include unavailable plugins. Resolve at
            // the Resource callback boundary so admission can contain the
            // failure and preserve activation's plugin-scoped diagnostic.
            // Eager resolution here would reject the entire daemon registry.
            runtime,
            // Resource callbacks can call the Action owner and other Resources.
            // Admit their first bytes after the complete registry is published.
            async prepareRuntime() {
                const previousFacts = activatedRegistry.targetActivationFacts;
                if (cold) await activatedRegistry.activateContributionsOnDemand([{ pluginId, family: 'resources', localId }]);
                await refreshActivatedConsumersIfChanged(previousFacts);
                const createProducer = readRegisteredRuntime().createProducer;
                if (createProducer) runtime.createProducer = async options => {
                    await revalidateResourceSource(options.signal);
                    const producer = await createProducer.call(readRegisteredRuntime(), options);
                    return {
                        async read(readOptions) {
                            await revalidateResourceSource(readOptions.signal);
                            return await producer.read(readOptions);
                        },
                        observe: (invalidate, observeOptions) => producer.observe(invalidate, observeOptions),
                        dispose: () => producer.dispose(),
                    };
                };
            },
        })];
    });
    resourcesOwner = (committed || accountActivationSources) && (
        committedResourceGenerations.size > 0 || dynamicResourceProducers.length > 0
    )
        ? await createStablePluginResourcesOwner({
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
                    const target = resolveCanonicalResourceActivationTarget(resource.pluginId,
                        isDynamicPluginResourceContributionV2(resource.definition) ? resource.definition.id : undefined)!;
                    return [Object.freeze({
                        ...resource,
                        pluginRootPath: generation?.rootPath ?? dirname(target.manifestPath),
                    })];
                }),
            },
            generations: committedResourceGenerations,
            dynamicOccurrenceIdsByPluginId: candidateOccurrenceIdsByPluginId,
            isDynamicOccurrenceCurrent: (pluginId, occurrenceId) => (
                activatedRegistry.isPluginOccurrenceCurrent(
                    pluginId,
                    occurrenceId as PluginRuntimeOccurrenceId,
                )
            ),
            dynamicProducers: scopedActionRuntime
                ? dynamicResourceProducers.filter((producer) => (
                    (producer.hostAccessRequests?.length ?? 0) === 0
                ))
                : dynamicResourceProducers,
            bindDynamicResourceAccountStorage,
            // The Account activation source and invocation own this registry's
            // authority. Receiver Settings hydration is a different lifetime.
            ...(params?.accountExecution ? { accountContext: 'admitted' as const } : {}),
            bindDynamicResourceActions: binding => createDynamicResourceActionBinding({
                binding,
                invoke: request => invokeContributedAction(request),
                readCaller: () => {
                    if (!isCurrentPluginOccurrence(binding.pluginId, binding.occurrenceId)) return null;
                    const sourceCustody = readCurrentPluginSourceCustody(binding.pluginId);
                    if (!sourceCustody) return null;
                    return Object.freeze({ kind: 'plugin' as const, pluginId: binding.pluginId,
                        occurrenceId: binding.occurrenceId, sourceCustody,
                        contribution: Object.freeze({ id: binding.resourceId, qualifiedId: `${binding.pluginId}/resources/${binding.resourceId}` }),
                    });
                },
            }),
            ...(params?.resolveSessionResourceAccess
                ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
                : {}),
            isPluginCurrent: pluginId => consumerAssembly.isPluginCurrent(pluginId)
                && (accountActivationSources?.isCurrent(pluginId) ?? true),
        })
        : undefined;
    for (const asset of authoritativeContributes.promptAssets ?? []) {
        const assetGeneration = committed?.generations.get(asset.pluginId);
        if (assetGeneration && !hasCommittedResourceActivationTarget(asset.pluginId)) {
            throw new Error(`Committed prompt asset activation target is unavailable for '${asset.pluginId}'`);
        }
    }
    const resolveRuntimeConsumerLifecycle = consumerAssembly.resolveLifecycle;
    const isPluginConsumerCurrent = (pluginId: string): boolean => consumerAssembly.isPluginCurrent(pluginId)
        && (accountActivationSources?.isCurrent(pluginId) ?? true);
    const readCurrentPluginOccurrenceId = (pluginId: string): PluginRuntimeOccurrenceId | null => isPluginConsumerCurrent(pluginId)
        ? consumerAssembly.readPluginOccurrenceId(pluginId) : null;
    const isCurrentPluginOccurrence = (pluginId: string, occurrenceId: string): boolean => (
        readCurrentPluginOccurrenceId(pluginId) === occurrenceId
    );
    async function prepareUiResourceDemand(input: Readonly<{
        callerPluginId: string;
        expectedCallerOccurrenceId: string;
        resourceId?: string;
        readAuthority?: import('@happier-dev/protocol/plugins/ui/client').PluginUiReadAuthorityReferenceV1['readAuthority'];
        signal?: AbortSignal;
    }>): Promise<void> {
        if (isCurrentPluginOccurrence(input.callerPluginId, input.expectedCallerOccurrenceId)) return;
        // A mounted cold declaration names the source-admitted desired
        // occurrence. A stale or undeclared request cannot activate code.
        if (!consumerAssembly.isOccurrenceCurrent()
            || !consumerAssembly.isPluginCurrent(input.callerPluginId)
            || candidateOccurrenceIdsByPluginId.get(input.callerPluginId) !== input.expectedCallerOccurrenceId) return;
        const localId = input.readAuthority?.consumer.localId ?? input.resourceId;
        const family = input.readAuthority ? 'actions' as const : 'resources' as const;
        const resource = input.readAuthority ? authoritativeContributes.actions.find(candidate => (
            candidate.pluginId === input.callerPluginId && candidate.definition.id === localId
        )) : committedResourceContributes.find((candidate) => (
            candidate.pluginId === input.callerPluginId
            && candidate.definition.id === localId
            && isDynamicPluginResourceContributionV2(candidate.definition)
        ));
        if (!resource || !localId || input.readAuthority && input.readAuthority.consumer.pluginId !== input.callerPluginId) return;
        if (input.signal?.aborted) {
            throw new PluginError({ code: 'plugin_resource_aborted', message: 'Resource operation was aborted' });
        }
        await activateContributionsOnDemand([{
            pluginId: input.callerPluginId, family, localId,
        }]);
    }
    const readCurrentPluginSourceCustody = (pluginId: string): PluginSourceCustody | null => isPluginConsumerCurrent(pluginId)
        ? consumerAssembly.readPluginSourceCustody(pluginId) : null;
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
    const resolveAdmittedPluginMaterializationRef = (
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null => {
        if (!isPluginConsumerCurrent(pluginId)) return null;
        let machineId: string | null | undefined;
        try {
            machineId = params?.resolveCurrentMachineId?.();
        } catch {
            return null;
        }
        const materialization = PluginMachineMaterializationRefV1Schema.safeParse({
            machineId,
            materializationId:
                authoritativeContributes.materializationIdsByPluginId?.[pluginId]
                ?? releaseLessDeclarationsByPluginId.get(pluginId)?.materializationId,
            pluginId,
        });
        return materialization.success ? Object.freeze(materialization.data) : null;
    };
    const resolveCurrentPluginMaterializationRef = (
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null => {
        // Effect callers still require an active runtime. Only the private
        // source-demand read below consumes an admitted cold declaration.
        return activatedRegistry.activatedPluginIds.has(pluginId)
            ? resolveAdmittedPluginMaterializationRef(pluginId)
            : null;
    };
    async function readConfiguredAutomationEventSourceDemand(
        pluginId: string,
        signal: AbortSignal,
    ): Promise<boolean> {
        signal.throwIfAborted();
        const accountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const target = resolveExactActivationTarget(pluginId);
        if (!target) throw new Error('automation_event_source_demand_unavailable');
        const transportKinds = new Set<AutomationEventSourcesListTransportV1['kind']>();
        for (const event of target.manifest.contributes.events ?? []) {
            if (event.kind !== 'event' || event.automation?.eligible !== true) continue;
            for (const kind of event.automation.source.supportedObservationTransports) transportKinds.add(kind);
        }
        if (transportKinds.size === 0) return false;
        const occurrenceId = candidateOccurrenceIdsByPluginId.get(pluginId);
        const sourceCustody = admittedPluginSourceCustodiesByPluginId.get(pluginId);
        const materialization = resolveAdmittedPluginMaterializationRef(pluginId);
        if (!occurrenceId || !sourceCustody || !materialization) {
            throw new Error('automation_event_source_demand_unavailable');
        }
        const credentials = await readSessionCredentials();
        signal.throwIfAborted();
        if (!credentials) throw new Error('automation_event_source_demand_unavailable');
        const transport = createAutomationEventStoredDefinitionsHttpTransportV1({
            credentials,
            revalidateCaller: async () => {
                const current = resolveAdmittedPluginMaterializationRef(pluginId);
                const currentCustody = admittedPluginSourceCustodiesByPluginId.get(pluginId);
                return current !== null
                    && arePluginMachineMaterializationRefsEqual(current, materialization)
                    && candidateOccurrenceIdsByPluginId.get(pluginId) === occurrenceId
                    && currentCustody !== undefined
                    && pluginSourceCustodyEqual(currentCustody, sourceCustody);
            },
        });
        for (const kind of transportKinds) {
            const result = await transport.read({
                caller: { pluginId, occurrenceId, sourceCustody, materialization },
                input: { transport: { kind }, pageSize: 1 },
                signal,
            });
            signal.throwIfAborted();
            if (getActiveAccountSettingsSnapshotLifetimeToken() !== accountLifetime) {
                throw new Error('automation_event_source_demand_unavailable');
            }
            // The transport has already strictly admitted the response. A
            // demand read has no known revision or cursor and requires a page.
            if (!result || typeof result !== 'object'
                || !('kind' in result) || result.kind !== 'page'
                || !('definitions' in result) || !Array.isArray(result.definitions)) {
                throw new Error('automation_event_source_demand_unavailable');
            }
            if (result.definitions.length > 0) return true;
        }
        return false;
    }
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
        const readCurrentCandidate = () => {
            const occurrenceId = readCurrentPluginOccurrenceId(pluginId);
            if (!occurrenceId) return null;
            if (authoritativeContributes.materializationIdsByPluginId?.[pluginId] !== undefined) {
                const materialization = resolveCurrentPluginMaterializationRef(pluginId);
                return materialization ? {
                    occurrenceId,
                    machineId: materialization.machineId,
                    materializationId: materialization.materializationId,
                } : null;
            }
            const sourceCustody = readCurrentPluginSourceCustody(pluginId);
            if (!sourceCustody || sourceCustody.kind === 'managed') return null;
            let machineId: string | null | undefined;
            try {
                machineId = params.resolveCurrentMachineId?.();
            } catch {
                return null;
            }
            return machineId ? { occurrenceId, machineId, sourceCustody } : null;
        };
        const before = readCurrentCandidate();
        if (!before) return null;
        let context: CurrentMachineExecutionOriginContext | null;
        try {
            context = await params.resolveCurrentMachineExecutionOriginContext(signal);
        } catch {
            return null;
        }
        signal?.throwIfAborted();
        const after = readCurrentCandidate();
        if (
            !context
            || !after
            || before.occurrenceId !== after.occurrenceId
            || context.machineId !== before.machineId
            || context.machineId !== after.machineId
        ) return null;
        const beforeOrigin = resolvePluginMachineExecutionOrigin({ pluginId, context, ...before });
        const afterOrigin = resolvePluginMachineExecutionOrigin({ pluginId, context, ...after });
        return beforeOrigin && afterOrigin && arePluginMachineExecutionOriginsEqual(beforeOrigin, afterOrigin)
            ? afterOrigin : null;
    };
    const resolveCurrentPluginApprovalReplayPlacement = async (
        pluginId: string,
        signal?: AbortSignal,
    ): ReturnType<NonNullable<ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginApprovalReplayPlacement']>> => {
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
            // Replay uses the local profile; its portable Home identity travels
            // separately to the approval origin writer, never into placement.
            serverId: configuration.activeServerId,
            machineId: context.machineId,
        });
        return placement.success ? Object.freeze({ ...placement.data, serverIdentityId: context.serverIdentityId }) : null;
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
            case 'account_release':
                return undefined;
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
                    && arePluginMachineExecutionOriginsEqual(currentOrigin, input.candidate.origin);
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
            if (!await isCandidateCurrent()) return unavailable('candidate_currentness_changed');
            projected = await loadCollectionMigrationModule(source, target);
            if (!await isCandidateCurrent()) return unavailable('candidate_currentness_changed');
            // This validates the static manifest and callback projection but
            // intentionally never invokes `activate`.
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
     * UI surfaces. Resource invalidation and admitted read-authority withdrawal
     * share this subscription owner; each producer retains its own admission.
     */
    const uiResourceWatches = createStablePluginUiResourceWatchOwner({
            resources: resourcesOwner,
            isPluginConsumerCurrent,
            readPluginOccurrenceId: (pluginId) => readCurrentPluginOccurrenceId(pluginId),
            async observeReadAuthority({ authority, context, signal, retire }) {
                const runtimeRegistry = resolvedRuntimeRegistryOwner;
                if (!runtimeRegistry) throw new PluginError({ code: 'plugin_action_registry_unavailable' });
                let subscription: import('@happier-dev/plugin-sdk').Disposable | undefined;
                const attempt = await executeContributedAction({ runtimeRegistry,
                    actionId: buildQualifiedPluginContributionKey(authority.consumer), input: authority.input,
                    requiredReadOnly: true,
                    readObservation: { authorityPurpose: authority.purpose, invalidate() {}, retire,
                        accept(value) { subscription = value; } },
                    ...(params?.scopedActionRuntime ? { actionsSettings: params.scopedActionRuntime.actionsSettingsProvider.getActionsSettings() } : {}),
                    context: { surface: 'ui', signal,
                        ...(context?.kind === 'session' ? { defaultSessionId: context.sessionId } : {}) },
                });
                if (!attempt.matched || !attempt.result.ok || !subscription) {
                    await subscription?.dispose();
                    throw new PluginError(!attempt.matched || attempt.result.ok
                        ? { code: 'plugin_action_read_observation_unavailable' }
                        : { code: attempt.result.errorCode ?? 'plugin_action_read_observation_unavailable', message: attempt.result.error });
                }
                return subscription;
            },
            ...(params?.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
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
    const retirePluginConsumers = async (pluginIds: readonly string[]) => {
        await Promise.all([
            consumerAssembly.retirePlugins(pluginIds),
            projectManagedServicesOwner.retireSharedProviderServices(pluginIds),
        ]);
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
    // Survives Agent lease rebuilds: an unchanged occurrence keeps its one daemon-owned server.
    const contributionOwnedManagedEndpointReads = createContributionOwnedManagedServiceEndpointReadHostCache();
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
            contributionOwnedManagedEndpointReads,
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
    const sessionCredentialsServerId = configuration.activeServerId;
    const sessionCredentialsHomeServerIdentityId = params?.externalActionHomeBinding?.serverIdentityId;
    const notificationServerUrl = params?.accountExecution?.serverUrl ?? configuration.serverUrl;
    const notificationServerHttpBaseUrl = params?.accountExecution?.serverUrl ?? resolveServerHttpBaseUrl();
    const sessionCredentials = await readSessionCredentials();
    // Only explicitly daemon-owned probes and admitted shared Provider bindings
    // use this Account. Absence of a Session never supplies requester evidence.
    const readDaemonManagedServiceRequester = (): RequesterWorkAttributionV1 | undefined => {
        try {
            if (!sessionCredentials || configuration.activeServerId !== sessionCredentialsServerId) return undefined;
            const accountId = readAccountIdFromToken(sessionCredentials.token);
            const machineId = params?.resolveCurrentMachineId?.();
            const requester = params?.readDaemonRequesterWorkAttribution?.();
            if (!requester || !accountId || !machineId || requester.serverId !== sessionCredentialsHomeServerIdentityId
                || requester.accountId !== accountId || requester.machineId !== machineId) return undefined;
            return requester;
        } catch { return undefined; }
    };
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
    // Remember an unchanged construction failure for diagnostic deduplication.
    // Candidate-specific refusals belong to the live configured-source owner;
    // construction failures remain retryable on demand.
    let failedExternalSessionsPublication: Readonly<{
        basis: CurrentGlobalExternalSessionsPublicationBasis;
        accountRevision: string;
        cause: string | null;
        error: string;
    }> | null = null;
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
            failedExternalSessionsPublication = null;
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
        const accountRevision = resolveActiveAccountConfiguredExternalSessionSourceRevision(
            getActiveAccountSettingsSnapshot(),
            agents.flatMap(agent => agent.richDefinition?.definition.surfaces?.externalSession.sources ?? []),
            params?.externalSessionsActiveServerId ?? null,
        );
        const previous = currentGlobalExternalSessions;
        try {
            const next = await createCurrentGlobalExternalSessionsAuthorService({
                agents,
                // activeAgents already holds current activated runtime leases;
                // project their executable facts without re-entering publication.
                resolveCatalogEntry: async (agentId) => projectActivatedAgentContributions(
                    contributes, activatedRegistry,
                    (pluginId) => isPluginConsumerCurrent(pluginId),
                    params?.resolveManagedServiceSessionBaseUrl,
                    params?.resolveManagedServiceSessionClientAccess,
                    (input) => resolveAgentPluginSettings(input),
                    bindAgentPreflightManagedServices,
                    resolveAgentPreflightManagedExecutable,
                    resolveAgentPreflightLifecycle,
                    agentId,
                    params?.agentIsolation,
                ).agents.find(agent => agent.id === agentId)?.catalogEntry ?? null,
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
            failedExternalSessionsPublication = null;
            refreshExternalSessionProjectionDiagnostics(agents, next.sourceRefusals);
            previous?.dispose();
        } catch (error) {
            // Only a host-integrity failure reaches here now — an unreadable
            // Account, or an undeclared/duplicate configured source identity the
            // host itself owns. Those make the host's own view of which sources
            // exist untrustworthy, so the service still fails closed; a single
            // candidate's admission/provider refusal no longer takes this path. Never silent:
            // this is the only record of why every caller now sees unavailable.
            previous?.dispose();
            currentGlobalExternalSessions = null;
            currentGlobalExternalSessionsPublicationBasis = null;
            refreshExternalSessionProjectionDiagnostics(
                Object.freeze([]),
                Object.freeze([]),
            );
            const failure = Object.freeze({
                basis: publicationBasis,
                accountRevision,
                cause: readExternalSessionsFailureCause(error),
                error: error instanceof Error ? error.message : String(error),
            });
            const alreadyReported = isDeepStrictEqual(failedExternalSessionsPublication, failure);
            failedExternalSessionsPublication = failure;
            if (alreadyReported) return;
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
                if (!target) {
                    return { status: 'unavailable' };
                }
                const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                    readCurrentPluginOccurrenceId(target.pluginId)!,
                    `${caller.contribution.qualifiedId}:external-sessions`,
                );
                return {
                    status: 'available',
                    scopes: resolveHostApplicableExternalSessionsPublicScopes({
                        scopes: binding.sessionScopes
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
        redact(value: string): string;
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
            const serviceBinding = resolveDeclaredInvocationServiceBinding(runtimeSeed);
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
                redact: (value: string) => invocationServiceOwners.redactDiagnosticText({
                    pluginId: runtimeSeed.plugin.id,
                    occurrenceId: runtimeSeed.occurrenceId,
                    correlationId: runtimeSeed.correlationId,
                }, value),
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }
    const mcpDiscoveryAttachments = new Map<string, Readonly<{
        endpoints: NonNullable<PluginMcpDiscoveryResult['endpoints']>;
        detectedServers?: PluginMcpDiscoveryResult['detectedServers'];
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
                async listTools(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.listTools(request, context, options)), redact);
                    } finally {
                        lifetime.complete();
                    }
                },
                async callTool(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.callTool(request, context, options)), redact);
                    } finally {
                        lifetime.complete();
                    }
                },
                async listResources(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.listResources(request, context, options)), redact);
                    } finally {
                        lifetime.complete();
                    }
                },
                async listResourceTemplates(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.listResourceTemplates(request, context, options)), redact);
                    } finally {
                        lifetime.complete();
                    }
                },
                async readResource(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.readResource(request, context, options)), redact);
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
                async listPrompts(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.listPrompts(request, context, options)), redact);
                    } finally {
                        lifetime.complete();
                    }
                },
                async getPrompt(request, callerSeed, options, projectResult) {
                    const { context, lifetime, redact } = createMcpTargetContext({
                        ref, family: 'mcp.servers', entry, pluginVersion, callerSeed,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    try {
                        return projectResult(await invokePeer(() => runtime.getPrompt(request, context, options)), redact);
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
                                ...(result.detectedServers ? { detectedServers: Object.freeze([...result.detectedServers]) } : {}),
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
        ...(params?.connectedAccounts ? { purposeHost: createConnectedAccountPluginHttpPurposeHost(params.connectedAccounts, {
            registerRawForRedaction(seed, value) { invocationServiceOwners.registerRawForRedaction(seed, value); },
        }) } : {}),
        containsRegisteredSecret({ seed, value }) {
            return invocationServiceOwners.containsRegisteredDiagnosticValue({
                pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId,
            }, value);
        },
        adapter: createGlobalFetchRuntime(),
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
                                if (context.physicalSourceCustody) {
                                    return context.isCurrent()
                                        && provider.definition.managedRuntime?.sharing === 'connectionMachine'
                                        && context.physicalSourceCustody.kind === 'managed'
                                        && generation.immutableGenerationId === context.physicalSourceCustody.immutableGenerationId
                                        && isRetainedPhysicalSourceCurrent?.(context.pluginId, context.occurrenceId, context.physicalSourceCustody) === true;
                                }
                                return context.isCurrent()
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
        readSpawnFailureLimits: params?.readSpawnFailureLimits,
        custodyOwner: 'daemon',
    });
    const daemonManagedServicesHostBindings = {
        dependencies: (scope) => managedDependencies.bind(scope.pluginId),
        async resolveManagedExecutable(scope, executable, isCurrent) {
            const source = scope.sourceCustody;
            const provider = (authoritativeContributes.providers ?? []).find(candidate => (
                `${candidate.identity.pluginId}/providers/${candidate.identity.localId}` === scope.contributionQualifiedId
                && candidate.identity.pluginId === scope.pluginId
                && candidate.definition.managedRuntime?.sharing === 'connectionMachine'
            ));
            const sourceCurrent = () => Boolean(source && isCurrent()
                && isRetainedPhysicalSourceCurrent?.(scope.pluginId, scope.occurrenceId, source) === true);
            if (!source || !provider || !sourceCurrent()) throw new PluginError({
                code: 'plugin_packaged_runtime_binary_unavailable', message: 'Retained managed Provider executable source is unavailable',
            });
            const resolved = await executableResolver(executable, scope.pluginId, Object.freeze({
                kind: 'managedProviderRuntime' as const, pluginId: scope.pluginId,
                providerLocalId: provider.identity.localId, contributionQualifiedId: scope.contributionQualifiedId,
                occurrenceId: scope.occurrenceId, physicalSourceCustody: source, isCurrent: sourceCurrent,
            }));
            if (!sourceCurrent()) {
                resolved.release?.();
                throw new PluginError({ code: 'plugin_packaged_runtime_binary_unavailable', message: 'Retained managed Provider executable source changed' });
            }
            return resolved;
        },
        async resolveNativeLifecycle(scope, instance, admission) {
            const scopeIsCurrent = (): boolean => {
                try {
                    return !scope.signal?.aborted
                        && scope.isOccurrenceCurrent() === true
                        && scope.occurrenceId === readCurrentPluginOccurrenceId(scope.pluginId)
                        && isPluginConsumerCurrent(scope.pluginId);
                } catch {
                    return false;
                }
            };
            if (!scopeIsCurrent()) return null;
            const resolution = await resolvedRuntimeRegistryOwner?.resolveProjectNativeAdapter(
                instance.adapter,
                'nativeServiceLifecycle',
            );
            if (!scopeIsCurrent() || resolution?.kind !== 'ready' || resolution.lease.isCurrent() !== true) {
                return null;
            }
            // Use the incumbent exec authorizer to resolve the SDK's cwd/path and
            // effective environment. This is admission, not another starter.
            const launch = await authorizePluginExecLaunchForHost(admission.exec, admission.launch, { agentIsolation: null });
            const captured = await (async () => {
                try {
                    return resolution.lease.captureNativeServiceLifecycle(instance, {
                        // An omitted cwd has exactly the OS spawn owner's current directory.
                        root: launch.cwd ?? process.cwd(), environment: launch.env,
                    });
                } finally { await launch.release(); }
            })();
            if (!scopeIsCurrent() || resolution.lease.isCurrent() !== true || captured.kind !== 'ready') {
                return null;
            }
            return Object.freeze({
                ...captured.lifecycle,
                async stop(...args: Parameters<typeof captured.lifecycle.stop>) {
                    const result = await captured.lifecycle.stop(...args);
                    if (result.status === 'stopped') await captured.release();
                    return result;
                },
            });
        },
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
            const gateway = managedProvider?.sharedGateway;
            const requester = gateway ? readDaemonManagedServiceRequester() : undefined;
            return Object.freeze({
                ...seed,
                ...(requester && gateway && requester.accountId === gateway.accountId && requester.machineId === gateway.machineId
                    ? { requesterWorkAttributionV1: requester } : {}),
                ...(context?.declaredSecretReadPort
                    ? {
                        declaredSecretReadPort:
                            context.declaredSecretReadPort,
                    }
                    : {}),
            });
        },
    } satisfies Omit<Parameters<typeof createManagedServicesOwner>[0], 'processSupervisorHost' | 'sharedGatewayAccessDirectory'>;
    const daemonManagedServicesOwner = createManagedServicesOwner({
        ...daemonManagedServicesHostBindings,
        processSupervisorHost: daemonManagedServiceProcessSupervisorHost,
        projectServiceStateDirectory: join(pluginStorePaths.storageDir, 'project-services'),
        sharedGatewayAccessDirectory: join(pluginStorePaths.storageDir, 'managed-provider-consumers'),
    });
    let projectManagedServicesOwner: ReturnType<NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['retainProjectManagedServicesOwner']
    >> = daemonManagedServicesOwner;
    let preserveProjectServicesOnRegistryRetirement = false;
    let isRetainedPhysicalSourceCurrent: Parameters<NonNullable<ResolvedExecutablePluginRuntimeRegistry['retainProjectManagedServicesOwner']>>[1];
    // Ordinary invocation services remain root-owned. Only the canonical
    // admitted shared binding transfers into the retained generic owner.
    const invocationManagedServicesOwner: ManagedServicesInvocationOwner = {
        isAvailable: daemonManagedServicesOwner.isAvailable,
        bind: daemonManagedServicesOwner.bind,
        bindWithExec(seed, exec, context) {
            return (context.managedProvider?.sharedGateway ? projectManagedServicesOwner : daemonManagedServicesOwner)
                .bindWithExec!(seed, exec, context);
        },
        retireGeneration: daemonManagedServicesOwner.retireGeneration,
        async projectManagedProviderEndpointAccess(input) {
            const ordinary = await daemonManagedServicesOwner.projectManagedProviderEndpointAccess!(input);
            return ordinary ?? (projectManagedServicesOwner === daemonManagedServicesOwner ? null
                : await projectManagedServicesOwner.projectManagedProviderEndpointAccess!(input));
        },
    };
    async function resolveAgentPreflightManagedExecutable(input: Readonly<{
        pluginId: string; executable: Extract<ManagedExecutableRef, { kind: 'managedDependency' }>;
        isCurrent(): boolean;
    }>): Promise<ResolvedPluginExecutable> {
        if (!input.isCurrent() || !isPluginConsumerCurrent(input.pluginId)) {
            throw new Error('Agent preflight managed executable belongs to a retired occurrence');
        }
        const resolved = await managedDependencies.resolveExecutable(input.executable, input.pluginId, { requireReady: true });
        if (!input.isCurrent() || !isPluginConsumerCurrent(input.pluginId)) {
            resolved.release();
            throw new Error('Agent preflight managed executable belongs to a retired occurrence');
        }
        return resolved;
    }
    function bindAgentPreflightManagedServices(input: Readonly<{
        pluginId: string; localAgentId: string; occurrenceId: string;
        exec: ExecService; signal: AbortSignal; isCurrent(): boolean;
    }>): PluginServices['managedServices'] {
        const isCurrent = () => input.isCurrent()
            && readCurrentPluginOccurrenceId(input.pluginId) === input.occurrenceId
            && isPluginConsumerCurrent(input.pluginId);
        if (!isCurrent()) throw new Error('Agent preflight managed service belongs to a retired occurrence');
        const requester = readDaemonManagedServiceRequester();
        return daemonManagedServicesOwner.bindScope({
            pluginId: input.pluginId, occurrenceId: input.occurrenceId,
            contributionQualifiedId: `${input.pluginId}/agents/${input.localAgentId}`,
            operationId: randomUUID(), signal: input.signal, isOccurrenceCurrent: isCurrent,
            ...(requester ? { requesterWorkAttributionV1: requester } : {}),
            ...(readCurrentPluginSourceCustody(input.pluginId) ? { sourceCustody: readCurrentPluginSourceCustody(input.pluginId)! } : {}),
        }, input.exec);
    }
    declaredMcpTransportConnector = createStableDeclaredMcpTransportConnector({
        resolveExecutable: executableResolver,
    });
    // Initial adoption precedes the health consumers; later adoptions reconcile
    // synchronously after the canonical source snapshot has been replaced.
    let reconcileAdoptedHealthChecks: (() => void) | undefined;
    const automationAssembly = await assembleAutomationRuntime({
        credentials: sessionCredentials,
        ...(sessionCredentials ? { readHealthSources: createCliHealthCheckSourceSnapshotReader({
            credentials: sessionCredentials, serverHttpBaseUrl: notificationServerHttpBaseUrl,
            signal: consumerAssembly.allRetirementSignal,
        }) } : {}),
        activationTargets: authoritativeContributes.activationTargets,
        activatedPluginIds: { has: pluginId => activatedRegistry.activatedPluginIds.has(pluginId) },
        resolveCurrentMaterialization: resolveCurrentPluginMaterializationRef,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        resolveConsumerLifecycle: resolveRuntimeConsumerLifecycle,
        revalidateCallerMaterialization: revalidatePluginActionCallerMaterialization,
        revalidateCallerOccurrence: revalidatePluginActionCallerOccurrence,
        onAdopted: () => reconcileAdoptedHealthChecks?.(),
    });
    const resolveAutomationEventAdoptedDefinitionSet =
        automationAssembly.resolveAdoptedDefinitionSet;
    const resolveAutomationEventHistoryGapSource =
        automationAssembly.resolveHistoryGapSource;
    const createAccountSourceMachineResolver = (seed: PluginInvocationServicesSeed): PluginInvocationServicesSeed['resolveAccountSourceMachine'] => {
        const authority = params?.accountExecution;
        if (!authority) return undefined;
        const declaration = readResolvedActionContribution(authoritativeContributes, { pluginId: seed.plugin.id,
            localId: seed.contribution.id })?.definition.sessionTarget;
        const context = seed.approvalContext;
        const defaultSessionId = seed.session?.id;
        const explicitMachineId = authority.explicitMachineId
            ?? (context?.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined)
            ?? context?.executionRunTargetMachineId;
        if (!explicitMachineId && declaration?.cardinality !== 'one' && !defaultSessionId) return undefined;
        let selection: ReturnType<typeof resolveAccountMachineSourceActionMachine> | undefined;
        return () => selection ??= resolveAccountMachineSourceActionMachine({ ...authority,
            ...(defaultSessionId ? { defaultSessionId } : {}),
            ...(explicitMachineId ? { explicitMachineId } : {}), declaration, input: seed.actionInput, signal: seed.signal });
    };
    const readAccountMachineSourceDeclarations = params?.accountExecution
        ? createAccountMachineSourceDeclarationReader(params.accountExecution) : undefined;
    const readCurrentAccountTargetedDeclarations = async (targetPluginId: string, signal?: AbortSignal,
        resolveMachine?: PluginInvocationServicesSeed['resolveAccountSourceMachine']): Promise<TargetedContributionManifestSnapshot> => {
        const accountDeclarations = (authoritativeContributes.pluginDeclarations ?? []).flatMap(declaration => {
            const occurrenceId = readCurrentPluginOccurrenceId(declaration.pluginId);
            const sourceCustody = readCurrentPluginSourceCustody(declaration.pluginId);
            return occurrenceId && sourceCustody ? [{ manifest: declaration.manifest, occurrenceId, sourceCustody }] : [];
        });
        let machineSnapshot: TargetedContributionManifestSnapshot = { declarations: [] };
        let machineId: string | undefined;
        try {
            // Missing Session placement removes Machine sources only. Account
            // sources remain usable, and never borrow an ambient Machine.
            if (resolveMachine) {
                const selection = await resolveMachine(signal);
                if (selection.status === 'available') machineId = selection.machineId;
            } else machineId = params?.accountExecution?.machineId;
        } catch { signal?.throwIfAborted(); }
        if (machineId && params?.accountExecution) {
            try {
                machineSnapshot = await readAccountMachineSourceDeclarations!({ machineId, targetPluginId, ...(signal ? { signal } : {}) });
            } catch { signal?.throwIfAborted(); }
        }
        return {
            declarations: mergeTargetedContributionManifestDeclarations({ targetPluginId, accountDeclarations, machineDeclarations: machineSnapshot.declarations }),
            unavailablePlugins: [...(authoritativeContributes.unavailablePlugins ?? []), ...(machineSnapshot.unavailablePlugins ?? [])],
        };
    };
    const invokeContributedActionInRegistry = async (
        request: Parameters<InvokeContributedAction>[0],
        runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null,
    ): ReturnType<InvokeContributedAction> => {
        if (!runtimeRegistry) {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_action_registry_unavailable',
                message: 'Plugin action registry is not yet committed',
                actionHandlerInvocation: 'notStarted' as const,
            });
        }
        if (params?.accountExecution) {
            const definition = readResolvedActionContribution(runtimeRegistry.contributes, request.action)?.definition;
            const localAccountAction = typeof definition?.execution === 'object' && definition.execution !== null
                && 'target' in definition.execution && definition.execution.target === 'account';
            if (!localAccountAction) {
                const selection = request.resolveAccountSourceMachine ? await request.resolveAccountSourceMachine(request.signal)
                    : await resolveAccountMachineSourceActionMachine({ ...params.accountExecution,
                        ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
                        declaration: definition?.sessionTarget, input: request.input, signal: request.signal });
                if (selection.status === 'unavailable') return selection;
                const machineId = selection.machineId;
                if (!machineId) return { status: 'unavailable' as const, code: 'plugin_action_machine_required',
                    message: 'This source requires a selected Machine', actionHandlerInvocation: 'notStarted' as const };
                const callerManifest = authoritativeContributes.pluginDeclarations?.find(declaration => declaration.pluginId === request.caller.pluginId)?.manifest;
                const callerSourceCustody = readCurrentPluginSourceCustody(request.caller.pluginId);
                if (!callerManifest || !callerSourceCustody || !request.caller.sourceCustody || !request.caller.occurrenceId
                    || readCurrentPluginOccurrenceId(request.caller.pluginId) !== request.caller.occurrenceId
                    || !pluginSourceCustodyEqual(callerSourceCustody, request.caller.sourceCustody)) return {
                    status: 'unavailable' as const, code: 'plugin_action_generation_retired', message: 'The Account caller is retired',
                    actionHandlerInvocation: 'notStarted' as const };
                const { declarations: sources } = await readAccountMachineSourceDeclarations!({ machineId,
                    targetPluginId: request.caller.pluginId, sourcePluginId: request.action.pluginId, signal: request.signal });
                const source = sources.find(row => row.manifest.id === request.action.pluginId
                    && (request.expectedContributorOccurrenceId === undefined || row.occurrenceId === request.expectedContributorOccurrenceId)
                    && (request.admittedTargetedOperation === undefined
                        || row.occurrenceId === request.admittedTargetedOperation.contributorOccurrenceId)
                    && row.manifest.contributes.actions.some(action => action.id === request.action.localId && action.execution.target === 'daemon'));
                if (!source) return { status: 'unavailable' as const, code: 'plugin_action_handler_missing',
                    message: 'The selected Machine has no current source Action', actionHandlerInvocation: 'notStarted' as const };
                if (!await accountActivationSources!.revalidate(request.caller.pluginId, request.signal)) return {
                    status: 'unavailable' as const, code: 'plugin_action_generation_retired', message: 'The Account caller is retired',
                    actionHandlerInvocation: 'notStarted' as const };
                return await invokeAccountMachineSourceAction({ ...params.accountExecution, machineId, request,
                    callerManifest, callerSourceCustody, source });
            }
        }
        const definition = readResolvedActionContribution(runtimeRegistry.contributes, request.action)?.definition;
        const accountTarget = typeof definition?.execution === 'object' && definition.execution !== null
            && 'target' in definition.execution && definition.execution.target === 'account';
        const requester = request.requesterAccount;
        // Only this runtime's own Account may borrow its credentials: local
        // ingress, or a current custodian Machine admission. A guest admission,
        // another Account's attributed work (e.g. its automation), or received
        // requester/Session authority must carry its own requester.
        const custody = !requester && accountTarget && !params?.accountExecution && sessionCredentials
            ? await import('@/daemon/lifecycle/requesterWorkAttribution') : null;
        const attributedAccountId = custody?.projectRpcRequesterWorkAttribution(request.approvalContext,
            request.approvalContext?.serverId ?? sessionCredentialsServerId)?.accountId;
        const localAccountCredentials = custody
            && (attributedAccountId === undefined || attributedAccountId === readAccountIdFromToken(sessionCredentials!.token))
            && !custody.carriesNonLocalRequesterAuthority(request.approvalContext)
            && await custody.canUseCustodianAccountForMachineRequest({ ...request.approvalContext, signal: request.signal })
            ? sessionCredentials : null;
        const accountCredentials = requester?.credentials ?? localAccountCredentials;
        const accountOperation = requester ?? (localAccountCredentials ? savedSecretOperationContext : undefined);
        const accountServerId = request.approvalContext?.serverId ?? sessionCredentialsServerId;
        const accountSessionCrypto = !params?.accountExecution && accountTarget && accountCredentials
            ? resolveSessionEncryptionContextFromCredentials(accountCredentials) : null;
        const accountAttempt = !params?.accountExecution && accountTarget && accountCredentials
            && !request.captureExecutionOrigin && !request.expectedExecutionOrigin && !request.expectedExecutionRouting
            ? await (await import('@/session/actions/executeAccountPluginAction')).executeAccountPluginAction({
                host: {
                    credentials: accountCredentials,
                    serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? notificationServerHttpBaseUrl,
                    serverId: accountServerId,
                    ...(accountOperation ? { savedSecretOperationContext: accountOperation,
                        isCredentialCurrent: () => accountOperation.isCurrent(request.signal) } : {}),
                    ...(params?.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
                },
                deps: (await import('@/session/actions/createCliActionDeps')).createCliActionDeps({
                    token: accountCredentials.token,
                    credentials: accountCredentials,
                    sessionId: request.sessionId ?? '',
                    ...(accountSessionCrypto ? { mode: 'e2ee' as const, ctx: accountSessionCrypto }
                        : { mode: 'plain' as const, ctx: null }),
                    serverId: accountServerId,
                    serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? notificationServerHttpBaseUrl,
                    ...(accountOperation ? { savedSecretOperationContext: accountOperation } : {}),
                }),
                actionId: formatQualifiedPluginActionId(request.action),
                input: request.input,
                context: { ...request.approvalContext, serverId: accountServerId, surface: 'plugin', authority: 'account_automation',
                    expectedContributedActionOccurrenceId: request.expectedContributorOccurrenceId,
                    actionCaller: request.initiatingActionCaller,
                    ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}), signal: request.signal },
                inheritedInvocation: {
                    caller: request.caller,
                    ...(request.requestId === undefined ? {} : { operationRequestId: request.requestId }),
                    ...(request.requiredDangerLevel ? { requiredDangerLevel: request.requiredDangerLevel } : {}),
                    ...(request.requiredReadOnly ? { requiredReadOnly: request.requiredReadOnly } : {}),
                    ...(request.resourceSessionId ? { resourceSessionId: request.resourceSessionId } : {}),
                    ...(request.readObservation ? { readObservation: request.readObservation } : {}),
                    ...(request.admittedTargetedOperation && request.beforeHandlerInvocation ? {
                        inheritedTargetedOperation: {
                            targetProtocol: request.admittedTargetedOperation.targetProtocol,
                            beforeHandlerInvocation: request.beforeHandlerInvocation,
                        },
                    } : {}),
                },
            }) : null;
        if (accountAttempt?.matched) return projectContributedActionExecuteResult(accountAttempt.result);
        const attempt = await executeContributedAction({
            runtimeRegistry,
            ...(params?.accountExecution && sessionCredentials ? {
                requestCurrentIntent: createCredentialedTargetActionCurrentIntent(sessionCredentials),
            } : {}),
            ...(request.approvalContext ? { approvalContext: request.approvalContext } : {}),
            actionId: buildQualifiedPluginContributionKey(
                createPluginContributionIdentity({
                    pluginId: request.action.pluginId,
                    localId: request.action.localId,
                }),
            ),
            input: request.input,
            ...(request.expectedContributorOccurrenceId === undefined ? {} : { expectedContributorOccurrenceId: request.expectedContributorOccurrenceId }),
            ...(request.requiredDangerLevel ? { requiredDangerLevel: request.requiredDangerLevel } : {}),
            ...(request.requiredReadOnly ? { requiredReadOnly: true as const } : {}),
            ...(request.resourceSessionId ? { resourceSessionId: request.resourceSessionId } : {}),
            ...(request.readObservation ? { readObservation: request.readObservation } : {}),
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
            ...(request.expectedExecutionRouting === undefined
                ? {}
                : { expectedExecutionRouting: request.expectedExecutionRouting }),
            ...(request.admittedTargetedOperation === undefined
                ? {}
                : {
                    admittedTargetedOperation: request.admittedTargetedOperation,
                }),
            context: {
                surface: request.surface,
                ...(request.requestId === undefined ? {} : { operationRequestId: request.requestId }),
                ...(request.originSurface ? { originSurface: request.originSurface } : {}),
                caller: request.caller,
                ...(request.initiatingActionCaller ? { initiatingActionCaller: request.initiatingActionCaller } : {}),
                ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
                ...(params?.accountExecution || request.beforeHandlerInvocation ? { beforeHandlerInvocation: async () => {
                    if (params?.accountExecution
                        && await accountActivationSources?.revalidate(request.caller.pluginId, request.signal) !== true) {
                        throw new PluginError({ code: 'plugin_action_generation_retired', message: 'The Account caller is retired' });
                    }
                    await request.beforeHandlerInvocation?.();
                } } : {}),
                signal: request.readObservation ? composePluginConsumerSignal(request.action.pluginId, request.signal) : request.signal,
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
    };
    const runtimeRegistryController = params?.runtimeRegistryController;
    const invokeContributedAction: InvokeContributedAction = async request => {
        const lease = runtimeRegistryController?.tryAcquireRuntimeRegistry();
        try {
            // Retained activation components outlive the registry that made
            // their SDK context. Admission still runs through the current
            // registry's canonical handler/caller/authority checks.
            return await invokeContributedActionInRegistry(request, runtimeRegistryController
                ? lease?.registry ?? null : resolvedRuntimeRegistryOwner);
        } finally {
            await lease?.release();
        }
    };
    const listContributedActionDefinitions = runtimeRegistryController
        ? createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => runtimeRegistryController.tryAcquireRuntimeRegistry(),
        })
        : (selection: Parameters<typeof listRuntimeContributedActionDefinitions>[1]) =>
            listRuntimeContributedActionDefinitions(resolvedRuntimeRegistryOwner, selection);
    const pluginActionMachineId = params?.resolveCurrentMachineId?.();
    const pluginActionExecutor = sessionCredentials
        ? createCliActionExecutorFromCredentials({
            credentials: sessionCredentials,
            readCredentials: readSessionCredentials,
            ...(savedSecretOperationContext ? { savedSecretOperationContext } : {}),
            serverId: configuration.activeServerId,
            serverApiUrl: resolveServerHttpBaseUrl(),
            ...(pluginActionMachineId ? { machineId: pluginActionMachineId } : {}),
            ...params?.externalActionHomeBinding,
            ...(runtimeRegistryController || params?.accountExecution
                ? { pluginActionExecutionOwner: 'current_process' as const } : {}),
            ...(params?.accountExecution ? {
                // This runtime already owns Account admission and any explicit
                // nested Machine dispatch; do not re-enter daemon placement.
                serverId: params.accountExecution.serverId ?? configuration.activeServerId,
                serverApiUrl: params.accountExecution.serverUrl,
                ...(params.accountExecution.serverIdentityId
                    ? { serverIdentityId: params.accountExecution.serverIdentityId } : {}),
            } : {}),
            ...(params?.scopedActionRuntime
                ? { actionsSettingsProvider: params.scopedActionRuntime.actionsSettingsProvider }
                : {}),
            ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
            ...(params?.machineAdmissionTransport
                ? { machineAdmissionTransport: params.machineAdmissionTransport }
                : {}),
            resolvePluginNotifications: () => invocationServiceOwners.notifications,
            readPluginVoiceProviders: () => resolvedRuntimeRegistryOwner?.contributes.voiceProviders ?? [],
            listContributedActionDefinitions,
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerOccurrence,
            invokeContributedAction: createHostContributedActionInvoker({
                invokeContributedAction,
                revalidatePluginActionCallerMaterialization,
                revalidatePluginActionCallerOccurrence,
                ...(params?.resolveCurrentMachineExecutionOriginContext ? { resolveCurrentPluginExecutionOrigin } : {}),
            }),
            resolveAutomationEventAdoptedDefinitionSet,
            ...(params?.resolveAuthenticatedAccountId
                ? { resolveAuthenticatedAccountId: params.resolveAuthenticatedAccountId } : {}),
            acquireAutomationEventObservationRegistry: async () => {
                const lease = runtimeRegistryController?.tryAcquireRuntimeRegistry();
                if (lease) return lease;
                // Finite hosts borrow their invocation's already-owned registry.
                const registry = runtimeRegistryController ? null : resolvedRuntimeRegistryOwner;
                if (!registry) throw Object.assign(new Error('deployment_target_role_unavailable'), { code: 'deployment_target_role_unavailable' });
                return { registry, release: async () => {} };
            },
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
    const accountTargetedContributions: StableTargetedContributionsOwner | undefined = params?.accountExecution
        ? { bind(binding) { return createManifestTargetedContributionsService({
            readCurrentDeclarations: () => readCurrentAccountTargetedDeclarations(binding.pluginId, binding.signal),
            // A finite CLI invocation does not replace its admitted source set;
            // release/Account retirement is enforced by the captured binding.
            subscribeToCatalogChanges: () => () => {},
        }).bind(binding); } } : undefined;
    const accountExecution = params?.accountExecution;
    const accountSettingsRecordAdapter = params?.accountSettingsRecordAdapter
        ?? (accountExecution ? createAccountPluginSettingsRecordStorage({
            readCredentials: readSessionCredentials,
            isCurrentAccount: async () => await accountExecution.isCredentialCurrent?.() !== false
                && accountExecution.isCurrent(),
            resolveBaseUrl: () => accountExecution.serverUrl,
        }) : undefined);
    const currentDomainEdgeObservation = createCurrentDomainEdgeObservation();
    consumerAssembly.allRetirementSignal.addEventListener('abort', () => currentDomainEdgeObservation.dispose(), { once: true });
    const notificationAccountId = sessionCredentials ? readAccountIdFromToken(sessionCredentials.token) : null;
    if (!accountExecution && sessionCredentials && notificationAccountId) {
        // The observer's admitted Account/Home already owns this push feed. Domain and Environment
        // writes by any entitled client invalidate its current fact without another probe or timer.
        const accountChanges = acquireRequesterAccountEncryptionCurrentness({ accountId: notificationAccountId,
            token: sessionCredentials.token, serverBaseUrl: notificationServerHttpBaseUrl });
        const unsubscribe = accountChanges.subscribeEnvironmentAccess(change => {
            if (change.kind === 'changes') {
                for (const environmentId of change.environmentIds) currentDomainEdgeObservation.withdraw(environmentId);
            } else currentDomainEdgeObservation.reconcile(() => false);
        });
        consumerAssembly.allRetirementSignal.addEventListener('abort', () => {
            unsubscribe();
            void accountChanges.dispose();
        }, { once: true });
    }
    // Reuse the runtime's captured Account scope for finite health transports.
    const readHealthCheckCredentials = async () => {
        const current = await readSessionCredentials();
        return current && sessionCredentials && readAccountIdFromToken(current.token)
            && readAccountIdFromToken(current.token) === readAccountIdFromToken(sessionCredentials.token)
            ? current : null;
    };
    const heartbeatClient = createPluginWebhookHeartbeatClient({
        readCredentials: readHealthCheckCredentials,
        serverHttpBaseUrl: notificationServerHttpBaseUrl,
    });
    const resolveHealthCheckSourceOwner = () => {
        const caller = resolveCurrentPluginMaterializationRef(HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1);
        const occurrenceId = readCurrentPluginOccurrenceId(HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1);
        return caller && occurrenceId ? { caller, occurrenceId } : null;
    };
    invocationServiceOwners = createProductionPluginInvocationServiceOwners({
        readSecretSources: () => resolvedRuntimeRegistryOwner?.secretSources,
        resolveRetirementSignal: pluginId => resolveRuntimeConsumerLifecycle(pluginId).retirementSignal,
        ...(!params?.accountExecution ? { healthChecks: createSavedHealthChecksHost({
            serverId: sessionCredentialsServerId,
            homeServerIdentityId: await resolveServerProfileHomeIdentityId(sessionCredentialsServerId),
            resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet,
            readKinds: () => (authoritativeContributes.healthCheckKinds ?? []).map(entry => ({
                pluginId: entry.pluginId, ...entry.definition,
            })),
            resolveSourceOwner: resolveHealthCheckSourceOwner,
            readSavedSource: sourceInstanceId => automationAssembly.readHealthAlertSource(sourceInstanceId),
            readAccountSettings: async signal => {
                const credentials = await readHealthCheckCredentials();
                if (!credentials) throw new PluginError({ code: 'account_settings_unavailable', message: 'Account settings are unavailable' });
                const accountId = readAccountIdFromToken(credentials.token);
                const snapshot = await runWithServerHttpBaseUrl(notificationServerHttpBaseUrl, () => bootstrapAccountSettingsContext({
                    credentials, signal, mode: 'blocking', publication: 'invocation', refresh: 'force', honorAccountSettingsModeEnv: false,
                }));
                if (!accountId || snapshot.source === 'none' || snapshot.scopeKey !== resolveAccountSettingsScopeKey(credentials)) {
                    throw new PluginError({ code: 'account_settings_unavailable', message: 'Account settings are unavailable' });
                }
                return { accountId, settings: snapshot.settings };
            },
            enrollHeartbeat: heartbeatClient.enroll,
            readHeartbeatReceipt: heartbeatClient.read,
            manageHeartbeat: heartbeatClient.manage,
            onDomainResult: value => currentDomainEdgeObservation.publish(value),
            onServiceResult: value => publishSavedServiceHealthResult(projectManagedServicesOwner, value),
            openDomainArtifact: async (artifactId, signal) => {
                const current = await readHealthCheckCredentials();
                if (!current) return null;
                const artifact = await runWithServerHttpBaseUrl(notificationServerHttpBaseUrl,
                    () => createCredentialedAccountArtifactStore(current).read(artifactId,
                        { signal, prepareRecipients: false, includeSharedAudience: false }));
                return artifact && typeof artifact.body === 'string'
                    ? { artifactId: artifact.artifactId, header: artifact.header, body: artifact.body, revision: artifact.revision }
                    : null;
            },
            readObserver: () => {
                const machineId = params?.resolveCurrentMachineId?.();
                const identity = readInstallationIdentityIfExistsSync();
                return machineId && identity ? { machineId, installationId: identity.installationId } : null;
            },
        }) } : {}),
        ...(!params?.accountExecution ? {
            demandBackgroundService: (target) => activatedRegistry.demandBackgroundService(target),
        } : {}),
        ...(params?.stableEventsBroker
            ? { eventsBroker: params.stableEventsBroker }
            : {}),
        ...(accountSettingsRecordAdapter
            ? { accountSettingsRecordAdapter }
            : {}),
        ...(accountCredentialAuthority ? { accountCredentialAuthority } : {}),
        ...(pluginActionExecutor ? { actionExecutor: pluginActionExecutor } : {}),
        resolveCurrentPluginMaterializationRef,
        ...(params?.resolveCurrentMachineExecutionOriginContext ? { resolveCurrentPluginExecutionOrigin } : {}),
        invokeContributedAction,
        ...((params?.targetedContributions ?? accountTargetedContributions)
            ? { targetedContributions: params?.targetedContributions ?? accountTargetedContributions }
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
                        materializeAttachment: async (input) => {
                            const rpc = params?.resolveComposerMediaStageTransferRpcHandler?.();
                            if (!rpc) throw new PluginError({
                                code: 'plugin_session_attachment_unavailable',
                                message: 'The local Session attachment transfer owner is unavailable',
                                retryable: true,
                            });
                            return await materializePluginSessionAttachment({ ...input, rpc });
                        },
                        executeMessageAction: async ({ sessionId, request, signal }) => (
                            await executePluginSessionMessageAction({
                                execute: async (actionId, input, context) => (
                                    await pluginActionExecutor!.execute(actionId, input, context)
                                ),
                                pluginId: seed.plugin.id,
                                contributionLocalId: seed.contribution.id,
                                occurrenceId,
                                sourceCustody,
                                ...(seed.initiatingActionCaller ? { initiatingActionCaller: seed.initiatingActionCaller } : {}),
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
                        serverUrl: notificationServerUrl,
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
                                        })
                                        : null;
                                },
                            })(sessionId)
                        ),
                    });
                },
            },
        } : {}),
        async isOccurrenceCurrent(action) {
            return isPluginConsumerCurrent(action.pluginId)
                && action.occurrenceId === readCurrentPluginOccurrenceId(action.pluginId)
                && activatedRegistry.activatedPluginIds.has(action.pluginId);
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
            logger.warn('[PLUGIN RUNTIME] Settings group excluded: its declaration is invalid', {
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
        // Activation is live after serving startup; retain the canonical
        // membership reader, not the getter's cold-start Set projection.
        activePluginIds: { has: pluginId => activatedRegistry.activatedPluginIds.has(pluginId) },
        notifications: {
            categories: authoritativeContributes.notifications ?? Object.freeze([]),
            channels: authoritativeContributes.notificationChannels ?? Object.freeze([]),
            readAttentionPolicy: () => scopedActionRuntime ? undefined : getActiveAccountSettingsSnapshot()?.settings.attentionDeliveryPolicyV1,
            ...(!scopedActionRuntime && sessionCredentials ? {
                sendNative: createPluginNativeNotificationDelivery({ credentials: sessionCredentials,
                    readCredentials: readSessionCredentials, serverUrl: notificationServerUrl,
                    serverHttpBaseUrl: notificationServerHttpBaseUrl,
                    serverId: params?.accountExecution?.serverId ?? sessionCredentialsServerId,
                    isCurrent: async () => params?.accountExecution
                        ? await params.accountExecution.isCredentialCurrent?.() !== false && params.accountExecution.isCurrent()
                        : configuration.activeServerId === sessionCredentialsServerId && configuration.serverUrl === notificationServerUrl,
                    ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
                }),
            } : {}),
            async resolveNoticeArtifacts(seed) {
                // Restricted Session credentials do not gain private Account
                // Artifact authority through a plugin notification.
                if (scopedActionRuntime || !sessionCredentials) return null;
                const accountId = readAccountIdFromToken(sessionCredentials.token);
                const current = await readSessionCredentials();
                if (!accountId || !current || readAccountIdFromToken(current.token) !== accountId) return null;
                const store = createCredentialedAccountArtifactStore(current);
                return { accountId, store: { writeNotice: async input => {
                    if (input.page && !authoritativeContributes.uiViewsV2?.some(page => page.pluginId === seed.plugin.id
                        && page.definition.container === 'appPage' && page.definition.id === input.page!.pageId)) {
                        throw new PluginError({ code: 'plugin_notification_page_undeclared', message: 'Notification page is not declared by this plugin' });
                    }
                    return await store.writeNotice({ ...input, beforeWrite: async () => {
                        const active = await readSessionCredentials();
                        if (!active || readAccountIdFromToken(active.token) !== accountId) {
                            throw new PluginError({ code: 'plugin_notification_account_retired', message: 'Notification Account custody is no longer current' });
                        }
                        await input.beforeWrite?.();
                    } });
                } } };
            },
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
                    isCurrent: isChannelLocallyCurrent,
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
                                    accountStorageCurrentness: isChannelLocallyCurrent,
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
            ...(params?.agentIsolation ? { agentIsolation: params.agentIsolation } : {}),
            readSpawnFailureLimits: params?.readSpawnFailureLimits,
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
        managedServices: invocationManagedServicesOwner,
    });
    // Subscribe before service consumers: one host push dirties each shared
    // adopted catalog once, irrespective of its number of observers.
    const automationCatalogSubscription = invocationServiceOwners.stableEventsBroker.subscribeHost({
        target: { eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } },
        listener(event) {
            if (event.eventId !== '@happier/automation/event-sources-invalidated') return;
            if (event.payload.definitionsChanged !== false) automationAssembly.invalidateSourceDefinitions(event.payload.pluginIds);
        },
        isCurrent: () => consumerAssembly.isOccurrenceCurrent(),
    });
    consumerAssembly.allRetirementSignal.addEventListener('abort', () => { void automationCatalogSubscription.dispose(); }, { once: true });
    if (!params?.accountExecution) {
        reconcileAdoptedHealthChecks = () => {
            currentDomainEdgeObservation.reconcile(entry => {
                const batch = readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet,
                    caller: entry.caller, occurrenceId: entry.occurrenceId,
                    sourceInstanceId: entry.sourceInstanceId, signal: consumerAssembly.allRetirementSignal });
                return batch.kind === 'available' && batch.source.subject.kind === 'environment'
                    && batch.source.subject.environmentId === entry.environmentId
                    && isDeepStrictEqual(batch.source.checks.find(check => check.checkId === entry.checkId), entry.check);
            });
            projectManagedServicesOwner.machineServiceRows.reconcileHealthResults(entry => {
                const batch = readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet,
                    caller: entry.caller, occurrenceId: entry.occurrenceId,
                    sourceInstanceId: entry.sourceInstanceId, signal: consumerAssembly.allRetirementSignal });
                return batch.kind === 'available' && isDeepStrictEqual(batch.source.subject, entry.subject)
                    && isDeepStrictEqual(batch.source.checks.find(check => check.checkId === entry.check.checkId), entry.check);
            });
        };
        reconcileAdoptedHealthChecks();
    }
    disposeInvocationServiceOwners = async () => {
        await automationCatalogSubscription.dispose();
        // A composite can own no new activation components. Its local services
        // may settle while a successor retains its peers, so only dispose local
        // consumers here. Explicit occurrence retirement still fences services.
        disposeConsumers();
        currentGlobalExternalSessions?.dispose();
        currentGlobalExternalSessions = null;
        currentGlobalExternalSessionsPublicationBasis = null;
        const results = await Promise.allSettled([
            invocationServiceOwners.dispose(),
            daemonManagedServicesOwner.dispose({
                preserveProjectServices: preserveProjectServicesOnRegistryRetirement,
                preserveSharedProviderServices: preserveProjectServicesOnRegistryRetirement,
            }),
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
    function resolveDeclaredInvocationServiceBinding(
        seed: PluginInvocationServicesSeed,
    ): PluginInvocationServiceBinding {
        const target = resolveExactActivationTarget(seed.plugin.id);
        const hostAccessRequests = target && resolveManifestHostAccessRequestsForQualifiedContribution({
            manifest: target.manifest,
            pluginId: seed.plugin.id,
            contribution: seed.contribution,
        });
        if (!hostAccessRequests) {
            throw new PluginError({
                code: 'plugin_contribution_unavailable',
                message: 'Plugin invocation declaration is unavailable',
            });
        }
        return invocationServiceOwners.resolveInvocationHostPolicy({
            pluginId: seed.plugin.id,
            occurrenceId: seed.occurrenceId,
            qualifiedId: seed.contribution.qualifiedId,
        }, {
            hostAccessRequests,
            surface: seed.surface,
            ...(seed.session ? { sessionId: seed.session.id } : {}),
            signal: seed.signal,
        }).serviceBinding;
    }
    const declaredEventSubscriptionBindings = new Map<string, Awaited<ReturnType<
        typeof invocationServiceOwners.bindDeclaredEventSubscriptions
    >>>();
    let configurationActivationObserver: Awaited<ReturnType<typeof observePluginConfigurationActivation>> | undefined;
    let configurationActivationStart: Promise<void> | undefined;
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
        configurationActivationObserver?.dispose();
        if (pluginIds) uiResourceWatches?.retirePlugins(pluginIds);
        else uiResourceWatches?.retire();
    };
    async function refreshDeclaredEventSubscriptionBindings(): Promise<boolean> {
        let activationChanged = false;
        for (const entry of activatedRegistry.targetRegistrations) {
            if (entry.registration.family !== 'events') continue;
            if (!activatedRegistry.activatedPluginIds.has(entry.pluginId)) continue;
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
            try {
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
                        const sourceCustody = readCurrentPluginSourceCustody(contextInput.pluginId);
                        const seed = Object.freeze({
                            plugin: Object.freeze({ id: contextInput.pluginId, version: contextInput.pluginVersion }),
                            contribution: Object.freeze({
                                id: contextInput.localId,
                                qualifiedId: `${contextInput.pluginId}/events/${contextInput.localId}`,
                            }),
                            occurrenceId: contextInput.occurrenceId,
                            ...(sourceCustody ? { sourceCustody } : {}),
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
                            const serviceBinding = resolveDeclaredInvocationServiceBinding(seed);
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
            } catch (error) {
                // A missing optional publisher makes its subscriber unavailable,
                // not the entire daemon. Use the same fact, consumer fence and
                // activation cleanup as other terminal plugin failures.
                await recordPluginActivationFailure(entry.pluginId, projectPluginFailureText(error));
                activationChanged = true;
                const pluginKey = `${entry.pluginId}\u0000`;
                for (const [bindingKey, binding] of declaredEventSubscriptionBindings) {
                    if (!bindingKey.startsWith(pluginKey)) continue;
                    declaredEventSubscriptionBindings.delete(bindingKey);
                    await binding.dispose();
                }
            }
        }
        return activationChanged;
    }
    const resolveCurrentFinalPolicyRuntime = (
        pluginId: string,
    ): PluginFinalPolicyCurrentRuntime | null => {
        const activationTarget = resolveExactActivationTarget(pluginId);
        const declaration = authoritativeContributes.pluginDeclarations?.find((candidate) => candidate.pluginId === pluginId);
        const clientOnlyDeclaration = !activationTarget && declaration
            && !declaration.daemonEntryPath && !declaration.devDaemonEntryPath;
        // Final-policy readers retain the exact admitted runtime identity after
        // terminal fencing so they can distinguish `applied: false` from an
        // unknown plugin. Public currentness readers still fail closed through
        // the consumer assembly once this occurrence is retired.
        const occurrenceId = activatedRegistry.readPluginOccurrenceId(pluginId);
        const sourceCustody = activatedRegistry.readPluginSourceCustody(pluginId);
        if (
            (!activationTarget && !clientOnlyDeclaration)
            || !occurrenceId
            || !sourceCustody
        ) return null;
        const activationApplied = clientOnlyDeclaration
            ? isPluginConsumerCurrent(pluginId)
            : Boolean(
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
        const hostOwnedServer = effect.seed.plugin.id === effect.ref.pluginId
            && effect.seed.contribution.qualifiedId === `${effect.ref.pluginId}/mcp.servers/${effect.ref.localId}`
            && authoritativeContributes.mcpServers?.some(entry => entry.pluginId === effect.ref.pluginId && entry.definition.id === effect.ref.localId);
        const resourceSelections = hostOwnedDiscovery || hostOwnedServer
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
    const resolveTargetActionAuthorizationFacts = (
        action: ResolvedTargetAction,
        purpose?: 'declaration',
    ): TargetActionAuthorizationFacts => {
        const activationTarget = resolveExactActivationTarget(action.pluginId);
        const admittedTarget = readResolvedActionContribution(authoritativeContributes, {
            pluginId: action.pluginId,
            localId: action.localId,
        })?.admittedTarget;
        const current = activationTarget && admittedTarget
            ? resolveCurrentFinalPolicyRuntime(action.pluginId)
            : null;
        return resolvePluginFinalPolicyAuthorizationFacts({
            pluginId: action.pluginId,
            current,
            // Discovery consumes the admitted declaration, not an applied handler.
            // Invocation omits this purpose and retains exact applied eligibility.
            ...(purpose ? { purpose } : {}),
            resourceSelections: resolveTargetActionResourceSelectionFacts(action),
        });
    };
    const resolveActionPresentUserGatePolicy = (
        pluginId: string,
        localId: string,
    ): PluginActionPresentUserGatePolicy | null => {
        try {
            const activationTarget = resolveExactActivationTarget(pluginId);
            const admittedTarget = readResolvedActionContribution(authoritativeContributes, {
                pluginId,
                localId,
            })?.admittedTarget;
            const current = activationTarget && admittedTarget
                ? resolveCurrentFinalPolicyRuntime(pluginId)
                : null;
            if (!admittedTarget || !current) return null;
            const definition = admittedTarget.declaration;
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
                hostAccessRequests: admittedTarget.hostAccessRequests,
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
    const readDeploymentTargetRoleAdmissionHost = (context: import('@happier-dev/protocol').ActionExecutorContext) => {
        const machineId = params?.resolveCurrentMachineId?.() ?? params?.accountExecution?.machineId ?? null;
        // Custody and execution realm are separate: a daemon runtime may
        // use its explicitly captured Account without becoming an Account runtime.
        const accountExecution = params?.accountExecution ?? params?.deploymentAccountExecution ?? (scopedActionRuntime && sessionCredentials ? {
            credentials: sessionCredentials,
            serverUrl: notificationServerHttpBaseUrl,
            serverId: sessionCredentialsServerId,
            serverIdentityId: params?.externalActionHomeBinding?.serverIdentityId ?? sessionCredentialsServerId,
            ...(machineId ? { machineId } : {}),
            ...(savedSecretOperationContext ? { savedSecretOperationContext } : {}),
            isCurrent: async () => configuration.activeServerId === sessionCredentialsServerId,
        } : undefined);
        return createDeploymentTargetRoleAdmissionHost(context, {
            resolveRequesterIdentity: async actionContext => {
                const physical = params?.readDaemonRequesterWorkAttribution?.();
                return selectHostRequesterExecutionIdentity({ actionContext,
                    hostHomeServerIdentityId: physical?.serverId ?? null,
                    hostCustodianAccountId: physical?.accountId ?? null,
                    ...(physical ? { hostExecutionTarget: { machineId: physical.machineId, installationId: physical.installationId } } : {}) });
            },
            ...(accountExecution ? { accountExecution: { ...accountExecution, isCurrent: async () => accountExecution.isCurrent() } } : {}),
            ...(params?.acquireServiceExportForward ? { acquireServiceExportForward: params.acquireServiceExportForward } : {}),
            readCurrentMachineId: () => machineId,
            connectedAccountRuntimeRegistry: params?.connectedAccountRuntimeRegistry ?? runtimeRegistryController,
        });
    };
    targetActionInvocations = buildTargetActionInvocationRegistry({
        ...(params?.ensureEnvironmentServices ? { ensureEnvironmentServices: params.ensureEnvironmentServices } : {}),
        readDeploymentTargetRoleAdmissionHost,
        async resolveEnvironmentApprovalScope(request) {
            const host = await readDeploymentTargetRoleAdmissionHost(request.context);
            return host?.resolveEnvironmentApprovalScope?.(request)
                ?? deploymentUnavailableDiagnostic({ ok: false as const, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' },
                    'deployment.target_role.approval_scope.host', 'client_required');
        },
        async readAccountScope(signal) {
            const authority = params?.accountExecution;
            const serverId = authority?.serverIdentityId ?? authority?.serverId;
            if (signal.aborted || !authority || !serverId || !await authority.isCurrent()) return undefined;
            const credentials = await readSessionCredentials();
            const accountId = credentials ? readAccountIdFromToken(credentials.token) : null;
            if (signal.aborted || !accountId || !await authority.isCurrent()) return undefined;
            return Object.freeze({ serverId, accountId });
        },
        ...(params?.accountExecution ? { readCurrentTargetedDeclarations: readCurrentAccountTargetedDeclarations,
            createAccountSourceMachineResolver } : {}),
        ...(accountActivationSources ? { executionRealm: 'account' as const } : {}),
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
        async prepareInvocationServices({ pluginId, localId }) {
            await activateContributionsOnDemand([{ pluginId, family: 'actions', localId }]);
        },
        beginDiagnosticScope: invocationServiceOwners.beginDiagnosticScope,
        redactDiagnosticText: invocationServiceOwners.redactDiagnosticText,
        completeDiagnosticScope: invocationServiceOwners.completeDiagnosticScope,
        resolveCurrentSessionUi: resolveCurrentSessionUiBinding,
        ...(params?.actionFormConnectedAccounts
            ? { actionFormConnectedAccounts: params.actionFormConnectedAccounts }
            : {}),
        resolveAutomationEventHistoryGapSource,
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
            const current = captureCurrentPluginOccurrence(input.pluginId);
            if (!pluginVersion || !current || current.occurrenceId !== input.occurrenceId) {
                throw new Error(`Voice speech contribution '${input.pluginId}/${input.localId}' has no active plugin identity`);
            }
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.localId,
                    qualifiedId: `${input.pluginId}/voiceProviders/${input.localId}`,
                }),
                occurrenceId: input.occurrenceId,
                sourceCustody: current.sourceCustody,
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
            );
            const transport = createGlobalFetchRuntime();
            const validateRecipient = async (requestUrl: string) => {
                if (input.endpointPolicy) await revalidateVoiceSpeechHttpEndpoint({ policy: input.endpointPolicy, requestUrl });
            };
            // This compares the actual recipient with the selected credential scope;
            // it does not re-admit the Action or plugin generation.
            return stableHttpHost.prepareAdapterBinding!(seed, binding)({ ...transport,
                async request(request, options) {
                    await validateRecipient(request.url);
                    return await transport.request(request, options);
                },
                async requestStream(request, options) {
                    await validateRecipient(request.url);
                    return await transport.requestStream!(request, options);
                },
            });
        },
    });
    const composerReferences = createTargetComposerReferenceRegistry({
        composerReferences: (authoritativeContributes.composerReferences ?? []).filter((entry) => (
            candidateOccurrenceIdsByPluginId.has(entry.pluginId)
        )),
        targetRegistrations: activatedRegistry.targetRegistrations,
        async activateReferenceOnDemand(reference) {
            await activateContributionsOnDemand([{ ...reference, family: 'composerReferences' }]);
        },
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
            const sourceCustody = readCurrentPluginSourceCustody(input.reference.pluginId);
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.reference.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.reference.localId,
                    qualifiedId: `${input.reference.pluginId}/composerReferences/${input.reference.localId}`,
                }),
                occurrenceId: input.occurrenceId,
                ...(sourceCustody ? { sourceCustody } : {}),
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
                const serviceBinding = resolveDeclaredInvocationServiceBinding(seed);
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
            // This Machine registry's storage belongs to its admitted Account.
            // A shared-Machine guest must never borrow that storage while its
            // nested source Action is dispatched with different Account custody.
            if (input.requesterAccount && (!sessionCredentials
                || input.requesterAccount.readSnapshot()?.scopeKey !== resolveAccountSettingsScopeKey(sessionCredentials))) {
                throw new PluginError({ code: 'plugin_action_caller_unavailable',
                    message: 'Composer attachment Account custody is unavailable on this Machine' });
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(input.attachment.pluginId);
            const currentSession = input.scope.kind === 'session'
                ? resolveCurrentSessionUiBinding(input.scope.sessionId)
                : null;
            const sourceCustody = readCurrentPluginSourceCustody(input.attachment.pluginId);
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.attachment.pluginId, version: pluginVersion }),
                contribution: Object.freeze({
                    id: input.attachment.localId,
                    qualifiedId: `${input.attachment.pluginId}/composerAttachments/${input.attachment.localId}`,
                }),
                occurrenceId: input.occurrenceId,
                ...(sourceCustody ? { sourceCustody } : {}),
                correlationId: randomUUID(),
                surface: 'cli' as const,
                scope: input.scope,
                ...(input.requesterAccount ? { requesterAccount: input.requesterAccount } : {}),
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
                const serviceBinding = resolveDeclaredInvocationServiceBinding(seed);
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
            return await resolved.handler(event, scopedContext);
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
        // Source-backed bundled plugins and packaged runtimes carry admitted
        // custody without a managed installation generation. Enumerate that
        // same custody owner, then retain the exact per-runtime policy checks.
        for (const pluginId of admittedPluginSourceCustodiesByPluginId.keys()) {
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
    // Binding can reject an optional plugin. Construct the diagnostic and
    // retirement owners first so that rejection settles before publication.
    if (await refreshDeclaredEventSubscriptionBindings()) {
        committedTargetActionInvocations.refresh();
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
            const serviceBinding = resolveDeclaredInvocationServiceBinding(seed);
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

    async function refreshActivatedConsumersIfChanged(
        previousFacts: typeof activatedRegistry.targetActivationFacts,
    ): Promise<void> {
        const currentFacts = activatedRegistry.targetActivationFacts;
        // Lifecycle facts are immutable and retain their identities until
        // activation or retirement changes them. A repeated warm demand does
        // not publish registrations and must not reconstruct bound consumers.
        if (
            previousFacts.length === currentFacts.length
            && previousFacts.every((fact, index) => fact === currentFacts[index])
        ) return;
        // Lazy activation publishes into the generation-owned registration/fact
        // arrays. Rebuild the complete immutable action index before exposing
        // the activation result so dispatch can never observe a half-published
        // target generation or fall through to the retired legacy path.
        await refreshDeclaredEventSubscriptionBindings();
        committedTargetActionInvocations.refresh();
        mergeActivatedHookHandlers();
        refreshAgentRuntimeRegistry();
        refreshSystemToolRegistries();
    }

    async function activateContributionsOnDemand(
        demands: Parameters<typeof activatedRegistry.activateContributionsOnDemand>[0],
    ): Promise<Awaited<ReturnType<typeof activatedRegistry.activateContributionsOnDemand>>> {
        const previousFacts = activatedRegistry.targetActivationFacts;
        const results = await activatedRegistry.activateContributionsOnDemand(demands);
        await refreshActivatedConsumersIfChanged(previousFacts);
        for (const { pluginId } of results) {
            if (activatedRegistry.activatedPluginIds.has(pluginId)) await resourcesOwner?.preparePlugin(pluginId);
        }
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
        const projected = projectActivatedAgentContributions(
            contributes,
            activatedRegistry,
            (pluginId) => isPluginConsumerCurrent(pluginId),
            params?.resolveManagedServiceSessionBaseUrl,
            params?.resolveManagedServiceSessionClientAccess,
            (input) => resolveAgentPluginSettings(input),
            bindAgentPreflightManagedServices,
            resolveAgentPreflightManagedExecutable,
            resolveAgentPreflightLifecycle,
            agentId,
            params?.agentIsolation,
        );
        return projected.agents.find((agent) => agent.id === agentId)?.catalogEntry ?? null;
    }

    async function activatePluginsForValidation(
        pluginIds: readonly string[],
    ): Promise<Awaited<ReturnType<typeof activatedRegistry.activatePluginsForValidation>>> {
        const previousFacts = activatedRegistry.targetActivationFacts;
        const results = await activatedRegistry.activatePluginsForValidation(pluginIds);
        await refreshActivatedConsumersIfChanged(previousFacts);
        for (const { pluginId } of results) {
            if (activatedRegistry.activatedPluginIds.has(pluginId)) await resourcesOwner?.preparePlugin(pluginId);
        }
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
    async function recordPluginActivationFailure(
        pluginId: string,
        failure: Parameters<typeof activatedRegistry.recordPluginActivationFailure>[1],
    ): Promise<void> {
        activatedRegistry.recordPluginActivationFailure(pluginId, failure);
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
    async function acquireProviderParserProjection(
        ref: PluginContributionRef,
        kind: 'catalog' | 'usage' | 'requestCost',
    ): Promise<ResolvedProviderContribution | null> {
        const provider = (authoritativeContributes.providers ?? []).find((candidate) => (
            candidate.identity.pluginId === ref.pluginId
            && candidate.identity.localId === ref.localId
        ));
        const target = resolveExactActivationTarget(ref.pluginId);
        if (
            !target
            || !provider
            || (kind === 'requestCost' ? provider.definition.requestCost === undefined
                : (kind === 'catalog' ? readContributedProviderCatalogParserIds : readContributedProviderUsageParserIds)(
                    provider.definition as unknown as Readonly<Record<string, unknown>>,
                ).length === 0)
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
        return projected.providers[0] ?? null;
    }

    async function acquireProviderCatalogParsers(ref: PluginContributionRef): Promise<ResolvedProviderCatalogParsers | null> {
        const parsers = (await acquireProviderParserProjection(ref, 'catalog'))?.catalogParsers ?? null;
        return parsers?.isCurrent() === true ? parsers : null;
    }

    async function acquireProviderUsageParsers(ref: PluginContributionRef): Promise<ResolvedProviderUsageParsers | null> {
        const parsers = (await acquireProviderParserProjection(ref, 'usage'))?.usageParsers ?? null;
        return parsers?.isCurrent() === true ? parsers : null;
    }
    async function acquireProviderRequestCostParser(ref: PluginContributionRef) {
        const parser = (await acquireProviderParserProjection(ref, 'requestCost'))?.requestCostParser ?? null;
        return parser?.isCurrent() === true ? parser : null;
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
                sharedGateway: input.sharedGateway,
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
        const declaration = resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: identity, managedRuntime: provider.definition.managedRuntime,
        });
        const sharedProvider = input.sharedGateway !== undefined && isSharedProviderAdmission(
            declaration, input.purposeBindings, qualifyManagedProviderRequestAuthUses(identity, declaration),
        );
        const operationOwner = sharedProvider ? projectManagedServicesOwner : daemonManagedServicesOwner;
        const operationOccurrenceId = readCurrentPluginOccurrenceId(identity.pluginId)!;
        const operationSource = readCurrentPluginSourceCustody(identity.pluginId);
        // Runtime acquisition has one owner: the public managed Provider lifecycle
        // coordinator invoked by `input.establish`. Pre-acquiring it here made a
        // permanently missing/integrity-rejected runtime collapse into the joiner's
        // generic `unavailable` result before that coordinator could return its
        // existing `managed_provider_runtime_unavailable` outcome. The registry
        // generation itself is already the exact SVC09 operation generation; this
        // closure only fences that admitted generation and the caller authority.
        // Activation is demanded by acquisition, not a precondition for demand.
        const readsOperationCurrent = (): boolean => {
            try {
                return input.isCurrent() === true
                    && (sharedProvider && isRetainedPhysicalSourceCurrent && operationSource
                        ? isRetainedPhysicalSourceCurrent(identity.pluginId, operationOccurrenceId, operationSource)
                        : isPluginConsumerCurrent(identity.pluginId)
                            && isCurrentPluginOccurrence(identity.pluginId, operationOccurrenceId));
            } catch {
                return false;
            }
        };
        if (!readsOperationCurrent()) {
            return Object.freeze({ status: 'not_current' as const });
        }
        return await operationOwner.runManagedProviderExplicitStart({
            ...(input.existingOnly ? { existingOnly: true as const } : {}),
            ...(sharedProvider ? { sharedProvider: true as const } : {}),
            ...(input.retirementGroup ? { retirementGroup: input.retirementGroup } : {}),
            operationId,
            pluginId: identity.pluginId,
            contributionQualifiedId:
                `${identity.pluginId}/providers/${identity.localId}`,
            occurrenceId: operationOccurrenceId,
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
        sharedGateway?: SharedManagedProviderGatewayBinding;
        operationClaim?: Extract<
            ManagedProviderRuntimeOperationClaim,
            { kind: 'providerBroker' }
        >;
    }>): Promise<boolean> {
        const operationId = resolveExplicitManagedProviderOperationClaimId(
            input,
        );
        if (!operationId) return false;
        const claim = {
                operationId,
                pluginId: input.identity.pluginId,
                contributionQualifiedId:
                    `${input.identity.pluginId}/providers/${input.identity.localId}`,
            };
        const ordinary = await daemonManagedServicesOwner.retireManagedProviderExplicitStart(claim);
        return projectManagedServicesOwner === daemonManagedServicesOwner ? ordinary
            : await projectManagedServicesOwner.retireManagedProviderExplicitStart(claim) || ordinary;
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
        const claim = {
            operationId,
            pluginId: input.identity.pluginId,
            contributionQualifiedId:
                `${input.identity.pluginId}/providers/${input.identity.localId}`,
        };
        const ordinary = await daemonManagedServicesOwner.retireManagedProviderExplicitStart(claim);
        return projectManagedServicesOwner === daemonManagedServicesOwner ? ordinary
            : await projectManagedServicesOwner.retireManagedProviderExplicitStart(claim) || ordinary;
    }

    async function revalidateManagedProviderExplicitStarts(
        signal?: AbortSignal,
        selector?: Parameters<typeof retireManagedProviderExplicitStart>[0],
        invalidation?: ProviderBrokerRetainedCurrentnessInvalidation,
    ): Promise<number> {
        signal?.throwIfAborted();
        const operationId = selector
            ? resolveExplicitManagedProviderOperationClaimId(selector)
            : null;
        if (selector && !operationId) return 0;
        const claim = selector && operationId ? {
            operationId,
            pluginId: selector.identity.pluginId,
            contributionQualifiedId:
                `${selector.identity.pluginId}/providers/${selector.identity.localId}`,
        } : undefined;
        const ordinary = await daemonManagedServicesOwner.revalidateManagedProviderExplicitStarts(signal, claim, invalidation);
        return ordinary + (projectManagedServicesOwner === daemonManagedServicesOwner ? 0
            : await projectManagedServicesOwner.revalidateManagedProviderExplicitStarts(signal, claim, invalidation));
    }

    async function retireManagedProviderExplicitStarts(
        lifecycleKind: 'publicExplicitStart' | 'providerBroker',
    ): Promise<number> {
        const ordinary = await daemonManagedServicesOwner.retireManagedProviderExplicitStarts(lifecycleKind);
        return ordinary + (projectManagedServicesOwner === daemonManagedServicesOwner ? 0
            : await projectManagedServicesOwner.retireManagedProviderExplicitStarts(lifecycleKind));
    }

    type ManagedProviderInvocationPreparation = Readonly<{
            accountAuthority?: ManagedProviderInvocationAccountAuthority;
            identity: PluginContributionRef;
            purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
            modelCatalogs?: import('./invocation/services/managedServicesAdapter').ManagedProviderRuntimeInvocationBinding['modelCatalogs'];
            operationClaim?: Exclude<ManagedProviderRuntimeOperationClaim, { kind: 'sessionDemand' }>
                | Pick<Extract<ManagedProviderRuntimeOperationClaim, { kind: 'sessionDemand' }>, 'kind' | 'sessionId' | 'runtimeBindingBasis'>;
            sharedGateway?: SharedManagedProviderGatewayBinding;
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
        }>;
    async function createManagedProviderRuntimeInvocationServicesInternal(
        input: ManagedProviderInvocationPreparation,
        preparation: 'bootstrapOnly',
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices['bootstrap'] | null>;
    async function createManagedProviderRuntimeInvocationServicesInternal(
        input: ManagedProviderInvocationPreparation,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | null>;
    async function createManagedProviderRuntimeInvocationServicesInternal(
        input: ManagedProviderInvocationPreparation,
        preparation?: 'bootstrapOnly',
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | ResolvedManagedProviderRuntimeInvocationServices['bootstrap'] | null> {
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
        if (input.sharedGateway) {
            const binding = input.sharedGateway;
            const [origin, credentials] = await Promise.all([
                params?.resolveCurrentMachineExecutionOriginContext?.(
                    input.signal,
                ).catch(() => null),
                (input.accountAuthority?.readCredentials ?? readSessionCredentials)().catch(() => null),
            ]);
            const sessionClaim = input.operationClaim?.kind === 'sessionDemand'
                ? input.operationClaim
                : null;
            if (
                !origin
                || !credentials
                || input.signal.aborted
                || !input.isCurrent()
                || origin.serverIdentityId !== binding.homeId
                || origin.machineId !== binding.machineId
                || readAccountIdFromToken(credentials.token) !== binding.accountId
                || Object.values(binding).some((value) => (
                    value.length === 0 || value.trim() !== value
                ))
                || (sessionClaim && (
                    sessionClaim.sessionId !== binding.consumerId
                    || sessionClaim.runtimeBindingBasis.connectionId
                        !== binding.connectionId
                ))
            ) return null;
        }
        const declaration = resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: input.identity,
            managedRuntime: rawDeclaration,
        });
        const purposeBindings =
            QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
                input.purposeBindings,
            );
        if (input.operationClaim?.kind === 'sessionDemand') {
            const basis = ProviderRuntimeBindingBasisV1Schema.safeParse(input.operationClaim.runtimeBindingBasis);
            if (!basis.success || basis.data.deployment.kind !== 'managedLocal') return null;
            const deployment = basis.data.deployment;
            const endpoint = targetProvider?.endpointTemplates.find(candidate => candidate.id === basis.data.endpoint.endpointTemplateId);
            if (createProviderManagedRuntimeBindingEqualityKeyV1(deployment)
                !== createProviderManagedRuntimeBindingEqualityKeyV1({
                    implementationIdentity: input.identity,
                    managedRuntime: declaration,
                    purposeBindings,
                })
                || !declaration.endpointTemplateIds.includes(basis.data.endpoint.endpointTemplateId)
                || (!input.retained && endpoint?.protocol !== basis.data.endpoint.protocol)) return null;
        }
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
        const qualifiedRequestAuthUses = qualifyManagedProviderRequestAuthUses(input.identity, declaration);
        const declaredSharingEligible = input.sharedGateway !== undefined
            && isSharedProviderAdmission(declaration, purposeBindings, qualifiedRequestAuthUses);
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
                    && (declaredSharingEligible && isRetainedPhysicalSourceCurrent
                        ? isRetainedPhysicalSourceCurrent(input.identity.pluginId, runtime.activationOccurrenceId, runtime.sourceCustody)
                        : runtime.isCurrent() === true
                            && (input.retained !== undefined || isPluginConsumerCurrent(input.identity.pluginId)));
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
                    input.sharedGateway,
                );
            }
            if (input.operationClaim.kind === 'providerBroker') {
                return resolveExplicitManagedProviderOperationClaimId({
                    identity: input.identity,
                    machineId: '',
                    operationClaim: input.operationClaim,
                    sharedGateway: input.sharedGateway,
                });
            }
            const sessionId = input.operationClaim.sessionId.trim();
            // The runner carries an opaque bounded ID, not this variable-size
            // source/placement tuple. Retained invocations keep their issued ID.
            return sessionId
                ? `managed-provider-session-demand:${createHash('sha256').update(JSON.stringify([
                    'managed-provider-session-demand',
                    sessionId,
                    input.identity.pluginId,
                    input.identity.localId,
                    runtime.activationOccurrenceId,
                    readCurrentPluginSourceCustody(
                        input.identity.pluginId,
                    ),
                    manifestAuthority,
                    ...(input.sharedGateway ? [input.sharedGateway] : []),
                ])).digest('hex')}`
                : null;
        })();
        if (!operationClaimId) return null;
        const bootstrapOccurrenceId = input.retained?.occurrenceId
            ?? readCurrentPluginOccurrenceId(input.identity.pluginId);
        const bootstrapSourceCustody = input.retained?.sourceCustody
            ?? readCurrentPluginSourceCustody(input.identity.pluginId);
        if (!bootstrapOccurrenceId || !bootstrapSourceCustody) return null;
        if (preparation === 'bootstrapOnly') {
            // A peer attests its current source, but borrows execution and
            // request-auth custody from the hub. Development source admission
            // is valid here too; retained reconstruction has its own attestation.
            if (!readsInvocationCurrent()) return null;
            return Object.freeze({
                identity: Object.freeze({ ...input.identity }),
                occurrenceId: bootstrapOccurrenceId,
                sourceCustody: bootstrapSourceCustody,
                manifestAuthority,
                operationClaimId,
                requestAuth: null,
            });
        }
        const lifetime = createPluginInvocationLifetime(
            input.retained || declaredSharingEligible
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
            const authority = input.accountAuthority?.operationAuthority ?? params?.managedProviderOperationAuthority;
            if (!authority) {
                lifetime.complete();
                return null;
            }
            try {
                operationAuthority =
                    await authority.activate({
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
        // A contribution can use ordinary Provider credentials as well as
        // connected subscriptions. Only admitted request-auth purposes select
        // shared consumer custody; an opt-in or placement alone is not enough.
        const sharingEligible = isSharedProviderAdmission(declaration, purposeBindings, requestAuth?.qualifiedRequestAuthUses ?? []);
        const sharedGateway = sharingEligible ? input.sharedGateway : undefined;
        // A Team Connected Account/Pool source has no Provider Connection.
        // Its admitted broker operation already owns process and request-auth
        // custody; only connection-backed callers require a shared placement.
        if (sharingEligible && !sharedGateway && input.operationClaim?.kind !== 'providerBroker') {
            lifetime.complete();
            await operationAuthority?.cleanup().catch(() => undefined);
            return null;
        }
        const readsPhysicalOccurrenceCurrent = (): boolean => {
            try {
                if (isRetainedPhysicalSourceCurrent) return isRetainedPhysicalSourceCurrent(
                    input.identity.pluginId, runtime.activationOccurrenceId, runtime.sourceCustody,
                );
                const source = readCurrentPluginSourceCustody(input.identity.pluginId);
                return isPluginConsumerCurrent(input.identity.pluginId)
                    && isCurrentPluginOccurrence(input.identity.pluginId, runtime.activationOccurrenceId)
                    && source !== null && source !== undefined
                    && pluginSourceCustodyEqual(source, runtime.sourceCustody);
            } catch {
                return false;
            }
        };
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
                ...(input.accountAuthority ? { connectedAccountsOwner: input.accountAuthority.connectedAccountsOwner } : {}),
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
                    ...(input.modelCatalogs ? { modelCatalogs: input.modelCatalogs } : {}),
                    ...(sharedGateway ? { sharedGateway, isPhysicalOccurrenceCurrent: readsPhysicalOccurrenceCurrent } : {}),
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
            ...(sharedGateway ? { lifetime: 'sharedConsumer' as const } : {}),
            materializeManagedProviderAgentBinding:
                (sharedGateway ? projectManagedServicesOwner : daemonManagedServicesOwner).materializeManagedProviderAgentBinding,
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
            accountAuthority?: ManagedProviderInvocationAccountAuthority;
            identity: PluginContributionRef;
            purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
            modelCatalogs?: import('./invocation/services/managedServicesAdapter').ManagedProviderRuntimeInvocationBinding['modelCatalogs'];
            operationClaim?: ManagedProviderRuntimeOperationClaim;
            sharedGateway?: SharedManagedProviderGatewayBinding;
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
        // The preparation owner validated this exact basis before acquiring
        // any request-auth or managed-service authority.
        const runtimeBindingBasis = input.operationClaim.runtimeBindingBasis;
        if (invocation.lifetime === 'sharedConsumer') return invocation;
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

    async function prepareManagedProviderSessionBootstrap(
        input: ManagedProviderSessionBootstrapPreparation,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices['bootstrap'] | null> {
        const parsed = ProviderRuntimeBindingBasisV1Schema.safeParse(input.runtimeBindingBasis);
        if (!parsed.success || parsed.data.deployment.kind !== 'managedLocal'
            || input.sessionId.trim() !== input.sessionId || !input.sessionId
            || input.signal.aborted || !input.isCurrent()) return null;
        const basis = parsed.data;
        const deployment = basis.deployment;
        if (deployment.kind !== 'managedLocal') return null;
        const current = await acquireManagedProviderRuntime(deployment.implementationIdentity);
        if (!current || !current.isCurrent()) return null;
        let retained: ManagedProviderInvocationPreparation['retained'];
        let retainedAvailable: (() => Promise<void>) | undefined;
        if (input.retainedScope) {
            const scope = input.retainedScope;
            if (scope.sessionId !== input.sessionId
                || !isDeepStrictEqual(scope.runtimeBindingBasis, basis)
                || buildQualifiedPluginContributionKey(scope.identity)
                    !== buildQualifiedPluginContributionKey(deployment.implementationIdentity)
                || scope.occurrenceId !== current.activationOccurrenceId
                || !isDeepStrictEqual(scope.sourceCustody, current.sourceCustody)) return null;
            const attested = await attestRetainedManagedProvider({
                paths: resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
                sessionId: scope.sessionId,
                identity: scope.identity,
                occurrenceId: scope.occurrenceId,
                sourceCustody: scope.sourceCustody,
                manifestAuthority: scope.manifestAuthority,
                runtimeBindingBasis: basis,
            });
            if (!attested) return null;
            retainedAvailable = attested.assertStillAvailable;
            retained = Object.freeze({
                declaration: attested.declaration,
                pluginVersion: attested.pluginVersion,
                occurrenceId: attested.occurrenceId,
                sourceCustody: attested.sourceCustody,
                manifestAuthority: attested.manifestAuthority,
                requiredHostAccess: attested.requiredHostAccess,
                operationClaimId: scope.operationClaimId,
            });
        }
        const bootstrap = await createManagedProviderRuntimeInvocationServicesInternal({
            identity: deployment.implementationIdentity,
            purposeBindings: deployment.purposeBindings,
            operationClaim: { kind: 'sessionDemand', sessionId: input.sessionId, runtimeBindingBasis: basis },
            ...(retained ? { retained } : {}),
            signal: input.signal,
            isCurrent: () => input.isCurrent() && current.isCurrent(),
        }, 'bootstrapOnly');
        try {
            await retainedAvailable?.();
            return !input.signal.aborted && input.isCurrent() && current.isCurrent() ? bootstrap : null;
        } catch {
            return null;
        }
    }

    async function createRetainedManagedProviderRuntimeInvocationServices(
        input: Readonly<{
            scope: RetainedManagedProviderRuntimeInvocationScope;
            sharedGateway?: SharedManagedProviderGatewayBinding;
            signal: AbortSignal;
            isCurrent(): boolean;
            readAdoptedPublicOutcome():
                Promise<ManagedProviderAdoptedPublicOutcome | null>;
            revalidatePolicy(): Promise<boolean>;
        }>,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices | null> {
        if (input.signal.aborted || !input.isCurrent()) return null;
        let adoptedPublicOutcome: ManagedProviderAdoptedPublicOutcome | null = null;
        try {
            const candidate = input.sharedGateway
                ? null
                : await input.readAdoptedPublicOutcome();
            if (
                !input.sharedGateway && (!candidate
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
                )))
            ) return null;
            adoptedPublicOutcome = candidate ? Object.freeze({
                ...candidate,
                endpointTemplateIds: Object.freeze([
                    ...candidate.endpointTemplateIds,
                ]),
                endpoints: Object.freeze(candidate.endpoints.map(
                    (endpoint) => Object.freeze({ ...endpoint }),
                )),
            }) : null;
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
            || (adoptedPublicOutcome && !adoptedPublicOutcome.endpointTemplateIds.includes(
                retainedProvider.runtimeBindingBasis.endpoint.endpointTemplateId,
            ))
            || (input.sharedGateway && (
                retainedProvider.declaration.sharing !== 'connectionMachine'
                || input.sharedGateway.consumerId !== scope.sessionId
                || input.sharedGateway.connectionId
                    !== retainedProvider.runtimeBindingBasis.connectionId
            ))
        ) return null;
        if (!input.isCurrent()) return null;
        const invocation =
            await createManagedProviderRuntimeInvocationServicesInternal({
                identity: retainedProvider.identity,
                purposeBindings:
                    retainedProvider.runtimeBindingBasis.deployment.purposeBindings,
                ...(input.sharedGateway ? { sharedGateway: input.sharedGateway } : {}),
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
                || (adoptedPublicOutcome && !isDeepStrictEqual(
                    await input.readAdoptedPublicOutcome(),
                    adoptedPublicOutcome,
                ))
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
        hostRuntimes: [createMcpSignInConnectedAccountRegistration()],
        resolveRetirementSignal: pluginId => resolveRuntimeConsumerLifecycle(pluginId).retirementSignal,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
        // The one unavailable activation fact carries the typed diagnostic that refused it.
        readPluginActivationFailure: pluginId => activatedRegistry.failedActivationPluginIds.has(pluginId)
            ? activatedRegistry.targetActivationFacts.find(fact => fact.pluginId === pluginId && fact.status === 'unavailable')
                ?.diagnostics.at(-1) ?? activatedRegistry.pluginDiagnosticsByPluginId[pluginId]?.at(-1)
                ?? { code: 'plugin_activation_failed', message: `Plugin '${pluginId}' did not activate` }
            : undefined,
        descriptors: authoritativeContributes.connectedAccountDescriptors ?? Object.freeze([]),
        onDescriptorUnavailable(ref, error) {
            const rejected = committed?.rejectedGenerations.get(ref.pluginId);
            logger.warn('[PLUGIN RUNTIME] Connected Account descriptor is unavailable', {
                pluginId: ref.pluginId,
                localId: ref.localId,
                reason: projectPluginFailureText(error ?? new Error(
                    rejected?.message
                    ?? 'The plugin has no admitted occurrence or source custody in this runtime',
                )),
                ...(rejected?.cause ? { cause: rejected.cause } : {}),
            });
        },
        async activateOnDemand(ref) {
            await activateContributionsOnDemand([{
                pluginId: ref.pluginId,
                family: 'connectedAccountDescriptors',
                localId: ref.localId,
            }]);
        },
        readRegistrations: () => activatedRegistry.targetRegistrations.flatMap((entry) => {
            const registration = entry.registration;
            if (registration.family !== 'connectedAccountDescriptors') return [];
            const runtime = 'realm' in registration
                ? { realm: registration.realm, runtime: registration.value }
                : { runtime: registration.value };
            return [Object.freeze({ pluginId: entry.pluginId, occurrenceId: entry.occurrenceId,
                localId: registration.localId, ...runtime })];
        }),
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
    });
    const connectedAccountContributions = connectedAccountAssembly.contributions;
    const connectedAccountRuntimeInvoker = connectedAccountAssembly.invoker;
    const connectedAccountAuthenticationHost = params?.accountExecution
        ? createCredentialedConnectedAccountAuthenticationHost({
            credentials: params.accountExecution.credentials, serverHttpBaseUrl: params.accountExecution.serverUrl,
            ...(savedSecretOperationContext ? { operationContext: savedSecretOperationContext } : {}),
            ...(resolveServerFeaturesSnapshot ? {
                readHomeWebappUrl: () => readHomeWebappUrl(resolveServerFeaturesSnapshot()),
            } : {}),
            contributions: connectedAccountContributions, invoker: connectedAccountRuntimeInvoker,
        }) : undefined;
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

    const disposeConsumers = (): void => {
        if (consumersRetired) return;
        consumersRetired = true;
        retireLiveSubscriptionConsumers();
        consumerAssembly.dispose(
            new Error('Executable plugin runtime registry consumer retired'),
        );
        invocationServiceOwners.retireConnectedAccountConsumers();
        committedTargetActionInvocations.dispose();
        connectedAccountContributions.dispose();
    };
    const retireConsumers = (): void => {
        consumerAssembly.retireAll(
            new Error('Executable plugin runtime registry consumer retired'),
        );
        disposeConsumers();
    };

    const verifyRetainedRunnerAgentServiceBinding = async (
        binding: AgentSessionRunnerBindingV1,
        unavailableCode: string,
        runnerSnapshotIdentity?: string,
    ) => {
        try {
            const verifiedBinding = verifyAgentSessionRunnerBindingV1(binding);
            if (verifiedBinding.sourceCustody.kind === 'development') {
                if (runnerSnapshotIdentity
                    && isRunnerPinnedDevelopmentAgentSource(verifiedBinding)
                    && retainedAgentSourceMatchesRunner(runnerSnapshotIdentity, verifiedBinding)) {
                    return await verifyRunnerAgentBindingAgainstGeneration({
                        paths: resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir }),
                        binding: verifiedBinding,
                        developmentRunnerSnapshotIdentity: runnerSnapshotIdentity,
                    });
                }
                const currentSourceCustody = readCurrentPluginSourceCustody(
                    verifiedBinding.pluginId,
                );
                const currentOccurrenceId = readCurrentPluginOccurrenceId(
                    verifiedBinding.pluginId,
                );
                const target = resolveExactActivationTarget(
                    verifiedBinding.pluginId,
                );
                const sourceAuthority = target
                    ? resolveCommittedActivationSource(target, {
                        recordActivatedManifestAuthority: false,
                    })?.sourceAuthority
                    : undefined;
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
                    || sourceAuthority?.kind !== 'development'
                    || !pluginSourceCustodyEqual(
                        resolvePluginSourceCustody(sourceAuthority),
                        verifiedBinding.sourceCustody,
                    )
                    || target.manifest.version !== verifiedBinding.pluginVersion
                    || !declaredAgent
                ) {
                    throw new Error('Development retained Agent is not available from the current trusted slot');
                }
                return Object.freeze({
                    binding: verifiedBinding,
                    sourceKind: 'development' as const,
                    rootPath: sourceAuthority.canonicalRoot,
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
        // Descriptor-only plugins have admitted declarations and occurrences but
        // no executable activation target. Settings consume that same authority.
        const declarations = authoritativeContributes.pluginDeclarations?.filter(declaration => declaration.pluginId === input.pluginId);
        const target = declarations?.length
            ? declarations.length === 1 ? declarations[0] : null
            : resolveExactActivationTarget(input.pluginId);
        const occurrenceId = readCurrentPluginOccurrenceId(input.pluginId);
        if (!target || !occurrenceId) return null;
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
            occurrenceId,
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
        );
        return invocationServiceOwners.createServices(seed, binding);
    };

    resolveAgentPluginSettings = async ({ pluginId, localAgentId, includeDefaults = true, signal }) => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('@happier-dev/protocol/account/settings/accountSettings');
        return await resolveAgentPluginSettingsFromService({
            pluginId, localAgentId, includeDefaults, signal,
            declarations: authoritativeContributes.settings ?? [],
            releasedAccountSettings: {
                settings: capturedSavedSecretOperationContext
                    ? capturedSavedSecretOperationContext.readSnapshot()?.rawSettings ?? null
                    : params?.accountExecution || scopedActionRuntime
                        ? null : getActiveAccountSettingsSnapshot()?.rawSettings ?? null,
                hostDefaults: ACCOUNT_SETTING_ARTIFACTS.defaults,
            },
            resolveSettingsService: () => {
                const services = createProjectionPluginServices({ pluginId });
                return services?.availability('settings').status === 'available' ? services.settings : null;
            },
        });
    };

    async function prepareAgentInvocationServiceOperation(agentParams: Parameters<CreateAgentInvocationServices>[0]) {
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
        const declaredAgentLocalId = declaredAgent.identity?.localId ?? declaredAgent.id;
        const nativeOperation = agentParams.auxiliaryNativeOperation && params?.agentIsolation?.read()?.enabled
            ? await prepareAgentAuxiliaryNativeOperation({ machine: params.agentIsolation,
                requester: readDaemonManagedServiceRequester(), correlationId: agentParams.correlationId,
                signal: agentParams.signal })
            : undefined;
        if (nativeOperation) agentParams.auxiliaryNativeOperation!.retainCleanup(nativeOperation);
        const agentIsolation = nativeOperation?.agentIsolation ?? params?.agentIsolation;
        const agentSystemTools = createDeclaredAgentCliSystemToolService({
            ...(!agentParams.agentCliLaunch ? { readMemberLaunch: () => readMemberAgentCliLaunchContext(agentIsolation, 'agent_invocation_services') } : {}),
            agentId: agentParams.agentId,
            localAgentId: declaredAgentLocalId,
            binding: declaredAgent.catalogEntry?.agentCliSystemTool,
            runtimeSpec: declaredAgent.runtimeSpec,
            agentCliLaunch: agentParams.agentCliLaunch,
            definitions: projectPluginSystemToolContributions(
                systemToolDefinitionsByPluginId.get(agentParams.pluginId) ?? Object.freeze([]),
            ),
            processEnv: createAgentCliHostResolutionEnvironment({
                ...(params?.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
            }),
            delegate: declaredAgent.catalogEntry?.agentCliSystemTool
                ? systemToolServicesByPluginId.get(agentParams.pluginId)
                : undefined,
        });
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
            ...(agentParams.workflowActionContext ? { workflowActionContext: agentParams.workflowActionContext } : {}),
            ...(agentParams.readApprovalProfileId ? { readApprovalProfileId: agentParams.readApprovalProfileId } : {}),
            ...(agentParams.processOwner ? { processOwner: agentParams.processOwner } : {}),
            ...(agentParams.readActiveTurnAdmissionWitness
                ? { readActiveTurnAdmissionWitness: agentParams.readActiveTurnAdmissionWitness }
                : {}),
            ...(!agentParams.readActiveTurnAdmissionWitness && agentParams.actionRequestAttributionV1
                ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(agentParams.actionRequestAttributionV1) }
                : {}),
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
        const connectedAccountsOwner = agentParams.connectedAccountsOwner ?? params?.connectedAccounts;
        const exactPurposeBindingSubjectId = agentParams.exactPurposeBindingSubjectId
            ?? (agentParams.processOwner?.kind === 'run'
                ? connectedAccountsOwner?.readExecutionRunPurposeBindingSubjectId?.(agentParams.processOwner.runId)
                : undefined);
        return { seed, operation: {
            filesystemRoots: Object.freeze({
                pluginData: join(storePaths.storageDir, agentParams.pluginId, 'fs'),
                workspace: nativeOperation?.workingDirectory ?? agentParams.cwd,
                projects: new Map(),
            }),
            hostAccessRequests: Object.freeze([
                ...invocationHostAccess.map((request) => Object.freeze({ request, required: true })),
                ...connectedAccountHostAccess,
            ]),
            ...(agentParams.environment ? { environment: agentParams.environment } : {}),
            ...(nativeOperation ? { agentIsolation: nativeOperation.agentIsolation,
                requesterIdentity: nativeOperation.requesterIdentity, defaultCwd: nativeOperation.workingDirectory } : {}),
            ...(agentParams.prepareAgentNativeLaunch ? { prepareAgentNativeLaunch: agentParams.prepareAgentNativeLaunch } : {}),
            ...(agentParams.assertLaunchCurrent ? { assertLaunchCurrent: agentParams.assertLaunchCurrent } : {}),
            ...(exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId } : {}),
            ...(agentParams.connectedAccountsOwner ? { connectedAccountsOwner: agentParams.connectedAccountsOwner } : {}),
            ...(agentSystemTools ? { systemTools: agentSystemTools } : {}),
        } };
    }

    const resolvedRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
        ...(params?.agentIsolation ? { scmCommandRunner: createHostScmCommandRunner({
            agentIsolation: params.agentIsolation, isCurrent: () => consumerAssembly.isOccurrenceCurrent(),
        }), scmAgentIsolation: params.agentIsolation } : {}),
        ...(accountActivationSources ? { executionRealm: 'account' as const,
            revalidateAccountExecution: accountActivationSources.revalidate,
            readAccountExecutionSelection: accountActivationSources.readSelection } : {}),
        resolveReadyManagedExecutable: (executable, pluginId) =>
            executableResolver(executable, pluginId, undefined, { requireReady: true }),
        get projectManagedServices() {
            return projectManagedServicesOwner;
        },
        currentDomainEdgeObservation,
        readHealthAlertSource: automationAssembly.readHealthAlertSource,
        readHealthCheckSource(sourceInstanceId, signal) {
            const owner = params?.accountExecution ? null : resolveHealthCheckSourceOwner();
            return owner ? readAdoptedHealthCheckBatch({ ...owner, sourceInstanceId, signal,
                resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet })
                : { kind: 'unavailable' as const, reason: 'source_unavailable' as const };
        },
        readSharedProviderGatewayRuntime(input) {
            return projectManagedServicesOwner.readSharedProviderGatewayRuntime(input);
        },
        retainProjectManagedServicesOwner(owner, isPhysicalSourceCurrent) {
            if (owner && owner !== projectManagedServicesOwner) {
                if (daemonManagedServicesOwner.listProjectServices().length > 0) {
                    throw new Error('Cannot replace established Project service custody');
                }
                projectManagedServicesOwner = owner;
            }
            projectManagedServicesOwner.configureHostBindings(daemonManagedServicesHostBindings);
            // Start recovery only after selecting the retained owner. Registry reload
            // must not make a temporary replacement adopt the same processes twice.
            void projectManagedServicesOwner.restoreProjectServices().catch(error => {
                logger.infoFile('[ProjectServices] Restart reconciliation unavailable', error);
            });
            isRetainedPhysicalSourceCurrent = isPhysicalSourceCurrent;
            preserveProjectServicesOnRegistryRetirement = projectManagedServicesOwner === daemonManagedServicesOwner;
            return projectManagedServicesOwner;
        },
        contributes: authoritativeContributes,
        durableRevision: committed?.commit?.revision ?? -1,
        declarationContributes: contributes,
        generation: activatedRegistry.generation,
        readPluginOccurrenceId: readCurrentPluginOccurrenceId,
        isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
        readPluginSourceCustody: readCurrentPluginSourceCustody,
        readAdmittedBackgroundServicePlugins(pluginIds) {
            return Object.freeze([...new Set(pluginIds)].map((pluginId) => {
                const target = activationTargets.find((candidate) => candidate.pluginId === pluginId);
                const occurrenceId = readCurrentPluginOccurrenceId(pluginId);
                const sourceCustody = readCurrentPluginSourceCustody(pluginId);
                const source = target
                    ? resolveCommittedActivationSource(target, { recordActivatedManifestAuthority: false })
                    : null;
                if (!target || !occurrenceId || !sourceCustody || !source
                    || !isCurrentPluginOccurrence(pluginId, occurrenceId)) {
                    throw new Error(`Background service source '${pluginId}' is unavailable`);
                }
                return projectAdmittedBackgroundServicePlugin({ target, occurrenceId, sourceCustody, source });
            }));
        },
        // Component retirement changes activation facts at the lifecycle owner.
        // Do not freeze the startup snapshot into the resolved registry.
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
                    ? [declaration.runtimeMaterialization]
                    : []
            ))),
        async claimReleaseLessDeclarations(): Promise<void> {
            if (scopedActionRuntime) return;
            const failures: PluginError[] = [];
            for (const [pluginId, declaration] of releaseLessDeclarationsByPluginId) {
                if (!declaration.claimsAccountIntent) continue;
                // Declaration publication admits the existing candidate, not
                // executable effect authority. Dormant targets have no active
                // runtime occurrence yet, but their source was admitted above.
                const occurrenceId = candidateOccurrenceIdsByPluginId.get(pluginId);
                if (!occurrenceId) continue;
                const lifecycle = resolveRuntimeConsumerLifecycle(pluginId);
                try {
                    await accountStorageHost.claimReleaseLessDeclaration({ pluginId, occurrenceId,
                        signal: lifecycle.retirementSignal,
                        isOccurrenceCurrent: () => lifecycle.isCurrent()
                            && candidateOccurrenceIdsByPluginId.get(pluginId) === occurrenceId });
                } catch (error) {
                    failures.push(new PluginError({
                        code: isPluginError(error) ? error.code : 'plugin_account_declaration_publication_failed',
                        details: { pluginId },
                    }, { cause: error }));
                }
            }
            if (failures.length > 0) throw new AggregateError(failures, 'Plugin Account declaration publication failed');
        },
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
        secretSources: createTargetSecretSources({
            targets: authoritativeContributes.activationTargets,
            registry: {
                activateContributionsOnDemand,
                get targetRegistrations() { return activatedRegistry.targetRegistrations; },
                isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
            },
            createInvocationContext(reference, occurrenceId, signal) {
                const target = resolveExactActivationTarget(reference.pluginId);
                if (!target) throw new Error('Secret source occurrence is unavailable');
                const lifetime = createPluginInvocationLifetime(composePluginConsumerSignal(reference.pluginId, signal));
                try {
                    const seed: PluginInvocationServicesSeed = {
                        plugin: { id: reference.pluginId, version: target.manifest.version },
                        contribution: { id: reference.localId, qualifiedId: `${reference.pluginId}/secretSources/${reference.localId}` },
                        occurrenceId, sourceCustody: readCurrentPluginSourceCustody(reference.pluginId) ?? undefined,
                        correlationId: randomUUID(), surface: 'cli', signal: lifetime.signal,
                        redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                        isOccurrenceCurrent: () => !lifetime.signal.aborted && isCurrentPluginOccurrence(reference.pluginId, occurrenceId),
                    };
                    const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({
                        manifest: target.manifest, pluginId: reference.pluginId, contribution: seed.contribution,
                    });
                    if (!hostAccessRequests) throw new Error('Secret source HostAccess is unavailable');
                    const services = invocationServiceOwners.createOperationServices(seed, {
                        filesystemRoots: { pluginData: join(pluginStorePaths.storageDir, reference.pluginId, 'fs'), projects: new Map() },
                        executionKind: 'machine_native', hostAccessRequests, environment: {},
                    });
                    return { context: { plugin: seed.plugin, contribution: seed.contribution, surface: seed.surface,
                        invokedAtMs: lifetime.invokedAtMs, signal: lifetime.signal, services }, complete: lifetime.complete };
                } catch (error) { lifetime.complete(); throw error; }
            },
        }),
        resolveProjectNativeAdapter(reference, role) {
            return resolveProjectNativeAdapter({
                reference, role, targets: authoritativeContributes.activationTargets,
                registry: {
                    activateContributionsOnDemand,
                    get targetRegistrations() { return activatedRegistry.targetRegistrations; },
                    readPluginOccurrenceId: readCurrentPluginOccurrenceId,
                    isPluginOccurrenceCurrent: isCurrentPluginOccurrence,
                },
                isAdmitted: () => resolveRuntimeConsumerLifecycle(reference.pluginId).isCurrent(),
                createInvocationContext(input) {
                    const target = resolveExactActivationTarget(reference.pluginId);
                    if (!target || !input.isCurrent()) throw new Error('Native adapter occurrence is unavailable');
                    const lifetime = createPluginInvocationLifetime(composePluginConsumerSignal(reference.pluginId, input.signal));
                    try {
                        const seed: PluginInvocationServicesSeed = {
                            plugin: { id: reference.pluginId, version: target.manifest.version },
                            contribution: { id: reference.localId, qualifiedId: `${reference.pluginId}/projectNativeAdapters/${reference.localId}` },
                            occurrenceId: input.occurrenceId,
                            sourceCustody: readCurrentPluginSourceCustody(reference.pluginId) ?? undefined,
                            correlationId: randomUUID(), surface: 'cli',
                            signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                            isOccurrenceCurrent: () => !lifetime.signal.aborted && input.isCurrent(),
                        };
                        const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({
                            manifest: target.manifest, pluginId: reference.pluginId, contribution: seed.contribution,
                        });
                        if (!hostAccessRequests) throw new Error('Native adapter HostAccess is unavailable');
                        const services = invocationServiceOwners.createOperationServices(seed, {
                            filesystemRoots: { pluginData: join(pluginStorePaths.storageDir, reference.pluginId, 'fs'),
                                ...(input.machine ? {} : { workspace: input.root }), projects: new Map() },
                            ...(input.machine ? { executionKind: 'machine_native' as const }
                                : { agentLaunchKind: 'workspaceExec' as const, executionKind: input.executionKind,
                                    requesterIdentity: input.requesterIdentity }),
                            assertLaunchCurrent: input.assertLaunchCurrent,
                            hostAccessRequests, environment: input.environment,
                        });
                        return { context: { plugin: seed.plugin, contribution: seed.contribution, surface: seed.surface,
                            invokedAtMs: lifetime.invokedAtMs, signal: lifetime.signal, services }, complete: lifetime.complete };
                    } catch (error) { lifetime.complete(); throw error; }
                },
            });
        },
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
        acquireProviderUsageParsers,
        acquireProviderRequestCostParser,
        runManagedProviderExplicitStart,
        retireManagedProviderExplicitStart,
        retireManagedProviderExternalApiKey,
        revalidateManagedProviderExplicitStarts,
        retireManagedProviderExplicitStarts,
        createManagedProviderRuntimeInvocationServices,
        prepareManagedProviderSessionBootstrap,
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
        resolveAccountConnectedAccountRuntime: connectedAccountContributions.resolveAccount,
        connectedAccountRuntimeInvoker,
        connectedAccountAuthenticationHost,
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
        projectMcpServerItems(catalog) {
            return projectPluginMcpServerItems({ catalog, activePlugins: authoritativeContributes.mcpServers ?? [],
                resolveExecutable: async (ref, pluginId) => {
                    const executable = await executableResolver(ref, pluginId);
                    if (executable.release) activatedRegistry.addRuntimeDisposable(pluginId, { dispose: executable.release });
                    return executable;
                },
            });
        },
        async materializePluginMcpServers(input) {
            let servers = input.servers;
            const pluginIds = [...new Set(servers.flatMap(server => {
                const ref = parseMcpPluginItemIdV1(server.id);
                const declaration = ref && authoritativeContributes.mcpServers?.find(entry => entry.pluginId === ref.pluginId && entry.definition.id === ref.localId);
                return ref && declaration?.definition.kind === 'dynamic' ? [ref.pluginId] : [];
            }))];
            for (const pluginId of pluginIds) {
                input.signal?.throwIfAborted();
                const declarations = authoritativeContributes.mcpServers?.filter(entry => entry.pluginId === pluginId && entry.definition.kind === 'dynamic'
                    && servers.some(server => server.id === mcpPluginItemIdV1({ pluginId, localId: entry.definition.id }))) ?? [];
                await activateContributionsOnDemand(declarations.map(entry => ({ pluginId, family: 'mcp.servers', localId: entry.definition.id })));
                const target = resolveExactActivationTarget(pluginId);
                const resolutionInput: McpSessionResolutionInput = input.scope.kind === 'session' ? { sessionId: input.scope.sessionId }
                    : { executionRunId: input.scope.executionRunId };
                const resolver = target && resolvedRuntimeRegistryOwner?.createPluginMcpSessionResolver?.({ pluginId,
                    pluginVersion: target.manifest.version, signal: input.signal, addDisposable: input.addDisposable, permissionHandler: input.permissionHandler,
                    resolveHostSession: async () => ({ bindingId: input.scope.kind === 'session' ? input.scope.sessionId : input.scope.executionRunId,
                        ...resolutionInput, directory: input.directory,
                        servers, ...(input.currentSession ? { currentSession: input.currentSession } : {}) }),
                });
                if (!resolver) throw new PluginError({ code: 'plugin_mcp_transport_unavailable', message: 'Plugin MCP attachment is unavailable' });
                servers = await resolver.resolveForSession({ ...resolutionInput, directory: input.directory });
            }
            input.signal?.throwIfAborted();
            return servers;
        },
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
                    mcpParams.signal?.throwIfAborted();
                    if (!hostSession) {
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
                        ...(hostSession.sessionId ? { session: Object.freeze({ id: hostSession.sessionId }) } : {}),
                        currentSession: hostSession.currentSession,
                        signal: mcpParams.signal ?? new AbortController().signal,
                        isOccurrenceCurrent,
                    });
                    const projected: ResolvedSessionMcpServer[] = [...hostSession.servers];
                    for (const [index, selected] of hostSession.servers.entries()) {
                        const ref = parseMcpPluginItemIdV1(selected.id);
                        const declaration = ref && authoritativeContributes.mcpServers?.find(entry => entry.pluginId === mcpParams.pluginId
                            && entry.pluginId === ref.pluginId && entry.definition.id === ref.localId);
                        if (!ref || declaration?.definition.kind !== 'dynamic') continue;
                        const item = { ref };
                        const currentSession = hostSession.sessionId && mcpParams.permissionHandler
                            ? (await import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions')).createNativeAgentCurrentSessionUiServices({
                                permissionHandler: mcpParams.permissionHandler, pluginId: ref.pluginId, contributionId: ref.localId,
                                runtimeId: `${ref.pluginId}/mcp.servers/${ref.localId}`, sessionId: hostSession.sessionId,
                                occurrenceId, sourceCustody, signal: mcpParams.signal, isCurrent: isOccurrenceCurrent,
                            }) : hostSession.currentSession;
                        const stableService = mcpHost.bind({ ...seed, contribution: { id: ref.localId,
                            qualifiedId: `${ref.pluginId}/mcp.servers/${ref.localId}` }, ...(currentSession ? { currentSession } : {}) });
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
                                const client = await stableService.connect(item.ref, hostSession.sessionId
                                    ? { sessionId: hostSession.sessionId, elicitation: { mode: 'hostMediated', sessionId: hostSession.sessionId } }
                                    : { elicitation: { mode: 'reject' } });
                                try {
                                    const tools = await client.listTools();
                                    const spec: PluginHostedMcpServerSpec = Object.freeze({
                                        id: `stable-${randomUUID()}`,
                                        name: selected.name,
                                        transport: Object.freeze({
                                            kind: 'hosted',
                                            exposure: Object.freeze({
                                                kind: 'loopbackHttp',
                                                requested: true,
                                            }),
                                        }),
                                        hosted: Object.freeze({
                                            tools: Object.freeze(tools.items.map((tool) => Object.freeze({
                                                name: tool.name,
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
                                        toolNameSource: 'mcpServer',
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
                                        id: selected.id,
                                        name: selected.name,
                                        ...(selected.title ? { title: selected.title } : {}),
                                        transport: Object.freeze({
                                            kind: 'http',
                                            url: handle.endpoint.url,
                                            headers: handle.endpoint.headers,
                                        }),
                                        scope: Object.freeze({
                                            ...(hostSession.sessionId ? { sessionId: hostSession.sessionId } : { executionRunId: hostSession.executionRunId }),
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
                        projected[index] = (await attachment).resolved;
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
                    ...(attachment?.detectedServers ? { detectedServers: attachment.detectedServers } : {}),
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
            if (settingsParams.accountSettingsRecordAdapter) {
                // A requester supplies an Account record owner, never an ambient daemon record.
                if (settingsParams.scope.kind !== 'account') return null;
                const seed = createProjectionPluginInvocationSeed(settingsParams);
                if (!seed) return null;
                const host = createProductionPluginSettingsHostFactory({
                    accountScoped: true,
                    accountSettingsRecordAdapter: settingsParams.accountSettingsRecordAdapter,
                    broker: createStablePluginEventsBroker(),
                })((authoritativeContributes.settings ?? []).flatMap(entry => entry.pluginId && entry.definition.scope === 'account'
                    ? [{ pluginId: entry.pluginId, contribution: entry.definition }] : []));
                return host.bind(seed)?.forScope(settingsParams.scope) ?? null;
            }
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
            );
            const services = invocationServiceOwners.createServices(seed, binding);
            return services.availability('events').status === 'available' ? services.events.plugin : null;
        },
        async attestRetainedRunnerAgentServiceBinding(input) {
            return await verifyRetainedRunnerAgentServiceBinding(
                input.binding,
                'plugin_services_retained_generation_untrusted',
                input.runnerSnapshotIdentity,
            );
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
                    input.runnerSnapshotIdentity,
                );
            if (
                await readHardRevocationRevision()
                    !== input.pluginHardRevocationRevision
            ) return null;

            const provenance = verified.manifestAuthority
                === 'bundled_first_party'
                ? 'first_party' as const
                : 'external' as const;
            const declaredAgent = projectManifestAgentContribution({
                definition: verified.declaredAgent,
                provenance,
                source: {
                    kind: provenance === 'first_party'
                        ? 'bundled'
                        : 'package',
                },
                pluginId: verified.binding.pluginId,
                admittedAgentId: verified.binding.agentId,
                systemTools: verified.manifest.contributes.systemTools,
                hostAccess: verified.manifest.hostAccess,
            });
            const retainedLeaf = await loadRetainedAgentRuntimeLeaf({
                paths,
                binding: verified.binding,
                ...(verified.sourceKind === 'development' ? {
                    developmentOccurrenceId: verified.cacheIdentity,
                    ...(isRunnerPinnedDevelopmentAgentSource(verified.binding) ? {
                        developmentRunnerSnapshotIdentity: input.runnerSnapshotIdentity,
                    } : {}),
                } : {}),
            });
            let acquired = false;
            try {
                if (await readHardRevocationRevision() !== input.pluginHardRevocationRevision) {
                    return null;
                }
                const retainedAgent = Object.freeze({
                    ...declaredAgent,
                    catalogEntry: retainedLeaf.catalogEntry,
                });
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
                const lease = Object.freeze({
                    contributes: retainedContributes,
                    // The Session marker/authority document retains G. Current H/I
                    // may move without invalidating G; hard revocation is fenced by
                    // the daemon authority owner and the revision reads above.
                    isCurrent: () => !released,
                    async release() {
                        if (released) return;
                        released = true;
                        await retainedLeaf.dispose();
                    },
                });
                acquired = true;
                return lease;
            } finally {
                if (!acquired) await retainedLeaf.dispose();
            }
        },
        async createRetainedRunnerAgentCurrentGlobalActionsService(
            agentParams,
        ) {
            const verified =
                await verifyRetainedRunnerAgentServiceBinding(
                    agentParams.binding,
                    'plugin_services_retained_generation_unavailable',
                    agentParams.runnerSnapshotIdentity,
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
                ...(agentParams.processOwner ? { processOwner: agentParams.processOwner } : {}),
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
                    agentParams.runnerSnapshotIdentity,
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
                    agentParams.runnerSnapshotIdentity,
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
                    agentParams.runnerSnapshotIdentity,
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
            const systemTools = createDeclaredAgentCliSystemToolService({
                ...(!agentParams.agentCliLaunch ? { readMemberLaunch: () => readMemberAgentCliLaunchContext(params?.agentIsolation, 'retained_runner_agent_services') } : {}),
                agentId: binding.agentId,
                localAgentId: binding.localAgentId,
                binding: declaredAgent.catalog?.agentCliSystemTool,
                ...(declaredAgent.cli ? { runtimeSpec: projectNativeAgentCliRuntimeDescriptor({
                    agentId: binding.agentId, title: declaredAgent.title, cli: declaredAgent.cli,
                }) } : {}),
                agentCliLaunch: agentParams.agentCliLaunch,
                definitions: systemToolDefinitions,
                processEnv: createAgentCliHostResolutionEnvironment({
                    ...(params?.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
                }),
                delegate: genericSystemTools,
            });
            const retainedManagedDependencies = binding.sourceCustody.kind === 'development'
                && currentOccurrenceId
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
                    ...(agentParams.runnerSnapshotIdentity
                        ? { runnerSnapshotIdentity: agentParams.runnerSnapshotIdentity }
                        : {}),
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
                    ...(agentParams.exactPurposeBindingSubjectId
                        ? { exactPurposeBindingSubjectId: agentParams.exactPurposeBindingSubjectId }
                        : {}),
                    ...(agentParams.connectedAccountsOwner
                        ? { connectedAccountsOwner: agentParams.connectedAccountsOwner }
                        : {}),
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
                ...(params?.agentIsolation ? { agentIsolation: params.agentIsolation } : {}),
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
            const prepared = await prepareAgentInvocationServiceOperation(agentParams);
            return invocationServiceOwners.createOperationServices(prepared.seed, prepared.operation);
        },
        async prepareBackgroundServiceProcessAgentServices(agentParams) {
            const prepared = await prepareAgentInvocationServiceOperation({
                ...agentParams,
                isOccurrenceCurrent: () => isCurrentPluginOccurrence(agentParams.pluginId, agentParams.occurrenceId),
            });
            return invocationServiceOwners.prepareBackgroundServiceProcessOperationServices(prepared.seed, prepared.operation);
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
                onOptionalUnavailable: promptParams.onOptionalUnavailable,
                promptAssets: (authoritativeContributes.promptAssets ?? [])
                    .filter((asset) => !excludedPluginIds.has(asset.pluginId)),
                resolveContributionOccurrence: (pluginId) => (
                    candidateOccurrenceIdsByPluginId.get(pluginId) ?? null
                ),
                isContributionOccurrenceCurrent: (pluginId, occurrenceId) => (
                    consumerAssembly.isPluginCurrent(pluginId)
                    && candidateOccurrenceIdsByPluginId.get(pluginId) === occurrenceId
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
            await prepareUiResourceDemand(resourceParams);
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
            const readController = new AbortController();
            const signal = resourceParams.signal
                ? AbortSignal.any([resourceParams.signal, readController.signal]) : readController.signal;
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
            try {
                assertResourceBindingCurrent();
                const service = await resourcesOwner.bindForResource({
                    pluginId: resourceParams.callerPluginId,
                    resourceId: resourceParams.resourceId,
                    ...(resourceParams.query ? { query: resourceParams.query } : {}),
                    signal,
                    isOccurrenceCurrent: isResourceBindingCurrent,
                    ...(resourceParams.context === undefined ? {} : { context: resourceParams.context }),
                });
                assertResourceBindingCurrent();
                return await service.read(resourceParams.resourceId, { signal });
            } finally { readController.abort(); }
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
            const binding = invocationServiceOwners.createOrdinaryServiceBinding(
                imageParams.expectedCallerOccurrenceId,
                `${target.pluginId}/ui/stored-image`,
            );
            const credentials = await readSessionCredentials();
            if (!credentials) throw new PluginError({ code: 'plugin_sessions_not_authenticated', message: 'Session image read requires an Account' });
            const [raw, account] = await Promise.all([
                fetchSessionById({ reason: 'session-content', token: credentials.token, sessionId: imageParams.media.file.sessionId }),
                fetchAccountEncryptionCurrentness({ credentials, token: credentials.token }),
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
                    scopes: binding.sessionScopes ?? [],
                    session: projectPluginSessionAccessIdentity(raw, metadata),
                    accountEncryptionMode: account.mode, sessionEncryptionMode: raw.encryptionMode,
                },
            });
            assertCurrent();
            if (verification.status !== 'verified') throw new PluginError({ code: 'plugin_session_media_unavailable', message: 'Session image is outside the declared read scope or unavailable' });
            return { bytesBase64: verification.bytes.toString('base64'), mimeType: 'image/png', width: imageParams.media.width, height: imageParams.media.height };
        },
        async openUiResourceWatch(watchParams) {
            await prepareUiResourceDemand(watchParams);
            const watches = requireCurrentUiResourceWatches(
                watchParams.callerPluginId,
                watchParams.expectedCallerOccurrenceId,
            );
            return await watches.open({
                callerPluginId: watchParams.callerPluginId,
                subscriptionId: watchParams.subscriptionId,
                ...(watchParams.resourceId === undefined ? {} : { resourceId: watchParams.resourceId }),
                ...(watchParams.readAuthority === undefined ? {} : { readAuthority: watchParams.readAuthority }),
                ...(watchParams.context === undefined ? {} : { context: watchParams.context }),
            });
        },
        async pollUiResourceWatch(watchParams) {
            if (accountActivationSources && !await accountActivationSources.revalidate(watchParams.callerPluginId, watchParams.signal)) {
                if (watchParams.signal?.aborted) {
                    throw new PluginError({ code: 'plugin_resource_aborted', message: 'Resource operation was aborted' });
                }
                resourcesOwner?.retirePlugin(watchParams.callerPluginId);
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Account Resource custody is no longer current' });
            }
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
            }) === true;
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
            retireLiveSubscriptionConsumers();
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
        uiResourceWatches,
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
        startConfiguredActivation,
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
                preparedActivationRegistryLeaseOwners
                    .filter((owner) => ![...owner.pluginIds].some((pluginId) => (
                        consumerAssembly.isPluginRetired(pluginId)
                    )))
                    .map((owner) => owner.retain()),
            ),
        } : {}),
    };
    resolvedRuntimeRegistryOwner = resolvedRuntimeRegistry;
    // Constructor-time activation still starts only at publication. Once this
    // registry serves, bind newly registered subscriptions before their service
    // can emit its first Event, using the same canonical binding owner.
    captureActivatedPluginConsumerPreparation = pluginId => {
        const wasServing = declaredEventSubscriptionsPublished;
        const assertServingCustody = () => {
            // A held predecessor lease can keep the component physically alive
            // after its live subscription custody moved to the successor.
            if (wasServing && !declaredEventSubscriptionsPublished) {
                throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin serving generation retired during consumer preparation' });
            }
        };
        return async () => {
            assertServingCustody();
            await refreshDeclaredEventSubscriptionBindings();
            await automationAssembly.refreshActivatedPlugin(pluginId);
            assertServingCustody();
        };
    };
    async function startConfiguredActivation(): Promise<void> {
        if (params?.accountExecution || !declaredEventSubscriptionsPublished || !consumerAssembly.isOccurrenceCurrent()) return;
        configurationActivationStart ??= (async () => {
            configurationActivationObserver = await observePluginConfigurationActivation({
                // A plugin whose continuous work all belongs to Machine roles that are off is not
                // activated by configuration; demand (Actions, notifications) still activates it.
                targets: activationTargets.filter(target => !isAutomaticActivationSuppressedByMachineRoles(target)),
                accountStorage: accountStorageHost,
                readAutomationEventSourceDemand: readConfiguredAutomationEventSourceDemand,
                subscribeAutomationEventSources(listener) {
                    const subscription = invocationServiceOwners.stableEventsBroker.subscribeHost({
                        target: { eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } },
                        listener: event => {
                            if (event.eventId === '@happier/automation/event-sources-invalidated') listener(event.payload.pluginIds);
                        },
                        isCurrent: () => declaredEventSubscriptionsPublished && consumerAssembly.isOccurrenceCurrent(),
                    });
                    return () => { void subscription.dispose(); };
                },
                activate: activateContributionsOnDemand,
                isActivated: pluginId => activatedRegistry.activatedPluginIds.has(pluginId),
                isTargetCurrent: pluginId => consumerAssembly.isPluginCurrent(pluginId),
                readOccurrenceId: pluginId => candidateOccurrenceIdsByPluginId.get(pluginId) ?? null,
                isCurrent: () => declaredEventSubscriptionsPublished && consumerAssembly.isOccurrenceCurrent(),
                signal: consumerAssembly.allRetirementSignal,
            });
            if (!declaredEventSubscriptionsPublished) configurationActivationObserver.dispose();
        })();
        await configurationActivationStart;
    }
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

export type { ResolvedManagedProviderRuntimeInvocationServices, ManagedProviderSessionCustodyBinding, ManagedProviderSessionBootstrapPreparation, ManagedProviderRuntimeOperationClaim, ManagedProviderExplicitStartJoinResult, ManagedProviderExplicitStartJoinInput, RetainedManagedProviderRuntimeInvocationScope, ManagedProviderAdoptedPublicOutcome, ManagedProviderInvocationAccountAuthority } from './providerBindings/runtimeTypes';

export type { PluginRuntimeGenerationAuthority, PluginContributionRuntimeLifecycle, ResolvedExecutablePluginRuntimeRegistry, PluginRuntimeMachineAdmissionTransport } from './composition/executableTypes';

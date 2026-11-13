import type { PluginAccountSettingsRecordAdapter } from '../invocation/services/settings';
import type { ResolvedManagedProviderRuntimeInvocationServices, ManagedProviderSessionBootstrapPreparation, ManagedProviderRuntimeOperationClaim, ManagedProviderExplicitStartJoinResult, ManagedProviderExplicitStartJoinInput, RetainedManagedProviderRuntimeInvocationScope, ManagedProviderAdoptedPublicOutcome, ManagedProviderInvocationAccountAuthority } from '../providerBindings/runtimeTypes';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import type { resolveProjectNativeAdapter, ProjectNativeAdapterResolutionV1 } from '../lifecycle/contributions/targetProjectNativeAdapters';
import type { ProjectNativeAdapterRoleV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { ResolvedPluginExecutable } from '../invocation/services/exec';
import type { ScmCommandRunner } from '@/scm/runtime';
import type { DaemonPluginStoredImageReadRequest } from '@happier-dev/protocol';
import type { PluginUiReadStoredImageResultV1 } from '@happier-dev/protocol/plugins/ui';
import type { SharedManagedProviderGatewayBinding } from '../invocation/services/managedServicesAdapter';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import type { PluginSourceCustody } from '../sourceAuthority';
import type { CredentialedConnectedAccountAuthenticationHost } from '../connectedAccounts/authenticationHost';
import type { ReleaseLessPluginDeclaration } from '@/plugins/availability/releaseLessDeclarations';
import type { PluginRuntimeActivationRegistryLease } from './activationAssembly';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import type { resolveMergedContributionRegistry } from '../../projection/registry/createResolvedContributionRegistry';
import type { ResolvedCatalogEntry, ResolvedContributionRegistry, ResolvedManagedProviderRuntime, ResolvedProviderCatalogParsers, ResolvedProviderUsageParsers, ResolvedProviderRequestCostParser } from '../../projection/registry/types';
import type { QualifiedConnectedAccountPurposeBindingsV1, PluginContributionIdentityV1, PluginMachineExecutionOriginV1, PluginMachineMaterializationRefV1, TargetActionApprovalReplayPlacementV1, NormalizedPluginAccountCollectionContractV1, PluginCollectionCandidatePreparationBindingV1, PluginCollectionContractRefV1, PluginReleaseRefV1, PluginUiArtifactDigestV1, PluginResourceContextV1, PluginActionPresentUserGatePolicy } from '@happier-dev/protocol';
import type { HostSemanticEventV1 } from '@happier-dev/protocol';
import type { HostStructuredMessageDescriptorV1 } from '../invocation/services/structuredMessageDescriptor';
import type { activatePluginRuntimeRegistry } from '../lifecycle/manager';
import type { ResolvedPluginHookHandler } from '../types';
import type { AdmittedBackgroundServicePlugin } from '../lifecycle/contributions/backgroundServiceProcessSource';
import type { createTargetVoiceSpeechRegistry } from '../lifecycle/contributions/targetVoiceSpeech';
import type { createTargetComposerAttachmentRegistry } from '../lifecycle/contributions/targetComposerAttachments';
import type { createTargetComposerReferenceRegistry } from '../lifecycle/contributions/targetComposerReferences';
import type { ClientContributedActionExecutor } from '../invocation/actions/executeContributedAction';
import type { CurrentGlobalExternalSessionsRouter } from '@/session/external/currentGlobalRouting';
import type { createTargetActionInvocationRegistry } from '../invocation/targetActionRegistry';
import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { PluginDaemonDatabaseCapability, PluginDaemonDatabasePreparedContract, PluginDaemonDatabaseQuiescence } from '../context/daemonDatabase';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { StablePluginConnectedAccountsOwner } from '../invocation/services/connectedAccounts';
import type { StablePluginNotificationsOwner } from '../invocation/services/notifications';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ResourceSessionAccessWitness, StablePluginResourcesOwner } from '../invocation/services/resources';
import type { PluginUiResourceWatchPollResult } from '../invocation/services/uiResourceWatch';
import type { PluginUiResourceWatchOwner } from '../invocation/services/uiResourceWatch';
import type { StablePluginStructuredMessageResolution } from '../invocation/services/structuredMessageConsumer';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginEvents } from '@happier-dev/plugin-sdk/events';
import type { McpDiscoveryRequest as PluginMcpDiscoveryRequest } from '@happier-dev/plugin-sdk/mcp';
import type { PluginResourceKind } from '@happier-dev/plugin-sdk/resources';
import type { ScopedSettingsService, SettingsScopeRef } from '@happier-dev/plugin-sdk/settings';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { DeclaredDaemonPluginSecretAdministrationPort } from '../context/secrets';
import type { ResolvedMcpEndpointDiscoveryResult } from '@/mcp/runtimeTypes';
import type { TargetPluginInterceptedRequest as PluginInterceptedRequest, TargetPluginInterceptorResult as PluginInterceptorResult, TargetRequestInterceptorBinding } from '../lifecycle/contributions/targetRequestInterceptors';
import type { AgentInvocationTurnAdmissionWitness, CreateAgentInvocationServices } from '../invocation/services/types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import type { createConnectedAccountContributionRegistry, ConnectedAccountRuntimeLease, ConnectedAccountPortableRuntimeLease } from '../connectedAccounts/contributionRegistry';
import type { ConnectedAccountHostRuntimeInvoker } from '../connectedAccounts/runtimeInvoker';
import type { StablePluginManagedDependenciesHost } from '../invocation/services/managedDependencies';
import type { RetainedRunnerAgentServiceBinding } from '../runner/loadRetainedAgentRuntimeLeaf';
import type { AgentSessionRunnerBindingV1 } from '../runner/agentSessionRunnerFactoryBinding';
import type { createManagedServicesOwner } from '../invocation/services/managedServicesOwner';
import type { CurrentDomainEdgeObservation } from '@/deployments/healthChecks/currentDomainEdgeObservation';
import type { readAdoptedHealthCheckBatch } from '@/deployments/healthChecks/readAdoptedHealthCheckBatch';
import type { ManagedServiceCredentialFileOwner } from '../invocation/services/managedServicesAdapter';
import type { RunnerManagedDependencyRetentionV1 } from '../runner/runnerManagedDependencyRetention';
import type { BoundAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import type { PluginContributionRef, PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginAccessSelection } from '../../store/install/accessScopeRegistry';
import type { readCurrentCommittedPluginGenerations } from '../../store/registry/generationStore';
import type { OptionalPromptAssetUnavailable } from '@/agent/prompting/contributions/resolvePromptAssetContributionBlocks';
import type { PromptBlockV1 } from '@happier-dev/protocol';
import type { ContributionPolicyFacts } from '../policy/evaluate';
import type { PluginFinalPolicyCurrentRuntime } from '../policy/facts';
import type { createPluginMcpSessionResolver } from '../context/mcp';
import type { McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { PluginExecutionScopeV1 } from '@happier-dev/protocol';
import type { McpSessionResolutionInput, PluginMcpSessionResolver, ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';

export type PluginRuntimeGenerationAuthority = NonNullable<Awaited<ReturnType<typeof readCurrentCommittedPluginGenerations>>>;

export type PluginContributionRuntimeLifecycle = Readonly<{
    occurrenceId: string;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export type ResolvedExecutablePluginRuntimeRegistry = Readonly<{
    /** Same installed observer's runtime-only current Domain edge facts. */
    currentDomainEdgeObservation?: CurrentDomainEdgeObservation;
    /** Finite current-source projection from the same local saved observer, without another adoption owner. */
    readHealthCheckSource?: (sourceInstanceId: string, signal: AbortSignal) => ReturnType<typeof readAdoptedHealthCheckBatch>;
    /** Native notification admissions borrow the pushed, current Account source view. */
    readHealthAlertSource?: (sourceInstanceId: string) => Promise<import('@/deployments/healthChecks/readSavedHealthCheckSource').SavedHealthCheckSourceRead>;
    /** Incumbent Resource continuation owner; host Account demand carries no plugin occurrence. */
    uiResourceWatches?: PluginUiResourceWatchOwner;
    /** Host-private SCM process port, sharing this registry's held launch context. */
    scmCommandRunner?: ScmCommandRunner;
    /** Same held daemon context; never serialized to plugins or runners. */
    scmAgentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
    executionRealm?: 'account';
    revalidateAccountExecution?(pluginId: string, signal?: AbortSignal): Promise<boolean>;
    readAccountExecutionSelection?(pluginId: string): import('@happier-dev/protocol/plugins/availability').PluginAccountExecutionSelectionV1 | null;
    /** Host reads may launch an installed executable, but never acquire one implicitly. */
    resolveReadyManagedExecutable?(
        executable: ManagedExecutableRef,
        pluginId: string,
    ): Promise<ResolvedPluginExecutable>;
    /** Host-private service supervision/control; the SDK remains plugin-scoped. */
    projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>,
        'superviseProject' | 'resolveProjectService' | 'listProjectServices' | 'restoreProjectServices' | 'resolveEnvironmentService' | 'readEnvironmentServiceLogRedactionLease' | 'machineServiceRows' | 'bindWorkloads'
        | 'superviseMachine' | 'listMachineServices' | 'retireMachineServices' | 'resolveNativeService'
        | 'activity' | 'readProcessRoots' | 'readResourceTargets' | 'readNativeContainerSources' | 'readMachineRebootServices' | 'resolveSetupScriptServiceEffects'>;
    /** Reads the retained daemon custody owner without activating a contribution. */
    readSharedProviderGatewayRuntime?: ReturnType<typeof createManagedServicesOwner>['readSharedProviderGatewayRuntime'];
    /** Transfers the same generic Project/shared Provider custody at publication. */
    retainProjectManagedServicesOwner?(owner?: ReturnType<typeof createManagedServicesOwner>,
        isPhysicalSourceCurrent?: (pluginId: string, occurrenceId: string, sourceCustody: PluginSourceCustody) => boolean):
        ReturnType<typeof createManagedServicesOwner>;
    // Includes internal merged contribution surfaces (`catalogEntry`).
    contributes: Awaited<ReturnType<typeof resolveMergedContributionRegistry>>;
    /** Declaration input for successor composition, before activation callbacks are projected. */
    declarationContributes: ResolvedContributionRegistry;
    /**
     * Durable installed-catalog revision from which this runtime was resolved.
     * Controller-published leases use it only to avoid joining two different
     * current snapshots; partial fixtures without this fact fail closed there.
     */
    durableRevision?: number;
    generation: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['generation'];
    readPluginOccurrenceId(pluginId: string): PluginRuntimeOccurrenceId | null;
    isPluginOccurrenceCurrent(
        pluginId: string,
        occurrenceId: PluginRuntimeOccurrenceId,
    ): boolean;
    readPluginSourceCustody?(pluginId: string): PluginSourceCustody | null;
    /** Exact daemon-admitted sources for a background child; this does not activate them. */
    readAdmittedBackgroundServicePlugins?(pluginIds: readonly string[]): readonly AdmittedBackgroundServicePlugin[];
    targetActivationFacts?: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['targetActivationFacts'];
    targetActionInvocations: ReturnType<typeof createTargetActionInvocationRegistry>;
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
    /** Claims admitted Account declarations through the incumbent Data host, without native activation. */
    claimReleaseLessDeclarations(): Promise<void>;
    /** Serving registry admission, joined after the incumbent Availability/claim publication attempt. */
    startConfiguredActivation(): Promise<void>;
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
     * exact current installed materialization or admitted source custody.
     */
    resolveCurrentPluginExecutionOrigin?(
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<PluginMachineExecutionOriginV1 | null>;
    /**
     * The same runtime owner resolves the exact daemon placement required by
     * a durable API Action approval. Unlike an SDK execution origin, this
     * placement deliberately has no plugin materialization component. The
     * observed Home identity stays host-private for the approval origin writer.
     */
    resolveCurrentPluginApprovalReplayPlacement?(
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<(TargetActionApprovalReplayPlacementV1 & Readonly<{ serverIdentityId?: string }>) | null>;
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
    resolveProjectNativeAdapter(reference: PluginContributionIdentityV1, role: ProjectNativeAdapterRoleV1): Promise<ProjectNativeAdapterResolutionV1>;
    secretSources?: import('../lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1;
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
    acquireProviderUsageParsers?(
        ref: PluginContributionRef,
    ): Promise<ResolvedProviderUsageParsers | null>;
    acquireProviderRequestCostParser?(
        ref: PluginContributionRef,
    ): Promise<ResolvedProviderRequestCostParser | null>;
    createManagedProviderRuntimeInvocationServices?(input: Readonly<{
        accountAuthority?: ManagedProviderInvocationAccountAuthority;
        identity: PluginContributionRef;
        purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
        operationClaim?: ManagedProviderRuntimeOperationClaim;
        modelCatalogs?: import('../invocation/services/managedServicesAdapter').ManagedProviderRuntimeInvocationBinding['modelCatalogs'];
        sharedGateway?: SharedManagedProviderGatewayBinding;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ResolvedManagedProviderRuntimeInvocationServices | null>;
    /** Source attestation only: remote workers mint no local request-auth operation. */
    prepareManagedProviderSessionBootstrap?(
        input: ManagedProviderSessionBootstrapPreparation,
    ): Promise<ResolvedManagedProviderRuntimeInvocationServices['bootstrap'] | null>;
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
        sharedGateway?: SharedManagedProviderGatewayBinding;
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
    revalidateManagedProviderExplicitStarts?(
        signal?: AbortSignal,
        selector?: Parameters<NonNullable<ResolvedExecutablePluginRuntimeRegistry['retireManagedProviderExplicitStart']>>[0],
        invalidation?: ProviderBrokerRetainedCurrentnessInvalidation,
    ): Promise<number>;
    retireManagedProviderExplicitStarts?(
        lifecycleKind: 'publicExplicitStart' | 'providerBroker',
    ): Promise<number>;
    createRetainedManagedProviderRuntimeInvocationServices?(input: Readonly<{
        scope: RetainedManagedProviderRuntimeInvocationScope;
        sharedGateway?: SharedManagedProviderGatewayBinding;
        signal: AbortSignal;
        isCurrent(): boolean;
        readAdoptedPublicOutcome():
            Promise<ManagedProviderAdoptedPublicOutcome | null>;
        revalidatePolicy(): Promise<boolean>;
    }>): Promise<ResolvedManagedProviderRuntimeInvocationServices | null>;
    activatePluginsForValidation: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['activatePluginsForValidation'];
    /**
     * Fences one plugin whose readiness was rejected after activation and records
     * its typed diagnostic (or `plugin_activation_failed` for a string reason),
     * leaving retained peers serving.
     */
    recordPluginActivationFailure: (
        ...args: Parameters<Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>['recordPluginActivationFailure']>
    ) => void | Promise<void>;
    /** DATA-DAEMON-DB's one named candidate preparation step. */
    prepareDaemonDatabases(input: Readonly<{
        pluginIds: readonly string[];
        incumbentContractsByPluginId?: ReadonlyMap<
            string,
            readonly PluginDaemonDatabasePreparedContract[]
        >;
    }>): Promise<void>;
    /** Candidate preparation quiesces only exact incumbent database owners. */
    quiesceDaemonDatabases(pluginIds: readonly string[]): Promise<PluginDaemonDatabaseQuiescence>;
    /** Exact adopted fixture callbacks available only to the next candidate. */
    readPreparedDaemonDatabaseContracts?(
        pluginId: string,
    ): readonly PluginDaemonDatabasePreparedContract[];
    /** Capability/diagnostic view of the injected measured database policy. */
    readDaemonDatabaseCapability?(pluginId: string): PluginDaemonDatabaseCapability;
    connectedAccountContributions?: ReturnType<typeof createConnectedAccountContributionRegistry>;
    resolveConnectedAccountRuntime?(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease | null>;
    resolveAccountConnectedAccountRuntime?(ref: PluginContributionRef): Promise<ConnectedAccountPortableRuntimeLease | null>;
    connectedAccountRuntimeInvoker?: ConnectedAccountHostRuntimeInvoker;
    connectedAccountAuthenticationHost?: CredentialedConnectedAccountAuthenticationHost;
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
        /** Explicit requester Account persistence; never falls back to the daemon Account. */
        accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
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
            permissionHandler?: Pick<import('@/agent/permissions/providerEnforced/handler').ProviderEnforcedPermissionHandler, 'handleToolCall'>;
            addDisposable?: (disposable: Readonly<{
                dispose(): void | Promise<void>;
            }>) => unknown;
            resolveHostSession(
                input: McpSessionResolutionInput,
            ): Promise<Readonly<{
                bindingId: string;
                sessionId?: string;
                executionRunId?: string;
                directory: string;
                servers: readonly ResolvedSessionMcpServer[];
                currentSession?: HostCurrentSessionUiServices;
            }> | null>;
        }>,
    ): PluginMcpSessionResolver | null;
    projectMcpServerItems?(catalog: McpServerCatalogV1): Promise<readonly McpPluginItemV1[]>;
    materializePluginMcpServers?(input: Readonly<{
        scope: PluginExecutionScopeV1; directory: string; servers: readonly ResolvedSessionMcpServer[]; signal?: AbortSignal;
        currentSession?: HostCurrentSessionUiServices;
        permissionHandler?: Pick<import('@/agent/permissions/providerEnforced/handler').ProviderEnforcedPermissionHandler, 'handleToolCall'>;
        addDisposable(disposable: Readonly<{ dispose(): void | Promise<void> }>): unknown;
    }>): Promise<readonly ResolvedSessionMcpServer[]>;
    discoverMcpServersForDetection?(params: Readonly<{
        pluginId: string;
        localId: string;
        input: PluginMcpDiscoveryRequest;
        signal: AbortSignal;
    }>): Promise<ResolvedMcpEndpointDiscoveryResult>;
    createAgentInvocationServices: CreateAgentInvocationServices;
    prepareBackgroundServiceProcessAgentServices?(
        agentParams: import('../lifecycle/contributions/backgroundServiceProcessBootstrap').BackgroundServiceProcessAgentInvocationRequest,
    ): Promise<import('../lifecycle/contributions/backgroundServiceProcessServices').PreparedBackgroundServiceProcessOperationServices>;
    /** Reuses exact retained/current-source attestation for daemon-owned services. */
    attestRetainedRunnerAgentServiceBinding?(params: Readonly<{
        binding: AgentSessionRunnerBindingV1;
        runnerSnapshotIdentity: string;
    }>): Promise<RetainedRunnerAgentServiceBinding>;
    /** Exact retained-G structural declarations for daemon-replacement recovery. */
    acquireRetainedRunnerAgentPurposeContributions?(params: Readonly<{
        binding: AgentSessionRunnerBindingV1;
        pluginHardRevocationRevision: number;
        runnerSnapshotIdentity?: string;
    }>): Promise<Readonly<{
        contributes: ResolvedContributionRegistry;
        isCurrent(): boolean;
        release(): Promise<void>;
    }> | null>;
    createRetainedRunnerAgentInvocationServices?(
        params: Readonly<{
            binding: AgentSessionRunnerBindingV1;
            runnerSnapshotIdentity?: string;
            sessionId: string;
            exactPurposeBindingSubjectId?: string;
            connectedAccountsOwner?: StablePluginConnectedAccountsOwner;
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
        /** The same daemon-held launch policy used by this projection's Exec. */
        agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
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
            runnerSnapshotIdentity?: string;
            sessionId: string;
            correlationId: string;
            processOwner?: import('@/processes/ownerTag').ProcessOwnerRef;
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
            runnerSnapshotIdentity?: string;
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
            runnerSnapshotIdentity?: string;
            sessionId: string;
            correlationId: string;
            signal: AbortSignal;
            isOccurrenceCurrent(): boolean;
        }>,
    ): Promise<PluginServices['sessions']['external']>;
    /** Host-private cancellation boundary for consumers of this resolved registry. */
    retirementSignal?: AbortSignal;
    /** Internal daemon-lifetime broker shared by every registry generation. */
    stableEventsBroker?: import('../invocation/services/events').StablePluginEventsBroker;
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
        onOptionalUnavailable?: (fact: OptionalPromptAssetUnavailable) => void;
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
        query?: import('@happier-dev/protocol/inputs/inputTypeRuntime').InputTypeOptionsQueryV1;
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
        resourceId?: string;
        readAuthority?: import('@happier-dev/protocol/plugins/ui/client').PluginUiReadAuthorityReferenceV1['readAuthority'];
        /** Host-stamped exact target context; contextual Resources require it. */
        context?: PluginResourceContextV1;
    }>): Promise<Readonly<{ subscriptionId: string; digest?: string }>>;
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


export type PluginRuntimeMachineAdmissionTransport = CliActionMachineAdmissionTransport;

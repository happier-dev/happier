import type {
    BackendCatalogDefinition,
    BackendDefinitionContractV1,
    AgentDefinitionContractV1,
} from '@happier-dev/agents';
import type {
  ActionDefinitionV1,
  HookCategoryV1,
  HookExecutionKindV1,
  HookScopeV1,
  AgentDefinitionV1,
  PluginAgentContributionV2,
  PluginActionContributionV2,
  PluginBackendDefinitionV1,
  BackendSurfaceDeclarationV1,
  PluginBackendCapabilitiesV1,
  PluginBrowserActionContributionV1,
  PluginBrowserTargetContributionV1,
  PluginNotificationCategoryContributionV2,
  PluginNotificationChannelContributionV2,
  PluginOpenableContentViewerContributionV1,
  PluginPromptAssetContributionV1,
  PluginExecutionRunProfileContributionV2,
  PluginHostedWebContributionV1,
  PluginSessionHeaderActionDescriptorV1,
  PluginTranscriptActivityContributionV1,
  PluginSessionInfoSectionContributionV1,
  PluginMcpDiscoverySourceContributionV1,
  PluginMcpServerContributionV1,
  PluginRequestInterceptorContributionV1,
  InstallableDependencyDescriptor,
  PluginManagedDependencyContributionV2,
  ScmBackendContribution,
  PluginSettingsContributionV2,
  PluginSystemToolContributionV1,
  ScmHostingProviderContribution,
  PluginConnectedAccountDescriptorContributionV2,
  PluginEventContributionV1,
  PluginSourceSpecV1,
  PluginContributionIdentityV1,
  PluginToolContributionV2,
  PluginCommandContributionV2,
  ProviderContributionV1,
  PluginAgentCliMetadata,
  PluginUiTranslationsContributionV1,
  PluginUiRendererV2,
  PluginUiSettingsGroupV1,
  PluginUiSettingsPageV1,
  PluginUiViewV2,
  PluginUiTranslationBundleV2,
  VoiceModelPackContributionV1,
  VoiceProviderContribution,
  NormalizedPluginAccountCollectionContractV1,
  PluginContributionPointV1,
  PluginJsonSchemaV2,
  PluginComposerAttachmentContributionV1,
  PluginComposerReferenceProviderContributionV1,
  PluginComposerControlContributionV1,
  PluginComposerRegionContributionV1,
  PreparedPluginJsonSchema,
  PluginTargetedContributionV1,
  RehydratedPluginContributionPointOperationV1,
  RehydratedPluginContributionPointSurfaceV1,
} from '@happier-dev/protocol';
import type { HostStructuredMessageDescriptorV1 } from '@/plugins/runtime/invocation/services/structuredMessageDescriptor';
import type { PluginUiArtifactsManifestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginRuntimeRegistration } from '@happier-dev/plugin-sdk/host/registration';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginContributionIntrospectionCandidate } from '@/plugins/projection/introspection/types';

export type ResolvedContributionProvenance = 'first_party' | 'external';

export type ResolvedContributionSourceKind = 'bundled' | 'path' | 'archive' | 'marketplace' | 'package';

export type ResolvedContributionSource = Readonly<{
    kind: ResolvedContributionSourceKind;
}>;

export type PluginLocaleScopedIdentity = Readonly<{
    pluginId: string;
    locale: string;
}>;

export type ResolvedTargetUiContribution<T> = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    pluginVersion?: string;
    identity: PluginContributionIdentityV1;
    manifestPath: string;
    definition: T;
}>;
export type ResolvedUiViewV2Contribution = ResolvedTargetUiContribution<PluginUiViewV2>;
export type ResolvedOpenableContentViewerContribution = ResolvedTargetUiContribution<PluginOpenableContentViewerContributionV1>;
export type ResolvedUiSettingsGroupV2Contribution = ResolvedTargetUiContribution<PluginUiSettingsGroupV1>;
export type ResolvedUiSettingsPageV2Contribution = ResolvedTargetUiContribution<PluginUiSettingsPageV1>;
export type ResolvedUiRendererV2Contribution = ResolvedTargetUiContribution<PluginUiRendererV2> & Readonly<{
    pluginRootPath?: string;
    generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;
export type ResolvedUiTranslationBundleV2Contribution = Readonly<
    Omit<ResolvedTargetUiContribution<PluginUiTranslationBundleV2>, 'identity'> & {
        localeIdentity: PluginLocaleScopedIdentity;
    }
>;
export type ResolvedComposerAttachmentContribution = ResolvedTargetUiContribution<
    PluginComposerAttachmentContributionV1
>;
export type ResolvedComposerReferenceContribution = ResolvedTargetUiContribution<
    PluginComposerReferenceProviderContributionV1
>;
export type ResolvedComposerControlContribution = ResolvedTargetUiContribution<
    PluginComposerControlContributionV1
>;
export type ResolvedComposerRegionContribution = ResolvedTargetUiContribution<
    PluginComposerRegionContributionV1
>;
export type ResolvedVoiceModelPackContribution = ResolvedTargetUiContribution<VoiceModelPackContributionV1> & Readonly<{
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}>;
export type ResolvedVoiceProviderContribution = ResolvedTargetUiContribution<VoiceProviderContribution> & Readonly<{
    pluginRootPath?: string;
    sourceSpec?: PluginSourceSpecV1;
    generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
}>;
export type ResolvedAccountCollectionContribution = ResolvedTargetUiContribution<NormalizedPluginAccountCollectionContractV1>;
/** Cold target-owned declarations; admission remains below this registry boundary. */
export type ResolvedPluginContributionPointDeclaration = ResolvedTargetUiContribution<PluginContributionPointV1>;
/** Cold contributor declarations; they have no execution authority until admitted. */
export type ResolvedTargetedPluginContributionDeclaration = ResolvedTargetUiContribution<PluginTargetedContributionV1>;

export type AdmittedTargetedContributionContributor = Readonly<{
    pluginId: string;
    contributionId: string;
    immutableGenerationId: string;
}>;

/**
 * Host-private summary of the exact input selection the target-scoped UI
 * admits for one Action. It carries no selected Account value: that remains
 * only in the transient UI settlement.
 */
export type AdmittedTargetedContributionActionInputSelection = Readonly<
    | { kind: 'none' }
    | { kind: 'connectedAccount'; fieldPath: string }
    | { kind: 'unavailable' }
>;

export type AdmittedTargetedContributionOperation = Readonly<{
    role: string;
    action: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    /** Exact parent contributor identity, retained for independent role projection. */
    contributor: AdmittedTargetedContributionContributor;
    /**
     * Current Action-definition selection fact retained only for the opaque
     * admitted-operation execution handle. It never crosses the public
     * targeted-contribution projection.
     */
    selectedActionInput: AdmittedTargetedContributionActionInputSelection;
    /** Exact target-owned parser pair retained only in the opaque Action handle binding. */
    targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;

/**
 * Host-private resolved renderer chain for an admitted embedded surface.
 * UI projection must consume this exact chain; it must not re-search the
 * global renderer catalog by local ID.
 */
export type AdmittedTargetedContributionSurface = Readonly<{
    role: string;
    /** Exact target-owned role contract for the UI mount projection; not public SDK data. */
    inputSchema: PluginJsonSchemaV2;
    /**
     * Exact normalized schema and one compiled validator owned by cold target
     * admission for this contributor generation. It never crosses RPC.
     */
    inputValidation: PreparedPluginJsonSchema;
    /** Exact target-owned parser retained by cold admission, never projected over RPC. */
    targetProtocol: RehydratedPluginContributionPointSurfaceV1;
    presentation: 'content' | 'fill';
    rendererChain: readonly ResolvedUiRendererV2Contribution[];
    /** Exact parent contributor identity, retained for independent surface projection. */
    contributor: AdmittedTargetedContributionContributor;
}>;

export type AdmittedTargetedContribution = Readonly<{
    contributor: AdmittedTargetedContributionContributor;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: ProtocolJsonValue;
    operations: readonly AdmittedTargetedContributionOperation[];
    surfaces: readonly AdmittedTargetedContributionSurface[];
}>;

export type AdmittedTargetedContributionSnapshot = Readonly<{
    target: Readonly<{
        pluginId: string;
        pointId: string;
        immutableGenerationId: string;
    }>;
    contributions: readonly AdmittedTargetedContribution[];
}>;

export type ResolvedAgentDefinitionContract = AgentDefinitionContractV1 & Readonly<
    Partial<Omit<AgentDefinitionV1, keyof AgentDefinitionContractV1>>
>;

export type ResolvedAgentRuntimeDefinitionContract = BackendDefinitionContractV1;

/**
 * Internal host projection shape.
 *
 * `catalogEntry` in merged contributes is intentionally internal-only in this
 * wave. It must not be treated as a stable external plugin ABI contract until
 * a narrower versioned contract replaces it.
 */
export type ResolvedCatalogEntry = Readonly<
    Omit<AgentCatalogEntry, 'id' | 'cliSubcommand'> & {
        id: string;
        cliSubcommand: string;
    }
>;

export type ResolvedAgentRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: PluginAgentContributionV2;
    }
    | {
        provenance: 'external';
        definition: PluginAgentContributionV2;
    }
>;

export type ResolvedAgentRuntimeRichDefinition = Readonly<
    | {
        provenance: 'first_party';
        definition: BackendCatalogDefinition;
    }
    | {
        provenance: 'external';
        definition: Omit<PluginBackendDefinitionV1, 'capabilities' | 'surfaceHandlers'> & Readonly<{
            capabilities: PluginBackendCapabilitiesV1;
            surfaceHandlers: readonly BackendSurfaceDeclarationV1[];
        }>;
    }
>;

export type ResolvedAgentContribution = Readonly<{
    id: string;
    /** Stable manifest-qualified identity. This is intentionally independent of runtime generation. */
    identity?: PluginContributionIdentityV1;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ResolvedAgentDefinitionContract;
    richDefinition?: ResolvedAgentRichDefinition;
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    /** Strict native manifest metadata retained for host-owned auth/login projections. */
    cliMetadata?: PluginAgentCliMetadata | null;
    catalogEntry?: ResolvedCatalogEntry | null;
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    /** Cold-manifest package access declarations used by Agent operation services.
     * This remains independent of executable activation-target projection. */
    hostAccess?: CanonicalPluginManifest['hostAccess'];
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>;

export type ResolvedAgentRuntimeContribution = Readonly<{
    id: string;
    agentId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    definition: ResolvedAgentRuntimeDefinitionContract;
    richDefinition?: ResolvedAgentRuntimeRichDefinition;
    runtimeKind?: string | null;
    capabilities?: PluginBackendCapabilitiesV1;
    surfaceHandlers?: readonly BackendSurfaceDeclarationV1[];
    sourceSpec?: PluginSourceSpecV1;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>;

type ResolvedProviderContributionBase = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    identity: PluginContributionIdentityV1;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ProviderContributionV1;
    /** Exact activation-owned public managed Provider runtime for this projected generation. */
    managedRuntime?: ResolvedManagedProviderRuntime;
    /**
     * Exact activation-owned public catalog wire formats this Provider
     * contributes, keyed by the `parser` id its declared probes name.
     */
    catalogParsers?: ResolvedProviderCatalogParsers;
}>;

type ProviderRuntimeRegistrationValue = Extract<
    PluginRuntimeRegistration,
    { family: 'providers' }
>['value'];

export type ResolvedManagedProviderRuntime = Readonly<{
    runtime: NonNullable<ProviderRuntimeRegistrationValue['managedRuntime']>;
    activationGeneration: string;
    immutableGenerationId: string;
    isCurrent(): boolean;
}>;

export type ResolvedProviderCatalogParsers = Readonly<{
    parsersByFormat: NonNullable<ProviderRuntimeRegistrationValue['catalogParsers']>;
    activationGeneration: string;
    immutableGenerationId: string;
    isCurrent(): boolean;
}>;

export type ResolvedProviderContribution = ResolvedProviderContributionBase;

/**
 * The author-facing presentation retained beside the executable Action shell.
 * Execution consumers keep the normalized string definition; the daemon
 * projection is the only consumer that carries these localization descriptors
 * onward to the UI presentation owner.
 */
export type ResolvedActionLocalizedPresentation = Readonly<{
    title: PluginActionContributionV2['title'];
    description?: PluginActionContributionV2['description'];
    inputHints?: PluginActionContributionV2['inputHints'];
}>;

export type ResolvedActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    pluginVersion?: string;
    identity?: PluginContributionIdentityV1;
    pluginRootPath?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    /** Signed generated UI graph retained only for the Action's exact client executable. */
    generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
    localizedPresentation?: ResolvedActionLocalizedPresentation;
    definition: ResolvedActionDefinition;
}>;

/**
 * The legacy Action schema is passthrough-shaped, so `Omit<ActionDefinitionV1,
 * 'execution'>` would erase every known field through its string index. Pick
 * its declared fields explicitly and replace only the legacy execution slot.
 */
type ActionDefinitionV1NonExecutionFields = Pick<ActionDefinitionV1,
    | 'kindVersion'
    | 'id'
    | 'title'
    | 'description'
    | 'safety'
    | 'approval'
    | 'placements'
    | 'slash'
    | 'bindings'
    | 'examples'
    | 'surfaces'
    | 'toolExposure'
    | 'contextualDefaults'
    | 'inputHints'
    | 'outputSchema'
    | 'operation'
    | 'sideEffectClass'
    | 'inputSchema'
    | 'compatibility'
>;
type ResolvedActionDefinitionBase = Readonly<
    ActionDefinitionV1NonExecutionFields & Readonly<Record<string, unknown>>
>;

type ResolvedActionPresentation = Readonly<{
    /** Manifest Action icon retained for host-rendered catalog consumers. */
    icon?: PluginActionContributionV2['icon'];
    /** Canonical V2 semantic bindings retained through the legacy passthrough shell. */
    placementBindings?: PluginActionContributionV2['placementBindings'];
    /** Canonical Action presentation order retained through the legacy passthrough shell. */
    priority?: PluginActionContributionV2['priority'];
}>;
type ResolvedActionSafety =
    | Readonly<{
        dangerLevel: 'safe';
        confirmation?: never;
    }>
    | Readonly<{
        dangerLevel: Exclude<PluginActionContributionV2['dangerLevel'], 'safe'>;
        /** Plugin-only Actions have no present-user confirmation presentation. */
        confirmation?: NonNullable<PluginActionContributionV2['confirmation']>;
    }>;

/**
 * Legacy ActionSpec callers retain their incumbent execution descriptor. They
 * are a distinct internal action domain, not a fallback for contributed
 * Actions, whose branch below always carries the closed realm target.
 */
type LegacyResolvedActionDefinition = Readonly<
    ActionDefinitionV1 & ResolvedActionPresentation & ResolvedActionSafety
>;

/** Canonical V2 contribution truth retained alongside the legacy ActionSpec shell. */
type ResolvedContributedActionDefinition = Readonly<
    ResolvedActionDefinitionBase & ResolvedActionPresentation & ResolvedActionSafety & Readonly<{
        /** The one explicit contributed-Action execution owner, retained without fallback. */
        execution: PluginActionContributionV2['execution'];
    }>
>;

export type ResolvedActionDefinition =
    | LegacyResolvedActionDefinition
    | ResolvedContributedActionDefinition;

export type ResolvedToolDefinition = Readonly<PluginToolContributionV2 & {
    kindVersion: 1;
    actionId: string;
}>;

export type ResolvedToolContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedToolDefinition;
}>;

export type ResolvedCommandVisibility = 'default' | 'advanced' | 'internal';

export type ResolvedCommandDefinition = Readonly<PluginCommandContributionV2 & {
    kindVersion: 1;
    actionId: string;
}>;

export type ResolvedCommandContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedCommandDefinition;
}>;

export type ResolvedResourceDefinition = Readonly<{
    kindVersion: 1;
    id: string;
    /** Content category (`PluginResourceKindV2Schema`). */
    type: string;
    /**
     * Sourcing discriminant (`PluginResourceSourceV2Schema`, §3.6.1). Absent
     * means packaged, matching every manifest that predates the discrimination.
     */
    source?: string | null;
    /** Dynamic arm only: immutable producer scope, defaulted by Protocol. */
    scope?: string | null;
    /** Dynamic arm only: exact manifest HostAccess request ids. */
    hostAccess?: readonly string[];
    title?: string | null;
    path?: string | null;
    digest?: string | null;
    contentType?: string | null;
    /** Dynamic arm only: declared per-read byte ceiling. */
    maxBytes?: number | null;
}>;

export type ResolvedResourceContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    pluginRootPath?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedResourceDefinition;
}>;

export type ResolvedPromptAssetContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    identity: PluginContributionIdentityV1;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    definition: PluginPromptAssetContributionV1;
}>;

export type ResolvedUiTranslationsContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginUiTranslationsContributionV1;
}>;

export type ResolvedStructuredMessageContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: HostStructuredMessageDescriptorV1;
}>;

export type ResolvedSessionHeaderActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginSessionHeaderActionDescriptorV1;
}>;
export type ResolvedTranscriptActivityContribution = ResolvedTargetUiContribution<PluginTranscriptActivityContributionV1>;
export type ResolvedSessionInfoSectionContribution = ResolvedTargetUiContribution<PluginSessionInfoSectionContributionV1>;

export type ResolvedHostedWebContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    pluginRootPath?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginHostedWebContributionV1;
}>;

export type ResolvedBrowserTargetContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginBrowserTargetContributionV1;
}>;

export type ResolvedBrowserActionContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginBrowserActionContributionV1;
}>;

export type ResolvedNotificationCategoryContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginNotificationCategoryContributionV2;
}>;

export type ResolvedNotificationChannelContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginNotificationChannelContributionV2;
}>;

export type ResolvedEventDefinition = Readonly<PluginEventContributionV1 & {
    id: string;
    localId: string;
}>;

type ResolvedEventDeclaration = Extract<ResolvedEventDefinition, Readonly<{ kind: 'event' }>>;

export type ResolvedEventContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ResolvedEventDefinition;
}>;

/**
 * Cold, current Event-automation composer facts derived by the resolved
 * contribution registry. This is deliberately not an Event registry: it is a
 * bounded view over one exact Event declaration and its same-plugin bound
 * Actions, each fenced to the current immutable plugin generation.
 */
export type ResolvedAutomationEligibleEventAction = Readonly<{
    /** Canonical plugin-qualified Action identity. */
    id: string;
    identity: PluginContributionIdentityV1;
    immutableGenerationId: string;
    title: string;
    description: string | null;
    inputSchema: ResolvedActionDefinition['inputSchema'];
    inputHints: ResolvedActionDefinition['inputHints'];
}>;

export type ResolvedAutomationEligibleEvent = Readonly<{
    event: Readonly<{
        /** Canonical plugin-qualified Event identity. */
        id: string;
        identity: PluginContributionIdentityV1;
        immutableGenerationId: string;
        title: string;
        description: string | null;
        payloadSchema?: ResolvedEventDeclaration['payloadSchema'];
        automation: NonNullable<ResolvedEventDeclaration['automation']>;
    }>;
    setupAction: ResolvedAutomationEligibleEventAction;
    /** Optional current recovery binding; absent is not a second owner or fallback. */
    historyGapResetAction?: ResolvedAutomationEligibleEventAction;
}>;

export type ResolvedSettingsContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
  definition: PluginSettingsContributionV2;
}>;

export type ResolvedExecutionRunProfileContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginExecutionRunProfileContributionV2;
}>;

export type ResolvedMcpServerContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginMcpServerContributionV1;
}>;

export type ResolvedMcpDiscoverySourceContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginMcpDiscoverySourceContributionV1;
}>;

export type ResolvedInstallableContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: InstallableDependencyDescriptor | PluginManagedDependencyContributionV2;
}>;

export type ResolvedSystemToolContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginSystemToolContributionV1;
}>;

export type ResolvedRequestInterceptorContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginRequestInterceptorContributionV1;
}>;

export type ResolvedScmHostingProviderContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    identity?: PluginContributionIdentityV1;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ScmHostingProviderContribution;
}>;

export type ResolvedScmBackendContribution = Readonly<{
    id: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    identity?: PluginContributionIdentityV1;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: ScmBackendContribution;
}>;

export type ResolvedConnectedAccountDescriptorContribution = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId?: string;
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
    definition: PluginConnectedAccountDescriptorContributionV2;
}>;

export type ResolvedActivatedHookRegistration = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    definition: Readonly<{
        hookApiVersion: 1;
        id: string;
        eventId?: string;
        category: HookCategoryV1;
        scope: HookScopeV1;
        filters?: Readonly<{
            agentId?: string;
            runtimeTargetId?: string;
            sessionId?: string;
            workspaceId?: string;
            cwdPrefix?: string;
            machineId?: string;
            eventNames?: readonly string[];
            [key: string]: unknown;
        }>;
        executionKind: HookExecutionKindV1;
        aggregation?: string;
        failureMode?: string;
        priority?: number;
        compatibility?: Readonly<Record<string, unknown>>;
        metadata?: Readonly<Record<string, unknown>>;
    }>;
}>;

export type ResolvedActivationTarget = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
    activationEvents?: readonly string[];
    manifest: CanonicalPluginManifest;
}>;

export type ResolvedContributionInputs = Readonly<{
    introspectionContributions?: readonly PluginContributionIntrospectionCandidate[];
    uiViewsV2?: readonly ResolvedUiViewV2Contribution[];
    openableContentViewers?: readonly ResolvedOpenableContentViewerContribution[];
    uiSettingsGroupsV2?: readonly ResolvedUiSettingsGroupV2Contribution[];
    uiSettingsPagesV2?: readonly ResolvedUiSettingsPageV2Contribution[];
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    uiTranslationsV2?: readonly ResolvedUiTranslationBundleV2Contribution[];
    composerReferences?: readonly ResolvedComposerReferenceContribution[];
    composerAttachments?: readonly ResolvedComposerAttachmentContribution[];
    composerControls?: readonly ResolvedComposerControlContribution[];
    composerRegions?: readonly ResolvedComposerRegionContribution[];
    agents?: readonly ResolvedAgentContribution[];
    providers?: readonly ResolvedProviderContribution[];
    catalogEntries?: readonly ResolvedCatalogEntry[];
    actions?: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources?: readonly ResolvedResourceContribution[];
    promptAssets?: readonly ResolvedPromptAssetContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    transcriptActivities?: readonly ResolvedTranscriptActivityContribution[];
    sessionInfoSections?: readonly ResolvedSessionInfoSectionContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
    browserTargets?: readonly ResolvedBrowserTargetContribution[];
    browserActions?: readonly ResolvedBrowserActionContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    events?: readonly ResolvedEventContribution[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoverySources?: readonly ResolvedMcpDiscoverySourceContribution[];
    managedDependencies?: readonly ResolvedInstallableContribution[];
    systemTools?: readonly ResolvedSystemToolContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    voiceModelPacks?: readonly ResolvedVoiceModelPackContribution[];
    voiceProviders?: readonly ResolvedVoiceProviderContribution[];
    accountCollections?: readonly ResolvedAccountCollectionContribution[];
    pluginContributionPoints?: readonly ResolvedPluginContributionPointDeclaration[];
    targetedPluginContributions?: readonly ResolvedTargetedPluginContributionDeclaration[];
    activationTargets?: readonly ResolvedActivationTarget[];
    /** Exact current materialization IDs captured with this contribution input. */
    materializationIdsByPluginId?: Readonly<Record<string, string>>;
    /** Canonical committed generations used by cold targeted-contribution admission. */
    immutableGenerationIdsByPluginId?: Readonly<Record<string, string>>;
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

export type ResolvedContributionRegistry = Readonly<{
    introspectionContributions?: readonly PluginContributionIntrospectionCandidate[];
    uiViewsV2?: readonly ResolvedUiViewV2Contribution[];
    openableContentViewers?: readonly ResolvedOpenableContentViewerContribution[];
    uiSettingsGroupsV2?: readonly ResolvedUiSettingsGroupV2Contribution[];
    uiSettingsPagesV2?: readonly ResolvedUiSettingsPageV2Contribution[];
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    uiTranslationsV2?: readonly ResolvedUiTranslationBundleV2Contribution[];
    composerReferences?: readonly ResolvedComposerReferenceContribution[];
    composerAttachments?: readonly ResolvedComposerAttachmentContribution[];
    composerControls?: readonly ResolvedComposerControlContribution[];
    composerRegions?: readonly ResolvedComposerRegionContribution[];
    agents: readonly ResolvedAgentContribution[];
    providers?: readonly ResolvedProviderContribution[];
    actions: readonly ResolvedActionContribution[];
    tools?: readonly ResolvedToolContribution[];
    commands?: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    promptAssets?: readonly ResolvedPromptAssetContribution[];
    uiTranslations?: readonly ResolvedUiTranslationsContribution[];
    structuredMessages?: readonly ResolvedStructuredMessageContribution[];
    sessionHeaderActions?: readonly ResolvedSessionHeaderActionContribution[];
    transcriptActivities?: readonly ResolvedTranscriptActivityContribution[];
    sessionInfoSections?: readonly ResolvedSessionInfoSectionContribution[];
    hostedWeb?: readonly ResolvedHostedWebContribution[];
    browserTargets?: readonly ResolvedBrowserTargetContribution[];
    browserActions?: readonly ResolvedBrowserActionContribution[];
    settings?: readonly ResolvedSettingsContribution[];
    notifications?: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels?: readonly ResolvedNotificationChannelContribution[];
    events?: readonly ResolvedEventContribution[];
    /** Current cold Event-automation composer projection; never an Event store or activation registry. */
    automationEligibleEvents?: readonly ResolvedAutomationEligibleEvent[];
    executionRunProfiles?: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers?: readonly ResolvedMcpServerContribution[];
    mcpDiscoverySources?: readonly ResolvedMcpDiscoverySourceContribution[];
    managedDependencies?: readonly ResolvedInstallableContribution[];
    systemTools?: readonly ResolvedSystemToolContribution[];
    requestInterceptors?: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
    scmBackends?: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    voiceModelPacks?: readonly ResolvedVoiceModelPackContribution[];
    voiceProviders?: readonly ResolvedVoiceProviderContribution[];
    accountCollections?: readonly ResolvedAccountCollectionContribution[];
    pluginContributionPoints?: readonly ResolvedPluginContributionPointDeclaration[];
    targetedPluginContributions?: readonly ResolvedTargetedPluginContributionDeclaration[];
    readAdmittedTargetedContributions?(request: Readonly<{
        targetPluginId: string;
        pointId: string;
        protocol: Readonly<{
            id: string;
            version: number;
        }>;
    }>): AdmittedTargetedContributionSnapshot | null;
    activationTargets: readonly ResolvedActivationTarget[];
    /** Exact current materialization IDs captured with this registry lease. */
    materializationIdsByPluginId?: Readonly<Record<string, string>>;
    immutableGenerationIdsByPluginId?: Readonly<Record<string, string>>;
    actionsById?: ReadonlyMap<string, ResolvedActionContribution>;
    toolsById?: ReadonlyMap<string, ResolvedToolContribution>;
    commandsById?: ReadonlyMap<string, ResolvedCommandContribution>;
    resourcesById?: ReadonlyMap<string, ResolvedResourceContribution>;
    promptAssetsById?: ReadonlyMap<string, ResolvedPromptAssetContribution>;
    structuredMessagesById?: ReadonlyMap<string, ResolvedStructuredMessageContribution>;
    sessionHeaderActionsById?: ReadonlyMap<string, ResolvedSessionHeaderActionContribution>;
    transcriptActivitiesById?: ReadonlyMap<string, ResolvedTranscriptActivityContribution>;
    sessionInfoSectionsById?: ReadonlyMap<string, ResolvedSessionInfoSectionContribution>;
    hostedWebById?: ReadonlyMap<string, ResolvedHostedWebContribution>;
    browserTargetsById?: ReadonlyMap<string, ResolvedBrowserTargetContribution>;
    browserActionsById?: ReadonlyMap<string, ResolvedBrowserActionContribution>;
    settingsById?: ReadonlyMap<string, ResolvedSettingsContribution>;
    notificationsById?: ReadonlyMap<string, ResolvedNotificationCategoryContribution>;
    notificationChannelsById?: ReadonlyMap<string, ResolvedNotificationChannelContribution>;
    eventsById?: ReadonlyMap<string, ResolvedEventContribution>;
    executionRunProfilesById?: ReadonlyMap<string, ResolvedExecutionRunProfileContribution>;
    managedDependenciesByKey?: ReadonlyMap<string, ResolvedInstallableContribution>;
    systemToolsById?: ReadonlyMap<string, ResolvedSystemToolContribution>;
    scmHostingProvidersById?: ReadonlyMap<string, ResolvedScmHostingProviderContribution>;
    scmBackendsById?: ReadonlyMap<string, ResolvedScmBackendContribution>;
    connectedAccountDescriptorsById?: ReadonlyMap<string, ResolvedConnectedAccountDescriptorContribution>;
    catalogEntriesById: Readonly<Record<string, ResolvedCatalogEntry>>;
    agentDefinitionsById: ReadonlyMap<string, ResolvedAgentContribution>;
    providersByContributionKey?: ReadonlyMap<string, ResolvedProviderContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

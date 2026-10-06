// Portable declarative grammar is projected by the single Action DTO producer.
import type { PluginLocalizedStringV2 as DtoPluginLocalizedStringV2, PluginDeclarativeToneV2 as DtoPluginDeclarativeToneV2, PluginDeclarativeControlV2 as DtoPluginDeclarativeControlV2, PluginDeclarativeActionNodeV2 as DtoPluginDeclarativeActionNodeV2, PluginContributionReference as DtoPluginContributionReference, PluginDeclarativeComposerApplyEffectV1 as DtoPluginDeclarativeComposerApplyEffectV1, PluginDeclarativeActionVariantV2 as DtoPluginDeclarativeActionVariantV2, PluginDeclarativeListNodeV2 as DtoPluginDeclarativeListNodeV2, PluginDeclarativeSectionNodeV2 as DtoPluginDeclarativeSectionNodeV2, PluginDeclarativeRowNodeV2 as DtoPluginDeclarativeRowNodeV2, PluginDeclarativeItemNodeV2 as DtoPluginDeclarativeItemNodeV2, PluginDeclarativeStateNodeV2 as DtoPluginDeclarativeStateNodeV2, PluginDeclarativeStateV2 as DtoPluginDeclarativeStateV2, PluginDeclarativeTargetedSurfaceNodeV2 as DtoPluginDeclarativeTargetedSurfaceNodeV2, PluginDeclarativeTargetedSurfaceReferenceV1 as DtoPluginDeclarativeTargetedSurfaceReferenceV1, PluginDeclarativeMetadataNodeV2 as DtoPluginDeclarativeMetadataNodeV2, PluginDeclarativeMetadataEntryV2 as DtoPluginDeclarativeMetadataEntryV2, PluginDeclarativeActionPanelNodeV2 as DtoPluginDeclarativeActionPanelNodeV2, PluginDeclarativeCollectionListNodeV2 as DtoPluginDeclarativeCollectionListNodeV2, PluginCollectionProjectedScalarFieldRefV1 as DtoPluginCollectionProjectedScalarFieldRefV1, PluginCollectionRowCommandV1 as DtoPluginCollectionRowCommandV1 } from './actions/dtos/actionDeclarativeNodeDto.generated.js';
import type { PluginDeclarativeNodeV2 } from './actions/dtos/pluginActionDtoSupport.generated.js';
import type { PluginDeclarativeDataNodeV1 as DtoPluginDeclarativeDataNodeV1 } from './actions/dtos/pluginActionDtoSupport.generated.js';
import { compilePluginJsonSchema as canonicalCompilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createPluginContributionIdentity as canonicalCreatePluginContributionIdentity, PluginContributionIdentityV1JsonSchema as canonicalPluginContributionIdentityV1JsonSchema, PluginContributionIdentityV1Schema as canonicalPluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ingestPluginManifestV2, validatePublicPluginManifestPolicy } from '@happier-dev/protocol/plugins/manifest/ingest';
import { isValidPluginJsonSchemaValue as canonicalIsValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginIdJsonSchema as canonicalPluginIdJsonSchema, PluginIdSchema as canonicalPluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import type {
  ComposerContentMediaKindV1,
  ComposerContentMimeTypeV1,
} from './composer.js';
import type { JsonValue, PluginJsonSchema, PluginJsonValueV2 } from './identity.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import { projectProtocolValue } from './protocol/projectProtocolValue.js';
import type {
  PluginUiAttachmentToneV1,
  PluginUiIconTokenV1,
  PluginUiViewV2Input,
} from './ui/publicContract.js';
import type { WorkflowsActionResultById } from './actions/dtos/workflowsActionDtos.generated.js';
import type { PluginDragSourceContributionV1, PluginDropTargetContributionV1 } from '@happier-dev/protocol';
export type { PluginDragSourceContributionV1, PluginDropTargetContributionV1 } from '@happier-dev/protocol';

/** Canonical workflow grammar projected by the Protocol-owned Action DTO producer. */
export type PluginWorkflowContributionV1 = Readonly<{
  id: string;
  title: string;
  description?: string;
  definition: WorkflowsActionResultById['workflow.definition.get']['definition'];
}>;

/** Typed input declarations use the incumbent Resource and UI-view families. */
export type PluginInputTypeContributionV1 = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  semantic: string;
  valueSchema: PluginJsonSchema;
  options?: Readonly<{
    resource: string | Readonly<{ pluginId: string; localId: string }>;
  }>;
  picker?: string | Readonly<{ pluginId: string; localId: string }>;
}>;

/** Observed ACP capability fingerprint used by a system-tool readiness declaration. */
export type PluginSystemToolAcpFingerprintV1 = Readonly<{
  loadSession: boolean;
  sessionCapabilities: readonly string[];
  absentSessionCapabilities: readonly string[];
  mcpHttp: boolean;
  mcpSse: boolean;
}>;

/**
 * Public readonly authoring projection of Protocol's system-tool readiness
 * contract. Protocol remains the runtime validation and ingestion owner.
 */
export type PluginSystemToolReadinessV1 = Readonly<{
  acpProbeArgs: readonly string[];
  currentFingerprint: PluginSystemToolAcpFingerprintV1;
  legacyFingerprint: PluginSystemToolAcpFingerprintV1;
  commandSurfaceArgs: readonly string[];
  legacyExecutableNames: readonly string[];
  legacyGuidance: string;
  unidentifiedGuidance: string;
}>;
/**
 * Protocol owns the Agent UI grammar and its strict parser. The SDK publishes
 * the same setting-reference structure and keeps the surrounding declaration
 * projection pinned to Protocol's `AgentUi*DeclarationV1` contracts in
 * `uiPublicContract.test.ts`, so a grammar change fails this package's
 * typecheck instead of silently diverging.
 */
export type AgentUiConditionV1 =
  | { kind: 'experimentsEnabled' }
  | { kind: 'settingEquals'; settingKey: AgentUiSettingReferenceV1; value: string; aliases?: Record<string, string> }
  | { kind: 'settingTrue'; settingKey: AgentUiSettingReferenceV1 }
  | { all: AgentUiConditionV1[] }
  | { any: AgentUiConditionV1[] };

/** Scope-qualified Agent UI setting reference; bare local IDs are not public. */
export type AgentUiSettingReferenceV1 = {
  scope: 'host' | 'account' | 'daemon';
  localId: string;
};

/** Setting mutations are limited to the declaring plugin's writable scopes. */
export type AgentUiMutablePluginSettingReferenceV1 = {
  scope: 'account' | 'daemon';
  localId: string;
};

export type AgentUiTranscriptStorageModeV1 = 'persisted' | 'direct';

/** A provider-owned External Sessions source; only `kind` is grammar-known. */
export type AgentUiExternalSessionsSourceV1 = { [key: string]: unknown; kind: string };

export type AgentUiBehaviorDeclarationV1 = {
  descriptorId?: string;
  attachedSessionTerminal?: { supported?: boolean };
  pendingDelivery?: { custodyLabelKey?: string; interruptAndRun?: boolean };
  guidance?: { includeInSessionGettingStartedCliExamples?: boolean };
  permissions?: {
    /**
     * Which permission-prompt conversation this Agent speaks. It selects the
     * footer's whole semantic action model — button set, handlers and terminal
     * decision reading — not just its wording. Absent means the neutral,
     * fail-closed rejecting action.
     */
    promptProtocol?: 'claude' | 'codexDecision';
    footer?: {
      usePermissionUpdates?: boolean;
      forceReadOnlyAfterStop?: boolean;
      supportsExecPolicyAmendment?: boolean;
      stopHandling?: 'denyOnly' | 'denyAndAbortRun';
    };
  };
  workState?: {
    editableGoals?: {
      capabilityDriven?: boolean;
      activeWhenNoPersistedMode?: boolean;
      persistedGoalSnapshot?: {
        path?: string[];
        itemKind?: string;
        providerFields?: string[];
      };
    };
  };
  resume?: {
    experimentSwitches?: {
      id: string;
      settingKey?: AgentUiSettingReferenceV1;
      when?: AgentUiConditionV1;
    }[];
  };
  sessionComposer?: {
    nonSteerableWhileBusy?: {
      reason?: 'provider_config_change_refused';
      metaKeys?: string[];
      sessionConfigOptionIds?: string[];
      freshModelOverride?: boolean;
    };
  };
  contextWindow?: {
    defaultTokens?: number;
    modelRules?: {
      idSuffix?: string;
      descriptionIncludesAny?: string[];
      tokens?: number;
    }[];
    observedUsageBumpTokens?: number[];
    trustObservedUsageBeyondKnown?: boolean;
  };
  newSession?: {
    relevantInstallableDepKeys?: string[];
    relevantInstallableDeps?: { keys?: string[]; when?: AgentUiConditionV1 }[];
    transcriptStorageModes?: AgentUiTranscriptStorageModeV1[];
    transcriptStorageModesByBackendMode?: Record<string, AgentUiTranscriptStorageModeV1[]>;
    canSelectWithoutDetectedCli?: boolean;
    agentOptions?: { key: string; kind: 'boolean'; spawnConfigOption?: boolean }[];
  };
  payload?: {
    spawnSessionExtras?: {
      kind: 'static';
      value: Record<string, string | number | boolean | null>;
    };
    /** A setting-backed session configuration option contributed on create. */
    sessionExtras?: {
      outputKey: string;
      values: string[];
      settingKey?: AgentUiSettingReferenceV1;
      aliases?: Record<string, string>;
      defaultValue?: string;
    };
    environmentVariables?: {
      backendMode: {
        envKey: string;
        settingKey: AgentUiSettingReferenceV1;
        defaultValue: string;
        values: string[];
      };
      serverBaseUrl?: {
        envKey: string;
        explicitEnvKey: string;
        settingKey: AgentUiSettingReferenceV1;
        byServerIdSettingKey: AgentUiSettingReferenceV1;
        allowedProtocols?: string[];
        rejectCredentials?: boolean;
        originOnly?: boolean;
      };
    };
  };
  askUserQuestion?: {
    dialogs: {
      dialogId: string;
      settingMutation?: {
        settingId: AgentUiMutablePluginSettingReferenceV1;
        allowedValues: string[];
      };
      terminalNotice?: {
        headerKey: string;
        questionKey: string;
      };
      terminalSecondaryAction?: {
        kind: 'openAttachedTerminal';
        labelKey: string;
        descriptionKey: string;
      };
    }[];
  };
  externalSessions?: {
    browse?: {
      order?: number;
      sourceOptions?: {
        key: string;
        labelKey: string;
        source: AgentUiExternalSessionsSourceV1;
        labelParams?: Record<string, string>;
        detail?: string;
      }[];
      connectedServiceProfileSources?: {
        serviceId: string;
        keyPrefix: string;
        labelKey: string;
        source: AgentUiExternalSessionsSourceV1;
        serviceIdField: string;
        profileIdField: string;
        labelParams?: Record<string, string>;
        detailSettingsKey?: AgentUiSettingReferenceV1;
      }[];
      lockedConnectedServiceSource?: {
        serviceId: string;
        keyPrefix: string;
        source: AgentUiExternalSessionsSourceV1;
        serviceIdField: string;
        profileIdField: string;
        groupIdField: string;
      };
      compatibleSource?: { sourceKind: string; optionalFields: string[] };
      linkEnsureRequestExtras?: {
        sourceFromCandidate?: { sourceKind: string; optionalFields: string[] };
      };
    };
    sessionHandoff?: { clearMetadataKeys?: string[] };
  };
};

export type AgentUiMessageDeclarationV1 = {
  metaOverrides?: {
    id: string;
    targetKey: string;
    value: {
      kind: 'sessionConfigOptionOverride';
      key: string;
      aliases?: string[];
    };
    normalize?: 'trimLowercase';
  }[];
};

/** Public structural projection of Protocol's data-only Agent Session UI grammar. */
export type AgentUiSessionAgentTeamBehaviorV1 = {
  kind: 'session.agentTeamBehavior.v1';
  snapshotKey: string;
  providerLabel: string;
  flavorAliases: string[];
  tools: {
    teamCreate: string[];
    teamDelete: string[];
    teamSendMessage: string[];
    subagentSpawn: string[];
    activeTeamFallbackSubagentSpawn?: string[];
    configMutation?: string[];
  };
  configTeamPath?: { rootDirectory: string; teamsDirectory: string; filename: string };
  lifecycleEvents?: { ignoreActivityPreview?: string[]; shutdownApproved?: string };
};

export type AgentUiSessionProviderBehaviorV1 = {
  kind: 'session.providerBehavior.v1';
  agentTeam?: AgentUiSessionAgentTeamBehaviorV1;
  participants?: {
    sidechainIds?: { kind: 'toolCallInputString'; toolNames: string[]; inputKey: string };
  };
  subagents?: {
    ignoreActivityPreviewText?: {
      kind: 'jsonEventType';
      recipientKinds: string[];
      eventTypes: string[];
    };
  };
};

export type AgentUiSessionVisibleMessagesV1 = {
  kind: 'session.visibleMessages.v1';
  subagentKinds: string[];
  fallbackToolNames?: string[];
  excludeJsonEventTypes: string[];
};

export type AgentUiSessionDeclarationV1 = {
  providerBehavior?: AgentUiSessionProviderBehaviorV1;
  visibleMessages?: AgentUiSessionVisibleMessagesV1;
};

/**
 * Host-owned controls and public inline surfaces an Agent places in a named
 * slot.
 *
 * A boolean-option `chip` selects the host-owned control. Session-subagent
 * slots instead name a `surfaceId` from the same plugin and carry only the
 * host-owned placement/resource metadata needed to mount that ordinary public
 * UI view. `componentId` is deliberately absent because it names code compiled
 * into the app rather than a public plugin contribution.
 */
export type AgentUiComponentsDeclarationV1 = {
  slots?: (
    | {
      id: string;
      slot: string;
      chip: {
        kind: 'booleanOption';
        optionStateKey: string;
        iconName: string;
        onLabelKey: string;
        offLabelKey: string;
      };
    }
    | {
      id: string;
      slot: 'sessionSubagents.launchCards';
      surfaceId: string;
      props?: { teamIds?: { kind: 'subagentGroupKeys'; subagentKinds?: string[] } };
    }
    | {
      id: string;
      slot: 'sessionSubagents.teammateDetailsTab';
      surfaceId: string;
      resourceKind: string;
      iconName: string;
      tab: { keyPrefix: string; titleKey: string; subtitleKey?: string };
    }
  )[];
};

/**
 * The public Agent UI authoring grammar (`contributes.agents[].ui`).
 *
 * One grammar for bundled and installed Agents alike. Rich, arbitrary UI is
 * authored through the public targeted surfaces; this block is declarative
 * facts and host-owned controls, so an author never has to name a component
 * compiled into the app to get parity.
 */
export type PluginAgentUiContribution = Readonly<{
  behavior?: AgentUiBehaviorDeclarationV1;
  message?: AgentUiMessageDeclarationV1;
  session?: AgentUiSessionDeclarationV1;
  components?: AgentUiComponentsDeclarationV1;
}>;

/** A qualified Plugin-local contribution identity. */
export type PluginContributionIdentity = Readonly<{
  pluginId: string;
  localId: string;
}>;

/** The callable JSON-schema validator contract, without the AJV owner graph. */
export type PluginJsonSchemaValidator = (value: unknown) => boolean;

/** Public prompt-asset capability facts retained by manifest declarations. */
export type PromptAssetCapabilities = Readonly<{
  supportsCatalogInstall?: boolean;
  supportsNestedNamespaces?: boolean;
  supportsSymlinkInstall?: boolean;
  [key: string]: unknown;
}>;

/** Public prompt-asset descriptor facts retained by manifest declarations. */
export type PromptAssetTypeDescriptor = Readonly<{
  id: string;
  providerId: string;
  title: string;
  description: string;
  libraryKind: 'doc' | 'bundle';
  supportsScope: Readonly<{
    user: boolean;
    project: boolean;
    [key: string]: unknown;
  }>;
  supportsFiles: boolean;
  formatId: string;
  defaultRoots: readonly Readonly<{
    label: string;
    scope: 'user' | 'project';
    pathTemplate: string;
    [key: string]: unknown;
  }>[];
  capabilities: PromptAssetCapabilities;
  [key: string]: unknown;
}>;

// Preserve canonical runtime identity while making every declaration-facing
// type local to this public SDK boundary.
export const compilePluginJsonSchema: (schema: PluginJsonSchema) => PluginJsonSchemaValidator =
  canonicalCompilePluginJsonSchema;
export const isValidPluginJsonSchemaValue: (
  validate: PluginJsonSchemaValidator,
  value: unknown,
) => boolean = canonicalIsValidPluginJsonSchemaValue;
export const createPluginContributionIdentity: (
  input: PluginContributionIdentity,
) => PluginContributionIdentity = canonicalCreatePluginContributionIdentity;
export const PluginContributionIdentityV1JsonSchema: PluginJsonSchema =
  canonicalPluginContributionIdentityV1JsonSchema;
export const PluginContributionIdentityV1Schema: ProtocolComposableSchema<PluginContributionIdentity> =
  canonicalPluginContributionIdentityV1Schema;
export const PluginIdJsonSchema: PluginJsonSchema = canonicalPluginIdJsonSchema;
export const PluginIdSchema: ProtocolComposableSchema<string> = canonicalPluginIdSchema;

// Protocol's `PluginLocalizedStringV2Schema` and `PluginContributionReferenceV2Schema`
// both project a mutable object arm. These are spelled the same way so the
// declarative grammar below stays structurally identical to Protocol's, which
// `uiPublicContract.test.ts` enforces. `readonly` property modifiers do not
// affect assignability, so no author or host call site changes meaning.
export type PluginLocalizedStringV2 = DtoPluginLocalizedStringV2;

export type PluginAvailabilityDescriptor = unknown;
export type PluginContributionReference = DtoPluginContributionReference;
export type PluginHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type PluginBrowserContributionDisplay = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  availability?: PluginAvailabilityDescriptor;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;
export type PluginBrowserTargetContributionInput = PluginBrowserContributionDisplay & Readonly<{
  url: string;
  launch?: 'newView' | 'currentView';
  profile?: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;
export type PluginBrowserTargetContribution = Omit<PluginBrowserTargetContributionInput, 'launch' | 'profile'> & Readonly<{
  launch: 'newView' | 'currentView';
  profile: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;
export type PluginBrowserActionContributionInput = PluginBrowserContributionDisplay & Readonly<{
  action: PluginContributionReference;
  target: PluginContributionReference;
  placement?: 'toolbar' | 'detailsPanel' | 'contextMenu';
  icon?: string;
  order?: number;
}>;
export type PluginBrowserActionContribution = Omit<PluginBrowserActionContributionInput, 'placement'> & Readonly<{
  placement: 'toolbar' | 'detailsPanel' | 'contextMenu';
}>;
export type PluginRequestInterceptorContribution = Readonly<{
  id: string;
  origins: readonly string[];
  methods?: readonly PluginHttpMethod[];
  priority?: number;
  availability?: PluginAvailabilityDescriptor;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;
export type PublicHostAccessCapability =
  | 'network'
  | 'network.client'
  | 'filesystem'
  | 'process'
  | 'environment'
  | 'connectedAccounts'
  | 'sessions'
  | 'terminal'
  | 'storage.account'
  | 'mcp';
/** Portable author-manifest value accepted by the canonical manifest schema. */
export interface PluginManifest {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly version: string;
  readonly displayName: PluginLocalizedStringV2;
  readonly description?: PluginLocalizedStringV2;
  readonly engines?: Readonly<{ happier?: string }>;
  readonly runtime: Readonly<{ apiVersion: 1 }>;
  readonly entrypoints?: Readonly<{ daemon?: string; development?: string }>;
  readonly brand?: Readonly<{ iconResourceId: string; monochrome?: boolean }>;
  readonly activation?: Readonly<{ events?: readonly Readonly<{ kind: 'startup' }>[] }>;
  readonly hostAccess?: Readonly<{
    required?: readonly Readonly<{
      id: string;
      reason: PluginLocalizedStringV2;
      capability: PublicHostAccessCapability;
      scope: Readonly<Record<string, unknown>>;
    }>[];
    optional?: readonly Readonly<{
      id: string;
      reason: PluginLocalizedStringV2;
      capability: 'connectedAccounts' | 'sessions' | 'storage.account' | 'mcp';
      scope: Readonly<Record<string, unknown>>;
    }>[];
  }>;
  readonly secrets?: readonly Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }>[];
  readonly contributes?: Readonly<{
    [TKey in
      | 'commands'
      | 'tools'
      | 'resources'
      | 'transcriptActivities'
      | 'sessionInfoSections'
      | 'sessionHeaderActions'
      | 'settings'
      | 'events'
      | 'executionRunProfiles'
      | 'notifications'
      | 'notificationChannels'
      | 'scmHostingProviders'
      | 'scmBackends'
      | 'connectedAccountDescriptors'
      | 'managedDependencies'
      | 'hooks'
      | 'voiceModelPacks'
      | 'voiceProviders'
      | 'backgroundServices'
      | 'composerReferences'
      | 'searchProviders'
      | 'composerControls'
      | 'composerRegions'
      | 'openableContentViewers'
      | 'accountCollections'
      | 'webhooks'
      | 'captureSources'
      | 'pluginContributionPoints'
      | 'targetedPluginContributions']?: readonly Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }>[];
  } & {
    /**
     * Agent contributions. `ui` is typed by the ONE public Agent UI grammar, so
     * a malformed declaration is refused where it is written rather than
     * silently no-opping when the client interprets it. Every other Agent field
     * stays open here; the canonical manifest schema validates them at ingest.
     */
    agents?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      ui?: PluginAgentUiContribution;
    }>)[];
    systemTools?: readonly Readonly<{
      id: string;
      title: PluginLocalizedStringV2;
      description?: PluginLocalizedStringV2;
      executableNames: string[];
      allowedArguments?: string[];
      platforms?: ('macos' | 'linux' | 'windows')[];
      readiness?: PluginSystemToolReadinessV1;
      metadata?: Record<string, PluginJsonValueV2>;
    }>[];
    providers?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      managedRuntime?: Readonly<Record<string, unknown>>;
    }>)[];
    actions?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      inputSchema?: PluginJsonSchema | null;
      resultSchema?: PluginJsonSchema | null;
      surfaces: readonly string[];
    }>)[];
    /** Read-only definitions available through the host's workflow library. */
    workflows?: readonly PluginWorkflowContributionV1[];
    inputTypes?: readonly PluginInputTypeContributionV1[];
    dragSources?: readonly PluginDragSourceContributionV1[];
    dropTargets?: readonly PluginDropTargetContributionV1[];
    /** Read-only role sources, overridable through the host's Roles settings. */
    roles?: readonly Readonly<{
      id: string;
      name: string;
      instructions: string;
      engine?: Readonly<{ agentTargetKey: string; modelId?: string; effort?: string }>;
      runsAs: Readonly<{ kind: 'session' }> | Readonly<{
        kind: 'background_run';
        intent: 'review' | 'plan' | 'delegate' | 'agent' | 'task' | 'voice_agent' | 'memory_hints' | 'scm_commit_message' | 'scm_diff_summary';
      }>;
      profileId?: string;
      workspaceWrites: 'allow' | 'deny';
      secondOpinion: 'off' | 'encouraged';
      enabled: boolean;
    }>[];
    promptAssets?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      kind: 'systemPrompt' | 'context' | 'guidelines';
      resource: string | Readonly<{ pluginId: string; localId: string }>;
      target: Readonly<{
        kind: 'agent';
        agent: string | Readonly<{ pluginId: string; localId: string }>;
      }>;
      priority?: number;
      adapterDescriptor?: Readonly<{
        id: string;
        providerId: string;
        title: string;
        description: string;
        libraryKind: 'doc' | 'bundle';
        supportsScope: Readonly<{
          user: boolean;
          project: boolean;
          [key: string]: unknown;
        }>;
        supportsFiles: boolean;
        formatId: string;
        defaultRoots: readonly Readonly<{
          label: string;
          scope: 'user' | 'project';
          pathTemplate: string;
          [key: string]: unknown;
        }>[];
        capabilities: Readonly<{
          supportsCatalogInstall?: boolean;
          supportsNestedNamespaces?: boolean;
          supportsSymlinkInstall?: boolean;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      }>;
      availability?: unknown;
      metadata?: Readonly<Record<string, JsonValue>>;
    }>)[];
    daemonDatabases?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      migrations: readonly Readonly<{ version: number; id: string }>[];
      incumbentQueryFixtureId: string;
    }>)[];
    composerAttachments?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      valueSchema?: object;
      preparedValueSchema?: object;
      runtime?: Readonly<Record<string, boolean | undefined>>;
    }>)[];
    mcp?: Readonly<{
      servers?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
      discoverySources?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
    }>;
    ui?: Readonly<{
      views?: readonly PluginUiViewV2Input[];
      // Raw renderer declarations remain an advanced manifest route until the
      // complete renderer union has one published author owner. Supported SDK
      // declarative authoring flows through the closed `PluginDeclarativeNodeV2`
      // projection used by the surface helper, not this opaque family.
      renderers?: readonly (Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }> & Readonly<{
        kind: string;
        artifact?: string;
        source?: unknown;
      }>)[];
      settingsGroups?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
      settingsPages?: readonly (Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }> & Readonly<{ renderer: string }>)[];
      translations?: readonly Readonly<{
        locale: string;
        messages: Readonly<Record<string, string>>;
      }>[];
    }>;
    requestInterceptors?: readonly PluginRequestInterceptorContribution[];
    browserTargets?: readonly PluginBrowserTargetContributionInput[];
    browserActions?: readonly PluginBrowserActionContributionInput[];
  }>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** Canonical readonly contribution collection returned by public structural parsing. */
export type PluginContributes = Readonly<{
  agents: NonNullable<NonNullable<PluginManifest['contributes']>['agents']>;
  providers: NonNullable<NonNullable<PluginManifest['contributes']>['providers']>;
  actions: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    inputSchema?: PluginJsonSchema;
    resultSchema?: PluginJsonSchema;
    surfaces: readonly string[];
    dangerLevel: string;
  }>)[];
  commands: NonNullable<NonNullable<PluginManifest['contributes']>['commands']>;
  tools: NonNullable<NonNullable<PluginManifest['contributes']>['tools']>;
  resources: NonNullable<NonNullable<PluginManifest['contributes']>['resources']>;
  transcriptActivities: NonNullable<NonNullable<PluginManifest['contributes']>['transcriptActivities']>;
  sessionInfoSections: NonNullable<NonNullable<PluginManifest['contributes']>['sessionInfoSections']>;
  sessionHeaderActions: NonNullable<NonNullable<PluginManifest['contributes']>['sessionHeaderActions']>;
  settings: NonNullable<NonNullable<PluginManifest['contributes']>['settings']>;
  events: NonNullable<NonNullable<PluginManifest['contributes']>['events']>;
  executionRunProfiles: NonNullable<NonNullable<PluginManifest['contributes']>['executionRunProfiles']>;
  roles: NonNullable<NonNullable<PluginManifest['contributes']>['roles']>;
  workflows: NonNullable<NonNullable<PluginManifest['contributes']>['workflows']>;
  inputTypes: NonNullable<NonNullable<PluginManifest['contributes']>['inputTypes']>;
  dragSources: NonNullable<NonNullable<PluginManifest['contributes']>['dragSources']>;
  dropTargets: NonNullable<NonNullable<PluginManifest['contributes']>['dropTargets']>;
  notifications: NonNullable<NonNullable<PluginManifest['contributes']>['notifications']>;
  notificationChannels: NonNullable<NonNullable<PluginManifest['contributes']>['notificationChannels']>;
  scmHostingProviders: NonNullable<NonNullable<PluginManifest['contributes']>['scmHostingProviders']>;
  scmBackends: NonNullable<NonNullable<PluginManifest['contributes']>['scmBackends']>;
  connectedAccountDescriptors: NonNullable<NonNullable<PluginManifest['contributes']>['connectedAccountDescriptors']>;
  managedDependencies: NonNullable<NonNullable<PluginManifest['contributes']>['managedDependencies']>;
  systemTools: NonNullable<NonNullable<PluginManifest['contributes']>['systemTools']>;
  promptAssets: NonNullable<NonNullable<PluginManifest['contributes']>['promptAssets']>;
  hooks: NonNullable<NonNullable<PluginManifest['contributes']>['hooks']>;
  voiceModelPacks: NonNullable<NonNullable<PluginManifest['contributes']>['voiceModelPacks']>;
  voiceProviders: NonNullable<NonNullable<PluginManifest['contributes']>['voiceProviders']>;
  backgroundServices: NonNullable<NonNullable<PluginManifest['contributes']>['backgroundServices']>;
  daemonDatabases: NonNullable<NonNullable<PluginManifest['contributes']>['daemonDatabases']>;
  composerReferences: NonNullable<NonNullable<PluginManifest['contributes']>['composerReferences']>;
  searchProviders: NonNullable<NonNullable<PluginManifest['contributes']>['searchProviders']>;
  composerAttachments: NonNullable<NonNullable<PluginManifest['contributes']>['composerAttachments']>;
  composerControls: NonNullable<NonNullable<PluginManifest['contributes']>['composerControls']>;
  composerRegions: NonNullable<NonNullable<PluginManifest['contributes']>['composerRegions']>;
  openableContentViewers: NonNullable<NonNullable<PluginManifest['contributes']>['openableContentViewers']>;
  accountCollections: NonNullable<NonNullable<PluginManifest['contributes']>['accountCollections']>;
  webhooks: NonNullable<NonNullable<PluginManifest['contributes']>['webhooks']>;
  requestInterceptors: readonly PluginRequestInterceptorContribution[];
  browserTargets: readonly PluginBrowserTargetContribution[];
  browserActions: readonly PluginBrowserActionContribution[];
  pluginContributionPoints: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    maxContributionsPerContributor?: number;
    protocols: readonly Readonly<{
      id: string;
      version: number;
      operations: Readonly<Record<string, Readonly<{ required: boolean }>>>;
    }>[];
  }>)[];
  targetedPluginContributions: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    target: Readonly<{
      pluginId: string;
      pointId: string;
    }>;
    protocol: Readonly<{
      id: string;
      version: number;
    }>;
    descriptor?: unknown;
    operations: Readonly<Record<string, string>>;
    surfaces?: unknown;
  }>)[];
  mcp: Required<NonNullable<NonNullable<PluginManifest['contributes']>['mcp']>>;
  ui: Required<NonNullable<NonNullable<PluginManifest['contributes']>['ui']>>;
}>;

/** Canonical portable manifest projected through declaration-safe SDK types. */
export interface ParsedPluginManifest extends Omit<
  PluginManifest,
  'activation' | 'hostAccess' | 'secrets' | 'contributes'
> {
  readonly activation?: Readonly<{
    events: NonNullable<NonNullable<PluginManifest['activation']>['events']>;
  }>;
  readonly hostAccess: Readonly<{
    required: NonNullable<NonNullable<PluginManifest['hostAccess']>['required']>;
    optional: NonNullable<NonNullable<PluginManifest['hostAccess']>['optional']>;
  }>;
  readonly secrets: NonNullable<PluginManifest['secrets']>;
  readonly contributes: PluginContributes;
}

/**
 * The daemon-independent testkit accepts a cold author declaration, a parsed
 * manifest, or a parsed fixture narrowed to just the contribution families a
 * test exercises. It always reparses through the canonical manifest owner.
 */
export type PluginTestkitManifest =
  | PluginManifest
  | ParsedPluginManifest
  | (Omit<ParsedPluginManifest, 'contributes'> & Readonly<{
    contributes: Partial<PluginContributes>;
  }>);

/** Structured portable-validation diagnostic suitable for author tooling. */
export type PluginManifestDiagnostic = Readonly<{
  code:
    | 'plugin_manifest_invalid_json'
    | 'plugin_manifest_invalid'
    | 'plugin_manifest_duplicate_contribution_id'
    | 'plugin_manifest_invalid_contribution_id'
    | 'plugin_manifest_dangling_reference'
    | 'plugin_manifest_wrong_family_reference'
    | 'plugin_manifest_missing_agent_setting_reference'
    | 'plugin_manifest_wrong_scope_agent_setting_reference';
  path?: readonly (string | number)[];
  message: string;
}>;
/** Portable structural parse result; host compatibility and installation checks are separate. */
export type PluginManifestParseResult =
  | Readonly<{ ok: true; manifest: ParsedPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestDiagnostic[] }>;

/**
 * Parses the canonical cold manifest without consulting host version,
 * installation, trust, or currentness state.
 */
export function parsePluginManifest(input: unknown): PluginManifestParseResult {
  const parsed = ingestPluginManifestV2(input);
  if (!parsed.ok) return parsed;
  const diagnostics = validatePublicPluginManifestPolicy(parsed.manifest);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  // The Protocol parser retains the broad internal HostAccess union. The
  // policy check above proves no deferred public capability remains, which is
  // the invariant represented by the SDK's narrower declaration projection.
  const publicManifest = projectProtocolValue<ParsedPluginManifest>(parsed.manifest);
  return {
    ok: true,
    manifest: publicManifest,
  };
}

/**
 * Protocol owns the declarative parser and its one closed node grammar. The
 * SDK declares a structurally exact projection of that grammar here instead of
 * aliasing Protocol's type.
 *
 * An alias resolves to the aliased symbol, so TypeScript names it at its
 * original declaration site when it emits a downstream author's `.d.ts`.
 * Protocol reaches an external author only as a `bundledDependencies` copy
 * nested under this package and its `exports` map publishes no `./dist/*`
 * wildcard, so that declaration site is unreachable from the author's own
 * package: their build stops with `TS2883 … cannot be named without a
 * reference to` the SDK's own nested Protocol copy, and the affected
 * declarations are never emitted at all.
 *
 * This is a projection, not a second vocabulary. `uiPublicContract.test.ts`
 * pins it to Protocol's `PluginDeclarativeNodeV2` with `toEqualTypeOf` under
 * `typecheck:tests`, member by member and as a whole union, so a Protocol
 * grammar change fails this package's build instead of silently diverging.
 * Every leaf below is likewise an SDK-local declaration: naming a Protocol leaf
 * (its `PluginJsonValueV2`, its icon tokens) reintroduces the same break one
 * level down.
 */
export type PluginDeclarativeActionVariantV2 = DtoPluginDeclarativeActionVariantV2;
export type PluginDeclarativeStateV2 = DtoPluginDeclarativeStateV2;
export type PluginDeclarativeMetadataEntryV2 = DtoPluginDeclarativeMetadataEntryV2;
export type PluginCollectionProjectedScalarFieldRefV1 = DtoPluginCollectionProjectedScalarFieldRefV1;
export type PluginCollectionRowCommandV1 = DtoPluginCollectionRowCommandV1;

export type PluginDeclarativeToneV2 = DtoPluginDeclarativeToneV2;

/**
 * Protocol's declarative schema admits ordinary mutable JSON. The public Host
 * API projects Composer operations deeply readonly, so this is the exact
 * structural grammar rather than a named mutable helper that would leak into
 * an author's declaration.
 */
export type PluginDeclarativeComposerApplyEffectV1 = DtoPluginDeclarativeComposerApplyEffectV1;

export type PluginDeclarativeControlV2 = DtoPluginDeclarativeControlV2;

export type PluginDeclarativeActionNodeV2 = DtoPluginDeclarativeActionNodeV2;

export type PluginDeclarativeItemNodeV2 = DtoPluginDeclarativeItemNodeV2;

export type PluginDeclarativeStateNodeV2 = DtoPluginDeclarativeStateNodeV2;

export type PluginDeclarativeRowNodeV2 = DtoPluginDeclarativeRowNodeV2;

export type PluginDeclarativeSectionNodeV2 = DtoPluginDeclarativeSectionNodeV2;

export type PluginDeclarativeListNodeV2 = DtoPluginDeclarativeListNodeV2;

export type PluginDeclarativeActionPanelNodeV2 = DtoPluginDeclarativeActionPanelNodeV2;

export type PluginDeclarativeMetadataNodeV2 = DtoPluginDeclarativeMetadataNodeV2;

export type PluginDeclarativeTargetedSurfaceReferenceV1 = DtoPluginDeclarativeTargetedSurfaceReferenceV1;

export type PluginDeclarativeTargetedSurfaceNodeV2 = DtoPluginDeclarativeTargetedSurfaceNodeV2;

export type PluginDeclarativeCollectionListNodeV2 = DtoPluginDeclarativeCollectionListNodeV2;

export type PluginDeclarativeDataNodeV1 = DtoPluginDeclarativeDataNodeV1;

// Preserve the canonical union's symbol so inferred author declarations can name the public export.
export type { PluginDeclarativeNodeV2 } from './actions/dtos/pluginActionDtoSupport.generated.js';

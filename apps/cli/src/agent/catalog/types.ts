import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type {
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  ConnectedAccountRequestAuthUseV1,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
  ExternalSessionsAgentId,
  PluginAgentToolsDeliveryV2,
} from '@happier-dev/protocol';
import type { AnyTerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';
import type { CommandDispatchPolicy } from '@/agent/runtime/registry/commandContracts';
import type { SessionCatalogControlAdapter } from '@/session/catalogControls/sessionCatalogControlTypes';
import type { SessionGoalControlAdapter } from '@/session/goalControls/sessionGoalControlTypes';
import type {
  SessionUsageLimitRecoveryBackoffPolicy,
  SessionUsageLimitRecoveryControlAdapter,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import type { Metadata } from '@/api/types';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import type { RuntimeActivityApplicability } from '@/agent/runtime/session/activity/runtimeActivityApplicability';

export type {
  CatalogAgentId,
  CatalogAgentLookupId,
  VendorResumeSupportLevel,
} from '@/agent/catalog/ids';
import type { CatalogAgentId, CatalogAgentLookupId, VendorResumeSupportLevel } from '@/agent/catalog/ids';
import type {
  AgentCliSessionCommandBuildInputV1,
  AgentConnectedAccountStateSharingDescriptorEntryV1,
  AgentConnectedAccountStateSharingDescriptorTransformV1,
  AgentConnectedAccountStateSharingDescriptorV1,
  AgentConnectedAccountStateSharingDynamicEntryPatternV1,
  AgentDeferredStartupEligibilityInputV1,
  AgentExperimentalVendorResumeSupportInputV1,
  AgentRuntimeSurfaces,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  PreflightSessionControlsProbeAdapter,
  PreflightSessionControlsProbeKind,
} from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import type {
  ConnectedServiceMaterializedHomeFreshness,
  ConnectedServiceMaterializedHomeRootResolver,
} from '@/daemon/connectedServices/materialization/materializedHomeFreshness';
import type { ConnectedServiceRefreshCoordinator } from '@/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/daemon/connectedServices/verifyResumeReachableTypes';
import type {
  ConnectedServiceDaemonAuthBridgeRefreshRequest,
  ConnectedServiceDaemonAuthBridgeRefreshResult,
} from '@/daemon/connectedServices/daemonAuthBridgeTypes';
import type {
  CliAuthMethod,
  CliAuthReason,
  CliAuthSource,
  CliAuthSpec,
  CliAuthState,
  CliAuthStatus,
  CliAuthStatusDraft,
} from '@/capabilities/cliAuth/types';
export type {
  CliAuthMethod,
  CliAuthReason,
  CliAuthSource,
  CliAuthSpec,
  CliAuthState,
  CliAuthStatus,
  CliAuthStatusDraft,
};
export type { ConnectedServicesMaterializer };
export type { ConnectedServiceMaterializedHomeFreshness };
export type { ConnectedServiceProviderRuntimeAuthAdapter };
export type { SessionUsageLimitRecoveryControlAdapter };

export type VendorResumeSupportParams = AgentExperimentalVendorResumeSupportInputV1;

export type VendorResumeSupportFn = (params: VendorResumeSupportParams) => boolean;

export type ProviderSessionRuntimePreferences = Readonly<Record<string, unknown>>;

export type ProviderSessionRuntimePreferencesResolver = (
  params: AgentCliSessionCommandBuildInputV1,
) => ProviderSessionRuntimePreferences | Promise<ProviderSessionRuntimePreferences>;

export type SessionHandoffAgentBundleRecordExtractor = (
  agentBundle: Readonly<Record<string, unknown>>,
) => readonly unknown[];

export type ProviderRuntimeLocalHandoffMetadataBuilder = (params: Readonly<{
  machineId: string | null;
  workingDirectory: string | null;
  transcriptStorage: string | null;
  environmentVariables: Readonly<Record<string, string | undefined>> | null;
  vendorResumeId: string;
}>) => Partial<Pick<Metadata, 'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'externalSessionV1'>>;

export type ConnectedServiceStateSharingDescriptorEntry =
  AgentConnectedAccountStateSharingDescriptorEntryV1;

export type ConnectedServiceStateSharingDescriptorTransform =
  AgentConnectedAccountStateSharingDescriptorTransformV1;

export type ConnectedServiceStateSharingDynamicEntryPattern =
  AgentConnectedAccountStateSharingDynamicEntryPatternV1;

/**
 * The SDK owns the static descriptor grammar. Catalog projection adds only
 * the host routing identity required by the existing state-sharing owner.
 */
export type ConnectedServiceStateSharingDescriptor =
  Readonly<{ providerId: CatalogAgentId }>
  & AgentConnectedAccountStateSharingDescriptorV1;

export type ConnectedServicePredictiveSoftSwitchLiveSessionRequirement =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'shared_group_auth_surface';
      serviceIds: ReadonlyArray<ConnectedServiceId>;
      authEnvKey: string;
      authEnvSubpath?: ReadonlyArray<string>;
    }>;

export type ConnectedServiceRuntimeAuthApplyCapability = Readonly<{
  directLiveHotAuth:
    | 'unsupported'
    | Readonly<{
        supportsInTurnApply: boolean;
        requiresExactRuntimeIdentity: boolean;
        refreshSelectionResync: 'required' | 'not_applicable';
        authMode:
          | Readonly<{ kind: 'external_token_injection'; surface: string }>
          | Readonly<{ kind: 'managed_provider_session' }>
          | Readonly<{ kind: 'api_key' }>
          | Readonly<{ kind: 'provider_owned'; name: string }>;
      }>;
}>;

export type LegacyConnectedServiceRuntimeAuthFailureSourceInput = Readonly<{
  reportedCredentialRevision: string | null;
  reportedProviderAccountId: string | null;
  failingAccessTokenFingerprint: string | null;
  liveIdentity: Readonly<{
    providerAccountId: string | null;
    credentialRevision: string | null;
  }>;
  currentCredential: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    credentialRevision: string;
  }>;
}>;

/**
 * Provider-owned compatibility check for failure reports emitted by supported
 * predecessor runners before the exact credential revision was carried end to end.
 * Current reports never use this hook.
 */
export type LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver = (
  input: LegacyConnectedServiceRuntimeAuthFailureSourceInput,
) => string | null;

export type ConnectedServiceRecoveryCapabilities = Readonly<{
  predictiveSoftSwitch: Readonly<{
    mode: 'supported' | 'unsupported';
    liveSessionRequirement?: ConnectedServicePredictiveSoftSwitchLiveSessionRequirement;
  }>;
  sameAccountFanoutStrategy?: 'provider_account_id' | 'shared_group_auth_surface' | 'none';
  generationApplicationScope?:
    | 'per_session_runtime'
    | 'shared_group_auth_surface'
    | 'request_time_auth'
    | 'unsupported';
  sharedGenerationApplicationServiceIds?: ReadonlyArray<ConnectedServiceId>;
  runtimeAuthApply?: ConnectedServiceRuntimeAuthApplyCapability;
}>;

export type ConnectedServiceSwitchContinuityMode =
  | 'hot_apply'
  | 'restart_same_home'
  | 'restart_shared_state_required'
  | 'unsupported';

export type ConnectedServiceSwitchContinuityResult = Readonly<{
  mode: ConnectedServiceSwitchContinuityMode;
  reason?: string;
  diagnostics?: ConnectedServiceResumeContinuityDiagnostics;
}>;

export type ConnectedServiceResumeContinuityDiagnostics = Readonly<{
  materializationIdentityId: string | null;
  targetMaterializedRoot: string | null;
  vendorResumeId: string | null;
  cwd: string | null;
  candidatePersistedSessionFile: string | null;
  requestedStateMode: 'shared' | 'isolated';
  effectiveStateMode: 'shared' | 'isolated';
  reachabilityMissReason: string;
}>;

export type ConnectedServiceSwitchEffectiveBinding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>;

export type ConnectedServiceSwitchContinuityParams = Readonly<{
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previousBinding: ConnectedServiceSwitchEffectiveBinding | null;
  nextBinding: ConnectedServiceSwitchEffectiveBinding;
  fromBindings: ConnectedServiceBindingsV1;
  toBindings: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
  runtimeAuthSelection?: unknown;
}>;

export type ConnectedServicePersistedSessionMetadata = Readonly<Partial<{
  piSessionFile: string;
  codexBackendMode: string;
  codexSessionId: string;
}>>;

export type ConnectedServicePersistedSessionCandidateParams = Readonly<{
  metadata: ConnectedServicePersistedSessionMetadata;
}>;

export type ConnectedServiceDaemonAuthBridgeRefresh = (input: Readonly<{
  serviceId: ConnectedServiceId;
  request: ConnectedServiceDaemonAuthBridgeRefreshRequest;
  refreshCoordinator: ConnectedServiceRefreshCoordinator;
}>) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> | ConnectedServiceDaemonAuthBridgeRefreshResult;

export type CliDetectSpec = Readonly<{
  /**
   * Candidate argv lists to try for `--version` probing.
   * The first matching semver is returned (best-effort).
   */
  versionArgsToTry?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Optional argv for best-effort "am I logged in?" probing.
   * When omitted/undefined, the snapshot returns null (unknown/unsupported).
   */
  loginStatusArgs?: ReadonlyArray<string> | null;
}>;

export type ProviderDeferredSessionStartupParams = AgentDeferredStartupEligibilityInputV1;

export type AgentCatalogEntry = Readonly<{
  id: CatalogAgentLookupId;
  /** Agent-declared channel for receiving contributed Happier tools. */
  toolDelivery?: PluginAgentToolsDeliveryV2;
  /** Provider-owned authoritative Runtime Activity characterization. */
  runtimeActivityApplicability?: RuntimeActivityApplicability;
  /** Host-private binding from this Agent CLI to one same-plugin declared system tool. */
  agentCliSystemTool?: Readonly<{ toolId: string }>;
  connectedServiceIds?: readonly ConnectedServiceId[];
  connectedAccountRequestAuthUses?: readonly ConnectedAccountRequestAuthUseV1[];
  cliSubcommand: CatalogAgentLookupId;
  /**
   * Optional CLI subcommand handler for this agent.
   */
  getCliCommandHandler?: () => Promise<CommandHandler>;
  /**
   * Optional CLI command dispatch policy for this agent's direct subcommand.
   */
  cliCommandPolicy?: CommandDispatchPolicy;
  /**
   * Optional root-help metadata for projected provider commands.
   */
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux?: boolean;
  getCliCapabilityOverride?: () => Promise<Capability>;
  getCliDetect?: () => Promise<CliDetectSpec>;
  getCliAuthSpec?: () => Promise<CliAuthSpec>;
  /**
   * Host projection of the public Agent CLI Session-options composer for
   * direct CLI starts. The shared Session command supplies only its resolved,
   * bounded input; it remains the owner of parsing and process launch.
   */
  resolveSessionRuntimePreferences?: ProviderSessionRuntimePreferencesResolver;
  /**
   * Provider-owned eligibility for the host's canonical deferred session bootstrap.
   *
   * The provider leaf decides only whether its released local-start behavior applies.
   * The host retains API/session initialization, buffering, attachment, and cleanup.
   */
  shouldUseDeferredSessionStartup?: (params: ProviderDeferredSessionStartupParams) => boolean;
  /**
   * Optional daemon spawn hooks for this agent.
   *
   * These are evaluated by the daemon before spawning a child process.
   */
  getDaemonSpawnHooks?: () => Promise<DaemonSpawnHooks>;
  /**
   * Optional provider-owned connected-services materializer used before spawning the backend.
   *
   * This keeps provider-specific auth file/env shaping out of the daemon core.
   */
  getConnectedServicesMaterializer?: () => Promise<ConnectedServicesMaterializer | null>;
  /**
   * Optional provider-owned freshness check for already-materialized auth homes.
   *
   * The daemon owns refresh/rematerialization orchestration; provider leaves own
   * native credential parsing and token/account fingerprint semantics.
   */
  getConnectedServiceMaterializedHomeFreshness?: () => Promise<ConnectedServiceMaterializedHomeFreshness | null>;
  /**
   * Optional provider-owned hygiene hook applied to a retained materialized-home root during
   * connected-service cleanup (e.g. stripping long-lived refresh tokens from a retained credential
   * file). Owned by the provider plugin so the generic cleanup scheduler stays provider-agnostic.
   */
  sanitizeRetainedConnectedServiceMaterializedHome?: (homeRootDir: string) => Promise<void> | void;
  /**
   * Service ids whose refreshed credentials are applied without restarting this agent.
   * Account switches still use the connected-service switch coordinator.
   */
  connectedServiceNoRestartRequiredServiceIds?: readonly ConnectedServiceId[];
  shouldRestartConnectedServiceOnCredentialUpdate?: (serviceId: ConnectedServiceId) => boolean;
  /**
   * Optional daemon-owned retained-home root resolver projected from provider connected-services
   * metadata. Refresh/freshness orchestration uses this so it checks the same home root that
   * materialization writes.
   */
  resolveConnectedServiceMaterializedHomeRoot?: ConnectedServiceMaterializedHomeRootResolver;
  /**
   * Optional provider-owned runtime-auth adapter for connected-service account groups.
   *
   * Provider-specific classification, quota probing, refresh, and hot-apply logic
   * lives in provider-owned leaves while daemon orchestration stays provider-agnostic.
   */
  getConnectedServiceRuntimeAuthAdapter?: () => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
  /**
   * Optional provider-owned daemon auth bridge binder.
   *
   * The daemon owns credential storage and refresh orchestration; executable-agent
   * leaves own service-specific request projection and response semantics.
   */
  getConnectedServiceDaemonAuthBridgeRefresh?: (
    serviceId: ConnectedServiceId,
  ) => Promise<ConnectedServiceDaemonAuthBridgeRefresh | null>;
  /**
   * Optional provider-owned quota fetcher descriptor.
   *
   * Quota probing is daemon-owned orchestration; service-specific HTTP/API
   * semantics stay in the plugin/provider leaf and are discovered through this
   * catalog hook instead of static daemon imports.
   */
  getConnectedServiceQuotaFetcherDescriptor?: () => Promise<ConnectedServiceQuotaFetcherDescriptor | null>;
  /**
   * Optional provider-owned connected-service state/config sharing descriptor.
   */
  getConnectedServiceStateSharingDescriptor?: () => Promise<ConnectedServiceStateSharingDescriptor | null>;
  /**
   * Optional provider-owned recovery capability descriptor (P7/F13 minimum surface).
   *
   * Declares whether predictive (soft-threshold) account switches are safe for this provider.
   * Restart-only providers must declare `predictiveSoftSwitch: { mode: 'unsupported' }` so daemon
   * recovery policy suppresses predictive switches via a declared contract instead of inferring
   * support from runtime-auth adapter shape. Providers without a descriptor keep the legacy
   * adapter inference.
   */
  getConnectedServiceRecoveryCapabilities?: () => Promise<ConnectedServiceRecoveryCapabilities | null>;
  /**
   * Optional provider-owned predecessor-wire compatibility verifier.
   *
   * The daemon owns current runtime tuple authorization. Provider leaves own any
   * credential-specific evidence needed to authorize a supported legacy report.
   */
  resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision?:
    LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver;
  /**
   * Optional provider-owned continuity resolver for existing-session auth switches.
   */
  resolveConnectedServiceSwitchContinuity?: (
    params: ConnectedServiceSwitchContinuityParams,
  ) => Promise<ConnectedServiceSwitchContinuityResult>;
  /**
   * Optional provider-owned resume-reachability probe (K4).
   *
   * Resolved through the catalog so the "is the vendor session for `vendorResumeId` reachable from a
   * source the switch will import / the target the vendor reads" decision stays in
   * the provider-owned leaf instead of a central `switch(agentId)`.
   *
   * The signature is normalized across providers (single `VerifyResumeReachableInput`). Providers
   * whose underlying probe takes a different shape (e.g. Claude's `{ vendorResumeId, processEnv }`)
   * adapt to this normalized input inside their backend folder without changing behavior.
   */
  verifyResumeReachable?: (
    input: VerifyResumeReachableInput,
  ) => Promise<VerifyResumeReachableResult>;
  /**
   * Optional provider-owned persisted session-file resolver for connected-service resume continuity.
   *
   * Shared daemon code asks this catalog hook for a provider-specific file hint instead of branching on
   * metadata fields such as PI's `piSessionFile` or Codex app-server rollout paths.
   */
  resolveConnectedServiceCandidatePersistedSessionFile?: (
    input: ConnectedServicePersistedSessionCandidateParams,
  ) => string | null;
  /**
   * Optional host-bound surfaces layered onto a built-in Agent runtime lease.
   *
   * This is a construction input to the single `AgentRuntime.surfaces` owner,
   * not a parallel catalog execution-surface projection. It exists for leaves
   * such as attach that require host-owned executable resolution.
   */
  resolveHostAgentRuntimeSurfaces?: () => Promise<AgentRuntimeSurfaces>;
  /**
   * Optional provider-owned terminal-runtime adapter surface.
   *
   * This keeps terminal-hosted runtime discovery/binding logic in backend-owned modules
   * instead of branching in shared catalog consumers.
   *
   * @deprecated Transitional built-in catalog bridge. Native Agents expose
   * terminal launch behavior through `AgentRuntime.surfaces.terminal`.
   */
  /**
   * Host-private durable inactive-recovery policy. Provider-native runtime
   * facets supply readiness evidence; the host owns intent and persistence.
   */
  sessionUsageLimitRecoveryBackoffPolicy?: SessionUsageLimitRecoveryBackoffPolicy;
  /**
   * Whether this agent supports vendor-level resume (NOT Happy session resume).
   *
   * Used by the daemon to decide whether it may pass `--resume <providerSessionId>`.
   */
  vendorResumeSupport: VendorResumeSupportLevel;
  /**
   * Optional predicate used when vendor resume support is experimental.
   *
   * This intentionally stays catalog-driven and lazy-imported.
   */
  getVendorResumeSupport?: () => Promise<VendorResumeSupportFn>;
  /**
   * Optional provider-owned terminal prompt submit verification policy.
   *
   * Generic terminal hosts own the submit orchestration; providers own TUI-specific screen
   * evidence such as collapsed composer markers.
   */
  getTerminalPromptSubmitVerificationPolicy?: () => Promise<TerminalPromptSubmitVerificationPolicy>;
  /**
   * Optional provider-owned handoff provider-bundle record extractor.
   *
   * Shared media continuity code applies provider-agnostic path validation after this hook
   * extracts provider-specific transcript/export records.
   */
  getSessionHandoffAgentBundleRecordExtractor?: () => Promise<SessionHandoffAgentBundleRecordExtractor | null>;
  /**
   * Optional provider-owned runtime-local metadata builder for session handoff.
   *
   * Shared daemon handoff code owns export/runtime-local splitting; providers own
   * provider-specific resume ids and external-session source metadata.
   */
  buildRuntimeLocalHandoffMetadata?: ProviderRuntimeLocalHandoffMetadataBuilder;
  /**
   * Optional Agent-owned derivation of this Agent's own session log for a vendor
   * resume id.
   *
   * The handoff brief may point the incoming Agent at the log the departing one
   * kept. An Agent that PERSISTS that path declares
   * `vendorResumeContinuityProofField` and the host reads it out of metadata
   * agent-agnostically; this hook is for an Agent that persists nothing and can
   * only DERIVE the path — Codex names its rollout file after the thread id under
   * a date-partitioned sessions root. The host resolves the vendor resume id and
   * verifies the returned path against the filesystem; the Agent owns only the
   * "where would that id's log be" step.
   */
  resolveAgentNativeSessionLogPath?: (
    input: Readonly<{ vendorResumeId: string }>,
  ) => Promise<string | null> | string | null;
  /**
   * Whether probe RPC handlers should load account settings before invoking probe methods.
   *
   * This is used for providers whose probe behavior depends on account settings even when the
   * caller is not using a configured ACP backend target.
   *
   * Keep this provider-owned by setting it in the backend catalog entry instead of branching
   * on provider ids in shared handlers.
   */
  needsAccountSettingsForProbes?: boolean;
  /**
   * Optional cache-variant shaper for the dynamic models probe.
   *
   * Use this when the provider has multiple distinct runtime flavors (e.g. Codex app-server vs ACP).
   */
  resolveModelsProbeVariant?: (params: Readonly<{
    backendTarget?: BackendTargetRefV1;
    probeKind?: PreflightSessionControlsProbeKind;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }>) => string | null;
  /**
   * Optional cache-variant shaper for dynamic session-control probes.
   *
   * Providers with multiple runtime flavors should use this generic hook so models,
   * modes, and config-option probes can partition caches without host provider-id
   * branches.
   */
  resolveSessionControlsProbeVariant?: (params: Readonly<{
    backendTarget?: BackendTargetRefV1;
    probeKind: PreflightSessionControlsProbeKind;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }>) => string | null;
  /**
   * Optional provider-owned backend options for catalog ACP model probes.
   *
   * Use this when starting the probe backend itself depends on account settings or environment
   * policy. Keep provider-specific option shaping in the provider catalog entry.
   */
  resolveModelsProbeBackendOptions?: (params: Readonly<{
    backendTarget?: BackendTargetRefV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }>) => Readonly<Record<string, unknown>> | null;
  /**
   * Optional provider-owned adapter for probing dynamic session controls (models/modes/config options)
   * without starting a full ACP session.
   *
   * Keep provider-specific implementations in the backend folder and expose them via this catalog hook.
   */
  getPreflightSessionControlsProbeAdapter?: () => Promise<PreflightSessionControlsProbeAdapter | null>;
}>;

export type {
  ExternalSessionsAgentId,
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
};
export type { AnyTerminalRuntimeOps, TerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';

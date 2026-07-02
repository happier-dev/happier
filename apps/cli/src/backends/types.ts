import type { AgentFactoryOptions } from '@/agent/core';
import type { ChecklistId } from '@/capabilities/checklistIds';
import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { CloudConnectTarget } from '@/cloud/connectTypes';
import type { DaemonSpawnHooks } from '../daemon/spawnHooks';
import type {
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
  ConnectedServicesProviderConfigSharingModeV1,
  ConnectedServicesProviderStateSharingModeV1,
  ExternalSessionsProviderId,
} from '@happier-dev/protocol';
import type { ExternalSessionProviderOps } from '@/session/external/providerOps';
import type { ExternalSessionCandidateHostAdapter } from '@/session/external/candidates/host';
import type { ExternalSessionTranscriptStoreAdapter } from '@/session/external/transcripts/store';
import type { AnyTerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';
import type { ProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import type { SessionCatalogControlAdapter } from '@/session/catalogControls/sessionCatalogControlTypes';
import type { SessionGoalControlAdapter } from '@/session/goalControls/sessionGoalControlTypes';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from '@/daemon/types';

export { AGENT_IDS as CATALOG_AGENT_IDS, DEFAULT_AGENT_ID as DEFAULT_CATALOG_AGENT_ID } from '@happier-dev/agents';
import type {
  AgentId as CatalogAgentId,
  ForkSurfaceV1,
  HandoffSurfaceV1,
  VendorResumeSupportLevel,
} from '@happier-dev/agents';
import { LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID } from '@/agent/acp/catalog/compat/customAcp';
export type CatalogAgentLookupId = CatalogAgentId | typeof LEGACY_CUSTOM_ACP_COMPAT_AGENT_ID;
export type { CatalogAgentId, VendorResumeSupportLevel };
export type { ProviderCliLaunchSpec };
import type { CodexBackendMode } from '@happier-dev/agents';
import type {
  PreflightSessionControlsProbeAdapter,
  PreflightSessionControlsProbeKind,
} from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type {
  ConnectedServiceRuntimeAuthSelectionMaterializer,
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
} from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import type { CliRuntimeCoreGetter } from '@/agent/runtime/registry/engineRegistryTypes';
import type { CatalogAcpBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { AcpRuntimeDefinitionBridgeV1 } from '@/agent/acp/runtime/definition/_types';
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
export type { ConnectedServiceProviderRuntimeAuthAdapter };
export type {
  ConnectedServiceRuntimeAuthSelectionMaterializer,
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
};
export type { SessionUsageLimitRecoveryControlAdapter };

export type CatalogAcpBackendCreateResult = Readonly<{ backend: CatalogAcpBackend }>;
export type ExternalSessionRuntimeHostAdapterParams = Readonly<{
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>;
export type ExternalSessionRuntimeHostAdapters = Readonly<{
  transcriptStores?: readonly ExternalSessionTranscriptStoreAdapter[];
  candidateHosts?: readonly ExternalSessionCandidateHostAdapter[];
}>;
export type CatalogAcpBackendFactory = (
  opts: AgentFactoryOptions,
) => CatalogAcpBackendCreateResult | Promise<CatalogAcpBackendCreateResult>;
export type ManagedServerShutdownCleanup = () => Promise<void>;

export type ManagedServerClaimDescriptor = Readonly<{
  agentId: CatalogAgentLookupId;
  statePathEnvKey: string;
  isExpectedProcessCommand: (command: string) => boolean;
}>;

export type VendorResumeSupportParams = Readonly<{
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
}>;

export type VendorResumeSupportFn = (params: VendorResumeSupportParams) => boolean;

export type HeadlessTmuxArgvTransform = (argv: string[]) => string[];

export type ProviderSessionRuntimePreferences = Readonly<Record<string, unknown>>;

export type ProviderSessionRuntimePreferencesParams = Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
  startedBy: 'terminal' | 'daemon' | undefined;
}>;

export type ProviderSessionRuntimePreferencesResolver = (
  params: ProviderSessionRuntimePreferencesParams,
) => ProviderSessionRuntimePreferences | Promise<ProviderSessionRuntimePreferences>;

export type SessionHandoffProviderBundleRecordExtractor = (
  providerBundle: Readonly<Record<string, unknown>>,
) => readonly unknown[];

export type ProviderRuntimeLocalHandoffMetadataBuilder = (params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  trackedSession: TrackedSession;
  vendorResumeId: string;
}>) => Partial<Pick<Metadata, 'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'externalSessionV1'>>;

export type ProviderAttachScope = 'local' | 'remote';

export type ProviderAttachEligibility =
  | Readonly<{
      eligible: true;
      scope: ProviderAttachScope;
      metadata: Record<string, unknown>;
    }>
  | Readonly<{
      eligible: false;
      reason: string;
    }>;

export type ProviderAttachReachability =
  | Readonly<{ reachable: true }>
  | Readonly<{ reachable: false; reason: string }>;

/**
 * Host-projected runtime binding hook.
 *
 * This is intentionally an internal host seam (not a plugin ABI).
 * It exists to let built-in backends provide an operational host binding
 * implementation so the engine registry can avoid falling back to legacy
 * registries/runners during the migration.
 */
export type ProviderAttachOps = Readonly<{
  evaluateAvailability: (params: Readonly<{
    sessionId: string;
    metadata: Record<string, unknown>;
    currentMachineId: string | null;
    sessionMachineId: string | null;
    hasLocalAttachmentInfo: boolean;
  }>) => ProviderAttachEligibility | Promise<ProviderAttachEligibility>;
  probeReachability?: (params: Readonly<{
    metadata: Record<string, unknown>;
  }>) => Promise<ProviderAttachReachability>;
  attach: (params: Readonly<{
    sessionId: string;
    metadata: Record<string, unknown>;
  }>) => Promise<number | false>;
}>;

export type ConnectedServiceStateSharingDescriptorEntry = Readonly<{
  path: string;
  mode: 'linked' | 'copied' | 'linked_or_copied' | 'env_redirect' | 'force_copied';
  envVar?: string;
  allowHardLinkFallback?: boolean;
  secret?: boolean;
}>;

export type ConnectedServiceStateSharingDescriptorTransform = Readonly<{
  entry: string;
  kind: 'rewrite_toml';
  spec: Readonly<{
    setStringValues: Readonly<Record<string, string>>;
  }>;
}>;

export type ConnectedServiceStateSharingDynamicEntryPattern = Readonly<{
  scope: 'config' | 'state';
  pattern: string;
  mode?: ConnectedServiceStateSharingDescriptorEntry['mode'];
  envVar?: string;
  allowHardLinkFallback?: boolean;
}>;

export type ConnectedServiceStateSharingDescriptor = Readonly<{
  providerId: CatalogAgentId;
  providerSupportStatus: 'supported' | 'unsupported';
  config: Readonly<{
    supported: boolean;
    modes: ReadonlyArray<ConnectedServicesProviderConfigSharingModeV1>;
    entries: ReadonlyArray<ConnectedServiceStateSharingDescriptorEntry>;
    unavailableReason?: 'not_implemented' | 'dynamic_diagnostics_required';
  }>;
  state: Readonly<{
    supported: boolean;
    modes: ReadonlyArray<ConnectedServicesProviderStateSharingModeV1>;
    entries: ReadonlyArray<ConnectedServiceStateSharingDescriptorEntry>;
    sharedStatePrivacyRiskAcknowledgementRequired?: boolean;
    symlinkUnavailableDegradePolicy: 'block_continuity' | 'degrade_to_isolated';
    unavailableReason?: 'not_implemented' | 'dynamic_diagnostics_required';
  }>;
  authIsolation: Readonly<{
    mode: 'env_only' | 'materialized_home' | 'process_env';
    secretEntries: ReadonlyArray<string>;
  }>;
  transforms?: ReadonlyArray<ConnectedServiceStateSharingDescriptorTransform>;
  dynamicEntryPatterns?: Readonly<Record<string, ConnectedServiceStateSharingDynamicEntryPattern>>;
}>;

export type ConnectedServiceRecoveryCapabilities = Readonly<{
  predictiveSoftSwitch: Readonly<{
    mode: 'supported' | 'unsupported';
  }>;
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

export type ConnectedServicePersistedSessionCandidateParams = Readonly<{
  metadata: unknown;
}>;

export type AgentChecklistContributions = Partial<
  Record<ChecklistId, ReadonlyArray<Readonly<{ id: string; params?: Record<string, unknown> }>>>
>;

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

export type AgentCatalogEntry = Readonly<{
  id: CatalogAgentLookupId;
  cliSubcommand: CatalogAgentLookupId;
  /**
   * Optional CLI subcommand handler for this agent.
   */
  getCliCommandHandler?: () => Promise<CommandHandler>;
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
   * Optional provider-owned runtime preference resolver for direct CLI starts.
   *
   * Shared session command code passes account settings and process env through this
   * hook instead of importing provider-specific preference modules.
   */
  resolveSessionRuntimePreferences?: ProviderSessionRuntimePreferencesResolver;
	  /**
	   * Optional cloud connect target for this agent.
	   *
	   * When present, `happier connect <agent>` will be available.
	   */
	  getCloudConnectTarget?: () => Promise<CloudConnectTarget>;
  /**
   * Optional daemon spawn hooks for this agent.
   *
   * These are evaluated by the daemon before spawning a child process.
   */
  getDaemonSpawnHooks?: () => Promise<DaemonSpawnHooks>;
  /**
   * Optional direct-session provider operations for browse/tail/takeover flows.
   *
   * Keep provider-specific implementations inside `src/backends/<provider>/...`
   * and expose them through this catalog hook instead of side registries.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.externalSessionSurface` from the plugin engine.
   */
  getExternalSessionProviderOps?: () => Promise<ExternalSessionProviderOps>;
  /**
   * Optional provider-owned host adapter contribution for external-session
   * transcript stores and child-host/app-server candidate listing.
   *
   * Shared runtime code consumes these as provider-neutral adapter lists; provider
   * specifics stay in `src/backends/<provider>/...` until the downstream provider
   * closure can move/delete the remaining host leaves.
   */
  getExternalSessionRuntimeHostAdapters?: (
    params: ExternalSessionRuntimeHostAdapterParams,
  ) => Promise<ExternalSessionRuntimeHostAdapters>;
  /**
   * Optional provider-owned connected-services materializer used before spawning the backend.
   *
   * This keeps provider-specific auth file/env shaping out of the daemon core.
   */
  getConnectedServicesMaterializer?: () => Promise<ConnectedServicesMaterializer | null>;
  /**
   * Optional provider-owned runtime-auth adapter for connected-service account groups.
   *
   * Provider-specific classification, quota probing, refresh, and hot-apply logic
   * lives in backend folders while daemon orchestration stays provider-agnostic.
   */
  getConnectedServiceRuntimeAuthAdapter?: () => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
  /**
   * Optional provider-owned runtime auth selection materializer.
   *
   * Shared auth-switch code resolves credentials and group metadata, then lets the
   * provider attach runtime-specific helpers without branching on provider ids.
   */
  materializeConnectedServiceRuntimeAuthSelection?: ConnectedServiceRuntimeAuthSelectionMaterializer;
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
   * `src/backends/<provider>/...` instead of a central `switch(agentId)`.
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
   * Optional provider-owned managed-server launch spec used to identify and validate host-managed processes.
   *
   * This keeps backend-specific launch identity shaping behind the catalog instead of hard-coding it in the host.
   */
  getManagedServerLaunchSpec?: () => Promise<ProviderCliLaunchSpec | null>;
  /**
   * Optional provider-owned managed-server shutdown cleanup.
   *
   * Daemon shutdown invokes this hook for providers that host long-lived managed
   * server processes, while the backend owns the process identity and safety checks.
   */
  getManagedServerShutdownCleanup?: () => Promise<ManagedServerShutdownCleanup | null>;
  /**
   * Optional provider-owned managed-server claim descriptor for daemon auth-switch cleanup.
   *
   * The daemon owns tracked child-process inventory; providers own how to identify
   * their managed server state path and process command.
   */
  getManagedServerClaimDescriptor?: () => Promise<ManagedServerClaimDescriptor | null>;
  /**
   * Optional provider-owned attach operations for shared local-control backends.
   *
   * Keep provider-specific attach eligibility and execution in the backend folder
   * and expose it through this catalog hook instead of branching in shared CLI code.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.attachSurface` from the plugin engine.
   */
  getProviderAttachOps?: () => Promise<ProviderAttachOps>;
  /**
   * Optional provider-owned terminal-runtime adapter surface.
   *
   * This keeps terminal-hosted runtime discovery/binding logic in backend-owned modules
   * instead of branching in shared catalog consumers.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.terminalRuntimeSurface` from the plugin engine.
   */
  getTerminalRuntimeOps?: () => Promise<AnyTerminalRuntimeOps | null>;
  /**
   * Optional provider-owned host runtime core.
   *
   * When present, the engine registry will prefer this runtimeCore over the legacy
   * execution-run registry fallback.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.runtimeCore` from the plugin engine.
   */
  getRuntimeCore?: CliRuntimeCoreGetter;
  /**
   * Optional provider-owned goal adapter for inactive/offline local sessions.
   *
   * Active sessions keep using session-scoped runtime RPCs; generic session code
   * resolves this hook only when it needs local provider control without a live
   * session runtime.
   */
  getSessionGoalControlAdapter?: () => Promise<SessionGoalControlAdapter | null>;
  /**
   * Optional provider-owned catalog adapter for inactive/offline local sessions.
   *
   * Active sessions keep using session-scoped runtime RPCs; generic session code
   * resolves this hook only when it needs local provider control without a live
   * session runtime.
   */
  getSessionCatalogControlAdapter?: () => Promise<SessionCatalogControlAdapter | null>;
  /**
   * Optional provider-owned usage-limit recovery adapter for inactive/offline local sessions.
   *
   * Active sessions keep using session-scoped runtime RPCs; generic session code
   * resolves this hook only when it needs provider quota probing without a live
   * session runtime.
   */
  getSessionUsageLimitRecoveryControlAdapter?: () => Promise<SessionUsageLimitRecoveryControlAdapter | null>;
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
   * Optional argv rewrite when launching headless sessions in tmux.
   *
   * Used by the CLI `--tmux` launcher before it spawns a child `happy ...` process.
   */
  getHeadlessTmuxArgvTransform?: () => Promise<HeadlessTmuxArgvTransform>;
  /**
   * Optional ACP backend factory for this agent.
   *
   * This is intentionally "pull-based" (lazy import) to avoid side-effect
   * registration and import-order dependence.
   *
   * @deprecated Provider/plugin ACP backends should expose
   * `getAcpRuntimeDefinitionBridge` so host ACP lifecycle remains generic.
   */
  getAcpBackendFactory?: () => Promise<CatalogAcpBackendFactory>;
  /**
   * Optional provider/plugin-authored ACP definition bridge.
   *
   * The bridge may provide provider-specific definition construction, but ACP
   * process lifecycle and runtime orchestration remain host-owned.
   */
  getAcpRuntimeDefinitionBridge?: () => Promise<AcpRuntimeDefinitionBridgeV1 | null>;
  /**
   * Optional provider-owned fork surface leaves.
   *
   * Host fork orchestration owns strategy selection, Happier child-session creation,
   * replay seed construction, and metadata persistence. Provider leaves only perform
   * native provider forks or resolve provider-specific child launch shaping.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.forkSurface` from the plugin engine.
   */
  getForkSurface?: () => Promise<ForkSurfaceV1 | null>;
  /**
   * Optional provider-owned session handoff bundle export/import operations.
   *
   * This keeps provider-specific handoff bundle logic out of shared session handoff core.
   *
   * @deprecated Transitional built-in catalog bridge. New provider/plugin work
   * should expose `BackendEngineV1.handoffSurface` from the plugin engine.
   */
  getHandoffSurface?: () => Promise<HandoffSurfaceV1 | null>;
  /**
   * Optional provider-owned handoff provider-bundle record extractor.
   *
   * Shared media continuity code applies provider-agnostic path validation after this hook
   * extracts provider-specific transcript/export records.
   */
  getSessionHandoffProviderBundleRecordExtractor?: () => Promise<SessionHandoffProviderBundleRecordExtractor | null>;
  /**
   * Optional provider-owned runtime-local metadata builder for session handoff.
   *
   * Shared daemon handoff code owns export/runtime-local splitting; providers own
   * provider-specific resume ids and external-session source metadata.
   */
  buildRuntimeLocalHandoffMetadata?: ProviderRuntimeLocalHandoffMetadataBuilder;
  /**
   * Optional provider-owned permission-mode normalization for daemon `happy session` forwarding.
   *
   * Use this to keep provider-specific permission-mode alias handling out of shared daemon core.
   */
  normalizeSessionControlPermissionMode?: (permissionMode: string) => string;
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
  /**
   * Optional capability checklist contributions for agent-specific UX.
   *
   * This is intentionally data-only (no self-registration) so the capabilities
   * engine can stay deterministic and easy to inspect.
   */
  checklists?: AgentChecklistContributions;
}>;

export type {
  ExternalSessionProviderOps,
  ExternalSessionsProviderId,
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
};
export type { AnyTerminalRuntimeOps, TerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';

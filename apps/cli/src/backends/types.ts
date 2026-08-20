import type { AgentBackend } from '@/agent/core';
import type { Metadata } from '@/api/types';
import type { ChecklistId } from '@/capabilities/checklistIds';
import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { CloudConnectTarget } from '@/cloud/connectTypes';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type { TrackedSession } from '@/daemon/types';
import type { BoundTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
import type {
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
  ConnectedServicesProviderConfigSharingModeV1,
  ConnectedServicesProviderStateSharingModeV1,
} from '@happier-dev/protocol';
import type { DirectSessionProviderOps } from './directSessions/providerOps';
import type { AcpForkContinuationHandler } from './forking/acpForkContinuationHandler';
import type { ProviderNativeForkHandler } from './forking/providerNativeForkHandler';
import type { SessionCatalogControlAdapter } from '@/session/catalogControls/sessionCatalogControlTypes';
import type { SessionGoalControlAdapter } from '@/session/goalControls/sessionGoalControlTypes';
import type { SessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';

export { AGENT_IDS as CATALOG_AGENT_IDS, DEFAULT_AGENT_ID as DEFAULT_CATALOG_AGENT_ID } from '@happier-dev/agents';
import type { AgentId as CatalogAgentId, VendorResumeSupportLevel } from '@happier-dev/agents';
export type { CatalogAgentId, VendorResumeSupportLevel };
import type { CodexBackendMode } from '@happier-dev/agents';
import type { InstallableKey } from '@happier-dev/protocol';
import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
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

export type CatalogAcpBackendCreateResult = Readonly<{ backend: AgentBackend }>;
export type CatalogAcpBackendFactory = (opts: unknown) => CatalogAcpBackendCreateResult;

export type VendorResumeSupportParams = Readonly<{
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
}>;

export type VendorResumeSupportFn = (params: VendorResumeSupportParams) => boolean;

export type HeadlessTmuxArgvTransform = (argv: string[]) => string[];

export type ProviderRuntimeLocalHandoffMetadataBuilder = (params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  trackedSession: TrackedSession;
  vendorResumeId: string;
}>) => Partial<Pick<Metadata, 'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'>>;

export type ProviderTerminalAttachmentRetirementHook = (params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attachmentInfo: BoundTerminalAttachmentInfo;
}>) => Promise<void>;

export type ProviderTerminalAttachmentControlProbe = (params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attachmentId?: string;
}>) => Promise<boolean>;

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

export type ProviderAttachOps = Readonly<{
  evaluateEligibility: (params: Readonly<{
    metadata: Record<string, unknown>;
    currentMachineId: string | null;
    sessionMachineId: string | null;
    hasLocalAttachmentInfo: boolean;
  }>) => ProviderAttachEligibility | Promise<ProviderAttachEligibility>;
  probeReachability?: (params: Readonly<{
    metadata: Record<string, unknown>;
  }>) => Promise<ProviderAttachReachability>;
  runAttach: (params: Readonly<{
    sessionId: string;
    metadata: Record<string, unknown>;
  }>) => Promise<number | false>;
}>;

export type ConnectedServiceStateSharingDescriptorEntry = Readonly<{
  path: string;
  mode: 'linked' | 'copied' | 'linked_or_copied' | 'env_redirect' | 'force_copied';
  envVar?: string;
  secret?: boolean;
  allowHardLinkFallback?: boolean;
}>;

export type ConnectedServiceStateSharingDescriptorTransform =
  | Readonly<{
      entry: string;
      kind: 'rewrite_toml';
      spec: Readonly<{
        setStringValues: Readonly<Record<string, string>>;
      }>;
    }>
  | Readonly<{
      entry: string;
      kind: 'fan_out_blob';
      spec: Readonly<Record<string, unknown>>;
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
  runtimeAuthSelection?: unknown;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
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
  id: CatalogAgentId;
  cliSubcommand: CatalogAgentId;
  /**
   * Optional CLI subcommand handler for this agent.
   */
  getCliCommandHandler?: () => Promise<CommandHandler>;
  getCliCapabilityOverride?: () => Promise<Capability>;
  /**
   * Optional extra capabilities contributed by this agent.
   *
   * Use this for agent-specific deps/tools/experiments, not the base `cli.<agentId>`
   * capability (handled by `getCliCapabilityOverride` / generic fallback).
   */
  getCapabilities?: () => Promise<ReadonlyArray<Capability>>;
  getCliDetect?: () => Promise<CliDetectSpec>;
  getCliAuthSpec?: () => Promise<CliAuthSpec>;
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
   */
  getDirectSessionProviderOps?: () => Promise<DirectSessionProviderOps>;
  /**
   * Optional provider-owned attach operations for shared local-control backends.
   *
   * Keep provider-specific attach eligibility and execution in the backend folder
   * and expose it through this catalog hook instead of branching in shared CLI code.
   */
  getProviderAttachOps?: () => Promise<ProviderAttachOps>;
  /**
   * Optional provider-owned cleanup after an exact terminal attachment has been retired.
   * Shared lifecycle code broadcasts the immutable retirement fact; providers clean only
   * descriptors fenced to that attachment and must not infer host ownership here.
   */
  onTerminalAttachmentRetired?: ProviderTerminalAttachmentRetirementHook;
  /** Whether this provider owns attachment-bound control state for a disconnected host. */
  hasTerminalAttachmentControlDescriptor?: ProviderTerminalAttachmentControlProbe;
  /**
   * Optional provider-owned connected-services materializer.
   *
   * Generic daemon code supplies resolved credentials and session-scoped directories;
   * providers decide how those credentials become env vars or auth files.
   */
  getConnectedServiceMaterializer?: () => Promise<ConnectedServicesProviderMaterializer | null>;
  /**
   * Optional provider-owned connected-service runtime auth adapter.
   *
   * Generic daemon/runtime code resolves this through the backend catalog so usage-limit
   * classification, hot-apply, refresh, and recovery behavior stay in provider folders.
   */
  getConnectedServiceRuntimeAuthAdapter?: () => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
  /**
   * Optional provider-owned runtime auth selection materializer.
   *
   * Shared auth-switch code resolves credentials and group metadata, then lets the
   * provider attach any runtime-specific helpers without branching on provider ids.
   */
  materializeConnectedServiceRuntimeAuthSelection?: ConnectedServiceRuntimeAuthSelectionMaterializer;
  /**
   * Optional provider-owned connected-service credential lifecycle policy.
   *
   * Shared refresh/restart orchestration consumes this descriptor instead of
   * branching on provider ids. Providers own restart requirements, refresh-token
   * runtime handling, and service coverage here.
   */
  getConnectedServiceCredentialLifecycleDescriptor?: () => Promise<ConnectedServiceCredentialLifecycleDescriptor | null>;
  /**
   * Optional provider-owned connected-service state/config sharing descriptor.
   *
   * Shared daemon code consumes this hook to avoid provider-name branching while
   * provider folders own allowlists, state rules, and unsupported diagnostics.
   */
  getConnectedServiceStateSharingDescriptor?: () => Promise<ConnectedServiceStateSharingDescriptor | null>;
  /**
   * Optional provider-owned quota fetcher descriptor.
   *
   * Shared quota polling owns host policy such as generic stale windows; providers own private
   * endpoint URLs, provider headers, kill switches, and service-specific placeholder behavior.
   */
  connectedServiceQuotaFetcherDescriptor?: ConnectedServiceQuotaFetcherDescriptor;
  /**
   * Optional provider-owned continuity resolver for existing-session auth switches.
   *
   * Generic switch orchestration calls this hook before offering or applying a
   * binding change. Providers decide whether exact vendor-session continuity is
   * possible for the requested switch.
   */
  resolveConnectedServiceSwitchContinuity?: (
    params: ConnectedServiceSwitchContinuityParams,
  ) => Promise<ConnectedServiceSwitchContinuityResult>;
  /**
   * Optional provider-owned resume-reachability probe.
   *
   * Generic continuity/spawn-gate code resolves this through the backend catalog so the
   * "is the vendor session for `vendorResumeId` reachable from a source the switch will
   * import / the target the vendor reads" decision stays in `src/backends/<provider>/...`
   * instead of a central `switch(agentId)`.
   *
   * The signature is normalized across providers (single `VerifyResumeReachableInput`).
   * Providers whose underlying probe takes a different shape (e.g. Claude) adapt to this
   * normalized input inside their backend folder without changing behavior.
   */
  verifyResumeReachable?: (
    input: VerifyResumeReachableInput,
  ) => Promise<VerifyResumeReachableResult>;
  /**
   * Optional provider-owned persisted session candidate derivation for connected-service
   * resume reachability. Shared daemon code passes generic metadata; providers own any
   * vendor-specific metadata fields.
   */
  resolveConnectedServiceCandidatePersistedSessionFile?: (
    input: ConnectedServicePersistedSessionCandidateParams,
  ) => string | null;
  /**
   * Optional provider-owned derivation of this Agent's own session log for a
   * vendor resume id.
   *
   * The handoff brief may point the incoming Agent at the log the departing one
   * kept. An Agent that PERSISTS that path declares
   * `vendorResumeContinuityProofField` and generic code reads it out of metadata
   * without naming a vendor key; this hook is for an Agent that persists nothing
   * and can only DERIVE the path — Codex names its rollout file after the thread
   * id under a date-partitioned sessions root. The caller resolves the vendor
   * resume id and verifies the returned path against the filesystem; the provider
   * owns only the "where would that id's log be" step.
   */
  resolveAgentNativeSessionLogPath?: (
    input: Readonly<{ vendorResumeId: string }>,
  ) => Promise<string | null> | string | null;
  /**
   * Optional provider-owned goal control adapter for inactive/offline local sessions.
   *
   * Generic CLI/session code resolves this through the catalog so provider-specific
   * control behavior stays in `src/backends/<provider>/...`.
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
   * Used by the daemon to decide whether it may pass `--resume <vendorSessionId>`.
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
   */
  getAcpBackendFactory?: () => Promise<CatalogAcpBackendFactory>;
  /**
   * Optional ACP fork-continuation shaper.
   *
   * Used by fork orchestration to keep provider-specific resume/env/metadata shaping
   * behind the backend catalog after ACP `session/fork` succeeds.
   */
  getAcpForkContinuationHandler?: () => Promise<AcpForkContinuationHandler>;
  /**
   * Optional provider-native fork handler.
   *
   * Used by fork orchestration to delegate provider-specific native fork behavior
   * through the backend catalog.
   */
  getProviderNativeForkHandler?: () => Promise<ProviderNativeForkHandler>;
  /**
   * Optional provider-owned runtime-local metadata builder for session handoff.
   *
   * Shared daemon handoff code owns export/runtime-local splitting; providers own
   * provider-specific resume ids and direct-session source metadata.
   */
  buildRuntimeLocalHandoffMetadata?: ProviderRuntimeLocalHandoffMetadataBuilder;
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
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
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
  runtimeInstallableKeys?: readonly InstallableKey[];
}>;

export type {
  AcpForkContinuationHandler,
  DirectSessionProviderOps,
  DirectSessionsProviderId,
  ProviderNativeForkHandler,
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
  SessionUsageLimitRecoveryControlAdapter,
};

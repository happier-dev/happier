import type { AgentBackend, AgentFactoryOptions } from '@/agent/core';
import type { ChecklistId } from '@/capabilities/checklistIds';
import type { Capability } from '@/capabilities/service';
import type { CommandHandler } from '@/cli/commandRegistry';
import type { CloudConnectTarget } from '@/cloud/connectTypes';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { DirectSessionProviderOps } from './directSessions/providerOps';
import type { AcpForkContinuationHandler } from './forking/acpForkContinuationHandler';
import type { ProviderNativeForkHandler } from './forking/providerNativeForkHandler';
import type { AnyTerminalRuntimeOps } from './terminalRuntime/types';
import type { ImportedSessionHandoffBundle, SessionHandoffProviderBundle } from '@/session/handoff/types';

export { AGENT_IDS as CATALOG_AGENT_IDS, DEFAULT_AGENT_ID as DEFAULT_CATALOG_AGENT_ID } from '@happier-dev/agents';
import type { AgentId as CatalogAgentId, VendorResumeSupportLevel } from '@happier-dev/agents';
export type { CatalogAgentId, VendorResumeSupportLevel };
import type { CodexBackendMode } from '@happier-dev/agents';
import type { InstallableKey } from '@happier-dev/protocol';
import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type { ConnectedServicesSpawnMaterializer } from './connectedServices/spawnMaterializer';
export type { ConnectedServicesSpawnMaterializer };
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
export type CatalogAcpBackendFactory = (opts: AgentFactoryOptions) => CatalogAcpBackendCreateResult;

export type VendorResumeSupportParams = Readonly<{
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
}>;

export type VendorResumeSupportFn = (params: VendorResumeSupportParams) => boolean;

export type HeadlessTmuxArgvTransform = (argv: string[]) => string[];

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

export type SessionHandoffProviderOps = Readonly<{
  exportBundle: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    activeServerDir: string;
  }>) => Promise<SessionHandoffProviderBundle>;
  importBundle: (params: Readonly<{
    bundle: SessionHandoffProviderBundle;
    targetPath: string;
    sessionStorageMode?: 'direct' | 'persisted';
  }>) => Promise<ImportedSessionHandoffBundle>;
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
   * Optional provider-owned connected-services materializer used before spawning the backend.
   *
   * This keeps provider-specific auth file/env shaping out of the daemon core.
   */
  getConnectedServicesSpawnMaterializer?: () => Promise<ConnectedServicesSpawnMaterializer | null>;
  /**
   * Optional provider-owned attach operations for shared local-control backends.
   *
   * Keep provider-specific attach eligibility and execution in the backend folder
   * and expose it through this catalog hook instead of branching in shared CLI code.
   */
  getProviderAttachOps?: () => Promise<ProviderAttachOps>;
  /**
   * Optional provider-owned terminal-runtime adapter surface.
   *
   * This keeps terminal-hosted runtime discovery/binding logic in backend-owned modules
   * instead of branching in shared catalog consumers.
   */
  getTerminalRuntimeOps?: () => Promise<AnyTerminalRuntimeOps | null>;
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
   * Optional provider-owned session handoff bundle export/import operations.
   *
   * This keeps provider-specific handoff bundle logic out of shared session handoff core.
   */
  getSessionHandoffProviderOps?: () => Promise<SessionHandoffProviderOps | null>;
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
    accountSettings?: Readonly<Record<string, unknown>> | null;
  }>) => string | null;
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
};
export type { AnyTerminalRuntimeOps, TerminalRuntimeOps } from './terminalRuntime/types';

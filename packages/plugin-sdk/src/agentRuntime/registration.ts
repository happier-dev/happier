import type { AgentProviderBindingAdapter } from './providerBinding.js';
import type { AgentTerminalSessionStateUpdate } from './projections.js';

/**
 * Secret-free connected-service selection supplied to an Agent daemon spawn
 * hook for the Session being launched. Credential material remains in the
 * bounded environment projection; this records only the selected source and
 * profile/group identity.
 */
export type AgentDaemonSpawnConnectedServiceBindingV1 =
  | Readonly<{ source: 'native' }>
  | Readonly<{
    source: 'connected';
    selection: 'profile';
    profileId: string;
  }>
  | Readonly<{
    source: 'connected';
    selection: 'group';
    groupId: string;
    profileId?: string;
  }>;

export type AgentDaemonSpawnConnectedServicesV1 = Readonly<{
  v: 1;
  bindingsByServiceId: Readonly<Record<string, AgentDaemonSpawnConnectedServiceBindingV1>>;
}>;

export type AgentDaemonResolvedToolV1 =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
    source: 'system' | 'managed' | 'user_config' | 'unknown';
  }>
  | Readonly<{
    ok: false;
    reasonCode: 'tool_unavailable' | 'installable_unavailable' | 'unsupported' | 'aborted';
    errorMessage: string;
  }>;

export type AgentDaemonRunToolResultV1 =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
    source: Extract<AgentDaemonResolvedToolV1, { ok: true }>['source'];
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    ok: false;
    reasonCode:
      | Extract<AgentDaemonResolvedToolV1, { ok: false }>['reasonCode']
      | 'execution_failed'
      | 'timeout';
    errorMessage: string;
    exitCode?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
  }>;

export type AgentDaemonSpawnDiagnosticV1 = Readonly<{
  code: string;
  message: string;
  detail?: Readonly<Record<string, unknown>>;
}>;

/**
 * Bounded host tools available while deciding whether an Agent spawn may
 * proceed. This is the complete tool surface for the hook; it does not expose
 * general daemon services or process custody.
 */
export type AgentDaemonSpawnToolResolutionContextV1 = Readonly<{
  signal: AbortSignal;
  resolveSystemTool(input: Readonly<{
    toolId: string;
    lookupNames?: readonly string[];
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<AgentDaemonResolvedToolV1>;
  runSystemTool(input: Readonly<{
    toolId: string;
    lookupNames?: readonly string[];
    sourcePreference?: 'system-first' | 'managed-first';
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    reason: string;
  }>): Promise<AgentDaemonRunToolResultV1>;
  resolveManagedInstallable(input: Readonly<{
    installableId: string;
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<AgentDaemonResolvedToolV1>;
  diagnostics: Readonly<{
    info(input: AgentDaemonSpawnDiagnosticV1): void;
    warn(input: AgentDaemonSpawnDiagnosticV1): void;
  }>;
}>;

/**
 * Launch facts available to a registered Agent daemon spawn hook. The host
 * owns process creation and every supplied value is a bounded snapshot for
 * this one spawn decision.
 */
export type AgentDaemonSpawnRuntimeSelectionV1 = Readonly<{
  providerRuntimeSelection?: Readonly<Record<string, unknown>>;
  runtimeDescriptorV1?: Extract<
    AgentTerminalSessionStateUpdate,
    Readonly<{ fieldId: 'identity.runtimeDescriptor' }>
  >['value'];
  cwd?: string;
  directory?: string;
  env?: Readonly<Record<string, string>>;
  connectedServices?: AgentDaemonSpawnConnectedServicesV1;
  providerBinding?: Readonly<{
    v: 1;
    agentTargetKey: string;
    connectionId: string;
    modelId: string;
  }>;
  tools?: AgentDaemonSpawnToolResolutionContextV1;
}>;

export type AgentDaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string; reasonCode?: string }>;

/**
 * Agent-owned spawn policy registered through `activate(api)`. The host binds
 * these callbacks to the active Agent generation before exposing them through
 * the catalog, so a retired generation cannot answer a later spawn.
 */
export type AgentDaemonSpawnHooks = Readonly<{
  resolveRuntimePrerequisites?: (
    params: AgentDaemonSpawnRuntimeSelectionV1,
  ) => Promise<AgentDaemonSpawnValidationResult>;
  augmentEnv?: (
    params: AgentDaemonSpawnRuntimeSelectionV1,
  ) => Record<string, string>;
}>;

/**
 * Immutable-generation-relative identity of the named Agent factory leaf that
 * a Session runner is allowed to load. The host validates the selected leaf
 * against the factory object registered through the one activation ABI.
 */
export type AgentSessionRunnerFactoryLocatorV1 = Readonly<{
  module: string;
  export: string;
  runtimeApiVersion: 1;
  /**
   * Optional named `AgentExternalSessionsContribution` export from the same
   * authenticated module as the primary Agent factory.
   */
  externalSessionsExport?: string;
}>;

/**
 * Static correspondence carried by the canonical Agent registration. A
 * registration-owned Session-capable Agent must supply `sessionRunnerFactory`;
 * an execution-only Agent must not. Host-owned declarative ACP runtimes have
 * no plugin registration. The registration transaction enforces that
 * declaration correspondence before publishing the generation.
 */
export type AgentRuntimeRegistrationOptions = Readonly<{
  providerBinding?: AgentProviderBindingAdapter;
  sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1;
  daemonSpawnHooks?: AgentDaemonSpawnHooks;
}>;

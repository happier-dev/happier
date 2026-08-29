import type { AgentProviderBindingAdapter } from './providerBinding.js';
import type {
  AgentTerminalSessionStateUpdate,
  AttachSessionMetadata,
} from './projections.js';
import type { JsonValue } from '../identity.js';
import type { AgentConnectedAccountContinuityV1 } from './connectedAccountContinuity.js';

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
  /**
   * Agent-owned runtime selection. The host transports this bounded snapshot
   * to the selected Agent but does not interpret its Agent-specific fields.
   */
  agentRuntimeSelection?: Readonly<Record<string, unknown>>;
  runtimeDescriptorV1?: Extract<
    AgentTerminalSessionStateUpdate,
    Readonly<{ fieldId: 'identity.runtimeDescriptor' }>
  >['value'];
  cwd?: string;
  directory?: string;
  env?: Readonly<Record<string, string>>;
  connectedServices?: AgentDaemonSpawnConnectedServicesV1;
  /** True only when this launch has an externally selected model binding. */
  hasExternalModelBinding?: true;
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
 * Plugin-produced facts used only by the host-owned provider CLI attach
 * surface. Session metadata remains the bounded attach projection; process,
 * health, credential, and connection custody remain with the host.
 */
export type AgentProviderCliAttachTargetV1 = Readonly<Record<string, string>>;

export type AgentProviderCliAttachTargetResolutionV1 =
  | Readonly<{
    ok: true;
    value: AgentProviderCliAttachTargetV1;
  }>
  | Readonly<{
    ok: false;
    reason: string;
  }>;

/**
 * Static Agent declaration for a host-created provider CLI attach surface.
 * All three callbacks are required so metadata and live reachability follow
 * one declaration rather than a plugin-owned executable surface.
 */
export type AgentProviderCliAttachDeclarationV1 = Readonly<{
  resolveTarget(params: Readonly<{
    metadata: AttachSessionMetadata;
    fallbackServerBaseUrl?: string | null;
  }>): AgentProviderCliAttachTargetResolutionV1;
  createArgs(target: AgentProviderCliAttachTargetV1): readonly string[];
  buildHealthUrl(target: AgentProviderCliAttachTargetV1): string | null;
}>;

/**
 * Agent-owned CLI arguments after the host parser has consumed its generic
 * session flags. This remains data-only: an Agent can interpret its own
 * command arguments, but cannot receive raw argv, a dispatcher, or process
 * custody through this declaration.
 */
export type AgentCliSessionCommandParsedArgsV1 = Readonly<{
  startingMode?: string;
  directory?: string;
  resume?: string;
  agentArgs: readonly string[];
}>;

/** Exact non-secret Settings records owned by the Agent, kept scope-qualified. */
export type AgentCliSessionCommandPluginSettingsV1 = Readonly<Partial<Record<
  'account' | 'daemon',
  Readonly<Record<string, unknown>>
>>>;

export type AgentCliSessionCommandBuildInputV1 = Readonly<{
  isExplicitCliSubcommand: boolean;
  parsed: AgentCliSessionCommandParsedArgsV1;
  /**
   * Current Account settings already resolved by the host for this Session.
   * The Agent may interpret its own settings; it cannot read or mutate the
   * host settings store.
   */
  settings: Readonly<Record<string, unknown>>;
  /**
   * Exact Settings record for the owning Agent contribution. This projection
   * contains declaration defaults and persisted non-secret fields only; it is
   * intentionally separate from host Account settings so an Agent cannot
   * accidentally read a same-named field from the wrong scope.
   */
  pluginSettings: AgentCliSessionCommandPluginSettingsV1;
  /**
   * Current host-resolved launch environment for this Session. This is data,
   * not a process environment handle; process construction remains host-owned.
   */
  environment: Readonly<Record<string, string | undefined>>;
  /** Host-resolved source of the current Session start. */
  startOrigin: 'terminal' | 'daemon';
}>;

/**
 * Agent-specific Session options are a bounded JSON data projection. The
 * host still owns parsing, dispatch, Account/settings resolution, Session
 * creation, and process custody.
 */
export type AgentCliSessionCommandOptionsV1 = Readonly<Record<string, JsonValue | undefined>>;

export type AgentCliSessionCommandBuildOptionsResultV1 =
  | Readonly<{
    ok: true;
    options: AgentCliSessionCommandOptionsV1;
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
  }>;

/**
 * Optional Agent declaration for the host-owned `happy <agent>` session
 * command. Static flags describe only Agent-native forwarding; the optional
 * callback turns parsed Agent arguments into bounded Session options.
 */
export type AgentCliSessionCommandDeclarationV1 = Readonly<{
  sessionRuntimeId?: string;
  deprecatedAliasAgentId?: string;
  accountSettingsAgentId?: string;
  implicitResumeDelegation?: Readonly<{
    resumeFlags: readonly string[];
  }>;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  forwardResumeFlag?: boolean;
  yoloAgentArgs?: readonly string[];
  versionFlags?: readonly string[];
  infoCommandPrefixes?: readonly (readonly string[])[];
  buildSessionOptions?: (
    input: AgentCliSessionCommandBuildInputV1,
  ) => AgentCliSessionCommandBuildOptionsResultV1 | Promise<AgentCliSessionCommandBuildOptionsResultV1>;
}>;

/** The normalized result of one Agent-owned CLI authentication probe. */
export type AgentCliAuthStatusV1 = Readonly<{
  state: 'logged_in' | 'logged_out' | 'unknown';
  method?: 'api_key_env' | 'auth_token_env' | 'credentials_file' | 'oauth_cli' | 'config_file' | 'gcloud_adc' | 'unknown' | null;
  accountLabel?: string | null;
  reason?: 'missing_credentials' | 'expired' | 'cli_missing' | 'probe_failed' | 'timeout' | 'unsupported' | 'interactive_blocked' | 'not_configured' | null;
  source?: 'env' | 'file' | 'command' | 'mixed' | null;
}>;

/** Bounded result from a host-owned CLI-auth probe command. */
export type AgentCliAuthCommandResultV1 = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

/**
 * Focused Agent-auth callback captured with the Agent registration. The host
 * owns environment construction and command execution; an Agent only
 * interprets its own bounded probe results.
 */
export type AgentCliAuthContributionV1 = Readonly<{
  detectAuthStatus(input: Readonly<{
    runDeclaredSystemToolCommand(input: Readonly<{
      toolId: string;
      args: readonly string[];
      timeoutMs?: number;
    }>): Promise<AgentCliAuthCommandResultV1>;
  }>): Promise<AgentCliAuthStatusV1> | AgentCliAuthStatusV1;
}>;

/**
 * A relative native-home entry whose sharing behavior is selected by the
 * Account settings owner. It is declaration data only: the host retains every
 * path, filesystem, copy/link/import, and cleanup operation.
 */
export type AgentConnectedAccountStateSharingDescriptorEntryV1 = Readonly<{
  path: string;
  mode: 'linked' | 'copied' | 'linked_or_copied' | 'env_redirect' | 'force_copied';
  envVar?: string;
  allowHardLinkFallback?: boolean;
  secret?: boolean;
}>;

export type AgentConnectedAccountStateSharingDescriptorTransformV1 = Readonly<{
  entry: string;
  kind: 'rewrite_toml';
  spec: Readonly<{
    setStringValues: Readonly<Record<string, string>>;
  }>;
}>;

export type AgentConnectedAccountStateSharingDynamicEntryPatternV1 = Readonly<{
  scope: 'config' | 'state';
  pattern: string;
  mode?: AgentConnectedAccountStateSharingDescriptorEntryV1['mode'];
  envVar?: string;
  allowHardLinkFallback?: boolean;
}>;

/** Exact native home used as the source for host-owned state sharing. */
export type AgentConnectedAccountNativeHomeV1 = Readonly<{
  environmentKey: string;
  defaultRelativePath: string;
}>;

/**
 * Static Agent-native classification of a materialized Connected Account
 * home. The Agent never receives a materialized root or filesystem capability
 * through this declaration; the existing host state-sharing owner consumes it.
 */
export type AgentConnectedAccountStateSharingDescriptorV1 = Readonly<{
  nativeHome?: AgentConnectedAccountNativeHomeV1;
  providerSupportStatus: 'supported' | 'unsupported';
  config: Readonly<{
    supported: boolean;
    modes: readonly ('linked' | 'copied' | 'isolated')[];
    entries: readonly AgentConnectedAccountStateSharingDescriptorEntryV1[];
    unavailableReason?: 'not_implemented' | 'dynamic_diagnostics_required';
  }>;
  state: Readonly<{
    supported: boolean;
    modes: readonly ('isolated' | 'shared')[];
    entries: readonly AgentConnectedAccountStateSharingDescriptorEntryV1[];
    sharedStatePrivacyRiskAcknowledgementRequired?: boolean;
    symlinkUnavailableDegradePolicy: 'block_continuity' | 'degrade_to_isolated';
    unavailableReason?: 'not_implemented' | 'dynamic_diagnostics_required';
  }>;
  authIsolation: Readonly<{
    mode: 'env_only' | 'materialized_home' | 'process_env';
    secretEntries: readonly string[];
  }>;
  transforms?: readonly AgentConnectedAccountStateSharingDescriptorTransformV1[];
  dynamicEntryPatterns?: Readonly<Record<string, AgentConnectedAccountStateSharingDynamicEntryPatternV1>>;
}>;

/**
 * Bounded declaration of one request-auth materialization an Agent uses at
 * launch. The host retains account selection, authorization, secret custody,
 * materialization, and final dispatch.
 */
export type AgentConnectedAccountRequestAuthUseV1 = Readonly<{
  purpose: string;
  materialization: Readonly<{
    kind: 'httpHeaders';
    origin: string;
    headerNames: readonly string[];
  }>;
}>;

/** One host-materialized credential file projected into an Agent environment variable. */
export type AgentConnectedAccountFileEnvironmentUseV1 = Readonly<{
  purpose: string;
  fileId: string;
  environmentKey: string;
}>;

/** One host-materialized credential value projected into an Agent environment variable. */
export type AgentConnectedAccountEnvironmentUseV1 = Readonly<{
  purpose: string;
  environmentKey: string;
}>;

export type AgentConnectedAccountSwitchTransitionV1 =
  | 'native_to_connected'
  | 'connected_to_native'
  | 'connected_to_connected'
  | 'same_connected_group';

/**
 * Static Agent-owned facts used by the host's existing-Session account-switch
 * coordinator. The host remains the transition, restart, and Session lifecycle
 * owner; this declaration only classifies which native transitions preserve
 * continuity for this Agent.
 */
export type AgentConnectedAccountSwitchContinuityV1 = Readonly<{
  continuityMode: 'hot_apply' | 'restart_same_home' | 'restart_shared_state_required';
  supportedTransitions?: readonly AgentConnectedAccountSwitchTransitionV1[];
  providerStateSharingRequired?: Readonly<{
    serviceIds?: readonly string[];
    supportedTransitions: readonly AgentConnectedAccountSwitchTransitionV1[];
  }>;
}>;

/**
 * Focused pre-open Connected Account facts captured with one Agent runtime
 * registration. Manifest declarations remain the authority for service and
 * purpose identity; this contribution only supplies exact request-auth uses
 * and static state-sharing classification.
 */
export type AgentConnectedAccountLaunchContributionV1 = Readonly<{
  requestAuthUses?: readonly AgentConnectedAccountRequestAuthUseV1[];
  fileEnvironmentUses?: readonly AgentConnectedAccountFileEnvironmentUseV1[];
  environmentUses?: readonly AgentConnectedAccountEnvironmentUseV1[];
  switchContinuity?: AgentConnectedAccountSwitchContinuityV1;
  stateSharingDescriptor?: AgentConnectedAccountStateSharingDescriptorV1;
  /**
   * Agent-owned interpretation required by host-owned account switching and
   * retained-session continuity. Registration generation currentness remains
   * enforced by the host before and after every callback.
   */
  continuity?: AgentConnectedAccountContinuityV1;
}>;

/**
 * Static command facts for one preflight inspection. The host resolves the
 * declared system tool, materializes its environment, and owns the deadline
 * and process lifecycle. An Agent can narrow the environment by exact names
 * and opt out of the host's default `CI=1` projection when its native CLI
 * requires that behavior.
 */
export type AgentPreflightSessionControlsCommandV1 = Readonly<{
  toolId: string;
  args: readonly string[];
  environmentKeys?: readonly string[];
  environmentExcludeKeys?: readonly string[];
  ci?: 'omit';
}>;

/** Bounded result from a host-owned preflight command invocation. */
export type AgentPreflightSessionControlsCommandResultV1 = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

/**
 * Request-only view of a host-scoped JSON-RPC client. The host creates,
 * bounds, cancels, and disposes the backing process; the Agent can only issue
 * protocol requests and interpret their responses.
 */
export type AgentPreflightJsonRpcRequestClientV1 = Readonly<{
  request(
    method: string,
    params?: JsonValue,
  ): Promise<JsonValue>;
}>;

export type AgentPreflightSessionControlsProbeInputV1 = Readonly<{
  accountSettings: Readonly<Record<string, JsonValue>> | null;
  environment: Readonly<Record<string, boolean>>;
}>;

/**
 * Host-bound tools for Agent-native preflight interpretation. Neither raw
 * environment values nor process/terminal handles cross this seam.
 */
export type AgentPreflightSessionControlsProbeContextV1 =
  AgentPreflightSessionControlsProbeInputV1 & Readonly<{
    signal: AbortSignal;
    runDeclaredSystemToolCommand(input: Readonly<{
      toolId: string;
      args: readonly string[];
    }>): Promise<AgentPreflightSessionControlsCommandResultV1>;
    withDeclaredJsonRpcClient<TResult>(
      input: Readonly<{
        toolId: string;
        args: readonly string[];
      }>,
      inspect: (
        client: AgentPreflightJsonRpcRequestClientV1,
        signal: AbortSignal,
      ) => Promise<TResult> | TResult,
    ): Promise<TResult>;
  }>;

export type AgentPreflightSessionControlsModelsV1 = Readonly<{
  command: AgentPreflightSessionControlsCommandV1;
  parseOutput?: (
    result: AgentPreflightSessionControlsCommandResultV1,
  ) => Promise<unknown | null> | unknown | null;
  fallback?: Readonly<{
    command: AgentPreflightSessionControlsCommandV1;
    parseOutput?: (
      result: AgentPreflightSessionControlsCommandResultV1,
    ) => Promise<unknown | null> | unknown | null;
  }>;
}>;

/**
 * Focused Agent-native preflight declaration captured with Agent runtime
 * registration. The host remains the owner of tool resolution, settings and
 * connected-service materialization, execution, cancellation, cache policy
 * enforcement, dispatch, and result projection.
 */
export type AgentPreflightSessionControlsContributionV1 = Readonly<{
  resolveProbeVariant?: (
    input: AgentPreflightSessionControlsProbeInputV1,
  ) => string | null | undefined;
  models?: AgentPreflightSessionControlsModelsV1;
  jsonRpcCommand?: AgentPreflightSessionControlsCommandV1;
  probeModels?: (
    context: AgentPreflightSessionControlsProbeContextV1,
  ) => Promise<unknown | null> | unknown | null;
  probeModes?: (
    context: AgentPreflightSessionControlsProbeContextV1,
  ) => Promise<unknown | null> | unknown | null;
  probeConfigOptions?: (
    context: AgentPreflightSessionControlsProbeContextV1,
  ) => Promise<unknown | null> | unknown | null;
  probePassiveRealtimeSetup?: (
    context: AgentPreflightSessionControlsProbeContextV1,
  ) => Promise<unknown | null> | unknown | null;
}>;

/**
 * Agent-native recognition of whether a prompt requires the host's existing
 * post-submit verification. The host retains terminal access, prompt
 * submission, retry, lifecycle, cancellation, and cleanup.
 */
export type AgentTerminalPromptSubmitVerificationPolicyV1 = Readonly<{
  shouldVerifyAfterSubmit(promptText: string): boolean;
  verifyBeforeSubmitStaging?(input: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
  verifyAfterSubmit(input: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
}>;

/**
 * Bounded lifecycle facts for an Agent's eligibility decision for the
 * host-owned deferred Session bootstrap. The host retains Session creation,
 * buffering, attachment, cancellation, and cleanup.
 */
export type AgentDeferredStartupEligibilityInputV1 = Readonly<{
  startedBy: 'terminal' | 'daemon';
  startingMode: 'terminal' | 'remote' | 'local' | null;
  hasExistingSession: boolean;
  hasSessionAttachFile: boolean;
  hasProviderResumeId: boolean;
  hasExplicitPermissionMode: boolean;
  /** True when the host restored a compatible persisted permission-mode seed. */
  hasPersistedPermissionModeSeed: boolean;
  hasTerminalTty: boolean;
}>;

/**
 * Focused Agent policy for whether the host should use its canonical deferred
 * Session bootstrap. This does not give the Agent a startup lifecycle.
 */
export type AgentSessionStartupContributionV1 = Readonly<{
  shouldUseDeferredBootstrap(input: AgentDeferredStartupEligibilityInputV1): boolean;
}>;

/**
 * Bounded runtime-selection snapshot available to an experimental vendor
 * resume predicate. Agent-specific selection remains opaque to the host.
 */
export type AgentExperimentalVendorResumeSupportInputV1 = Readonly<Pick<
  AgentDaemonSpawnRuntimeSelectionV1,
  'agentRuntimeSelection' | 'runtimeDescriptorV1'
>>;

/**
 * Focused Agent predicate used only after the manifest's canonical
 * `catalog.vendorResume.support` normalizes to `experimental`.
 */
export type AgentExperimentalVendorResumeSupportContributionV1 = Readonly<{
  supportsVendorResume(input: AgentExperimentalVendorResumeSupportInputV1): boolean;
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
  providerCliAttach?: AgentProviderCliAttachDeclarationV1;
  cliSessionCommand?: AgentCliSessionCommandDeclarationV1;
  cliAuth?: AgentCliAuthContributionV1;
  connectedAccountLaunch?: AgentConnectedAccountLaunchContributionV1;
  preflightSessionControls?: AgentPreflightSessionControlsContributionV1;
  terminalPromptSubmitVerification?: AgentTerminalPromptSubmitVerificationPolicyV1;
  sessionStartup?: AgentSessionStartupContributionV1;
  vendorResumeSupport?: AgentExperimentalVendorResumeSupportContributionV1;
}>;

import type { AgentRuntimeFactoryContext, PluginInvocationContext } from '../invocation.js';
import type { WorkStateService } from '../services/sessions.js';
import type {
  AgentModelDescriptor,
  TerminalControlPort,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLivenessV1,
  TerminalHostPreference,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '@happier-dev/agents';
import type { AgentRuntimeProtocolComposers } from './acp.js';
import type { Disposable } from '../lifecycle.js';
import type { JsonValue } from '../identity.js';
import type { AgentPermissionIntent } from './session.js';
import type {
  AgentModelOptionOverrideRule,
  AgentSessionAuthRefreshClassificationV1,
  AgentSessionAuthRefreshErrorV1,
  AgentSessionAuthRefreshPayloadV1,
  AgentSessionAuthRefreshRecoveryV1,
  AgentSessionAuthRefreshSelectionV1,
  TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';
import type {
  AgentAccountUsageRecordKey,
  AgentAccountUsageSnapshot,
} from './accountUsage.js';

export type { AgentRuntimeFactoryContext } from '../invocation.js';
export type {
  SessionRuntimeAuthRefreshResultV1 as AgentSessionAuthRefreshResult,
  TerminalControlPort,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLivenessV1 as TerminalHostLiveness,
  TerminalHostPreference,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '@happier-dev/agents';

export type AgentRuntimeContext = PluginInvocationContext & Readonly<{
  agent: Readonly<{ id: string }>;
  protocols: AgentRuntimeProtocolComposers;
}>;

export type AgentSessionHookProviderPayload = Readonly<Record<string, unknown>>;

export type AgentSessionHookServerStartRequest = Readonly<{
  onSessionHook?: (providerSessionId: string, data: AgentSessionHookProviderPayload) => void | Promise<void>;
  onPermissionHook?: (data: AgentSessionHookProviderPayload) => unknown | Promise<unknown>;
  onStatuslineUpdate?: (data: AgentSessionHookProviderPayload) => void | Promise<void>;
  defaultPermissionHookResponse?: (
    data: AgentSessionHookProviderPayload,
  ) => unknown | Promise<unknown>;
  sessionHookSecret?: string;
  permissionHookSecret?: string;
  permissionRequestTimeoutMs?: number | null;
  permissionRequestTimeoutMsForTool?: (
    toolName: string | null,
  ) => number | null | undefined | Promise<number | null | undefined>;
}>;

export type AgentSessionHookServerHandle = Readonly<{
  port: number;
  sessionHookSecretFile?: string;
  permissionHookSecretFile?: string;
  stop(): void;
  dispose(): Promise<void>;
}>;

export type AgentSessionHookForwarderAssets = Readonly<{
  nodeExecutable: string;
  sessionForwarderScript: string;
  permissionForwarderScript: string;
  statuslineForwarderScript?: string;
}>;

export type AgentSessionHookPluginFile =
  | Readonly<{ path: string; json: unknown; contents?: never }>
  | Readonly<{ path: string; contents: string; json?: never }>;

export type AgentSessionHookPluginDirCreateRequest = Readonly<{
  files: readonly AgentSessionHookPluginFile[];
}>;

export type AgentSessionProviderTranscriptPublishRequest = Readonly<{
  providerSessionId?: string;
  kind: string;
  turnId?: string;
  text?: string;
  stopReason?: string;
  providerPayload?: Readonly<Record<string, unknown>>;
}>;

export interface AgentSessionHooksService {
  startServer(request: AgentSessionHookServerStartRequest): Promise<AgentSessionHookServerHandle>;
  resolveForwarderAssets(): Promise<AgentSessionHookForwarderAssets>;
  createPluginDir(request: AgentSessionHookPluginDirCreateRequest): Promise<string>;
  disposePluginDir(pluginDir: string): Promise<void>;
  publishProviderTranscript(
    request: AgentSessionProviderTranscriptPublishRequest,
  ): Promise<void>;
}

export type AgentTranscriptFileFollowLine = Readonly<{
  line: string;
  sourcePath: string;
  sequence: number;
}>;

export type AgentTranscriptFileFollowInput = Readonly<{
  path: string;
  startAt: 'beginning' | 'end';
  strategy?: 'poll';
  policy?: Readonly<{
    pollIntervalMs?: number;
    missingFileRetryIntervalMs?: number;
    maxDrainRowsPerTick?: number;
    maxDrainBytesPerTick?: number;
  }>;
  signal?: AbortSignal;
  onLine(line: AgentTranscriptFileFollowLine): void | Promise<void>;
  onReset?(event: Readonly<{ reason: 'missing' | 'replaced' | 'truncated' }>): void | Promise<void>;
  onError?(error: unknown): void | Promise<void>;
}>;

export type AgentTranscriptFileFollowHandle = Readonly<{
  id: string;
  drainNow(options?: Readonly<{ timeoutMs?: number }>): Promise<void>;
  close(options?: Readonly<{ finalDrain?: boolean; drainTimeoutMs?: number }>): Promise<void>;
}>;

export interface AgentTranscriptFileFollowService {
  follow(input: AgentTranscriptFileFollowInput): Promise<AgentTranscriptFileFollowHandle>;
}

export type AgentTranscriptSessionEventPublicationResult = Readonly<{
  status: 'custodied';
}>;

export interface AgentTranscriptSessionEventPublisher {
  /**
   * Publishes one protocol-validated Session event into the host-owned durable
   * transcript. Resolution means the canonical outbox accepted durable custody;
   * failures reject so callers can preserve retry semantics.
   */
  publishSessionEvent(
    event: TranscriptRawAgentEventV1,
  ): Promise<AgentTranscriptSessionEventPublicationResult>;
  /**
   * Reserves an exact provider-fact identity already represented by a host-owned
   * transcript row. This prevents later source catch-up from duplicating the echo.
   */
  markSourceFactConsumed?(
    request: Readonly<{
      localId: string;
      reason: 'host_prompt_echo';
    }>,
  ): Promise<AgentTranscriptSessionEventPublicationResult>;
}

export type AgentAccountUsageSourceContextInput = Readonly<{
  serviceId: string;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type AgentAccountUsageSourceContext = Readonly<{
  serviceId: string;
  profileId: string;
  bindingKind: 'profile' | 'group_member';
  groupId?: string;
}>;

export type AgentAccountUsageRecordSnapshotInput = Readonly<{
  snapshot: AgentAccountUsageSnapshot;
  /**
   * Evidence read after an already-surfaced hard failure. The host records it but must not
   * start predictive switching; the runtime-auth failure owner already owns recovery.
   */
  policyDisposition?: 'evidence_only';
  /**
   * Semantic address of the service/account source. The host resolves its current binding
   * and private currentness witnesses again when recording the observation.
   */
  source?: AgentAccountUsageSourceContextInput | null;
}>;

export type AgentAccountUsageRecordSnapshotResult =
  | Readonly<{ status: 'recorded' }>
  | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
  | Readonly<{ status: 'rejected'; reason: 'invalid_snapshot' | 'session_mismatch' | 'daemon_rejected' }>;

export type AgentAccountUsageAdoptionProof =
  | Readonly<{ kind: 'id_token_account_id'; issuer?: string }>
  | Readonly<{ kind: 'provider_account_id_match' }>
  | Readonly<{ kind: 'provider_owned_subject_proof'; detail?: string }>;

export type AgentAccountUsageAdoptProvisionalRecordInput = Readonly<{
  adoption: Readonly<{
    fromRecordId: string;
    toRecordId: string;
    stableRecordKey: AgentAccountUsageRecordKey;
    proof: AgentAccountUsageAdoptionProof;
    observedAtMs: number;
  }>;
}>;

export type AgentAccountUsageAdoptProvisionalRecordResult =
  | Readonly<{ status: 'adopted' | 'already_adopted' }>
  | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
  | Readonly<{ status: 'rejected'; reason: 'invalid_adoption' | 'session_mismatch' | 'daemon_rejected' }>;

export interface AgentAccountUsageService {
  resolveSourceContext(
    input: AgentAccountUsageSourceContextInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentAccountUsageSourceContext | null>;
  recordSnapshot(
    input: AgentAccountUsageRecordSnapshotInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentAccountUsageRecordSnapshotResult>;
  adoptProvisionalRecord(
    input: AgentAccountUsageAdoptProvisionalRecordInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentAccountUsageAdoptProvisionalRecordResult>;
}

export type AgentSessionAuthRefreshSelection = AgentSessionAuthRefreshSelectionV1;
export type AgentSessionAuthRefreshClassification = AgentSessionAuthRefreshClassificationV1;
export type AgentSessionAuthRefreshPayload = AgentSessionAuthRefreshPayloadV1;
export type AgentSessionAuthRefreshRecovery = AgentSessionAuthRefreshRecoveryV1;
export type AgentSessionAuthRefreshError = AgentSessionAuthRefreshErrorV1;

export type AgentSessionAuthRefreshRequest = Readonly<{
  serviceId: string;
  refreshAttemptId?: string;
  targetId?: string | null;
  selection?: AgentSessionAuthRefreshSelection;
  planType?: string | null;
  env?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  classification?: AgentSessionAuthRefreshClassification;
  failingAccessTokenFingerprint?: string | null;
  expectedCredentialRevision?: string | null;
  reason?: string | null;
}>;

export type AgentSessionMcpTransport =
  | Readonly<{ kind: 'http' | 'sse'; url: string }>
  | Readonly<{ kind: 'hosted' | 'stdio' }>;

export type AgentSessionMcpServer = Readonly<{
  id: string;
  name: string;
  transport: AgentSessionMcpTransport;
}>;

/**
 * Resolves launch-ready MCP server descriptors for this exact native Agent
 * session. This is distinct from the generic invocation MCP registry/client
 * service and from Session-handle MCP elicitation.
 */
export interface AgentSessionMcpService {
  resolveServers(options?: Readonly<{ signal?: AbortSignal }>): Promise<readonly AgentSessionMcpServer[]>;
}

export type AgentFeatureDecisionService = Readonly<{
  isEnabled(featureId: string): boolean;
}>;

export type AgentTerminalHostResolutionReason =
  | 'tmux_available'
  | 'tmux_forced'
  | 'tmux_unavailable'
  | 'tmux_unsupported_on_windows'
  | 'zellij_forced'
  | 'zellij_unavailable'
  | 'zellij_unavailable_tmux_fallback'
  | 'windows_console_available'
  | 'windows_console_forced'
  | 'windows_console_unavailable'
  | 'windows_zellij_unvalidated'
  | 'windows_arm64_unsupported'
  | 'no_host_available';

export type AgentTerminalHostResolveRequest = Readonly<{
  preference: TerminalHostPreference;
}>;

export type AgentTerminalHostResolveResult =
  | Readonly<{
      status: 'resolved';
      hostKind: TerminalHostKind;
      reason: AgentTerminalHostResolutionReason;
    }>
  | Readonly<{
      status: 'disabled';
      reason: AgentTerminalHostResolutionReason;
      message: string;
    }>;

export type AgentTerminalHostLaunchInput = Readonly<{
  kind: 'agent-cli';
  agentId: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  stdin?: string | Uint8Array;
}>;

export type AgentTerminalHostCreateOrAttachRequest = Readonly<{
  preference: TerminalHostPreference;
  sessionName: string;
  workingDirectory: string;
  launch: AgentTerminalHostLaunchInput;
  isolatedEnv: boolean;
}>;

export type AgentTerminalHostDisposeIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'plugin_deactivated' | 'host_shutdown' | 'runtime_recovery' | 'unspecified';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'session_closed';
    }>;

export type AgentTerminalHostService = Readonly<{
  resolve(request: AgentTerminalHostResolveRequest): Promise<AgentTerminalHostResolveResult>;
  createOrAttachHost(request: AgentTerminalHostCreateOrAttachRequest): Promise<TerminalHostHandle>;
  injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
  interruptTurn(handle: TerminalHostHandle): Promise<void>;
  evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLivenessV1>;
  captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState | null>;
  controlPort(handle: TerminalHostHandle): Promise<TerminalControlPort | null>;
  dispose(handle: TerminalHostHandle, intent: AgentTerminalHostDisposeIntent): Promise<void>;
}>;

export type AgentSessionModelOptionChoice = Readonly<{
  value: string | number | boolean | null;
  name: string;
  description?: string;
}>;

export type AgentSessionModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: string | number | boolean | null;
  options?: readonly AgentSessionModelOptionChoice[];
  /**
   * Producer-declared override rule (see {@link AgentModelOptionOverrideRule}). This runtime
   * mirror widens `currentValue` but must otherwise carry the same producer facts as the
   * catalog descriptor, or a runtime republication silently narrows what was published.
   */
  overridesWhenOn?: AgentModelOptionOverrideRule;
}>;

export type AgentSessionModel = Readonly<
  Omit<AgentModelDescriptor, 'modelOptions'> & {
    modelOptions?: readonly AgentSessionModelOption[];
    /**
     * Runtime-owned negative facts. The session-model publisher must omit these option ids even
     * when a persisted Provider/catalog descriptor contains richer facts for the same model.
     * This marker controls publication only and is never persisted as part of the model descriptor.
     */
    suppressedModelOptionIds?: readonly string[];
  }
>;

export type AgentSessionModelsSnapshot = Readonly<{
  models: readonly AgentSessionModel[] | null;
  currentModelId?: string | null;
}>;

export type AgentSessionModelsSource = Readonly<{
  read(): AgentSessionModelsSnapshot;
  subscribe(listener: (snapshot: AgentSessionModelsSnapshot) => void): Disposable;
}>;

export type AgentSessionModelsService = Readonly<{
  bind(source: AgentSessionModelsSource): Disposable;
}>;

export type AgentSessionInFlightConfigurationOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string }
  | { status: 'failed'; reason?: string }
>;

export type AgentSessionTerminalComposerClearOutcome =
  | Readonly<{ ok: true; status: 'cleared' | 'already_empty' }>
  | Readonly<{
      ok: false;
      status:
        | 'unsupported'
        | 'no_live_terminal'
        | 'not_safe'
        | 'generating'
        | 'dialog_open'
        | 'capture_unavailable'
        | 'clear_failed'
        | 'host_dead'
        | 'stale_state'
        | 'failed';
      errorCode?: string;
      error?: string;
    }>;

export type AgentSessionActiveInputBinding = Readonly<{
  isTurnInFlight(): boolean;
  canSteer(): boolean;
  canInterruptForPendingInput?(): boolean;
  onPromptQueued(): void;
  applyPermissionIntentDuringTurn(
    permissionIntent: AgentPermissionIntent,
  ): AgentSessionInFlightConfigurationOutcome | Promise<AgentSessionInFlightConfigurationOutcome>;
  clearTerminalComposer(
    request: Readonly<{ expectedStateAtMs?: number }>,
  ): AgentSessionTerminalComposerClearOutcome | Promise<AgentSessionTerminalComposerClearOutcome>;
  interruptPendingInputAndRun(
    request: Readonly<{ localId: string; expectedStateAtMs?: number }>,
  ): Promise<unknown> | unknown;
}>;

export type AgentSessionActiveInputStatus = Readonly<{
  steerAvailable: boolean;
  steerUnavailableReason: 'unsafe_window' | 'user_terminal_draft' | 'turn_settling' | null;
  stateUpdatedAtMs: number;
  terminalComposerDraftPresent: boolean;
  terminalComposerClearSupported: boolean;
  inFlightConfigurationApplySupported: boolean;
  pendingInputInterruptAndRunLocalId: string | null;
  pendingInputInterruptAndRunStateAt: number | null;
}>;

export type AgentSessionActiveInputService = Readonly<{
  bind(binding: AgentSessionActiveInputBinding): Disposable;
  publishStatus(status: AgentSessionActiveInputStatus): void;
}>;

export type AgentSessionWorkflowActivityService = Readonly<{
  /**
   * Publishes the canonical compact session-activity headlines; invalid JSON fails closed.
   *
   * ONE call carrying BOTH keys (`SessionActivityHeadlineBundleV1`), because they describe the same
   * committed run snapshots in two vocabularies. Two calls would mean two session-metadata
   * mutations per drain — double the write traffic on every progress tick, and a window in which
   * the two keys describe different worlds.
   */
  publishHeadlines(bundle: JsonValue): Promise<void>;
}>;

export type AgentToolExecutionBeforeRequest = Readonly<{
  turnId?: string;
  callId: string;
  name: string;
  input: JsonValue;
}>;

export type AgentToolExecutionBeforeResult = Readonly<
  | { status: 'continue'; input: JsonValue }
  | { status: 'rejected'; code?: string; message?: string }
  | { status: 'failed'; code: string }
>;

export type AgentToolExecutionService = Readonly<{
  before(
    request: AgentToolExecutionBeforeRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentToolExecutionBeforeResult>;
}>;

export type AgentSessionNativeToolDescriptor = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: JsonValue;
}>;

export type AgentSessionNativeToolBridgeConfig = Readonly<{
  v: 1;
  sessionId: string;
  directory: string;
  systemPrompt: string;
  tools: readonly AgentSessionNativeToolDescriptor[];
  launch: Readonly<{
    executablePath: string;
    argsPrefix: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>;
}>;

export type AgentSessionHappierToolsService = Readonly<{
  resolveNativeBridge(
    request: Readonly<{ systemPrompt?: string | null }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionNativeToolBridgeConfig>;
}>;

/**
 * Host capabilities bound to one live native Agent session. The host creates
 * this bag once for that session and retires it with the session or its
 * generation. It complements the operation-scoped `AgentRuntimeContext.services`
 * bag rather than duplicating it.
 */
export type AgentSessionHostServices = Readonly<{
  features: AgentFeatureDecisionService;
  terminalHost?: AgentTerminalHostService;
  models: AgentSessionModelsService;
  activeInput: AgentSessionActiveInputService;
  sessionHooks: AgentSessionHooksService;
  transcripts: AgentTranscriptSessionEventPublisher & Readonly<{
    fileFollow: AgentTranscriptFileFollowService;
  }>;
  accountUsage: AgentAccountUsageService;
  mcp: AgentSessionMcpService;
  workflowActivity: AgentSessionWorkflowActivityService;
  toolExecution: AgentToolExecutionService;
  happierTools?: AgentSessionHappierToolsService;
}>;

export type AgentSessionRuntimeContext = AgentRuntimeContext & Readonly<{
  session: Readonly<{
    id: string;
    services: AgentSessionHostServices;
  }>;
  workState: WorkStateService;
}>;

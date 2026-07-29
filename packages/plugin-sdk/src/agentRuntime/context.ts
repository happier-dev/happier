import type { AgentRuntimeFactoryContext, PluginInvocationContext } from '../invocation.js';
import type { PluginCurrentSessionWorkStateService } from '../services/sessions.js';
import type {
  AgentModelDescriptor,
  TerminalControlPort,
  TerminalHostHandle,
  TerminalHostKind,
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
  SessionSystemRecordKind,
  SessionSystemRecordNamespace,
} from '@happier-dev/protocol';
import type {
  AgentAccountUsageRecordKey,
  AgentAccountUsageSnapshot,
} from './accountUsage.js';

export type { AgentRuntimeFactoryContext } from '../invocation.js';

export type AgentRuntimeContext = PluginInvocationContext & Readonly<{
  agent: Readonly<{ id: string }>;
  protocols: AgentRuntimeProtocolComposers;
}>;

type AgentSessionHookProviderPayload = Readonly<Record<string, unknown>>;

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

type AgentSessionHookPluginDirCreateRequest = Readonly<{
  files: readonly AgentSessionHookPluginFile[];
}>;

type AgentSessionProviderTranscriptPublishRequest = Readonly<{
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

type AgentTranscriptFileFollowLine = Readonly<{
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

type AgentConnectedServiceId =
  | 'anthropic'
  | 'bitbucket'
  | 'claude-subscription'
  | 'gemini'
  | 'github'
  | 'openai'
  | 'openai-codex';

type AgentAccountUsageSourceContextInput = Readonly<{
  serviceId: AgentConnectedServiceId;
  env?: Readonly<Record<string, string | undefined>>;
}>;

type AgentAccountUsageSourceContext = Readonly<{
  serviceId: AgentConnectedServiceId;
  profileId: string;
  bindingKind: 'profile' | 'group_member';
  groupId?: string;
  groupGeneration?: number;
}>;

type AgentAccountUsageRecordSnapshotInput = Readonly<{
  snapshot: AgentAccountUsageSnapshot;
  /**
   * Evidence read after an already-surfaced hard failure. The host records it but must not
   * start predictive switching; the runtime-auth failure owner already owns recovery.
   */
  policyDisposition?: 'evidence_only';
  source?: AgentAccountUsageSourceContext | null;
  appliedIdentity?: Readonly<{
    serviceId: AgentConnectedServiceId;
    profileId: string;
    groupId: string | null;
    groupGeneration: number | null;
    providerAccountId: string;
    credentialFingerprint: string | null;
    observedAtMs: number;
  }> | null;
}>;

type AgentAccountUsageRecordSnapshotResult =
  | Readonly<{ status: 'recorded'; recordId: string; persisted?: boolean }>
  | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
  | Readonly<{ status: 'rejected'; reason: 'invalid_snapshot' | 'session_mismatch' | 'daemon_rejected' }>;

type AgentAccountUsageAdoptionProof =
  | Readonly<{ kind: 'opaque_local_credential_ref_match'; localCredentialRef: string }>
  | Readonly<{ kind: 'session_subject_match'; sessionId?: string | null }>
  | Readonly<{ kind: 'id_token_account_id'; issuer?: string }>
  | Readonly<{ kind: 'provider_account_id_match' }>
  | Readonly<{ kind: 'provider_owned_subject_proof'; detail?: string }>;

type AgentAccountUsageAdoptProvisionalRecordInput = Readonly<{
  adoption: Readonly<{
    fromRecordId: string;
    toRecordId: string;
    stableRecordKey: AgentAccountUsageRecordKey;
    proof: AgentAccountUsageAdoptionProof;
    observedAtMs: number;
  }>;
}>;

type AgentAccountUsageAdoptProvisionalRecordResult =
  | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string; persisted?: boolean }>
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

export type AgentSessionAuthRefreshRequest = Readonly<{
  serviceId: string;
  refreshAttemptId?: string;
  targetId?: string | null;
  selection?: unknown;
  planType?: string | null;
  env?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  classification?: unknown;
  failingAccessTokenFingerprint?: string | null;
  expectedCredentialRevision?: string | null;
  reason?: string | null;
}>;

export type AgentSessionAuthRefreshResult = Readonly<
  | { status: 'refreshed'; result?: unknown }
  | { status: 'unavailable'; reason: string; recovery?: unknown }
  | { status: 'failed'; reason: string; error?: unknown; runtimeAuthClassification?: unknown; recovery?: unknown }
  | { status: 'pending'; refreshAttemptId: string }
>;

export interface AgentSessionAuthService {
  refreshRuntimeAuth(
    request: AgentSessionAuthRefreshRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionAuthRefreshResult>;
}

export type AgentSessionMcpTransport =
  | Readonly<{ kind: 'http' | 'sse'; url: string }>
  | Readonly<{ kind: 'managed'; url?: string }>
  | Readonly<{ kind: 'hosted' | 'stdio' }>;

export type AgentSessionMcpServer = Readonly<{
  id: string;
  name: string;
  transport: AgentSessionMcpTransport;
}>;

export interface AgentSessionMcpService {
  resolveServers(options?: Readonly<{ signal?: AbortSignal }>): Promise<readonly AgentSessionMcpServer[]>;
}

type AgentFeatureDecisionService = Readonly<{
  isEnabled(featureId: string): boolean;
}>;

type AgentTerminalHostResolutionReason =
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

type AgentTerminalHostResolveRequest = Readonly<{
  preference: TerminalHostPreference;
}>;

type AgentTerminalHostResolveResult =
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

type AgentTerminalHostLaunchInput = Readonly<{
  kind: 'agent-cli';
  agentId: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  stdin?: string | Uint8Array;
}>;

type AgentTerminalHostCreateOrAttachRequest = Readonly<{
  preference: TerminalHostPreference;
  sessionName: string;
  workingDirectory: string;
  launch: AgentTerminalHostLaunchInput;
  isolatedEnv: boolean;
}>;

type AgentTerminalHostDisposeIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'plugin_deactivated' | 'host_shutdown' | 'runtime_recovery' | 'unspecified';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'session_closed';
    }>;

type AgentTerminalHostLiveness = Readonly<{
  paneAlive: boolean;
  probeInconclusive?: boolean;
  paneDead?: boolean;
  panePid?: number;
  paneCurrentCommand?: string;
  paneExitStatus?: number;
  paneScreenDumpCaptured?: boolean;
  paneScreenDumpTruncated?: boolean;
  paneScreenDumpError?: string;
  observedAt: number;
}>;

type AgentTerminalHostService = Readonly<{
  resolve(request: AgentTerminalHostResolveRequest): Promise<AgentTerminalHostResolveResult>;
  createOrAttachHost(request: AgentTerminalHostCreateOrAttachRequest): Promise<TerminalHostHandle>;
  injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult>;
  interruptTurn(handle: TerminalHostHandle): Promise<void>;
  evaluateLiveness(handle: TerminalHostHandle): Promise<AgentTerminalHostLiveness>;
  captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState | null>;
  controlPort(handle: TerminalHostHandle): Promise<TerminalControlPort | null>;
  dispose(handle: TerminalHostHandle, intent: AgentTerminalHostDisposeIntent): Promise<void>;
}>;

type AgentSessionModelOptionChoice = Readonly<{
  value: string | number | boolean | null;
  name: string;
  description?: string;
}>;

type AgentSessionModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: string | number | boolean | null;
  options?: readonly AgentSessionModelOptionChoice[];
}>;

type AgentSessionModel = Readonly<
  Omit<AgentModelDescriptor, 'modelOptions'> & {
    modelOptions?: readonly AgentSessionModelOption[];
  }
>;

type AgentSessionModelsSnapshot = Readonly<{
  models: readonly AgentSessionModel[] | null;
  currentModelId?: string | null;
}>;

type AgentSessionModelsSource = Readonly<{
  read(): AgentSessionModelsSnapshot;
  subscribe(listener: (snapshot: AgentSessionModelsSnapshot) => void): Disposable;
}>;

type AgentSessionModelsService = Readonly<{
  bind(source: AgentSessionModelsSource): Disposable;
}>;

type AgentSessionInFlightConfigurationOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string }
  | { status: 'failed'; reason?: string }
>;

type AgentSessionTerminalComposerClearOutcome =
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

type AgentSessionActiveInputBinding = Readonly<{
  isTurnInFlight(): boolean;
  canSteer(): boolean;
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

type AgentSessionActiveInputStatus = Readonly<{
  steerAvailable: boolean;
  steerUnavailableReason: 'unsafe_window' | 'user_terminal_draft' | 'turn_settling' | null;
  stateUpdatedAtMs: number;
  terminalComposerDraftPresent: boolean;
  terminalComposerClearSupported: boolean;
  inFlightConfigurationApplySupported: boolean;
  pendingInputInterruptAndRunLocalId: string | null;
  pendingInputInterruptAndRunStateAt: number | null;
}>;

type AgentSessionActiveInputService = Readonly<{
  bind(binding: AgentSessionActiveInputBinding): Disposable;
  publishStatus(status: AgentSessionActiveInputStatus): void;
}>;

type AgentSessionSystemRecordsService = Readonly<{
  write(request: Readonly<{
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    payload: JsonValue;
  }>): Promise<void>;
  read(request: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>): Promise<Readonly<{
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    localId: string;
    payload: JsonValue;
  }> | null>;
}>;

type AgentSessionWorkflowActivityService = Readonly<{
  /** Publishes only the canonical compact workflow headline; invalid JSON fails closed. */
  publishHeadline(headline: JsonValue): Promise<void>;
}>;

export type AgentSessionHostServices = Readonly<{
  features: AgentFeatureDecisionService;
  terminalHost?: AgentTerminalHostService;
  models: AgentSessionModelsService;
  activeInput: AgentSessionActiveInputService;
  sessionHooks: AgentSessionHooksService;
  transcripts: Readonly<{
    fileFollow: AgentTranscriptFileFollowService;
  }>;
  accountUsage: AgentAccountUsageService;
  auth: AgentSessionAuthService;
  mcp: AgentSessionMcpService;
  systemRecords: AgentSessionSystemRecordsService;
  workflowActivity: AgentSessionWorkflowActivityService;
}>;

export type AgentSessionRuntimeContext = AgentRuntimeContext & Readonly<{
  session: Readonly<{
    id: string;
    services: AgentSessionHostServices;
  }>;
  workState: PluginCurrentSessionWorkStateService;
}>;

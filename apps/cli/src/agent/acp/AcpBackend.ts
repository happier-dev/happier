/**
 * AcpBackend - Agent Client Protocol backend using official SDK
 *
 * This module provides a universal backend implementation using the official
 * @agentclientprotocol/sdk. Agent-specific behavior (timeouts, filtering,
 * error handling) is delegated to TransportHandler implementations.
 *
 * A.15.2 marker: runtime definition normalization belongs in
 * agent/acp/runtime/definition; this file remains the low-level ACP process
 * client and must not regain catalog/configured/plugin normalization logic.
 * F-ACP-5 deferral: the larger AcpBackend structural split is intentionally
 * left for a coordinated window; this slice only fixes launch/permission seams.
 */

import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import {
  RequestError,
  type SessionNotification,
  type RequestPermissionResponse,
  type InitializeResponse,
  type NewSessionRequest,
  type ForkSessionRequest,
  type LoadSessionRequest,
  type PromptRequest,
  type SetSessionModeRequest,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
  McpServerConfig,
} from '../core';
import type {
  AcpPromptSubmissionResult,
  CatalogAcpBackend,
} from './runtime/acpRuntimeBackendContract';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { logger } from '@/ui/logger';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { delay } from '@/utils/time';
import { createSubprocessStderrAppender, type BoundedTextFileAppender } from '@/agent/runtime/subprocessArtifacts';
import { createAcpStderrLogSummarizer } from './diagnostics/summarizeAcpStderrForLogs';
import packageJson from '../../../package.json';
import {
  type TransportHandler,
  type StderrContext,
  DefaultTransport,
} from '../transport';
import {
  type HandlerContext,
  type SessionUpdate,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './sessionUpdateHandlers';
import { LegacyAcpToolRuntime } from './toolCalls/legacy/runtime';
import type { MergedAcpToolResult } from './toolCalls/types';
import { withRetry } from './withRetry';
import { nodeToWebStreams } from './nodeToWebStreams';
import { buildAcpSpawnSpec } from './acpSpawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import type { AcpPermissionHandler } from './permissions/acpPermissionHandler';
import { AcpReplayCapture, type AcpReplayEvent } from './history/acpReplayCapture';
import { createAcpFilteredStdoutReadable, type DroppedStdoutLine } from './createAcpFilteredStdoutReadable';
import { createAcpNdJsonStream } from './createAcpNdJsonStream';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { buildTokenCountAgentMessageFromUsageObservation } from '@/usage/legacy/legacyUsageTransport';
import {
  buildAcpPromptUsageObservation,
  buildAcpSessionUpdateUsageObservation,
  buildAcpUsageUpdateObservation,
} from './usage/buildAcpUsageObservation';
import {
  buildInitializeRequest,
  createAcpClientFsMethods,
  isAcpFsEnabled,
} from './fs/acpClientFsMethods';
import {
  makeAbortError,
  resolveIdleWithoutAssistantMessageTimeoutMs,
  resolvePostPromptNoUpdatesTimeoutMs,
  resolvePostToolCallIdleTimeoutMs,
  resolvePromptLivenessTimeoutMs,
  resolveTurnHardCapTimeoutMs,
  resolveTurnInactivityTimeoutMs,
} from './timeouts/acpBackendTimeouts';
import type {
  SessionConfigOption,
  SessionModeState,
  SessionModel,
  SessionModelProjector,
  SessionModelState,
} from './sessionSettings/sessionSettingsState';
import {
  normalizeSessionConfigOptions,
  readSessionConfigOptionsFromSessionResponse,
  readSessionModeStateFromSessionResponse,
  readSessionModelStateFromSessionResponse,
} from './sessionSettings/sessionSettingsState';
import {
  provisionAcpBackendExecutionRunSession,
  readAcpBackendExecutionRunResumeSupport,
  subscribeAcpBackendExecutionRunMessages,
} from './executionRuns/hostRuntime';
import { createAcpClientHandlers } from './createAcpClientHandlers';
import {
  createAcpClientConnection,
  type AcpClientConnection,
} from './connection/createAcpClientConnection';
import type {
  AcpExtensionContextFactory,
  AcpExtensionRegistration,
} from './connection/types';
import { handleAcpSessionNotification } from './updates/handleSessionNotification';
import type { AcpTurnOutcome } from './turn/outcome';
import { mapStopReasonToAcpTurnOutcome, readPromptStopReason } from './turn/completion';
import { abortPendingAcpPermissionRequests } from './permissions/permissionFinalization';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export type { AcpPermissionHandler } from './permissions/acpPermissionHandler';
export { isAcpFsEnabled, buildInitializeRequest, createAcpClientFsMethods } from './fs/acpClientFsMethods';

type AcpPromptOptions = Readonly<{
  metadata?: Readonly<Record<string, unknown>>;
  localInputId?: string | null;
  localInputIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;
export type {
  SessionConfigOptionValueId,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionModel,
  SessionModelState,
} from './sessionSettings/sessionSettingsState';

/**
 * Retry configuration for ACP operations
 */
const RETRY_CONFIG = {
  /** Maximum number of retry attempts for init/newSession */
  maxAttempts: 3,
  /** Base delay between retries in ms */
  baseDelayMs: 1000,
  /** Maximum delay between retries in ms */
  maxDelayMs: 5000,
} as const;

const MAX_RECENT_STDERR_DIAGNOSTICS = 3;
const MAX_STARTUP_DIAGNOSTIC_CHARS = 1_200;
const MAX_AUTH_METHODS = 64;
const MAX_AUTH_METHOD_ID_CODE_UNITS = 256;
const MAX_INITIALIZE_METADATA_CODE_UNITS = 16_384;

// SessionNotification payload shape differs across ACP SDK versions (some use `update`, some use `updates[]`).
// We normalize dynamically in `handleSessionUpdate` and avoid relying on the SDK type here.
type MutableSessionNotificationEnvelope = Omit<SessionNotification, 'update'> & {
  update?: unknown;
  updates?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isPromptTurnSessionUpdateType(sessionUpdateType: string | undefined): boolean {
  return sessionUpdateType === 'user_message_chunk'
    || sessionUpdateType === 'agent_message_chunk'
    || sessionUpdateType === 'agent_thought_chunk'
    || sessionUpdateType === 'tool_call'
    || sessionUpdateType === 'tool_call_update'
    || sessionUpdateType === 'plan';
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function truncateStartupDiagnostic(value: string): string {
  const trimmed = redactBugReportSensitiveText(String(value ?? '').trim());
  if (trimmed.length <= MAX_STARTUP_DIAGNOSTIC_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_STARTUP_DIAGNOSTIC_CHARS)}...`;
}

export type AcpAuthenticationSelection = Readonly<{
  methodId: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type AcpAuthenticationSelector = (context: Readonly<{
  advertisedMethodIds: readonly string[];
  initializeMetadata: Readonly<Record<string, unknown>> | null;
}>) => AcpAuthenticationSelection | null | Promise<AcpAuthenticationSelection | null>;

export type AcpSetModelResponseProjector = (input: Readonly<{
  response: unknown;
  requestedModelId: string;
  requestMeta: Readonly<Record<string, unknown>> | null;
  targetModel: SessionModel;
}>) => SessionModel | null;

function readAdvertisedAuthMethodIds(initResponse: InitializeResponse): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const methods = Array.isArray(initResponse.authMethods) ? initResponse.authMethods : [];
  for (const method of methods) {
    if (output.length >= MAX_AUTH_METHODS) break;
    const record = asRecord(method);
    const id = record ? getString(record, 'id')?.trim() : undefined;
    if (!id || id.length > MAX_AUTH_METHOD_ID_CODE_UNITS || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return Object.freeze(output);
}

function readBoundedInitializeMetadata(initResponse: InitializeResponse): Readonly<Record<string, unknown>> | null {
  const candidate = asRecord(initResponse)?.['_meta'];
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(candidate);
  if (!parsed.success) return null;
  const record = asRecord(parsed.data);
  if (!record || JSON.stringify(record).length > MAX_INITIALIZE_METADATA_CODE_UNITS) return null;
  return Object.freeze({ ...record });
}

function validateAuthenticationSelection(
  selection: AcpAuthenticationSelection,
  advertisedMethodIds: readonly string[],
): AcpAuthenticationSelection {
  const methodId = typeof selection.methodId === 'string' ? selection.methodId.trim() : '';
  if (!methodId || methodId.length > MAX_AUTH_METHOD_ID_CODE_UNITS) {
    throw new Error('[AcpBackend] ACP authentication selector returned an invalid method id');
  }
  if (!advertisedMethodIds.includes(methodId)) {
    throw new Error(`[AcpBackend] ACP agent does not advertise auth method '${methodId}'`);
  }
  const metadata = selection.metadata;
  if (metadata === undefined) return Object.freeze({ methodId });
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(metadata);
  const record = parsed.success ? asRecord(parsed.data) : null;
  if (!record || JSON.stringify(record).length > MAX_INITIALIZE_METADATA_CODE_UNITS) {
    throw new Error('[AcpBackend] ACP authentication selector returned invalid metadata');
  }
  return Object.freeze({ methodId, metadata: Object.freeze({ ...record }) });
}

/**
 * Configuration for AcpBackend
 */
export interface AcpBackendOptions {
  /** Agent name for identification */
  agentName: string;

  /** Working directory for the agent */
  cwd: string;

  /** Command to spawn the ACP agent */
  command: string;

  /** Arguments for the agent command */
  args?: string[];

  /** Environment variables to pass to the agent */
  env?: NodeJS.ProcessEnv;

  /** Environment variable names to remove from the final child environment */
  unsetEnv?: readonly string[];

  /** Runner-private final child-launch substitution seam. */
  transformAgentChildLaunchEnvironment?: (
    environment: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Optional per-backend ACP fs capability override */
  fsEnabled?: boolean;

  /** Transport handler for agent-specific behavior (timeouts, filtering, etc.) */
  transportHandler?: TransportHandler;

  /** Optional callback to check if prompt has change_title instruction */
  hasChangeTitleInstruction?: (prompt: string) => boolean;

  /**
   * Optional ACP authentication method to invoke after `initialize`, before `newSession` / `loadSession`.
   *
   * This is primarily used by agents like Codex ACP that advertise auth methods but do not auto-authenticate
   * from environment variables until the `authenticate` method is called.
   */
  authMethodId?: string;

  /** Optional ACP authenticate metadata forwarded as `_meta`. */
  authMeta?: Record<string, unknown>;

  /** Selects authentication from the final bounded initialize response. */
  authSelector?: AcpAuthenticationSelector;

  /** Whether the ACP agent should advertise its parameterized model picker. */
  parameterizedModelPicker?: boolean;

  /** Provider-owned pure augmentation of normalized ACP model metadata. */
  projectModel?: SessionModelProjector;

  /** Provider-owned projection for non-standard prompt usage fields and accounting semantics. */
  projectPromptUsage?: (input: Readonly<{
    usage: unknown;
    promptResponse: unknown;
  }>) => unknown;

  /** Private child-host seam that awaits a complete projected model snapshot. */
  prepareSessionModels?: (
    sessionResponse: unknown,
  ) => Promise<SessionModelState | null>;

  /** Provider-owned interpretation of an acknowledged legacy set-model response without standard model state. */
  projectSetModelResponse?: AcpSetModelResponseProjector;

  /** Private child-host seam for an awaitable acknowledged legacy set-model projection. */
  projectSetModelResponseAwaitable?: (
    input: Parameters<AcpSetModelResponseProjector>[0],
  ) => Promise<SessionModel | null>;

  /** Private child-host seam that awaits provider-owned tool projection before canonical handling. */
  prepareToolUpdate?: (
    update: SessionUpdate,
    context: Readonly<{ toolCallCountSincePrompt: number }>,
  ) => Promise<SessionUpdate | null>;

  /** Host-owned raw `session/prompt` transform immediately before ACP dispatch. */
  transformPromptRequest?: (
    request: PromptRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<PromptRequest>;

  /** Closed custom ACP methods registered on the canonical client connection. */
  extensions?: ReadonlyArray<AcpExtensionRegistration>;

  /** Runtime-scoped context factory for custom ACP methods. */
  createExtensionContext?: AcpExtensionContextFactory;

  /** Observes the subprocess terminal fact without taking lifecycle ownership from the caller. */
  onProcessExit?: (exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;

  /** Observes only accumulator-owned terminal result publications. */
  onPublishedTerminalToolResult?: (result: MergedAcpToolResult) => void;
}

/**
 * ACP backend using the official @agentclientprotocol/sdk
 */
export class AcpBackend implements CatalogAcpBackend, ExecutionRunHostRuntime {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private stderrAppender: BoundedTextFileAppender | null = null;
  private recentStderrDiagnostics: string[] = [];
  private lastProcessExitDetail: string | null = null;
  private readonly summarizeStderrForLogs = createAcpStderrLogSummarizer();
  private readonly sessionUpdateShapeLogger = createEventShapeLoggerForLog({ logger, scope: 'acp-backend' });
  private connection: AcpClientConnection | null = null;
  private acpSessionId: string | null = null;
  private acceptsImageInput = false;
  private disposed = false;
  private replayCapture: AcpReplayCapture | null = null;
  /** Sole legacy ACP tool lifecycle owner. */
  private readonly toolCalls: LegacyAcpToolRuntime;
  /** Pending permission requests that need response */
  private pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();

  /** Map from permission request ID to real tool call ID for tracking */
  private permissionToToolCallMap = new Map<string, string>();

  /** Cache last selected permission option per tool call id (handles duplicate permission prompts) */
  private lastSelectedPermissionOptionIdByToolCallId = new Map<string, string>();

  /** Track if we just sent a prompt with change_title instruction */
  private recentPromptHadChangeTitle = false;

  private sessionModeState: SessionModeState | null = null;
  private sessionModelState: SessionModelState | null = null;
  private sessionConfigOptionsState: ReadonlyArray<SessionConfigOption> | null = null;

  getSessionModeState(): SessionModeState | null {
    return this.sessionModeState;
  }

  getSessionModelState(): SessionModelState | null {
    return this.sessionModelState;
  }

  getSessionConfigOptionsState(): ReadonlyArray<SessionConfigOption> | null {
    return this.sessionConfigOptionsState;
  }

  getLastTurnOutcome(): AcpTurnOutcome | null {
    return this.lastTurnOutcome;
  }

  supportsImagePrompts(): boolean {
    return this.acceptsImageInput;
  }

  private settlePendingPromptSubmissionEffect(
    turnGeneration: number,
    acceptanceKind: 'transport_write' | 'correlated_provider_effect',
  ): boolean {
    if (
      !this.pendingPromptSubmissionEffectResolver
      || this.pendingPromptSubmissionTurnGeneration !== turnGeneration
    ) {
      return false;
    }
    const resolveProviderEffect = this.pendingPromptSubmissionEffectResolver;
    this.pendingPromptSubmissionAcceptanceKind = acceptanceKind;
    this.pendingPromptSubmissionEffectResolver = null;
    this.pendingPromptSubmissionTurnGeneration = null;
    resolveProviderEffect();
    return true;
  }

  private observeAcpTransportMessageWritten(message: unknown): void {
    const record = asRecord(message);
    if (record?.method !== 'session/prompt') return;
    const params = asRecord(record.params);
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
    if (!sessionId) return;
    const waiterIndex = this.promptTransportWriteWaiters.findIndex(
      (waiter) => waiter.sessionId === sessionId,
    );
    if (waiterIndex < 0) return;
    const [waiter] = this.promptTransportWriteWaiters.splice(waiterIndex, 1);
    waiter?.resolve();
  }

  private createAcpPromptTransportWriteReceipt(sessionId: string): Readonly<{
    written: Promise<void>;
    cancel: () => void;
  }> {
    let waiter!: { sessionId: string; resolve: () => void };
    const written = new Promise<void>((resolve) => {
      waiter = { sessionId, resolve };
      this.promptTransportWriteWaiters.push(waiter);
    });
    return {
      written,
      cancel: () => {
        const index = this.promptTransportWriteWaiters.indexOf(waiter);
        if (index >= 0) this.promptTransportWriteWaiters.splice(index, 1);
      },
    };
  }

  /** Host-private sink for provider evidence correlated by the public session owner. */
  submitCompletionEvidence(outcome: Readonly<{
    kind: 'completed' | 'cancelled' | 'failed';
    message?: string;
  }>): boolean {
    if (this.disposed || !this.waitingForResponse || this.isCurrentTurnGenerationClosed()) {
      return false;
    }
    const failureMessage = outcome.kind === 'failed'
      ? redactBugReportSensitiveText(outcome.message ?? 'Provider reported prompt failure').trim().slice(0, 1_024)
      : '';
    this.settlePendingPromptSubmissionEffect(this.turnGeneration, 'correlated_provider_effect');
    this.finalizeTurnOutcome(
      outcome.kind === 'completed'
        ? { kind: 'completed', stopReason: 'end_turn' }
        : outcome.kind === 'cancelled'
          ? { kind: 'aborted', stopReason: 'cancelled' }
          : { kind: 'failed', error: new Error(failureMessage || 'Provider reported prompt failure') },
    );
    return true;
  }

  /** Track tool calls count since last prompt (to identify first tool call) */
  private toolCallCountSincePrompt = 0;
  /** Timeout for emitting 'idle' status after last message chunk */
  private idleTimeout: NodeJS.Timeout | null = null;
  private turnGeneration = 0;
  private closedTurnGeneration: number | null = null;
  private pendingTurnOutcome: AcpTurnOutcome | null = null;
  private lastTurnOutcome: AcpTurnOutcome | null = null;
  private turnHardCapTimeout: NodeJS.Timeout | null = null;
  private turnInactivityTimeout: NodeJS.Timeout | null = null;
  private turnInactivityTimeoutMs: number | null = null;
  private permissionFlushTurnGeneration: number | null = null;
  private prePromptResponseUpdateGuard: 'none' | 'completed' | 'terminal' = 'none';
  private dropPromptTurnUpdatesUntilPromptResponse = false;
  private pendingPromptResponseTurnGeneration: number | null = null;
  private rawPromptRequest: Promise<unknown> | null = null;
  private rawPromptRequestTurnGeneration: number | null = null;
  private idleStatusDeferredUntilPromptResponse = false;

  /** Transport handler for agent-specific behavior */
  private readonly transport: TransportHandler;

  constructor(private options: AcpBackendOptions) {
    this.transport = options.transportHandler ?? new DefaultTransport(options.agentName);
    this.toolCalls = new LegacyAcpToolRuntime({
      sessionId: () => this.acpSessionId ?? 'acp-session-uninitialized',
      turnId: () => `legacy-turn:${this.turnGeneration}`,
      sidechainId: null,
      emit: (message) => this.emit(message),
      transport: this.transport,
      onBecameActive: () => {
        if (this.idleTimeout) {
          clearTimeout(this.idleTimeout);
          this.idleTimeout = null;
        }
        this.emit({ type: 'status', status: 'running' });
      },
      onBecameIdle: () => this.scheduleIdleStatusAfterToolCompletion(),
      ...(options.onPublishedTerminalToolResult
        ? { onPublishedTerminalResult: options.onPublishedTerminalToolResult }
        : {}),
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  } 

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  async readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean> {
    return readAcpBackendExecutionRunResumeSupport(this, opts);
  }

  async provisionSession(
    opts?: ExecutionRunSessionProvisionOptions,
  ): Promise<ExecutionRunSessionProvisionResult> {
    return await provisionAcpBackendExecutionRunSession(this, opts);
  }

  subscribeMessages(handler: ExecutionRunHostRuntimeMessageHandler): () => void {
    return subscribeAcpBackendExecutionRunMessages(this, handler);
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[AcpBackend] Error in message handler:', error);
      }
    }
  }

  private recordStderrDiagnostic(summary: string): void {
    const diagnostic = truncateStartupDiagnostic(summary);
    if (!diagnostic) return;
    this.recentStderrDiagnostics = [
      ...this.recentStderrDiagnostics,
      diagnostic,
    ].slice(-MAX_RECENT_STDERR_DIAGNOSTICS);
  }

  private buildStartupFailureDiagnosticSuffix(): string {
    const parts: string[] = [];
    if (this.lastProcessExitDetail) {
      parts.push(`process exit: ${this.lastProcessExitDetail}`);
    }
    if (this.recentStderrDiagnostics.length > 0) {
      parts.push(`recent stderr: ${this.recentStderrDiagnostics.join(' | ')}`);
    }
    if (this.stderrAppender?.path) {
      parts.push(`stderr artifact: ${this.stderrAppender.path}`);
    }
    if (parts.length === 0) return '';
    return ` (${parts.map(truncateStartupDiagnostic).join('; ')})`;
  }

  private createStartupTimeoutError(operation: string, timeoutMs: number): Error {
    return new Error(
      `${operation} timeout after ${timeoutMs}ms - ${this.transport.agentName} did not respond${this.buildStartupFailureDiagnosticSuffix()}`,
    );
  }

  private buildAcpMcpServersForSessionRequest(): NewSessionRequest['mcpServers'] {
    if (!this.options.mcpServers) return [] as unknown as NewSessionRequest['mcpServers'];
    const mcpServers = Object.entries(this.options.mcpServers).map(([name, config]) => ({
      name,
      command: config.command,
      args: config.args || [],
      env: config.env
        ? Object.entries(config.env).map(([envName, envValue]) => ({ name: envName, value: envValue }))
        : [],
    }));
    return mcpServers as unknown as NewSessionRequest['mcpServers'];
  }

  private buildSpawnEnv(): NodeJS.ProcessEnv {
    const environment = finalizeSessionChildEnvironment({
      environment: buildScopedProcessEnv({
        baseEnv: process.env,
        explicitEnv: this.options.env,
        unsetEnvKeys: this.options.unsetEnv,
      }),
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    });
    if (!this.options.transformAgentChildLaunchEnvironment) {
      return environment;
    }
    return this.options.transformAgentChildLaunchEnvironment(
      Object.freeze(Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string',
        ),
      )),
    );
  }

  private async cleanupInitializedProcessConnection(params: { graceMs: number }): Promise<void> {
    const proc = this.process;
    const connection = this.connection;
    this.process = null;
    this.connection = null;
    this.acpSessionId = null;
    this.acceptsImageInput = false;

    connection?.close(undefined, { timeoutMs: params.graceMs });

    try {
      await this.stderrAppender?.close();
    } catch {
      // best-effort cleanup
    } finally {
      this.stderrAppender = null;
    }
    if (proc) {
      try {
        await killProcessTree(proc, { graceMs: params.graceMs });
      } catch {
        // best-effort cleanup
      }
    }

    await connection?.closed.catch(() => undefined);
  }

  private async createConnectionAndInitialize(params: { operationId: string }): Promise<{ initTimeout: number }> {
    logger.debug(`[AcpBackend] Starting process + initializing connection (op=${params.operationId})`);

    if (this.process || this.connection) {
      throw new Error('ACP backend is already initialized');
    }

    try {
      // Spawn the ACP agent process.
      // Use cross-spawn so Windows quoting/.cmd resolution is handled safely without joining args.
      const spec = buildAcpSpawnSpec({
        command: this.options.command,
        args: this.options.args || [],
        cwd: this.options.cwd,
        env: this.buildSpawnEnv(),
      });

      this.recentStderrDiagnostics = [];
      this.lastProcessExitDetail = null;

	    this.process = spawn(spec.command, spec.args, spec.options);

	    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
	      throw new Error('Failed to create stdio pipes');
	    }

	    // Best-effort stderr artifact capture for diagnostics.
	    try {
	      this.stderrAppender?.close().catch(() => {});
	      this.stderrAppender = await createSubprocessStderrAppender({
	        agentName: this.options.agentName,
	        pid: typeof this.process.pid === 'number' ? this.process.pid : null,
	        label: 'acp',
	      });
	    } catch (error) {
	      logger.debug('[AcpBackend] Failed to create stderr artifact appender (non-fatal)', error);
	      this.stderrAppender = null;
	    }

	    // Handle stderr output via transport handler
	    this.process.stderr.on('data', (data: Buffer) => {
	      const text = data.toString();
	      if (!text.trim()) return;

	      this.stderrAppender?.append(text);

	      // Build context for transport handler
	      const activeToolCallIds = this.activeToolCallIds();
	      const hasActiveInvestigation = this.transport.isInvestigationTool
	        ? Array.from(activeToolCallIds).some(id => this.transport.isInvestigationTool!(id))
	        : false;

      const context: StderrContext = {
        activeToolCalls: activeToolCallIds,
        hasActiveInvestigation,
      };

      const stderrResult = this.transport.handleStderr?.(text, context) ?? null;
      const stderrSummary = stderrResult?.suppress ? null : this.summarizeStderrForLogs(text);
      if (stderrSummary) {
        this.recordStderrDiagnostic(stderrSummary);
        logger.debug(
          hasActiveInvestigation
            ? `[AcpBackend] 🔍 Agent stderr (during investigation): ${stderrSummary}`
            : `[AcpBackend] Agent stderr: ${stderrSummary}`,
        );
      }

      // Let transport handler process stderr and optionally emit messages
      if (stderrResult?.message) {
        this.emit(stderrResult.message);
        // If the transport surfaces a fatal error via a status message, record it as the response
        // completion error. This must not depend on `waitingForResponse` because idle/cancel signals
        // can race with stderr delivery (especially under parallel load).
        if (stderrResult.message.type === 'status' && stderrResult.message.status === 'error') {
          const detail =
            typeof stderrResult.message.detail === 'string' && stderrResult.message.detail.trim()
              ? stderrResult.message.detail
              : 'ACP transport reported an error';
          this.failPendingResponseWait(new Error(detail));
        }
      }
    });

    this.process.on('error', (err) => {
      // Log to file only, not console
      logger.debug(`[AcpBackend] Process error:`, err);
      this.failPendingResponseWait(err instanceof Error ? err : new Error(String(err)));
      this.emit({ type: 'status', status: 'error', detail: err.message });
    });

	    this.process.on('exit', (code, signal) => {
	      const hasSignal = typeof signal === 'string' && signal.trim().length > 0;
	      const hasNonZeroCode = typeof code === 'number' && Number.isFinite(code) && code !== 0;
	      const hasUnknownExit = code === null && !hasSignal;

	      if (!this.disposed && (hasSignal || hasNonZeroCode || hasUnknownExit)) {
	        logger.debug(`[AcpBackend] Process exited with code ${code}, signal ${signal}`);
	        const detail = hasSignal ? `Signal: ${signal}` : `Exit code: ${typeof code === 'number' ? code : 1}`;
	        this.lastProcessExitDetail = detail;
	        this.failPendingResponseWait(new Error(detail));
	        this.emit({ type: 'status', status: 'error', detail });
	      }

	      if (!this.disposed) {
	        this.options.onProcessExit?.({ code, signal });
	      }

	      void this.stderrAppender?.close().catch(() => {});
	      this.stderrAppender = null;
	    });

    // Create Web Streams from Node streams
    const streams = nodeToWebStreams(
      this.process.stdin,
      this.process.stdout
    );
    const writable = streams.writable;
    const readable = streams.readable;

    const transport = this.transport;

    const droppedStdoutCapture = (() => {
      if (!isTruthyEnv(process.env.HAPPIER_ACP_CAPTURE_IO)) return null;
      const traceFile = (process.env.HAPPIER_STACK_TOOL_TRACE_FILE ?? '').toString().trim();
      const baseDir = traceFile ? dirname(traceFile) : null;
      if (!baseDir) return null;

      const maxBytesRaw = (process.env.HAPPIER_ACP_CAPTURE_DROPPED_MAX_BYTES ?? '').toString().trim();
      const maxBytes = (() => {
        const n = Number(maxBytesRaw);
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 2_000_000;
      })();

      try {
        const stream = createWriteStream(join(baseDir, 'acp.stdout.dropped.jsonl'), { flags: 'a' });
        let written = 0;
        stream.on('error', (error) => {
          logger.debug('[AcpBackend] Ignoring dropped-stdout capture stream error', error);
        });
        return {
          write: (entry: DroppedStdoutLine) => {
            if (written >= maxBytes) return;
            const payload = JSON.stringify({ ts: Date.now(), ...entry });
            const next = payload + '\n';
            written += Buffer.byteLength(next, 'utf8');
            try {
              stream.write(next);
            } catch {
              // ignore capture failures
            }
          },
          close: () => {
            try {
              stream.end();
            } catch {
              // ignore
            }
          },
        } as const;
      } catch (error) {
        logger.debug('[AcpBackend] Failed to set up dropped-stdout capture', error);
        return null;
      }
    })();

    const maxMultilineBytesRaw = (process.env.HAPPIER_ACP_MULTILINE_JSON_MAX_BYTES ?? '').toString().trim();
    const maxMultilineBytes = (() => {
      const n = Number(maxMultilineBytesRaw);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
    })();

    let filteredCount = 0;
    const filteredReadable = createAcpFilteredStdoutReadable({
      readable,
      transport,
      onDroppedLine: (entry) => {
        filteredCount++;
        droppedStdoutCapture?.write(entry);

        // Some ACP agents incorrectly emit error output to stdout (instead of stderr), which gets
        // filtered out as non-JSON and can otherwise leave the UI "stuck" with no visible failure.
        // Best-effort: classify error-like dropped stdout lines during an in-flight prompt turn and
        // surface them as status:error + a rejected waitForResponseComplete().
        if (this.waitingForResponse && !this.responseCompletionError && entry.reason === 'transport_filter_null') {
          const raw = entry.line;
          const trimmed = raw.trim();
          if (trimmed) {
            const context: StderrContext = {
              activeToolCalls: this.activeToolCallIds(),
              hasActiveInvestigation: this.transport.isInvestigationTool
                ? Array.from(this.activeToolCallIds()).some((id) => this.transport.isInvestigationTool!(id))
                : false,
            };

            const transportResult = this.transport.handleStderr?.(raw, context);
            const transportMessage = transportResult?.message ?? null;
            if (transportMessage) {
              this.emit(transportMessage);
              if (transportMessage.type === 'status' && transportMessage.status === 'error') {
                const detailRaw =
                  typeof transportMessage.detail === 'string' && transportMessage.detail.trim()
                    ? transportMessage.detail
                    : trimmed;
                const detail = redactBugReportSensitiveText(detailRaw);
                this.failPendingResponseWait(new Error(detail));
              }
              return;
            }

            const analysisText = trimmed.length > 5000 ? trimmed.slice(0, 5000) : trimmed;
            const lower = analysisText.toLowerCase();
            const looksLikeError =
              lower.startsWith('error') ||
              lower.includes('error:') ||
              lower.includes('exception') ||
              lower.includes('traceback') ||
              lower.includes('invalid_request') ||
              lower.includes('invalid request') ||
              lower.includes('unauthorized') ||
              lower.includes('forbidden') ||
              lower.includes('permission denied') ||
              (/\b(4\d\d|5\d\d)\b/.test(lower) &&
                (lower.includes('http') || lower.includes('status') || lower.includes('error') || lower.includes('request'))) ||
              (lower.includes('exceeds') && lower.includes('bytes') && trimmed.includes('>'));
            if (!looksLikeError) return;

            const redacted = redactBugReportSensitiveText(trimmed);
            const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
            this.emit({ type: 'status', status: 'error', detail });
            this.failPendingResponseWait(new Error(detail));
          }
        }
      },
      onDone: () => {
        if (filteredCount > 0) {
          logger.debug(
            `[AcpBackend] Filtered out ${filteredCount} non-JSON/malformed lines from ${transport.agentName} stdout`,
          );
        }
        droppedStdoutCapture?.close();
      },
      maxMultilineBytes,
    });

    // Create ndJSON stream for ACP
    const stream = createAcpNdJsonStream(writable, filteredReadable, {
      onMessageWritten: (message) => {
        this.observeAcpTransportMessageWritten(message);
      },
    });

    const clientHandlers = createAcpClientHandlers({
      onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
      transport: this.transport,
      emit: (message) => this.emit(message),
      permissionHandler: this.options.permissionHandler,
      createHandlerContext: () => this.createHandlerContext(),
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
        toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      }),
      getActiveSessionId: () => this.acpSessionId,
      cancel: async (sessionId) => this.cancel(sessionId),
      emitPermissionResponse: async (requestId, approved) => {
        logger.debug(`[AcpBackend] Permission response event (UI only): ${requestId} = ${approved}`);
        this.emit({ type: 'permission-response', id: requestId, approved });
      },
      clearTrackedToolCall: (toolCallId, reason) => this.clearTrackedToolCall(toolCallId, reason),
      incrementToolCallCountSincePrompt: () => {
        this.toolCallCountSincePrompt++;
      },
      toolCalls: this.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: this.lastSelectedPermissionOptionIdByToolCallId,
    });

    const fsEnabled = this.options.fsEnabled ?? isAcpFsEnabled();
    if (fsEnabled) {
      Object.assign(
        clientHandlers,
        createAcpClientFsMethods({
          cwd: this.options.cwd,
          permissionHandler: this.options.permissionHandler,
        })
      );
    }

    this.connection = createAcpClientConnection({
      name: 'happier-cli',
      transport: stream,
      handlers: clientHandlers,
      ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      ...(this.options.createExtensionContext
        ? { createExtensionContext: this.options.createExtensionContext }
        : {}),
    });

    // Initialize the connection with timeout and retry
    const initRequest = buildInitializeRequest({
      clientName: 'happier-cli',
      clientVersion: packageJson.version,
      fsEnabled,
      ...(typeof this.options.parameterizedModelPicker === 'boolean'
        ? { parameterizedModelPicker: this.options.parameterizedModelPicker }
        : {}),
    });

    // Some ACP agents (notably Gemini CLI) can swallow early stdin before their ACP
    // stdio bridge is ready. Waiting briefly avoids poisoning the channel.
    const initDelay = (() => {
      const raw = this.transport.getInitDelayMs?.();
      return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    })();
    if (initDelay > 0) {
      logger.debug(`[AcpBackend] Waiting ${initDelay}ms before initialize (${this.transport.agentName})...`);
      await delay(initDelay);
    }

    const initTimeout = this.transport.getInitTimeout();
    logger.debug(`[AcpBackend] Initializing connection (timeout: ${initTimeout}ms)...`);

    const initResponse = await withRetry(
      async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
          const result = await Promise.race([
            this.connection!.peer.initialize(initRequest).then((res) => {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
              return res;
            }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(this.createStartupTimeoutError('Initialize', initTimeout));
              }, initTimeout);
            }),
          ]);
          return result;
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      },
      {
        operationName: 'Initialize',
        maxAttempts: RETRY_CONFIG.maxAttempts,
        baseDelayMs: RETRY_CONFIG.baseDelayMs,
        maxDelayMs: RETRY_CONFIG.maxDelayMs,
      }
    );

    logger.debug(`[AcpBackend] Initialize completed`);

    const agentCapabilities = asRecord((initResponse as InitializeResponse).agentCapabilities);
    const promptCapabilities = asRecord(agentCapabilities?.promptCapabilities);
    this.acceptsImageInput = promptCapabilities?.image === true;

    const advertisedMethodIds = readAdvertisedAuthMethodIds(initResponse);
    const staticAuthMethodId = typeof this.options.authMethodId === 'string'
      ? this.options.authMethodId.trim()
      : '';
    const selectedAuth = this.options.authSelector
      ? await this.options.authSelector(Object.freeze({
          advertisedMethodIds,
          initializeMetadata: readBoundedInitializeMetadata(initResponse),
        }))
      : staticAuthMethodId
        ? { methodId: staticAuthMethodId, ...(this.options.authMeta ? { metadata: this.options.authMeta } : {}) }
        : null;
    if (selectedAuth) {
      const authentication = validateAuthenticationSelection(selectedAuth, advertisedMethodIds);

      logger.debug(`[AcpBackend] Authenticating with methodId=${authentication.methodId}...`);
      await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.peer.authenticate({
                methodId: authentication.methodId,
                ...(authentication.metadata ? { _meta: authentication.metadata } : {}),
              }).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(this.createStartupTimeoutError('Authenticate', initTimeout));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'Authenticate',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        },
      );
      logger.debug(`[AcpBackend] Authenticate completed`);
    }

    return { initTimeout };
  } catch (error) {
    logger.debug('[AcpBackend] Initialization failed; cleaning up process/connection', error);
    await this.cleanupInitializedProcessConnection({ graceMs: 250 });
    throw error;
  }
}

  async startSession(): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCalls.reset();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      // Create a new session with retry
      const newSessionRequest: NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest(),
        ...(typeof this.options.parameterizedModelPicker === 'boolean'
          ? { _meta: { parameterizedModelPicker: this.options.parameterizedModelPicker } }
          : {}),
      };

      logger.debug(`[AcpBackend] Creating new session...`);

      const sessionResponse = await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.peer.newSession(newSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(this.createStartupTimeoutError('New session', initTimeout));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'NewSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );
      const sessionId = readNonBlankOpaqueIdentifier(sessionResponse.sessionId);
      if (!sessionId) {
        throw new Error('New session response did not include a session id');
      }
      this.acpSessionId = sessionId;
      logger.debug(`[AcpBackend] Session created: ${sessionId}`);

      this.seedSessionModesFromSessionResponse(sessionResponse);
      await this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();

      return { sessionId };

    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpBackend] Error starting session:', error);
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: error instanceof Error ? error.message : String(error) 
      });
      await this.cleanupInitializedProcessConnection({ graceMs: 250 });
      throw error;
    }
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const normalized = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalized) {
      throw new Error('Session ID is required');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCalls.reset();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });
      const sessionResponse = await this.loadSessionOnCurrentConnection(normalized, initTimeout);

      this.acpSessionId = normalized;
      logger.debug(`[AcpBackend] Session loaded: ${normalized}`);

      this.seedSessionModesFromSessionResponse(sessionResponse);
      await this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();
      return { sessionId: normalized };
    } catch (error) {
      logger.debug('[AcpBackend] Error loading session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error)
      });
      await this.cleanupInitializedProcessConnection({ graceMs: 250 });
      throw error;
    }
  }

  async loadSessionWithReplayCapture(sessionId: SessionId): Promise<StartSessionResult & { replay: AcpReplayEvent[] }> {
    this.replayCapture = new AcpReplayCapture();
    try {
      const result = await this.loadSession(sessionId);
      const replay = this.replayCapture.finalize();
      return { ...result, replay };
    } finally {
      this.replayCapture = null;
    }
  }

  /**
   * Fork an existing session using ACP session/fork (UNSTABLE).
   *
   * This is only available when the agent advertises session.fork; callers should
   * treat failures as "not supported" and fall back to other mechanisms.
   */
  async forkSession(params: Readonly<{ sessionId: SessionId; cwd?: string }>): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const normalized = readNonBlankOpaqueIdentifier(params.sessionId) ?? '';
    if (!normalized) {
      throw new Error('Session ID is required');
    }

    this.emit({ type: 'status', status: 'starting' });

    try {
      if (!this.connection) {
        await this.createConnectionAndInitialize({ operationId: randomUUID() });
      }
      const connection = this.connection;
      if (!connection?.peer) {
        throw new Error(`${this.transport.agentName} does not support ACP session/fork`);
      }

      const request: ForkSessionRequest = {
        sessionId: normalized,
        cwd: typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest() as unknown as ForkSessionRequest['mcpServers'],
      };

      const response = await connection.peer.forkSession(request).catch((error) => {
        if (error instanceof RequestError && error.code === -32601) {
          throw new Error(`${this.transport.agentName} does not support ACP session/fork`);
        }
        throw error;
      });
      const forkedSessionId = readNonBlankOpaqueIdentifier(response?.sessionId) ?? '';
      if (!forkedSessionId) {
        throw new Error('Fork response did not include a session id');
      }

      this.acpSessionId = forkedSessionId;
      this.seedSessionModesFromSessionResponse(response);
      await this.seedSessionModelsFromSessionResponse(response);
      this.seedSessionConfigOptionsFromSessionResponse(response);
      this.emitIdleStatus();

      return { sessionId: forkedSessionId };
    } catch (error) {
      logger.debug('[AcpBackend] Error forking session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<Response> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection) {
      await this.createConnectionAndInitialize({ operationId: randomUUID() });
    }
    const peer = this.connection?.peer;
    if (!peer) {
      throw new Error(`${this.transport.agentName} does not support ACP extension requests`);
    }
    return await peer.requestExtension<Response, Params>(method, params, options);
  }

  async loadExtensionForkSession(
    sessionId: SessionId,
    forkResponse: unknown,
  ): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection) {
      throw new Error('ACP extension fork requires its initialized provider connection');
    }
    const normalized = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalized) {
      throw new Error('Extension fork response did not include a session id');
    }
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCalls.reset();

    try {
      const sessionResponse = await this.loadSessionOnCurrentConnection(
        normalized,
        this.transport.getInitTimeout(),
      );
      this.acpSessionId = normalized;
      logger.debug(`[AcpBackend] Extension-forked session loaded: ${normalized}`);

      // Some extension contracts carry supplemental provider state, while the
      // standard session/load response is the authoritative active-session state.
      this.seedSessionModesFromSessionResponse(forkResponse);
      await this.seedSessionModelsFromSessionResponse(forkResponse);
      this.seedSessionConfigOptionsFromSessionResponse(forkResponse);
      this.seedSessionModesFromSessionResponse(sessionResponse);
      await this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();
      return { sessionId: normalized };
    } catch (error) {
      logger.debug('[AcpBackend] Error loading extension-forked session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      await this.cleanupInitializedProcessConnection({ graceMs: 250 });
      throw error;
    }
  }

  private async loadSessionOnCurrentConnection(
    sessionId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const connection = this.connection;
    if (!connection?.peer) {
      throw new Error('ACP session/load requires an initialized provider connection');
    }
    const request: LoadSessionRequest = {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: this.buildAcpMcpServersForSessionRequest() as unknown as LoadSessionRequest['mcpServers'],
    };

    logger.debug(`[AcpBackend] Loading session: ${sessionId}`);

    return await withRetry(
      async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
          return await Promise.race([
            connection.peer.loadSession(request).then((response) => {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
              return response;
            }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(this.createStartupTimeoutError('Load session', timeoutMs));
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      },
      {
        operationName: 'LoadSession',
        maxAttempts: RETRY_CONFIG.maxAttempts,
        baseDelayMs: RETRY_CONFIG.baseDelayMs,
        maxDelayMs: RETRY_CONFIG.maxDelayMs,
      },
    );
  }

  /**
   * Create handler context for session update processing
   */
  private createHandlerContext(): HandlerContext {
    return {
      transport: this.transport,
      toolCalls: this.toolCalls,
      idleTimeout: this.idleTimeout,
      recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
      toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      emit: (msg) => this.emit(msg),
      emitIdleStatus: () => this.emitIdleStatus(),
      scheduleIdleStatusAfterToolCompletion: () => this.scheduleIdleStatusAfterToolCompletion(),
      clearIdleTimeout: () => {
        if (this.idleTimeout) {
          clearTimeout(this.idleTimeout);
          this.idleTimeout = null;
        }
      },
      setIdleTimeout: (callback, ms) => {
        const turnGeneration = this.turnGeneration;
        this.idleTimeout = setTimeout(() => {
          if (turnGeneration !== this.turnGeneration) return;
          callback();
          this.idleTimeout = null;
        }, ms);
        this.idleTimeout.unref?.();
      },
    };
  }

  private activeToolCallIds(): Set<string> {
    return new Set(this.toolCalls.activeCalls().map((call) => call.toolCallId));
  }

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const raw = asRecord(params) ?? {};
    const filteredNotification = (() => {
      if (this.replayCapture) return params;
      const dropClosedTurnUpdates = !this.waitingForResponse && this.isCurrentTurnGenerationClosed();
      if (!dropClosedTurnUpdates && this.prePromptResponseUpdateGuard === 'none' && !this.dropPromptTurnUpdatesUntilPromptResponse) return params;
      const sourceUpdates = raw.update !== undefined
        ? (Array.isArray(raw.update) ? raw.update : [raw.update])
        : (Array.isArray(raw.updates) ? raw.updates : []);
      if (sourceUpdates.length === 0) return params;

      const processable: unknown[] = [];
      for (const update of sourceUpdates) {
        const record = asRecord(update);
        const sessionUpdateType = typeof record?.sessionUpdate === 'string' ? record.sessionUpdate : undefined;
        const isRetainedClosedTurnToolUpdate =
          dropClosedTurnUpdates
          && sessionUpdateType === 'tool_call_update'
          && typeof record?.toolCallId === 'string'
          && this.toolCalls.readCall(record.toolCallId) !== null;
        if (dropClosedTurnUpdates && isPromptTurnSessionUpdateType(sessionUpdateType) && !isRetainedClosedTurnToolUpdate) {
          continue;
        }
        if (!isPromptTurnSessionUpdateType(sessionUpdateType)) {
          processable.push(update);
          continue;
        }
        const isCurrentPromptUserBoundary =
          this.prePromptResponseUpdateGuard === 'terminal'
          && this.dropPromptTurnUpdatesUntilPromptResponse
          && this.waitingForResponse
          && sessionUpdateType === 'user_message_chunk';
        if (isCurrentPromptUserBoundary) {
          // A terminal prior turn can still emit late output after its successor starts.
          // ACP's user-message update is the explicit boundary for the newly issued prompt,
          // so retain the stale-output fence until this boundary instead of waiting for the
          // prompt RPC (some agents stream the complete successor turn before returning it).
          this.prePromptResponseUpdateGuard = 'none';
          this.dropPromptTurnUpdatesUntilPromptResponse = false;
          processable.push(update);
          continue;
        }
        if (this.prePromptResponseUpdateGuard === 'none' && !this.dropPromptTurnUpdatesUntilPromptResponse) {
          processable.push(update);
          continue;
        }

        const promptResponseStillPending =
          this.pendingPromptSubmissionTurnGeneration === this.turnGeneration;
        const canAcceptCompletedGuardUpdate =
          this.prePromptResponseUpdateGuard === 'completed' &&
          !this.dropPromptTurnUpdatesUntilPromptResponse &&
          (promptResponseStillPending || sessionUpdateType === 'agent_message_chunk' || sessionUpdateType === 'agent_thought_chunk');
        const canAcceptTerminalGuardUpdate =
          this.prePromptResponseUpdateGuard === 'terminal' &&
          !this.dropPromptTurnUpdatesUntilPromptResponse &&
          !promptResponseStillPending &&
          (sessionUpdateType === 'agent_message_chunk' || sessionUpdateType === 'agent_thought_chunk');

        if (canAcceptCompletedGuardUpdate || canAcceptTerminalGuardUpdate) {
          this.prePromptResponseUpdateGuard = 'none';
          processable.push(update);
          continue;
        }

        if (this.prePromptResponseUpdateGuard !== 'none') {
          this.dropPromptTurnUpdatesUntilPromptResponse = true;
        }
      }

      if (processable.length === 0) {
        logger.debug('[AcpBackend] Dropping prompt-turn session/update before current prompt response');
        return null;
      }

      const notification: MutableSessionNotificationEnvelope = { ...params };
      if (raw.update !== undefined) {
        notification.update = Array.isArray(raw.update) ? processable : processable[0];
      } else {
        delete notification.update;
      }
      notification.updates = raw.update === undefined && Array.isArray(raw.updates) ? processable : raw.updates;
      return notification;
    })();
    if (!filteredNotification) return;

    await handleAcpSessionNotification({
      notification: filteredNotification as SessionNotification,
      agentName: this.options.agentName,
      transport: this.transport,
      replayCapture: this.replayCapture,
      sessionUpdateShapeLogger: this.sessionUpdateShapeLogger,
      waitingForResponse: this.waitingForResponse,
      onResponseTrafficObserved: () => {
        this.sawSessionUpdateSincePrompt = true;
        if (this.postPromptCompletionIdleTimeout) {
          clearTimeout(this.postPromptCompletionIdleTimeout);
          this.postPromptCompletionIdleTimeout = null;
        }
        if (this.postIdleWithoutAssistantMessageTimeout) {
          clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
          this.postIdleWithoutAssistantMessageTimeout = null;
        }
        this.bumpResponseCompletionTimeout();
        this.bumpTurnInactivityTimeout();
      },
      onAssistantMessageObserved: () => {
        this.sawAssistantMessageSincePrompt = true;
      },
      ...(this.options.prepareToolUpdate
        ? { prepareToolUpdate: this.options.prepareToolUpdate }
        : {}),
      createHandlerContext: () => this.createHandlerContext(),
      setToolCallCountSincePrompt: (count) => {
        this.toolCallCountSincePrompt = count;
      },
      getToolCallCountSincePrompt: () => this.toolCallCountSincePrompt,
      emit: (message) => this.emit(message),
      sessionModeState: this.sessionModeState,
      setSessionModeState: (state) => {
        this.sessionModeState = state;
      },
      sessionModelState: this.sessionModelState,
      setSessionModelState: (state) => {
        this.sessionModelState = state;
      },
      sessionConfigOptionsState: this.sessionConfigOptionsState,
      setSessionConfigOptionsState: (state) => {
        this.sessionConfigOptionsState = state;
      },
    });
  }

  private seedSessionModesFromSessionResponse(sessionResponse: unknown): void {
    const state = readSessionModeStateFromSessionResponse(sessionResponse);
    if (!state) return;
    this.sessionModeState = state;
    this.emit({ type: 'event', name: 'session_modes_state', payload: this.sessionModeState });
  }

  private async seedSessionModelsFromSessionResponse(sessionResponse: unknown): Promise<void> {
    const state = this.options.prepareSessionModels
      ? await this.options.prepareSessionModels(sessionResponse)
      : readSessionModelStateFromSessionResponse(sessionResponse, this.options.projectModel);
    if (!state) return;
    this.sessionModelState = state;
    this.emit({ type: 'event', name: 'session_models_state', payload: this.sessionModelState });
  }

  private seedSessionConfigOptionsFromSessionResponse(sessionResponse: unknown): void {
    const configOptions = readSessionConfigOptionsFromSessionResponse(sessionResponse);
    if (!configOptions) return;
    this.sessionConfigOptionsState = configOptions;
    this.emit({ type: 'event', name: 'config_options_state', payload: { configOptions } });
  }

  async setSessionConfigOption(sessionId: SessionId, configId: string, valueId: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }
    const normalizedSessionId = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const normalizedConfigId = readNonBlankOpaqueIdentifier(configId) ?? '';
    if (!normalizedConfigId) {
      throw new Error('Config ID is required');
    }

    const normalizedValueId = readNonBlankOpaqueIdentifier(valueId) ?? '';
    if (!normalizedValueId) {
      throw new Error('Config value is required');
    }

    const response = await this.connection.peer.setSessionConfigOption({
      sessionId: normalizedSessionId,
      configId: normalizedConfigId,
      value: normalizedValueId,
    });

    const configOptionsCandidate = response?.configOptions;
    const configOptionsRaw = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
    if (configOptionsRaw) {
      const next = normalizeSessionConfigOptions(configOptionsRaw);
      this.sessionConfigOptionsState = next;
    }

    this.emit({
      type: 'event',
      name: 'config_options_update',
      payload: { configOptions: this.sessionConfigOptionsState ?? [] },
    });
  }

  // Promise resolver for waitForIdle - set when waiting for response to complete
  private idleResolver: ((outcome?: AcpTurnOutcome) => void) | null = null;
  private idleRejecter: ((error: Error) => void) | null = null;
  private waitingForResponse = false;
  private responseCompletionError: Error | null = null;
  private postPromptCompletionIdleTimeout: NodeJS.Timeout | null = null;
  private postIdleWithoutAssistantMessageTimeout: NodeJS.Timeout | null = null;
  private sawSessionUpdateSincePrompt = false;
  private sawAssistantMessageSincePrompt = false;
  private pendingPromptSubmissionTurnGeneration: number | null = null;
  private pendingPromptSubmissionEffectResolver: (() => void) | null = null;
  private pendingPromptSubmissionAcceptanceKind: 'transport_write' | 'correlated_provider_effect' | null = null;
  private promptTransportWriteWaiters: Array<{
    sessionId: string;
    resolve: () => void;
  }> = [];
  private responseCompletionTimeoutMs: number | null = null;
  private responseCompletionTimeout: NodeJS.Timeout | null = null;
  private responseCompletionTimeoutRejecter: (() => void) | null = null;

  private clearResponseCompletionTimeout(): void {
    if (this.responseCompletionTimeout) {
      clearTimeout(this.responseCompletionTimeout);
      this.responseCompletionTimeout = null;
    }
    this.responseCompletionTimeoutMs = null;
    this.responseCompletionTimeoutRejecter = null;
  }

  private clearTurnHardCapTimeout(): void {
    if (this.turnHardCapTimeout) {
      clearTimeout(this.turnHardCapTimeout);
      this.turnHardCapTimeout = null;
    }
  }

  private clearTurnInactivityTimeout(): void {
    if (this.turnInactivityTimeout) {
      clearTimeout(this.turnInactivityTimeout);
      this.turnInactivityTimeout = null;
    }
  }

  private clearTurnTimers(): void {
    this.clearTurnHardCapTimeout();
    this.clearTurnInactivityTimeout();
    this.turnInactivityTimeoutMs = null;
  }

  private scheduleTurnHardCapTimeout(turnGeneration: number): void {
    this.clearTurnHardCapTimeout();
    const capMs = resolveTurnHardCapTimeoutMs();
    if (capMs == null) {
      return;
    }
    this.turnHardCapTimeout = setTimeout(() => {
      this.turnHardCapTimeout = null;
      if (this.disposed) return;
      if (turnGeneration !== this.turnGeneration) return;
      if (!this.waitingForResponse) return;

      logger.debug(`[AcpBackend] Turn hard cap elapsed after ${capMs}ms`);
      if (this.connection && this.acpSessionId) {
        void this.connection.peer
          .cancel({ sessionId: this.acpSessionId })
          .catch((error) => logger.debug('[AcpBackend] Error cancelling after turn hard cap:', error));
      }
      this.emit({
        type: 'status',
        status: 'error',
        detail: `ACP turn timed out after ${capMs}ms`,
      });
      if (this.sawSessionUpdateSincePrompt) {
        // Same-turn provider traffic proves the prompt reached provider custody. Release the
        // submission waiter before closing the turn so the hard-cap outcome remains observable
        // instead of being replaced later by the prompt-RPC liveness timeout.
        this.settlePendingPromptSubmissionEffect(turnGeneration, 'correlated_provider_effect');
      }
      this.finalizeTurnOutcome({ kind: 'timed_out', capMs });
    }, capMs);
    this.turnHardCapTimeout.unref?.();
  }

  private bumpTurnInactivityTimeout(): void {
    if (!this.waitingForResponse) return;
    const timeoutMs = this.turnInactivityTimeoutMs;
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const turnGeneration = this.turnGeneration;
    this.clearTurnInactivityTimeout();
    this.turnInactivityTimeout = setTimeout(() => {
      this.turnInactivityTimeout = null;
      if (turnGeneration !== this.turnGeneration) return;
      if (!this.waitingForResponse) return;
      this.failPendingResponseWait(
        new Error(`ACP turn inactivity timeout after ${timeoutMs}ms without session/update traffic`),
      );
    }, timeoutMs);
    this.turnInactivityTimeout.unref?.();
  }

  private closeCurrentTurnGeneration(): void {
    this.closedTurnGeneration = this.turnGeneration;
  }

  private isCurrentTurnGenerationClosed(): boolean {
    return this.closedTurnGeneration === this.turnGeneration;
  }

  private clearActiveToolCallStateForTerminalTurn(
    reason: string,
    status: 'completed' | 'failed' | 'cancelled' = 'failed',
  ): void {
    this.toolCalls.terminalizeTurn(status);
    logger.debug(`[AcpBackend] Terminalized active tool state after ${reason}`);
  }

  private resolvePermissionFlushReasonForOutcome(outcome: AcpTurnOutcome): string {
    switch (outcome.kind) {
      case 'completed':
        return 'ACP turn ended';
      case 'aborted':
        return 'ACP turn cancelled';
      case 'failed':
        return 'ACP turn failed';
      case 'refused':
        return 'ACP turn refused';
      case 'timed_out':
        return 'ACP turn timed out';
    }
  }

  private abortPendingPermissionsForCurrentTurn(reason: string): void {
    if (this.permissionFlushTurnGeneration === this.turnGeneration) return;
    this.permissionFlushTurnGeneration = this.turnGeneration;
    void abortPendingAcpPermissionRequests(this.options.permissionHandler, reason, (error) => {
      logger.debug('[AcpBackend] Failed to abort pending permission requests:', error);
    });
  }

  private finalizeTurnOutcome(outcome: AcpTurnOutcome): void {
    this.clearTurnTimers();
    this.clearResponseCompletionTimeout();
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    const reason = this.resolvePermissionFlushReasonForOutcome(outcome);
    this.lastTurnOutcome = outcome;
    this.pendingTurnOutcome = outcome;
    this.prePromptResponseUpdateGuard = 'none';
    this.dropPromptTurnUpdatesUntilPromptResponse = false;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.abortPendingPermissionsForCurrentTurn(reason);
    this.clearActiveToolCallStateForTerminalTurn(
      reason,
      outcome.kind === 'completed' || outcome.kind === 'refused'
        ? 'completed'
        : outcome.kind === 'aborted'
          ? 'cancelled'
          : 'failed',
    );
    this.closeCurrentTurnGeneration();
    this.waitingForResponse = false;

    if (outcome.kind !== 'timed_out') {
      this.emit({ type: 'status', status: 'idle' });
    }

    if (this.idleResolver) {
      const resolve = this.idleResolver;
      this.idleResolver = null;
      this.idleRejecter = null;
      this.pendingTurnOutcome = null;
      resolve(outcome);
    }
  }

  private handlePromptResponseForTurn(
    promptResponse: unknown,
    turnGeneration: number,
    emitPromptUsage: (promptResponse: unknown) => void,
  ): boolean {
    if (this.disposed) return true;
    if (turnGeneration !== this.turnGeneration) return true;
    if (this.closedTurnGeneration === turnGeneration) return true;

    if (this.pendingPromptResponseTurnGeneration === turnGeneration) {
      this.pendingPromptResponseTurnGeneration = null;
    }
    if (this.prePromptResponseUpdateGuard === 'terminal') {
      this.dropPromptTurnUpdatesUntilPromptResponse = false;
    }
    emitPromptUsage(promptResponse);
    const stopReason = readPromptStopReason(promptResponse);
    if (!stopReason) {
      const shouldReplayDeferredIdle =
        this.idleStatusDeferredUntilPromptResponse &&
        this.waitingForResponse &&
        this.toolCalls.activeCalls().length === 0;
      this.idleStatusDeferredUntilPromptResponse = false;
      if (shouldReplayDeferredIdle) {
        this.emitIdleStatus();
      }
      return false;
    }

    this.finalizeTurnOutcome(mapStopReasonToAcpTurnOutcome(stopReason));
    return true;
  }

  private bumpResponseCompletionTimeout(): void {
    if (!this.waitingForResponse) return;

    const timeoutMs = this.responseCompletionTimeoutMs;
    const rejecter = this.responseCompletionTimeoutRejecter;
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    if (!rejecter) return;

    if (this.responseCompletionTimeout) {
      clearTimeout(this.responseCompletionTimeout);
      this.responseCompletionTimeout = null;
    }

    this.responseCompletionTimeout = setTimeout(() => {
      this.responseCompletionTimeout = null;
      // Avoid stale timeouts firing after the waiter has already been cleared.
      if (this.responseCompletionTimeoutRejecter === rejecter) {
        rejecter();
      }
    }, Math.trunc(timeoutMs));
    this.responseCompletionTimeout.unref?.();
  }

  private failPendingResponseWait(error: Error): void {
    // Multiple sources can surface the same underlying failure (stderr parsing, transport errors, process exit).
    // Preserve the first error to keep `waitForResponseComplete()` deterministic and avoid churn.
    if (this.responseCompletionError) {
      // Prefer surfacing a non-abort failure over a late "Cancelled by user" abort, so fatal transport
      // errors don't get masked by incidental cancellation (for example permission-denied shutdown).
      const existing = this.responseCompletionError;
      const existingIsAbort = existing.name === 'AbortError';
      const incomingIsAbort = error.name === 'AbortError';
      if (existingIsAbort && !incomingIsAbort) {
        logger.debug('[AcpBackend] Replacing abort response completion error with non-abort error', {
          existing: existing.message,
          incoming: error.message,
        });
        this.responseCompletionError = error;
        return;
      }

      logger.debug('[AcpBackend] Additional response completion error observed (ignored)', error);
      return;
    }
    this.responseCompletionError = error;
    this.waitingForResponse = false;
    this.prePromptResponseUpdateGuard = 'none';
    this.dropPromptTurnUpdatesUntilPromptResponse = false;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.lastTurnOutcome = { kind: 'failed', error };
    this.closeCurrentTurnGeneration();
    const reason = error.name === 'AbortError' || error.message === 'Cancelled by user' ? 'Cancelled by user' : 'ACP turn failed';
    this.abortPendingPermissionsForCurrentTurn(reason);
    this.clearActiveToolCallStateForTerminalTurn(
      reason,
      error.name === 'AbortError' || error.message === 'Cancelled by user' ? 'cancelled' : 'failed',
    );
    this.clearTurnTimers();
    this.clearResponseCompletionTimeout();
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    if (this.idleRejecter) {
      this.idleRejecter(error);
    }
    this.idleResolver = null;
    this.idleRejecter = null;
  }

  async sendPrompt(
    sessionId: SessionId,
    prompt: string | readonly ContentBlock[],
    options: AcpPromptOptions = {},
  ): Promise<AcpPromptSubmissionResult> {
    // Check if prompt contains change_title instruction (via optional callback)
    const promptText = typeof prompt === 'string'
      ? prompt
      : prompt
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
    const promptHasChangeTitle = this.options.hasChangeTitleInstruction?.(promptText) ?? false;

    // Reset tool call counter and set flag
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;
    
    if (promptHasChangeTitle) {
      logger.debug('[AcpBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern');
    }
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }
    if (this.rawPromptRequest !== null) {
      throw new Error('Previous ACP prompt request is still settling');
    }

    // ACP tool-call ids are only turn-scoped. Preserve same-turn prompt replay,
    // but never reuse an allow-once response for a later turn with the same raw id.
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.emit({ type: 'status', status: 'running' });
    const previousTurnOutcomeKind = this.isCurrentTurnGenerationClosed() ? this.lastTurnOutcome?.kind : undefined;
    const turnGeneration = this.turnGeneration + 1;
    this.turnGeneration = turnGeneration;
    this.closedTurnGeneration = null;
    this.prePromptResponseUpdateGuard =
      previousTurnOutcomeKind === 'completed'
        ? 'completed'
        : previousTurnOutcomeKind
          ? 'terminal'
          : 'none';
    this.dropPromptTurnUpdatesUntilPromptResponse = this.prePromptResponseUpdateGuard === 'terminal';
    this.pendingTurnOutcome = null;
    this.lastTurnOutcome = null;
    this.permissionFlushTurnGeneration = null;
    // The public ACP session already owns a bounded, turn-correlated pre-acknowledgement
    // buffer. Keep response-idle observations provisional until this exact prompt request
    // settles (or correlated terminal evidence settles the turn), so a provider that streams
    // its complete turn before returning session/prompt cannot close the generation and make
    // the remaining same-turn updates look stale.
    this.pendingPromptResponseTurnGeneration = turnGeneration;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.waitingForResponse = true;
    this.responseCompletionError = null;
    this.sawSessionUpdateSincePrompt = false;
    this.sawAssistantMessageSincePrompt = false;
    this.pendingPromptSubmissionTurnGeneration = null;
    this.pendingPromptSubmissionEffectResolver = null;
    this.pendingPromptSubmissionAcceptanceKind = null;
    this.clearResponseCompletionTimeout();
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    this.turnInactivityTimeoutMs = resolveTurnInactivityTimeoutMs();
    this.scheduleTurnHardCapTimeout(turnGeneration);
    this.bumpTurnInactivityTimeout();

    const handlePromptError = (error: unknown): Error => {
      logger.debug('[AcpBackend] Error sending prompt:', error);

      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.failPendingResponseWait(normalizedError);

      // Extract error details for better error handling
      let errorDetail: string;
      if (error instanceof Error) {
        errorDetail = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errObj = error as Record<string, unknown>;
        // Try to extract structured error information
        const fallbackMessage = (typeof errObj.message === 'string' ? errObj.message : undefined) || String(error);
        if (errObj.code !== undefined) {
          errorDetail = JSON.stringify({ code: errObj.code, message: fallbackMessage });
        } else if (typeof errObj.message === 'string') {
          errorDetail = errObj.message;
        } else {
          errorDetail = String(error);
        }
      } else {
        errorDetail = String(error);
      }

      this.emit({
        type: 'status',
        status: 'error',
        detail: errorDetail,
      });

      return normalizedError;
    };

    try {
      // Never log prompt contents (can include secrets).
      logger.debug(`[AcpBackend] Sending prompt (text length: ${promptText.length})`);

      const contentBlocks: ContentBlock[] = typeof prompt === 'string'
        ? [{ type: 'text', text: prompt }]
        : [...prompt];

      const rawPromptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: contentBlocks,
        ...(options.metadata ? { _meta: options.metadata } : {}),
      };
      const promptRequest = this.options.transformPromptRequest
        ? await this.options.transformPromptRequest(rawPromptRequest, {
            signal: this.connection.signal,
          })
        : rawPromptRequest;

      const emitPromptUsage = (promptResponse: any): void => {
        const observation = buildAcpPromptUsageObservation({
          provider: this.options.agentName,
          promptResponse,
          ...(this.options.projectPromptUsage
            ? { projectUsage: this.options.projectPromptUsage }
            : {}),
        });
        const telemetry = observation ? buildTokenCountAgentMessageFromUsageObservation(observation) : null;
        if (telemetry) {
          this.emit(telemetry);
        }
      };

      const correlatedProviderEffectSentinel = Symbol('acp-correlated-provider-effect');
      const promptLivenessTimeoutSentinel = Symbol('acp-prompt-liveness-timeout');
      const correlatedProviderEffect = new Promise<typeof correlatedProviderEffectSentinel>((resolve) => {
        this.pendingPromptSubmissionTurnGeneration = turnGeneration;
        this.pendingPromptSubmissionEffectResolver = () => resolve(correlatedProviderEffectSentinel);
      });
      const promptLivenessTimeoutMs = resolvePromptLivenessTimeoutMs(this.transport);
      let promptLivenessTimeout: ReturnType<typeof setTimeout> | null = null;
      const promptTransportWriteReceipt = this.createAcpPromptTransportWriteReceipt(promptRequest.sessionId);
      void promptTransportWriteReceipt.written.then(() => {
        this.settlePendingPromptSubmissionEffect(turnGeneration, 'transport_write');
      });
      const promptPromise = this.connection.peer.prompt(promptRequest);
      this.rawPromptRequest = promptPromise;
      this.rawPromptRequestTurnGeneration = turnGeneration;
      const clearRawPromptOwnership = (): void => {
        if (
          this.rawPromptRequest === promptPromise
          && this.rawPromptRequestTurnGeneration === turnGeneration
        ) {
          this.rawPromptRequest = null;
          this.rawPromptRequestTurnGeneration = null;
        }
      };
      void promptPromise.then(clearRawPromptOwnership, clearRawPromptOwnership);
      void promptPromise.then(
        () => promptTransportWriteReceipt.cancel(),
        () => promptTransportWriteReceipt.cancel(),
      );
      const promptRaceInputs: Promise<unknown>[] = [
        promptPromise,
        correlatedProviderEffect,
      ];
      if (promptLivenessTimeoutMs !== null) {
        promptRaceInputs.push(new Promise<typeof promptLivenessTimeoutSentinel>((resolve) => {
          promptLivenessTimeout = setTimeout(() => {
            promptLivenessTimeout = null;
            resolve(promptLivenessTimeoutSentinel);
          }, promptLivenessTimeoutMs);
          promptLivenessTimeout.unref?.();
        }));
      }

      let promptSubmissionEvidence: any;
      try {
        promptSubmissionEvidence = await Promise.race(promptRaceInputs);
      } finally {
        if (promptLivenessTimeout) {
          clearTimeout(promptLivenessTimeout);
          promptLivenessTimeout = null;
        }
      }
      logger.debug('[AcpBackend] Prompt request sent to ACP connection');

      const scheduleNoUpdateCompletionIfNeeded = (): void => {
        if (
          !this.waitingForResponse
          || this.toolCalls.activeCalls().length > 0
          || this.sawSessionUpdateSincePrompt
        ) return;
        const noUpdatesTimeoutMs = resolvePostPromptNoUpdatesTimeoutMs(this.transport);
        if (noUpdatesTimeoutMs === null) return;
        const graceMs = Math.max(100, noUpdatesTimeoutMs);
        this.postPromptCompletionIdleTimeout = setTimeout(() => {
          this.postPromptCompletionIdleTimeout = null;
          if (this.responseCompletionError) return;
          if (!this.waitingForResponse) return;
          if (this.sawSessionUpdateSincePrompt) return;
          if (this.toolCalls.activeCalls().length > 0) return;
          const exitCode = this.process?.exitCode;
          if (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) {
            this.failPendingResponseWait(new Error(`Exit code: ${exitCode}`));
            return;
          }
          const signalCode = this.process?.signalCode;
          if (typeof signalCode === 'string' && signalCode.trim().length > 0) {
            this.failPendingResponseWait(new Error(`Signal: ${signalCode}`));
            return;
          }
          this.emitIdleStatus();
        }, graceMs);
      };

      if (promptSubmissionEvidence === promptLivenessTimeoutSentinel) {
        promptTransportWriteReceipt.cancel();
        throw new Error(
          `Timeout waiting for the ACP prompt response or correlated provider-effect evidence after ${promptLivenessTimeoutMs}ms`,
        );
      }

      if (promptSubmissionEvidence === correlatedProviderEffectSentinel) {
        promptTransportWriteReceipt.cancel();
        const acceptanceKind = this.pendingPromptSubmissionAcceptanceKind;
        this.pendingPromptSubmissionAcceptanceKind = null;
        // A successful transport write proves provider custody. A host-private completion
        // signal can independently prove correlated provider effect if it wins first.
        this.pendingPromptResponseTurnGeneration = turnGeneration;
        void promptPromise
          .then((res: any) => {
            const completedTurn = this.handlePromptResponseForTurn(res, turnGeneration, emitPromptUsage);
            if (!completedTurn) scheduleNoUpdateCompletionIfNeeded();
          })
          .catch((error) => {
            if (this.pendingPromptResponseTurnGeneration === turnGeneration) {
              this.pendingPromptResponseTurnGeneration = null;
              this.idleStatusDeferredUntilPromptResponse = false;
            }
            if (this.disposed || turnGeneration !== this.turnGeneration || this.closedTurnGeneration === turnGeneration) return;
            handlePromptError(error);
          });
        return acceptanceKind === 'transport_write'
          ? { kind: 'accepted_by_transport_write' }
          : { kind: 'accepted_by_correlated_provider_effect' };
      }

      this.pendingPromptSubmissionEffectResolver = null;
      this.pendingPromptSubmissionTurnGeneration = null;
      this.pendingPromptSubmissionAcceptanceKind = null;
      promptTransportWriteReceipt.cancel();

      const promptResponse: any = promptSubmissionEvidence;

      // Best-effort: emit token usage when the ACP agent reports it in the PromptResponse.
      // ACP standardizes per-turn usage under `usage` (RFC: session-usage).
      const promptResponseCompletedTurn = this.handlePromptResponseForTurn(promptResponse, turnGeneration, emitPromptUsage);
      if (promptResponseCompletedTurn) {
        return { kind: 'accepted_by_prompt_response' };
      }
      
      // Don't emit 'idle' here - it will be emitted after all message chunks are received
      // The idle timeout in handleSessionUpdate will emit 'idle' after the last chunk
      //
      // However, some ACP agents complete the prompt turn without emitting any session/update
      // events (no message chunks, no tool calls). In that case, we must still unblock
      // `waitForResponseComplete()` so callers don't degrade into a generic timeout.
      //
      // Guard: only emit when we are still waiting (i.e. no idle was already observed), there are
      // no active tool calls, and we have *not yet observed any session/update traffic* for this prompt.
      scheduleNoUpdateCompletionIfNeeded();

      return { kind: 'accepted_by_prompt_response' };
    } catch (error) {
      this.pendingPromptSubmissionEffectResolver = null;
      this.pendingPromptSubmissionTurnGeneration = null;
      this.pendingPromptSubmissionAcceptanceKind = null;
      const normalizedError = handlePromptError(error);
      if (error instanceof RequestError && !this.sawSessionUpdateSincePrompt) {
        return { kind: 'rejected_before_effect', error: normalizedError };
      }
      return { kind: 'effect_may_have_occurred', error: normalizedError };
    }
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const contentBlock: ContentBlock = {
      type: 'text',
      text: prompt,
    };

    const rawPromptRequest: PromptRequest = {
      sessionId: this.acpSessionId,
      prompt: [contentBlock],
    };
    const promptRequest = this.options.transformPromptRequest
      ? await this.options.transformPromptRequest(rawPromptRequest, {
          signal: this.connection.signal,
        })
      : rawPromptRequest;

    // Intentionally do not toggle `waitingForResponse` or tool-call counters here.
    // This method is used for in-flight steering while a primary prompt is already running.
    const turnGeneration = this.turnGeneration;
    const transportWriteReceipt = this.createAcpPromptTransportWriteReceipt(promptRequest.sessionId);
    const transportWriteSentinel = Symbol('acp-steer-transport-write');
    const promptPromise = this.connection.peer.prompt(promptRequest);
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        promptPromise,
        transportWriteReceipt.written.then(
          (): typeof transportWriteSentinel => transportWriteSentinel,
        ),
      ]);
    } catch (error) {
      transportWriteReceipt.cancel();
      throw error;
    }
    if (outcome !== transportWriteSentinel) {
      transportWriteReceipt.cancel();
      this.handlePromptResponseForTurn(outcome, turnGeneration, () => {});
      return;
    }
    void promptPromise.then(
      (response) => {
        this.handlePromptResponseForTurn(response, turnGeneration, () => {});
      },
      (error: unknown) => {
        if (this.disposed || !this.waitingForResponse) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.failPendingResponseWait(normalizedError);
        this.emit({ type: 'status', status: 'error', detail: normalizedError.message });
      },
    );
  }

  async setSessionMode(sessionId: SessionId, modeId: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }
    const normalizedModeId = readNonBlankOpaqueIdentifier(modeId) ?? '';
    if (!normalizedModeId) {
      throw new Error('Mode ID is required');
    }

    const request: SetSessionModeRequest = { sessionId: normalizedSessionId, modeId: normalizedModeId };
    await this.connection.peer.setSessionMode(request);

    if (this.sessionModeState) {
      this.sessionModeState = { ...this.sessionModeState, currentModeId: normalizedModeId };
    }

    this.emit({ type: 'event', name: 'current_mode_update', payload: { currentModeId: normalizedModeId } });
  }

  async setSessionModel(
    sessionId: SessionId,
    modelId: string,
    requestMeta?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = readNonBlankOpaqueIdentifier(sessionId) ?? '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const normalizedModelId = readNonBlankOpaqueIdentifier(modelId) ?? '';
    if (!normalizedModelId) {
      throw new Error('Model ID is required');
    }

    const response = await this.connection.peer.setSessionModelLegacy({
      sessionId: normalizedSessionId,
      modelId: normalizedModelId,
      ...(requestMeta ? { _meta: requestMeta } : {}),
    });
    let returnedState = this.options.prepareSessionModels
      ? await this.options.prepareSessionModels(response)
      : readSessionModelStateFromSessionResponse(response, this.options.projectModel);
    if (
      !returnedState
      && (this.options.projectSetModelResponse
        || this.options.projectSetModelResponseAwaitable)
      && this.sessionModelState
    ) {
      const targetModel = this.sessionModelState.availableModels.find((model) => model.id === normalizedModelId);
      const projected = targetModel
        ? this.options.projectSetModelResponseAwaitable
          ? await this.options.projectSetModelResponseAwaitable({
              response,
              requestedModelId: normalizedModelId,
              requestMeta: requestMeta ?? null,
              targetModel,
            })
          : this.options.projectSetModelResponse!({
              response,
              requestedModelId: normalizedModelId,
              requestMeta: requestMeta ?? null,
              targetModel,
            })
        : null;
      if (projected) {
        const candidate = readSessionModelStateFromSessionResponse({
          models: {
            currentModelId: normalizedModelId,
            availableModels: this.sessionModelState.availableModels.map((model) => (
              model.id === normalizedModelId ? projected : model
            )),
          },
        });
        if (candidate?.availableModels.some((model) => model.id === normalizedModelId)) {
          returnedState = candidate;
        }
      }
    }
    if (!returnedState) {
      throw new Error('ACP session/set_model did not return model state');
    }
    if (returnedState.currentModelId !== normalizedModelId) {
      throw new Error('ACP session/set_model returned a different current model');
    }
    this.sessionModelState = returnedState;
    this.emit({ type: 'event', name: 'session_models_state', payload: returnedState });
  }

  /**
   * Wait for the response to complete (idle status after all chunks received)
   * Call this after sendPrompt to wait for Gemini to finish responding
   */
  private clearTrackedToolCall(toolCallId: string, reason: string): void {
    if (this.waitingForResponse && reason.startsWith('permission')) {
      this.failPendingResponseWait(makeAbortError('Cancelled by user'));
      return;
    }
    const wasActive = this.toolCalls.readCall(toolCallId) !== null;
    this.toolCalls.terminalizeCall(toolCallId, 'cancelled');
    if (wasActive) {
      logger.debug(
        `[AcpBackend] Terminalized tracked tool call ${toolCallId} after ${reason}. Active tool calls: ${this.toolCalls.activeCalls().length}`,
      );
    }

    if (this.toolCalls.activeCalls().length === 0) {
      // Tool completion often precedes trailing assistant message chunks. Respect the transport's
      // post-tool quiet period before emitting idle so `waitForResponseComplete()` does not settle
      // prematurely (especially for OpenCode-family agents).
      this.scheduleIdleStatusAfterToolCompletion();
    }
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void>;
  async waitForResponseComplete(timeoutMs?: number | null): Promise<AcpTurnOutcome | void> {
    if (this.responseCompletionError) {
      throw this.responseCompletionError;
    }
    if (this.pendingTurnOutcome) {
      const outcome = this.pendingTurnOutcome;
      this.pendingTurnOutcome = null;
      return outcome;
    }
    if (!this.waitingForResponse) {
      return; // Already completed or no prompt sent
    }

    return new Promise<AcpTurnOutcome | void>((resolve, reject) => {
      const rejectTimeout = () => {
        const error = new Error('Timeout waiting for response to complete');
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        this.prePromptResponseUpdateGuard = 'none';
        this.dropPromptTurnUpdatesUntilPromptResponse = false;
        this.pendingPromptResponseTurnGeneration = null;
        this.idleStatusDeferredUntilPromptResponse = false;
        this.closeCurrentTurnGeneration();
        this.lastTurnOutcome = { kind: 'failed', error };
        this.abortPendingPermissionsForCurrentTurn('ACP response wait timeout');
        this.clearActiveToolCallStateForTerminalTurn('response wait timeout');
        this.clearTurnTimers();
        this.clearResponseCompletionTimeout();
        reject(error);
      };

      // Treat the timeout as a stall budget. While the agent continues emitting session/update
      // traffic, `handleSessionUpdate()` will keep bumping this timeout forward.
      const stallTimeoutMs =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.trunc(timeoutMs)
          : null;
      if (typeof stallTimeoutMs === 'number') {
        this.responseCompletionTimeoutMs = stallTimeoutMs;
        this.responseCompletionTimeoutRejecter = rejectTimeout;
        this.bumpResponseCompletionTimeout();
      } else {
        this.clearResponseCompletionTimeout();
        this.responseCompletionTimeoutMs = null;
        this.responseCompletionTimeoutRejecter = null;
      }

      this.idleResolver = (outcome?: AcpTurnOutcome) => {
        this.clearResponseCompletionTimeout();
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        resolve(outcome);
      };
      this.idleRejecter = (error: Error) => {
        this.clearResponseCompletionTimeout();
        this.clearTurnTimers();
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        reject(error);
      };
    });
  }

  async waitForTurnCompletion(timeoutMs?: number | null): Promise<void> {
    await this.waitForResponseComplete(timeoutMs);
  }

  /**
   * Helper to emit idle status and resolve any waiting promises
   */
  private finalizeIdleStatus(): void {
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    this.clearTurnTimers();
    this.clearResponseCompletionTimeout();
    this.emit({ type: 'status', status: 'idle' });
    this.clearActiveToolCallStateForTerminalTurn('idle finalization');
    this.closeCurrentTurnGeneration();
    // Avoid races where the idle signal arrives before `waitForResponseComplete()` starts waiting.
    // In that case, `idleResolver` is still null, so we must also clear `waitingForResponse` here.
    this.waitingForResponse = false;
    // Resolve any waiting promises
    if (this.idleResolver) {
      logger.debug('[AcpBackend] Resolving idle waiter');
      this.idleResolver();
    }
  }

  private emitIdleStatus(): void {
    if (this.waitingForResponse && this.pendingPromptResponseTurnGeneration === this.turnGeneration) {
      this.idleStatusDeferredUntilPromptResponse = true;
      logger.debug('[AcpBackend] Deferring idle status until prompt response arrives');
      return;
    }

    const idleWithoutAssistantMessageTimeoutMs = resolveIdleWithoutAssistantMessageTimeoutMs(this.transport);
    const shouldDelayIdleResolution =
      this.waitingForResponse
      && !this.sawAssistantMessageSincePrompt
      && idleWithoutAssistantMessageTimeoutMs > 0;

    if (shouldDelayIdleResolution) {
      if (this.postIdleWithoutAssistantMessageTimeout) {
        clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      }
      logger.debug(
        `[AcpBackend] Delaying idle resolution for ${idleWithoutAssistantMessageTimeoutMs}ms because no assistant message chunk has arrived yet`,
      );
      this.postIdleWithoutAssistantMessageTimeout = setTimeout(() => {
        this.postIdleWithoutAssistantMessageTimeout = null;
        if (this.responseCompletionError) return;
        if (!this.waitingForResponse) return;
        if (this.toolCalls.activeCalls().length > 0) return;
        if (this.sawAssistantMessageSincePrompt) return;
        logger.debug('[AcpBackend] Assistant message still absent after idle grace; finalizing idle status');
        this.finalizeIdleStatus();
      }, idleWithoutAssistantMessageTimeoutMs);
      this.postIdleWithoutAssistantMessageTimeout.unref?.();
      return;
    }

    this.finalizeIdleStatus();
  }

  private scheduleIdleStatusAfterToolCompletion(): void {
    if (this.toolCalls.activeCalls().length > 0) return;
    // Tool terminalization is also used by failure/cancellation cleanup. Once the response owner
    // has stopped waiting, an on-idle callback must not resolve a still-installed waiter or emit a
    // later idle status over the terminal outcome.
    if (!this.waitingForResponse) return;

    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    const idleTimeoutMs = resolvePostToolCallIdleTimeoutMs(this.transport);
    this.idleTimeout = setTimeout(() => {
      this.idleTimeout = null;
      if (!this.waitingForResponse) return;
      if (this.toolCalls.activeCalls().length > 0) {
        logger.debug('[AcpBackend] Skipping post-tool idle emission because a tool call became active again');
        return;
      }
      logger.debug('[AcpBackend] Post-tool quiet period elapsed, emitting idle status');
      this.emitIdleStatus();
    }, idleTimeoutMs);
    this.idleTimeout.unref?.();
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const cancelledTurnGeneration = this.turnGeneration;
    if (this.waitingForResponse) {
      this.failPendingResponseWait(makeAbortError('Cancelled by user'));
    }

    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    this.clearTurnTimers();
    this.prePromptResponseUpdateGuard = 'none';
    this.dropPromptTurnUpdatesUntilPromptResponse = false;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;

    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    this.toolCalls.terminalizeTurn('cancelled');

    const connection = this.connection;
    const acpSessionId = this.acpSessionId;
    const rawPromptRequest = this.rawPromptRequest;
    if (!connection || !acpSessionId) return;

    const cancelAcknowledged = connection.peer
      .cancel({ sessionId: acpSessionId })
      .then(
        () => true,
        (error) => {
          logger.debug('[AcpBackend] Error cancelling:', error);
          return false;
        },
      );
    const rawPromptSettled = rawPromptRequest
      ? rawPromptRequest.then(() => undefined, () => undefined)
      : Promise.resolve();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancellationSettled = await Promise.race([
      cancelAcknowledged.then(async (acknowledged) => {
        if (acknowledged) return true;
        await rawPromptSettled;
        return false;
      }),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 5_000);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    let cleanedUpCancelledConnection = false;
    if (
      cancellationSettled
      && rawPromptRequest !== null
      && this.rawPromptRequest === rawPromptRequest
    ) {
      this.settlePendingPromptSubmissionEffect(cancelledTurnGeneration, 'correlated_provider_effect');
      // An acknowledged ACP cancellation closes this turn's provider custody even when the
      // original prompt RPC settles later. Release only the local request owner so a successor
      // prompt can start; the old response remains fenced by its closed turn generation.
      this.rawPromptRequest = null;
      this.rawPromptRequestTurnGeneration = null;
    } else if (
      !cancellationSettled
      && this.connection === connection
      && this.acpSessionId === acpSessionId
    ) {
      await this.cleanupInitializedProcessConnection({ graceMs: 250 });
      cleanedUpCancelledConnection = true;
      if (this.rawPromptRequest === rawPromptRequest) {
        this.rawPromptRequest = null;
        this.rawPromptRequestTurnGeneration = null;
      }
    }

    if (
      this.turnGeneration === cancelledTurnGeneration
      && (
        cleanedUpCancelledConnection
        || (
          this.connection === connection
          && this.acpSessionId === acpSessionId
        )
      )
    ) {
      this.emit({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    
    logger.debug('[AcpBackend] Disposing backend');
    this.disposed = true;

    if (this.waitingForResponse || this.responseCompletionTimeout) {
      this.failPendingResponseWait(makeAbortError('Backend disposed'));
      this.clearResponseCompletionTimeout();
    }

    try {
      await this.stderrAppender?.close();
    } catch {
      // ignore
    } finally {
      this.stderrAppender = null;
    }
    // Try graceful shutdown first
    if (this.connection && this.acpSessionId) {
      try {
        // Send cancel to stop any ongoing work
        await Promise.race([
          this.connection.peer.cancel({ sessionId: this.acpSessionId }),
          new Promise((resolve) => setTimeout(resolve, 2000)), // 2s timeout for graceful shutdown
        ]);
      } catch (error) {
        logger.debug('[AcpBackend] Error during graceful shutdown:', error);
      }
    }
    const connection = this.connection;
    const processConnectionGraceMs = 1000;
    connection?.close(undefined, { timeoutMs: processConnectionGraceMs });

    // Kill the whole process tree (some ACP CLIs spawn child processes).
    if (this.process) {
      try {
        await killProcessTree(this.process, { graceMs: processConnectionGraceMs });
      } catch (error) {
        logger.debug('[AcpBackend] Failed to kill process tree (non-fatal):', error);
      } finally {
        this.process = null;
      }
    }
    await connection?.closed.catch(() => undefined);

    // Clear timeouts
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    this.clearTurnTimers();
    this.pendingPromptResponseTurnGeneration = null;
    this.rawPromptRequest = null;
    this.rawPromptRequestTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;

    // Clear state
    this.listeners = [];
    this.connection = null;
    this.acpSessionId = null;
    this.toolCalls.dispose();
    this.pendingPermissions.clear();
    this.permissionToToolCallMap.clear();
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
  }
}

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import spawn from 'cross-spawn';

import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  AgentSessionOpenOptions,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import {
  AcpPromptSubmissionPhaseError,
  type AcpPromptSubmissionEvidence,
  type AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import { abortPendingAcpPermissionRequests } from '@/agent/acp/backend/permissions/acpPermissionFinalization';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { materializeProtectedTempTextArtifact, type ProtectedTempTextArtifact } from '@/utils/fs/protectedTempTextArtifact';
import { PI_BRIDGE_CONFIG_PATH_FLAG } from '@/backends/pi/bridgeExtension/piBridgeExtensionEnv';
import { logger } from '@/ui/logger';
import {
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import {
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  parsePiBrokerSelections,
  piRegisterProviderId,
  PiBrokerReadinessError,
  verifyPiBrokerReadyForConnectedSession,
  type PiBrokerReadiness,
} from '@/backends/pi/brokerExtension';

import { createPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/createPiConnectedServiceRuntimeAuthAdapter';
import { resolvePiCompactionTurnOutcome } from './compaction/resolvePiCompactionTurnOutcome';
import {
  doesPiSessionFileNameMatchSessionId,
  formatPiSessionDirectoryForCwd,
  isBarePiSessionId,
  resolvePiSessionIdFromResumeReference,
} from '../utils/piSessionFiles';
import { attachPiRpcJsonlLineReader, type PiRpcJsonlLineReader } from './attachPiRpcJsonlLineReader';
import {
  buildPiContextTelemetryKeySuffix,
  mergePiContextTelemetryIntoTokens,
  parsePiContextTelemetryFromSessionStats,
  parsePiContextTelemetryMarkerLine,
  type PiContextTelemetry,
} from './piContextTelemetryMarker';
import { mapPiRpcEventToAgentMessages } from './eventMapping';
import {
  createPiProviderFailureError,
  normalizePiProviderFailure,
  type PiProviderFailureDiagnostic,
} from './piProviderFailureDiagnostic';
import type {
  PiRpcCommand,
  PiRpcCommandWithoutId,
  PiRpcCommandsData,
  PiRpcModelsData,
  PiRpcResponse,
  PiRpcSessionStatsData,
  PiRpcStateData,
} from './types';
import {
  buildPiExtensionAskUserQuestionInput,
  buildPiExtensionUiResponse,
  parsePiBlockingExtensionUiRequest,
  type PiExtensionUiResponse,
} from './piExtensionUiRequest';
import {
  createPiModelCatalogEntry,
  normalizePiThinkingEffort,
  qualifyPiModelId,
} from '@/backends/pi/models/piModelCatalog';

type PendingRpcRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  commandType: PiRpcCommandWithoutId['type'];
  removeAbortListener: () => void;
};

type PiRpcCommandOptions = Readonly<{
  processAlreadyEnsured?: boolean;
  signal?: AbortSignal;
  createCancellationError?: () => Error;
}>;

type PendingTurn = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
  timeoutMs: number;
  agentEndSettleTimeout: NodeJS.Timeout | null;
  compactionResumeTimeout: NodeJS.Timeout | null;
  compactionInProgress: boolean;
  /** True after Pi emitted `agent_end` but before Happier has proven the provider is idle. */
  agentEndObserved: boolean;
  /** Activity epoch captured by the latest final `agent_end`, used to preserve late-event guards. */
  agentEndActivityEpoch: number | null;
  /** True after Pi emitted `agent_start` for the prompt accepted by this pending turn. */
  agentStartObserved: boolean;
  /** Terminal failure observed after admission but before Pi identified the current turn. */
  preStartTerminalFailure: Error | null;
  /** Bumped on every Pi event so an in-flight liveness probe can detect stale state. */
  activityEpoch: number;
  /** Consecutive liveness probes where Pi claimed to be busy but emitted no events. */
  consecutiveSilentProbes: number;
  /** True while a `get_state` liveness probe is awaiting a response. */
  livenessProbeInFlight: boolean;
  /** True when an inactivity timer fired while another liveness probe was already in-flight. */
  livenessProbeRerunRequested: boolean;
  /** True after a recoverable assistant error until Pi proves the turn resumed or ended normally. */
  recoverableAssistantErrorObserved: boolean;
  /** Sanitized provider-owned evidence retained until Pi confirms whether it will retry. */
  providerFailureDiagnostic: PiProviderFailureDiagnostic | null;
  /** Last observed `compaction_end`, used to classify a post-compaction pause vs. a stall. */
  lastCompactionEnd: { payload: Record<string, unknown>; willRetry: boolean; errorMessage: string | null } | null;
  /** Last assistant `message_end` stop reason observed before a post-turn compaction. */
  lastAssistantStopReason: string | null;
  /** Number of hidden continuation prompts sent after threshold/manual compaction pauses. */
  compactionAutoContinueAttempts: number;
  /** Runtime-auth classifications already reported from stderr for this pending turn. */
  stderrRuntimeAuthReportedKeys: Set<string>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function parseCompactInstructions(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '/compact') return undefined;
  if (!trimmed.startsWith('/compact ')) return undefined;
  const instructions = trimmed.slice('/compact'.length).trim();
  return instructions.length > 0 ? instructions : undefined;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  if (!resolve || !reject) {
    throw new Error('Failed to initialize deferred promise');
  }

  return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findContextCompactionPayload(messages: readonly AgentMessage[]): Record<string, unknown> | null {
  for (const message of messages) {
    if (message.type !== 'event' || message.name !== 'context_compaction') continue;
    const payload = asRecord(message.payload);
    if (payload?.type === 'context-compaction') return payload;
  }
  return null;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

class PiRpcCommandResponseTimeoutError extends Error {
  readonly commandType: PiRpcCommandWithoutId['type'];

  constructor(commandType: PiRpcCommandWithoutId['type']) {
    super(`Timed out waiting for Pi RPC response (${commandType})`);
    this.name = 'PiRpcCommandResponseTimeoutError';
    this.commandType = commandType;
  }
}

class PiRpcPromptRejectedBeforeEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiRpcPromptRejectedBeforeEffectError';
  }
}

function isPromptResponseTimeoutError(error: Error): boolean {
  if (error instanceof PiRpcCommandResponseTimeoutError) {
    return error.commandType === 'prompt';
  }
  return error.message.toLowerCase() === 'timed out waiting for pi rpc response (prompt)';
}

const DEFAULT_PI_RPC_TURN_STALL_TIMEOUT_MS = 180_000;
/** Existing Pi new-session command budget; also owns broker readiness for that session open. */
const PI_RPC_SESSION_OPEN_TIMEOUT_MS = 60_000;
const DEFAULT_PI_RPC_COMPACTION_RESUME_GRACE_MS = 30_000;
const DEFAULT_PI_RPC_AGENT_END_SETTLE_MS = 250;
const DEFAULT_PI_RPC_AGENT_END_BUSY_GRACE_MS = 30_000;
const PI_RPC_RECOVERABLE_ASSISTANT_ERROR_PATTERN =
  /(?:context[_ -]?length[_ -]?exceeded|server[_ -]?is[_ -]?overloaded|service[_ -]?unavailable|websocket[^\n]*closed|\bECONN(?:RESET|REFUSED|ABORTED)\b)/iu;

const PI_RPC_TURN_STALL_TIMEOUT_ENV = 'HAPPIER_PI_RPC_TURN_STALL_TIMEOUT_MS';
const PI_RPC_COMPACTION_RESUME_GRACE_ENV = 'HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS';
const PI_RPC_AGENT_END_SETTLE_ENV = 'HAPPIER_PI_RPC_AGENT_END_SETTLE_MS';
const PI_RPC_AGENT_END_BUSY_GRACE_ENV = 'HAPPIER_PI_RPC_AGENT_END_BUSY_GRACE_MS';

const DEFAULT_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PI_RPC_MAX_SILENT_PROBES = 4;
const DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS = 30_000;
const DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS = 250;

type PiRpcSessionOpenLifecycle = Readonly<{
  deadlineMs: number;
  signal?: AbortSignal;
}>;
const DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX = 3;
const DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT =
  'Continue the interrupted work from the recovered provider context. Do not restart or repeat completed work.';

/** How many trailing stderr lines to retain for the non-zero process-exit context (O2). */
const PI_RPC_STDERR_TAIL_MAX_LINES = 10;

/**
 * Cheap pre-filter so we only run the full runtime-auth classifier on stderr lines that look like a
 * provider usage/rate limit. Pi surfaces most limits via an assistant `message_end`, but some appear
 * only on stderr; this catches those without classifying every noisy log line.
 */
const PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN =
  /\b(usage_limit_reached|usage_limit_exceeded|usagelimitreached|usagelimitexceeded|freeusagelimiterror|go_usage_limit|gousagelimiterror|account_rate_limit|rate_limit|rate_limit_error|ratelimit|ratelimiterror|resource_exhausted)\b/iu;
const PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN =
  /\b(usage\s*limit|rate\s*limit|too many requests|resource[_\s-]*exhausted|limit reached|out of credits|credits exhausted)\b|\bquota(?:[_\s-]*(?:exceeded|exhausted|reached)|[_\s-]*limit[_\s-]*(?:exceeded|exhausted|reached))\b/u;
const PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN =
  /\b(?:http|status|code|error)["']?\s*[:=]?\s*429\b|\b429\b.*\btoo many requests\b|\btoo many requests\b.*\b429\b/u;
const PI_RPC_PROVIDER_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/gu;

function redactPiDiagnosticText(value: string): string {
  // Shared scrubber first, Pi's narrower rule second: the shared owner covers `sk-` keys of 20+
  // body characters (including separators), and this pattern is the local backstop for the shorter
  // ones it does not reach.
  return redactBugReportSensitiveText(value).replace(PI_RPC_PROVIDER_TOKEN_PATTERN, '[redacted-provider-token]');
}

const PI_RPC_FAILURE_TRACE_ENV = 'HAPPIER_PI_RPC_FAILURE_TRACE';
const PI_RPC_FAILURE_TRACE_MAX_STRING_LENGTH = 240;
const PI_RPC_FAILURE_TRACE_MAX_ARRAY_LENGTH = 10;
const PI_RPC_FAILURE_TRACE_SAFE_SCALAR_FIELDS = [
  'type',
  'command',
  'success',
  'error',
  'message',
  'detail',
  'reason',
  'status',
  'terminalStatus',
  'terminal_status',
  'stopReason',
  'stop_reason',
  'errorCode',
  'error_code',
  'errorMessage',
  'error_message',
  'provider',
  'model',
] as const;

function sanitizePiRpcFailureTraceScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') {
    const normalized = redactPiDiagnosticText(value).replace(/\s+/gu, ' ').trim();
    return normalized.length > 0 ? normalized.slice(0, PI_RPC_FAILURE_TRACE_MAX_STRING_LENGTH) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

function collectPiRpcFailureTraceScalars(record: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const key of PI_RPC_FAILURE_TRACE_SAFE_SCALAR_FIELDS) {
    const sanitized = sanitizePiRpcFailureTraceScalar(record[key]);
    if (sanitized !== null) output[key] = sanitized;
  }
  return output;
}

function buildPiRpcFailureTraceMessageShape(value: unknown): Record<string, unknown> | null {
  const message = asRecord(value);
  if (!message) return null;
  const content = Array.isArray(message.content) ? message.content : null;
  return {
    ...collectPiRpcFailureTraceScalars(message),
    hasContent: content !== null,
    contentLength: content?.length ?? null,
    contentItemTypes: content
      ?.slice(0, PI_RPC_FAILURE_TRACE_MAX_ARRAY_LENGTH)
      .map((item) => asNonEmptyString(asRecord(item)?.type) ?? typeof item) ?? [],
  };
}

function sanitizePiRpcFailureTraceExtraValue(value: unknown): unknown {
  const scalar = sanitizePiRpcFailureTraceScalar(value);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) {
    return value
      .slice(0, PI_RPC_FAILURE_TRACE_MAX_ARRAY_LENGTH)
      .map((item) => sanitizePiRpcFailureTraceExtraValue(item));
  }
  const record = asRecord(value);
  if (record) {
    return {
      object: true,
      keys: Object.keys(record).slice(0, PI_RPC_FAILURE_TRACE_MAX_ARRAY_LENGTH),
    };
  }
  return null;
}

function sanitizePiRpcFailureTraceExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    output[key] = sanitizePiRpcFailureTraceExtraValue(value);
  }
  return output;
}

function collectPiStderrRuntimeAuthMarkerText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPiStderrRuntimeAuthMarkerText(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const nested of Object.values(record)) {
    collectPiStderrRuntimeAuthMarkerText(nested, output);
  }
}

function readPiRuntimeAuthMarkerCode(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.match(PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN)?.[0] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = readPiRuntimeAuthMarkerCode(item);
      if (code) return code;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const nested of Object.values(record)) {
    const code = readPiRuntimeAuthMarkerCode(nested);
    if (code) return code;
  }
  return null;
}

function normalizePiRuntimeAuthStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-5]\d{2}$/u.test(trimmed)) return null;
  const status = Number(trimmed);
  return status >= 100 && status <= 599 ? status : null;
}

function isPiRuntimeAuthStatusCodeKey(key: string): boolean {
  return ['code', 'errorcode', 'httpstatus', 'status', 'statuscode'].includes(
    key.replace(/[_-]/gu, '').toLowerCase(),
  );
}

function readPiRuntimeAuthStatusCode(value: unknown): number | null {
  let fallback: number | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = readPiRuntimeAuthStatusCode(item);
      if (status === 429) return status;
      fallback ??= status;
    }
    return fallback;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, nested] of Object.entries(record)) {
    if (!isPiRuntimeAuthStatusCodeKey(key)) continue;
    const status = normalizePiRuntimeAuthStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  for (const nested of Object.values(record)) {
    const status = readPiRuntimeAuthStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  return fallback;
}

function looksLikeProviderLimitStderrLine(line: string): boolean {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    parsed = null;
  }

  const record = asRecord(parsed);
  if (record) {
    if (readPiRuntimeAuthStatusCode(record) === 429) return true;
    const parts: string[] = [];
    collectPiStderrRuntimeAuthMarkerText(record, parts);
    const markerText = parts.join(' ').toLowerCase();
    return PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN.test(markerText)
      || PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN.test(markerText);
  }

  const normalized = line.toLowerCase();
  return PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN.test(line)
    || PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN.test(normalized)
    || PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN.test(normalized);
}

function buildRuntimeAuthClassificationReportKey(
  classification: ConnectedServiceRuntimeFailureClassification,
): string {
  return [
    classification.kind,
    classification.serviceId,
    classification.profileId ?? '',
    classification.groupId ?? '',
    classification.quotaScope ?? '',
  ].join(':');
}

function buildPiStderrRuntimeAuthEvidence(
  line: string,
  provider: string | null,
): Record<string, unknown> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    parsed = null;
  }

  const record = asRecord(parsed);
  if (record) {
    const code = readPiRuntimeAuthMarkerCode(record)
      ?? asNonEmptyString(record.code ?? record.type ?? record.reason ?? record.name);
    const status = readPiRuntimeAuthStatusCode(record);
    const providerFallback = provider && !asNonEmptyString(record.provider ?? record.providerId)
      ? { provider }
      : {};
    return {
      ...providerFallback,
      ...record,
      ...(code ? { code } : {}),
      ...(status !== null ? { status } : {}),
      message: asNonEmptyString(record.message ?? record.errorMessage ?? record.error_message) ?? line,
    };
  }

  const code = readPiRuntimeAuthMarkerCode(line);
  const status = PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN.test(line.toLowerCase()) ? 429 : null;
  return {
    ...(provider ? { provider } : {}),
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    message: line,
  };
}

function readPiTerminalStatus(value: unknown): string | null {
  const status = asNonEmptyString(value);
  return status ? status.toLowerCase() : null;
}

function isPiFailedAssistantTerminalEvent(event: Record<string, unknown>): boolean {
  const type = asNonEmptyString(event.type);
  if (type !== 'assistant_message_end' && type !== 'message_end') return false;
  const message = asRecord(event.message);
  if (message && message.role !== 'assistant') return false;

  const terminalStatus = readPiTerminalStatus(
    event.terminalStatus ??
    event.terminal_status ??
    message?.terminalStatus ??
    message?.terminal_status,
  );
  return terminalStatus === 'failed' || terminalStatus === 'failure' || terminalStatus === 'error';
}

const PI_RPC_LIVENESS_PROBE_TIMEOUT_ENV = 'HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS';
const PI_RPC_MAX_SILENT_PROBES_ENV = 'HAPPIER_PI_RPC_MAX_SILENT_PROBES';
const PI_RPC_PROMPT_COLLISION_IDLE_WAIT_ENV = 'HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS';
const PI_RPC_PROMPT_COLLISION_IDLE_POLL_ENV = 'HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS';
const PI_RPC_COMPACTION_AUTO_CONTINUE_MAX_ENV = 'HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX';
const PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT_ENV = 'HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT';

function readPositiveIntegerEnv(env: Record<string, string>, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== 'string') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeIntegerEnv(env: Record<string, string>, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== 'string') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readPiSessionHeaderId(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const firstLine = buffer.subarray(0, firstLineEnd >= 0 ? firstLineEnd : bytesRead).toString('utf8').trim();
    if (!firstLine) return null;
    const header = asRecord(JSON.parse(firstLine));
    if (header?.type !== 'session') return null;
    return asNonEmptyString(header.id);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}

async function stopPiRpcProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  // Register before signaling so a fast Windows exit cannot race the close listener. `close` is
  // later than `exit` and proves the child's stdio/OS handles have been released as well as its PID.
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  await killProcessTree(child, { graceMs: 2_000 });
  await closed;
}

export type PiRpcSpawnOptions = {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  happierSessionId?: string | null;
  /**
   * Residual system-prompt content appended to pi's prompt via `--append-system-prompt`.
   * Delivered as a protected temporary file (pi treats an existing path as a file source
   * and re-reads it on resource reload): literal argv would be process-list-visible and
   * unbounded. Materialized once before the first spawn, retained for the backend
   * lifetime (process restarts reuse it), removed on disposal.
   */
  appendSystemPromptText?: string | null;
  toolsBridgeConfigText?: string | null;
  permissionHandler?: AcpPermissionHandler;
};

export class PiRpcBackend implements AgentBackend {
  readonly options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    happierSessionId: string | null;
    appendSystemPromptText: string | null;
    toolsBridgeConfigText: string | null;
  }>;

  private process: ChildProcessWithoutNullStreams | null = null;
  private appendSystemPromptArtifact: ProtectedTempTextArtifact | null = null;
  private toolsBridgeConfigArtifact: ProtectedTempTextArtifact | null = null;
  private readonly availableCommandNames = new Set<string>();
  private readonly availableExtensionCommandNames = new Set<string>();
  private stdoutLineReader: PiRpcJsonlLineReader | null = null;
  private stderrLineReader: PiRpcJsonlLineReader | null = null;
  private readonly messageHandlers = new Set<AgentMessageHandler>();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly openPromptRequestIds = new Set<string>();
  private readonly activeExtensionUiRequestIds = new Set<string>();
  private readonly permissionHandler: AcpPermissionHandler | null;
  private pendingTurn: PendingTurn | null = null;
  private pendingTurnBarrier: Deferred<void> | null = null;
  private sessionId: string | null = null;
  private sessionFile: string | null = null;
  private lastAuthJsonMtimeMs: number | null = null;
  private authRestartPendingMtimeMs: number | null = null;
  private authRestartInFlight: Promise<void> | null = null;
  private processTransitionInFlight: Promise<void> | null = null;
  private currentModelProvider: string | null = null;
  private readonly modelProviderById = new Map<string, string>();
  private sessionModelState: { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string; modelOptions?: unknown[] }> } | null =
    null;
  private lastPublishedUsageKey: string | null = null;
  /** Latest live context telemetry parsed from the bridge extension's stderr markers, if any. */
  private latestContextTelemetry: PiContextTelemetry | null = null;
  private assistantBoundaryContextTelemetry: PiContextTelemetry | null = null;
  private assistantMessageEndAwaitingContextTelemetry = false;
  /** Serializes usage-stats publishes so overlapping triggers cannot double-emit. */
  private usageStatsPublishChain: Promise<void> = Promise.resolve();
  private readonly connectedServiceRuntimeAuthAdapter = createPiConnectedServiceRuntimeAuthAdapter();
  private disposed = false;
  /**
   * Memoized once-per-session broker preflight (fail-closed). Broker readiness is a launch-time fact
   * (extension asset on disk + daemon bridge reachable + extension actually loaded), so verify once and
   * enforce before startup/prompt commands. Native + direct-API-key sessions resolve `ready: true`
   * (no-op).
   */
  private connectedBrokerPreflight: Promise<PiBrokerReadiness> | null = null;
  private anonymousCompactionSequence = 0;
  private activeCompactionLifecycleId: string | null = null;
  /** Bounded tail of recent raw stderr lines, retained only to enrich a non-zero process-exit (O2). */
  private readonly recentStderrLines: string[] = [];

  constructor(options: PiRpcSpawnOptions) {
    this.permissionHandler = options.permissionHandler ?? null;
    this.options = {
      cwd: options.cwd,
      command: options.command,
      args: [...options.args],
      env: { ...(options.env ?? {}) },
      happierSessionId: asNonEmptyString(options.happierSessionId) ?? null,
      appendSystemPromptText:
        typeof options.appendSystemPromptText === 'string' && options.appendSystemPromptText.trim().length > 0
          ? options.appendSystemPromptText
          : null,
      toolsBridgeConfigText: asNonEmptyString(options.toolsBridgeConfigText) ?? null,
    };
  }

  onMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  async startSession(
    _initialPrompt?: string,
    options?: AgentSessionOpenOptions,
  ): Promise<StartSessionResult> {
    const lifecycle = this.createSessionOpenLifecycle(options?.signal);
    await this.ensureProcess();
    await this.ensureConnectedBrokerReady(lifecycle);
    this.emitMessage({ type: 'status', status: 'starting' });

    const stateBefore = await this.getState(
      this.resolveSessionOpenRemainingMs(lifecycle),
      this.createSessionOpenCommandOptions(lifecycle),
    );
    const existingSessionId = asNonEmptyString(stateBefore.sessionId);
    const existingSessionFile = asNonEmptyString(stateBefore.sessionFile);
    if (existingSessionId) {
      this.sessionId = existingSessionId;
      this.sessionFile = existingSessionFile;
      await this.captureAuthJsonSnapshot();
      await this.publishRuntimeState(stateBefore);
      this.emitMessage({ type: 'status', status: 'idle' });
      return { sessionId: existingSessionId };
    }

    const created = await this.sendProviderAffectingCommand(
      { type: 'new_session' },
      this.resolveSessionOpenRemainingMs(lifecycle),
      lifecycle,
    );
    if ((asRecord(created.data)?.cancelled ?? false) === true) {
      throw new Error('Pi cancelled new_session');
    }

    const stateAfter = await this.getState(
      this.resolveSessionOpenRemainingMs(lifecycle),
      this.createSessionOpenCommandOptions(lifecycle),
    );
    const nextSessionId = asNonEmptyString(stateAfter.sessionId);
    const nextSessionFile = asNonEmptyString(stateAfter.sessionFile);
    if (!nextSessionId) {
      throw new Error('Pi did not return a session id');
    }

    this.sessionId = nextSessionId;
    this.sessionFile = nextSessionFile;
    await this.captureAuthJsonSnapshot();
    await this.publishRuntimeState(stateAfter);
    this.emitMessage({ type: 'status', status: 'idle' });
    return { sessionId: nextSessionId };
  }

  private async resolveSessionFileForSessionId(
    expectedSessionId: string,
    preferredAbsolutePath: string | null = null,
    requireMatchingHeader = false,
  ): Promise<string | null> {
    const candidateDirs = new Set<string>();
    const fromSessionEnv = asNonEmptyString(this.options.env.PI_CODING_AGENT_SESSION_DIR);
    if (fromSessionEnv) {
      candidateDirs.add(join(fromSessionEnv, '--workdir--'));
      candidateDirs.add(fromSessionEnv);
    }

    const fromEnv = asNonEmptyString(this.options.env.PI_CODING_AGENT_DIR);
    const encodedCwd = formatPiSessionDirectoryForCwd(this.options.cwd);
    if (fromEnv) {
      candidateDirs.add(fromEnv);
      candidateDirs.add(join(fromEnv, 'sessions', encodedCwd));
      candidateDirs.add(join(fromEnv, 'sessions'));
      const materializedRoot = dirname(fromEnv);
      candidateDirs.add(join(materializedRoot, 'pi-sessions', '--workdir--'));
      candidateDirs.add(join(materializedRoot, 'pi-sessions'));
    }

    if (preferredAbsolutePath) candidateDirs.add(dirname(preferredAbsolutePath));
    if (this.sessionFile) candidateDirs.add(dirname(this.sessionFile));

    const matches: Array<{ path: string; mtimeMs: number }> = [];
    const visited = new Set<string>();
    const queue: Array<{ dir: string; depth: number }> = [];
    const maxDepth = 4;
    const enqueue = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      if (visited.has(dir)) return;
      visited.add(dir);
      queue.push({ dir, depth });
    };
    for (const dir of candidateDirs) enqueue(dir, 0);

    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      try {
        const entries = await readdir(next.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (next.depth < maxDepth) enqueue(join(next.dir, entry.name), next.depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          const name = entry.name;
          if (!doesPiSessionFileNameMatchSessionId(name, expectedSessionId)) continue;
          const path = join(next.dir, name);
          try {
            const s = await stat(path);
            if (!s.isFile()) continue;
            if (requireMatchingHeader && await readPiSessionHeaderId(path) !== expectedSessionId) continue;
            matches.push({ path, mtimeMs: typeof s.mtimeMs === 'number' ? s.mtimeMs : 0 });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path));
    return matches[0]?.path ?? null;
  }

  async loadSession(
    sessionId: SessionId,
    options?: AgentSessionOpenOptions,
  ): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Pi backend is disposed');
    }

    const requestedResumeReference = String(sessionId ?? '').trim();
    if (!requestedResumeReference) {
      throw new Error('Pi loadSession requires a session id');
    }
    const requestedAbsoluteSessionFile = isAbsolute(requestedResumeReference) ? requestedResumeReference : null;
    if (!requestedAbsoluteSessionFile && !isBarePiSessionId(requestedResumeReference)) {
      throw new Error('Pi loadSession requires a bare Pi session id or absolute session file path');
    }

    const expectedSessionId = resolvePiSessionIdFromResumeReference(requestedResumeReference);
    if (!expectedSessionId) {
      throw new Error('Pi loadSession requires a bare Pi session id or absolute session file path');
    }

    // If we're already attached to a session, validate that it matches.
    if (this.sessionId) {
      if (this.sessionId !== expectedSessionId) {
        throw new Error(`Pi session mismatch (expected ${expectedSessionId}, got ${this.sessionId})`);
      }
      return { sessionId: this.sessionId };
    }

    if (this.pendingTurn) {
      throw new Error('Cannot load Pi session while a turn is in-flight');
    }

    // `--session <path-or-id>` is Pi's deterministic resume primitive.
    // We intentionally avoid `--continue` here because it resumes "most recent", which can be the wrong
    // session when multiple sessions exist in PI_CODING_AGENT_DIR.
    this.emitMessage({ type: 'status', status: 'starting' });
    const lifecycle = this.createSessionOpenLifecycle(options?.signal);
    try {
      const preferredSessionFile = requestedAbsoluteSessionFile && await pathIsFile(requestedAbsoluteSessionFile)
        ? requestedAbsoluteSessionFile
        : null;
      const sessionFile = preferredSessionFile
        ?? await this.resolveSessionFileForSessionId(expectedSessionId, requestedAbsoluteSessionFile);
      const sessionArg = sessionFile ?? expectedSessionId;
      const state = await this.runProcessTransition(async () => await this.replaceRpcProcessForSession({
        expectedSessionId,
        sessionArg,
        lifecycle,
      }));

      this.sessionId = expectedSessionId;
      this.sessionFile = asNonEmptyString(state.sessionFile) ?? sessionFile;
      await this.captureAuthJsonSnapshot();
      await this.publishRuntimeState(state);
      this.emitMessage({ type: 'status', status: 'idle' });
      return { sessionId: expectedSessionId };
    } catch (error) {
      this.sessionId = null;
      throw error;
    }
  }

  /**
   * Exposed for best-effort model probing (see `capabilities/probes/agentModelsProbe.ts`).
   * This mirrors the ACP `getSessionModelState` shape.
   */
  getSessionModelState(): { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null {
    return this.sessionModelState;
  }

  /**
   * Fail-closed broker preflight before startup/prompt commands. For brokered connected sessions, the
   * stored credential carries NO real refresh token — it only works if the Happier broker extension
   * actually loaded and the daemon bridge is reachable. Verify that once; if not ready, throw a clear
   * error rather than letting Pi attempt a request with a non-functional brokered credential. Native +
   * direct-API-key sessions short-circuit to ready (no broker env present) so this is a strict no-op.
   */
  private createSessionOpenLifecycle(signal?: AbortSignal): PiRpcSessionOpenLifecycle {
    return {
      deadlineMs: Date.now() + PI_RPC_SESSION_OPEN_TIMEOUT_MS,
      signal,
    };
  }

  private resolveSessionOpenRemainingMs(lifecycle: PiRpcSessionOpenLifecycle): number {
    return Math.max(1, lifecycle.deadlineMs - Date.now());
  }

  private createSessionOpenCommandOptions(
    lifecycle: PiRpcSessionOpenLifecycle,
  ): PiRpcCommandOptions {
    return {
      processAlreadyEnsured: true,
      signal: lifecycle.signal,
      createCancellationError: () => new PiBrokerReadinessError('broker_readiness_cancelled'),
    };
  }

  private async ensureConnectedBrokerReady(
    lifecycle: PiRpcSessionOpenLifecycle = this.createSessionOpenLifecycle(),
  ): Promise<void> {
    const owningProcess = this.process;
    this.connectedBrokerPreflight ??= verifyPiBrokerReadyForConnectedSession(this.options.env, {
      deadlineMs: lifecycle.deadlineMs,
      signal: lifecycle.signal,
      isProcessActive: owningProcess
        ? () => this.disposed === false && this.process === owningProcess
        : undefined,
    });
    const readiness = await this.connectedBrokerPreflight;
    if (!readiness.ready) {
      // Reset so a transient miss (e.g. handshake still in flight) can be re-verified on retry.
      this.connectedBrokerPreflight = null;
      throw new PiBrokerReadinessError(readiness.reason);
    }
  }

  private async ensureConnectedBrokerReadyForProviderCommand(
    lifecycle?: PiRpcSessionOpenLifecycle,
  ): Promise<void> {
    await this.ensureProcess();
    await this.ensureConnectedBrokerReady(lifecycle);
  }

  private async sendProviderAffectingCommand(
    command: PiRpcCommandWithoutId,
    timeoutMs = 30_000,
    lifecycle?: PiRpcSessionOpenLifecycle,
  ): Promise<PiRpcResponse> {
    await this.ensureConnectedBrokerReadyForProviderCommand(lifecycle);
    return this.sendCommand(
      command,
      timeoutMs,
      lifecycle
        ? this.createSessionOpenCommandOptions(lifecycle)
        : { processAlreadyEnsured: true },
    );
  }

  private refreshPiBrokerLoadNonceForNextSpawn(): void {
    const selections = parsePiBrokerSelections(this.options.env[PI_BROKER_SELECTIONS_ENV]);
    const hasBrokeredProvider = PI_BROKER_PROVIDERS.some((provider) => selections[provider]);
    if (!hasBrokeredProvider) return;
    this.options.env[PI_BROKER_LOAD_NONCE_ENV] = randomUUID();
    this.connectedBrokerPreflight = null;
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await this.sendPromptWithAdmission(sessionId, prompt).completion;
  }

  isProviderNativeCommand(prompt: string): boolean {
    const name = this.readProviderNativeCommandName(prompt);
    return name.length > 0 && this.availableCommandNames.has(name);
  }

  private isProviderExtensionCommand(prompt: string): boolean {
    const name = this.readProviderNativeCommandName(prompt);
    return name.length > 0 && this.availableExtensionCommandNames.has(name);
  }

  private readProviderNativeCommandName(prompt: string): string {
    if (!prompt.startsWith('/')) return '';
    const spaceIndex = prompt.indexOf(' ');
    return spaceIndex === -1 ? prompt.slice(1) : prompt.slice(1, spaceIndex);
  }

  async sendPromptWithEvidence(
    sessionId: SessionId,
    prompt: string,
  ): Promise<AcpPromptSubmissionEvidence> {
    const outcome = await this.sendPromptWithAdmission(sessionId, prompt).admission;
    if (outcome.status === 'accepted') {
      return { kind: 'accepted_without_exact_final_response' };
    }
    throw new AcpPromptSubmissionPhaseError(outcome.status, outcome.error);
  }

  sendPromptWithAdmission(sessionId: SessionId, prompt: string): Readonly<{
    admission: Promise<
      | { status: 'accepted' }
      | { status: 'rejected_before_effect'; error: Error }
      | { status: 'effect_may_have_occurred'; error: Error }
    >;
    completion: Promise<void>;
  }> {
    const admission = createDeferred<
      | { status: 'accepted' }
      | { status: 'rejected_before_effect'; error: Error }
      | { status: 'effect_may_have_occurred'; error: Error }
    >();
    let admissionSettled = false;
    const settleAdmission = (outcome: Awaited<typeof admission.promise>): void => {
      if (admissionSettled) return;
      admissionSettled = true;
      admission.resolve(outcome);
    };
    const completion = this.sendPromptAndObserveCompletion(sessionId, prompt, settleAdmission);
    void completion.catch((error: unknown) => {
      settleAdmission({ status: 'rejected_before_effect', error: asError(error) });
    });
    return { admission: admission.promise, completion };
  }

  private async sendPromptAndObserveCompletion(
    sessionId: SessionId,
    prompt: string,
    settleAdmission: (outcome:
      | { status: 'accepted' }
      | { status: 'rejected_before_effect'; error: Error }
      | { status: 'effect_may_have_occurred'; error: Error }
    ) => void,
  ): Promise<void> {
    this.assertSession(sessionId);
    await this.ensureConnectedBrokerReady();
    let providerSendAttempted = false;

    const barrier = createDeferred<void>();
    // The barrier is observed only by concurrent waitForResponseComplete callers. Attach a handler
    // immediately so a rejected pre-admission transition cannot become an unhandled rejection when
    // no waiter exists; awaiting the original promise still preserves its rejection semantics.
    void barrier.promise.catch(() => undefined);
    this.pendingTurnBarrier = barrier;
    const settleBarrier = (error?: Error) => {
      if (this.pendingTurnBarrier !== barrier) return;
      this.pendingTurnBarrier = null;
      if (error) {
        barrier.reject(error);
        return;
      }
      barrier.resolve(undefined);
    };

    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    try {
      if (maybeRestart) await maybeRestart;
      if (!prompt.trim()) {
        settleAdmission({ status: 'rejected_before_effect', error: new Error('Prompt text is blank') });
        settleBarrier();
        return;
      }
      const message = prompt;

      // Ensure we have a live process *before* allocating a pending turn.
      // If the process died between turns, `ensureProcess()` may need to restart and reattach via --session.
      await this.ensureProcess();
      await this.ensureConnectedBrokerReady();

      settleBarrier();

      if (this.pendingTurn) {
        const existingPendingTurn = this.pendingTurn;
        await this.waitForPromptCollisionToBecomeIdle();
        if (this.pendingTurn === existingPendingTurn) {
          await Promise.race([
            existingPendingTurn.promise.catch(() => undefined),
            delay(this.getAgentEndSettleMs() + this.getPromptCollisionIdlePollMs()),
          ]);
        }
        if (this.pendingTurn) throw new Error('Pi is already processing another prompt');
      }

      await this.ensureConnectedBrokerReadyForProviderCommand();
      const providerExtensionCommand = this.isProviderExtensionCommand(message);
      const pendingTurn = this.createPendingTurn(this.getPendingTurnStallTimeoutMs());
      const turn = pendingTurn.promise;
      providerSendAttempted = true;
      try {
        await this.sendCommand({ type: 'prompt', message }, 30_000, { processAlreadyEnsured: true });
      } catch (error) {
        const promptError = asError(error);
        settleAdmission(promptError instanceof PiRpcPromptRejectedBeforeEffectError
          ? { status: 'rejected_before_effect', error: promptError }
          : { status: 'effect_may_have_occurred', error: promptError });
        this.rejectPendingTurn(promptError);
        await turn.catch(() => undefined);
        throw promptError;
      }
      settleAdmission({ status: 'accepted' });
      if (
        providerExtensionCommand
        && pendingTurn
        && this.isCurrentPendingTurn(pendingTurn)
        && !pendingTurn.agentStartObserved
      ) {
        // Pi acknowledges an extension command after its handler returns, but a handler may
        // schedule an Agent turn whose event follows the acknowledgement. Reuse the existing
        // event-ordering grace before deciding that the command was handled without a turn.
        await delay(this.getAgentEndSettleMs());
        const state = await this.getState().catch(() => null);
        if (
          this.isCurrentPendingTurn(pendingTurn)
          && !pendingTurn.agentStartObserved
          && state?.isStreaming !== true
          && state?.isCompacting !== true
        ) {
          this.resolvePendingTurn();
        }
      }
      await turn;
      return;
    } catch (error) {
      const promptError = asError(error);
      settleAdmission(providerSendAttempted
        ? { status: 'effect_may_have_occurred', error: promptError }
        : { status: 'rejected_before_effect', error: promptError });
      settleBarrier(asError(error));
      throw error;
    }
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const message = prompt.trim();
    if (!message) return;
    if (!this.process) {
      throw new Error('Pi process is not running');
    }
    await this.ensureConnectedBrokerReady();
    await this.sendCommand({ type: 'steer', message }, 30_000, { processAlreadyEnsured: true });
  }

  async compactContext(sessionId: SessionId, command: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const customInstructions = parseCompactInstructions(command);
    await this.sendProviderAffectingCommand({
      type: 'compact',
      ...(customInstructions ? { customInstructions } : {}),
    }, 240_000);
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const normalized = modelId.trim();
    if (!normalized) return;

    const selection = await this.resolveModelSelection(normalized);
    await this.sendProviderAffectingCommand({ type: 'set_model', provider: selection.provider, modelId: selection.modelId }, 60_000);
    this.currentModelProvider = selection.provider;
    await this.publishRuntimeState(await this.getState());
  }

  async setSessionConfigOption(sessionId: SessionId, configId: string, value: string | number | boolean | null): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;

    const normalizedId = typeof configId === 'string' ? configId.trim().toLowerCase() : '';
    if (!normalizedId) return;

    // Pi's RPC supports `set_thinking_level`. We expose it through the generic model-scoped option id.
    if (normalizedId !== 'reasoning_effort') return;

    const level = normalizePiThinkingEffort(value);
    if (!level) return;

    await this.sendProviderAffectingCommand({ type: 'set_thinking_level', level }, 30_000);
    await this.publishRuntimeState(await this.getState());
  }

  async cancel(sessionId: SessionId): Promise<void> {
    this.assertSession(sessionId);
    await abortPendingAcpPermissionRequests(this.permissionHandler, 'Pi turn cancelled');
    await this.sendCommand({ type: 'abort' });
    if (this.pendingTurn) await this.pendingTurn.promise;
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    if (!this.pendingTurn && this.pendingTurnBarrier) {
      await this.pendingTurnBarrier.promise;
    }
    if (!this.pendingTurn) return;
    const turn = this.pendingTurn;

    const stallTimeoutMs =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : null;

    if (stallTimeoutMs === null) {
      await turn.promise;
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        turn.promise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for Pi response completion'));
          }, stallTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    await abortPendingAcpPermissionRequests(this.permissionHandler, 'Pi backend disposed');

    this.rejectAllPending(new Error('Pi backend disposed'));
    this.rejectPendingTurn(new Error('Pi backend disposed'));

    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
    if (this.stderrLineReader) {
      this.stderrLineReader.close();
      this.stderrLineReader = null;
    }

    const child = this.process;
    this.process = null;

    // Terminal path: remove the protected append-system-prompt artifact with the backend.
    if (!child) {
      await this.cleanupProtectedSpawnArtifacts();
      return;
    }

    try {
      await stopPiRpcProcess(child);
    } finally {
      await this.cleanupProtectedSpawnArtifacts();
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.disposed) {
      throw new Error('Pi backend is disposed');
    }
    if (this.process) return;
    if (this.sessionId) {
      // Best-effort recovery: if we have an established session id but the process is gone, attempt to
      // restart and reattach to the same session via `--session`.
      await this.restartAndContinue();
      return;
    }

    await this.runProcessTransition(async () => {
      if (this.disposed) throw new Error('Pi backend is disposed');
      if (this.process) return;
      const protectedArgs = await this.resolveProtectedSpawnArtifactArgs();
      if (this.disposed) {
        await this.cleanupProtectedSpawnArtifacts();
        throw new Error('Pi backend is disposed');
      }
      if (this.process) return;
      this.spawnRpcProcess({ args: [...this.options.args, ...protectedArgs] });
    });
  }

  private async cleanupProtectedSpawnArtifacts(): Promise<void> {
    const appendSystemPromptArtifact = this.appendSystemPromptArtifact;
    this.appendSystemPromptArtifact = null;
    const toolsBridgeConfigArtifact = this.toolsBridgeConfigArtifact;
    this.toolsBridgeConfigArtifact = null;
    await Promise.all([
      appendSystemPromptArtifact?.cleanup(),
      toolsBridgeConfigArtifact?.cleanup(),
    ]);
  }

  /**
   * `--append-system-prompt` arguments for the current backend lifetime. The prompt text
   * is materialized into a protected temporary file once; pi resolves an existing path as
   * a file source and re-reads it on resource reload, so restarts within this backend
   * reuse the same artifact. Materialization failure rejects and prevents the spawn.
   */
  private async resolveAppendSystemPromptArgs(): Promise<string[]> {
    const text = this.options.appendSystemPromptText;
    if (!text) return [];
    if (!this.appendSystemPromptArtifact) {
      this.appendSystemPromptArtifact = await materializeProtectedTempTextArtifact({
        prefix: 'happier-pi-append-system-prompt-',
        contents: text,
      });
    }
    return ['--append-system-prompt', this.appendSystemPromptArtifact.path];
  }

  private async resolveToolsBridgeConfigArgs(): Promise<string[]> {
    const text = this.options.toolsBridgeConfigText;
    if (!text) return [];
    if (!this.toolsBridgeConfigArtifact) {
      this.toolsBridgeConfigArtifact = await materializeProtectedTempTextArtifact({
        prefix: 'happier-pi-tools-bridge-config-',
        contents: text,
      });
    }
    return [`--${PI_BRIDGE_CONFIG_PATH_FLAG}`, this.toolsBridgeConfigArtifact.path];
  }

  private async resolveProtectedSpawnArtifactArgs(): Promise<string[]> {
    return [
      ...(await this.resolveToolsBridgeConfigArgs()),
      ...(await this.resolveAppendSystemPromptArgs()),
    ];
  }

  private spawnRpcProcess(params: Readonly<{ args: string[] }>): void {
    this.refreshPiBrokerLoadNonceForNextSpawn();
    const child = spawn(this.options.command, params.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: 'pipe',
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Failed to start Pi RPC process with piped stdio');
    }

    const spawnedChild = child as ChildProcessWithoutNullStreams;
    this.process = spawnedChild;
    const stdoutLineReader = attachPiRpcJsonlLineReader(child.stdout, (line) => {
      if (this.process === spawnedChild) this.handleStdoutLine(line);
    });
    const stderrLineReader = attachPiRpcJsonlLineReader(child.stderr, (line) => {
      if (this.process === spawnedChild) this.handleStderrLine(line);
    });
    this.stdoutLineReader = stdoutLineReader;
    this.stderrLineReader = stderrLineReader;

    const detachSpawnedChild = () => {
      if (this.process !== spawnedChild) return;
      this.process = null;
      stdoutLineReader.close();
      stderrLineReader.close();
      if (this.stdoutLineReader === stdoutLineReader) this.stdoutLineReader = null;
      if (this.stderrLineReader === stderrLineReader) this.stderrLineReader = null;
      void this.cleanupProtectedSpawnArtifacts();
    };

    const handleIoError = (error: unknown) => {
      if (this.process !== spawnedChild) return;
      const resolved = asError(error);
      if (!this.disposed) {
        this.emitMessage({
          type: 'status',
          status: 'error',
          detail: `Pi IO error: ${resolved.message}`,
        });
      }
      this.rejectAllPending(new Error(`Pi IO error: ${resolved.message}`));
      this.rejectPendingTurn(new Error('Pi process terminated'));
    };

    // Defensive: avoid unhandled EPIPE on stdio streams when the subprocess exits between turns.
    child.stdin.on('error', handleIoError);
    child.stdout.on('error', handleIoError);
    child.stderr.on('error', handleIoError);

    child.on('error', (error) => {
      if (this.process !== spawnedChild) return;
      this.emitMessage({
        type: 'status',
        status: 'error',
        detail: `Pi process error: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.rejectAllPending(new Error(`Pi process error: ${error instanceof Error ? error.message : String(error)}`));
      this.rejectPendingTurn(new Error('Pi process terminated'));
      detachSpawnedChild();
    });

    child.on('exit', (code, signal) => {
      if (this.process !== spawnedChild) return;
      if (!this.disposed) {
        const detail = code === 0
          ? `Pi process exited (code=0, signal=${signal ?? 'null'})`
          : this.buildProcessExitContextDetail(code, signal);
        this.emitMessage({
          type: 'status',
          status: code === 0 ? 'stopped' : 'error',
          detail,
        });
      }
      this.rejectAllPending(new Error('Pi process exited'));
      if (code === 0 && this.pendingTurn?.agentEndSettleTimeout) {
        this.resolvePendingTurn();
      } else if (code === 0 && this.pendingTurn?.compactionResumeTimeout) {
        this.resolvePendingTurnAsCompactionPaused(this.pendingTurn);
      } else {
        this.rejectPendingTurn(new Error('Pi process exited'));
      }
      detachSpawnedChild();
    });
  }

  private resolveAuthJsonPath(): string | null {
    const agentDir = asNonEmptyString(this.options.env.PI_CODING_AGENT_DIR);
    if (!agentDir) return null;
    return join(agentDir, 'auth.json');
  }

  /**
   * O2: build a structured, debuggable detail for a non-zero Pi process exit. Instead of a bare
   * "Pi process exited", surface the load-bearing context an operator needs to diagnose a failed
   * resume — exit code/signal, the vendor resume id, the cwd, the materialized agent dir +
   * connected-service materialization root, and a redacted tail of stderr. Pairs with the K1 §2
   * fail-closed gate: the gate prevents most missing-file crashes up front; this explains the rest.
   */
  private buildProcessExitContextDetail(code: number | null, signal: NodeJS.Signals | null): string {
    const fields: string[] = [
      `code=${code ?? 'null'}`,
      `signal=${signal ?? 'null'}`,
      `cwd=${this.options.cwd}`,
      `vendorResumeId=${this.sessionId ?? 'null'}`,
    ];
    const agentDir = asNonEmptyString(this.options.env.PI_CODING_AGENT_DIR);
    if (agentDir) fields.push(`agentDir=${agentDir}`);
    const materializationRoot = asNonEmptyString(
      this.options.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY],
    );
    if (materializationRoot) fields.push(`materializationRoot=${materializationRoot}`);
    const stderrTail = this.recentStderrLines.slice(-PI_RPC_STDERR_TAIL_MAX_LINES).join(' | ');
    if (stderrTail) fields.push(`stderrTail=${redactBugReportSensitiveText(stderrTail)}`);
    return `Pi process exited (${fields.join(', ')})`;
  }

  private async captureAuthJsonSnapshot(): Promise<void> {
    const authPath = this.resolveAuthJsonPath();
    if (!authPath) return;
    try {
      const s = await stat(authPath);
      this.lastAuthJsonMtimeMs = typeof s.mtimeMs === 'number' && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
    } catch {
      this.lastAuthJsonMtimeMs = null;
    }
  }

  private isCurrentPiProviderBrokered(): boolean {
    const currentProvider = this.currentModelProvider;
    if (!currentProvider) return false;
    const selections = parsePiBrokerSelections(this.options.env[PI_BROKER_SELECTIONS_ENV]);
    return PI_BROKER_PROVIDERS.some((provider) => (
      selections[provider] !== undefined && piRegisterProviderId(provider) === currentProvider
    ));
  }

  private maybeRestartForUpdatedAuthJson(): Promise<void> | void {
    if (this.disposed) return;
    if (!this.sessionId) return;
    if (!this.process) return;
    // Brokered credentials are refreshed by the daemon bridge and re-fed by the Pi extension. The
    // catalog declares these selected provider shapes as no-restart, so the local auth.json mtime
    // watcher must not compete with that lifecycle owner.
    if (this.isCurrentPiProviderBrokered()) return;

    const authPath = this.resolveAuthJsonPath();
    if (!authPath) return;

    return (async () => {
      if (this.authRestartInFlight) {
        // If a restart is already in-flight, await it when we're idle, but never block an in-flight turn.
        if (this.pendingTurn) return;
        await this.authRestartInFlight;
        return;
      }

      // If we already observed an auth change during a turn, defer stat + restart until idle.
      if (this.pendingTurn && this.authRestartPendingMtimeMs !== null) {
        return;
      }

      let nextMtimeMs: number | null = null;
      try {
        const s = await stat(authPath);
        nextMtimeMs = typeof s.mtimeMs === 'number' && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
      } catch {
        return;
      }

      if (this.lastAuthJsonMtimeMs === null) {
        this.lastAuthJsonMtimeMs = nextMtimeMs;
        return;
      }
      if (nextMtimeMs === null || nextMtimeMs === this.lastAuthJsonMtimeMs) return;

      if (this.pendingTurn) {
        // Auth changed mid-turn: never restart while Pi is streaming a response.
        this.authRestartPendingMtimeMs = nextMtimeMs;
        return;
      }

      // Idle boundary: replace only when the vendor session is durably resumable. Once the old child
      // has been destroyed, a failed replacement is fatal to this admission attempt and propagates.
      this.authRestartInFlight = (async () => {
        try {
          const restarted = await this.restartAndContinue({ requireDurableSessionFile: true });
          if (!restarted) {
            this.authRestartPendingMtimeMs = nextMtimeMs;
            return;
          }
          this.lastAuthJsonMtimeMs = nextMtimeMs;
          this.authRestartPendingMtimeMs = null;
          await this.captureAuthJsonSnapshot();
        } catch (error) {
          this.authRestartPendingMtimeMs = nextMtimeMs;
          throw error;
        } finally {
          this.authRestartInFlight = null;
        }
      })();

      await this.authRestartInFlight;
    })();
  }

  private async restartAndContinue(
    options: Readonly<{ requireDurableSessionFile?: boolean }> = {},
  ): Promise<boolean> {
    const expectedSessionId = this.sessionId;
    if (!expectedSessionId) return false;
    if (this.pendingTurn) {
      throw new Error('Cannot restart Pi while a turn is in-flight');
    }

    const sessionFile = await this.resolveSessionFileForSessionId(
      expectedSessionId,
      this.sessionFile,
      options.requireDurableSessionFile === true,
    );
    if (options.requireDurableSessionFile === true && !sessionFile) {
      return false;
    }
    const sessionArg = sessionFile ?? expectedSessionId;
    const state = await this.runProcessTransition(async () => await this.replaceRpcProcessForSession({
      expectedSessionId,
      sessionArg,
    }));
    this.sessionFile = asNonEmptyString(state.sessionFile) ?? sessionFile;
    await this.publishRuntimeState(state);
    this.emitMessage({ type: 'status', status: 'idle' });
    return true;
  }

  private async runProcessTransition<T>(operation: () => Promise<T>): Promise<T> {
    while (this.processTransitionInFlight) {
      await this.processTransitionInFlight;
    }
    const operationPromise = operation();
    const gate = operationPromise.then(() => undefined, () => undefined);
    this.processTransitionInFlight = gate;
    try {
      return await operationPromise;
    } finally {
      if (this.processTransitionInFlight === gate) {
        this.processTransitionInFlight = null;
      }
    }
  }

  private async replaceRpcProcessForSession(params: Readonly<{
    expectedSessionId: string;
    sessionArg: string;
    lifecycle?: PiRpcSessionOpenLifecycle;
  }>): Promise<PiRpcStateData> {
    await this.stopRpcProcessForRestart();
    const protectedArgs = await this.resolveProtectedSpawnArtifactArgs();
    if (this.disposed) {
      await this.cleanupProtectedSpawnArtifacts();
      throw new Error('Pi backend is disposed');
    }
    this.spawnRpcProcess({
      args: [
        ...this.options.args,
        ...protectedArgs,
        '--session',
        params.sessionArg,
      ],
    });

    try {
      const lifecycle = params.lifecycle ?? this.createSessionOpenLifecycle();
      await this.ensureConnectedBrokerReady(lifecycle);
      const state = await this.getState(
        this.resolveSessionOpenRemainingMs(lifecycle),
        this.createSessionOpenCommandOptions(lifecycle),
      );
      const nextSessionId = asNonEmptyString(state.sessionId);
      if (!nextSessionId) {
        throw new Error('Pi did not return a session id after --session');
      }
      if (nextSessionId !== params.expectedSessionId) {
        throw new Error(
          `Pi session mismatch after --session (expected ${params.expectedSessionId}, got ${nextSessionId})`,
        );
      }
      return state;
    } catch (error) {
      // A successor is not usable until its reported identity matches. Stop every half-initialized
      // candidate before releasing the transition gate so no prompt can reach it.
      await this.stopRpcProcessForRestart();
      throw error;
    }
  }

  private async stopRpcProcessForRestart(): Promise<void> {
    await abortPendingAcpPermissionRequests(this.permissionHandler, 'Pi backend restarting');
    this.rejectAllPending(new Error('Pi restarting'));
    this.rejectPendingTurn(new Error('Pi restarting'));

    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
    if (this.stderrLineReader) {
      this.stderrLineReader.close();
      this.stderrLineReader = null;
    }

    const child = this.process;
    this.process = null;
    if (!child) return;

    await stopPiRpcProcess(child);
  }

  private isPiRpcFailureTraceEnabled(): boolean {
    return this.options.env[PI_RPC_FAILURE_TRACE_ENV] === '1' || process.env[PI_RPC_FAILURE_TRACE_ENV] === '1';
  }

  private tracePiRpcFailureBoundary(
    branch: string,
    record: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    if (!this.isPiRpcFailureTraceEnabled()) return;
    const id = asNonEmptyString(record.id);
    const pending = id ? this.pendingRequests.get(id) ?? null : null;
    const messageShape = buildPiRpcFailureTraceMessageShape(record.message);

    logger.debug('[pi] RPC failure trace', {
      branch,
      ...collectPiRpcFailureTraceScalars(record),
      idPresent: id !== null,
      idMatchesOpenPrompt: id !== null && this.openPromptRequestIds.has(id),
      hasPendingRequest: pending !== null,
      pendingCommandType: pending?.commandType ?? null,
      pendingTurnPresent: this.pendingTurn !== null,
      ...(messageShape ? { messageShape } : {}),
      ...sanitizePiRpcFailureTraceExtra(extra),
    });
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = (() => {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        this.emitMessage({ type: 'terminal-output', data: line });
        return null;
      }
    })();
    if (!parsed) return;

    const record = asRecord(parsed);
    if (!record) return;
    if (this.pendingTurn) {
      this.tracePiRpcFailureBoundary('stdout_record', record);
    }

    if (record.type === 'response') {
      this.handleResponse(record as PiRpcResponse);
      return;
    }

    this.handleEvent(record);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = asNonEmptyString(response.id);
    if (!id) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      if (response.command === 'prompt' && !response.success && this.openPromptRequestIds.has(id)) {
        this.tracePiRpcFailureBoundary('late_open_prompt_response', response);
        this.openPromptRequestIds.delete(id);
        this.surfacePiProviderFailure(normalizePiProviderFailure('post_acceptance_prompt', { error: response.error }));
      } else {
        this.tracePiRpcFailureBoundary('ignored_response_no_pending_request', response);
      }
      return;
    }

    if (this.pendingTurn || response.command === 'prompt' || !response.success) {
      this.tracePiRpcFailureBoundary('pending_request_response', response, {
        pendingCommandType: pending.commandType,
      });
    }
    this.clearPendingRpcRequest(id, pending);

    if (!response.success) {
      this.openPromptRequestIds.delete(id);
      const rawDetail = asNonEmptyString(response.error) ?? `Pi RPC command failed: ${response.command}`;
      if (pending.commandType === 'prompt') {
        this.tracePiRpcFailureBoundary('pending_prompt_failure_response', response, { detail: rawDetail });
        const failure = normalizePiProviderFailure('prompt_rejected', { error: rawDetail });
        this.logPiProviderFailure(failure);
        this.emitPiProviderFailureDiagnostic(failure.sanitizedPreview);
        pending.reject(Object.assign(
          new PiRpcPromptRejectedBeforeEffectError(failure.sanitizedPreview),
          { piProviderFailure: failure },
        ));
        return;
      }
      pending.reject(new Error(rawDetail));
      return;
    }
    if (pending.commandType === 'prompt') {
      this.openPromptRequestIds.add(id);
    }
    pending.resolve(response);
  }

  private readPiAssistantErrorMessage(event: Record<string, unknown>): string | null {
    if (event.type !== 'message_end') return null;
    const message = asRecord(event.message);
    if (!message || message.role !== 'assistant') return null;
    const stopReason = asNonEmptyString(message.stopReason ?? message.stop_reason);
    const errorMessage = asNonEmptyString(message.errorMessage ?? message.error_message ?? event.errorMessage ?? event.error_message);
    if (stopReason !== 'error' && !errorMessage) return null;
    return errorMessage ?? 'Pi assistant message failed';
  }

  private isRecoverablePiAssistantError(event: Record<string, unknown>): boolean {
    const classification = this.classifyPiAssistantRuntimeAuthFailure(event);
    if (classification) return classification.kind === 'capacity';
    const detail = this.readPiAssistantErrorMessage(event);
    return detail !== null && PI_RPC_RECOVERABLE_ASSISTANT_ERROR_PATTERN.test(detail);
  }

  private classifyPiAssistantRuntimeAuthFailure(event: Record<string, unknown>) {
    const message = asRecord(event.message);
    return this.classifyPiRuntimeAuthFailure({
      provider: asNonEmptyString(event.provider) ?? asNonEmptyString(message?.provider) ?? this.currentModelProvider,
      event,
      message,
    });
  }

  private classifyPiRuntimeAuthFailure(error: unknown) {
    return this.connectedServiceRuntimeAuthAdapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: this.sessionId },
      error,
      selection: readConnectedServiceChildSelectionsFromEnv(this.options.env),
    });
  }

  private createPiAssistantFailureError(
    detail: string,
    classification: ConnectedServiceRuntimeFailureClassification | null,
  ): Error {
    const error = new Error(detail);
    if (!classification) return error;
    return Object.assign(error, { runtimeAuthClassification: classification });
  }

  private isAcceptedPromptAwaitingAgentStart(): boolean {
    return this.pendingTurn !== null && !this.pendingTurn.agentStartObserved;
  }

  private async reportPiRuntimeAuthFailureToDaemon(
    classification: ConnectedServiceRuntimeFailureClassification,
  ): Promise<void> {
    if (!this.options.happierSessionId) return;
    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: this.options.happierSessionId,
      switchesThisTurn: 0,
      classification,
      logPrefix: '[pi]',
    });
    projectConnectedServiceRuntimeAuthRecoveryReport({
      report: recoveryReport,
      sendGenericStatusMessage: (message) => {
        this.emitMessage({ type: 'status', status: 'error', detail: message });
        return true;
      },
      commitTypedProjection: (projection) => {
        if (!projection.transcriptEvent) return false;
        this.emitMessage({
          type: 'event',
          name: 'connected-service-runtime-auth-recovery',
          payload: projection.transcriptEvent,
        });
        return true;
      },
    });
  }

  private handlePiAssistantFailureEvent(event: Record<string, unknown>): void {
    const detail = this.readPiAssistantErrorMessage(event);
    if (!detail) return;
    this.tracePiRpcFailureBoundary('assistant_failure_event_detail_present', event);
    if (this.isAcceptedPromptAwaitingAgentStart()) {
      // A resumed Pi RPC session can replay a stale assistant error just after accepting the next
      // prompt. Do not fail that new turn unless Pi has emitted agent_start for it first.
      return;
    }
    const failure = normalizePiProviderFailure('assistant_message_end', event);
    const classification = this.classifyPiAssistantRuntimeAuthFailure(event);
    if (this.pendingTurn) {
      this.pendingTurn.providerFailureDiagnostic ??= failure;
    }
    // Pi's overflow/server-capacity recovery *begins* with an assistant
    // `message_end{stopReason:'error'}` and then self-heals via compaction, retry, or resumed tool
    // activity. Terminating the turn here re-creates the original stuck-after-compaction bug:
    // premature completion clears `turnInFlight`, and the next queued prompt collides with a
    // still-busy Pi. Capacity errors such as Codex `server_is_overloaded` are therefore owned by the
    // turn lifecycle (`agent_end`/willRetry, the compaction-resume grace, and the `get_state`
    // liveness probe) instead of this event. The recoverable error carries no surfaceable assistant
    // text, so suppressing the status here does not hide anything from the transcript.
    if (this.isRecoverablePiAssistantError(event)) {
      if (classification) {
        void this.reportPiRuntimeAuthFailureToDaemon(classification);
      }
      return;
    }
    if (classification) {
      void this.reportPiRuntimeAuthFailureToDaemon(classification);
    }
    this.surfacePiProviderFailure(failure, classification);
  }

  private handlePiTurnFailedEvent(event: Record<string, unknown>): void {
    if (!this.pendingTurn) return;
    const failure = normalizePiProviderFailure('turn_failed', event);
    const detail = failure.sanitizedPreview;
    if (this.isAcceptedPromptAwaitingAgentStart()) {
      this.pendingTurn.preStartTerminalFailure ??= createPiProviderFailureError(failure);
      return;
    }
    this.tracePiRpcFailureBoundary('turn_failed_event_matched', event);
    this.surfacePiProviderFailure(failure);
  }

  private handlePiAssistantMessageEndTerminalFailureEvent(event: Record<string, unknown>): void {
    if (!this.pendingTurn) return;
    if (!isPiFailedAssistantTerminalEvent(event)) return;
    const failure = normalizePiProviderFailure('assistant_message_end', event);
    const detail = failure.sanitizedPreview;
    const classification = this.classifyPiAssistantRuntimeAuthFailure(event);
    if (this.isAcceptedPromptAwaitingAgentStart()) {
      this.pendingTurn.preStartTerminalFailure ??= Object.assign(
        createPiProviderFailureError(failure),
        classification ? { runtimeAuthClassification: classification } : {},
      );
      return;
    }
    this.tracePiRpcFailureBoundary('failed_assistant_terminal_event_matched', event);
    if (classification) {
      void this.reportPiRuntimeAuthFailureToDaemon(classification);
    }
    this.surfacePiProviderFailure(failure, classification);
  }

  private readCompactionLifecycleId(event: Record<string, unknown>): string | null {
    return (
      asNonEmptyString(event.compactionId) ??
      asNonEmptyString(event.compaction_id) ??
      asNonEmptyString(event.id) ??
      asNonEmptyString(event.turnId) ??
      asNonEmptyString(event.turn_id)
    );
  }

  private normalizeCompactionLifecycleEvent(event: Record<string, unknown>): Record<string, unknown> {
    if (event.type !== 'compaction_start' && event.type !== 'compaction_end') return event;

    const explicitLifecycleId = this.readCompactionLifecycleId(event);
    if (event.type === 'compaction_start') {
      const lifecycleId = explicitLifecycleId ?? `pi:context-compaction:${++this.anonymousCompactionSequence}`;
      this.activeCompactionLifecycleId = lifecycleId;
      return explicitLifecycleId ? event : { ...event, compactionId: lifecycleId };
    }

    const lifecycleId = explicitLifecycleId ?? this.activeCompactionLifecycleId ?? `pi:context-compaction:${++this.anonymousCompactionSequence}`;
    this.activeCompactionLifecycleId = null;
    return explicitLifecycleId ? event : { ...event, compactionId: lifecycleId };
  }

  private handleEvent(event: Record<string, unknown>): void {
    const extensionRequest = parsePiBlockingExtensionUiRequest(event);
    if (extensionRequest) {
      this.notePendingTurnActivity(event);
      void this.handleBlockingExtensionUiRequest(extensionRequest, this.process);
      return;
    }
    const normalizedEvent = this.normalizeCompactionLifecycleEvent(event);
    if (normalizedEvent.type === 'compaction_start' || normalizedEvent.type === 'compaction_end') {
      this.latestContextTelemetry = null;
      this.assistantBoundaryContextTelemetry = null;
      this.assistantMessageEndAwaitingContextTelemetry = false;
    }
    this.notePendingTurnActivity(normalizedEvent);

    const mappedMessages = mapPiRpcEventToAgentMessages(normalizedEvent);
    this.tracePiRpcFailureBoundary('event_mapped', normalizedEvent, {
      mappedAgentMessageTypes: mappedMessages.map((msg) => msg.type).slice(0, PI_RPC_FAILURE_TRACE_MAX_ARRAY_LENGTH),
    });

    for (const msg of mappedMessages) {
      this.emitMessage(msg);
    }

    this.handlePiAssistantFailureEvent(normalizedEvent);
    this.handlePiAssistantMessageEndTerminalFailureEvent(normalizedEvent);

    // Publish usage/context telemetry the moment an assistant message settles — BEFORE any
    // tool calls it requested start executing — so a slow tool call shows the fresh context
    // size on the badge instead of waiting for the whole turn to go idle. Gated on bridge
    // telemetry being present: only Happier-bound sessions (extension markers flowing) get
    // the mid-turn publish; plain embedders keep the idle-time cadence without extra
    // mid-turn RPC traffic.
    if (normalizedEvent.type === 'message_end') {
      const message = asRecord(normalizedEvent.message);
      if (message?.role === 'assistant') {
        this.assistantBoundaryContextTelemetry = null;
        if (this.latestContextTelemetry) {
          const contextTelemetry = this.latestContextTelemetry;
          this.latestContextTelemetry = null;
          this.assistantBoundaryContextTelemetry = contextTelemetry;
          this.assistantMessageEndAwaitingContextTelemetry = false;
          this.scheduleUsageStatsPublish(contextTelemetry);
        } else {
          this.assistantMessageEndAwaitingContextTelemetry = true;
        }
      }
    }

    if (normalizedEvent.type === 'turn_failed') {
      this.handlePiTurnFailedEvent(normalizedEvent);
      return;
    }

    if (normalizedEvent.type === 'agent_end') {
      if (this.pendingTurn) {
        if (!this.pendingTurn.agentStartObserved && this.pendingTurn.preStartTerminalFailure) {
          const failure = this.pendingTurn.preStartTerminalFailure;
          this.emitPiProviderFailureDiagnostic(failure.message);
          this.emitMessage({ type: 'status', status: 'error', detail: failure.message });
          this.rejectPendingTurn(failure);
          return;
        }
        if (normalizedEvent.willRetry === true) {
          this.pendingTurn.agentEndObserved = false;
          this.pendingTurn.agentEndActivityEpoch = null;
          this.cancelPendingTurnAgentEndSettle(this.pendingTurn);
          this.armPendingTurnInactivityTimer(this.pendingTurn);
        } else if (
          this.pendingTurn.recoverableAssistantErrorObserved
          && normalizedEvent.willRetry !== false
        ) {
          this.pendingTurn.agentEndObserved = false;
          this.pendingTurn.agentEndActivityEpoch = null;
          this.cancelPendingTurnAgentEndSettle(this.pendingTurn);
          this.armPendingTurnInactivityTimer(this.pendingTurn);
        } else if (this.pendingTurn.providerFailureDiagnostic) {
          this.surfacePiProviderFailure(this.pendingTurn.providerFailureDiagnostic);
          return;
        } else {
          this.pendingTurn.agentEndObserved = true;
          this.pendingTurn.agentEndActivityEpoch = this.pendingTurn.activityEpoch;
          this.schedulePendingTurnCompletion();
        }
      } else {
        this.emitMessage({ type: 'status', status: 'idle' });
        this.scheduleUsageStatsPublish();
      }
    }

    if (normalizedEvent.type === 'message_update') {
      const assistant = asRecord(normalizedEvent.assistantMessageEvent);
      const assistantType = asNonEmptyString(assistant?.type);
      if (assistantType === 'thinking_start') {
        this.emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: true } });
      } else if (assistantType === 'thinking_end' || assistantType === 'text_start' || assistantType === 'text_delta') {
        this.emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: false } });
      }
    }
  }

  private async handleBlockingExtensionUiRequest(
    request: NonNullable<ReturnType<typeof parsePiBlockingExtensionUiRequest>>,
    child: ChildProcessWithoutNullStreams | null,
  ): Promise<void> {
    if (!child || this.activeExtensionUiRequestIds.has(request.id)) return;
    this.activeExtensionUiRequestIds.add(request.id);
    let providerTimedOut = false;
    const timeout = typeof request.timeout === 'number'
      ? setTimeout(() => {
        providerTimedOut = true;
        this.permissionHandler?.cancelPendingRequest?.(request.id, 'Pi extension dialog timed out');
      }, request.timeout)
      : null;
    timeout?.unref?.();
    try {
      const result = this.permissionHandler
        ? await this.permissionHandler.handleToolCall(
          request.id,
          'AskUserQuestion',
          buildPiExtensionAskUserQuestionInput(request),
        )
        : { decision: 'denied' as const };
      if (providerTimedOut) return;
      await this.writeExtensionUiResponse(child, buildPiExtensionUiResponse(request, result));
    } catch {
      if (providerTimedOut) return;
      await this.writeExtensionUiResponse(child, {
        type: 'extension_ui_response',
        id: request.id,
        cancelled: true,
      }).catch(() => undefined);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.activeExtensionUiRequestIds.delete(request.id);
    }
  }

  private async writeExtensionUiResponse(
    child: ChildProcessWithoutNullStreams,
    response: PiExtensionUiResponse,
  ): Promise<void> {
    if (this.process !== child || !child.stdin) {
      throw new Error('Pi process changed before extension UI response');
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /** Schedule a serialized usage-stats publish; safe to call from any event path. */
  private scheduleUsageStatsPublish(contextTelemetryOverride?: PiContextTelemetry | null): Promise<void> {
    const contextTelemetry = contextTelemetryOverride === undefined
      ? this.assistantBoundaryContextTelemetry
      : contextTelemetryOverride;
    this.usageStatsPublishChain = this.usageStatsPublishChain
      .then(() => this.publishUsageStatsBestEffort(contextTelemetry))
      .catch(() => {
        // best-effort; publish errors are already swallowed inside
      });
    return this.usageStatsPublishChain;
  }

  private async publishUsageStatsBestEffort(contextTelemetryOverride: PiContextTelemetry | null = null): Promise<void> {
      if (this.disposed) return;
      if (!this.process) return;

    try {
      const stats = await this.getSessionStats();
      const sessionId = asNonEmptyString(stats.sessionId);
      if (!sessionId) return;

      const assistantMessagesRaw = stats.assistantMessages;
      const assistantMessages =
        typeof assistantMessagesRaw === 'number' && Number.isFinite(assistantMessagesRaw) ? assistantMessagesRaw : null;
      // Live context telemetry: prefer pi's own `stats.contextUsage` (the estimate it uses
      // for compaction); fall back to the bridge extension's stderr marker when stats lack
      // it (older pi builds). The suffix lets a changed live-context value re-publish even
      // when the assistant-message counter has not advanced (compaction, retries).
      const contextTelemetry = Object.prototype.hasOwnProperty.call(stats, 'contextUsage')
        ? parsePiContextTelemetryFromSessionStats(stats)
        : contextTelemetryOverride ?? this.latestContextTelemetry;
      const rawKey = (assistantMessages !== null ? `${sessionId}:${assistantMessages}` : sessionId)
        + (contextTelemetry ? buildPiContextTelemetryKeySuffix(contextTelemetry) : '');
      if (this.lastPublishedUsageKey === rawKey) return;
      this.lastPublishedUsageKey = rawKey;

      const asNonNegative = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

      const input = asNonNegative(stats.tokens?.input);
      const output = asNonNegative(stats.tokens?.output);
      const cacheRead = asNonNegative(stats.tokens?.cacheRead);
      const cacheWrite = asNonNegative(stats.tokens?.cacheWrite);
      const total = asNonNegative(stats.tokens?.total);

      const tokens: Record<string, number> = {};
      if (input !== null) tokens.input = input;
      if (output !== null) tokens.output = output;
      if (cacheRead !== null) tokens.cache_read = cacheRead;
      if (cacheWrite !== null) tokens.cache_creation = cacheWrite;
      if (total !== null) tokens.total = total;
      if (Object.keys(tokens).length === 0 && !contextTelemetry) return;
      if (contextTelemetry) mergePiContextTelemetryIntoTokens(tokens, contextTelemetry);

      const costRaw = stats.cost;
      const costTotal = typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : null;

      this.emitMessage({
        type: 'token-count',
        key: `pi:${rawKey}`,
        tokens,
        ...(costTotal !== null ? { cost: { total: costTotal } } : {}),
      });
    } catch {
      // best-effort
    }
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Bridge-extension context telemetry markers are consumed programmatically and must not
    // surface as terminal-output noise in the transcript.
    const contextTelemetry = parsePiContextTelemetryMarkerLine(trimmed);
    if (contextTelemetry) {
      this.latestContextTelemetry = contextTelemetry;
      if (this.assistantMessageEndAwaitingContextTelemetry) {
        this.latestContextTelemetry = null;
        this.assistantBoundaryContextTelemetry = contextTelemetry;
        this.assistantMessageEndAwaitingContextTelemetry = false;
        this.scheduleUsageStatsPublish(contextTelemetry);
      }
      return;
    }
    this.recentStderrLines.push(trimmed);
    if (this.recentStderrLines.length > PI_RPC_STDERR_TAIL_MAX_LINES) {
      this.recentStderrLines.splice(0, this.recentStderrLines.length - PI_RPC_STDERR_TAIL_MAX_LINES);
    }
    this.emitMessage({ type: 'terminal-output', data: trimmed });

    // Pi reports most usage/rate limits via an assistant message_end, but some surface only on
    // stderr (e.g. a structured 429 with no assistant message). Route limit-looking lines through
    // the SAME classifier as the assistant path so they are detected + reported for recovery rather
    // than missed. Stderr remains diagnostic evidence, not a turn-terminal lifecycle signal: Pi can
    // keep streaming after auth/limit-looking stderr, so canonical failure stays owned by provider
    // terminal events, command failures, liveness probes, or process exit.
    if (this.pendingTurn && looksLikeProviderLimitStderrLine(trimmed)) {
      const pending = this.pendingTurn;
      const classification = this.classifyPiRuntimeAuthFailure(
        buildPiStderrRuntimeAuthEvidence(trimmed, this.currentModelProvider),
      );
      if (classification && (classification.kind === 'usage_limit' || classification.kind === 'rate_limit')) {
        const reportKey = buildRuntimeAuthClassificationReportKey(classification);
        if (!pending.stderrRuntimeAuthReportedKeys.has(reportKey)) {
          pending.stderrRuntimeAuthReportedKeys.add(reportKey);
          void this.reportPiRuntimeAuthFailureToDaemon(classification);
        }
      }
    }
  }

  private emitMessage(message: AgentMessage): void {
    const safeMessage: AgentMessage =
      message.type === 'terminal-output'
        ? ({ ...message, data: redactPiDiagnosticText(String(message.data ?? '')) } as AgentMessage)
        : message;

    for (const handler of this.messageHandlers) {
      try {
        handler(safeMessage);
      } catch (error) {
        logger.debug('[pi] Message handler failed (non-fatal)', error);
      }
    }
  }

  private async sendCommand(
    command: PiRpcCommandWithoutId,
    timeoutMs = 30_000,
    options: PiRpcCommandOptions = {},
  ): Promise<PiRpcResponse> {
    if (options.processAlreadyEnsured !== true) {
      await this.ensureProcess();
    }
    const child = this.process;
    if (!child?.stdin) {
      throw new Error('Pi process stdin is unavailable');
    }

    const id = randomUUID();
    const payload: PiRpcCommand = { ...command, id } as PiRpcCommand;
    const encoded = JSON.stringify(payload);

    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending || !this.clearPendingRpcRequest(id, pending)) return;
        if (command.type === 'prompt') {
          this.openPromptRequestIds.add(id);
        } else {
          this.openPromptRequestIds.delete(id);
        }
        pending.reject(new PiRpcCommandResponseTimeoutError(command.type));
      }, timeoutMs);
      timeout.unref?.();

      const pending: PendingRpcRequest = {
        resolve,
        reject,
        timeout,
        commandType: command.type,
        removeAbortListener: () => undefined,
      };
      this.pendingRequests.set(id, pending);

      if (options.signal) {
        const onAbort = () => {
          if (!this.clearPendingRpcRequest(id, pending)) return;
          this.openPromptRequestIds.delete(id);
          pending.reject(options.createCancellationError?.() ?? new Error(`Pi RPC command cancelled (${command.type})`));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
        if (options.signal.aborted) onAbort();
      }

      if (!this.pendingRequests.has(id)) return;
      child.stdin.write(`${encoded}\n`, (error) => {
        if (!error) return;
        if (!this.clearPendingRpcRequest(id, pending)) return;
        this.openPromptRequestIds.delete(id);
        pending.reject(new Error(`Failed to write Pi RPC command (${command.type}): ${error.message}`));
      });
    });

    return response;
  }

  private clearPendingRpcRequest(id: string, pending: PendingRpcRequest): boolean {
    if (this.pendingRequests.get(id) !== pending) return false;
    clearTimeout(pending.timeout);
    pending.removeAbortListener();
    this.pendingRequests.delete(id);
    return true;
  }

  private createPendingTurn(timeoutMs: number): PendingTurn {
    if (this.pendingTurn) {
      throw new Error('Pi pending turn already exists');
    }
    let resolveTurn: (() => void) | null = null;
    let rejectTurn: ((error: Error) => void) | null = null;

    const promise = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    if (!resolveTurn || !rejectTurn) {
      throw new Error('Failed to initialize Pi pending turn');
    }

    const pending: PendingTurn = {
      promise,
      resolve: resolveTurn,
      reject: rejectTurn,
      timeout: null,
      timeoutMs,
      agentEndSettleTimeout: null,
      compactionResumeTimeout: null,
      compactionInProgress: false,
      agentEndObserved: false,
      agentEndActivityEpoch: null,
      agentStartObserved: false,
      preStartTerminalFailure: null,
      activityEpoch: 0,
      consecutiveSilentProbes: 0,
      livenessProbeInFlight: false,
      livenessProbeRerunRequested: false,
      recoverableAssistantErrorObserved: false,
      providerFailureDiagnostic: null,
      lastCompactionEnd: null,
      lastAssistantStopReason: null,
      compactionAutoContinueAttempts: 0,
      stderrRuntimeAuthReportedKeys: new Set(),
    };
    this.pendingTurn = pending;
    this.armPendingTurnInactivityTimer(pending);
    return pending;
  }

  private isCurrentPendingTurn(pending: PendingTurn): boolean {
    return this.pendingTurn === pending;
  }

  private resolvePendingTurn(): boolean {
    if (!this.pendingTurn) return false;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.openPromptRequestIds.clear();
    this.emitMessage({ type: 'status', status: 'idle' });
    pending.resolve();
    return true;
  }

  private rejectPendingTurn(error: Error): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.openPromptRequestIds.clear();
    pending.reject(error);
  }

  private surfacePiProviderFailure(
    failure: PiProviderFailureDiagnostic,
    runtimeAuthClassification: ConnectedServiceRuntimeFailureClassification | null = null,
  ): void {
    this.logPiProviderFailure(failure);
    this.emitPiProviderFailureDiagnostic(failure.sanitizedPreview);
    this.emitMessage({ type: 'status', status: 'error', detail: failure.sanitizedPreview });
    this.rejectPendingTurn(Object.assign(
      createPiProviderFailureError(failure),
      runtimeAuthClassification ? { runtimeAuthClassification } : {},
    ));
  }

  private emitPiProviderFailureDiagnostic(result: string): void {
    this.emitMessage({
      type: 'tool-result',
      callId: randomUUID(),
      toolName: 'terminal-output',
      result,
      isError: true,
    });
  }

  private logPiProviderFailure(failure: PiProviderFailureDiagnostic): void {
    logger.warn('[pi] Provider turn failed', {
      classification: failure.classification,
      providerCode: failure.code,
      sanitizedPreview: failure.sanitizedPreview,
    });
  }

  private rejectPendingTurnAsStalled(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    const error = new Error('Timed out waiting for Pi turn completion');
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.openPromptRequestIds.clear();
    this.emitMessage({ type: 'status', status: 'error', detail: error.message });
    pending.reject(error);
  }

  private rejectPendingTurnAsCompactionFailed(pending: PendingTurn, detail: string): void {
    if (this.pendingTurn !== pending) return;
    const classification = this.classifyPiRuntimeAuthFailure({
      provider: this.currentModelProvider,
      event: pending.lastCompactionEnd?.payload ?? null,
      message: detail,
    });
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.openPromptRequestIds.clear();
    this.emitMessage({ type: 'status', status: 'error', detail });
    if (classification) {
      void this.reportPiRuntimeAuthFailureToDaemon(classification);
    }
    pending.reject(this.createPiAssistantFailureError(detail, classification));
  }

  private getPendingTurnStallTimeoutMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_TURN_STALL_TIMEOUT_ENV,
      DEFAULT_PI_RPC_TURN_STALL_TIMEOUT_MS,
    );
  }

  private getPromptCollisionIdleWaitMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_PROMPT_COLLISION_IDLE_WAIT_ENV,
      DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS,
    );
  }

  private getPromptCollisionIdlePollMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_PROMPT_COLLISION_IDLE_POLL_ENV,
      DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS,
    );
  }

  private async waitForPromptCollisionToBecomeIdle(): Promise<void> {
    const quiesceBudgetMs = this.getPromptCollisionIdleWaitMs();
    const pollMs = this.getPromptCollisionIdlePollMs();
    const probeTimeoutMs = Math.min(this.getLivenessProbeTimeoutMs(), quiesceBudgetMs);
    // Wait for the in-flight work to finish, then let the caller send a clean prompt. While a turn is
    // still pending we wait indefinitely: that turn's own event-aware liveness probe (with its
    // silent-probe ceiling) is the single authority on whether Pi is genuinely stuck, so a long-but-live
    // turn is never failed and a hung one is settled there — we never fail/drop the user's prompt just
    // because Pi is busy, and we never send Pi `abort` here. Once no turn is pending, the prior turn has
    // settled; we then only confirm Pi has quiesced, and we bound that confirmation so a hung/unreachable
    // Pi (or one still reporting `isStreaming` after its turn was force-stalled) surfaces a clear error
    // instead of blocking the caller forever.
    let unreachableSince: number | null = null;
    let quiesceSince: number | null = null;
    for (;;) {
      let state: PiRpcStateData | null = null;
      try {
        state = await this.getState(probeTimeoutMs);
        unreachableSince = null;
      } catch {
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= quiesceBudgetMs) {
          throw new Error('Pi became unreachable while waiting for the previous prompt to finish');
        }
      }
      if (this.pendingTurn) {
        quiesceSince = null;
      } else {
        if (state && state.isStreaming !== true && state.isCompacting !== true) return;
        quiesceSince ??= Date.now();
        if (Date.now() - quiesceSince >= quiesceBudgetMs) {
          throw new Error('Pi did not return to idle after the previous prompt settled');
        }
      }
      await delay(pollMs);
    }
  }

  private getCompactionResumeGraceMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_COMPACTION_RESUME_GRACE_ENV,
      DEFAULT_PI_RPC_COMPACTION_RESUME_GRACE_MS,
    );
  }

  private getAgentEndSettleMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_AGENT_END_SETTLE_ENV,
      DEFAULT_PI_RPC_AGENT_END_SETTLE_MS,
    );
  }

  private getAgentEndBusyGraceMs(pending: PendingTurn): number {
    return Math.min(
      readPositiveIntegerEnv(
        this.options.env,
        PI_RPC_AGENT_END_BUSY_GRACE_ENV,
        DEFAULT_PI_RPC_AGENT_END_BUSY_GRACE_MS,
      ),
      pending.timeoutMs,
    );
  }

  private clearPendingTurnTimers(pending: PendingTurn): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    if (pending.agentEndSettleTimeout) {
      clearTimeout(pending.agentEndSettleTimeout);
      pending.agentEndSettleTimeout = null;
    }
    if (pending.compactionResumeTimeout) {
      clearTimeout(pending.compactionResumeTimeout);
      pending.compactionResumeTimeout = null;
    }
  }

  private clearPendingTurnInactivityTimer(pending: PendingTurn): void {
    if (!pending.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  private armPendingTurnInactivityTimer(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.clearPendingTurnInactivityTimer(pending);

    // The timer runs uniformly, including during compaction. When it fires we do not blindly
    // fail the turn; we ask Pi whether it is still working (see `probeLivenessAndDecide`).
    const timeout = setTimeout(() => {
      void this.probeLivenessAndDecide(pending);
    }, pending.timeoutMs);
    timeout.unref?.();
    pending.timeout = timeout;
  }

  private cancelPendingTurnAgentEndSettle(pending: PendingTurn): void {
    if (!pending.agentEndSettleTimeout) return;
    clearTimeout(pending.agentEndSettleTimeout);
    pending.agentEndSettleTimeout = null;
  }

  private cancelPendingTurnCompactionResume(pending: PendingTurn): void {
    if (!pending.compactionResumeTimeout) return;
    clearTimeout(pending.compactionResumeTimeout);
    pending.compactionResumeTimeout = null;
  }

  private notePendingTurnActivity(event: Record<string, unknown>): void {
    const pending = this.pendingTurn;
    if (!pending) return;

    // Any Pi event is proof of life: bump the epoch (so an in-flight probe discards its result)
    // and reset the silent-probe counter.
    pending.activityEpoch += 1;
    pending.consecutiveSilentProbes = 0;

    const type = asNonEmptyString(event.type);
    if (type === 'message_end') {
      const message = asRecord(event.message);
      if (message?.role === 'assistant') {
        const stopReason = asNonEmptyString(message.stopReason ?? message.stop_reason);
        pending.lastAssistantStopReason = stopReason;
        const errorMessage = asNonEmptyString(message.errorMessage ?? message.error_message ?? event.errorMessage ?? event.error_message);
        const assistantFailed = stopReason === 'error' || Boolean(errorMessage);
        pending.recoverableAssistantErrorObserved = assistantFailed
          ? this.isRecoverablePiAssistantError(event)
          : false;
        if (!pending.recoverableAssistantErrorObserved) {
          pending.providerFailureDiagnostic = null;
        }
      }
    }

    if (
      pending.recoverableAssistantErrorObserved
      && (
        type === 'message_update'
        || type === 'tool_execution_start'
        || type === 'tool_execution_update'
        || type === 'tool_execution_end'
      )
    ) {
      // Provider work after a recoverable assistant error proves that Pi resumed
      // the same turn. Do not let the earlier diagnostic poison its final agent_end.
      pending.recoverableAssistantErrorObserved = false;
      pending.providerFailureDiagnostic = null;
    }

    if (type === 'compaction_start') {
      pending.compactionInProgress = true;
      pending.agentEndObserved = false;
      pending.agentEndActivityEpoch = null;
      pending.lastCompactionEnd = null;
      this.cancelPendingTurnAgentEndSettle(pending);
      this.cancelPendingTurnCompactionResume(pending);
      // Do NOT suppress the inactivity timer during compaction: the liveness probe distinguishes
      // a healthy in-progress compaction (isCompacting) from a hung one.
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (type === 'agent_start') {
      pending.compactionInProgress = false;
      pending.agentEndObserved = false;
      pending.agentEndActivityEpoch = null;
      pending.agentStartObserved = true;
      pending.preStartTerminalFailure = null;
      pending.recoverableAssistantErrorObserved = false;
      pending.providerFailureDiagnostic = null;
      pending.lastCompactionEnd = null;
      pending.lastAssistantStopReason = null;
      this.cancelPendingTurnAgentEndSettle(pending);
      this.cancelPendingTurnCompactionResume(pending);
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (type === 'compaction_end') {
      pending.compactionInProgress = false;
      pending.agentEndObserved = false;
      pending.agentEndActivityEpoch = null;
      pending.lastCompactionEnd = {
        payload: findContextCompactionPayload(mapPiRpcEventToAgentMessages(event)) ?? {
          type: 'context-compaction',
          phase: 'completed',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'unknown',
          source: 'provider-event',
        },
        willRetry: event.willRetry === true,
        errorMessage: asNonEmptyString(event.errorMessage ?? event.error_message) ?? null,
      };
      this.cancelPendingTurnAgentEndSettle(pending);
      this.armPendingTurnInactivityTimer(pending);
      this.scheduleCompactionResumeGrace(pending);
      return;
    }

    if (type !== 'agent_end') {
      this.cancelPendingTurnAgentEndSettle(pending);
    }

    if (pending.agentEndObserved) {
      this.schedulePendingTurnCompletion();
      return;
    }

    this.armPendingTurnInactivityTimer(pending);
  }

  private getLivenessProbeTimeoutMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_LIVENESS_PROBE_TIMEOUT_ENV,
      DEFAULT_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS,
    );
  }

  private getMaxSilentProbes(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_MAX_SILENT_PROBES_ENV,
      DEFAULT_PI_RPC_MAX_SILENT_PROBES,
    );
  }

  private getCompactionAutoContinueMax(): number {
    return readNonNegativeIntegerEnv(
      this.options.env,
      PI_RPC_COMPACTION_AUTO_CONTINUE_MAX_ENV,
      DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX,
    );
  }

  private getCompactionAutoContinuePrompt(): string {
    const configured = this.options.env[PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT_ENV];
    if (typeof configured === 'string') {
      const trimmed = configured.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT;
  }

  /**
   * Inactivity-timer callback. Instead of blindly failing the turn, ask Pi whether it is still
   * working (`get_state` → `isStreaming || isCompacting`). Active PI liveness is treated as proof
   * of life; only missing liveness or explicit idle-without-terminal can fail the turn here.
   */
  private async probeLivenessAndDecide(pending: PendingTurn): Promise<void> {
    if (this.pendingTurn !== pending) return;
    // Single-flight: never run two overlapping probes for the same turn.
    if (pending.livenessProbeInFlight) {
      pending.livenessProbeRerunRequested = true;
      return;
    }
    pending.livenessProbeInFlight = true;
    pending.livenessProbeRerunRequested = false;
    const epoch = pending.activityEpoch;

    let state: PiRpcStateData | null = null;
    try {
      state = await this.getState(this.getLivenessProbeTimeoutMs());
    } catch {
      state = null;
    } finally {
      pending.livenessProbeInFlight = false;
    }

    // Stale-proof: discard the result if the turn was replaced, or a Pi event arrived while the
    // probe was in flight. If the replacement timer already fired during this probe, re-arm here
    // so the turn cannot be orphaned without a timer.
    if (this.pendingTurn !== pending) return;
    if (pending.activityEpoch !== epoch) {
      if (pending.livenessProbeRerunRequested || pending.timeout === null) {
        pending.livenessProbeRerunRequested = false;
        this.armPendingTurnInactivityTimer(pending);
      }
      return;
    }

    if (!state) {
      // Pi can transiently stop answering `get_state` while still emitting turn activity shortly
      // afterward. Treat probe timeouts like other silent liveness probes and only fail after the
      // bounded ceiling.
      pending.consecutiveSilentProbes += 1;
      if (pending.consecutiveSilentProbes >= this.getMaxSilentProbes()) {
        this.rejectPendingTurnAsStalled(pending);
        return;
      }
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (state.isStreaming === true || state.isCompacting === true || pending.compactionInProgress) {
      // Provider-reported work is proof of life. Long silent reasoning/compaction windows are valid
      // for PI, so the silent-probe ceiling only applies when liveness is absent.
      pending.consecutiveSilentProbes = 0;
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (pending.lastCompactionEnd?.willRetry === true) {
      // Overflow recovery can sit between "compaction finished" and "retry resumed" for much
      // longer than the short resume grace, especially around PI restarts/resumes. If PI reports
      // active streaming/compaction we handled that above; if it now reports idle, settle this as a
      // paused compaction rather than a failed turn. The user can continue explicitly, and a later
      // provider resume is not preceded by a stale `turn_failed` transcript marker.
      this.resolvePendingTurnAsCompactionPaused(pending);
      return;
    }

    if (pending.lastCompactionEnd) {
      void this.continuePendingTurnAfterCompactionPause(pending);
      return;
    }

    if (pending.agentEndObserved) {
      this.resolvePendingTurn();
      void this.scheduleUsageStatsPublish();
      return;
    }

    // Pi reports it is neither streaming nor compacting, yet never emitted a terminal event.
    this.rejectPendingTurnAsStalled(pending);
  }

  private schedulePendingTurnCompletion(): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.clearPendingTurnInactivityTimer(pending);

    const timeout = setTimeout(() => {
      void this.settlePendingTurnAfterAgentEnd(pending);
    }, this.getAgentEndSettleMs());
    timeout.unref?.();
    pending.agentEndSettleTimeout = timeout;
  }

  private async settlePendingTurnAfterAgentEnd(pending: PendingTurn): Promise<void> {
    if (this.pendingTurn !== pending) return;
    pending.agentEndSettleTimeout = null;
    if (pending.compactionInProgress) {
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    let state: PiRpcStateData | null = null;
    try {
      state = await this.getState(this.getLivenessProbeTimeoutMs());
    } catch {
      state = null;
    }

    if (this.pendingTurn !== pending) return;
    if (pending.compactionInProgress || !pending.agentEndObserved) {
      this.armPendingTurnInactivityTimer(pending);
      return;
    }
    if (!state) {
      pending.consecutiveSilentProbes += 1;
      if (pending.consecutiveSilentProbes >= this.getMaxSilentProbes()) {
        this.rejectPendingTurnAsStalled(pending);
        return;
      }
      this.armPendingTurnInactivityTimer(pending);
      return;
    }
    const finalAssistantBoundaryIsCurrent = (
      pending.lastAssistantStopReason === 'stop'
      && pending.agentEndActivityEpoch === pending.activityEpoch
    );
    if (
      state.isCompacting === true
      || (state.isStreaming === true && !finalAssistantBoundaryIsCurrent)
    ) {
      this.schedulePendingTurnCompletionBusyGrace(pending);
      return;
    }

    this.resolvePendingTurn();
    void this.scheduleUsageStatsPublish();
  }

  private schedulePendingTurnCompletionBusyGrace(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.clearPendingTurnInactivityTimer(pending);
    const timeout = setTimeout(() => {
      if (this.pendingTurn !== pending || pending.compactionInProgress) return;
      void this.settlePendingTurnAfterAgentEnd(pending);
    }, this.getAgentEndBusyGraceMs(pending));
    timeout.unref?.();
    pending.agentEndSettleTimeout = timeout;
  }

  private scheduleCompactionResumeGrace(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.cancelPendingTurnCompactionResume(pending);

    const timeout = setTimeout(() => {
      if (this.pendingTurn !== pending) return;
      void this.continuePendingTurnAfterCompactionPause(pending);
    }, this.getCompactionResumeGraceMs());
    timeout.unref?.();
    pending.compactionResumeTimeout = timeout;
  }

  private async continuePendingTurnAfterCompactionPause(pending: PendingTurn): Promise<void> {
    if (this.pendingTurn !== pending) return;
    if (pending.lastCompactionEnd?.willRetry === true) {
      // Do not turn a delayed PI overflow retry into a false failed turn. The inactivity/liveness
      // probe is the authority: while PI reports streaming/compacting it can run indefinitely; once
      // PI reports idle, `probeLivenessAndDecide` resolves the turn as a paused compaction.
      this.cancelPendingTurnCompactionResume(pending);
      this.armPendingTurnInactivityTimer(pending);
      return;
    }
    // INVARIANT: a completed final answer (`stopReason === 'stop'`) resolves completed/non-fatal and
    // is never escalated, even when a post-final maintenance compaction failed. The shared decision
    // helper enforces that completed-final wins over terminal-failure so the ordering cannot drift.
    const outcome = resolvePiCompactionTurnOutcome(pending);
    if (outcome.kind === 'completed_post_final') {
      this.resolvePendingTurnAfterPostFinalCompaction(pending);
      return;
    }
    if (outcome.kind === 'terminal_failure') {
      this.rejectPendingTurnAsCompactionFailed(pending, outcome.detail);
      return;
    }

    const maxAttempts = this.getCompactionAutoContinueMax();
    if (pending.compactionAutoContinueAttempts >= maxAttempts) {
      this.resolvePendingTurnAsCompactionPaused(pending);
      return;
    }

    pending.compactionAutoContinueAttempts += 1;
    this.cancelPendingTurnCompactionResume(pending);
    this.armPendingTurnInactivityTimer(pending);

    try {
      await this.sendCommand(
        {
          type: 'prompt',
          message: this.getCompactionAutoContinuePrompt(),
          streamingBehavior: 'followUp',
        },
        this.getLivenessProbeTimeoutMs(),
      );
      if (this.pendingTurn === pending) {
        this.armPendingTurnInactivityTimer(pending);
      }
    } catch (error) {
      if (this.pendingTurn !== pending) return;
      const message = asError(error).message.toLowerCase();
      if (message.includes('already processing') || message.includes('streamingbehavior')) {
        this.armPendingTurnInactivityTimer(pending);
        return;
      }
      this.rejectPendingTurnAsStalled(pending);
    }
  }

  private resolvePendingTurnAfterPostFinalCompaction(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.cancelPendingTurnCompactionResume(pending);
    // The final answer already completed, so a failed post-final maintenance compaction is NOT a
    // turn failure and must not escalate into runtime-auth recovery. Surface it as a non-fatal,
    // already-supported context-compaction `failed` event so the next turn starts from a possibly
    // un-compacted (degraded) context without a stale turn-failed marker. The clean post-final case
    // emits nothing.
    const end = pending.lastCompactionEnd;
    if (end && end.errorMessage) {
      this.emitMessage({
        type: 'event',
        name: 'context_compaction',
        payload: {
          ...(end.payload ?? {}),
          type: 'context-compaction',
          phase: 'failed',
        },
      });
    }
    this.resolvePendingTurn();
    void this.scheduleUsageStatsPublish();
  }

  private resolvePendingTurnAsCompactionPaused(pending: PendingTurn): void {
    if (this.pendingTurn !== pending) return;
    // Same shared invariant as `continuePendingTurnAfterCompactionPause`: completed-final wins over
    // terminal-failure so a finished turn is never escalated into runtime-auth recovery.
    const outcome = resolvePiCompactionTurnOutcome(pending);
    if (outcome.kind === 'completed_post_final') {
      this.resolvePendingTurnAfterPostFinalCompaction(pending);
      return;
    }
    if (outcome.kind === 'terminal_failure') {
      this.rejectPendingTurnAsCompactionFailed(pending, outcome.detail);
      return;
    }

    // A threshold/manual/overflow compaction completed and Pi paused without auto-resuming.
    this.emitMessage({
      type: 'event',
      name: 'context_compaction',
      payload: {
        ...(pending.lastCompactionEnd?.payload ?? {}),
        type: 'context-compaction',
        phase: 'completed',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      },
    });
    this.resolvePendingTurn();
    void this.scheduleUsageStatsPublish();
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.clearPendingRpcRequest(id, pending);
      pending.reject(error);
    }
  }

  private async getState(
    timeoutMs = 30_000,
    options: PiRpcCommandOptions = {},
  ): Promise<PiRpcStateData> {
    const response = await this.sendCommand({ type: 'get_state' }, timeoutMs, options);
    return (asRecord(response.data) ?? {}) as PiRpcStateData;
  }

  private async getAvailableModels(): Promise<PiRpcModelsData> {
    const response = await this.sendCommand({ type: 'get_available_models' }, 60_000);
    return (asRecord(response.data) ?? {}) as PiRpcModelsData;
  }

  private async getSessionStats(): Promise<PiRpcSessionStatsData> {
    const response = await this.sendCommand({ type: 'get_session_stats' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcSessionStatsData;
  }

  private async getCommands(): Promise<PiRpcCommandsData> {
    const response = await this.sendCommand({ type: 'get_commands' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcCommandsData;
  }

  private async publishRuntimeState(state: PiRpcStateData): Promise<void> {
    const modelRecord = asRecord(state.model);
    const currentModelIdRaw = asNonEmptyString(modelRecord?.id) ?? '';
    const currentModelProvider = asNonEmptyString(modelRecord?.provider);
    const currentModelId = currentModelProvider
      ? qualifyPiModelId(currentModelProvider, currentModelIdRaw) ?? currentModelIdRaw
      : currentModelIdRaw;
    if (currentModelProvider) {
      this.currentModelProvider = currentModelProvider;
    }
    const thinkingLevelFromState = normalizePiThinkingEffort(state.thinkingLevel) ?? 'medium';

    let normalized: Array<{ id: string; name: string; description: string; modelOptions?: unknown[] }> =
      (this.sessionModelState?.availableModels ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? '',
      }));

    try {
      const available = await this.getAvailableModels();
      const models = Array.isArray(available.models) ? available.models : [];
      this.modelProviderById.clear();
      normalized = models
        .map((entry) => {
          const model = asRecord(entry);
          const id = asNonEmptyString(model?.id);
          const provider = asNonEmptyString(model?.provider);
          if (!id || !provider) return null;
          const qualifiedId = qualifyPiModelId(provider, id);
          const name = asNonEmptyString(model?.name);
          this.modelProviderById.set(id, provider);
          if (qualifiedId) this.modelProviderById.set(qualifiedId, provider);
          return createPiModelCatalogEntry({
            provider,
            modelId: id,
            ...(name ? { name } : {}),
            supportsThinking: model?.reasoning === true,
            thinkingEffort: thinkingLevelFromState,
          });
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    } catch {
      // Best-effort: model introspection should not block session start/resume.
    }

    this.sessionModelState = {
      currentModelId,
      availableModels: normalized,
    };

    this.emitMessage({
      type: 'event',
      name: 'session_models_state',
      payload: {
        currentModelId,
        availableModels: normalized,
      },
    });

    try {
      const commands = await this.getCommands();
      const commandList = Array.isArray(commands.commands) ? commands.commands : [];
      const nextCommandNames = new Set<string>();
      const nextExtensionCommandNames = new Set<string>();
      const availableCommands = commandList
        .map((entry) => {
          const item = asRecord(entry);
          const name = asNonEmptyString(item?.name);
          if (!name) return null;
          const description = asNonEmptyString(item?.description) ?? undefined;
          const source = asNonEmptyString(item?.source);
          return {
            name: name.startsWith('/') ? name : `/${name}`,
            ...(description ? { description } : {}),
            ...(source ? { source } : {}),
          };
        })
        .filter((entry): entry is { name: string; description?: string; source?: string } => entry !== null);

      for (const command of availableCommands) {
        const name = command.name.slice(1).trim().toLowerCase();
        if (name) {
          nextCommandNames.add(name);
          if (command.source === 'extension') nextExtensionCommandNames.add(name);
        }
      }

      this.availableCommandNames.clear();
      for (const name of nextCommandNames) this.availableCommandNames.add(name);
      this.availableExtensionCommandNames.clear();
      for (const name of nextExtensionCommandNames) this.availableExtensionCommandNames.add(name);

      this.emitMessage({
        type: 'event',
        name: 'available_commands_update',
        payload: {
          availableCommands: availableCommands.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
        },
      });
    } catch {
      // Best-effort: commands introspection should not block session start/resume.
    }
  }

  private async resolveModelSelection(modelIdRaw: string): Promise<{ provider: string; modelId: string }> {
    if (modelIdRaw.includes('/')) {
      const [provider, ...rest] = modelIdRaw.split('/');
      const modelId = rest.join('/').trim();
      const normalizedProvider = provider.trim();
      if (normalizedProvider && modelId) {
        this.modelProviderById.set(modelId, normalizedProvider);
        this.modelProviderById.set(`${normalizedProvider}/${modelId}`, normalizedProvider);
        return { provider: normalizedProvider, modelId };
      }
    }

    const fromKnownMap = this.modelProviderById.get(modelIdRaw);
    if (fromKnownMap) {
      return { provider: fromKnownMap, modelId: modelIdRaw };
    }

    if (this.currentModelProvider) {
      return { provider: this.currentModelProvider, modelId: modelIdRaw };
    }

    const state = await this.getState();
    const model = asRecord(state.model);
    const provider = asNonEmptyString(model?.provider);
    if (provider) {
      this.currentModelProvider = provider;
      return { provider, modelId: modelIdRaw };
    }

    throw new Error(`Cannot resolve Pi provider for model "${modelIdRaw}"`);
  }

  private assertSession(sessionId: SessionId): void {
    if (!this.sessionId) {
      throw new Error('Pi session was not started');
    }
    if (this.sessionId !== sessionId) {
      throw new Error(`Pi session mismatch (expected ${this.sessionId}, got ${sessionId})`);
    }
  }

}

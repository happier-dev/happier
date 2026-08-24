/**
 * AcpBackend - Agent Client Protocol backend using official SDK
 *
 * This module provides a universal backend implementation using the official
 * @agentclientprotocol/sdk. Agent-specific behavior (timeouts, filtering,
 * error handling) is delegated to TransportHandler implementations.
 */

import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import {
  RequestError,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type ForkSessionRequest,
  type LoadSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SetSessionModeRequest,
  type SetSessionConfigOptionRequest,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
  McpServerConfig,
  AgentPromptPayload,
} from '../core';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import { createSubprocessStderrAppender, type BoundedTextFileAppender } from '@/agent/runtime/subprocessArtifacts';
import { createAcpStderrLogSummarizer } from './diagnostics/summarizeAcpStderrForLogs';
import {
  resolveAcpAuthenticationSelection,
  type AcpAuthentication,
} from './AcpAuthentication';
import { normalizeAcpConfigOptionChoices } from './configOptionChoiceNormalization';
import {
  readNonBlankSessionControlIdentifier,
  readSessionControlValueId,
} from '@/agent/runtime/sessionControlIdentifiers';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import packageJson from '../../../package.json';
import {
  type TransportHandler,
  type StderrContext,
  type ToolNameContext,
  DefaultTransport,
} from '../transport';
import {
  type SessionUpdate,
  type HandlerContext,
  DEFAULT_IDLE_TIMEOUT_MS,
  handleAgentMessageChunk,
  handleUserMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  handleAvailableCommandsUpdate,
  handleCurrentModeUpdate,
  readCurrentModeId,
  handleSessionInfoUpdate,
  markToolCallRunningAfterPermission,
  markToolCallWaitingForPermission,
} from './sessionUpdateHandlers';
import { withRetry } from './withRetry';
import { nodeToWebStreams } from './nodeToWebStreams';
import { buildAcpSpawnSpec } from './acpSpawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
  pickPermissionOutcome,
} from './permissions/permissionMapping';
import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  refinePermissionToolNameWithInput,
  resolvePermissionToolName,
  shouldReplaceCachedPermissionToolName,
  type PermissionRequestLike,
} from './permissions/permissionRequest';
import { AcpReplayCapture, type AcpReplayEvent } from './history/acpReplayCapture';
import { createAcpFilteredStdoutReadable, type DroppedStdoutLine } from './createAcpFilteredStdoutReadable';
import { createAcpNdJsonStream } from './createAcpNdJsonStream';
import {
  buildStructuredAgentMessageChunkMirrorSet,
  shouldSkipLegacyMessageChunkMirror,
} from './updates/legacyMessageChunkMirrorDedup';
import { type AcpToolCallTracker } from './updates/toolCalls/AcpToolCallTracker';
import { createAcpToolCallLifecycle } from './updates/toolCalls/createAcpToolCallLifecycle';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import type { AcpTurnOutcome } from './backend/turn/_types';
import { mapStopReasonToAcpTurnOutcome, readPromptStopReason } from './backend/turn/acpTurnCompletion';
import { abortPendingAcpPermissionRequests } from './backend/permissions/acpPermissionFinalization';
import { SessionControlApplyError } from '@/agent/runtime/sessionControlApplyError';
import { buildAcpPromptContentBlocks } from './prompt/buildAcpPromptContentBlocks';
import {
  createAcpClientConnection,
  type AcpClientConnection,
} from './connection/createAcpClientConnection';
import type {
  AcpClientConnectionHandlers,
  AcpExtensionHandlerContext,
  AcpExtensionRegistration,
} from './connection/types';
import {
  buildUnknownAcpSessionUpdateDiagnostic,
  classifyAcpSessionUpdateDisposition,
} from './connection/sdkContractDisposition';
import type { PermissionResult } from '@/agent/permissions/permissionResult';
import { AcpPlanProjection, type NormalizedAcpPlanSnapshot } from './plans';

function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAcpJsonRpcRejection(error: unknown): boolean {
  if (error instanceof RequestError) return true;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const record = error as Record<string, unknown>;
  return typeof record.code === 'number' && Number.isFinite(record.code) && typeof record.message === 'string';
}

async function applyAcpSessionControl<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAcpJsonRpcRejection(error)) throw SessionControlApplyError.definitive(error);
    throw error;
  }
}

export type AcpPromptSubmissionPhase =
  | 'rejected_before_effect'
  | 'effect_may_have_occurred';

export class AcpPromptSubmissionPhaseError extends Error {
  readonly phase: AcpPromptSubmissionPhase;
  override readonly cause: unknown;

  constructor(phase: AcpPromptSubmissionPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AcpPromptSubmissionPhaseError';
    this.phase = phase;
    this.cause = cause;
  }
}

type AcpPromptExactFinalResponseEvidence = Readonly<{
  kind: 'exact_final_response';
  response: PromptResponse;
}>;

export type AcpPromptFinalResponseEvidence =
  | AcpPromptExactFinalResponseEvidence
  | Readonly<{
      kind: 'accepted_without_exact_final_response';
    }>;

export type AcpPromptSubmissionEvidence =
  | AcpPromptFinalResponseEvidence
  | Readonly<{
      kind: 'effect_may_have_occurred';
      finalResponseEvidence: Promise<AcpPromptFinalResponseEvidence>;
    }>;

function toAcpPromptSubmissionPhaseError(
  phase: AcpPromptSubmissionPhase,
  error: unknown,
): AcpPromptSubmissionPhaseError {
  if (error instanceof AcpPromptSubmissionPhaseError) return error;
  return new AcpPromptSubmissionPhaseError(phase, error);
}

function resolveAcpPlanTurnId(turnGeneration: unknown): string {
  return `turn:${typeof turnGeneration === 'number' && Number.isInteger(turnGeneration) && turnGeneration >= 0
    ? turnGeneration
    : 0}`;
}

const DEFAULT_POST_PROMPT_NO_UPDATES_TIMEOUT_MS: number | null = null;
const DEFAULT_PROMPT_LIVENESS_TIMEOUT_MS: number | null = null;
const PROMPT_CANCEL_SETTLEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_POST_TOOL_CALL_IDLE_TIMEOUT_MS = 1_000;
const DEFAULT_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS = 0;

function resolvePostPromptNoUpdatesTimeoutMs(transport: TransportHandler): number | null {
  const transportValue = transport.getPostPromptNoUpdatesTimeoutMs?.();
  if (transportValue === null) return null;
  if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
    return Math.trunc(transportValue);
  }

  const envValue =
    readPositiveIntEnv('HAPPIER_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS') ??
    readPositiveIntEnv('HAPPY_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS');
  if (envValue != null) return envValue;

  return DEFAULT_POST_PROMPT_NO_UPDATES_TIMEOUT_MS;
}

function resolvePromptLivenessTimeoutMs(transport: TransportHandler): number | null {
  const transportValue = transport.getPromptLivenessTimeoutMs?.();
  if (transportValue === null) return null;
  if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
    return Math.trunc(transportValue);
  }

  const envValue =
    readPositiveIntEnv('HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS') ??
    readPositiveIntEnv('HAPPY_ACP_PROMPT_LIVENESS_TIMEOUT_MS');
  if (envValue != null) return envValue;

  return DEFAULT_PROMPT_LIVENESS_TIMEOUT_MS;
}

function resolvePostToolCallIdleTimeoutMs(transport: TransportHandler): number {
  const transportValue = transport.getPostToolCallIdleTimeoutMs?.();
  if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
    return Math.trunc(transportValue);
  }

  const envValue =
    readPositiveIntEnv('HAPPIER_ACP_POST_TOOL_IDLE_TIMEOUT_MS') ??
    readPositiveIntEnv('HAPPY_ACP_POST_TOOL_IDLE_TIMEOUT_MS');
  if (envValue != null) return envValue;

  return DEFAULT_POST_TOOL_CALL_IDLE_TIMEOUT_MS;
}

function resolveIdleWithoutAssistantMessageTimeoutMs(transport: TransportHandler): number {
  const transportValue = transport.getIdleWithoutAssistantMessageTimeoutMs?.();
  if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
    return Math.trunc(transportValue);
  }

  const envValue =
    readPositiveIntEnv('HAPPIER_ACP_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS') ??
    readPositiveIntEnv('HAPPY_ACP_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS');
  if (envValue != null) return envValue;

  return DEFAULT_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS;
}

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

/**
 * Extended RequestPermissionRequest with additional fields that may be present
 */
type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    toolCallId?: string;
    id?: string;
    kind?: string;
    toolName?: string;
    rawInput?: Record<string, unknown>;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  rawInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

// SessionNotification payload shape differs across ACP SDK versions (some use `update`, some use `updates[]`).
// We normalize dynamically in `handleSessionUpdate` and avoid relying on the SDK type here.

export type SessionConfigOptionValueId = string | number | boolean | null;

export type SessionConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: SessionConfigOptionValueId;
  options?: ReadonlyArray<Readonly<{ value: SessionConfigOptionValueId; name: string; description?: string }>>;
}>;

/**
 * Permission handler interface for ACP backends
 */
export interface AcpPermissionHandler {
  /**
   * Best-effort synchronous preview used to suppress UI/mobile permission prompts for
   * requests the handler can auto-approve immediately.
   */
  getImmediateDecision?(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Pick<PermissionResult, 'decision'> | null;

  /**
   * Handle a tool permission request
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @returns Promise resolving to permission result with decision
   */
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<PermissionResult>;

  /**
   * Finalize one provider-owned prompt that can no longer accept a response.
   * Neighboring permission requests remain pending.
   */
  cancelPendingRequest?(requestId: string, reason: string): boolean;

  /**
   * Abort any ACP permission requests still waiting on user/provider state.
   *
   * This is intentionally event-driven from turn finalization/cancellation, not timer-based.
   */
  abortPendingRequestsAndFlush?(reason: string): Promise<void>;
}

export type SessionMode = {
  id: string;
  name: string;
  description?: string;
};

export type AcpExtensionHandlers = ReadonlyArray<AcpExtensionRegistration>;
export type { AcpExtensionHandlerContext } from './connection/types';

export type SessionModeState = {
  currentModeId: string;
  availableModes: SessionMode[];
};

export type SessionModel = {
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: SessionConfigOption[];
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: SessionModel[];
};

export type AcpSessionModelAdapter = Readonly<{
  projectModel?: (params: Readonly<{
    rawModel: Readonly<Record<string, unknown>>;
    normalizedModel: Readonly<SessionModel>;
  }>) => Readonly<SessionModel>;
  projectModelOptions?: (params: Readonly<{
    rawModel: Readonly<Record<string, unknown>>;
    normalizedModelOptions: ReadonlyArray<SessionConfigOption>;
  }>) => ReadonlyArray<SessionConfigOption>;
  resolveConfigOptionModelUpdate?: (params: Readonly<{
    configId: string;
    value: SessionConfigOptionValueId;
    modelState: Readonly<SessionModelState> | null;
  }>) => Readonly<{
    modelId: string;
    requestMeta?: Readonly<Record<string, unknown>>;
  }> | undefined;
}>;

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

function normalizeConfigOptionValueId(value: unknown): string | boolean | null {
  return readSessionControlValueId(value);
}

function readNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readAcpUsageCost(record: Record<string, unknown>): Record<string, number> | undefined {
  const nested = record.cost && typeof record.cost === 'object' && !Array.isArray(record.cost)
    ? record.cost as Record<string, unknown>
    : null;
  const nestedCurrency = typeof nested?.currency === 'string' ? nested.currency.trim().toLowerCase() : null;
  const nestedAmount =
    !nested || (nestedCurrency !== null && nestedCurrency !== 'usd')
      ? null
      : readNonNegativeFiniteNumber(nested.amount);
  const total =
    readNonNegativeFiniteNumber(record.cost_usd) ??
    readNonNegativeFiniteNumber(record.costUsd) ??
    readNonNegativeFiniteNumber(record.total_cost_usd) ??
    readNonNegativeFiniteNumber(record.totalCostUsd) ??
    readNonNegativeFiniteNumber(record.total_cost) ??
    readNonNegativeFiniteNumber(record.totalCost) ??
    (nested
      ? readNonNegativeFiniteNumber(nested.total) ??
        readNonNegativeFiniteNumber(nested.usd) ??
        readNonNegativeFiniteNumber(nested.total_usd) ??
        readNonNegativeFiniteNumber(nested.totalUsd) ??
        nestedAmount
      : null) ??
    (typeof record.cost === 'number' ? readNonNegativeFiniteNumber(record.cost) : null);
  return total === null ? undefined : { total };
}

function normalizeSessionConfigOptions(raw: ReadonlyArray<unknown>): SessionConfigOption[] {
  const out: SessionConfigOption[] = [];

  for (const entryRaw of raw) {
    const entry = asRecord(entryRaw);
    if (!entry) continue;

    const id = readNonBlankSessionControlIdentifier(entry.id);
    const name = getString(entry, 'name');
    const type = getString(entry, 'type');
    if (!id || !name || !type) continue;

    const currentValue = normalizeConfigOptionValueId((entry as any).currentValue);
    if (currentValue === null) continue;

    const description = getString(entry, 'description');
    const category = getString(entry, 'category');
    const optionsCandidate = (entry as any).options;
    const optionsRaw = Array.isArray(optionsCandidate) ? optionsCandidate : null;

    const options = normalizeAcpConfigOptionChoices(optionsRaw, normalizeConfigOptionValueId);

    out.push({
      id,
      name,
      type,
      currentValue,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      ...(options.length > 0 ? { options } : {}),
    });
  }

  return out;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isAcpFsEnabled(): boolean {
  // Default ON: ACP agents that support the `fs` capability will route file reads/writes
  // through the client (Happier). This is the only reliable way for Happier to enforce
  // workspace boundaries for ACP backends.
  const raw = process.env.HAPPIER_ACP_FS;
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

export function buildInitializeRequest(params: {
  clientName: string;
  clientVersion: string;
  planUpdates?: boolean;
  initializeMeta?: Record<string, unknown>;
  initializeClientCapabilitiesMeta?: Record<string, unknown>;
}): InitializeRequest {
  const fsEnabled = isAcpFsEnabled();
  const initializeMeta =
    params.initializeMeta && Object.keys(params.initializeMeta).length > 0
      ? params.initializeMeta
      : null;
  const initializeClientCapabilitiesMeta =
    params.initializeClientCapabilitiesMeta && Object.keys(params.initializeClientCapabilitiesMeta).length > 0
      ? params.initializeClientCapabilitiesMeta
      : null;
  return {
    protocolVersion: 1,
    ...(initializeMeta ? { _meta: initializeMeta } : {}),
    clientCapabilities: {
      ...(initializeClientCapabilitiesMeta ? { _meta: initializeClientCapabilitiesMeta } : {}),
      ...(params.planUpdates ? { plan: {} } : {}),
      fs: {
        readTextFile: fsEnabled,
        writeTextFile: fsEnabled,
      },
    },
    clientInfo: {
      name: params.clientName,
      version: params.clientVersion,
    },
  };
}

export function createAcpClientFsMethods(params: {
  cwd: string;
  permissionHandler?: AcpPermissionHandler;
}): Pick<AcpClientConnectionHandlers, 'readTextFile' | 'writeTextFile'> {
  const rootResolved = resolve(params.cwd);
  const rootRealPromise = fs.realpath(rootResolved).catch(() => rootResolved);

  const isWithinRoot = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };

  const isWithinAnyRoot = (roots: string[], target: string): boolean => {
    for (const root of roots) {
      if (isWithinRoot(root, target)) return true;
    }
    return false;
  };

  const assertWithinCwd = async (targetPath: string, opts: { kind: 'read' | 'write' }): Promise<void> => {
    const targetResolved = resolve(targetPath);
    if (!isWithinRoot(rootResolved, targetResolved)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

    const rootReal = await rootRealPromise;
    // `realpath()` can normalize the same directory into different spellings on some platforms
    // (for example: Windows mapped drive letters vs UNC paths). Treat both spellings as valid roots.
    const roots = rootReal === rootResolved ? [rootResolved] : [rootResolved, rootReal];
    const resolveExistingAncestorRealPath = async (startPath: string): Promise<string> => {
      let candidate = startPath;
      while (true) {
        const candidateReal = await fs.realpath(candidate).catch((error) => {
          const errno = (error as NodeJS.ErrnoException | undefined)?.code;
          if (errno === 'ENOENT') return null;
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        });
        if (candidateReal) return candidateReal;
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        }
        candidate = parent;
      }
    };

    if (opts.kind === 'read') {
      const targetReal = await fs.realpath(targetResolved).catch((error) => {
        const errno = (error as NodeJS.ErrnoException | undefined)?.code;
        if (errno === 'ENOENT') return targetResolved;
        throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
      });
      if (!isWithinAnyRoot(roots, targetReal)) {
        throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
      }
      return;
    }

    const targetReal = await fs.realpath(targetResolved).catch((error) => {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errno === 'ENOENT') return null;
      throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
    });
    if (targetReal && !isWithinAnyRoot(roots, targetReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

    const existingAncestorReal = await resolveExistingAncestorRealPath(dirname(targetResolved));
    if (!isWithinAnyRoot(roots, existingAncestorReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }
  };

  const readTextFile: NonNullable<AcpClientConnectionHandlers['readTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'read' });
    const full = await fs.readFile(targetPath, 'utf8');
    const line = typeof req.line === 'number' ? req.line : null;
    const limit = typeof req.limit === 'number' ? req.limit : null;

    if (line === null && limit === null) {
      return { content: full };
    }

    const lines = full.split('\n');
    const startIdx = Math.max(0, (line ?? 1) - 1);
    const endIdx = limit === null ? lines.length : startIdx + Math.max(0, limit);
    const slice = lines.slice(startIdx, endIdx);
    // Preserve behavior similar to "read lines": remove trailing empty line if caused by final newline.
    if (slice.length > 0 && slice[slice.length - 1] === '') slice.pop();
    return { content: slice.join('\n') };
  };

  const writeTextFile: NonNullable<AcpClientConnectionHandlers['writeTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'write' });
    const reqRecord = asRecord(req) ?? {};
    const meta = asRecord(reqRecord._meta) ?? {};
    const toolCallId = typeof meta.toolCallId === 'string' ? meta.toolCallId : `acp-fs-write:${randomUUID()}`;

    if (params.permissionHandler) {
      const result = await params.permissionHandler.handleToolCall(toolCallId, 'writeTextFile', {
        path: targetPath,
        bytes: Buffer.byteLength(req.content, 'utf8'),
      });

      const approved =
        result.decision === 'approved' ||
        result.decision === 'approved_for_session' ||
        result.decision === 'approved_execpolicy_amendment';

      if (!approved) {
        throw new Error(`Permission denied for writeTextFile (${toolCallId})`);
      }
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, req.content, 'utf8');
    return {};
  };

  return { readTextFile, writeTextFile };
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

  /** Inherited process environment variables to remove before provider env overrides are applied */
  unsetEnv?: readonly string[];

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Transport handler for agent-specific behavior (timeouts, filtering, etc.) */
  transportHandler?: TransportHandler;

  /** Optional callback to check if prompt has change_title instruction */
  hasChangeTitleInstruction?: (prompt: string) => boolean;

  /** Optional authentication selected only after a successful ACP initialize response. */
  authentication?: AcpAuthentication;

  /** Optional ACP initialize _meta payload for provider-specific extension negotiation. */
  initializeMeta?: Record<string, unknown>;

  /** Optional ACP clientCapabilities._meta payload for provider-specific extension negotiation. */
  initializeClientCapabilitiesMeta?: Record<string, unknown>;

  /** Provider-owned handlers for non-standard ACP extension requests/notifications. */
  extensionHandlers?: AcpExtensionHandlers;

  /** Provider-owned request metadata for an exactly correlated secondary prompt-completion signal. */
  promptCompletion?: Readonly<{
    buildRequestMeta: (params: Readonly<{ correlationId: string }>) => Readonly<Record<string, unknown>>;
  }>;

  /** Provider-owned projection/application for model metadata not standardized by ACP. */
  sessionModelAdapter?: AcpSessionModelAdapter;

  /** Provider-owned in-flight steer extension. Omit to retain the ACP session/prompt contract. */
  inFlightSteer?: AcpInFlightSteerAdapter;

  /** Provider-owned projection for non-standard prompt usage fields and accounting semantics. */
  promptUsageAdapter?: AcpPromptUsageAdapter;
}

export type AcpSteerDeliveryIdentity = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export type AcpInFlightSteerAdapter = Readonly<{
  method: string;
  buildParams(input: Readonly<{
    sessionId: string;
    prompt: string;
    deliveryIdentity?: AcpSteerDeliveryIdentity;
  }>): unknown;
  isAccepted(response: unknown): boolean;
}>;

export type AcpPromptUsageProjection = Readonly<{
  tokens: Readonly<Record<string, number>>;
  cost?: Readonly<Record<string, number>>;
  modelId?: string;
}>;

export type AcpPromptUsageAdapter = Readonly<{
  project(input: Readonly<{
    usage: unknown;
    promptResponse: Readonly<Record<string, unknown>>;
  }>): AcpPromptUsageProjection | null;
}>;

/**
 * ACP backend using the official @agentclientprotocol/sdk
 */
export class AcpBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private stderrAppender: BoundedTextFileAppender | null = null;
  private readonly summarizeStderrForLogs = createAcpStderrLogSummarizer();
  private readonly recentStderrSummaries: string[] = [];
  private lastProcessExitDetail: string | null = null;
  private readonly sessionUpdateShapeLogger = createEventShapeLoggerForLog({ logger, scope: 'acp-backend' });
  private connection: AcpClientConnection | null = null;
  private acpSessionId: string | null = null;
  private disposed = false;
  private replayCapture: AcpReplayCapture | null = null;
  /** Sole tool lifecycle/merge/timeout/finalization owner. */
  private readonly toolCalls: AcpToolCallTracker;
  /** Sole standard/proprietary plan replace/merge/fingerprint owner. */
  private readonly plans: AcpPlanProjection;
  private planStatePublisher: ((snapshot: NormalizedAcpPlanSnapshot) => Promise<void>) | null = null;
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

  async requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<Response> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection) {
      throw new Error('ACP connection is not initialized');
    }
    return await this.connection.peer.requestExtension<Response, Params>(method, params, options);
  }

  /** Track tool calls count since last prompt (to identify first tool call) */
  private toolCallCountSincePrompt = 0;
  /** Timeout for emitting 'idle' status after last message chunk */
  private idleTimeout: NodeJS.Timeout | null = null;
  private turnGeneration = 0;
  private closedTurnGeneration: number | null = null;
  private pendingTurnOutcome: AcpTurnOutcome | null = null;
  private lastTurnOutcome: AcpTurnOutcome | null = null;
  private permissionFlushTurnGeneration: number | null = null;
  private extensionAbortController = new AbortController();
  /**
   * The generation whose session/prompt request has been handed to the ACP peer.
   * Prompt-turn notifications are attributable to a generation only after this boundary.
   */
  private dispatchedPromptTurnGeneration: number | null = null;
  private promptCompletionSettlement: Readonly<{
    generation: number;
    correlationId: string;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }> | null = null;
  /** The raw session/prompt RPC remains the ownership boundary until it settles. */
  private activePromptRpc: Readonly<{
    generation: number;
    settled: Promise<void>;
  }> | null = null;

  /** Transport handler for agent-specific behavior */
  private readonly transport: TransportHandler;

  constructor(private options: AcpBackendOptions) {
    this.transport = options.transportHandler ?? new DefaultTransport(options.agentName);
    this.plans = new AcpPlanProjection({
      publish: async (snapshot) => {
        if (!this.planStatePublisher) {
          throw new Error('ACP plan state publisher is unavailable');
        }
        await this.planStatePublisher(snapshot);
      },
    });
    this.toolCalls = createAcpToolCallLifecycle({
      transport: this.transport,
      emit: (message) => this.emit(message),
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
        toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      }),
      onCallClosed: ({ callId, reason, activeSize }) => {
        logger.debug(`[AcpBackend] Tool call closed: ${callId} (${reason}); active=${activeSize}`);
        if ((reason === 'terminal' || reason === 'timeout') && activeSize === 0 && !this.disposed) {
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          this.scheduleIdleStatusAfterToolCompletion();
        }
      },
    });
  }

  setPlanStatePublisher(
    publisher: (snapshot: NormalizedAcpPlanSnapshot) => Promise<void>,
  ): void {
    this.planStatePublisher = publisher;
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
    const trimmed = summary.trim();
    if (!trimmed) return;
    this.recentStderrSummaries.push(trimmed);
    while (this.recentStderrSummaries.length > 3) {
      this.recentStderrSummaries.shift();
    }
  }

  private buildStartupFailureDiagnosticSuffix(): string {
    const parts: string[] = [];
    if (this.lastProcessExitDetail) {
      parts.push(`Process exit: ${this.lastProcessExitDetail}`);
    }
    if (this.recentStderrSummaries.length > 0) {
      parts.push(`Recent ACP stderr: ${this.recentStderrSummaries.join(' | ')}`);
    }
    if (this.stderrAppender?.path) {
      parts.push(`ACP stderr artifact: ${this.stderrAppender.path}`);
    }
    return parts.length > 0 ? `. ${parts.join('. ')}` : '';
  }

  private createStartupTimeoutError(operationName: string, timeoutMs: number): Error {
    return new Error(
      `${operationName} timeout after ${timeoutMs}ms - ${this.transport.agentName} did not respond${this.buildStartupFailureDiagnosticSuffix()}`,
    );
  }

  private buildAcpMcpServersForSessionRequest(): NewSessionRequest['mcpServers'] {
    if (!this.options.mcpServers) return [] as unknown as NewSessionRequest['mcpServers'];
    const mcpServers = Object.entries(this.options.mcpServers).map(([name, config]) => ({
      type: 'stdio',
      name,
      command: config.command,
      args: config.args || [],
      env: config.env
        ? Object.entries(config.env).map(([envName, envValue]) => ({ name: envName, value: envValue }))
        : [],
    }));
    return mcpServers as unknown as NewSessionRequest['mcpServers'];
  }

  private async cleanupInitializedProcessConnection(params: { graceMs: number }): Promise<void> {
    const proc = this.process;
    const connection = this.connection;
    this.process = null;
    this.connection = null;
    this.acpSessionId = null;

    connection?.close();

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

  private buildSpawnEnv(): NodeJS.ProcessEnv {
    const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
    const unsetEnvKeys = new Set(
      (this.options.unsetEnv ?? [])
        .filter((key) => key.trim().length > 0)
        .map((key) => key.toLowerCase()),
    );
    if (unsetEnvKeys.size > 0) {
      for (const key of Object.keys(inheritedEnv)) {
        if (unsetEnvKeys.has(key.toLowerCase())) {
          delete inheritedEnv[key];
        }
      }
    }
    return { ...inheritedEnv, ...this.options.env };
  }

  private resetExtensionAbortControllerForTurn(): void {
    if (this.extensionAbortController.signal.aborted) {
      this.extensionAbortController = new AbortController();
    }
  }

  private abortPendingExtensionHandlers(reason: string): void {
    if (!this.extensionAbortController.signal.aborted) {
      this.extensionAbortController.abort(makeAbortError(reason));
    }
  }

  private createExtensionHandlerContext(
    method: string,
    sdkSignal: AbortSignal,
  ): AcpExtensionHandlerContext {
    return {
      method,
      sessionId: this.acpSessionId,
      signal: AbortSignal.any([sdkSignal, this.extensionAbortController.signal]),
      agentName: this.options.agentName,
      turnId: resolveAcpPlanTurnId(this.turnGeneration),
      plans: this.plans,
      toolCalls: this.toolCalls,
      ...(this.options.promptCompletion
        ? {
            promptCompletion: {
              settle: (params: Readonly<{
                correlationId: string;
                outcome:
                  | Readonly<{ kind: 'completed'; response: PromptResponse }>
                  | Readonly<{ kind: 'failed'; error: Error }>;
              }>) => this.settlePromptFromExtension(params),
            },
          }
        : {}),
    };
  }

  private async createConnectionAndInitialize(params: { operationId: string }): Promise<{ initTimeout: number }> {
    logger.debug(`[AcpBackend] Starting process + initializing connection (op=${params.operationId})`);

    if (this.process || this.connection) {
      throw new Error('ACP backend is already initialized');
    }

    this.resetExtensionAbortControllerForTurn();
    this.recentStderrSummaries.length = 0;
    this.lastProcessExitDetail = null;

    try {
      // Spawn the ACP agent process.
      // Use cross-spawn so Windows quoting/.cmd resolution is handled safely without joining args.
      const spec = buildAcpSpawnSpec({
        command: this.options.command,
        args: this.options.args || [],
        cwd: this.options.cwd,
        env: this.buildSpawnEnv(),
      });

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
	      const hasActiveInvestigation = this.transport.isInvestigationTool
	        ? this.toolCalls.activeCallIds().some(id => this.transport.isInvestigationTool!(id))
	        : false;

      const context: StderrContext = {
        activeToolCalls: new Set(this.toolCalls.activeCallIds()),
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
        // If the transport surfaces a fatal error via a status message, fail any pending
        // `waitForResponseComplete()` caller so we don't degrade into a generic timeout.
        if (
          stderrResult.message.type === 'status' &&
          stderrResult.message.status === 'error' &&
          this.shouldAcceptTransportCompletionFailure()
        ) {
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
      this.abortPendingExtensionHandlers('ACP process error');
      this.failPendingResponseWait(err instanceof Error ? err : new Error(String(err)));
      this.emit({ type: 'status', status: 'error', detail: err.message });
    });

	    this.process.on('exit', (code, signal) => {
	      this.abortPendingExtensionHandlers('ACP process exited');
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
        if (
          this.shouldAcceptTransportCompletionFailure() &&
          (!this.responseCompletionError || this.isUserCancellationCompletionError(this.responseCompletionError)) &&
          entry.reason === 'transport_filter_null'
        ) {
          const raw = entry.line;
          const trimmed = raw.trim();
          if (trimmed) {
            const context: StderrContext = {
              activeToolCalls: new Set(this.toolCalls.activeCallIds()),
              hasActiveInvestigation: this.transport.isInvestigationTool
                ? this.toolCalls.activeCallIds().some((id) => this.transport.isInvestigationTool!(id))
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

    // Create client handlers. The generic connection owner registers these on the public SDK app API.
    const clientHandlers: AcpClientConnectionHandlers = {
      sessionUpdate: async (params: SessionNotification) => {
        await this.handleSessionUpdate(params);
      },
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const extendedParams = params as ExtendedRequestPermissionRequest;
        const toolCall = extendedParams.toolCall;
        const options = extendedParams.options || [];
        // ACP spec: toolCall.toolCallId is the correlation ID. Fall back to legacy fields when needed.
        const toolCallId =
          (typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId.trim().length > 0)
            ? toolCall.toolCallId
            : (typeof toolCall?.id === 'string' && toolCall.id.trim().length > 0)
              ? toolCall.id
              : randomUUID();
        const permissionId = toolCallId;

        let toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
        const resolvedToolNameHint = resolvePermissionToolName({
          toolNameHint,
          toolCallId,
          toolCallIdToNameMap: { get: (id) => this.toolCalls.get(id)?.toolName },
        });
        const input = extractPermissionInputWithFallback(
          extendedParams as PermissionRequestLike,
          toolCallId,
          {
            get: (id) => {
              const rawInput = this.toolCalls.get(id)?.snapshot.rawInput;
              return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                ? rawInput as Record<string, unknown>
                : undefined;
            },
          },
          { toolNameHint: resolvedToolNameHint },
        );
        toolNameHint = refinePermissionToolNameWithInput(toolNameHint, input);
        let toolName = resolvePermissionToolName({
          toolNameHint,
          toolCallId,
          toolCallIdToNameMap: { get: (id) => this.toolCalls.get(id)?.toolName },
        });

        // If the agent re-prompts with the same toolCallId, reuse the previous selection when possible.
        const cachedOptionId = this.lastSelectedPermissionOptionIdByToolCallId.get(toolCallId);
        if (cachedOptionId && options.some((opt) => opt.optionId === cachedOptionId)) {
          logger.debug(`[AcpBackend] Duplicate permission prompt for ${toolCallId}, reusing cached optionId=${cachedOptionId}`);
          return { outcome: { outcome: 'selected', optionId: cachedOptionId } };
        }

        // If toolName is "other" or "Unknown tool", try to determine real tool name
        const context: ToolNameContext = {
          recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
          toolCallCountSincePrompt: this.toolCallCountSincePrompt,
        };
        toolName = this.transport.determineToolName?.(toolName, toolCallId, input, context) ?? toolName;

        if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
          logger.debug(`[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
        }

        // Seed tool-call identity for later tool_call_update events.
        // Some providers emit a permission prompt before (or instead of) an initial tool_call update.
        // When the subsequent tool_call_update omits kind/title, we still want stable tool names and
        // the correct renderer in the UI.
        const existingToolCall = this.toolCalls.get(toolCallId);
        const seededToolName = existingToolCall
          && !shouldReplaceCachedPermissionToolName(existingToolCall.toolName, toolName)
          ? existingToolCall.toolName
          : toolName;
        this.toolCalls.observe({
          toolCallId,
          kind: seededToolName,
          status: 'pending',
          ...(typeof toolCall?.title === 'string' ? { title: toolCall.title } : {}),
          ...(Object.keys(input).length > 0 ? { rawInput: input } : {}),
        });
        markToolCallWaitingForPermission(toolCallId, this.createHandlerContext());

        // Increment tool call counter for context tracking
        this.toolCallCountSincePrompt++;

        const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
          ? Object.keys(input as Record<string, unknown>)
          : [];
        logger.debug(`[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, inputKeys=${inputKeys.join(',')}`);
        logger.debug(`[AcpBackend] Permission request params structure:`, JSON.stringify({
          hasToolCall: !!toolCall,
          toolCallToolCallId: toolCall?.toolCallId,
          toolCallKind: toolCall?.kind,
          toolCallToolName: toolCall?.toolName,
          toolCallId: toolCall?.id,
          paramsKind: extendedParams.kind,
          options: options.map((opt) => ({ optionId: opt.optionId, kind: opt.kind, name: opt.name })),
          paramsKeys: Object.keys(params),
        }, null, 2));

        const immediateDecision = this.options.permissionHandler?.getImmediateDecision?.(
          toolCallId,
          toolName,
          input,
        ) ?? null;

        if (!immediateDecision) {
          // Emit permission request event for UI/mobile handling only when the handler cannot
          // auto-approve synchronously. This avoids noisy prompt flashes for shell-bridge tools.
          this.emit({
            type: 'permission-request',
            id: permissionId,
            reason: toolName,
            payload: {
              ...params,
              permissionId,
              toolCallId,
              toolName,
              input,
              options: options.map((opt) => ({
                id: opt.optionId,
                name: opt.name,
                kind: opt.kind,
              })),
            },
          });
        }

        // Use permission handler if provided, otherwise auto-approve
        if (this.options.permissionHandler) {
          try {
            const result = await this.options.permissionHandler.handleToolCall(
              toolCallId,
              toolName,
              input
            );

            const isApproved = result.decision === 'approved'
              || result.decision === 'approved_for_session'
              || result.decision === 'approved_execpolicy_amendment';

            const resolvedDecision = String(result.decision);
            const overrideOptionId = this.transport.pickPermissionOptionId?.(
              options,
              resolvedDecision,
              { toolCallId, toolName, input },
            );
            const outcome = (() => {
              if (overrideOptionId === null) return { outcome: 'cancelled' as const };
              if (typeof overrideOptionId === 'string' && overrideOptionId.trim().length > 0) {
                if (options.some((opt) => opt.optionId === overrideOptionId)) {
                  return { outcome: 'selected' as const, optionId: overrideOptionId };
                }
                logger.debug('[AcpBackend] Transport returned unknown permission optionId override; falling back to default mapping', {
                  toolCallId,
                  toolName,
                  optionId: overrideOptionId,
                });
              }
              return pickPermissionOutcome(options, resolvedDecision);
            })();
            if (outcome.outcome === 'selected') {
              this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
            } else {
              this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
            }

            await this.respondToPermission(permissionId, isApproved);

            if (result.decision === 'denied' || result.decision === 'abort') {
              // When the user declines a permission prompt, abort the in-flight prompt turn so the
              // agent doesn't continue and retry tool calls. This matches our non-ACP behavior.
              //
              // Important: still return the actual permission outcome (e.g. "deny") so ACP agents
              // can distinguish an explicit rejection from a transport cancellation.
              const requestSessionId =
                typeof (extendedParams as any).sessionId === 'string'
                  ? String((extendedParams as any).sessionId)
                  : (this.acpSessionId ?? '');
              void this.cancel(requestSessionId);
              this.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
              return { outcome };
            }

            if (isApproved) {
              markToolCallRunningAfterPermission(toolCallId, this.createHandlerContext());
            } else {
              this.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
            }
            return { outcome };
          } catch (error) {
            // Log to file only, not console
            logger.debug('[AcpBackend] Error in permission handler:', error);
            this.clearTrackedToolCall(toolCallId, 'permission handler error');
            // Fallback to deny on error
            return { outcome: { outcome: 'cancelled' } };
          }
        }

        // Auto-approve once if no permission handler.
        const outcome = pickPermissionOutcome(options, 'approved');
        if (outcome.outcome === 'selected') {
          this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
        } else {
          this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
        }
        markToolCallRunningAfterPermission(toolCallId, this.createHandlerContext());
        return { outcome };
      },
    };

    if (isAcpFsEnabled()) {
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
      extensions: this.options.extensionHandlers,
      createExtensionContext: (method, sdkSignal) => (
        this.createExtensionHandlerContext(method, sdkSignal)
      ),
    });

    // Initialize the connection with timeout and retry
    const initRequest = buildInitializeRequest({
      clientName: 'happier-cli',
      clientVersion: packageJson.version,
      planUpdates: this.planStatePublisher !== null,
      initializeMeta: this.options.initializeMeta,
      initializeClientCapabilitiesMeta: this.options.initializeClientCapabilitiesMeta,
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

    if (this.options.authentication) {
      const advertisedMethodIds = new Set<string>();
      const methods = (initResponse as InitializeResponse | null)?.authMethods ?? [];
      if (Array.isArray(methods)) {
        for (const method of methods) {
          const methodRecord = asRecord(method);
          const methodId = methodRecord ? getString(methodRecord, 'id')?.trim() ?? '' : '';
          if (methodId) advertisedMethodIds.add(methodId);
        }
      }
      const initRecord = asRecord(initResponse);
      const rawInitializeMeta = asRecord(initRecord?._meta);
      const selection = resolveAcpAuthenticationSelection({
        authentication: this.options.authentication,
        advertisedMethodIds,
        initializeMeta: rawInitializeMeta ? Object.freeze({ ...rawInitializeMeta }) : null,
      });
      const authenticateRequest = selection.meta
        ? { methodId: selection.methodId, _meta: selection.meta }
        : { methodId: selection.methodId };

      logger.debug(`[AcpBackend] Authenticating with methodId=${selection.methodId}...`);
      await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.peer.authenticate(authenticateRequest).then((res) => {
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

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    await this.plans.reset();
    this.toolCalls.reset();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      // Create a new session with retry
      const newSessionRequest: NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest(),
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
      this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();

      // Send initial prompt if provided
      if (initialPrompt) {
        this.sendPrompt(sessionId, initialPrompt).catch((error) => {
          // Log to file only, not console
          logger.debug('[AcpBackend] Error sending initial prompt:', error);
          this.emit({ type: 'status', status: 'error', detail: String(error) });
        });
      }

      return { sessionId };

    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpBackend] Error starting session:', error);
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: error instanceof Error ? error.message : String(error) 
      });
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
    await this.plans.reset();
    this.toolCalls.reset();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      const loadSessionRequest: LoadSessionRequest = {
        sessionId: normalized,
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest() as unknown as LoadSessionRequest['mcpServers'],
      };

      logger.debug(`[AcpBackend] Loading session: ${normalized}`);

      const sessionResponse = await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.peer.loadSession(loadSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(this.createStartupTimeoutError('Load session', initTimeout));
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
          operationName: 'LoadSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );

      this.acpSessionId = normalized;
      logger.debug(`[AcpBackend] Session loaded: ${normalized}`);

      this.seedSessionModesFromSessionResponse(sessionResponse);
      this.seedSessionModelsFromSessionResponse(sessionResponse);
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
      if (!connection) {
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
      this.seedSessionModelsFromSessionResponse(response);
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

  /**
   * Create handler context for session update processing
   */
  private createHandlerContext(): HandlerContext {
    return {
      transport: this.transport,
      toolCalls: this.toolCalls,
      turnId: resolveAcpPlanTurnId(this.turnGeneration),
      plans: this.plans,
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

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const raw = asRecord(params) ?? {};
    const updateCandidates: unknown[] = [];

    const maxUpdatesPerNotification = (() => {
      const rawMax =
        process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION ??
        process.env.HAPPY_ACP_MAX_UPDATES_PER_NOTIFICATION ??
        '';
      const parsed = Number.parseInt(String(rawMax).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10_000);
      return 1000;
    })();

    const pushUpdateCandidate = (value: unknown): boolean => {
      if (updateCandidates.length >= maxUpdatesPerNotification) return false;
      updateCandidates.push(value);
      return true;
    };

    if (raw.update !== undefined) {
      const updateField = raw.update;
      if (Array.isArray(updateField)) {
        for (const item of updateField) {
          if (!pushUpdateCandidate(item)) {
            logger.warn(
              `[AcpBackend] Received ${updateField.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`
            );
            break;
          }
        }
      } else {
        pushUpdateCandidate(updateField);
      }
    } else if (Array.isArray(raw.updates)) {
      for (const item of raw.updates) {
        if (!pushUpdateCandidate(item)) {
          logger.warn(
            `[AcpBackend] Received ${raw.updates.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`
          );
          break;
        }
      }
    }

    if (updateCandidates.length === 0) {
      logger.debug('[AcpBackend] Received session update without update field:', params);
      return;
    }

    if (this.replayCapture) {
      for (const update of updateCandidates) {
        try {
          this.replayCapture.handleUpdate(update as SessionUpdate);
        } catch (error) {
          logger.debug('[AcpBackend] Replay capture failed (non-fatal)', { error });
        }
      }
    }

    const processableUpdateCandidates = this.filterPromptTurnUpdatesByDispatch(updateCandidates);

    if (processableUpdateCandidates.length === 0) {
      logger.debug('[AcpBackend] Dropping prompt-turn session/update outside an active dispatched generation');
      return;
    }

    if (this.waitingForResponse) {
      this.sawSessionUpdateSincePrompt = true;
      if (this.postPromptCompletionIdleTimeout) {
        clearTimeout(this.postPromptCompletionIdleTimeout);
        this.postPromptCompletionIdleTimeout = null;
      }
      if (this.postIdleWithoutAssistantMessageTimeout) {
        clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
        this.postIdleWithoutAssistantMessageTimeout = null;
      }
      if (this.firstSessionUpdateSincePromptResolver) {
        const resolve = this.firstSessionUpdateSincePromptResolver;
        this.firstSessionUpdateSincePromptResolver = null;
        resolve();
      }
      // Treat response-completion timeouts as a stall budget: as long as ACP session/update
      // traffic keeps arriving, continue waiting.
      this.bumpResponseCompletionTimeout();
    }

    const isGeminiAcpDebugEnabled = (() => {
      const flag = process.env.HAPPIER_STACK_GEMINI_ACP_DEBUG;
      return flag === '1' || flag === 'true';
    })();

    const sanitizeForLogs = (value: unknown, depth = 0): unknown => {
      if (depth > 4) return '[truncated depth]';
      if (typeof value === 'string') {
        const max = 400;
        if (value.length <= max) return value;
        return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
      }
      if (Array.isArray(value)) {
        if (value.length > 50) {
          return [...value.slice(0, 50).map((v) => sanitizeForLogs(v, depth + 1)), `… [truncated ${value.length - 50} items]`];
        }
        return value.map((v) => sanitizeForLogs(v, depth + 1));
      }
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (/(token|secret|authorization|cookie|api[_-]?key|password)/i.test(k)) {
            out[k] = '[redacted]';
            continue;
          }
          out[k] = sanitizeForLogs(v, depth + 1);
        }
        return out;
      }
      return value;
    };

    const handleOneUpdate = async (update: SessionUpdate): Promise<void> => {
      const sessionUpdateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
      this.sessionUpdateShapeLogger.log(
        `inbound:${this.options.agentName}:${sessionUpdateType ?? 'unknown'}`,
        update,
      );
      if (
        sessionUpdateType === 'agent_message_chunk'
        || (update.messageChunk && typeof update.messageChunk.textDelta === 'string' && update.messageChunk.textDelta.length > 0)
      ) {
        this.sawAssistantMessageSincePrompt = true;
      }

      if (this.replayCapture) {
        // Suppress transcript-affecting updates during loadSession replay.
        const suppress = sessionUpdateType === 'user_message_chunk'
          || sessionUpdateType === 'agent_message_chunk'
          || sessionUpdateType === 'agent_thought_chunk'
          || sessionUpdateType === 'tool_call'
          || sessionUpdateType === 'tool_call_update'
          || sessionUpdateType === 'plan';
        if (suppress) {
          return;
        }
      }

      // Log session updates for debugging (but not every chunk to avoid log spam)
      if (sessionUpdateType !== 'agent_message_chunk') {
        logger.debug(`[AcpBackend] Received session update: ${sessionUpdateType}`, JSON.stringify({
          sessionUpdate: sessionUpdateType,
          toolCallId: update.toolCallId,
          status: update.status,
          kind: update.kind,
          hasContent: !!update.content,
          hasLocations: !!update.locations,
        }, null, 2));
      }

      // Gemini ACP deep debug: dump raw terminal tool updates to verify where tool outputs live.
      if (
        isGeminiAcpDebugEnabled &&
        this.transport.agentName === 'gemini' &&
        (sessionUpdateType === 'tool_call_update' || sessionUpdateType === 'tool_call') &&
        (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled')
      ) {
        const keys = Object.keys(update);
        logger.debug('[AcpBackend] [GeminiACP] Terminal tool update keys:', keys);
        logger.debug('[AcpBackend] [GeminiACP] Terminal tool update payload:', JSON.stringify(sanitizeForLogs(update), null, 2));
      }

      const ctx = this.createHandlerContext();

      // Dispatch to appropriate handler based on update type
      if (sessionUpdateType === 'agent_message_chunk') {
        handleAgentMessageChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'user_message_chunk') {
        handleUserMessageChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'tool_call_update') {
        const result = handleToolCallUpdate(update, ctx);
        if (result.toolCallCountSincePrompt !== undefined) {
          this.toolCallCountSincePrompt = result.toolCallCountSincePrompt;
        }
        return;
      }

      if (sessionUpdateType === 'agent_thought_chunk') {
        handleAgentThoughtChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'tool_call') {
        handleToolCall(update, ctx);
        return;
      }

      if (sessionUpdateType === 'available_commands_update') {
        handleAvailableCommandsUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'current_mode_update') {
        const modeId = readCurrentModeId(update);
        if (modeId && this.sessionModeState) {
          this.sessionModeState = {
            ...this.sessionModeState,
            currentModeId: modeId,
          };
        }
        handleCurrentModeUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'session_info_update') {
        handleSessionInfoUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'current_model_update') {
        const modelId =
          typeof (update as any).currentModelId === 'string'
            ? (update as any).currentModelId
            : (typeof (update as any).currentModel === 'string' ? (update as any).currentModel : null);
        if (modelId && this.sessionModelState) {
          this.sessionModelState = {
            ...this.sessionModelState,
            currentModelId: modelId,
          };
        }
        this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: modelId ?? '' } });
        return;
      }

      if (sessionUpdateType === 'config_option_update') {
        const configOptionsCandidate = (update as any).configOptions;
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
        return;
      }

      if (
        sessionUpdateType === 'plan'
        || sessionUpdateType === 'plan_update'
        || sessionUpdateType === 'plan_removed'
      ) {
        await handlePlanUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'usage_update') {
        const usedRaw = (update as any).used;
        const sizeRaw = (update as any).size;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const usageCost = readAcpUsageCost(update as Record<string, unknown>);
        const used = asNum(usedRaw);
        const size = asNum(sizeRaw);
        if (used != null || size != null) {
          const tokens: Record<string, number> = { total: used ?? 0 };
          if (used != null) tokens.used = used;
          if (size != null) tokens.size = size;
          this.emit({
            type: 'token-count',
            key: 'acp-usage-update',
            tokens,
            source: 'acp-usage-update',
            ...(usageCost ? { cost: usageCost } : {}),
          });
        }
        // Some ACP providers report per-turn usage via usage_update with OpenAI-like fields.
        // Accept these best-effort and convert them into token-count telemetry.
        if (used == null && size == null) {
          const input = asNum((update as any).input_tokens) ?? asNum((update as any).prompt_tokens);
          const output = asNum((update as any).output_tokens) ?? asNum((update as any).completion_tokens);
          const cacheRead =
            asNum((update as any).cache_read_input_tokens) ?? asNum((update as any).cache_read_tokens);
          const cacheCreation =
            asNum((update as any).cache_creation_input_tokens) ?? asNum((update as any).cache_creation_tokens);

          const anyPresent = input != null || output != null || cacheRead != null || cacheCreation != null;
          if (anyPresent) {
            const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
            const tokens: Record<string, number> = { total };
            if (input != null) tokens.input = input;
            if (output != null) tokens.output = output;
            if (cacheRead != null) tokens.cache_read = cacheRead;
            if (cacheCreation != null) tokens.cache_creation = cacheCreation;
            this.emit({
              type: 'token-count',
              key: 'acp-usage-update',
              tokens,
              source: 'acp-usage-update',
              ...(usageCost ? { cost: usageCost } : {}),
            });
          }
        }
        return;
      }

      // Best-effort: some ACP providers attach usage to non-usage session updates (e.g. task_complete).
      const usageCandidate = (update as any).usage;
      if (usageCandidate && typeof usageCandidate === 'object' && !Array.isArray(usageCandidate)) {
        const record = usageCandidate as Record<string, unknown>;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const usageCost = readAcpUsageCost(record);

        const input =
          asNum(record.input_tokens) ??
          asNum(record.inputTokens) ??
          asNum(record.prompt_tokens) ??
          asNum(record.promptTokens);
        const output =
          asNum(record.output_tokens) ??
          asNum(record.outputTokens) ??
          asNum(record.completion_tokens) ??
          asNum(record.completionTokens);
        const thought = asNum(record.thought_tokens) ?? asNum(record.thoughtTokens);
        const cacheRead =
          asNum(record.cached_read_tokens) ??
          asNum(record.cachedReadTokens) ??
          asNum(record.cache_read_tokens) ??
          asNum(record.cacheReadTokens);
        const cacheWrite =
          asNum(record.cached_write_tokens) ??
          asNum(record.cachedWriteTokens) ??
          asNum(record.cache_creation_tokens) ??
          asNum(record.cacheCreationTokens);
        const totalFromResponse =
          asNum(record.total_tokens) ??
          asNum(record.totalTokens);
        const total =
          totalFromResponse ??
          (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (thought ?? 0);

        const anyPresent =
          totalFromResponse != null ||
          input != null ||
          output != null ||
          cacheRead != null ||
          cacheWrite != null ||
          thought != null;

        if (anyPresent) {
          const tokens: Record<string, number> = { total };
          if (input != null) tokens.input = input;
          if (output != null) tokens.output = output;
          if (cacheRead != null) tokens.cache_read = cacheRead;
          if (cacheWrite != null) tokens.cache_creation = cacheWrite;
          if (thought != null) tokens.thought = thought;
          this.emit({
            type: 'token-count',
            key: 'acp-session-update-usage',
            tokens,
            source: 'acp-session-update-usage',
            ...(usageCost ? { cost: usageCost } : {}),
          });
        }
      }

      // Handle legacy and auxiliary update types
      handleLegacyMessageChunk(update, ctx);
      await handlePlanUpdate(update, ctx);
      handleThinkingUpdate(update, ctx);

      // Log unhandled session update types for debugging
      // Cast to string to avoid TypeScript errors (SDK types don't include all Gemini-specific update types)
      const updateTypeStr = sessionUpdateType as string;
      const handledTypes = [
        'agent_message_chunk',
        'user_message_chunk',
        'tool_call_update',
        'agent_thought_chunk',
        'tool_call',
        'available_commands_update',
        'current_mode_update',
        'session_info_update',
        'current_model_update',
        'config_option_update',
        'plan',
        'usage_update',
      ];
      if (updateTypeStr && !handledTypes.includes(updateTypeStr)) {
        const disposition = classifyAcpSessionUpdateDisposition(updateTypeStr);
        const diagnostic = buildUnknownAcpSessionUpdateDiagnostic(update);
        logger.debug(
          disposition.kind === 'stable'
            ? `[AcpBackend] Stable session update reached no runtime owner: ${diagnostic.sessionUpdate} (${disposition.disposition})`
            : `[AcpBackend] Unknown ACP extension session update: ${diagnostic.sessionUpdate}`,
          diagnostic,
        );
      }
    };

    const normalizedUpdates: SessionUpdate[] = [];
    for (const candidate of processableUpdateCandidates) {
      const update = (asRecord(candidate) ?? {}) as SessionUpdate;
      if (Object.keys(update).length === 0) continue;
      normalizedUpdates.push(update);
    }

    const mirroredStructuredChunkTexts = buildStructuredAgentMessageChunkMirrorSet(normalizedUpdates);

    for (const update of normalizedUpdates) {
      if (shouldSkipLegacyMessageChunkMirror(update, mirroredStructuredChunkTexts)) {
        continue;
      }
      await handleOneUpdate(update);
    }
  }

  private seedSessionModesFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;
    const modesRaw = asRecord(response.modes);
    if (!modesRaw) return;

    const currentModeId = getString(modesRaw, 'currentModeId');
    const availableModesRaw = Array.isArray(modesRaw.availableModes) ? modesRaw.availableModes : null;
    if (!currentModeId || !availableModesRaw) return;

    const availableModes: SessionMode[] = availableModesRaw
      .map((mode) => asRecord(mode))
      .filter((mode): mode is Record<string, unknown> => Boolean(mode))
      .map((mode) => {
        const id = getString(mode, 'id');
        const name = getString(mode, 'name');
        if (!id || !name) return null;
        const description = getString(mode, 'description');
        return { id, name, ...(description ? { description } : {}) };
      })
      .filter((mode): mode is SessionMode => Boolean(mode));

    if (availableModes.length === 0) return;

    this.sessionModeState = { currentModeId, availableModes };
    this.emit({ type: 'event', name: 'session_modes_state', payload: this.sessionModeState });
  }

  private seedSessionModelsFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;
    const modelsRaw = asRecord(response.models);
    if (!modelsRaw) return;

    const currentModelId = getString(modelsRaw, 'currentModelId');
    const availableModelsCandidate = (modelsRaw as { availableModels?: unknown }).availableModels;
    const availableModelsRaw: unknown[] | null = Array.isArray(availableModelsCandidate) ? availableModelsCandidate : null;
    if (!currentModelId || !availableModelsRaw) return;

    const availableModels: SessionModel[] = availableModelsRaw
      .map((model: unknown) => asRecord(model))
      .filter((model): model is Record<string, unknown> => Boolean(model))
      .map((model) => {
        const id = getString(model, 'id') ?? getString(model, 'modelId');
        const name = getString(model, 'name');
        if (!id || !name) return null;
        const description = getString(model, 'description');
        const modelOptionsCandidate = model['modelOptions'] ?? model['model_options'];
        const modelOptionsRaw: unknown[] | null = Array.isArray(modelOptionsCandidate) ? modelOptionsCandidate : null;
        const normalizedModelOptions = modelOptionsRaw ? normalizeSessionConfigOptions(modelOptionsRaw) : [];
        const modelOptions = this.options.sessionModelAdapter?.projectModelOptions?.({
          rawModel: model,
          normalizedModelOptions,
        }) ?? normalizedModelOptions;
        const normalizedModel: SessionModel = {
          id,
          name,
          ...(description ? { description } : {}),
          ...(modelOptions.length > 0 ? { modelOptions: [...modelOptions] } : {}),
        };
        return this.options.sessionModelAdapter?.projectModel?.({
          rawModel: model,
          normalizedModel,
        }) ?? normalizedModel;
      })
      .filter((model): model is SessionModel => Boolean(model));

    if (availableModels.length === 0) return;

    this.sessionModelState = { currentModelId, availableModels };
    this.emit({ type: 'event', name: 'session_models_state', payload: this.sessionModelState });
  }

  private seedSessionConfigOptionsFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;

    const configOptionsCandidate = (response as { configOptions?: unknown }).configOptions;
    const configOptionsRaw: unknown[] | null = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
    if (!configOptionsRaw) return;

    const configOptions = normalizeSessionConfigOptions(configOptionsRaw);
    this.sessionConfigOptionsState = configOptions;
    this.emit({ type: 'event', name: 'config_options_state', payload: { configOptions } });
  }

  async setSessionConfigOption(
    sessionId: SessionId,
    configId: string,
    valueId: string | number | boolean | null,
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

    const normalizedConfigId = readNonBlankSessionControlIdentifier(configId) ?? '';
    if (!normalizedConfigId) {
      throw new Error('Config ID is required');
    }

    const normalizedValueId = normalizeConfigOptionValueId(valueId);
    if (normalizedValueId === null) {
      throw new Error('Config value is required');
    }

    let modelUpdate: ReturnType<NonNullable<AcpSessionModelAdapter['resolveConfigOptionModelUpdate']>>;
    try {
      modelUpdate = this.options.sessionModelAdapter?.resolveConfigOptionModelUpdate?.({
        configId: normalizedConfigId,
        value: normalizedValueId,
        modelState: this.sessionModelState,
      });
    } catch (error) {
      throw SessionControlApplyError.definitive(error);
    }
    if (modelUpdate) {
      await this.setSessionModel(normalizedSessionId, modelUpdate.modelId, modelUpdate.requestMeta);
      if (this.sessionModelState) {
        this.sessionModelState = {
          ...this.sessionModelState,
          availableModels: this.sessionModelState.availableModels.map((model) =>
            model.id === modelUpdate.modelId && model.modelOptions
              ? {
                  ...model,
                  modelOptions: model.modelOptions.map((option) =>
                    option.id === normalizedConfigId
                      ? { ...option, currentValue: normalizedValueId }
                      : option),
                }
              : model),
        };
        this.emit({ type: 'event', name: 'session_models_state', payload: this.sessionModelState });
      }
      return;
    }

    const request: SetSessionConfigOptionRequest = typeof normalizedValueId === 'boolean'
      ? {
          sessionId: normalizedSessionId,
          configId: normalizedConfigId,
          type: 'boolean',
          value: normalizedValueId,
        }
      : {
          sessionId: normalizedSessionId,
          configId: normalizedConfigId,
          value: normalizedValueId,
        };

    const response = await applyAcpSessionControl(() => this.connection!.peer.setSessionConfigOption(request));

    const configOptionsCandidate = response?.configOptions;
    const configOptionsRaw = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
    if (configOptionsRaw) {
      const next = normalizeSessionConfigOptions(configOptionsRaw);
      this.sessionConfigOptionsState = next.map((option) =>
        option.id === normalizedConfigId
          ? { ...option, currentValue: normalizedValueId }
          : option
      );
    } else if (this.sessionConfigOptionsState) {
      this.sessionConfigOptionsState = this.sessionConfigOptionsState.map((option) =>
        option.id === normalizedConfigId
          ? { ...option, currentValue: normalizedValueId }
          : option
      );
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
  private firstSessionUpdateSincePromptResolver: (() => void) | null = null;
  private promptTransportWriteWaiters: Array<{
    sessionId: string;
    resolve: () => void;
  }> = [];
  private responseCompletionTimeoutMs: number | null = null;
  private responseCompletionTimeout: NodeJS.Timeout | null = null;
  private responseCompletionTimeoutRejecter: (() => void) | null = null;
  private pendingPromptResponseTurnGeneration: number | null = null;
  private idleStatusDeferredUntilPromptResponse = false;

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

  private clearResponseCompletionTimeout(): void {
    if (this.responseCompletionTimeout) {
      clearTimeout(this.responseCompletionTimeout);
      this.responseCompletionTimeout = null;
    }
    this.responseCompletionTimeoutMs = null;
    this.responseCompletionTimeoutRejecter = null;
  }

  private closeCurrentTurnGeneration(): void {
    this.closedTurnGeneration = this.turnGeneration;
    if (this.dispatchedPromptTurnGeneration === this.turnGeneration) {
      this.dispatchedPromptTurnGeneration = null;
    }
  }

  private isCurrentTurnGenerationClosed(): boolean {
    return this.closedTurnGeneration === this.turnGeneration;
  }

  private isTurnGenerationClosed(turnGeneration: number): boolean {
    return this.closedTurnGeneration === turnGeneration;
  }

  private clearActiveToolCallStateForTerminalTurn(reason: string): void {
    const activeToolCallCount = this.toolCalls.activeSize;
    if (activeToolCallCount === 0) return;
    this.toolCalls.abandonAll();

    logger.debug(
      `[AcpBackend] Abandoned ${activeToolCallCount} unresolved tool call(s) after ${reason}`,
    );
  }

  private finalizeTurnOutcome(outcome: AcpTurnOutcome): void {
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

    this.lastTurnOutcome = outcome;
    this.pendingTurnOutcome = outcome;
    if (this.promptCompletionSettlement?.generation === this.turnGeneration) {
      this.promptCompletionSettlement = null;
    }
    this.dispatchedPromptTurnGeneration = null;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.abortPendingPermissionsForCurrentTurn(this.resolvePermissionFlushReasonForOutcome(outcome));
    this.clearActiveToolCallStateForTerminalTurn(this.resolvePermissionFlushReasonForOutcome(outcome));
    this.plans.finalizeTurn(resolveAcpPlanTurnId(this.turnGeneration));
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
    promptResponse: PromptResponse | unknown,
    turnGeneration: number,
    emitPromptUsage: (promptResponse: PromptResponse | unknown) => void,
  ): boolean {
    if (this.disposed) return true;
    if (turnGeneration !== this.turnGeneration) return true;
    if (this.isTurnGenerationClosed(turnGeneration)) return true;

    if (this.pendingPromptResponseTurnGeneration === turnGeneration) {
      this.pendingPromptResponseTurnGeneration = null;
    }
    emitPromptUsage(promptResponse);
    const stopReason = readPromptStopReason(promptResponse);
    if (!stopReason) {
      const shouldReplayDeferredIdle =
        this.idleStatusDeferredUntilPromptResponse &&
        this.waitingForResponse &&
        this.toolCalls.activeSize === 0;
      this.idleStatusDeferredUntilPromptResponse = false;
      if (shouldReplayDeferredIdle) {
        this.emitIdleStatus();
      }
      return false;
    }

    this.finalizeTurnOutcome(mapStopReasonToAcpTurnOutcome(stopReason));
    return true;
  }

  private abortPendingPermissionsForCurrentTurn(reason: string): void {
    if (this.permissionFlushTurnGeneration === this.turnGeneration) return;
    this.permissionFlushTurnGeneration = this.turnGeneration;
    void abortPendingAcpPermissionRequests(this.options.permissionHandler, reason, (error) => {
      logger.debug('[AcpBackend] Failed to abort pending permission requests:', error);
    });
  }

  private filterPromptTurnUpdatesByDispatch(updateCandidates: unknown[]): unknown[] {
    const acceptsPromptTurnUpdates =
      this.dispatchedPromptTurnGeneration === this.turnGeneration &&
      !this.isCurrentTurnGenerationClosed();

    if (acceptsPromptTurnUpdates) return updateCandidates;

    return updateCandidates.filter((update) => {
      const record = asRecord(update);
      const sessionUpdateType = typeof record?.sessionUpdate === 'string' ? record.sessionUpdate : undefined;
      return !isPromptTurnSessionUpdateType(sessionUpdateType);
    });
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

  private isUserCancellationCompletionError(error: Error): boolean {
    if (error.name === 'AbortError') return true;
    return error.message === 'Cancelled by user';
  }

  private shouldAcceptTransportCompletionFailure(): boolean {
    if (this.waitingForResponse) return true;
    return Boolean(
      this.responseCompletionError &&
      this.isUserCancellationCompletionError(this.responseCompletionError),
    );
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
      if (this.isUserCancellationCompletionError(this.responseCompletionError) && !this.isUserCancellationCompletionError(error)) {
        logger.debug('[AcpBackend] Replacing cancellation completion error with transport/process failure', {
          from: this.responseCompletionError.message,
          to: error.message,
        });
        this.responseCompletionError = error;
        return;
      }
      logger.debug('[AcpBackend] Additional response completion error observed (ignored)', error);
      return;
    }
    if (!this.waitingForResponse || this.isCurrentTurnGenerationClosed()) {
      logger.debug('[AcpBackend] Backend failure observed without an active prompt turn', error);
      return;
    }
    this.responseCompletionError = error;
    this.waitingForResponse = false;
    if (this.promptCompletionSettlement?.generation === this.turnGeneration) {
      this.promptCompletionSettlement = null;
    }
    this.dispatchedPromptTurnGeneration = null;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.lastTurnOutcome = { kind: 'failed', error };
    this.plans.finalizeTurn(resolveAcpPlanTurnId(this.turnGeneration));
    this.closeCurrentTurnGeneration();
    const reason = this.isUserCancellationCompletionError(error) ? 'Cancelled by user' : 'ACP turn failed';
    this.abortPendingPermissionsForCurrentTurn(reason);
    this.abortPendingExtensionHandlers(reason);
    this.clearActiveToolCallStateForTerminalTurn(reason);
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

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await this.sendPromptWithEvidence(sessionId, prompt);
  }

  async sendPromptPayload(sessionId: SessionId, payload: AgentPromptPayload): Promise<void> {
    await this.sendPromptPayloadWithEvidence(sessionId, payload);
  }

  async sendPromptPayloadWithEvidence(
    sessionId: SessionId,
    payload: AgentPromptPayload,
  ): Promise<AcpPromptSubmissionEvidence> {
    return this.sendPromptWithEvidence(sessionId, payload.text, payload.meta);
  }

  async sendPromptWithEvidence(
    sessionId: SessionId,
    prompt: string,
    metadata?: unknown,
  ): Promise<AcpPromptSubmissionEvidence> {
    if (this.disposed) {
      throw new AcpPromptSubmissionPhaseError(
        'rejected_before_effect',
        new Error('Backend has been disposed'),
      );
    }

    if (!this.connection || !this.acpSessionId) {
      throw new AcpPromptSubmissionPhaseError(
        'rejected_before_effect',
        new Error('Session not started'),
      );
    }
    if (this.activePromptRpc) {
      throw new AcpPromptSubmissionPhaseError(
        'rejected_before_effect',
        new Error('Previous ACP prompt RPC is still settling'),
      );
    }

    // Check if prompt contains change_title instruction (via optional callback)
    const promptHasChangeTitle = this.options.hasChangeTitleInstruction?.(prompt) ?? false;

    // Reset tool call counter and set flag
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;

    if (promptHasChangeTitle) {
      logger.debug('[AcpBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern');
    }

    this.emit({ type: 'status', status: 'running' });
    const turnGeneration = this.turnGeneration + 1;
    this.turnGeneration = turnGeneration;
    this.closedTurnGeneration = null;
    this.promptCompletionSettlement = null;
    this.dispatchedPromptTurnGeneration = null;
    this.pendingTurnOutcome = null;
    this.lastTurnOutcome = null;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
    this.permissionFlushTurnGeneration = null;
    this.waitingForResponse = true;
    this.responseCompletionError = null;
    this.sawSessionUpdateSincePrompt = false;
    this.sawAssistantMessageSincePrompt = false;
    this.firstSessionUpdateSincePromptResolver = null;
    this.clearResponseCompletionTimeout();
    this.resetExtensionAbortControllerForTurn();
    if (this.postPromptCompletionIdleTimeout) {
      clearTimeout(this.postPromptCompletionIdleTimeout);
      this.postPromptCompletionIdleTimeout = null;
    }
    if (this.postIdleWithoutAssistantMessageTimeout) {
      clearTimeout(this.postIdleWithoutAssistantMessageTimeout);
      this.postIdleWithoutAssistantMessageTimeout = null;
    }

    type PromptErrorDisposition =
      | 'failed'
      | 'ignored_after_closed_turn';
    let promptErrorHandled = false;
    const handlePromptError = (error: unknown): PromptErrorDisposition => {
      if (turnGeneration !== this.turnGeneration || this.isTurnGenerationClosed(turnGeneration)) {
        logger.debug('[AcpBackend] Ignoring prompt error after turn generation closed:', error);
        return 'ignored_after_closed_turn';
      }
      logger.debug('[AcpBackend] Error sending prompt:', error);

      this.failPendingResponseWait(error instanceof Error ? error : new Error(String(error)));

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

      return 'failed';
    };

    try {
      // Never log prompt contents (can include secrets).
      logger.debug(`[AcpBackend] Sending prompt (length: ${prompt.length})`);

      const promptCompletionCorrelationId = this.options.promptCompletion ? randomUUID() : null;
      const promptCompletionMeta = promptCompletionCorrelationId
        ? this.options.promptCompletion?.buildRequestMeta({ correlationId: promptCompletionCorrelationId })
        : undefined;
      const promptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: await buildAcpPromptContentBlocks({
          cwd: this.options.cwd,
          text: prompt,
          metadata,
        }),
        ...(promptCompletionMeta && Object.keys(promptCompletionMeta).length > 0
          ? { _meta: { ...promptCompletionMeta } }
          : {}),
      };

      const emitPromptUsage = (promptResponse: PromptResponse | unknown): void => {
        const promptResponseRecord =
          promptResponse && typeof promptResponse === 'object'
            ? promptResponse as Record<string, unknown>
            : null;
        if (!promptResponseRecord) return;
        const metadata = promptResponseRecord._meta;
        const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? metadata as Record<string, unknown>
          : null;
        const usage = promptResponseRecord.usage ?? metadataRecord?.usage;
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;

        const projected = this.options.promptUsageAdapter?.project({
          usage,
          promptResponse: promptResponseRecord,
        });
        if (this.options.promptUsageAdapter) {
          if (!projected) return;
          this.emit({
            type: 'token-count',
            key: 'acp-prompt-usage',
            tokens: projected.tokens,
            ...(projected.cost ? { cost: projected.cost } : {}),
            ...(projected.modelId ? { modelId: projected.modelId } : {}),
            source: 'acp-prompt-usage',
          });
          return;
        }

        const record = usage as Record<string, unknown>;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

        const input = asNum(record.input_tokens);
        const output = asNum(record.output_tokens);
        const thought = asNum(record.thought_tokens);
        const cacheRead = asNum(record.cached_read_tokens);
        const cacheWrite = asNum(record.cached_write_tokens);
        const totalFromResponse = asNum(record.total_tokens);
        const total =
          totalFromResponse ??
          (input ?? 0) +
            (output ?? 0) +
            (cacheRead ?? 0) +
            (cacheWrite ?? 0) +
            (thought ?? 0);

        const tokens: Record<string, number> = { total };
        if (input != null) tokens.input = input;
        if (output != null) tokens.output = output;
        if (cacheRead != null) tokens.cache_read = cacheRead;
        if (cacheWrite != null) tokens.cache_creation = cacheWrite;
        if (thought != null) tokens.thought = thought;

        const modelId =
          typeof promptResponseRecord.modelId === 'string'
            ? promptResponseRecord.modelId
            : typeof promptResponseRecord.model === 'string'
              ? promptResponseRecord.model
              : undefined;

        this.emit({
          type: 'token-count',
          key: 'acp-prompt-usage',
          tokens,
          ...(modelId ? { modelId } : null),
          source: 'acp-prompt-usage',
        });
      };

      const firstUpdateSentinel = Symbol('acp-first-session-update');
      const promptTransportWriteSentinel = Symbol('acp-prompt-transport-write');
      const promptLivenessTimeoutSentinel = Symbol('acp-prompt-liveness-timeout');
      const firstSessionUpdateSincePrompt = new Promise<typeof firstUpdateSentinel>((resolve) => {
        this.firstSessionUpdateSincePromptResolver = () => resolve(firstUpdateSentinel);
      });
      const promptTransportWriteReceipt = this.createAcpPromptTransportWriteReceipt(this.acpSessionId);
      const promptTransportWrite = promptTransportWriteReceipt.written.then(
        () => promptTransportWriteSentinel,
      );
      const promptLivenessTimeoutMs = resolvePromptLivenessTimeoutMs(this.transport);
      let promptLivenessTimeout: ReturnType<typeof setTimeout> | null = null;
      const promptLivenessRaceItems: Array<Promise<unknown>> = [
        promptTransportWrite,
        firstSessionUpdateSincePrompt,
      ];
      if (promptLivenessTimeoutMs !== null) {
        promptLivenessRaceItems.push(new Promise<typeof promptLivenessTimeoutSentinel>((resolve) => {
          promptLivenessTimeout = setTimeout(() => {
            promptLivenessTimeout = null;
            resolve(promptLivenessTimeoutSentinel);
          }, promptLivenessTimeoutMs);
          promptLivenessTimeout.unref?.();
        }));
      }

      const privateCompletionResponse = promptCompletionCorrelationId
        ? new Promise<PromptResponse>((resolve, reject) => {
            this.promptCompletionSettlement = {
              generation: turnGeneration,
              correlationId: promptCompletionCorrelationId,
              resolve,
              reject,
            };
          })
        : null;

      // Establish both dispatch and secondary-completion ownership before invoking the peer: a
      // conforming ACP agent may emit updates and notifications before its prompt RPC resolves.
      this.dispatchedPromptTurnGeneration = turnGeneration;
      const promptPromise = this.connection.peer.prompt(promptRequest);
      const activePromptRpc = {
        generation: turnGeneration,
        settled: promptPromise.then(() => undefined, () => undefined),
      };
      this.activePromptRpc = activePromptRpc;
      void activePromptRpc.settled.then(() => {
        if (this.activePromptRpc === activePromptRpc) {
          this.activePromptRpc = null;
        }
      });
      const finalResponseEvidence: Promise<AcpPromptExactFinalResponseEvidence> = Promise.race([
        promptPromise,
        ...(privateCompletionResponse ? [privateCompletionResponse] : []),
      ]).then((response): AcpPromptExactFinalResponseEvidence => ({
        kind: 'exact_final_response',
        response,
      })).catch((error: unknown) => {
        promptTransportWriteReceipt.cancel();
        promptErrorHandled = true;
        handlePromptError(error);
        throw toAcpPromptSubmissionPhaseError('effect_may_have_occurred', error);
      });
      // Direct AgentBackend callers intentionally consume only liveness. Keep the exact
      // evidence promise safe until createAcpRuntime opts into awaiting it.
      void finalResponseEvidence.catch(() => {});
      promptLivenessRaceItems.unshift(finalResponseEvidence);
      void promptPromise.then(() => {
        if (this.promptCompletionSettlement?.generation === turnGeneration) {
          this.promptCompletionSettlement = null;
        }
      }, () => {});

      let promptResponseOrFirstUpdate: any;
      try {
        promptResponseOrFirstUpdate = await Promise.race(promptLivenessRaceItems);
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
          || this.toolCalls.activeSize > 0
          || this.sawSessionUpdateSincePrompt
        ) return;
        const noUpdatesTimeoutMs = resolvePostPromptNoUpdatesTimeoutMs(this.transport);
        if (noUpdatesTimeoutMs === null) return;
        const graceMs = Math.max(100, noUpdatesTimeoutMs);
        this.postPromptCompletionIdleTimeout = setTimeout(() => {
          this.postPromptCompletionIdleTimeout = null;
          if (turnGeneration !== this.turnGeneration) return;
          if (this.responseCompletionError) return;
          if (!this.waitingForResponse) return;
          if (this.sawSessionUpdateSincePrompt) return;
          if (this.toolCalls.activeSize > 0) return;
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

      if (promptResponseOrFirstUpdate === promptLivenessTimeoutSentinel) {
        this.firstSessionUpdateSincePromptResolver = null;
        promptTransportWriteReceipt.cancel();
        throw new AcpPromptSubmissionPhaseError(
          'effect_may_have_occurred',
          new Error(`Timeout waiting for prompt ACK or first session/update after ${promptLivenessTimeoutMs ?? 'disabled'}ms`),
        );
      }

      const observePendingPromptResponse = (): void => {
        this.pendingPromptResponseTurnGeneration = turnGeneration;
        void promptPromise
          .then((res) => {
            const completedTurn = this.handlePromptResponseForTurn(res, turnGeneration, emitPromptUsage);
            if (!completedTurn) scheduleNoUpdateCompletionIfNeeded();
          })
          .catch(() => {
            if (this.pendingPromptResponseTurnGeneration === turnGeneration) {
              this.pendingPromptResponseTurnGeneration = null;
              this.idleStatusDeferredUntilPromptResponse = false;
            }
            // finalResponseEvidence is the sole prompt-error disposition owner. This
            // branch only clears prompt-response bookkeeping after the raw RPC rejects.
          });
      };

      if (promptResponseOrFirstUpdate === promptTransportWriteSentinel) {
        this.firstSessionUpdateSincePromptResolver = null;
        observePendingPromptResponse();
        return { kind: 'accepted_without_exact_final_response' };
      }

      if (promptResponseOrFirstUpdate === firstUpdateSentinel) {
        if (!this.waitingForResponse || this.isTurnGenerationClosed(turnGeneration)) {
          return await finalResponseEvidence;
        }
        // ACP agents commonly ACK `session/prompt` immediately, but some will start sending
        // `session/update` traffic before the prompt RPC resolves. Treat the first update as
        // proof of liveness so higher-level runtimes can proceed to waitForResponseComplete().
        observePendingPromptResponse();
        return {
          kind: 'effect_may_have_occurred',
          finalResponseEvidence,
        };
      }

      // Prompt ACK won the race; clear the first-update resolver to avoid leaking it into later turns.
      if (this.firstSessionUpdateSincePromptResolver) {
        this.firstSessionUpdateSincePromptResolver = null;
      }
      promptTransportWriteReceipt.cancel();

      const promptFinalEvidence = promptResponseOrFirstUpdate as AcpPromptExactFinalResponseEvidence;
      const promptResponse = promptFinalEvidence.response;

      // Best-effort: emit token usage when the ACP agent reports it in the PromptResponse.
      // ACP standardizes per-turn usage under `usage` (RFC: session-usage).
      if (this.handlePromptResponseForTurn(promptResponse, turnGeneration, emitPromptUsage)) {
        return {
          kind: 'exact_final_response',
          response: promptResponse as PromptResponse,
        };
      }
      
      // Don't emit 'idle' here - it will be emitted after all message chunks are received
      // The idle timeout in handleSessionUpdate will emit 'idle' after the last chunk
      //
      // Some ACP agents complete the prompt turn without emitting any session/update events
      // (no message chunks, no tool calls). Only transports that explicitly opt into a
      // no-update fallback should unblock `waitForResponseComplete()` here; otherwise, avoid
      // inventing a turn boundary while a provider may still be working silently.
      //
      // Guard: only emit when we are still waiting (i.e. no idle was already observed), there are
      // no active tool calls, and we have *not yet observed any session/update traffic* for this prompt.
      scheduleNoUpdateCompletionIfNeeded();

      return {
        kind: 'exact_final_response',
        response: promptResponse as PromptResponse,
      };

    } catch (error) {
      if (!promptErrorHandled) handlePromptError(error);
      throw toAcpPromptSubmissionPhaseError('effect_may_have_occurred', error);
    }
  }

  async sendSteerPrompt(
    sessionId: SessionId,
    prompt: string,
    deliveryIdentity?: AcpSteerDeliveryIdentity,
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

    if (this.options.inFlightSteer) {
      const response = await this.connection.peer.requestExtension(
        this.options.inFlightSteer.method,
        this.options.inFlightSteer.buildParams({
          sessionId: normalizedSessionId,
          prompt,
          ...(deliveryIdentity === undefined ? {} : { deliveryIdentity }),
        }),
      );
      if (!this.options.inFlightSteer.isAccepted(response)) {
        throw new Error(`${this.options.agentName} in-flight steer extension did not accept input`);
      }
      return;
    }

    const contentBlock: ContentBlock = { type: 'text', text: prompt };
    const promptRequest: PromptRequest = {
      sessionId: this.acpSessionId,
      prompt: [contentBlock],
    };

    // Intentionally do not toggle `waitingForResponse` or tool-call counters here.
    // This method is used for in-flight steering while a primary prompt is already running.
    const turnGeneration = this.turnGeneration;
    const transportWriteReceipt = this.createAcpPromptTransportWriteReceipt(this.acpSessionId);
    const transportWriteSentinel = Symbol('acp-steer-transport-write');
    const promptPromise = this.connection.peer.prompt(promptRequest);
    let outcome: PromptResponse | typeof transportWriteSentinel;
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
      this.handlePromptResponseForTurn(
        outcome as PromptResponse,
        turnGeneration,
        () => {},
      );
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
    const normalizedModeId = readNonBlankSessionControlIdentifier(modeId) ?? '';
    if (!normalizedModeId) {
      throw new Error('Mode ID is required');
    }

    const request: SetSessionModeRequest = { sessionId: normalizedSessionId, modeId: normalizedModeId };
    await applyAcpSessionControl(() => this.connection!.peer.setSessionMode(request));

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

    const normalizedModelId = readNonBlankSessionControlIdentifier(modelId) ?? '';
    if (!normalizedModelId) {
      throw new Error('Model ID is required');
    }

    await applyAcpSessionControl(() => this.connection!.peer.setSessionModelLegacy({
      sessionId: normalizedSessionId,
      modelId: normalizedModelId,
      ...(requestMeta && Object.keys(requestMeta).length > 0 ? { _meta: requestMeta } : {}),
    }));

    if (this.sessionModelState) {
      this.sessionModelState = { ...this.sessionModelState, currentModelId: normalizedModelId };
    }

    this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: normalizedModelId } });
  }

  /**
   * Wait for the response to complete (idle status after all chunks received)
   * Call this after sendPrompt to wait for Gemini to finish responding
   */
  private clearTrackedToolCall(toolCallId: string, reason: string): void {
    const wasActive = this.toolCalls.cancel(toolCallId);
    if (wasActive) {
      logger.debug(
        `[AcpBackend] Cancelled tracked tool call ${toolCallId} after ${reason}. Active tool calls: ${this.toolCalls.activeSize}`,
      );
    }
    if (this.toolCalls.activeSize === 0) this.emitIdleStatus();
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
        if (this.promptCompletionSettlement?.generation === this.turnGeneration) {
          this.promptCompletionSettlement = null;
        }
        this.dispatchedPromptTurnGeneration = null;
        this.pendingPromptResponseTurnGeneration = null;
        this.idleStatusDeferredUntilPromptResponse = false;
        this.closeCurrentTurnGeneration();
        this.lastTurnOutcome = { kind: 'failed', error };
        this.abortPendingPermissionsForCurrentTurn('ACP response wait timeout');
        this.abortPendingExtensionHandlers('ACP response wait timeout');
        this.clearActiveToolCallStateForTerminalTurn('response wait timeout');
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
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        reject(error);
      };
    });
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
    if (
      this.waitingForResponse &&
      this.pendingPromptResponseTurnGeneration === this.turnGeneration
    ) {
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
        if (this.toolCalls.activeSize > 0) return;
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
    if (this.toolCalls.activeSize > 0) return;

    if (!this.waitingForResponse) {
      this.emitIdleStatus();
      return;
    }

    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    const idleTimeoutMs = resolvePostToolCallIdleTimeoutMs(this.transport);
    this.idleTimeout = setTimeout(() => {
      this.idleTimeout = null;
      if (this.toolCalls.activeSize > 0) {
        logger.debug('[AcpBackend] Skipping post-tool idle emission because a tool call became active again');
        return;
      }
      logger.debug('[AcpBackend] Post-tool quiet period elapsed, emitting idle status');
      this.emitIdleStatus();
    }, idleTimeoutMs);
    this.idleTimeout.unref?.();
  }

  private settlePromptFromExtension(params: Readonly<{
    correlationId: string;
    outcome:
      | Readonly<{ kind: 'completed'; response: PromptResponse }>
      | Readonly<{ kind: 'failed'; error: Error }>;
  }>): boolean {
    const correlationId = readNonBlankOpaqueIdentifier(params.correlationId);
    const settlement = this.promptCompletionSettlement;
    if (
      !correlationId
      || !settlement
      || settlement.correlationId !== correlationId
      || settlement.generation !== this.turnGeneration
      || !this.waitingForResponse
      || this.dispatchedPromptTurnGeneration !== settlement.generation
      || this.isTurnGenerationClosed(settlement.generation)
    ) {
      return false;
    }

    if (params.outcome.kind === 'failed') {
      this.promptCompletionSettlement = null;
      this.failPendingResponseWait(params.outcome.error);
      settlement.reject(params.outcome.error);
      return true;
    }
    if (
      !this.sawSessionUpdateSincePrompt
      || this.toolCalls.activeSize > 0
      || !readPromptStopReason(params.outcome.response)
    ) {
      return false;
    }

    this.promptCompletionSettlement = null;
    if (!this.handlePromptResponseForTurn(params.outcome.response, settlement.generation, () => {})) {
      return false;
    }
    settlement.resolve(params.outcome.response);
    return true;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    this.promptCompletionSettlement = null;
    if (this.waitingForResponse) {
      this.failPendingResponseWait(makeAbortError('Cancelled by user'));
    } else {
      this.abortPendingPermissionsForCurrentTurn('Cancelled by user');
      this.abortPendingExtensionHandlers('Cancelled by user');
    }
    this.plans.finalizeTurn(resolveAcpPlanTurnId(this.turnGeneration));

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

    this.toolCalls.cancelAll();

    if (!this.connection || !this.acpSessionId) return;

    const activePromptRpc = this.activePromptRpc;
    const cancelResult = this.connection.peer
      .cancel({ sessionId: this.acpSessionId })
      .catch((error) => logger.debug('[AcpBackend] Error cancelling:', error));
    let settlementTimer: NodeJS.Timeout | null = null;
    const settledInTime = await Promise.race([
      Promise.all([
        cancelResult,
        activePromptRpc?.settled ?? Promise.resolve(),
      ]).then(() => true),
      new Promise<false>((resolve) => {
        settlementTimer = setTimeout(() => resolve(false), PROMPT_CANCEL_SETTLEMENT_TIMEOUT_MS);
        settlementTimer.unref?.();
      }),
    ]);
    if (settlementTimer) clearTimeout(settlementTimer);
    if (!settledInTime) {
      logger.debug('[AcpBackend] Cancellation acknowledgement or prompt RPC did not settle; closing the ACP connection');
      await this.cleanupInitializedProcessConnection({ graceMs: 250 });
      if (this.activePromptRpc === activePromptRpc) {
        this.activePromptRpc = null;
      }
    }

    this.emit({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
  }

  /**
   * Emit permission response event for UI/logging purposes.
   *
   * **IMPORTANT:** For ACP backends, this method does NOT send the actual permission
   * response to the agent. The ACP protocol requires synchronous permission handling,
   * which is done inside the `requestPermission` RPC handler via `this.options.permissionHandler`.
   *
   * This method only emits a `permission-response` event for:
   * - UI updates (e.g., closing permission dialogs)
   * - Logging and debugging
   * - Other parts of the CLI that need to react to permission decisions
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    logger.debug(`[AcpBackend] Permission response event (UI only): ${requestId} = ${approved}`);
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    
    logger.debug('[AcpBackend] Disposing backend');
    this.disposed = true;

    if (this.waitingForResponse || this.responseCompletionTimeout) {
      this.failPendingResponseWait(makeAbortError('Backend disposed'));
      this.clearResponseCompletionTimeout();
    } else {
      this.abortPendingExtensionHandlers('Backend disposed');
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
    connection?.close();

    // Kill the whole process tree (some ACP CLIs spawn child processes).
    if (this.process) {
      try {
        await killProcessTree(this.process, { graceMs: 1000 });
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
    // Clear state
    this.listeners = [];
    this.connection = null;
    this.acpSessionId = null;
    this.toolCalls.dispose();
    await this.plans.reset();
    this.planStatePublisher = null;
    this.pendingPermissions.clear();
    this.permissionToToolCallMap.clear();
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.pendingTurnOutcome = null;
    this.lastTurnOutcome = null;
    this.closedTurnGeneration = null;
    this.promptCompletionSettlement = null;
    this.activePromptRpc = null;
    this.dispatchedPromptTurnGeneration = null;
    this.pendingPromptResponseTurnGeneration = null;
    this.idleStatusDeferredUntilPromptResponse = false;
  }
}

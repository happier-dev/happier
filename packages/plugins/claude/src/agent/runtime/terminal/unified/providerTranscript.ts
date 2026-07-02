import type {
  PluginContextV1,
  TranscriptFileFollowHandleV1,
} from '@happier-dev/plugin-sdk';
import {
  type SessionProviderTranscriptEventPayloadV1,
} from '@happier-dev/protocol';

import { parseRawJsonLinesLine } from '../../../transcripts/parseRawJsonLines.js';
import type { RawJSONLines } from '../../../transcripts/rawJsonLines.js';
import {
  isClaudeInternalTranscriptMessage,
  isClaudeSlashCommandTranscriptRow,
} from '../../../transcripts/visibility.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';

export const CLAUDE_UNIFIED_TRANSCRIPT_FINAL_DRAIN_TIMEOUT_MS = 750;

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';

type ProviderTranscriptContext = Readonly<{
  sessionHooks: Pick<PluginContextV1['sessionHooks'], 'publishProviderTranscript'>;
  transcripts: Readonly<{
    fileFollow: Pick<PluginContextV1['transcripts']['fileFollow'], 'follow'>;
  }>;
  logger: Pick<PluginContextV1['logger'], 'debug' | 'warn'>;
}>;

export type ClaudeUnifiedProviderTranscriptPublisher = Readonly<{
  bindFromSessionHook(providerSessionId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  drainNow(): Promise<void>;
  dispose(options?: Readonly<{ drainTimeoutMs?: number }>): Promise<void>;
}>;

export type ClaudeUnifiedProviderTranscriptPublisherParams = Readonly<{
  ctx: ProviderTranscriptContext;
  sessionId: string;
}>;

type TranscriptBinding = Readonly<{
  providerSessionId: string;
  transcriptPath: string;
  visibleAfterMs: number | null;
  boundAtMs: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHookEventName(payload: Readonly<Record<string, unknown>>): string | null {
  return readString(payload.hook_event_name)
    ?? readString(payload.hookEventName)
    ?? readString(payload.eventName);
}

function readTranscriptPath(payload: Readonly<Record<string, unknown>>): string | null {
  return readString(payload.transcript_path) ?? readString(payload.transcriptPath);
}

function readSessionStartSource(payload: Readonly<Record<string, unknown>>): string | null {
  return readString(payload.source);
}

function readTimestampMs(row: RawJSONLines): number | null {
  const value =
    (row as Record<string, unknown>).timestamp
    ?? (row as Record<string, unknown>).createdAt
    ?? (row as Record<string, unknown>).created_at;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFinalDrainTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return CLAUDE_UNIFIED_TRANSCRIPT_FINAL_DRAIN_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function readMessageRecord(row: RawJSONLines): Record<string, unknown> | null {
  const message = isRecord(row.message) ? row.message : null;
  return message;
}

function readTextContent(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readFirstTextContent(value: unknown): string | null {
  const directText = readTextContent(value);
  if (directText !== null) return directText;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = readTextContent(item.text);
    if (text) return text;
  }
  return null;
}

function readTurnId(row: RawJSONLines): string | undefined {
  return readString(row.uuid) ?? undefined;
}

function withOptionalTurnId<T extends Record<string, unknown>>(row: RawJSONLines, payload: T): T & { turnId?: string } {
  const turnId = readTurnId(row);
  return turnId ? { ...payload, turnId } : payload;
}

function createBasePayload(params: Readonly<{
  sessionId: string;
  providerSessionId: string;
  row: RawJSONLines;
}>): Pick<SessionProviderTranscriptEventPayloadV1, 'providerId' | 'sessionId' | 'providerSessionId' | 'providerPayload'> {
  return {
    providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
    sessionId: params.sessionId,
    providerSessionId: params.providerSessionId,
    providerPayload: params.row,
  };
}

function mapClaudeJsonlRowToProviderTranscriptPayload(params: Readonly<{
  sessionId: string;
  providerSessionId: string;
  row: RawJSONLines;
  visibleAfterMs: number | null;
  boundAtMs: number;
}>): SessionProviderTranscriptEventPayloadV1 | null {
  if (isClaudeInternalTranscriptMessage(params.row)) return null;
  // Sidechain (subagent) rows are never parent-turn lifecycle evidence: a Task-tool
  // subagent finishing with stop_reason 'end_turn' must not mint a parent completion
  // candidate (premature parent turnCompleted), and sidechain prompts/feedback must
  // not re-render as parent activity.
  if (params.row.isSidechain === true) return null;
  if (isClaudeSlashCommandTranscriptRow(params.row)) {
    // Replay-leak guard (resume-replay incident, lane Z intent): a slash-command XML row in the
    // one-time bind replay (older than the bind, or unprovably live) must never re-render as a
    // raw user message after a respawn. Deterministic and persistence-free: it re-applies
    // identically on every replay. LIVE rows appended after the bind keep the user-typed-command
    // passthrough policy.
    const timestampMs = readTimestampMs(params.row);
    if (timestampMs === null || timestampMs < params.boundAtMs) return null;
  }
  if (params.visibleAfterMs !== null) {
    const timestampMs = readTimestampMs(params.row);
    if (timestampMs === null || timestampMs < params.visibleAfterMs) return null;
  }
  const base = createBasePayload(params);

  if (params.row.type === 'system') {
    const subtype = readString((params.row as Record<string, unknown>).subtype);
    if (subtype !== 'compact_boundary') return null;
    return withOptionalTurnId(params.row, {
      ...base,
      kind: 'compact_boundary',
    });
  }

  if (params.row.type === 'assistant') {
    const stopReason = readString(readMessageRecord(params.row)?.stop_reason);
    if (!stopReason) return null;
    return withOptionalTurnId(params.row, {
      ...base,
      kind: 'assistant_stop',
      stopReason,
    });
  }

  if (params.row.type !== 'user') return null;
  const text = readFirstTextContent(readMessageRecord(params.row)?.content);
  if (!text) return null;

  if (params.row.isMeta === true && text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)) {
    return withOptionalTurnId(params.row, {
      ...base,
      kind: 'stop_hook_feedback',
    });
  }
  if (params.row.isMeta === true) return null;

  return withOptionalTurnId(params.row, {
    ...base,
    kind: 'text',
    text,
  });
}

export function createClaudeUnifiedProviderTranscriptPublisher(
  params: ClaudeUnifiedProviderTranscriptPublisherParams,
): ClaudeUnifiedProviderTranscriptPublisher {
  let binding: TranscriptBinding | null = null;
  let disposed = false;
  let followHandle: TranscriptFileFollowHandleV1 | null = null;
  let drainInFlight: Promise<void> | null = null;

  function logDrainDeferred(error: unknown, activeBinding: TranscriptBinding | null = binding): void {
    params.ctx.logger.debug('[ClaudeUnifiedTerminal] transcript drain deferred', {
      error,
      ...(activeBinding ? {
        providerSessionId: activeBinding.providerSessionId,
        transcriptPath: activeBinding.transcriptPath,
      } : {}),
    });
  }

  async function emitPayload(payload: SessionProviderTranscriptEventPayloadV1): Promise<void> {
    if (disposed) return;
    await params.ctx.sessionHooks.publishProviderTranscript(payload);
  }

  async function processLine(activeBinding: TranscriptBinding, rawLine: string): Promise<void> {
    if (disposed) return;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    const row = parseRawJsonLinesLine(line);
    if (!row) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] ignored invalid transcript row', {
        providerSessionId: activeBinding.providerSessionId,
        transcriptPath: activeBinding.transcriptPath,
      });
      return;
    }
    const payload = mapClaudeJsonlRowToProviderTranscriptPayload({
      sessionId: params.sessionId,
      providerSessionId: activeBinding.providerSessionId,
      row,
      visibleAfterMs: activeBinding.visibleAfterMs,
      boundAtMs: activeBinding.boundAtMs,
    });
    if (payload) await emitPayload(payload);
  }

  async function closeFollowHandle(
    handle: TranscriptFileFollowHandleV1,
    options?: Parameters<TranscriptFileFollowHandleV1['close']>[0],
    activeBinding: TranscriptBinding | null = binding,
  ): Promise<void> {
    try {
      await handle.close(options);
    } catch (error) {
      logDrainDeferred(error, activeBinding);
    }
  }

  async function drainNow(): Promise<void> {
    if (disposed || !followHandle) return;
    if (drainInFlight) return await drainInFlight;
    const activeBinding = binding;
    const handle = followHandle;
    drainInFlight = handle.drainNow().catch((error: unknown) => {
      logDrainDeferred(error, activeBinding);
    }).finally(() => {
      drainInFlight = null;
    });
    return await drainInFlight;
  }

  async function attachFileFollow(activeBinding: TranscriptBinding): Promise<boolean> {
    let handle: TranscriptFileFollowHandleV1;
    try {
      handle = await params.ctx.transcripts.fileFollow.follow({
        path: activeBinding.transcriptPath,
        startAt: 'beginning',
        strategy: 'poll',
        onLine: async ({ line }) => {
          await processLine(activeBinding, line);
        },
        onError: (error) => {
          logDrainDeferred(error, activeBinding);
        },
      });
    } catch (error) {
      logDrainDeferred(error, activeBinding);
      return false;
    }
    if (disposed || binding !== activeBinding) {
      await closeFollowHandle(handle, undefined, activeBinding);
      return false;
    }
    followHandle = handle;
    return true;
  }

  async function bindFromSessionHook(
    providerSessionId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (disposed) return;
    if (readHookEventName(payload) !== 'SessionStart') return;
    const transcriptPath = readTranscriptPath(payload);
    const trustedProviderSessionId = readString(providerSessionId)
      ?? readString(payload.session_id)
      ?? readString(payload.sessionId);
    if (!transcriptPath || !trustedProviderSessionId) return;

    if (binding) {
      if (
        binding.providerSessionId === trustedProviderSessionId &&
        binding.transcriptPath === transcriptPath
      ) {
        return;
      }
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] ignored conflicting transcript binding', {
        existingProviderSessionId: binding.providerSessionId,
        providerSessionId: trustedProviderSessionId,
      });
      return;
    }

    const activeBinding = {
      providerSessionId: trustedProviderSessionId,
      transcriptPath,
      visibleAfterMs: readSessionStartSource(payload) === 'resume' ? Date.now() : null,
      boundAtMs: Date.now(),
    };
    binding = activeBinding;
    const attached = await attachFileFollow(activeBinding);
    if (!attached && binding === activeBinding) {
      binding = null;
    }
  }

  async function dispose(options?: Readonly<{ drainTimeoutMs?: number }>): Promise<void> {
    if (disposed) return;
    const handle = followHandle;
    followHandle = null;
    if (handle) {
      await closeFollowHandle(handle, {
        finalDrain: true,
        drainTimeoutMs: normalizeFinalDrainTimeoutMs(options?.drainTimeoutMs),
      });
    }
    disposed = true;
    binding = null;
    drainInFlight = null;
  }

  return {
    bindFromSessionHook,
    drainNow,
    dispose,
  };
}

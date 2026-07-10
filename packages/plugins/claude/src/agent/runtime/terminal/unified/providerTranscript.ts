import { isSidechainSessionHook } from '../../../hooks/sidechain.js';
import type {
  PluginContextV1,
  SessionProviderTranscriptPublishRequestV1,
  TranscriptFileFollowHandleV1,
  TranscriptFileFollowStartAtV1,
} from '@happier-dev/plugin-sdk';

import { parseRawJsonLinesLine } from '../../../transcripts/parseRawJsonLines.js';
import { createClaudeJsonlResetReplaySuppressor } from '../../../transcripts/jsonlReplaySuppression.js';
import type { RawJSONLines } from '../../../transcripts/rawJsonLines.js';
import {
  isClaudeInternalTranscriptMessage,
  readClaudeVisibleCompactSummaryText,
  readClaudeVisibleLocalCommandOutputText,
  readClaudeVisibleSlashCommandText,
} from '../../../transcripts/visibility.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';

export const CLAUDE_UNIFIED_TRANSCRIPT_FINAL_DRAIN_TIMEOUT_MS = 750;

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';
const CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

type ProviderTranscriptContext = Readonly<{
  agentRuntime: Readonly<{
    sessionHooks: Pick<PluginContextV1['agentRuntime']['sessionHooks'], 'publishProviderTranscript'>;
    transcripts: Readonly<{
      fileFollow: Pick<PluginContextV1['agentRuntime']['transcripts']['fileFollow'], 'follow'>;
    }>;
  }>;
  logger: Pick<PluginContextV1['logger'], 'debug' | 'warn'>;
}>;

export type ClaudeUnifiedProviderTranscriptPublisher = Readonly<{
  bindFromSessionHook(providerSessionId: string, payload: Readonly<Record<string, unknown>>): Promise<ClaudeUnifiedProviderTranscriptBindResult>;
  bindKnownLiveTranscript(input: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }>): Promise<ClaudeUnifiedProviderTranscriptBindResult>;
  drainNow(): Promise<void>;
  dispose(options?: Readonly<{ drainTimeoutMs?: number }>): Promise<void>;
}>;

export type ClaudeUnifiedProviderTranscriptPublisherParams = Readonly<{
  ctx: ProviderTranscriptContext;
  sessionId: string;
  /**
   * Optional observer invoked for EVERY parsed raw transcript row, BEFORE the
   * visibility filter that drops `attachment`/`system` rows from the rendered
   * transcript. This is the single shared raw-row seam where derived work-state
   * sources (e.g. the native `/goal` source, which consumes `goal_status`
   * attachments + the system-init `slash_commands`) observe the stream without
   * disturbing the lifecycle/message-commit channel. Must be allocation-light
   * and non-throwing; it runs inside the shared file-follow row callback.
   */
  onObserveRow?: (row: RawJSONLines) => void;
}>;

type TranscriptBinding = Readonly<{
  providerSessionId: string;
  transcriptPath: string;
}>;

export type ClaudeUnifiedProviderTranscriptAcceptedBinding = Readonly<{
  providerSessionId: string;
  transcriptPath: string;
}>;

export type ClaudeUnifiedProviderTranscriptBindResult =
  | Readonly<{ status: 'bound'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'unchanged'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'deferred'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'ignored' }>;

type SessionProviderTranscriptEventPayloadV1 = SessionProviderTranscriptPublishRequestV1;

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

function toAcceptedBinding(binding: TranscriptBinding): ClaudeUnifiedProviderTranscriptAcceptedBinding {
  return {
    providerSessionId: binding.providerSessionId,
    transcriptPath: binding.transcriptPath,
  };
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

function readTextContentParts(value: unknown): string | null {
  const directText = readTextContent(value);
  if (directText !== null) return directText;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = readTextContent(item.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function readSingleTextContentBlock(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const block = value[0];
  if (!isRecord(block) || block.type !== 'text') return null;
  return typeof block.text === 'string' ? block.text : null;
}

function isClaudeSyntheticNoResponseRow(row: RawJSONLines): boolean {
  if (row.type !== 'assistant') return false;
  if (readString((row as Record<string, unknown>).model) !== '<synthetic>') return false;
  const message = readMessageRecord(row);
  if (!message) return false;
  return readSingleTextContentBlock(message.content)?.trim() === CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT;
}

function readTurnId(row: Readonly<Record<string, unknown>>): string | undefined {
  return readString(row.uuid) ?? undefined;
}

function withOptionalTurnId<T extends Record<string, unknown>>(row: Readonly<Record<string, unknown>>, payload: T): T & { turnId?: string } {
  const turnId = readTurnId(row);
  return turnId ? { ...payload, turnId } : payload;
}

function createBasePayload(params: Readonly<{
  sessionId: string;
  providerSessionId: string;
  row: Readonly<Record<string, unknown>>;
}>): Pick<SessionProviderTranscriptEventPayloadV1, 'providerId' | 'sessionId' | 'providerSessionId' | 'providerPayload'> {
  return {
    providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
    sessionId: params.sessionId,
    providerSessionId: params.providerSessionId,
    providerPayload: params.row,
  };
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readQueuedCommandPrompt(row: Readonly<Record<string, unknown>>): string | null {
  if (row.type === 'queue-operation') {
    if (readString(row.operation) !== 'enqueue') return null;
    return readTextContent(row.content);
  }

  if (row.type !== 'attachment') return null;
  const attachment = isRecord(row.attachment) ? row.attachment : null;
  if (!attachment || readString(attachment.type) !== 'queued_command') return null;
  return readTextContent(attachment.prompt);
}

function mapClaudeRawQueuedCommandRowToProviderTranscriptPayload(params: Readonly<{
  sessionId: string;
  providerSessionId: string;
  row: Readonly<Record<string, unknown>>;
}>): SessionProviderTranscriptEventPayloadV1 | null {
  const text = readQueuedCommandPrompt(params.row);
  if (!text) return null;
  return withOptionalTurnId(params.row, {
    ...createBasePayload(params),
    kind: 'queued_command',
    text,
  });
}

function mapClaudeJsonlRowToProviderTranscriptPayload(params: Readonly<{
  sessionId: string;
  providerSessionId: string;
  row: RawJSONLines;
  suppressPriorEraTurnClosure: boolean;
}>): SessionProviderTranscriptEventPayloadV1 | null {
  const base = createBasePayload(params);
  const visibleBase = {
    providerId: base.providerId,
    sessionId: base.sessionId,
    ...(base.providerSessionId ? { providerSessionId: base.providerSessionId } : {}),
  };
  const compactSummary = readClaudeVisibleCompactSummaryText(params.row);
  if (compactSummary) {
    return withOptionalTurnId(params.row, {
      ...visibleBase,
      kind: 'compact_summary',
      text: compactSummary,
    });
  }
  const slashCommand = readClaudeVisibleSlashCommandText(params.row);
  if (slashCommand) {
    return withOptionalTurnId(params.row, {
      ...visibleBase,
      kind: 'slash_command',
      text: slashCommand,
    });
  }
  const localCommandOutput = readClaudeVisibleLocalCommandOutputText(params.row);
  if (localCommandOutput) {
    return withOptionalTurnId(params.row, {
      ...visibleBase,
      kind: 'local_command_output',
      text: localCommandOutput,
    });
  }
  if (isClaudeInternalTranscriptMessage(params.row)) return null;
  // Sidechain (subagent) rows are never parent-turn lifecycle evidence: a Task-tool
  // subagent finishing with stop_reason 'end_turn' must not mint a parent completion
  // candidate (premature parent turnCompleted), and sidechain prompts/feedback must
  // not re-render as parent activity.
  if (params.row.isSidechain === true) return null;
  if (params.row.type === 'system') {
    const subtype = readString((params.row as Record<string, unknown>).subtype);
    if (subtype !== 'compact_boundary') return null;
    if (params.suppressPriorEraTurnClosure) return null;
    return withOptionalTurnId(params.row, {
      ...base,
      kind: 'compact_boundary',
    });
  }

  if (params.row.type === 'assistant') {
    if (isClaudeSyntheticNoResponseRow(params.row)) return null;
    if ((params.row as Readonly<Record<string, unknown>>).isApiErrorMessage === true) {
      if (params.suppressPriorEraTurnClosure) return null;
      return withOptionalTurnId(params.row, {
        ...base,
        kind: 'assistant_api_error',
      });
    }
    const stopReason = readString(readMessageRecord(params.row)?.stop_reason);
    if (!stopReason) return null;
    if (params.suppressPriorEraTurnClosure) return null;
    return withOptionalTurnId(params.row, {
      ...base,
      kind: 'assistant_stop',
      stopReason,
    });
  }

  if (params.row.type !== 'user') return null;
  const text = readTextContentParts(readMessageRecord(params.row)?.content);
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
  const resetReplaySuppressor = createClaudeJsonlResetReplaySuppressor();
  const initialResumeCatchUpBindings = new WeakSet<object>();

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
    await params.ctx.agentRuntime.sessionHooks.publishProviderTranscript(payload);
  }

  function observeRawRow(row: RawJSONLines): void {
    if (!params.onObserveRow) return;
    try {
      params.onObserveRow(row);
    } catch (error) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] transcript row observer failed (non-fatal)', { error });
    }
  }

  function shouldObserveRawRow(activeBinding: TranscriptBinding, row: Readonly<Record<string, unknown>>): boolean {
    void row;
    return !initialResumeCatchUpBindings.has(activeBinding);
  }

  async function processLine(activeBinding: TranscriptBinding, rawLine: string): Promise<void> {
    if (disposed) return;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    const rawRow = parseJsonRecord(line);
    if (rawRow && resetReplaySuppressor.shouldSuppress(rawRow)) {
      return;
    }
    if (rawRow) {
      const queuedCommandPayload = mapClaudeRawQueuedCommandRowToProviderTranscriptPayload({
        sessionId: params.sessionId,
        providerSessionId: activeBinding.providerSessionId,
        row: rawRow,
      });
      if (queuedCommandPayload) {
        if (shouldObserveRawRow(activeBinding, rawRow)) {
          observeRawRow(rawRow as RawJSONLines);
        }
        await emitPayload(queuedCommandPayload);
        return;
      }
    }
    const row = parseRawJsonLinesLine(line);
    if (!row) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] ignored invalid transcript row', {
        providerSessionId: activeBinding.providerSessionId,
        transcriptPath: activeBinding.transcriptPath,
      });
      return;
    }
    // Single shared raw-row seam: derived work-state sources observe every parsed
    // row (incl. `attachment`/`system`) before the visibility filter drops them.
    if (shouldObserveRawRow(activeBinding, row)) {
      observeRawRow(row);
    }
    const payload = mapClaudeJsonlRowToProviderTranscriptPayload({
      sessionId: params.sessionId,
      providerSessionId: activeBinding.providerSessionId,
      row,
      suppressPriorEraTurnClosure: initialResumeCatchUpBindings.has(activeBinding),
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

  async function attachFileFollow(
    activeBinding: TranscriptBinding,
    startAt: TranscriptFileFollowStartAtV1,
  ): Promise<boolean> {
    let handle: TranscriptFileFollowHandleV1;
    try {
      handle = await params.ctx.agentRuntime.transcripts.fileFollow.follow({
        path: activeBinding.transcriptPath,
        startAt,
        strategy: 'poll',
        onLine: async ({ line }) => {
          await processLine(activeBinding, line);
        },
        onError: (error) => {
          logDrainDeferred(error, activeBinding);
        },
        onReset: () => {
          resetReplaySuppressor.markReset();
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

  async function bindTranscript(
    input: Readonly<{
      providerSessionId: string;
      transcriptPath: string;
      startAt: TranscriptFileFollowStartAtV1;
      initialResumeCatchUp: boolean;
    }>,
  ): Promise<ClaudeUnifiedProviderTranscriptBindResult> {
    const trustedProviderSessionId = readString(input.providerSessionId);
    const transcriptPath = readString(input.transcriptPath);
    if (disposed || !trustedProviderSessionId || !transcriptPath) return { status: 'ignored' };

    if (binding) {
      if (
        binding.providerSessionId === trustedProviderSessionId &&
        binding.transcriptPath === transcriptPath
      ) {
        return { status: 'unchanged', binding: toAcceptedBinding(binding) };
      }
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] ignored conflicting transcript binding', {
        existingProviderSessionId: binding.providerSessionId,
        providerSessionId: trustedProviderSessionId,
      });
      return { status: 'ignored' };
    }

    const activeBinding = {
      providerSessionId: trustedProviderSessionId,
      transcriptPath,
    };
    binding = activeBinding;
    if (input.initialResumeCatchUp) {
      initialResumeCatchUpBindings.add(activeBinding);
    }
    const attached = await attachFileFollow(activeBinding, input.startAt);
    initialResumeCatchUpBindings.delete(activeBinding);
    if (!attached && binding === activeBinding) {
      binding = null;
      return { status: 'deferred', binding: toAcceptedBinding(activeBinding) };
    }
    if (!attached) return { status: 'deferred', binding: toAcceptedBinding(activeBinding) };
    return { status: 'bound', binding: toAcceptedBinding(activeBinding) };
  }

  async function bindFromSessionHook(
    providerSessionId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<ClaudeUnifiedProviderTranscriptBindResult> {
    if (disposed) return { status: 'ignored' };
    if (readHookEventName(payload) !== 'SessionStart') return { status: 'ignored' };
    // A sidechain (subagent) SessionStart must never re-key the parent transcript binding
    // (ported HF-7): its transcript belongs to the subagent's own provider session.
    if (isSidechainSessionHook(payload)) return { status: 'ignored' };
    const transcriptPath = readTranscriptPath(payload);
    const trustedProviderSessionId = readString(providerSessionId)
      ?? readString(payload.session_id)
      ?? readString(payload.sessionId);
    if (!transcriptPath || !trustedProviderSessionId) return { status: 'ignored' };

    return await bindTranscript({
      providerSessionId: trustedProviderSessionId,
      transcriptPath,
      initialResumeCatchUp: readSessionStartSource(payload) === 'resume',
      startAt: 'beginning',
    });
  }

  async function bindKnownLiveTranscript(input: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }>): Promise<ClaudeUnifiedProviderTranscriptBindResult> {
    return await bindTranscript({
      providerSessionId: input.providerSessionId,
      transcriptPath: input.transcriptPath,
      initialResumeCatchUp: false,
      startAt: 'end',
    });
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
    bindKnownLiveTranscript,
    drainNow,
    dispose,
  };
}

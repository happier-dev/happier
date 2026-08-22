import { isSidechainSessionHook } from '../../../hooks/sidechain.js';
import type {
  AgentSessionHooksService,
  AgentTranscriptFileFollowInput,
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  classifyClaudeNativeTranscriptRow,
  type ClaudeNativeTranscriptRowClassification,
} from '../../../transcripts/nativeSemanticProjection.js';
import { parseRawJsonLinesLine } from '../../../transcripts/parseRawJsonLines.js';
import { createClaudeJsonlResetReplaySuppressor } from '../../../transcripts/jsonlReplaySuppression.js';
import type { RawJSONLines } from '../../../transcripts/rawJsonLines.js';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';

export const CLAUDE_UNIFIED_TRANSCRIPT_FINAL_DRAIN_TIMEOUT_MS = 750;

type ProviderTranscriptContext = Readonly<{
  agentRuntime: Readonly<{
    sessionHooks: Pick<AgentSessionHooksService, 'publishProviderTranscript'>;
    transcripts: Readonly<{
      fileFollow: Pick<AgentTranscriptFileFollowService, 'follow'>;
    }>;
  }>;
  logger: Pick<ClaudeRuntimeLogger, 'debug' | 'warn'>;
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
  onPublishPayload?: (payload: ClaudeProviderTranscriptPayload) => void | Promise<void>;
  /**
   * Optional observer invoked for EVERY parsed raw transcript row, BEFORE the
   * visibility filter that drops `attachment`/`system` rows from the rendered
   * transcript. This is the single shared raw-row seam where derived work-state
   * sources (e.g. the native `/goal` source, which consumes `goal_status`
   * attachments + the system-init `slash_commands`) observe the stream without
   * disturbing the lifecycle/message-commit channel. Must be allocation-light
   * and non-throwing; it runs inside the shared file-follow row callback.
   */
  onObserveRow?: (
    row: RawJSONLines,
    observation: Readonly<{
      providerSessionId: string;
      historicalReplay: boolean;
    }>,
  ) => void | Promise<void>;
}>;

type TranscriptBinding = Readonly<{
  providerSessionId: string;
  transcriptPath: string;
  queuedCommandEvidence: NativeQueuedCommandEvidenceState;
}>;

type NativeQueuedCommandOperation = Readonly<{
  operation: 'enqueue' | 'remove';
  content: string;
  sessionId: string;
  timestamp: string;
  timestampMs: number;
}>;

type NativeQueuedCommandConsumption = Readonly<{
  prompt: string;
  sessionId: string;
  transcriptKey: string;
}>;

type NativeQueuedCommandCustody = {
  content: string;
  enqueuedAtMs: number;
  episodeOrder: number;
  removedAtMs: number | null;
  sessionId: string;
};

type NativeQueuedCommandEvidenceState = {
  custodyEpisodes: NativeQueuedCommandCustody[];
  consumedTranscriptKeys: Set<string>;
  nextEpisodeOrder: number;
};

export type ClaudeUnifiedProviderTranscriptAcceptedBinding = Readonly<{
  providerSessionId: string;
  transcriptPath: string;
}>;

export type ClaudeUnifiedProviderTranscriptBindResult =
  | Readonly<{ status: 'bound'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'unchanged'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'deferred'; binding: ClaudeUnifiedProviderTranscriptAcceptedBinding }>
  | Readonly<{ status: 'ignored' }>;

export type ClaudeProviderTranscriptPayload = Parameters<
  AgentSessionHooksService['publishProviderTranscript']
>[0];
type TranscriptFileFollowStartAtV1 = AgentTranscriptFileFollowInput['startAt'];

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

function readExactNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readTurnId(row: Readonly<Record<string, unknown>>): string | undefined {
  return readString(row.uuid) ?? undefined;
}

function withOptionalTurnId<T extends Record<string, unknown>>(row: Readonly<Record<string, unknown>>, payload: T): T & { turnId?: string } {
  const turnId = readTurnId(row);
  return turnId ? { ...payload, turnId } : payload;
}

function withNativeBoundaryTurnId<T extends Record<string, unknown>>(
  classification: ClaudeNativeTranscriptRowClassification,
  payload: T,
): T & { turnId?: string } {
  const turnId = classification.nativeBoundary?.id ?? undefined;
  return turnId ? { ...payload, turnId } : payload;
}

function createBasePayload(params: Readonly<{
  providerSessionId: string;
  row: Readonly<Record<string, unknown>>;
}>): Pick<ClaudeProviderTranscriptPayload, 'providerSessionId' | 'providerPayload'> {
  return {
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

function createNativeQueuedCommandEvidenceState(): NativeQueuedCommandEvidenceState {
  return {
    custodyEpisodes: [],
    consumedTranscriptKeys: new Set(),
    nextEpisodeOrder: 0,
  };
}

function clearNativeQueuedCommandEvidence(state: NativeQueuedCommandEvidenceState): void {
  state.custodyEpisodes.length = 0;
  state.consumedTranscriptKeys.clear();
  state.nextEpisodeOrder = 0;
}

function readNativeQueuedCommandOperation(
  row: Readonly<Record<string, unknown>>,
): NativeQueuedCommandOperation | null {
  if (row.type !== 'queue-operation') return null;
  const operation = row.operation;
  if (operation !== 'enqueue' && operation !== 'remove') return null;
  const content = readExactNonBlankString(row.content);
  const sessionId = readExactNonBlankString(row.sessionId);
  const timestamp = readExactNonBlankString(row.timestamp);
  if (!content || !sessionId || !timestamp) return null;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return { operation, content, sessionId, timestamp, timestampMs };
}

function readNativeQueuedCommandConsumption(
  row: Readonly<Record<string, unknown>>,
): NativeQueuedCommandConsumption | null {
  if (row.type !== 'attachment' || row.isSidechain !== false) return null;
  const attachment = isRecord(row.attachment) ? row.attachment : null;
  const origin = isRecord(attachment?.origin) ? attachment.origin : null;
  const prompt = readExactNonBlankString(attachment?.prompt);
  const sessionId = readExactNonBlankString(row.sessionId);
  const transcriptUuid = readExactNonBlankString(row.uuid);
  const parentUuid = readExactNonBlankString(row.parentUuid);
  const timestamp = readExactNonBlankString(row.timestamp);
  if (
    attachment?.type !== 'queued_command'
    || attachment.commandMode !== 'prompt'
    || origin?.kind !== 'human'
    || !prompt
    || !sessionId
    || !transcriptUuid
    || !parentUuid
    || !timestamp
    || !Number.isFinite(Date.parse(timestamp))
  ) return null;
  return {
    prompt,
    sessionId,
    transcriptKey: `uuid:${transcriptUuid}`,
  };
}

function observeNativeQueuedCommandOperation(params: Readonly<{
  binding: TranscriptBinding;
  operation: NativeQueuedCommandOperation;
}>): void {
  const { binding, operation } = params;
  if (operation.sessionId !== binding.providerSessionId) return;
  const evidence = binding.queuedCommandEvidence;
  if (operation.operation === 'enqueue') {
    evidence.custodyEpisodes.push({
      content: operation.content,
      enqueuedAtMs: operation.timestampMs,
      episodeOrder: evidence.nextEpisodeOrder++,
      removedAtMs: null,
      sessionId: operation.sessionId,
    });
    return;
  }

  const candidate = evidence.custodyEpisodes
    .filter((custody) => (
      custody.removedAtMs === null
      && custody.sessionId === operation.sessionId
      && custody.content === operation.content
    ))
    .sort((left, right) => left.episodeOrder - right.episodeOrder)[0];
  if (!candidate) return;
  candidate.removedAtMs = operation.timestampMs;
}

function prepareNativeQueuedCommandAcceptance(params: Readonly<{
  binding: TranscriptBinding;
  row: Readonly<Record<string, unknown>>;
}>): Readonly<{
  payload: ClaudeProviderTranscriptPayload;
  markPublished(): void;
}> | null {
  const consumption = readNativeQueuedCommandConsumption(params.row);
  if (!consumption || consumption.sessionId !== params.binding.providerSessionId) return null;
  const evidence = params.binding.queuedCommandEvidence;
  if (evidence.consumedTranscriptKeys.has(consumption.transcriptKey)) return null;
  const custody = evidence.custodyEpisodes
    .filter((candidate) => (
      candidate.removedAtMs !== null
      && candidate.content === consumption.prompt
      && candidate.sessionId === consumption.sessionId
    ))
    .sort((left, right) => left.episodeOrder - right.episodeOrder)[0];
  if (!custody) return null;
  return {
    payload: withOptionalTurnId(params.row, {
      ...createBasePayload({
        providerSessionId: params.binding.providerSessionId,
        row: params.row,
      }),
      kind: 'queued_command',
      text: consumption.prompt,
    }),
    markPublished() {
      evidence.consumedTranscriptKeys.add(consumption.transcriptKey);
      const custodyIndex = evidence.custodyEpisodes.indexOf(custody);
      if (custodyIndex >= 0) evidence.custodyEpisodes.splice(custodyIndex, 1);
    },
  };
}

export function projectClaudeTranscriptRowToProviderPayload(params: Readonly<{
  providerSessionId: string;
  row: RawJSONLines;
  suppressPriorEraTurnClosure: boolean;
}>): ClaudeProviderTranscriptPayload | null {
  const classification = classifyClaudeNativeTranscriptRow(params.row);
  const normalizedRow = classification.row ?? params.row;
  const base = createBasePayload({
    providerSessionId: params.providerSessionId,
    row: normalizedRow,
  });
  const visibleBase = {
    ...(base.providerSessionId ? { providerSessionId: base.providerSessionId } : {}),
  };
  // Sidechain (subagent) rows are never parent provider-transcript evidence,
  // including sanitized compact/command rows. External Sessions may still render
  // those rows through its distinct direct-message contract.
  if (classification.sidechain) return null;

  if (classification.content.kind === 'compact_summary') {
    return withOptionalTurnId(normalizedRow, {
      ...visibleBase,
      kind: 'compact_summary',
      text: classification.content.text,
    });
  }
  if (classification.content.kind === 'slash_command') {
    return withOptionalTurnId(normalizedRow, {
      ...visibleBase,
      kind: 'slash_command',
      text: classification.content.text,
    });
  }
  if (classification.content.kind === 'local_command_output') {
    return withOptionalTurnId(normalizedRow, {
      ...visibleBase,
      kind: 'local_command_output',
      text: classification.content.text,
    });
  }
  if (classification.visibility !== 'visible') return null;

  if (classification.lifecycle.kind === 'compact_boundary') {
    if (params.suppressPriorEraTurnClosure) return null;
    return withNativeBoundaryTurnId(classification, {
      ...base,
      kind: 'compact_boundary',
    });
  }

  if (classification.lifecycle.kind === 'assistant_api_error') {
    if (params.suppressPriorEraTurnClosure) return null;
    return withNativeBoundaryTurnId(classification, {
      ...base,
      kind: 'assistant_api_error',
    });
  }

  if (classification.lifecycle.kind === 'assistant_stop') {
    if (params.suppressPriorEraTurnClosure) return null;
    return withNativeBoundaryTurnId(classification, {
      ...base,
      kind: 'assistant_stop',
      stopReason: classification.lifecycle.stopReason,
    });
  }

  if (classification.lifecycle.kind === 'stop_hook_feedback') {
    return withOptionalTurnId(normalizedRow, {
      ...base,
      kind: 'stop_hook_feedback',
    });
  }

  if (classification.lifecycle.kind === 'text') {
    return withOptionalTurnId(normalizedRow, {
      ...base,
      kind: 'text',
      text: classification.lifecycle.text,
    });
  }

  return null;
}

export function createClaudeUnifiedProviderTranscriptPublisher(
  params: ClaudeUnifiedProviderTranscriptPublisherParams,
): ClaudeUnifiedProviderTranscriptPublisher {
  let binding: TranscriptBinding | null = null;
  let disposed = false;
  let followHandle: AgentTranscriptFileFollowHandle | null = null;
  let drainInFlight: Promise<void> | null = null;
  const resetReplaySuppressor = createClaudeJsonlResetReplaySuppressor();
  const initialResumeCatchUpBindings = new WeakSet<object>();
  const initialFileReplayBindings = new WeakSet<object>();

  function logDrainDeferred(error: unknown, activeBinding: TranscriptBinding | null = binding): void {
    params.ctx.logger.debug('[ClaudeUnifiedTerminal] transcript drain deferred', {
      error,
      ...(activeBinding ? {
        providerSessionId: activeBinding.providerSessionId,
        transcriptPath: activeBinding.transcriptPath,
      } : {}),
    });
  }

  async function emitPayload(payload: ClaudeProviderTranscriptPayload): Promise<void> {
    if (disposed) return;
    await params.onPublishPayload?.(payload);
    await params.ctx.agentRuntime.sessionHooks.publishProviderTranscript(payload);
  }

  async function observeRawRow(activeBinding: TranscriptBinding, row: RawJSONLines): Promise<void> {
    if (!params.onObserveRow) return;
    try {
      await params.onObserveRow(row, {
        providerSessionId: activeBinding.providerSessionId,
        historicalReplay: initialFileReplayBindings.has(activeBinding),
      });
    } catch (error) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] transcript row observer failed (non-fatal)', { error });
    }
  }

  function shouldObserveRawRow(activeBinding: TranscriptBinding, row: Readonly<Record<string, unknown>>): boolean {
    void row;
    return !initialResumeCatchUpBindings.has(activeBinding);
  }

  async function processLine(activeBinding: TranscriptBinding, rawLine: string): Promise<void> {
    // A closing file-follow may still deliver an already-buffered callback after a
    // trusted primary SessionStart rotates Claude's native session identity.
    if (disposed || binding !== activeBinding) return;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    const rawRow = parseJsonRecord(line);
    if (rawRow && resetReplaySuppressor.shouldSuppress(rawRow)) {
      return;
    }
    if (rawRow) {
      const nativeQueuedCommandOperation = readNativeQueuedCommandOperation(rawRow);
      const isQueuedCommandAttachment = rawRow.type === 'attachment'
        && isRecord(rawRow.attachment)
        && rawRow.attachment.type === 'queued_command';
      if (nativeQueuedCommandOperation || isQueuedCommandAttachment) {
        if (shouldObserveRawRow(activeBinding, rawRow)) {
          await observeRawRow(activeBinding, rawRow as RawJSONLines);
        }
        // `follow({ startAt: 'beginning' })` may synchronously replay existing JSONL rows before
        // returning its handle. Historical enqueue/remove/attachment triples are observation-only:
        // only rows appended after the binding is live may establish provider acceptance.
        if (initialFileReplayBindings.has(activeBinding)) return;
        if (nativeQueuedCommandOperation) {
          observeNativeQueuedCommandOperation({
            binding: activeBinding,
            operation: nativeQueuedCommandOperation,
          });
          return;
        }
        const acceptance = prepareNativeQueuedCommandAcceptance({
          binding: activeBinding,
          row: rawRow,
        });
        if (!acceptance) return;
        await emitPayload(acceptance.payload);
        acceptance.markPublished();
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
      await observeRawRow(activeBinding, row);
    }
    const payload = projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: activeBinding.providerSessionId,
      row,
      suppressPriorEraTurnClosure: initialResumeCatchUpBindings.has(activeBinding),
    });
    if (payload) await emitPayload(payload);
  }

  async function closeFollowHandle(
    handle: AgentTranscriptFileFollowHandle,
    options?: Parameters<AgentTranscriptFileFollowHandle['close']>[0],
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
    let handle: AgentTranscriptFileFollowHandle;
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
          clearNativeQueuedCommandEvidence(activeBinding.queuedCommandEvidence);
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
      replaceExistingBinding: boolean;
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
      if (!input.replaceExistingBinding) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] ignored conflicting transcript binding', {
          existingProviderSessionId: binding.providerSessionId,
          providerSessionId: trustedProviderSessionId,
        });
        return { status: 'ignored' };
      }

      const previousBinding = binding;
      const previousHandle = followHandle;
      followHandle = null;
      if (previousHandle) {
        await closeFollowHandle(previousHandle, {
          finalDrain: true,
          drainTimeoutMs: CLAUDE_UNIFIED_TRANSCRIPT_FINAL_DRAIN_TIMEOUT_MS,
        }, previousBinding);
      }
      if (disposed || binding !== previousBinding) return { status: 'ignored' };
      clearNativeQueuedCommandEvidence(previousBinding.queuedCommandEvidence);
      binding = null;
      resetReplaySuppressor.clear();
    }

    const activeBinding = {
      providerSessionId: trustedProviderSessionId,
      transcriptPath,
      queuedCommandEvidence: createNativeQueuedCommandEvidenceState(),
    };
    binding = activeBinding;
    if (input.initialResumeCatchUp) {
      initialResumeCatchUpBindings.add(activeBinding);
    }
    if (input.startAt === 'beginning') {
      initialFileReplayBindings.add(activeBinding);
    }
    const attached = await attachFileFollow(activeBinding, input.startAt);
    initialFileReplayBindings.delete(activeBinding);
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
      replaceExistingBinding: true,
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
      replaceExistingBinding: false,
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
    if (binding) clearNativeQueuedCommandEvidence(binding.queuedCommandEvidence);
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

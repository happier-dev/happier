import { AgentSessionRuntimeEventSchema, type SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import {
  normalizeEphemeralSendOutcome,
  type EphemeralSendResult,
} from '@/api/session/client/transcript/ephemeralSendOutcome';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import {
  CommittedTranscriptAdmissionExpiredError,
  type CommittedTranscriptAdmission,
  type CommittedTranscriptMessageOptions,
} from '@/api/session/transcriptPort';

type RuntimeMessageDeltaBridge = Readonly<{
  appendAssistantDelta: (args: Readonly<{
    streamKey: string;
    sidechainId: string | null;
    deltaText: string;
  }>) => void;
  appendThinkingDelta: (args: Readonly<{
    streamKey: string;
    sidechainId: string | null;
    deltaText: string;
  }>) => void;
  flushAll: (args: Readonly<{
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }>) => Promise<readonly StreamedTranscriptFlushSummary[]>;
}>;

type TranscriptMessageCommitResult = Readonly<{
  persisted: boolean;
  delivered: boolean;
}>;

export type RuntimeTranscriptProjectionSession = Readonly<{
  sessionId: string;
  enqueueUserTextMessageCommitted?: (
    text: string,
    opts: CommittedTranscriptMessageOptions,
  ) => Promise<TranscriptMessageCommitResult>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: CommittedTranscriptMessageOptions,
  ) => Promise<TranscriptMessageCommitResult>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{
      localId: string;
      createdAt: number;
      updatedAt?: number;
      meta?: Record<string, unknown>;
    }>,
  ) => EphemeralSendResult;
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type RuntimeTranscriptRequiredAdmissionFailureReason =
  | 'admission_expired'
  | 'durable_enqueue_unavailable'
  | 'durable_enqueue_failed'
  | 'durable_custody_rejected'
  | 'streamed_finalization_failed'
  | 'streamed_final_not_durable'
  | 'projection_drain_timed_out';

export class RuntimeTranscriptRequiredAdmissionError extends Error {
  readonly code = 'runtime_transcript_required_admission_failed' as const;

  constructor(
    readonly reason: RuntimeTranscriptRequiredAdmissionFailureReason,
    readonly eventKind: string,
  ) {
    super(`Required runtime transcript admission failed: ${reason}`);
    this.name = 'RuntimeTranscriptRequiredAdmissionError';
  }
}

export type RuntimeTranscriptProjectionResult =
  | Readonly<{
    projected: true;
    kind:
      | 'message-delta'
      | 'tool-progress'
      | 'tool-call'
      | 'tool-result'
      | 'turn-complete'
      | 'turn-failed'
      | 'turn-cancelled'
      | 'transcript-message-committed';
  }>
  | Readonly<{
    projected: false;
    reason: 'unsupported_event' | 'session_mismatch' | 'ephemeral_not_accepted';
  }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveCommittedTranscriptObservation(event: Readonly<{
  emittedAtMs: number;
}>): Readonly<{
  createdAt: number;
  updatedAt: number;
  provenance: SessionTranscriptObservationProvenanceV1;
}> {
  return {
    createdAt: event.emittedAtMs,
    updatedAt: event.emittedAtMs,
    provenance: { kind: 'non_dependent', source: 'external' },
  };
}

function buildRuntimeToolLocalId(event: Readonly<{
  sessionId: string;
  turnId: string;
  sidechainId?: string;
  toolCallId: string;
}>, kind: 'tool-call' | 'tool-result'): string {
  const identity = createAcpToolIdentity({
    sessionId: event.sessionId,
    turnId: event.turnId,
    sidechainId: event.sidechainId ?? null,
    toolCallId: event.toolCallId,
  });
  return kind === 'tool-call' ? identity.callLocalId : identity.resultLocalId;
}

function buildRuntimeToolMeta(event: Readonly<{
  turnId: string;
}>, kind: 'tool-progress' | 'tool-call' | 'tool-result', fullSnapshot: boolean): Record<string, unknown> {
  return {
    source: 'runtime',
    runtimeEventKind: kind,
    runtimeTurnId: event.turnId,
    ...(fullSnapshot ? { runtimeToolSnapshotV1: { v: 1, mode: 'full' } } : {}),
  };
}

function buildProjectedToolInput(rawInput: unknown, snapshot: unknown): unknown {
  if (!isRecord(snapshot)) return rawInput;

  const effectiveRawInput = hasOwn(snapshot, 'rawInput') ? snapshot.rawInput : rawInput;
  const args: Record<string, unknown> = isRecord(effectiveRawInput)
    ? { ...effectiveRawInput }
    : Array.isArray(effectiveRawInput)
      ? { items: effectiveRawInput }
      : typeof effectiveRawInput === 'string'
        ? { value: effectiveRawInput }
        : {};
  const existingAcp = isRecord(args._acp) ? args._acp : {};
  const acp: Record<string, unknown> = { ...existingAcp };

  for (const key of ['title', 'kind', 'status'] as const) {
    acp[key] = typeof snapshot[key] === 'string' && snapshot[key].length > 0
      ? snapshot[key]
      : null;
  }
  acp.rawInput = hasOwn(snapshot, 'rawInput') ? snapshot.rawInput : null;
  if (Array.isArray(snapshot.locations)) {
    args.locations = snapshot.locations;
    acp.locations = snapshot.locations;
  } else {
    args.locations = [];
    acp.locations = null;
  }
  acp.content = Array.isArray(snapshot.content) ? snapshot.content : null;
  args._acp = acp;
  return args;
}

function readToolProgressSnapshot(value: unknown): Readonly<{
  toolName: string;
  rawInput?: unknown;
}> | null {
  if (!isRecord(value)) return null;
  const toolName = readString(value.toolName);
  if (!toolName) return null;
  return value as Readonly<{ toolName: string; rawInput?: unknown }>;
}

function readEphemeralEpoch(session: RuntimeTranscriptProjectionSession): number {
  try {
    const epoch = session.getEphemeralStreamConnectionEpoch?.();
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0
      ? Math.trunc(epoch)
      : 0;
  } catch {
    return 0;
  }
}

function assertRequiredTranscriptAdmission(
  admission: CommittedTranscriptAdmission | undefined,
  eventKind: string,
): void {
  if (
    !admission
    || (
      !admission.signal.aborted
      && (
        admission.deadlineAtMs === undefined
        || Date.now() < admission.deadlineAtMs
      )
    )
  ) {
    return;
  }
  throw new RuntimeTranscriptRequiredAdmissionError('admission_expired', eventKind);
}

export async function commitRequiredRuntimeTranscriptMessage(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  provenance: SessionTranscriptObservationProvenanceV1;
  eventKind: string;
  admission?: CommittedTranscriptAdmission;
}>): Promise<void> {
  assertRequiredTranscriptAdmission(params.admission, params.eventKind);
  const opts: CommittedTranscriptMessageOptions = {
    localId: params.localId,
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
    ...(params.updatedAt === undefined ? {} : { updatedAt: params.updatedAt }),
    provenance: params.provenance,
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  };
  if (!params.session.enqueueAgentMessageCommitted) {
    throw new RuntimeTranscriptRequiredAdmissionError(
      'durable_enqueue_unavailable',
      params.eventKind,
    );
  }
  try {
    const result = await params.session.enqueueAgentMessageCommitted(params.provider, params.body, opts);
    assertRequiredTranscriptAdmission(params.admission, params.eventKind);
    if (!result.persisted) {
      throw new RuntimeTranscriptRequiredAdmissionError(
        'durable_custody_rejected',
        params.eventKind,
      );
    }
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    if (error instanceof CommittedTranscriptAdmissionExpiredError) {
      throw new RuntimeTranscriptRequiredAdmissionError('admission_expired', params.eventKind);
    }
    throw new RuntimeTranscriptRequiredAdmissionError(
      'durable_enqueue_failed',
      params.eventKind,
    );
  }
}

async function commitRequiredRuntimeTranscriptUserText(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  text: string;
  localId: string;
  meta?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  provenance?: SessionTranscriptObservationProvenanceV1;
  eventKind: string;
  admission?: CommittedTranscriptAdmission;
}>): Promise<void> {
  assertRequiredTranscriptAdmission(params.admission, params.eventKind);
  if (!params.session.enqueueUserTextMessageCommitted) {
    throw new RuntimeTranscriptRequiredAdmissionError('durable_enqueue_unavailable', params.eventKind);
  }
  try {
    const result = await params.session.enqueueUserTextMessageCommitted(params.text, {
      localId: params.localId,
      ...(params.meta ? { meta: params.meta } : {}),
      ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
      ...(params.updatedAt === undefined ? {} : { updatedAt: params.updatedAt }),
      provenance: params.provenance ?? { kind: 'non_dependent', source: 'external' },
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    assertRequiredTranscriptAdmission(params.admission, params.eventKind);
    if (!result.persisted) {
      throw new RuntimeTranscriptRequiredAdmissionError('durable_custody_rejected', params.eventKind);
    }
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    if (error instanceof CommittedTranscriptAdmissionExpiredError) {
      throw new RuntimeTranscriptRequiredAdmissionError('admission_expired', params.eventKind);
    }
    throw new RuntimeTranscriptRequiredAdmissionError('durable_enqueue_failed', params.eventKind);
  }
}

function assertStreamedTranscriptFlushDurability(
  summaries: readonly StreamedTranscriptFlushSummary[],
  eventKind: 'tool-call' | 'turn-complete' | 'turn-failed' | 'turn-cancelled',
): void {
  const failedRequiredSegment = summaries
    .flatMap((summary) => summary.segments)
    .find((segment) => segment.sawText && !segment.didDurablyFlush);
  if (!failedRequiredSegment) return;
  throw new RuntimeTranscriptRequiredAdmissionError(
    'streamed_final_not_durable',
    eventKind,
  );
}

async function flushRequiredRuntimeTranscriptSegments(params: Readonly<{
  bridge: RuntimeMessageDeltaBridge;
  reason: 'tool-call-boundary' | 'turn-end' | 'abort';
  eventKind: 'tool-call' | 'turn-complete' | 'turn-failed' | 'turn-cancelled';
  interruptedReason?: string;
}>): Promise<void> {
  let summaries: readonly StreamedTranscriptFlushSummary[];
  try {
    summaries = await params.bridge.flushAll({
      reason: params.reason,
      ...(params.interruptedReason ? { interruptedReason: params.interruptedReason } : {}),
    });
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    throw new RuntimeTranscriptRequiredAdmissionError(
      'streamed_finalization_failed',
      params.eventKind,
    );
  }
  assertStreamedTranscriptFlushDurability(summaries, params.eventKind);
}

export async function projectRuntimeTranscriptEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider?: ACPProvider;
  runtimeMessageDeltaBridge?: RuntimeMessageDeltaBridge;
  admission?: CommittedTranscriptAdmission;
  event: unknown;
}>): Promise<RuntimeTranscriptProjectionResult> {
  const parsed = AgentSessionRuntimeEventSchema.safeParse(params.event);
  if (!parsed.success) {
    return { projected: false, reason: 'unsupported_event' };
  }
  const event = parsed.data;
  if (event.sessionId !== params.session.sessionId) {
    return { projected: false, reason: 'session_mismatch' };
  }
  if (event.kind === 'message-delta') {
    const deltaText = event.text;
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const appendDelta = event.channel === 'reasoning'
      ? params.runtimeMessageDeltaBridge.appendThinkingDelta
      : params.runtimeMessageDeltaBridge.appendAssistantDelta;
    appendDelta({
      streamKey: event.turnId,
      sidechainId: event.sidechainId ?? null,
      deltaText,
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'tool-progress') {
    if (!params.provider || !params.session.sendAgentMessageEphemeral) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const snapshot = readToolProgressSnapshot(event.progress);
    if (!snapshot) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-call');
    const rawOutcome = await params.session.sendAgentMessageEphemeral(
      params.provider,
      {
        type: 'tool-call',
        callId: event.toolCallId,
        name: snapshot.toolName,
        input: buildProjectedToolInput(snapshot.rawInput, event.progress),
        id: localId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      {
        localId,
        createdAt: event.emittedAtMs,
        updatedAt: event.emittedAtMs,
        meta: buildRuntimeToolMeta(event, 'tool-progress', true),
      },
    );
    const outcome = normalizeEphemeralSendOutcome(rawOutcome, readEphemeralEpoch(params.session));
    return outcome.accepted
      ? { projected: true, kind: event.kind }
      : { projected: false, reason: 'ephemeral_not_accepted' };
  }
  if (event.kind === 'tool-call') {
    if (params.runtimeMessageDeltaBridge) {
      await flushRequiredRuntimeTranscriptSegments({
        bridge: params.runtimeMessageDeltaBridge,
        reason: 'tool-call-boundary',
        eventKind: event.kind,
      });
    }
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-call');
    await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider: params.provider,
      localId,
      body: {
        type: 'tool-call',
        callId: event.toolCallId,
        name: event.toolName,
        input: event.input,
        id: localId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      meta: buildRuntimeToolMeta(event, 'tool-call', false),
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'tool-result') {
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-result');
    await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider: params.provider,
      localId,
      body: {
        type: 'tool-result',
        callId: event.toolCallId,
        output: event.output,
        id: localId,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      meta: buildRuntimeToolMeta(event, 'tool-result', false),
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-complete') {
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: 'turn-end',
      eventKind: event.kind,
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-failed') {
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: 'abort',
      eventKind: event.kind,
      interruptedReason: 'turn-failed',
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-cancelled') {
    if (!params.runtimeMessageDeltaBridge || !params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: 'abort',
      eventKind: event.kind,
      interruptedReason: 'turn-cancelled',
    });
    const markerId = event.agentTurnId ?? event.turnId;
    await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider: params.provider,
      body: { type: 'turn_cancelled', id: markerId },
      localId: `${markerId}:turn_cancelled`,
      meta: {
        source: 'runtime',
        runtimeEventKind: event.kind,
        runtimeTurnId: event.turnId,
      },
      createdAt: event.emittedAtMs,
      updatedAt: event.emittedAtMs,
      provenance: { kind: 'non_dependent', source: 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'transcript-message-committed' && event.role === 'user') {
    const observation = resolveCommittedTranscriptObservation(event);
    await commitRequiredRuntimeTranscriptUserText({
      session: params.session,
      text: event.text,
      localId: event.messageId,
      ...observation,
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind !== 'transcript-message-committed' || !params.provider) {
    return { projected: false, reason: 'unsupported_event' };
  }

  const observation = resolveCommittedTranscriptObservation(event);
  await commitRequiredRuntimeTranscriptMessage({
    session: params.session,
    provider: params.provider,
    body: event.role === 'reasoning'
      ? { type: 'thinking', text: event.text, ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}) }
      : { type: 'message', message: event.text, ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}) },
    localId: event.messageId,
    ...observation,
    eventKind: event.kind,
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  });
  return { projected: true, kind: event.kind };
}

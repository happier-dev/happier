import { projectRuntimeCompactionEvent } from './projectRuntimeCompactionEvent';
import { isForegroundTurnRuntimeTranscriptEvent, isSessionScopedRuntimeTranscriptEvent } from '../events/runtimeTranscriptScope';
import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { UsageMcpBindingUsageSchema } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import { buildSessionTranscriptMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionTranscriptObservationProvenanceV1, ToolNormalizationProtocol, TurnChangeSet } from '@happier-dev/protocol';

import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import { resolveHappierSkillIdentity } from '@/prompts/skills/runtime/resolveHappierSkillIdentity';
import { recordDaemonSkillUse } from '@/daemon/controlClient';
import type { SkillUsageAccount } from '@/prompts/skills/store/skillUsage';
import { configuration } from '@/configuration';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import type { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';
import type { NormalizedToolChangeResult } from '@/agent/tools/diff/normalizedToolChangeTypes';
import {
  normalizeEphemeralSendOutcome,
  type EphemeralSendResult,
} from '@/api/session/client/transcript/ephemeralSendOutcome';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import type { SessionPersonalFollowCommit } from '@/api/session/sessionClientPort';
import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import { getSessionCommittedTranscriptLocalIds } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import {
  CommittedTranscriptAdmissionExpiredError,
  type CommittedTranscriptAdmission,
  type CommittedTranscriptMessageOptions,
} from '@/api/session/transcriptPort';

type RuntimeMessageStreamArgs = Readonly<{
  streamKey: string;
  sidechainId: string | null;
  messageId?: string;
  foregroundTurnId?: string;
}>;

type RuntimeMessageDeltaBridge = Readonly<{
  appendAssistantDelta: (args: RuntimeMessageStreamArgs & Readonly<{ deltaText: string }>) => void;
  appendThinkingDelta: (args: RuntimeMessageStreamArgs & Readonly<{ deltaText: string }>) => void;
  finalizeSegment: (args: RuntimeMessageStreamArgs & Readonly<{
    channel: 'assistant' | 'reasoning';
    text: string;
    sourceMessageId: string;
    unnamedStreamKey?: string;
    admission?: CommittedTranscriptAdmission;
  }>) => Promise<StreamedTranscriptFlushSummary | null>;
  flushAll: (args: Readonly<{
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
    selectStream?: (stream: Readonly<{ foregroundTurnId?: string }>) => boolean;
  }>) => Promise<readonly StreamedTranscriptFlushSummary[]>;
}>;

type TranscriptMessageCommitResult = Readonly<{
  persisted: boolean;
  delivered: boolean;
  committedSequence?: number;
  personalFollow?: SessionActivityChangedResult['personalFollow'];
  whenCommitted?: Promise<SessionPersonalFollowCommit | null>;
}>;

export type RuntimeTranscriptProjectionSession = Readonly<{
  sessionId: string;
  /** Run-scoped transcript targets require a durable marker even for zero-output turns. */
  requiresDurableTurnCompletionMarker?: true;
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
  | 'delivery_not_confirmed'
  | 'streamed_finalization_failed'
  | 'streamed_final_not_durable';

export class RuntimeTranscriptRequiredAdmissionError extends Error {
  readonly code = 'runtime_transcript_required_admission_failed' as const;

  constructor(
    readonly reason: RuntimeTranscriptRequiredAdmissionFailureReason,
    readonly eventKind: string,
    options?: ErrorOptions,
  ) {
    super(`Required runtime transcript admission failed: ${reason}`, options);
    this.name = 'RuntimeTranscriptRequiredAdmissionError';
  }
}

export type RuntimeTranscriptProjectionResult =
  | Readonly<{
    projected: true;
    /** Exact foreground assistant custody, independent of notification previews. */
    finalAssistantMessageSeq?: number;
    terminalSourceMessage?: Readonly<{ localId: string; committedSequence?: number;
      personalFollow?: SessionActivityChangedResult['personalFollow']; whenCommitted?: Promise<SessionPersonalFollowCommit | null> }>;
    kind:
      | 'message-delta'
      | 'tool-progress'
      | 'tool-call'
      | 'mcp-tool-usage'
      | 'context-compaction'
      | 'skill-usage'
      | 'tool-result'
      | 'file-edit'
      | 'turn-complete'
      | 'turn-failed'
      | 'turn-cancelled'
      | 'transcript-message-committed';
  }>
  | Readonly<{
    projected: false;
    reason: 'unsupported_event' | 'session_mismatch' | 'ephemeral_not_accepted';
  }>;

// Foreground streaming and native file follow share the Session's ordered
// projection and its active stream writer. Retain exact live receipts beside
// the committed-ID baseline so a joining delivery admission can recheck them.
type RuntimeTranscriptProjectionParams = Parameters<typeof projectRuntimeTranscriptEvent>[0];
type AdmittedRuntimeTranscriptProjectionParams = Omit<RuntimeTranscriptProjectionParams, 'event'> & Readonly<{
  event: AgentSessionRuntimeEvent;
}>;
type CommittedNativeTranscript = Readonly<{
  role: 'assistant' | 'reasoning';
  sidechainId: string | null;
  hasText: boolean;
  result: Promise<TranscriptMessageCommitResult>;
}>;
type SessionTranscriptProjection = {
  commits: Map<string, CommittedNativeTranscript>;
  tail: Promise<void>;
  stream?: Readonly<{ provider: ACPProvider; bridge: RuntimeMessageDeltaBridge }>;
};
const transcriptProjections = new WeakMap<RuntimeTranscriptProjectionSession, SessionTranscriptProjection>();

function bindSessionTranscriptProjection<T extends RuntimeTranscriptProjectionParams>(params: T) {
  let state = transcriptProjections.get(params.session);
  if (!state) {
    state = { commits: new Map(), tail: Promise.resolve() };
    transcriptProjections.set(params.session, state);
  }
  if (params.provider && params.runtimeMessageDeltaBridge) {
    state.stream = { provider: params.provider, bridge: params.runtimeMessageDeltaBridge };
  }
  return { state, params: !params.runtimeMessageDeltaBridge && state.stream && state.stream.provider === params.provider
    ? { ...params, runtimeMessageDeltaBridge: state.stream.bridge } : params };
}

function enqueueSessionTranscriptProjection(
  state: SessionTranscriptProjection,
  project: () => Promise<RuntimeTranscriptProjectionResult>,
): Promise<RuntimeTranscriptProjectionResult> {
  const result = state.tail.then(project);
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}

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

function buildRuntimeMessageStreamArgs(
  event: Extract<AgentSessionRuntimeEvent, { kind: 'message-delta' | 'transcript-message-committed' }>,
  channel: 'assistant' | 'reasoning',
  messageId: string | null = event.messageId ?? null,
): RuntimeMessageStreamArgs {
  const foreground = isForegroundTurnRuntimeTranscriptEvent(event);
  return {
    // A native message has one transcript identity even when its authoritative
    // source observation is Session scoped. Only unnamed output needs turn scope.
    streamKey: messageId
      ? JSON.stringify([event.sessionId, event.sidechainId ?? null, channel, messageId])
      : foreground
        ? JSON.stringify([event.turnId, channel, null])
        : JSON.stringify([event.sessionId, event.sidechainId ?? null, event.turnId ?? null, channel, null]),
    sidechainId: event.sidechainId ?? null,
    ...(messageId ? { messageId } : {}),
    ...(foreground ? { foregroundTurnId: event.turnId } : {}),
  };
}

function projectCommittedAssistantReceipt(
  event: Extract<AgentSessionRuntimeEvent, { kind: 'transcript-message-committed' | 'message-delta' }>,
  result: TranscriptMessageCommitResult,
  hasText = event.text.trim().length > 0,
): Readonly<{ finalAssistantMessageSeq?: number }> {
  return isForegroundTurnRuntimeTranscriptEvent(event)
    && (event.kind === 'message-delta' ? event.channel === 'assistant' : event.role === 'assistant') && hasText
    && result.delivered && typeof result.committedSequence === 'number'
    && Number.isSafeInteger(result.committedSequence) && result.committedSequence >= 0
    ? { finalAssistantMessageSeq: result.committedSequence } : {};
}

function buildRuntimeToolLocalId(event: Readonly<{
  sessionId: string;
  turnId?: string;
  sidechainId?: string;
  toolCallId: string;
}>, kind: 'tool-call' | 'tool-result'): string {
  const identity = createAcpToolIdentity({
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    sidechainId: event.sidechainId ?? null,
    toolCallId: event.toolCallId,
  });
  return kind === 'tool-call' ? identity.callLocalId : identity.resultLocalId;
}

function commitRuntimeTurnCancellation(
  params: Parameters<typeof projectRuntimeTranscriptEvent>[0],
  event: Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>,
): Promise<TranscriptMessageCommitResult> | undefined {
  if (!params.provider || !params.runtimeMessageDeltaBridge || params.questionWaitTurnId === event.turnId) return undefined;
  const markerId = event.agentTurnId ?? event.turnId;
  return commitRequiredRuntimeTranscriptMessage({
    session: params.session,
    provider: params.provider,
    body: { type: 'turn_cancelled', id: markerId },
    localId: `${markerId}:turn_cancelled`,
    meta: { source: 'runtime', runtimeEventKind: event.kind, runtimeTurnId: event.turnId },
    createdAt: event.emittedAtMs,
    updatedAt: event.emittedAtMs,
    provenance: { kind: 'non_dependent', source: 'external' },
    eventKind: event.kind,
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  });
}

/** The one typed failed-turn marker writer for native output and host failures. */
export async function commitRuntimeTurnFailureMarker(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  event: Pick<Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' }>, 'turnId' | 'agentTurnId' | 'emittedAtMs'>;
  meta?: Record<string, unknown>;
  provenance?: SessionTranscriptObservationProvenanceV1;
  admission?: CommittedTranscriptAdmission;
}>) {
  const markerId = params.event.agentTurnId ?? params.event.turnId;
  const localId = `${markerId}:turn_failed`;
  const result = await commitRequiredRuntimeTranscriptMessage({
    session: params.session, provider: params.provider,
    body: { type: 'turn_failed', id: markerId }, localId,
    meta: params.meta ?? { source: 'runtime', runtimeEventKind: 'turn-failed', runtimeTurnId: params.event.turnId },
    createdAt: params.event.emittedAtMs, updatedAt: params.event.emittedAtMs,
    provenance: params.provenance ?? { kind: 'non_dependent', source: 'external' },
    eventKind: 'turn-failed',
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  });
  const committed = result.committedSequence === undefined ? await result.whenCommitted : null;
  const committedSequence = committed?.committedSequence ?? result.committedSequence;
  const personalFollow = committed?.personalFollow ?? result.personalFollow;
  return { localId,
    ...(committedSequence === undefined ? {} : { committedSequence }),
    ...(personalFollow ? { personalFollow } : {}),
    ...(result.whenCommitted ? { whenCommitted: result.whenCommitted } : {}),
  };
}

/** Foreground calls retain correction custody until their native result arrives. */
export function createRuntimeTranscriptProjector(): (
  params: Parameters<typeof projectRuntimeTranscriptEvent>[0] & Readonly<{ priorProjection?: Promise<void> }>,
) => Promise<RuntimeTranscriptProjectionResult> {
  const pendingCalls = new Map<string, {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    missingResultCreatedAtMs?: number;
  }>();
  return (input) => {
    const bound = bindSessionTranscriptProjection(input);
    const { state } = bound;
    const parsed = AgentSessionRuntimeEventSchema.safeParse(bound.params.event);
    if (!parsed.success) {
      return enqueueSessionTranscriptProjection(state, async () => ({ projected: false, reason: 'unsupported_event' }));
    }
    const event = parsed.data;
    const params = { ...bound.params, event };
    if (event.sessionId !== params.session.sessionId) {
      return enqueueSessionTranscriptProjection(state, () => projectRuntimeTranscriptEventNow(params));
    }
    // Native cancellation is already authoritative. Publish its marker before
    // joining earlier transcript writes, while retaining their ordered drain.
    const cancellationMarker = event.kind === 'turn-cancelled'
      ? commitRuntimeTurnCancellation(params, event) : undefined;
    void cancellationMarker?.catch(() => undefined);
    return enqueueSessionTranscriptProjection(state, async () => {
      await params.priorProjection;
      if (event.kind === 'turn-cancelled' || event.kind === 'turn-failed' || event.kind === 'turn-complete') {
        for (const call of pendingCalls.values()) {
          if (call.sessionId !== event.sessionId || call.turnId !== event.turnId || call.missingResultCreatedAtMs !== undefined) continue;
          // A terminal turn settles the transcript wait, not the external effect.
          // Later native results keep the same projection identity; the existing
          // transcript transport owns revision arbitration.
          const settlement = await projectRuntimeTranscriptEventNow({ ...params, toolResultCreatedAtMs: event.emittedAtMs, event: {
            kind: 'tool-result', sessionId: call.sessionId, turnId: call.turnId,
            toolCallId: call.toolCallId, sequence: event.sequence, emittedAtMs: event.emittedAtMs,
            isError: true,
            output: {
              status: event.kind === 'turn-cancelled' ? 'cancelled' : 'failed',
              error: 'The turn ended before a tool result was received. The operation may have taken effect.',
            },
          } });
          if (settlement.projected) call.missingResultCreatedAtMs = event.emittedAtMs;
        }
      }
      const pendingCall = event.kind === 'tool-result'
        ? pendingCalls.get(buildRuntimeToolLocalId(event, 'tool-call'))
        : undefined;
      const result = await projectRuntimeTranscriptEventNow({ ...params,
        ...(pendingCall?.missingResultCreatedAtMs === undefined ? {} : {
          toolResultCreatedAtMs: pendingCall.missingResultCreatedAtMs,
        }),
      }, cancellationMarker);
      if (result.projected && event.kind === 'tool-call' && isForegroundTurnRuntimeTranscriptEvent(event)) {
        pendingCalls.set(buildRuntimeToolLocalId(event, 'tool-call'), {
          sessionId: event.sessionId, turnId: event.turnId, toolCallId: event.toolCallId,
        });
      } else if (result.projected && event.kind === 'tool-result' && isForegroundTurnRuntimeTranscriptEvent(event)) {
        pendingCalls.delete(buildRuntimeToolLocalId(event, 'tool-call'));
      }
      return result;
    });
  };
}

function buildRuntimeFileEditLocalId(event: Readonly<{
  sessionId: string;
  turnId?: string;
  sidechainId?: string;
  editId: string;
}>): string {
  return createAcpToolIdentity({
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    sidechainId: event.sidechainId ?? null,
    toolCallId: `file-edit:${event.editId}`,
  }).callLocalId;
}

function buildRuntimeToolMeta(event: Readonly<{
  turnId?: string;
}>, kind: 'tool-progress' | 'tool-call' | 'tool-result', fullSnapshot: boolean): Record<string, unknown> {
  return {
    source: 'runtime',
    runtimeEventKind: kind,
    ...(event.turnId ? { runtimeTurnId: event.turnId } : {}),
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

function readNormalizedToolChangeResult(value: unknown): NormalizedToolChangeResult | undefined {
  if (!isRecord(value) || !isRecord(value.fileMutation)) return undefined;
  const mutation = value.fileMutation;
  return {
    fileMutation: {
      ...(mutation.kind === 'create' || mutation.kind === 'update' || mutation.kind === 'delete' || mutation.kind === 'unknown'
        ? { kind: mutation.kind }
        : {}),
      ...(typeof mutation.filePath === 'string' ? { filePath: mutation.filePath } : {}),
      ...(typeof mutation.oldText === 'string' || mutation.oldText === null ? { oldText: mutation.oldText } : {}),
      ...(typeof mutation.newText === 'string' || mutation.newText === null ? { newText: mutation.newText } : {}),
    },
  };
}

export type RuntimeTurnChangeSetPublication = Readonly<{
  turnChangeSet: TurnChangeSet;
  eventKind: string;
  admission?: CommittedTranscriptAdmission;
}>;

export async function publishRuntimeTurnChangeSet(params: RuntimeTurnChangeSetPublication & Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  protocol: ToolNormalizationProtocol;
  publishTurnChangeSet?: (publication: RuntimeTurnChangeSetPublication) => Promise<void>;
}>): Promise<void> {
  if (params.publishTurnChangeSet) {
    await params.publishTurnChangeSet({
      turnChangeSet: params.turnChangeSet,
      eventKind: params.eventKind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    return;
  }
  const messages: Array<Readonly<{ body: ACPMessageData; localId: string }>> = [];
  emitCanonicalTurnDiffTool({
    turnChangeSet: params.turnChangeSet,
    protocol: params.protocol,
    rawToolName: 'NormalizedRuntimeToolDiff',
    sendToolCall: ({ toolName, input, callId }) => {
      const resolvedCallId = callId ?? `normalized-tool-diff-${params.turnChangeSet.turnId}`;
      messages.push({
        body: { type: 'tool-call', id: resolvedCallId, callId: resolvedCallId, name: toolName, input },
        localId: `${resolvedCallId}:tool-call`,
      });
      return resolvedCallId;
    },
    sendToolResult: ({ callId, output }) => {
      messages.push({
        body: { type: 'tool-result', id: callId, callId, output },
        localId: `${callId}:tool-result`,
      });
    },
  });
  for (const message of messages) {
    await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider: params.provider,
      body: message.body,
      localId: message.localId,
      provenance: { kind: 'non_dependent', source: 'external' },
      eventKind: params.eventKind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
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
}>): Promise<TranscriptMessageCommitResult> {
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
    if (params.admission?.requireDelivery && !result.delivered) {
      throw new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', params.eventKind);
    }
    if (!result.persisted) {
      throw new RuntimeTranscriptRequiredAdmissionError(
        'durable_custody_rejected',
        params.eventKind,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    if (error instanceof CommittedTranscriptAdmissionExpiredError) {
      throw new RuntimeTranscriptRequiredAdmissionError('admission_expired', params.eventKind, { cause: error });
    }
    throw new RuntimeTranscriptRequiredAdmissionError(
      'durable_enqueue_failed',
      params.eventKind,
      { cause: error },
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
    if (params.admission?.requireDelivery && !result.delivered) {
      throw new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', params.eventKind);
    }
    if (!result.persisted) {
      throw new RuntimeTranscriptRequiredAdmissionError('durable_custody_rejected', params.eventKind);
    }
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    if (error instanceof CommittedTranscriptAdmissionExpiredError) {
      throw new RuntimeTranscriptRequiredAdmissionError('admission_expired', params.eventKind, { cause: error });
    }
    throw new RuntimeTranscriptRequiredAdmissionError('durable_enqueue_failed', params.eventKind, { cause: error });
  }
}

function assertStreamedTranscriptFlushDurability(
  summaries: readonly StreamedTranscriptFlushSummary[],
  eventKind: 'tool-call' | 'turn-complete' | 'turn-failed' | 'turn-cancelled' | 'transcript-message-committed',
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
  turnId: string;
}>): Promise<Readonly<{ finalAssistantMessageSeq?: number }>> {
  let summaries: readonly StreamedTranscriptFlushSummary[];
  try {
    summaries = await params.bridge.flushAll({
      reason: params.reason,
      selectStream: (stream) => stream.foregroundTurnId === params.turnId,
      ...(params.interruptedReason ? { interruptedReason: params.interruptedReason } : {}),
    });
  } catch (error) {
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) throw error;
    throw new RuntimeTranscriptRequiredAdmissionError(
      'streamed_finalization_failed',
      params.eventKind,
      { cause: error },
    );
  }
  assertStreamedTranscriptFlushDurability(summaries, params.eventKind);
  let finalAssistantMessageSeq: number | undefined;
  for (const summary of summaries) for (const segment of summary.segments) {
    if (segment.kind === 'assistant' && segment.sidechainId === null && segment.didDeliver
      && typeof segment.committedSequence === 'number' && Number.isSafeInteger(segment.committedSequence)
      && segment.committedSequence >= 0) {
      finalAssistantMessageSeq = Math.max(finalAssistantMessageSeq ?? 0, segment.committedSequence);
    }
  }
  return finalAssistantMessageSeq === undefined ? {} : { finalAssistantMessageSeq };
}

export function projectRuntimeTranscriptEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider?: ACPProvider;
  runtimeMessageDeltaBridge?: RuntimeMessageDeltaBridge;
  admission?: CommittedTranscriptAdmission;
  normalizedToolTurnChangeTracker?: NormalizedToolTurnChangeTracker;
  /** Foreground checkpoint finalization joins native evidence before publishing the single card. */
  publishTurnChangeSet?: (publication: RuntimeTurnChangeSetPublication) => Promise<void>;
  toolNormalizationProtocol?: ToolNormalizationProtocol;
  /** Host-owned yield witness captured before asynchronous transcript projection. */
  questionWaitTurnId?: string | null;
  /** The first result snapshot's source timestamp, retained for a late native correction. */
  toolResultCreatedAtMs?: number;
  event: unknown;
  mcpServerIdentities?: Readonly<Record<string, import('@/mcp/runtime/assignMcpWireNames').McpServerIdentity>>;
  skillDelivery?: AgentSessionSkillDelivery;
  usageAccount?: SkillUsageAccount;
}>): Promise<RuntimeTranscriptProjectionResult> {
  const bound = bindSessionTranscriptProjection(params);
  const parsed = AgentSessionRuntimeEventSchema.safeParse(params.event);
  if (!parsed.success) {
    return enqueueSessionTranscriptProjection(bound.state, async () => ({ projected: false, reason: 'unsupported_event' }));
  }
  const admitted = { ...bound.params, event: parsed.data };
  const cancellationMarker = parsed.data.sessionId === params.session.sessionId
    && parsed.data.kind === 'turn-cancelled'
    ? commitRuntimeTurnCancellation(bound.params, parsed.data) : undefined;
  void cancellationMarker?.catch(() => undefined);
  return enqueueSessionTranscriptProjection(bound.state,
    () => projectRuntimeTranscriptEventNow(admitted, cancellationMarker));
}

async function projectRuntimeTranscriptEventNow(
  params: AdmittedRuntimeTranscriptProjectionParams,
  cancellationMarker?: Promise<TranscriptMessageCommitResult>,
): Promise<RuntimeTranscriptProjectionResult> {
  const event = params.event;
  if (event.sessionId !== params.session.sessionId) {
    return { projected: false, reason: 'session_mismatch' };
  }
  if (event.kind === 'context-compaction') return projectRuntimeCompactionEvent({ ...params, event });
  if (event.kind === 'skill-usage') {
    if (!params.usageAccount) return { projected: false, reason: 'unsupported_event' };
    const skillIds = [...new Set(event.skills.flatMap(skill => {
      const id = resolveHappierSkillIdentity(skill, params.skillDelivery, configuration.happyHomeDir);
      return id === null ? [] : [id];
    }))];
    if (!skillIds.length) return { projected: false, reason: 'unsupported_event' };
    try { await recordDaemonSkillUse({ skillIds, account: params.usageAccount }); }
    catch { return { projected: false, reason: 'unsupported_event' }; }
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'mcp-tool-usage') {
    if (!params.provider) return { projected: false, reason: 'unsupported_event' };
    const bindings = event.servers.flatMap(server => {
      const identity = params.mcpServerIdentities?.[server.serverName]?.usage;
      return identity ? [{ ...identity, toolCallCount: server.toolCallCount, schemaBytes: server.schemaBytes }] : [];
    });
    if (!bindings.length) return { projected: false, reason: 'unsupported_event' };
    const evidenceId = JSON.stringify([event.sessionId, event.turnId, event.sequence]);
    const usage = UsageMcpBindingUsageSchema.safeParse({ v: 2, evidenceId, sessionId: event.sessionId,
      turnId: event.turnId, observedAtMs: event.window.endMs, window: event.window,
      ...(event.queuedTurnCount === undefined ? {} : { queuedTurnCount: event.queuedTurnCount }),
      coverage: bindings.length === event.servers.length ? event.coverage : 'partial', bindings });
    if (!usage.success) return { projected: false, reason: 'unsupported_event' };
    await commitRequiredRuntimeTranscriptMessage({ session: params.session, provider: params.provider,
      body: { type: 'event', id: evidenceId, data: { type: 'mcp-binding-usage', usage: usage.data } }, localId: evidenceId,
      createdAt: event.window.endMs, provenance: { kind: 'non_dependent', source: 'external' },
      eventKind: event.kind, ...(params.admission ? { admission: params.admission } : {}) });
    return { projected: true, kind: event.kind };
  }
  const sessionScopedTranscript = isSessionScopedRuntimeTranscriptEvent(event);
  if (event.kind === 'turn-start') {
    params.normalizedToolTurnChangeTracker?.beginTurn({
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
    });
  } else if (!sessionScopedTranscript && 'agentTurnId' in event && event.agentTurnId) {
    params.normalizedToolTurnChangeTracker?.observeAgentTurnId(event.agentTurnId);
  }
  if (event.kind === 'message-delta') {
    const committed = event.messageId && transcriptProjections.get(params.session)?.commits.get(event.messageId);
    if (committed && committed.sidechainId === (event.sidechainId ?? null)
      && committed.role === (event.channel === 'assistant' ? 'assistant' : 'reasoning')) {
      // File follow can observe the authoritative final before a delayed native
      // delta. Reuse its exact receipt rather than resurrecting a partial writer.
      return { projected: true, kind: event.kind,
        ...projectCommittedAssistantReceipt(event, await committed.result, committed.hasText) };
    }
    const deltaText = event.text;
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const appendDelta = event.channel === 'reasoning'
      ? params.runtimeMessageDeltaBridge.appendThinkingDelta
      : params.runtimeMessageDeltaBridge.appendAssistantDelta;
    appendDelta({
      ...buildRuntimeMessageStreamArgs(event, event.channel),
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
    let assistantReceipt: Readonly<{ finalAssistantMessageSeq?: number }> = {};
    if (isForegroundTurnRuntimeTranscriptEvent(event) && params.runtimeMessageDeltaBridge) {
      assistantReceipt = await flushRequiredRuntimeTranscriptSegments({
        bridge: params.runtimeMessageDeltaBridge,
        reason: 'tool-call-boundary',
        eventKind: event.kind,
        turnId: event.turnId,
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
    if (!sessionScopedTranscript && isRecord(event.input)) {
      params.normalizedToolTurnChangeTracker?.observeToolCall({
        callId: event.toolCallId,
        toolName: event.toolName,
        args: event.input,
        parentToolUseId: event.sidechainId ?? null,
      });
    }
    return { projected: true, kind: event.kind, ...assistantReceipt };
  }
  if (event.kind === 'tool-result') {
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-result');
    const createdAt = params.toolResultCreatedAtMs ?? event.emittedAtMs;
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
      createdAt,
      updatedAt: Math.max(createdAt, event.emittedAtMs),
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    if (!sessionScopedTranscript) params.normalizedToolTurnChangeTracker?.observeToolResult({
      callId: event.toolCallId,
      isError: event.isError === true,
      result: readNormalizedToolChangeResult(event.output),
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'file-edit') {
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeFileEditLocalId(event);
    await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider: params.provider,
      localId,
      body: {
        type: 'file-edit',
        description: event.description ?? '',
        filePath: event.path,
        ...(event.diff === undefined ? {} : { diff: event.diff }),
        ...(event.oldContent === undefined ? {} : { oldContent: event.oldContent }),
        ...(event.newContent === undefined ? {} : { newContent: event.newContent }),
        id: localId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      meta: {
        source: 'runtime',
        runtimeEventKind: event.kind,
        ...(event.turnId ? { runtimeTurnId: event.turnId } : {}),
      },
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    if (!sessionScopedTranscript) params.normalizedToolTurnChangeTracker?.observeFileEdit({
      editId: event.editId,
      filePath: event.path,
      ...(event.diff === undefined ? {} : { diff: event.diff }),
      ...(event.oldContent === undefined ? {} : { oldContent: event.oldContent }),
      ...(event.newContent === undefined ? {} : { newContent: event.newContent }),
      ...(event.description === undefined ? {} : { description: event.description }),
      parentToolUseId: event.sidechainId ?? null,
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-complete') {
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const assistantReceipt = await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: 'turn-end',
      eventKind: event.kind,
      turnId: event.turnId,
    });
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'completed',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishRuntimeTurnChangeSet({
        publishTurnChangeSet: params.publishTurnChangeSet,
        session: params.session,
        provider: params.provider,
        protocol: params.toolNormalizationProtocol,
        turnChangeSet: normalizedTurnChangeSet,
        eventKind: event.kind,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
    }
    // A turn with no streamed text still needs one durable typed terminal
    // observation. Session-owned Runs pass through the existing run-scoped
    // transcript target, which adds their exact sidechain and rechecks current
    // controller custody before this write can reach the parent Session.
    if (params.provider && params.session.requiresDurableTurnCompletionMarker === true
      && params.questionWaitTurnId !== event.turnId) {
      const completion = await commitRequiredRuntimeTranscriptMessage({
        session: params.session,
        provider: params.provider,
        body: { type: 'task_complete', id: event.turnId },
        localId: `${event.turnId}:task_complete`,
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
      return { projected: true, kind: event.kind, ...assistantReceipt, terminalSourceMessage: {
        localId: `${event.turnId}:task_complete`,
        ...(completion.committedSequence === undefined ? {} : { committedSequence: completion.committedSequence }),
        ...(completion.personalFollow ? { personalFollow: completion.personalFollow } : {}),
        ...(completion.whenCommitted ? { whenCommitted: completion.whenCommitted } : {}),
      } };
    }
    return { projected: true, kind: event.kind, ...assistantReceipt };
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
      turnId: event.turnId,
    });
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'interrupted',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishRuntimeTurnChangeSet({
        publishTurnChangeSet: params.publishTurnChangeSet,
        session: params.session,
        provider: params.provider,
        protocol: params.toolNormalizationProtocol,
        turnChangeSet: normalizedTurnChangeSet,
        eventKind: event.kind,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
    }
    if (params.provider && params.session.requiresDurableTurnCompletionMarker === true) {
      const marker = await commitRuntimeTurnFailureMarker({
        session: params.session, provider: params.provider, event,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
      return { projected: true, kind: event.kind, terminalSourceMessage: marker };
    }
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-cancelled') {
    if (!params.runtimeMessageDeltaBridge || !params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const marker = cancellationMarker ?? commitRuntimeTurnCancellation(params, event);
    void marker?.catch(() => undefined);
    const assistantReceipt = await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: params.questionWaitTurnId === event.turnId ? 'turn-end' : 'abort',
      eventKind: event.kind,
      turnId: event.turnId,
      ...(params.questionWaitTurnId === event.turnId ? {} : { interruptedReason: 'turn-cancelled' }),
    });
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'aborted',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishRuntimeTurnChangeSet({
        publishTurnChangeSet: params.publishTurnChangeSet,
        session: params.session,
        provider: params.provider,
        protocol: params.toolNormalizationProtocol,
        turnChangeSet: normalizedTurnChangeSet,
        eventKind: event.kind,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
    }
    if (params.questionWaitTurnId === event.turnId) {
      return { projected: true, kind: event.kind };
    }
    await marker;
    return { projected: true, kind: event.kind, ...assistantReceipt };
  }
  if (event.kind === 'transcript-message-committed' && event.role === 'user') {
    const observation = resolveCommittedTranscriptObservation(event);
    await commitRequiredRuntimeTranscriptUserText({
      session: params.session,
      text: event.text,
      localId: event.messageId,
      meta: {
        happierProvenanceV1: buildSessionTranscriptMessageProvenanceV1('runtimeTranscript'),
      },
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
  assertRequiredTranscriptAdmission(params.admission, event.kind);
  const committedLocalIds = getSessionCommittedTranscriptLocalIds(params.session);
  const pending = transcriptProjections.get(params.session)!.commits;
  const incumbent = pending?.get(event.messageId);
  if (incumbent) {
    // A native ID collision is not delivery evidence for another channel or
    // sidechain. Preserve the exact receipt rather than acknowledging that write.
    if (incumbent.role !== event.role || incumbent.sidechainId !== (event.sidechainId ?? null)) {
      throw new RuntimeTranscriptRequiredAdmissionError('durable_custody_rejected', event.kind);
    }
    const result = await incumbent.result;
    assertRequiredTranscriptAdmission(params.admission, event.kind);
    if (params.admission?.requireDelivery && !result.delivered) {
      throw new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', event.kind);
    }
    return { projected: true, kind: event.kind, ...projectCommittedAssistantReceipt(event, result) };
  }
  if (committedLocalIds.has(event.messageId)) return { projected: true, kind: event.kind };
  const provider = params.provider;
  const channel = event.role === 'reasoning' ? 'reasoning' : 'assistant';
  const commit = async (): Promise<TranscriptMessageCommitResult> => {
    // Peer-delivered text is a whole message from another agent, never a stream segment of this Agent's reply.
    if (params.runtimeMessageDeltaBridge && !event.peer) {
      assertRequiredTranscriptAdmission(params.admission, event.kind);
      const summary = await params.runtimeMessageDeltaBridge.finalizeSegment({
        ...buildRuntimeMessageStreamArgs(event, channel),
        channel,
        text: event.text,
        sourceMessageId: event.messageId,
        ...(isForegroundTurnRuntimeTranscriptEvent(event)
          ? { unnamedStreamKey: buildRuntimeMessageStreamArgs(event, channel, null).streamKey }
          : {}),
        ...(params.admission ? { admission: params.admission } : {}),
      });
      assertRequiredTranscriptAdmission(params.admission, event.kind);
      if (summary) {
        assertStreamedTranscriptFlushDurability([summary], event.kind);
        committedLocalIds.add(event.messageId);
        const sequence = summary.segments.find(segment => segment.kind === 'assistant' && segment.sidechainId === null)?.committedSequence;
        return { persisted: true, delivered: summary.segments.every(segment => !segment.sawText || segment.didDeliver === true),
          ...(sequence === undefined ? {} : { committedSequence: sequence }) };
      }
    }
    const result = await commitRequiredRuntimeTranscriptMessage({
      session: params.session,
      provider,
      body: event.role === 'reasoning'
        ? { type: 'thinking', text: event.text, ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}) }
        : { type: 'message', message: event.text, ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
          ...(event.peer ? { peer: event.peer } : {}) },
      localId: event.messageId,
      meta: {
        source: 'runtime',
        runtimeEventKind: event.kind,
        ...(event.turnId ? { runtimeTurnId: event.turnId } : {}),
      },
      ...observation,
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    committedLocalIds.add(event.messageId);
    return result;
  };
  const publication = commit();
  pending.set(event.messageId, { role: channel, sidechainId: event.sidechainId ?? null,
    hasText: event.text.trim().length > 0, result: publication });
  try {
    const result = await publication;
    return { projected: true, kind: event.kind, ...projectCommittedAssistantReceipt(event, result) };
  } catch (error) {
    pending.delete(event.messageId);
    throw error;
  }
}

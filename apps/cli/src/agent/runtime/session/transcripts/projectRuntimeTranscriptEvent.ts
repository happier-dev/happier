import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { buildSessionTranscriptMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionTranscriptObservationProvenanceV1, ToolNormalizationProtocol, TurnChangeSet } from '@happier-dev/protocol';

import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import type { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';
import type { NormalizedToolChangeResult } from '@/agent/tools/diff/normalizedToolChangeTypes';
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

function buildRuntimeFileEditLocalId(event: Readonly<{
  sessionId: string;
  turnId: string;
  sidechainId?: string;
  editId: string;
}>): string {
  return createAcpToolIdentity({
    sessionId: event.sessionId,
    turnId: event.turnId,
    sidechainId: event.sidechainId ?? null,
    toolCallId: `file-edit:${event.editId}`,
  }).callLocalId;
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

async function publishNormalizedToolTurnChangeSet(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  protocol: ToolNormalizationProtocol;
  turnChangeSet: TurnChangeSet;
  eventKind: string;
  admission?: CommittedTranscriptAdmission;
}>): Promise<void> {
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
    if (params.admission?.requireDelivery && !result.delivered) {
      throw new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', params.eventKind);
    }
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
    if (params.admission?.requireDelivery && !result.delivered) {
      throw new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', params.eventKind);
    }
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
  normalizedToolTurnChangeTracker?: NormalizedToolTurnChangeTracker;
  toolNormalizationProtocol?: ToolNormalizationProtocol;
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
  if (event.kind === 'turn-start') {
    params.normalizedToolTurnChangeTracker?.beginTurn({
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
    });
  } else if ('agentTurnId' in event && event.agentTurnId) {
    params.normalizedToolTurnChangeTracker?.observeAgentTurnId(event.agentTurnId);
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
    if (isRecord(event.input)) {
      params.normalizedToolTurnChangeTracker?.observeToolCall({
        callId: event.toolCallId,
        toolName: event.toolName,
        args: event.input,
        parentToolUseId: event.sidechainId ?? null,
      });
    }
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
    params.normalizedToolTurnChangeTracker?.observeToolResult({
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
        runtimeTurnId: event.turnId,
      },
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
      eventKind: event.kind,
      ...(params.admission === undefined ? {} : { admission: params.admission }),
    });
    params.normalizedToolTurnChangeTracker?.observeFileEdit({
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
    await flushRequiredRuntimeTranscriptSegments({
      bridge: params.runtimeMessageDeltaBridge,
      reason: 'turn-end',
      eventKind: event.kind,
    });
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'completed',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishNormalizedToolTurnChangeSet({
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
    if (params.provider && params.session.requiresDurableTurnCompletionMarker === true) {
      await commitRequiredRuntimeTranscriptMessage({
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
    }
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
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'interrupted',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishNormalizedToolTurnChangeSet({
        session: params.session,
        provider: params.provider,
        protocol: params.toolNormalizationProtocol,
        turnChangeSet: normalizedTurnChangeSet,
        eventKind: event.kind,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
    }
    if (params.provider && params.session.requiresDurableTurnCompletionMarker === true) {
      const markerId = event.agentTurnId ?? event.turnId;
      await commitRequiredRuntimeTranscriptMessage({
        session: params.session,
        provider: params.provider,
        body: { type: 'turn_failed', id: markerId },
        localId: `${markerId}:turn_failed`,
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
    }
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
    const normalizedTurnChangeSet = params.normalizedToolTurnChangeTracker?.completeTurn({
      sessionId: params.session.sessionId,
      turnId: event.turnId,
      agentTurnId: event.agentTurnId ?? null,
      sequence: event.sequence,
      status: 'aborted',
    });
    if (normalizedTurnChangeSet && params.provider && params.toolNormalizationProtocol) {
      await publishNormalizedToolTurnChangeSet({
        session: params.session,
        provider: params.provider,
        protocol: params.toolNormalizationProtocol,
        turnChangeSet: normalizedTurnChangeSet,
        eventKind: event.kind,
        ...(params.admission === undefined ? {} : { admission: params.admission }),
      });
    }
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

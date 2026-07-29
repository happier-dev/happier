import { RuntimeEventV1Schema, type SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import {
  normalizeEphemeralSendOutcome,
  type EphemeralSendResult,
} from '@/api/session/client/transcript/ephemeralSendOutcome';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

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
  }>) => Promise<unknown>;
}>;

type AgentMessageCommitResult = Readonly<{
  persisted: boolean;
  delivered: boolean;
}>;

type RuntimeTranscriptProjectionSession = Readonly<{
  sessionId: string;
  sendUserTextMessage: (
    text: string,
    opts?: Readonly<{ localId?: string; meta?: Record<string, unknown> }>,
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
  ) => Promise<void>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: Readonly<{ localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 }>,
  ) => Promise<AgentMessageCommitResult>;
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
      | 'transcript-user-text'
      | 'transcript-agent-message-committed';
  }>
  | Readonly<{
    projected: false;
    reason: 'unsupported_event' | 'session_mismatch' | 'ephemeral_not_accepted';
  }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readACPMessageData(value: unknown): ACPMessageData | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  return value as ACPMessageData;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readRuntimeMessageDeltaText(value: unknown): string | null {
  const directText = readString(value);
  if (directText) return directText;
  if (!isRecord(value)) return null;

  const content = isRecord(value.content) ? value.content : null;
  return readString(value.text)
    ?? readString(value.textDelta)
    ?? readString(value.deltaText)
    ?? readString(value.message)
    ?? readString(content?.text)
    ?? readString(content?.textDelta);
}

function isThinkingRuntimeMessageDelta(value: unknown): boolean {
  return isRecord(value) && value.thinking === true;
}

function buildUserTextOptions(event: Readonly<{
  localId?: string;
  meta?: Record<string, unknown>;
}>): Readonly<{ localId?: string; meta?: Record<string, unknown> }> | undefined {
  if (!event.localId && !event.meta) return undefined;
  return {
    ...(event.localId ? { localId: event.localId } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
}

function buildRuntimeToolLocalId(event: Readonly<{
  sessionId: string;
  turnId: string;
  sidechainId?: string;
  toolCallId: string;
  localId?: string;
}>, kind: 'tool-call' | 'tool-result'): string {
  if (event.localId) return event.localId;
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

async function commitAgentMessage(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
  provenance: SessionTranscriptObservationProvenanceV1;
}>): Promise<void> {
  const opts = {
    localId: params.localId,
    ...(params.meta ? { meta: params.meta } : {}),
    provenance: params.provenance,
  };
  if (params.session.enqueueAgentMessageCommitted) {
    await params.session.enqueueAgentMessageCommitted(params.provider, params.body, opts);
  } else {
    await params.session.sendAgentMessageCommitted(params.provider, params.body, opts);
  }
}

export async function projectRuntimeTranscriptEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider?: ACPProvider;
  runtimeMessageDeltaBridge?: RuntimeMessageDeltaBridge;
  event: unknown;
}>): Promise<RuntimeTranscriptProjectionResult> {
  const parsed = RuntimeEventV1Schema.safeParse(params.event);
  if (!parsed.success) {
    return { projected: false, reason: 'unsupported_event' };
  }
  const event = parsed.data;
  if (event.sessionId !== params.session.sessionId) {
    return { projected: false, reason: 'session_mismatch' };
  }
  if (event.kind === 'message-delta') {
    const deltaText = readRuntimeMessageDeltaText(event.delta);
    if (!params.runtimeMessageDeltaBridge || deltaText === null) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const appendDelta = isThinkingRuntimeMessageDelta(event.delta)
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
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await params.runtimeMessageDeltaBridge.flushAll({ reason: 'tool-call-boundary' });
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-call');
    await commitAgentMessage({
      session: params.session,
      provider: params.provider,
      localId,
      body: {
        type: 'tool-call',
        callId: event.toolCallId,
        name: event.toolName,
        input: buildProjectedToolInput(event.toolInput, event.toolSnapshot),
        id: localId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      meta: buildRuntimeToolMeta(event, 'tool-call', isRecord(event.toolSnapshot)),
      provenance: { kind: 'non_dependent', source: event.sidechainId ? 'sidechain' : 'external' },
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'tool-result') {
    if (!params.provider) {
      return { projected: false, reason: 'unsupported_event' };
    }
    const localId = buildRuntimeToolLocalId(event, 'tool-result');
    await commitAgentMessage({
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
    });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-complete') {
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await params.runtimeMessageDeltaBridge.flushAll({ reason: 'turn-end' });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'turn-failed' || event.kind === 'turn-cancelled') {
    if (!params.runtimeMessageDeltaBridge) {
      return { projected: false, reason: 'unsupported_event' };
    }
    await params.runtimeMessageDeltaBridge.flushAll({ reason: 'abort', interruptedReason: event.kind });
    return { projected: true, kind: event.kind };
  }
  if (event.kind === 'transcript-user-text') {
    params.session.sendUserTextMessage(event.text, buildUserTextOptions(event));
    return { projected: true, kind: event.kind };
  }
  if (event.kind !== 'transcript-agent-message-committed') {
    return { projected: false, reason: 'unsupported_event' };
  }

  const body = readACPMessageData(event.body);
  if (!body) {
    return { projected: false, reason: 'unsupported_event' };
  }
  await commitAgentMessage({
    session: params.session,
    provider: event.agentId,
    body,
    localId: event.localId,
    ...(event.meta ? { meta: event.meta } : {}),
    provenance: { kind: 'non_dependent', source: 'external' },
  });
  return { projected: true, kind: event.kind };
}

import { RuntimeEventV1Schema } from '@happier-dev/protocol';

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
    opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
  ) => Promise<AgentMessageCommitResult>;
}>;

export type RuntimeTranscriptProjectionResult =
  | Readonly<{
    projected: true;
    kind:
      | 'message-delta'
      | 'tool-call'
      | 'tool-result'
      | 'turn-complete'
      | 'turn-failed'
      | 'turn-cancelled'
      | 'transcript-user-text'
      | 'transcript-agent-message-committed';
  }>
  | Readonly<{ projected: false; reason: 'unsupported_event' | 'session_mismatch' }>;

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
  turnId: string;
  toolCallId: string;
}>, kind: 'tool-call' | 'tool-result'): string {
  return `${event.turnId}:${event.toolCallId}:${kind}`;
}

function buildRuntimeToolMeta(event: Readonly<{
  turnId: string;
}>, kind: 'tool-call' | 'tool-result'): Record<string, unknown> {
  return {
    source: 'runtime',
    runtimeEventKind: kind,
    runtimeTurnId: event.turnId,
  };
}

async function commitAgentMessage(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
}>): Promise<void> {
  const opts = {
    localId: params.localId,
    ...(params.meta ? { meta: params.meta } : {}),
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
        input: event.toolInput,
        id: localId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      },
      meta: buildRuntimeToolMeta(event, 'tool-call'),
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
      meta: buildRuntimeToolMeta(event, 'tool-result'),
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
  });
  return { projected: true, kind: event.kind };
}

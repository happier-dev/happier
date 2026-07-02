import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

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
  | Readonly<{ projected: true; kind: 'transcript-user-text' | 'transcript-agent-message-committed' }>
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

export async function projectRuntimeTranscriptEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  event: unknown;
}>): Promise<RuntimeTranscriptProjectionResult> {
  const parsed = RuntimeEventV1Schema.safeParse(params.event);
  if (!parsed.success) {
    return { projected: false, reason: 'unsupported_event' };
  }
  const event = parsed.data;
  if (
    event.kind !== 'transcript-user-text'
    && event.kind !== 'transcript-agent-message-committed'
  ) {
    return { projected: false, reason: 'unsupported_event' };
  }
  if (event.sessionId !== params.session.sessionId) {
    return { projected: false, reason: 'session_mismatch' };
  }
  if (event.kind === 'transcript-user-text') {
    params.session.sendUserTextMessage(event.text, buildUserTextOptions(event));
    return { projected: true, kind: event.kind };
  }

  const body = readACPMessageData(event.body);
  if (!body) {
    return { projected: false, reason: 'unsupported_event' };
  }
  const opts = {
    localId: event.localId,
    ...(event.meta ? { meta: event.meta } : {}),
  };
  if (params.session.enqueueAgentMessageCommitted) {
    await params.session.enqueueAgentMessageCommitted(event.provider, body, opts);
  } else {
    await params.session.sendAgentMessageCommitted(event.provider, body, opts);
  }
  return { projected: true, kind: event.kind };
}

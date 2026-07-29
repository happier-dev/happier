import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import type { HostExternalTranscriptFollowEvent, HostExternalTranscriptItem } from './privateContract';

export type ExternalSessionTerminalRuntimeEventProjectionResult =
  | Readonly<{ projected: true }>
  | Readonly<{ projected: false; reason: string }>;

export type ExternalSessionTerminalFollowProjector = (
  event: HostExternalTranscriptFollowEvent,
) => Promise<void>;

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function toRuntimeTranscriptEvent(params: Readonly<{
  sessionId: string;
  agentId: string;
  item: HostExternalTranscriptItem;
}>): RuntimeEventV1 | null {
  if (params.item.kind === 'user') {
    // The managed host already owns committed user rows. Native transcript user
    // records are correlation echoes and must not create a second transcript row.
    return null;
  }
  if (
    params.item.timestampMs === undefined
    || !Number.isSafeInteger(params.item.timestampMs)
    || params.item.timestampMs < 0
  ) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  const data = asRecord(params.item.data);
  const type = typeof data?.type === 'string' ? data.type.trim() : '';
  if (!data || type.length === 0) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  let body: JsonRecord = data;
  if (params.item.kind === 'agent' && type === 'text') {
    const text = typeof data.text === 'string' ? data.text : null;
    if (text === null) {
      throw new Error('external_session_terminal_transcript_item_invalid');
    }
    body = Object.freeze({ type: 'message', message: text });
  }
  const bodyRole = resolveTranscriptBodySessionMessageRole({
    protocol: 'acp',
    body,
  });
  if (
    params.item.kind === 'agent'
      ? bodyRole !== 'agent'
      : bodyRole === 'unknown'
  ) {
    if (bodyRole === 'unknown' && params.item.kind !== 'agent') return null;
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  if (params.item.kind !== 'agent' && bodyRole !== 'event') {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  return Object.freeze({
    kind: 'transcript-agent-message-committed',
    sessionId: params.sessionId,
    emittedAtMs: params.item.timestampMs,
    agentId: params.agentId,
    localId: params.item.id,
    body,
  });
}

export function createExternalSessionTerminalFollowProjector(params: Readonly<{
  sessionId: string;
  agentId: string;
  projectRuntimeEvent(
    event: RuntimeEventV1,
  ): Promise<ExternalSessionTerminalRuntimeEventProjectionResult>;
}>): ExternalSessionTerminalFollowProjector {
  return async (event) => {
    if (event.kind !== 'data') return;
    for (const item of event.items) {
      const runtimeEvent = toRuntimeTranscriptEvent({
        sessionId: params.sessionId,
        agentId: params.agentId,
        item,
      });
      if (!runtimeEvent) continue;
      const result = await params.projectRuntimeEvent(runtimeEvent);
      if (!result.projected) {
        throw new Error('external_session_terminal_transcript_projection_rejected');
      }
    }
  };
}

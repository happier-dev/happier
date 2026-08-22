import { resolveTranscriptBodySemanticEvent } from '@happier-dev/protocol';
import {
  AgentSessionRuntimeEventSchema,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/protocol/runtime';

import type { HostExternalTranscriptFollowEvent, HostExternalTranscriptItem } from './privateContract';

export type ExternalSessionTerminalRuntimeEventProjectionResult =
  | Readonly<{ projected: true }>
  | Readonly<{ projected: false; reason: string }>;

export type ExternalSessionTerminalFollowProjectionAdmission = Readonly<{
  signal: AbortSignal;
  deadlineAtMs?: number;
}>;

export type ExternalSessionTerminalFollowProjector = (
  event: HostExternalTranscriptFollowEvent,
  admission?: ExternalSessionTerminalFollowProjectionAdmission,
) => Promise<void>;

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseRuntimeTranscriptEvent(value: unknown): AgentSessionRuntimeEvent {
  const parsed = AgentSessionRuntimeEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  return parsed.data;
}

function toRuntimeTranscriptEvent(params: Readonly<{
  sessionId: string;
  agentId: string;
  item: HostExternalTranscriptItem;
  phase?: 'initial_replay';
  sequence: number;
}>): AgentSessionRuntimeEvent | null {
  if (
    params.item.timestampMs === undefined
    || !Number.isSafeInteger(params.item.timestampMs)
    || params.item.timestampMs < 0
  ) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  const raw = asRecord(params.item.data);
  const content = asRecord(raw?.content);
  if (params.item.kind === 'user') {
    if (!raw || raw.role !== 'user' || content?.type !== 'text' || typeof content.text !== 'string') {
      throw new Error('external_session_terminal_transcript_item_invalid');
    }
    if (params.item.userProjection === 'host_prompt_echo') {
      return null;
    }
    if (
      params.item.userProjection === undefined
      || (
        params.item.userProjection === 'source_fact'
        && params.phase !== 'initial_replay'
      )
    ) {
      throw new Error('external_session_terminal_transcript_item_invalid');
    }
    if (
      params.item.userProjection !== 'source_fact'
      && params.item.userProjection !== 'terminal_origin'
    ) {
      throw new Error('external_session_terminal_transcript_item_invalid');
    }
    if (!params.item.localId || params.item.localId.trim().length === 0) {
      throw new Error('external_session_terminal_transcript_item_invalid');
    }
    return parseRuntimeTranscriptEvent({
      kind: 'transcript-message-committed',
      sequence: params.sequence,
      sessionId: params.sessionId,
      emittedAtMs: params.item.timestampMs,
      messageId: params.item.localId,
      role: 'user',
      text: content.text,
    });
  }
  if (!raw || raw.role !== 'agent' || !content) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  const semanticEvent = resolveTranscriptBodySemanticEvent({
    protocol: 'acp',
    body: content,
  });
  if (!semanticEvent) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  const bodyRole = semanticEvent.role;
  if (params.item.kind === 'agent' && bodyRole !== 'agent') {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  if (params.item.kind !== 'agent' && bodyRole !== 'event') {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  const body = asRecord(semanticEvent.body);
  if (!body) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  if (body.type === 'tool-call') {
    return parseRuntimeTranscriptEvent({
      kind: 'tool-call',
      sequence: params.sequence,
      sessionId: params.sessionId,
      emittedAtMs: params.item.timestampMs,
      turnId: body.callId,
      toolCallId: body.callId,
      toolName: body.name,
      input: body.input,
      ...(Object.hasOwn(body, 'sidechainId') ? { sidechainId: body.sidechainId } : {}),
    });
  }
  if (body.type === 'tool-result' || body.type === 'tool-call-result') {
    return parseRuntimeTranscriptEvent({
      kind: 'tool-result',
      sequence: params.sequence,
      sessionId: params.sessionId,
      emittedAtMs: params.item.timestampMs,
      turnId: body.callId,
      toolCallId: body.callId,
      output: body.output,
      ...(Object.hasOwn(body, 'isError') ? { isError: body.isError } : {}),
      ...(Object.hasOwn(body, 'sidechainId') ? { sidechainId: body.sidechainId } : {}),
    });
  }
  const text = (body.type === 'message' || body.type === 'reasoning')
    && typeof body.message === 'string'
    ? body.message
    : body.type === 'thinking' && typeof body.text === 'string'
      ? body.text
      : null;
  if (text === null) {
    throw new Error('external_session_terminal_transcript_item_invalid');
  }
  return parseRuntimeTranscriptEvent({
    kind: 'transcript-message-committed',
    sequence: params.sequence,
    sessionId: params.sessionId,
    emittedAtMs: params.item.timestampMs,
    messageId: params.item.localId ?? params.item.id,
    role: body.type === 'message' ? 'assistant' : 'reasoning',
    text,
    ...(Object.hasOwn(body, 'sidechainId') ? { sidechainId: body.sidechainId } : {}),
  });
}

export function createExternalSessionTerminalFollowProjector(params: Readonly<{
  sessionId: string;
  agentId: string;
  projectRuntimeEvent(
    event: AgentSessionRuntimeEvent,
    admission?: ExternalSessionTerminalFollowProjectionAdmission,
  ): Promise<ExternalSessionTerminalRuntimeEventProjectionResult>;
}>): ExternalSessionTerminalFollowProjector {
  let sequence = 0;
  return async (event, admission) => {
    if (event.kind !== 'data') return;
    for (const item of event.items) {
      const runtimeEvent = toRuntimeTranscriptEvent({
        sessionId: params.sessionId,
        agentId: params.agentId,
        item,
        sequence: sequence + 1,
        ...(event.phase ? { phase: event.phase } : {}),
      });
      if (!runtimeEvent) continue;
      const result = await params.projectRuntimeEvent(runtimeEvent, admission);
      if (!result.projected) {
        throw new Error('external_session_terminal_transcript_projection_rejected');
      }
      sequence = runtimeEvent.sequence;
    }
  };
}

import {
  AgentExternalSessionTranscriptRawRecordSchema,
  type AgentExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  mapOpenCodeMessageToTranscriptItem,
} from '../../../runtime/server/transcript/indexedTranscript.js';
import {
  isTerminalOpenCodeToolPartStatus,
} from '../../../runtime/server/foregroundToolTracker.js';
import { readOpenCodeToolPart } from '../../../runtime/server/state.js';
import { buildOpenCodeToolResultOutput } from '../../../runtime/server/toolEvents.js';
import { classifyOpenCodeMessageForProjection } from '../../../runtime/server/transcript/projection/index.js';

export type OpenCodeExternalSessionMessageProjection =
  | Readonly<{
      disposition: 'mapped';
      items: readonly AgentExternalSessionTranscriptItem[];
    }>
  | Readonly<{
      disposition: 'known_non_transcript' | 'unsupported';
      items: readonly [];
    }>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readPartType(part: unknown): string {
  const value = asRecord(part)?.type;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildSemanticItemId(params: Readonly<{
  providerSessionId: string;
  messageId: string;
  callId: string;
  kind: 'tool-call' | 'tool-result';
}>): string {
  const base = `opencode:${encodeURIComponent(params.providerSessionId)}:${encodeURIComponent(params.messageId)}`;
  return `${base}:${params.kind}:${encodeURIComponent(params.callId)}`;
}

function createToolEventItem(params: Readonly<{
  id: string;
  createdAtMs: number;
  data: unknown;
}>): AgentExternalSessionTranscriptItem | null {
  const parsed = AgentExternalSessionTranscriptRawRecordSchema.safeParse({
    role: 'agent',
    content: {
      type: 'acp',
      agentId: 'opencode',
      data: params.data,
    },
  });
  if (!parsed.success) return null;
  return {
    id: params.id,
    localId: params.id,
    createdAtMs: params.createdAtMs,
    messageRole: 'event',
    raw: parsed.data,
  };
}

function projectOpenCodeToolPart(params: Readonly<{
  part: unknown;
  providerSessionId: string;
  messageId: string;
  createdAtMs: number;
}>): readonly AgentExternalSessionTranscriptItem[] | null {
  const toolPart = readOpenCodeToolPart(params.part);
  if (!toolPart) return null;

  const callId = buildSemanticItemId({
    providerSessionId: params.providerSessionId,
    messageId: params.messageId,
    callId: toolPart.callID,
    kind: 'tool-call',
  });
  const call = createToolEventItem({
    id: callId,
    createdAtMs: params.createdAtMs,
    data: {
      type: 'tool-call',
      callId: toolPart.callID,
      name: toolPart.tool,
      input: toolPart.state.input ?? {},
      id: callId,
    },
  });
  if (!call) return null;
  if (!isTerminalOpenCodeToolPartStatus(toolPart.state.status)) return [call];

  const resultId = buildSemanticItemId({
    providerSessionId: params.providerSessionId,
    messageId: params.messageId,
    callId: toolPart.callID,
    kind: 'tool-result',
  });
  const result = createToolEventItem({
    id: resultId,
    createdAtMs: params.createdAtMs,
    data: {
      type: 'tool-result',
      callId: toolPart.callID,
      output: buildOpenCodeToolResultOutput(toolPart),
      id: resultId,
      ...(toolPart.state.status === 'completed' ? {} : { isError: true }),
    },
  });
  return result ? [call, result] : null;
}

/**
 * External history is more faithful than the live/direct text projector: a
 * single accepted OpenCode message may carry both its text and several tool
 * lifecycle facts. Reasoning remains deliberately non-transcript content.
 */
export function projectOpenCodeExternalSessionMessage(
  message: unknown,
  providerSessionId: string,
): OpenCodeExternalSessionMessageProjection {
  const record = asRecord(message);
  const messageProjection = classifyOpenCodeMessageForProjection(message);
  if (
    messageProjection.kind === 'compaction_internal'
    || messageProjection.kind === 'ignored_internal'
  ) {
    return { disposition: 'known_non_transcript', items: [] };
  }
  if (
    messageProjection.kind !== 'user_transcript'
    && messageProjection.kind !== 'assistant_transcript'
  ) {
    return { disposition: 'unsupported', items: [] };
  }

  const items: AgentExternalSessionTranscriptItem[] = [];
  const textItem = mapOpenCodeMessageToTranscriptItem(message, providerSessionId);
  if (textItem) {
    items.push({
      ...textItem,
      messageRole: messageProjection.kind === 'user_transcript' ? 'user' : 'agent',
    });
  }

  const parts = Array.isArray(record?.parts) ? record.parts : [];
  for (const part of parts) {
    const partType = readPartType(part);
    if (partType === 'tool') {
      if (messageProjection.kind !== 'assistant_transcript' || !messageProjection.messageId) {
        return { disposition: 'unsupported', items: [] };
      }
      const toolItems = projectOpenCodeToolPart({
        part,
        providerSessionId,
        messageId: messageProjection.messageId,
        createdAtMs: messageProjection.createdAtMs,
      });
      if (!toolItems) return { disposition: 'unsupported', items: [] };
      items.push(...toolItems);
      continue;
    }
    // Reasoning is deliberately hidden. Text/step parts are represented by
    // the existing canonical text projection above; internal flags are already
    // excluded there and are safe to advance past.
    if (partType === 'reasoning' || partType === 'text' || partType === 'step') continue;
    if (asRecord(part) && (asRecord(part)?.synthetic === true || asRecord(part)?.ignored === true || asRecord(part)?.internal === true)) {
      continue;
    }
    return { disposition: 'unsupported', items: [] };
  }

  return items.length > 0
    ? { disposition: 'mapped', items }
    : { disposition: 'known_non_transcript', items: [] };
}

export function mapOpenCodeMessageToExternalSessionItems(
  message: unknown,
  providerSessionId: string,
): readonly AgentExternalSessionTranscriptItem[] {
  return projectOpenCodeExternalSessionMessage(message, providerSessionId).items;
}

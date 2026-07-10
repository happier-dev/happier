import { randomUUID } from 'node:crypto';

import type {
  RuntimeOutboundTranscriptDispatchFacetV1,
  RuntimeOutboundTranscriptDispatchInputV1,
  RuntimeOutboundTranscriptDispatchPlanV1,
  RuntimeOutboundTranscriptPostSendEffectV1,
  RuntimeOutboundTranscriptToolTraceEventV1,
  SessionMessageRole,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { buildUsageObservationEffect } from '@happier-dev/plugin-sdk/usage';

import { buildClaudeAssistantUsageObservation } from '../usage/buildAssistantObservation.js';
import { buildClaudeSdkResultUsageObservation } from '../usage/buildSdkResultObservation.js';
import {
  RawJSONLinesSchema,
  type RawJSONLines,
} from './rawJsonLines.js';
import { isClaudeInternalTranscriptMessage } from './visibility.js';
import { buildClaudeTaskWorkStatePostSendEffect } from './workState.js';

type CliMessageMeta = Readonly<Record<string, unknown> & {
  sentFrom: 'cli';
  source: 'cli';
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildCliMessageMeta(meta?: Record<string, unknown>): CliMessageMeta {
  return {
    sentFrom: 'cli',
    source: 'cli',
    ...(meta && typeof meta === 'object' ? meta : {}),
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSidechainId(body: unknown): string | null {
  return readNonEmptyString(asRecord(body)?.sidechainId);
}

function buildUserTextMessageContent(text: string, meta?: Record<string, unknown>) {
  return {
    role: 'user',
    content: { type: 'text', text },
    meta: buildCliMessageMeta(meta),
  } as const;
}

function buildClaudeJsonlLocalId(
  body: unknown,
  sidechainId: string | null,
  randomId: () => string,
): string {
  const record = asRecord(body);
  const type = readNonEmptyString(record?.type) ?? 'unknown';
  const rawId = (() => {
    if (type === 'summary') {
      return readNonEmptyString(record?.leafUuid) ?? '';
    }
    return readNonEmptyString(record?.uuid) ?? '';
  })();
  if (!rawId) return randomId();
  const chain = sidechainId ?? 'main';
  return `claude-jsonl:${chain}:${type}:${rawId}`;
}

function readClaudeContent(body: unknown): unknown {
  return asRecord(asRecord(body)?.message)?.content;
}

function contentBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function readType(value: unknown): string | null {
  return readNonEmptyString(asRecord(value)?.type);
}

function hasToolBlock(content: unknown): boolean {
  return contentBlocks(content).some((block) => {
    const type = readType(block);
    return type === 'tool_use' || type === 'tool_result';
  });
}

function hasTextBlock(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return contentBlocks(content).some((block) => {
    const record = asRecord(block);
    return record?.type === 'text' && typeof record.text === 'string' && record.text.trim().length > 0;
  });
}

function isInternalClaudeTranscriptBody(body: unknown): boolean {
  const parsed = RawJSONLinesSchema.safeParse(body);
  return parsed.success && isClaudeInternalTranscriptMessage(parsed.data);
}

function resolveClaudeMessageRole(body: unknown): SessionMessageRole {
  if (isInternalClaudeTranscriptBody(body)) return 'event';
  const type = readNonEmptyString(asRecord(body)?.type);
  if (type === 'user') {
    const content = readClaudeContent(body);
    if (hasToolBlock(content)) return 'event';
    return hasTextBlock(content) ? 'user' : 'event';
  }
  if (type === 'assistant') {
    const content = readClaudeContent(body);
    return hasTextBlock(content) ? 'agent' : 'event';
  }
  if (type === 'summary' || type === 'system' || type === 'progress') {
    return 'event';
  }
  return 'unknown';
}

function redactClaudeToolPayload(value: unknown, key?: string): unknown {
  const redactKeys = new Set([
    'content',
    'text',
    'old_string',
    'new_string',
    'oldContent',
    'newContent',
  ]);

  if (typeof value === 'string') {
    if (key && redactKeys.has(key)) return `[redacted ${value.length} chars]`;
    if (value.length <= 1_000) return value;
    return `${value.slice(0, 1_000)}...(truncated ${value.length - 1_000} chars)`;
  }

  if (typeof value !== 'object' || value === null) return value;

  if (Array.isArray(value)) {
    const sliced = value.slice(0, 50).map((item) => redactClaudeToolPayload(item));
    if (value.length <= 50) return sliced;
    return [...sliced, `...(truncated ${value.length - 50} items)`];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  const sliced = entries.slice(0, 200);
  for (const [entryKey, entryValue] of sliced) {
    out[entryKey] = redactClaudeToolPayload(entryValue, entryKey);
  }
  if (entries.length > 200) out._truncatedKeys = entries.length - 200;
  return out;
}

function buildClaudeToolTraceEvents(body: unknown): RuntimeOutboundTranscriptToolTraceEventV1[] {
  const contentBlocksValue = readClaudeContent(body);
  if (!Array.isArray(contentBlocksValue)) return [];

  const events: RuntimeOutboundTranscriptToolTraceEventV1[] = [];
  for (const block of contentBlocksValue) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === 'tool_use') {
      const id = readNonEmptyString(record.id);
      const name = readNonEmptyString(record.name);
      if (!id || !name) continue;
      events.push({
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-call',
        payload: {
          type: 'tool_use',
          id,
          name,
          input: redactClaudeToolPayload(record.input),
        },
      });
      continue;
    }
    if (record.type === 'tool_result') {
      const toolUseId = readNonEmptyString(record.tool_use_id);
      if (!toolUseId) continue;
      events.push({
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-result',
        payload: {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: redactClaudeToolPayload(record.content, 'content'),
        },
      });
    }
  }
  return events;
}

function buildContent(body: unknown, meta?: Record<string, unknown>) {
  if (isInternalClaudeTranscriptBody(body)) {
    return {
      role: 'agent',
      content: {
        type: 'output',
        data: body,
      },
      meta: buildCliMessageMeta(meta),
    } as const;
  }
  const record = asRecord(body);
  const message = asRecord(record?.message);
  if (
    record?.type === 'user'
    && typeof message?.content === 'string'
    && record.isSidechain !== true
    && record.isMeta !== true
  ) {
    return buildUserTextMessageContent(message.content, meta);
  }

  return {
    role: 'agent',
    content: {
      type: 'output',
      data: body,
    },
    meta: buildCliMessageMeta(meta),
  } as const;
}

export function createClaudeOutboundTranscriptDispatchFacet(): RuntimeOutboundTranscriptDispatchFacetV1 {
  let activeModelId: string | null = null;
  return Object.freeze({
    prepareDispatch(input: RuntimeOutboundTranscriptDispatchInputV1): RuntimeOutboundTranscriptDispatchPlanV1 {
      const parsedBody = RawJSONLinesSchema.safeParse(input.body);
      const validBody = parsedBody.success ? parsedBody.data : null;
      const body = validBody ?? input.body;
      const bodyRecord = asRecord(body);
      const bodyType = readNonEmptyString(bodyRecord?.type);
      const sidechainId = readSidechainId(body);
      const now = input.now ?? Date.now;
      const randomId = input.randomId ?? randomUUID;
      const localId = buildClaudeJsonlLocalId(body, sidechainId, randomId);
      const postSendEffects: RuntimeOutboundTranscriptPostSendEffectV1[] = [];

      if (validBody?.type === 'assistant' && validBody.message?.usage) {
        activeModelId = readNonEmptyString(validBody.message.model) ?? activeModelId;
        const observation = buildClaudeAssistantUsageObservation({
          modelId: typeof validBody.message.model === 'string' ? validBody.message.model : null,
          usage: validBody.message.usage,
        });
        if (observation) {
          postSendEffects.push(buildUsageObservationEffect({ observation, externalKey: localId }));
        }
      }

      if (bodyType === 'result') {
        const resultModelId = readNonEmptyString(input.meta?.modelId) ?? activeModelId;
        const observation = resultModelId
          ? buildClaudeSdkResultUsageObservation({
            modelId: resultModelId,
            result: body,
            observedAtMs: now(),
          })
          : null;
        const sessionId = readNonEmptyString(bodyRecord?.session_id ?? bodyRecord?.sessionId);
        const resultMessageId = readNonEmptyString(bodyRecord?.uuid ?? bodyRecord?.id);
        if (observation && sessionId && resultMessageId) {
          postSendEffects.push(buildUsageObservationEffect({
            observation,
            externalKey: `claude:${sessionId}:result:${resultMessageId}`,
          }));
        }
      }

      if (validBody?.type === 'summary') {
        postSendEffects.push({
          type: 'metadataField',
          fieldId: 'display.title',
          value: {
            title: validBody.summary,
            updatedAt: now(),
          },
          reason: 'reconciliation',
          metadataReason: 'mirror_claude_summary',
        });
      }

      const taskWorkStateEffect = buildClaudeTaskWorkStatePostSendEffect(input);
      if (taskWorkStateEffect) {
        postSendEffects.push(taskWorkStateEffect);
      }

      const content = buildContent(body, input.meta);

      return {
        content,
        localId,
        sidechainId,
        messageRole: resolveClaudeMessageRole(body),
        logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
        outboundShapeLogs: [
          { label: 'claude:raw-jsonl', payload: body },
          { label: 'claude:session-content', payload: content },
        ],
        debugLargeJsonLogs: [{
          message: '[SOCKET] Sending message through socket:',
          data: content,
        }],
        disconnectedLog: {
          context: 'Claude session message',
          details: { type: bodyType },
        },
        ...(postSendEffects.length > 0 ? { postSendEffects } : {}),
        toolTraceEvents: buildClaudeToolTraceEvents(body),
      };
    },
  });
}

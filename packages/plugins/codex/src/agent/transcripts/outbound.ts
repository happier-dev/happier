import { randomUUID } from 'node:crypto';

import type {
  RuntimeOutboundTranscriptDispatchFacetV1,
  RuntimeOutboundTranscriptDispatchInputV1,
  RuntimeOutboundTranscriptDispatchPlanV1,
  RuntimeOutboundTranscriptPostSendEffectV1,
  RuntimeOutboundTranscriptToolTraceEventV1,
} from '@happier-dev/agents';
import type { SessionMessageRole } from '@happier-dev/protocol';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

type CliMessageMeta = Readonly<Record<string, unknown> & {
  sentFrom: 'cli';
  source: 'cli';
}>;

const CODEX_EVENT_TYPES = new Set([
  'tool-call',
  'tool-call-result',
  'tool-result',
  'token_count',
  'reasoning',
  'agent_reasoning',
  'thinking',
  'task_started',
  'task_complete',
  'turn_failed',
  'turn_cancelled',
  'turn_aborted',
  'context-compaction',
  'permission-request',
  'file-edit',
  'terminal-output',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildCliMessageMeta(meta?: Record<string, unknown>): CliMessageMeta {
  return {
    sentFrom: 'cli',
    source: 'cli',
    ...(meta && typeof meta === 'object' ? meta : {}),
  };
}

function getToolCallNameKey(provider: string, callId: string): string {
  return `${provider}:${callId}`;
}

function resolveCodexSessionMessageRole(body: unknown): SessionMessageRole {
  const record = asRecord(body);
  const type = readNonEmptyString(record?.type);
  if (type === 'message' || type === 'agent_message') {
    return readNonEmptyString(record?.role) === 'user' ? 'user' : 'agent';
  }
  if (type && CODEX_EVENT_TYPES.has(type)) return 'event';
  return 'unknown';
}

function normalizeCodexSessionMessageBody(input: RuntimeOutboundTranscriptDispatchInputV1): unknown {
  const body = input.body;
  const record = asRecord(body);
  if (!record) return body;

  if (record.type === 'tool-call') {
    const callId = readNonEmptyString(record.callId) ?? undefined;
    const rawToolName = String(record.name ?? '');
    const normalized = input.toolNormalization?.normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: rawToolName,
      rawInput: record.input,
      callId,
    });
    if (!normalized) return body;
    if (callId) {
      input.toolCallCanonicalNameByProviderAndId?.set(getToolCallNameKey('codex', callId), {
        rawToolName,
        canonicalToolName: normalized.canonicalToolName,
      });
    }
    return {
      ...record,
      name: normalized.canonicalToolName,
      input: normalized.input,
    };
  }

  if (record.type === 'tool-call-result') {
    const callId = readNonEmptyString(record.callId) ?? undefined;
    const mapping = callId
      ? input.toolCallCanonicalNameByProviderAndId?.get(getToolCallNameKey('codex', callId))
      : undefined;
    if (callId && !mapping) {
      input.debug?.('[Codex] Received tool-call-result without prior tool-call mapping (callId mismatch?)', {
        callId,
        type: record.type,
      });
    }
    const output = input.toolNormalization?.normalizeToolResultV2({
      protocol: 'codex',
      provider: 'codex',
      rawToolName: mapping?.rawToolName ?? 'unknown',
      canonicalToolName: mapping?.canonicalToolName ?? 'Unknown',
      rawOutput: record.output,
    });
    return {
      ...record,
      ...(output !== undefined ? { output } : {}),
    };
  }

  return body;
}

function resolveBackendMode(metadata: unknown): string | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const providerExtra = asRecord(descriptor?.provider.providerExtra);
  const runtimeHandle = asRecord(providerExtra?.runtimeHandle);
  return readNonEmptyString(runtimeHandle?.backendMode)
    ?? readNonEmptyString(descriptor?.provider.backendMode);
}

function resolveExternalKey(params: Readonly<{
  body: unknown;
  fallbackLocalId: string;
}>): string | null {
  const record = asRecord(params.body);
  return readNonEmptyString(record?.key)
    ?? readNonEmptyString(record?.id)
    ?? readNonEmptyString(params.fallbackLocalId);
}

function buildToolTraceEvents(body: unknown): RuntimeOutboundTranscriptToolTraceEventV1[] {
  const record = asRecord(body);
  const type = readNonEmptyString(record?.type);
  if (type !== 'tool-call' && type !== 'tool-call-result') return [];
  return [{
    protocol: 'codex',
    provider: 'codex',
    kind: type,
    payload: body,
  }];
}

export function createCodexOutboundTranscriptDispatchFacet(): RuntimeOutboundTranscriptDispatchFacetV1 {
  return Object.freeze({
    prepareDispatch(input: RuntimeOutboundTranscriptDispatchInputV1): RuntimeOutboundTranscriptDispatchPlanV1 {
      const normalizedBody = normalizeCodexSessionMessageBody(input);
      const normalizedRecord = asRecord(normalizedBody);
      const localId = (input.randomId ?? randomUUID)();
      const backendMode = resolveBackendMode(input.metadata);
      const externalKey = resolveExternalKey({
        body: normalizedBody,
        fallbackLocalId: localId,
      });
      const postSendEffects: RuntimeOutboundTranscriptPostSendEffectV1[] = [];

      if (normalizedRecord?.type === 'token_count') {
        postSendEffects.push({
          type: 'tokenCountUsageObservation',
          provider: 'codex',
          body: normalizedBody,
          backendMode,
          externalKey,
        });
      }

      return {
        content: {
          role: 'agent',
          content: {
            type: 'codex',
            data: normalizedBody,
          },
          meta: buildCliMessageMeta(input.meta),
        },
        localId,
        sidechainId: null,
        messageRole: resolveCodexSessionMessageRole(normalizedBody),
        logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
        outboundShapeLogs: [{
          label: 'codex:normalized',
          payload: normalizedBody,
        }],
        disconnectedLog: {
          context: 'Codex message',
          details: { type: normalizedRecord?.type },
        },
        ...(postSendEffects.length > 0 ? { postSendEffects } : {}),
        toolTraceEvents: buildToolTraceEvents(normalizedBody),
      };
    },
  });
}

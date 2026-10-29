import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

import type { OpenCodeGlobalEvent } from './types';
import { asRecord, normalizeString, readOpenCodeEventIdentity } from './openCodeParsing';

type ContextCompactionTrigger = 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
type ContextCompactionPhase = 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';

export type OpenCodeCompactionAgentMessage = ACPMessageData & {
  type: 'context-compaction';
  phase: ContextCompactionPhase;
  lifecycleId: string;
  providerSessionId: string;
  source: 'provider-event' | 'provider-status' | 'provider-hook' | 'transcript-inference' | 'runtime' | 'user-command';
  trigger: ContextCompactionTrigger;
};

const OPENCODE_COMPACTION_EVENT_TYPES = new Set([
  'session.next.compaction.started',
  'session.next.compaction.delta',
  'session.next.compaction.ended',
  'session.compacted',
]);

function normalizeTrigger(value: unknown): ContextCompactionTrigger {
  const raw = normalizeString(value).trim().toLowerCase();
  if (raw === 'manual' || raw === 'auto' || raw === 'threshold' || raw === 'overflow') return raw;
  return 'unknown';
}

function readCompactionId(props: Record<string, unknown>): string {
  return (
    normalizeString(props.messageID)
    || normalizeString(props.compactionID)
    || normalizeString(props.compactionId)
    || normalizeString(props.compaction_id)
    || normalizeString(props.id)
    || normalizeString(props.eventID)
    || normalizeString(props.eventId)
  ).trim();
}

function readErrorPreview(props: Record<string, unknown>): string {
  const rawError = props.error;
  if (typeof rawError === 'string') return rawError.trim();
  const errorRecord = asRecord(rawError);
  return (
    normalizeString(errorRecord?.message)
    || normalizeString(errorRecord?.error)
    || normalizeString(props.errorMessage)
  ).trim();
}

export function mapOpenCodeCompactionEventToAgentMessage(
  evt: OpenCodeGlobalEvent,
  expectedSessionId: string | null,
): OpenCodeCompactionAgentMessage | null {
  if (!expectedSessionId) return null;

  const type = normalizeString(evt.payload.type).trim();
  if (!OPENCODE_COMPACTION_EVENT_TYPES.has(type)) return null;

  const props = asRecord(evt.payload.properties);
  if (!props) return null;

  const providerSessionId = readOpenCodeEventIdentity(type, props)?.sessionId ?? '';
  if (!providerSessionId || providerSessionId !== expectedSessionId) return null;

  const providerEventId = readCompactionId(props);
  const lifecycleId = providerEventId
    ? `opencode:context-compaction:${providerSessionId}:${providerEventId}`
    : `opencode:context-compaction:${providerSessionId}`;
  const trigger = normalizeTrigger(props.reason ?? props.trigger);
  const errorPreview = readErrorPreview(props);
  const failed = type === 'session.next.compaction.ended' && Boolean(errorPreview);
  const cancelled = type === 'session.next.compaction.ended' && props.aborted === true && !failed;

  return {
    type: 'context-compaction',
    phase: type === 'session.next.compaction.started'
      ? 'started'
      : type === 'session.next.compaction.delta'
        ? 'progress'
        : cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
    provider: 'opencode',
    source: 'provider-event',
    trigger,
    lifecycleId,
    providerSessionId,
    ...(providerEventId ? { providerEventId } : {}),
    ...(errorPreview ? { sanitizedErrorPreview: errorPreview } : {}),
  };
}

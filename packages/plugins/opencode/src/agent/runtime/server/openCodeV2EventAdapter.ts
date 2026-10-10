import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { projectOpenCodeV2Form, type OpenCodeV2FormProjection } from './openCodeV2Forms.js';

/**
 * Adapts the released OpenCode V2 (v2.0.15) event vocabulary onto the internal event shape the
 * runtime already consumes. Upstream definitions live in `packages/schema/src/session-event.ts`,
 * `permission.ts`, `form.ts` and `event.ts` at tag v2.0.15.
 *
 * The earlier V2 preview published `session.next.*`, `permission.v2.asked` and
 * `question.v2.asked`; none of those types exist in the release. Everything is translated here so
 * the runtime keeps one provider-agnostic vocabulary and no second decision-maker appears in core.
 */
export type OpenCodeV2NormalizedEvent = Readonly<{
  type: string;
  properties: unknown;
  /** Present when the frame carried a form that the client must remember to answer it later. */
  formProjection?: OpenCodeV2FormProjection;
}>;

/** Wire envelope marker emitted once at a durable log read's replay watermark. */
export const OPEN_CODE_V2_LOG_SYNCED_EVENT_TYPE = 'log.synced';

type StreamKind = 'text' | 'reasoning';

/**
 * V2 identifies a streamed part by `(assistantMessageID, ordinal)`; the preview used a standalone
 * `textID`/`reasoningID`. Synthesizing a stable part id keeps the runtime's part bookkeeping and
 * accumulation keys working unchanged.
 */
function buildPartId(kind: StreamKind, data: Record<string, unknown>): string {
  const assistantMessageID = readNonBlankOpaqueIdentifier(data.assistantMessageID) ?? '';
  const ordinal = typeof data.ordinal === 'number' && Number.isFinite(data.ordinal) ? String(data.ordinal) : '0';
  return assistantMessageID ? `${assistantMessageID}:${kind}:${ordinal}` : '';
}

function streamEvent(kind: StreamKind, suffix: string, data: Record<string, unknown>): OpenCodeV2NormalizedEvent {
  const partId = buildPartId(kind, data);
  return {
    type: `session.next.${kind}.${suffix}`,
    properties: { ...data, ...(partId ? { [kind === 'text' ? 'textID' : 'reasoningID']: partId } : {}) },
  };
}

function deltaEvent(kind: StreamKind, data: Record<string, unknown>): OpenCodeV2NormalizedEvent {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: buildPartId(kind, data),
      delta: data.delta,
      // The producer states the part kind so a live delta never has to wait for the durable
      // `*.started` frame that carries it on the other stream.
      partType: kind,
    },
  };
}

/**
 * `Permission.Request` renamed every field Happier's permission owner reads, and its tool source
 * is `{ type, messageID, id }` rather than `{ messageID, callID }`.
 */
export function normalizeOpenCodeV2PermissionRequest(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const source = asRecord(record.source) ?? asRecord(record.tool);
  const callID = source ? normalizeString(source.callID) || normalizeString(source.id) : '';
  const messageID = source ? normalizeString(source.messageID) : '';
  return {
    id: record.id,
    sessionID: record.sessionID,
    permission: record.action,
    patterns: Array.isArray(record.resources) ? record.resources : [],
    metadata: asRecord(record.metadata) ?? {},
    always: Array.isArray(record.save) ? record.save : [],
    ...(normalizeString(record.message) ? { message: record.message } : {}),
    ...(messageID && callID ? { tool: { messageID, callID } } : {}),
  };
}

export function normalizeOpenCodeV2Event(type: string, rawData: unknown): OpenCodeV2NormalizedEvent {
  const data = asRecord(rawData);

  if (type === 'permission.asked') {
    return { type: 'permission.asked', properties: normalizeOpenCodeV2PermissionRequest(rawData) };
  }

  if (type === 'form.created') {
    const projection = projectOpenCodeV2Form(data?.form);
    if (projection) {
      return { type: 'question.asked', properties: projection.request, formProjection: projection };
    }
    return { type, properties: rawData };
  }

  if (!data) return { type, properties: rawData };

  switch (type) {
    case 'session.created':
      return { type, properties: { sessionID: data.sessionID, info: { ...data, id: data.sessionID } } };
    case 'session.text.started':
      return streamEvent('text', 'started', data);
    case 'session.text.delta':
      return deltaEvent('text', data);
    case 'session.text.ended':
      return streamEvent('text', 'ended', data);
    case 'session.reasoning.started':
      return streamEvent('reasoning', 'started', data);
    case 'session.reasoning.delta':
      return deltaEvent('reasoning', data);
    case 'session.reasoning.ended':
      return streamEvent('reasoning', 'ended', data);

    // Execution lifecycle replaced the preview's single `session.next.execution.settled` frame.
    case 'session.execution.started':
      return { type: 'session.status', properties: { sessionID: data.sessionID, status: { type: 'busy' } } };
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return { type: 'session.idle', properties: { sessionID: data.sessionID,
        executionOutcome: type === 'session.execution.succeeded' ? 'succeeded' : 'interrupted',
        ...(data.reason === undefined ? {} : { interruptionReason: data.reason }) } };
    case 'session.execution.failed':
      return {
        type: 'session.error',
        properties: { sessionID: data.sessionID, executionOutcome: 'failed', error: data.error ?? { message: 'OpenCode V2 execution failed' } },
      };

    case 'session.retry.scheduled':
      return { type: 'session.next.retried', properties: { ...data, next: data.at } };

    // The canonical compaction owner (`openCodeCompactionEvents.ts`) already understands this
    // vocabulary; a failure is an ended phase carrying an error.
    case 'session.compaction.started':
      return { type: 'session.next.compaction.started', properties: data };
    case 'session.compaction.delta':
      return { type: 'session.next.compaction.delta', properties: data };
    case 'session.compaction.ended':
      return { type: 'session.next.compaction.ended', properties: data };
    case 'session.compaction.failed':
      return { type: 'session.next.compaction.ended', properties: data };

    default:
      break;
  }

  if (type.startsWith('session.step.')) {
    return { type: `session.next.step.${type.slice('session.step.'.length)}`, properties: data };
  }
  if (type.startsWith('session.tool.')) {
    return { type: `session.next.tool.${type.slice('session.tool.'.length)}`, properties: data };
  }

  return { type, properties: rawData };
}

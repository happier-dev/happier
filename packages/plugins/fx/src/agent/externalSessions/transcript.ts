import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createExternalSessionContentSearchControl, createExternalSessionUnsupportedTranscriptItem, readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';

import { fxFile, fxSessionDir, FxSourceError, isFxRecord as isRecord, readFxMetadata } from './source.js';
import { fxImageUnavailable, readFxImageSourceWitness, readFxToolImages, readFxUserImages } from './images.js';

export type FxTranscriptRow = Readonly<{ item: AgentExternalSessionTranscriptItem & Readonly<{ createdAtMs: number }>; text?: string; unsupported?: true;
  images?: unknown; imageWitness?: string; partial?: boolean; imageUnavailableItem?: AgentExternalSessionTranscriptItem;
  result?: Readonly<{ handle: string; callId: string; failed: boolean; imageHandle?: unknown }> }>;

// Exact v0.0.14 ConversationEvent payload fields. Unknown fields may carry
// new branch/content meaning and cannot be silently treated as old frames.
const FRAME_FIELDS = new Set(['schema_version', 'seq', 'timestamp_ms', 'event']);
const EVENT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(Object.entries({
  user: ['text', 'images', 'work_id'],
  assistant: ['text', 'provider_replay', 'standalone_response'],
  steering: ['text'],
  tool_call: ['call_id', 'tool_name', 'arguments_json', 'argument_integrity', 'provisional_id', 'provider_result', 'final_identity', 'provenance'],
  tool_result: ['call_id', 'tool_name', 'status', 'artifact_ref', 'tool_image_handle', 'output_bytes', 'stored_bytes', 'completeness',
    'preview', 'provider_native', 'review_feedback', 'created_at_ms', 'permission_feedback', 'committed_file_presentation',
    'command_replay_ref', 'command_replay_bytes', 'command_process_presentation', 'terminal_action_presentation'],
  context_checkpoint: ['covers_through_seq', 'summary'],
  turn_completed: ['files', 'turn_summary'],
  interrupted: ['reason', 'partial_text', 'command_replay_ref', 'command_replay_bytes', 'command_artifact_ref', 'files', 'turn_summary', 'cancellation_origin'],
}).map(([kind, fields]) => [kind, new Set(fields)]));

class FxReplayYield extends Error {}

function textRow(seq: number, createdAtMs: number, text: string, user = false): FxTranscriptRow {
  return { text, item: { id: `fx:${seq}`, createdAtMs, messageRole: user ? 'user' : 'agent',
    raw: user ? { role: 'user', content: { type: 'text', text } }
      : { role: 'agent', content: { type: 'acp', agentId: 'fx', data: { type: 'message', message: text } } } } };
}

function toolRow(seq: number, createdAtMs: number, data: Readonly<Record<string, unknown>>): FxTranscriptRow {
  const raw = AgentExternalSessionTranscriptRawRecordSchema.safeParse({ role: 'agent',
    content: { type: 'acp', agentId: 'fx', data: { ...data, id: `fx:${seq}` } } });
  if (!raw.success) return { unsupported: true,
    item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'fx', id: `fx:${seq}`, createdAtMs }) };
  return { item: { id: `fx:${seq}`, createdAtMs, messageRole: 'event', raw: raw.data } };
}

/** Read-only counterpart of v0.0.14 ConversationHistoryReader, not model-context replay.
 * Completed turns survive context checkpoints; an unfinished writer tail does not.
 * The SDK scanner owns JSONL framing/UTF-8 and releases each source record immediately.
 */
export async function readFxTranscript(root: string, id: string, signal: AbortSignal,
  scanBounds: Readonly<{ deadlineAtMs?: number; resumeAfterSeq?: number }> = {}) {
  await readFxMetadata(root, id);
  const dir = await fxSessionDir(root, id);
  const path = await fxFile(dir, 'events.jsonl');
  const before = await stat(path);
  const items: FxTranscriptRow[] = [];
  let pending: FxTranscriptRow[] = [];
  let pendingAssistant: FxTranscriptRow | null = null;
  let stepRows: { callId: string; row: FxTranscriptRow }[] = [];
  const results = new Map<string, FxTranscriptRow>();
  const calls = new Map<string, string>();
  let open = false;
  let partial = false;
  let lastSeq = 0;
  let checkpointCoverage = 0;
  let throughSeq = 0;
  let yielded = false;
  const unsupported = (seq: number, createdAtMs: number) => {
    partial = true;
    (open ? pending : items).push({ item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'fx', id: `fx:unsupported:${seq}`, createdAtMs }) });
  };
  const flushAssistant = () => {
    if (pendingAssistant?.text) pending.push(pendingAssistant);
    pendingAssistant = null;
  };
  const scan = await readJsonlFileForwardLines({ filePath: path, offsetBytes: 0,
    // Freeze the scanner's byte boundary, not the vendor file. New committed
    // turns written during this read belong to the next read-after invocation.
    fileSystem: { ...createExternalSessionContentSearchControl({ signal }).fileSystem, stat: async () => before },
    // Native file length bounds this operation; no guessed transcript cap.
    maxBytes: Math.max(1, before.size), maxItems: Math.max(1, before.size),
    maxOversizeLineBytes: Math.max(1, before.size),
    onDiagnostic: () => { partial = true; },
    onLine(line) {
      signal.throwIfAborted();
      // The vendor treats an unterminated frame as an unfinished writer tail,
      // even when its current prefix happens to be valid JSON.
      if (line.endOffsetBytes === before.size) { partial = true; return; }
      const frame = line.value;
      if (!isRecord(frame) || !Number.isSafeInteger(frame.seq) || Number(frame.seq) !== lastSeq + 1
        || Object.keys(frame).some(key => !FRAME_FIELDS.has(key))
        || typeof frame.schema_version !== 'number' || ![1, 2, 3].includes(frame.schema_version) || typeof frame.timestamp_ms !== 'number'
        || !Number.isSafeInteger(frame.timestamp_ms) || frame.timestamp_ms < 0
        || !isRecord(frame.event) || Object.keys(frame.event).length !== 1) {
        unsupported(lastSeq + 1, 0);
        if (isRecord(frame) && Number.isSafeInteger(frame.seq)) lastSeq = Number(frame.seq);
        return;
      }
      const seq = Number(frame.seq);
      lastSeq = seq;
      const [kind] = Object.keys(frame.event);
      const value = frame.event[kind!];
      const fields = EVENT_FIELDS[kind!];
      if (!isRecord(value) || !fields || Object.keys(value).some(key => !fields.has(key))) {
        unsupported(seq, frame.timestamp_ms); return;
      }
      const text = value.text;
      switch (kind) {
        case 'user': {
          if (open || typeof text !== 'string') { unsupported(seq, frame.timestamp_ms); break; }
          open = true;
          const images = value.images ?? [];
          pending = text || !Array.isArray(images) || images.length
            ? [{ ...textRow(seq, frame.timestamp_ms, text, true), images }] : [];
          break;
        }
        case 'assistant':
          if (!open || calls.size || typeof text !== 'string') { unsupported(seq, frame.timestamp_ms); break; }
          flushAssistant();
          pendingAssistant = textRow(seq, frame.timestamp_ms, text);
          if (value.standalone_response === true) flushAssistant();
          break;
        case 'steering':
          if (!open || calls.size || typeof text !== 'string') { unsupported(seq, frame.timestamp_ms); break; }
          flushAssistant();
          pending.push(textRow(seq, frame.timestamp_ms, text, true));
          break;
        case 'tool_call':
          if (!open || results.size || typeof value.call_id !== 'string' || typeof value.tool_name !== 'string' || calls.has(value.call_id)
            || typeof value.arguments_json !== 'string') {
            unsupported(seq, frame.timestamp_ms); break;
          }
          calls.set(value.call_id, value.tool_name);
          // Arguments remain native metadata, not searchable prose. The tool
          // lifecycle still reaches the transcript so output policy can apply.
          {
            let parsed: unknown;
            try { parsed = JSON.parse(value.arguments_json); } catch { unsupported(seq, frame.timestamp_ms); break; }
            stepRows.push({ callId: value.call_id,
              row: toolRow(seq, frame.timestamp_ms, { type: 'tool-call', callId: value.call_id, name: value.tool_name, input: parsed }) });
          }
          break;
        case 'tool_result': {
          if (!open || typeof value.call_id !== 'string' || calls.get(value.call_id) !== value.tool_name
            || typeof value.artifact_ref !== 'string' || !/^result-[A-Za-z0-9_-]+\.txt$/.test(value.artifact_ref)
            || !['complete', 'partial', 'unknown'].includes(String(value.completeness))
            || !['success', 'failure'].includes(String(value.status))) { unsupported(seq, frame.timestamp_ms); break; }
          if (value.completeness !== 'complete') partial = true;
          calls.delete(value.call_id);
          results.set(value.call_id, { ...toolRow(seq, frame.timestamp_ms, { type: 'tool-result', callId: value.call_id, output: '' }),
            result: { handle: value.artifact_ref, callId: value.call_id, failed: value.status === 'failure', imageHandle: value.tool_image_handle } });
          if (!calls.size) {
            flushAssistant();
            // ACP history pairs each completed result with its call in call
            // order, even when native results arrived in the opposite order.
            for (const call of stepRows) {
              pending.push(call.row);
              const result = results.get(call.callId);
              if (result) pending.push(result);
            }
            stepRows = [];
            results.clear();
          }
          break;
        }
        case 'context_checkpoint':
          if (calls.size || !Number.isSafeInteger(value.covers_through_seq) || Number(value.covers_through_seq) < checkpointCoverage
            || Number(value.covers_through_seq) >= seq || typeof value.summary !== 'string') {
            unsupported(seq, frame.timestamp_ms); break;
          }
          checkpointCoverage = Number(value.covers_through_seq);
          flushAssistant();
          break;
        case 'turn_completed':
        case 'interrupted':
          if (!open || results.size || (kind === 'turn_completed' && calls.size) || (kind === 'interrupted' && calls.size > 1)) {
            unsupported(seq, frame.timestamp_ms); break;
          }
          if (kind === 'interrupted' && calls.size) {
            // ConversationTurnBuilder discards the assistant associated with
            // an unfinished tool step; only settled prior steps are replayed.
            pendingAssistant = null;
            stepRows = [];
          }
          flushAssistant();
          if (kind === 'interrupted' && typeof value.partial_text === 'string' && value.partial_text) {
            pending.push(textRow(seq, frame.timestamp_ms, value.partial_text));
          }
          if (kind === 'interrupted') {
            if (value.reason !== 'cancelled' && value.reason !== 'failed') { unsupported(seq, frame.timestamp_ms); break; }
            const notice = textRow(seq, frame.timestamp_ms, value.reason);
            pending.push({ ...notice, item: { ...notice.item, id: `fx:${seq}:notice` } });
          }
          items.push(...pending);
          pending = [];
          open = false;
          calls.clear();
          throughSeq = seq;
          // A completed turn is the vendor's smallest committed replay unit.
          // Commit one new turn before yielding, including on a resumed page.
          if (seq > (scanBounds.resumeAfterSeq ?? 0) && scanBounds.deadlineAtMs !== undefined
            && Date.now() >= scanBounds.deadlineAtMs && line.endOffsetBytes + 1 < before.size) throw new FxReplayYield();
          break;
        default: unsupported(seq, frame.timestamp_ms);
      }
    },
  }).catch((error: unknown) => {
    if (!(error instanceof FxReplayYield)) throw error;
    yielded = true;
    return { truncated: false, reachedEnd: false };
  });
  if (!yielded && (scan.truncated || !scan.reachedEnd)) partial = true;
  signal.throwIfAborted();
  for (let index = 0; index < items.length; index++) {
    const row = items[index]!;
    const imageWitness = await readFxImageSourceWitness(dir, row.images, row.result?.imageHandle, signal);
    items[index] = { ...row, imageWitness };
    if (!row.result) continue;
    let body: string;
    try {
      const bytes = await readFile(await fxFile(dir, 'tool-results', row.result.handle));
      signal.throwIfAborted();
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      signal.throwIfAborted();
      body = '[Tool result unavailable]';
      partial = true;
    }
    const data = { type: 'tool-result', callId: row.result.callId, output: body, isError: row.result.failed };
    const hydrated = toolRow(Number(row.item.id.slice(3)), row.item.createdAtMs, data);
    items[index] = { ...hydrated, text: body, result: row.result, imageWitness };
  }
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size
    || (after.size === before.size && before.mtimeMs !== after.mtimeMs)) {
    throw new FxSourceError('source_invalid');
  }
  return { items, partial: partial || items.some(row => row.unsupported), complete: !yielded, throughSeq,
    hydrateRow: (row: FxTranscriptRow) => hydrateFxTranscriptRow(dir, row, signal),
    identity: `${before.dev}:${before.ino}:${before.birthtimeMs}` };
}

/** Only a demanded page/follow row opens its native image bodies. Search consumes the text index. */
async function hydrateFxTranscriptRow(dir: string, row: FxTranscriptRow, signal: AbortSignal): Promise<FxTranscriptRow> {
  if (row.images === undefined && !row.result) return row;
  const images = row.images !== undefined ? await readFxUserImages(dir, row.images, signal)
    : await readFxToolImages(dir, row.result!.imageHandle, signal);
  const body = row.text ?? '';
  const text = images.partial ? fxImageUnavailable(body) : body;
  const seq = Number(row.item.id.slice(3));
  const project = (text: string) => row.result
    ? toolRow(seq, row.item.createdAtMs, { type: 'tool-result', callId: row.result.callId, output: text, isError: row.result.failed })
    : textRow(seq, row.item.createdAtMs, text, true);
  const hydrated = project(text);
  return { ...hydrated, partial: images.partial,
    ...(images.media.length ? { item: { ...hydrated.item, raw: { ...hydrated.item.raw, media: images.media } },
      imageUnavailableItem: project(fxImageUnavailable(body)).item } : {}) };
}

/** A normalized prefix witness also catches same-size rewrites and sidecar-only edits. */
export function fxPrefix(rows: readonly FxTranscriptRow[], count: number): string {
  const digest = createHash('sha256');
  for (let index = 0; index < count; index++) {
    const row = rows[index]!;
    digest.update(JSON.stringify([row.item, row.images, row.result?.imageHandle, row.imageWitness]));
  }
  return digest.digest('base64url');
}

import { readFile, stat } from 'node:fs/promises';
import { isRecord } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem, readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { ExternalSessionContentSearchControl } from '@happier-dev/plugin-sdk/sessions/file-stores';

export type GeminiTranscript = Readonly<{
  sessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  title?: string;
  subagent: boolean;
  items: readonly AgentExternalSessionTranscriptItem[];
  partial: boolean;
}>;

export class UnsupportedGeminiTranscript extends Error {
  constructor(message: string, readonly sessionId?: string) { super(message); }
}

function time(value: unknown): number {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

/** Gemini's PartListUnion text projection, never a generic object stringify. */
function parts(value: unknown): { text: string; partial: boolean } {
  if (typeof value === 'string') return { text: value, partial: false };
  if (value === undefined || value === null) return { text: '', partial: true };
  const values = Array.isArray(value) ? value : [value];
  let partial = false;
  const text = values.map(part => {
    if (typeof part === 'string') return part;
    // @google/genai 1.30.0 Part, pinned by Gemini CLI v0.64.0.
    if (isRecord(part) && Object.keys(part).some(key => !['mediaResolution', 'codeExecutionResult', 'executableCode',
      'fileData', 'functionCall', 'functionResponse', 'inlineData', 'text', 'thought', 'thoughtSignature', 'videoMetadata'].includes(key))) partial = true;
    if (isRecord(part) && typeof part.text === 'string' && part.thought !== true) return part.text;
    // Characterized non-text Google GenAI parts are not transcript prose.
    if (isRecord(part) && (part.thought === true || 'inlineData' in part || 'fileData' in part || 'functionCall' in part)) return '';
    partial = true;
    return '';
  }).join('');
  return { text, partial };
}

export function geminiItemText(item: AgentExternalSessionTranscriptItem): string | null {
  if (item.raw.role === 'user') return item.raw.content.text;
  const content = item.raw.content;
  const data = isRecord(content) && isRecord(content.data) ? content.data : null;
  if (data?.type === 'message' && typeof data.message === 'string') return data.message;
  return data?.type === 'tool-result' && typeof data.output === 'string' ? data.output : null;
}

/** Replay the vendor v0.64.0 writer's patches, checkpoint and inclusive rewind.
 * Both native paging and search consume this one active-history projection. */
export async function readGeminiTranscript(filePath: string, signal: AbortSignal,
  control?: ExternalSessionContentSearchControl): Promise<GeminiTranscript> {
  signal.throwIfAborted();
  const info = await stat(filePath);
  let metadata: Record<string, unknown> = {};
  let partial = false;
  const messages = new Map<string, Record<string, unknown>>();
  const put = (value: unknown) => {
    control?.checkWork();
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') { partial = true; return; }
    if (Object.keys(value).some(key => !['id', 'timestamp', 'content', 'displayContent', 'type', 'toolCalls',
      'thoughts', 'tokens', 'model'].includes(key)) || typeof value.timestamp !== 'string') partial = true;
    messages.set(value.id, { ...value });
  };
  const patch = (value: unknown) => {
    control?.checkWork();
    if (!isRecord(value) || typeof value.id !== 'string') { partial = true; return; }
    if (Object.keys(value).some(key => !['id', 'content', 'toolCalls'].includes(key))) partial = true;
    const message = messages.get(value.id);
    if (!message) return;
    if ('content' in value) message.content = value.content;
    if (Array.isArray(value.toolCalls) && Array.isArray(message.toolCalls)) {
      const patches = value.toolCalls;
      if (patches.some(entry => !isRecord(entry) || Object.keys(entry).some(key => !['id', 'result'].includes(key)))) partial = true;
      message.toolCalls = message.toolCalls.map(tool => {
        if (!isRecord(tool)) { partial = true; return tool; }
        const update = patches.find(entry => isRecord(entry) && entry.id === tool.id);
        return isRecord(update) && 'result' in update ? { ...tool, result: update.result } : tool;
      });
    }
  };
  const consume = (value: unknown) => {
    signal.throwIfAborted();
    control?.checkWork();
    if (!isRecord(value)) { partial = true; return; }
    const allowed = '$rewindTo' in value ? ['$rewindTo'] : '$patch' in value ? ['$patch'] : '$set' in value ? ['$set']
      : typeof value.sessionId === 'string' ? ['sessionId', 'projectHash', 'startTime', 'lastUpdated', 'messages', 'summary', 'memoryScratchpad', 'directories', 'kind']
      : ['id', 'timestamp', 'content', 'displayContent', 'type', 'toolCalls', 'thoughts', 'tokens', 'model'];
    if (Object.keys(value).some(key => !allowed.includes(key))) partial = true;
    // This dialect has no version field. Do not interpret an explicitly
    // versioned future envelope as this unversioned vendor contract.
    if ('version' in value || 'schemaVersion' in value) throw new UnsupportedGeminiTranscript('Unknown Gemini recording dialect',
      typeof value.sessionId === 'string' ? value.sessionId : undefined);
    if (typeof value.$rewindTo === 'string') {
      const ids = [...messages.keys()];
      const index = ids.indexOf(value.$rewindTo);
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
    } else if (isRecord(value.$patch)) {
      const update = value.$patch;
      if (typeof update.id === 'string') patch(update);
      if (Array.isArray(update.updates)) for (const item of update.updates) patch(item);
      if (Array.isArray(update.removeIds)) for (const id of update.removeIds) { if (typeof id === 'string') messages.delete(id); else partial = true; }
      if (Array.isArray(update.orderIds)) {
        const ordered = update.orderIds.filter((id): id is string => typeof id === 'string' && messages.has(id));
        const suffix = ordered.map(id => [id, messages.get(id)!] as const);
        for (const id of ordered) messages.delete(id);
        for (const [id, message] of suffix) messages.set(id, message);
      }
      if (Object.keys(update).some(key => !['id', 'content', 'toolCalls', 'updates', 'removeIds', 'orderIds'].includes(key))) partial = true;
    } else if (isRecord(value.$set)) {
      const update = value.$set;
      if (Object.keys(update).some(key => !['sessionId', 'projectHash', 'startTime', 'lastUpdated', 'messages',
        'summary', 'memoryScratchpad', 'directories', 'kind'].includes(key))) partial = true;
      if (Array.isArray(update.messages)) { messages.clear(); for (const item of update.messages) put(item); }
      metadata = { ...metadata, ...update };
    } else if (typeof value.sessionId === 'string') {
      metadata = { ...metadata, ...value };
      if (Array.isArray(value.messages)) for (const item of value.messages) put(item);
    } else if (typeof value.id === 'string') put(value);
    else partial = true;
  };
  control?.checkWork();
  if (filePath.endsWith('.json')) {
    let value: unknown;
    try { value = JSON.parse(await readFile(filePath, { encoding: 'utf8', signal })); }
    catch { signal.throwIfAborted(); throw new UnsupportedGeminiTranscript('Unreadable legacy Gemini recording'); }
    if (!isRecord(value) || !Array.isArray(value.messages)) throw new UnsupportedGeminiTranscript('Unknown legacy Gemini recording');
    consume(value);
  } else {
    // Patches can invalidate earlier hits. Check the containing scan deadline
    // between native records and publish only a completely replayed history.
    // The SDK owns framing/UTF-8; the native file supplies the byte boundary.
    const bytes = Math.max(1, info.size);
    const page = await readJsonlFileForwardLines({ filePath, offsetBytes: 0, maxBytes: bytes, maxItems: bytes,
      maxOversizeLineBytes: bytes, onLine: line => consume(line.value) });
    partial ||= page.truncated || !page.reachedEnd || !!page.diagnostics?.length;
  }
  signal.throwIfAborted();
  if (typeof metadata.sessionId !== 'string' || typeof metadata.projectHash !== 'string') {
    throw new UnsupportedGeminiTranscript('Gemini session metadata is unsupported');
  }
  const createdAtMs = time(metadata.startTime) || info.birthtimeMs;
  const items: AgentExternalSessionTranscriptItem[] = [];
  for (const [id, message] of messages) {
    signal.throwIfAborted();
    control?.checkWork();
    const createdAt = time(message.timestamp) || createdAtMs;
    if (message.type === 'info' || message.type === 'error' || message.type === 'warning') continue;
    if (message.type !== 'user' && message.type !== 'gemini') {
      partial = true; items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'gemini', id, createdAtMs: createdAt })); continue;
    }
    const text = parts(message.displayContent ?? message.content);
    partial ||= text.partial;
    if (text.text) items.push({ id, createdAtMs: createdAt, messageRole: message.type === 'user' ? 'user' : 'agent',
      raw: message.type === 'user' ? { role: 'user', content: { type: 'text', text: text.text } }
        : { role: 'agent', content: { type: 'acp', agentId: 'gemini', data: { type: 'message', message: text.text } } } });
    if (text.partial) items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'gemini', id: `${id}:unsupported`, createdAtMs: createdAt }));
    if (message.type === 'gemini' && Array.isArray(message.toolCalls)) for (const tool of message.toolCalls) {
      if (!isRecord(tool) || typeof tool.id !== 'string') { partial = true; continue; }
      if (Object.keys(tool).some(key => !['id', 'name', 'args', 'result', 'status', 'timestamp', 'agentId', 'displayName',
        'description', 'resultDisplay', 'renderOutputAsMarkdown'].includes(key))) partial = true;
      if (tool.result === undefined || tool.result === null) continue;
      const output = parts(tool.result);
      partial ||= output.partial;
      if (output.text) items.push({ id: `${id}:tool:${tool.id}`, createdAtMs: time(tool.timestamp) || createdAt,
        raw: { role: 'agent', content: { type: 'acp', agentId: 'gemini',
          data: { type: 'tool-result', callId: tool.id, output: output.text, isError: tool.status === 'error' } } } });
    }
  }
  return { sessionId: metadata.sessionId, createdAtMs, updatedAtMs: time(metadata.lastUpdated) || info.mtimeMs,
    ...(typeof metadata.summary === 'string' ? { title: metadata.summary } : {}),
    subagent: metadata.kind === 'subagent', items, partial };
}

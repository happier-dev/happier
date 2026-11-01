import { readFile, stat } from 'node:fs/promises';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { ExternalSessionContentSearchControl } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { admittedPath, fingerprint, KimiStoreError, record, type KimiSession } from './source.js';

type Entry = {
  id: string; time: number; role: 'user' | 'assistant' | 'tool'; text: string;
  origin?: string; realPrompt: boolean; unsupported?: boolean; unsupportedContent?: boolean;
  calls: { id: string; name: string; input: string }[]; callId?: string; isError?: boolean;
};
const bookkeeping = new Set(['forked', 'turn.prompt', 'turn.steer', 'turn.cancel', 'config.update',
  'permission.set_mode', 'permission.record_approval_result', 'full_compaction.begin', 'full_compaction.cancel',
  'full_compaction.complete', 'micro_compaction.apply', 'plan_mode.enter', 'plan_mode.cancel', 'plan_mode.exit',
  'swarm_mode.enter', 'swarm_mode.exit', 'tools.register_user_tool', 'tools.unregister_user_tool',
  'tools.set_active_tools', 'tools.update_store', 'usage.record', 'goal.create', 'goal.update', 'goal.clear']);

/** Kimi Code 0.18.0 / protocol 1.4. Mirrors the vendor's full transcript, not its folded model context. */
export async function readKimiTranscript(session: KimiSession, signal: AbortSignal,
  control?: ExternalSessionContentSearchControl): Promise<Readonly<{
  items: AgentExternalSessionTranscriptItem[]; partial: boolean; identity: string;
}>> {
  signal.throwIfAborted();
  const path = await admittedPath(session.directory, session.wirePath);
  const before = await stat(path);
  control?.checkWork();
  const raw = await readFile(path, { encoding: 'utf8', signal });
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new KimiStoreError('source_invalid');
  const lines = raw.split('\n');
  const entries: Entry[] = [];
  const steps = new Map<string, Entry>();
  const pending = new Set<string>();
  const calls = new Set<string>();
  let deferred: Entry[] = [];
  let foldedLength = 0;
  let floor = 0;
  let partial = false;
  let metadata = false;
  const fieldsKnown = (value: Record<string, unknown>, keys: readonly string[]) => {
    if (Object.keys(value).some(key => !keys.includes(key))) partial = true;
  };
  const push = (entry: Entry) => { entries.push(entry); foldedLength++; };
  const flush = () => { if (!pending.size) { deferred.forEach(push); deferred = []; } };
  const reset = () => { steps.clear(); pending.clear(); deferred = []; };
  const text = (content: unknown): { text: string; unsupported: boolean } => {
    if (!Array.isArray(content)) { partial = true; return { text: '', unsupported: true }; }
    let unsupported = false;
    const body = content.map(part => {
      if (record(part) && part.type === 'text' && typeof part.text === 'string') {
        fieldsKnown(part, ['type', 'text']); return part.text;
      }
      if (record(part) && part.type === 'think' && typeof part.think === 'string') return '';
      partial = true;
      unsupported = true;
      return '';
    }).join('');
    return { text: body, unsupported };
  };
  for (let line = 0; line < lines.length; line++) {
    signal.throwIfAborted();
    control?.checkWork();
    const input = lines[line]!.trim();
    if (!input) continue;
    const id = `wire:${line + 1}`;
    let value: unknown;
    try { value = JSON.parse(input); }
    catch { partial = true; if (line === lines.length - 1) break; value = null; }
    const at = record(value) && typeof value.time === 'number' && Number.isFinite(value.time) ? value.time : session.createdAtMs ?? 0;
    const entry = (role: Entry['role'] = 'assistant'): Entry => ({ id, time: at, role, text: '', realPrompt: false, calls: [] });
    const unsupported = () => { partial = true; push({ ...entry(), unsupported: true }); };
    if (!record(value) || typeof value.type !== 'string') { unsupported(); continue; }
    if (value.type === 'metadata') {
      if (metadata || value.protocol_version !== '1.4') throw new KimiStoreError('unsupported');
      fieldsKnown(value, ['type', 'time', 'protocol_version', 'created_at']);
      metadata = true; continue;
    }
    if (!metadata) throw new KimiStoreError('unsupported');
    switch (value.type) {
      case 'context.append_message': {
        fieldsKnown(value, ['type', 'time', 'message']);
        const message = value.message;
        if (!record(message) || !['user', 'assistant', 'tool'].includes(String(message.role))) { unsupported(); break; }
        fieldsKnown(message, ['role', 'content', 'toolCalls', 'toolCallId', 'isError', 'origin']);
        const role = message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'assistant';
        const origin = record(message.origin) && typeof message.origin.kind === 'string' ? message.origin.kind : undefined;
        const body = text(message.content);
        const next: Entry = { ...entry(role), text: body.text, unsupportedContent: body.unsupported, origin,
          realPrompt: role === 'user' && (origin === undefined || origin === 'user'
            || origin === 'skill_activation' && record(message.origin) && message.origin.trigger === 'user-slash'),
          ...(typeof message.toolCallId === 'string' ? { callId: message.toolCallId } : {}),
          ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
        };
        if (Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) {
            if (!record(call) || typeof call.id !== 'string' || typeof call.name !== 'string') { partial = true; continue; }
            fieldsKnown(call, ['type', 'id', 'name', 'arguments']);
            next.calls.push({ id: call.id, name: call.name, input: typeof call.arguments === 'string' ? call.arguments : '' });
            calls.add(call.id);
          }
        }
        if (pending.size) deferred.push(next); else push(next);
        break;
      }
      case 'context.append_loop_event': {
        fieldsKnown(value, ['type', 'time', 'event']);
        const event = value.event;
        if (!record(event)) { unsupported(); break; }
        switch (event.type) {
          case 'step.begin': {
            fieldsKnown(event, ['type', 'uuid', 'turnId', 'step']);
            if (typeof event.uuid !== 'string') { unsupported(); break; }
            const next = entry(); push(next); steps.set(event.uuid, next); break;
          }
          case 'step.end':
            fieldsKnown(event, ['type', 'uuid', 'turnId', 'step', 'usage', 'finishReason', 'llmFirstTokenLatencyMs',
              'llmStreamDurationMs', 'providerFinishReason', 'rawFinishReason']);
            if (typeof event.uuid !== 'string' || !steps.delete(event.uuid)) { unsupported(); break; }
            flush(); break;
          case 'content.part': {
            fieldsKnown(event, ['type', 'uuid', 'turnId', 'step', 'stepUuid', 'part']);
            const step = typeof event.stepUuid === 'string' ? steps.get(event.stepUuid) : undefined;
            if (!step) { unsupported(); break; }
            const body = text([event.part]);
            step.text += body.text; step.unsupportedContent ||= body.unsupported; break;
          }
          case 'tool.call': {
            fieldsKnown(event, ['type', 'uuid', 'turnId', 'step', 'stepUuid', 'toolCallId', 'name', 'args', 'description', 'display']);
            const step = typeof event.stepUuid === 'string' ? steps.get(event.stepUuid) : undefined;
            if (!step || typeof event.toolCallId !== 'string' || typeof event.name !== 'string') { unsupported(); break; }
            step.calls.push({ id: event.toolCallId, name: event.name, input: JSON.stringify(event.args ?? null) });
            calls.add(event.toolCallId); pending.add(event.toolCallId); break;
          }
          case 'tool.result': {
            fieldsKnown(event, ['type', 'parentUuid', 'toolCallId', 'result']);
            if (typeof event.toolCallId !== 'string' || !calls.has(event.toolCallId) || !record(event.result)) { unsupported(); break; }
            fieldsKnown(event.result, ['output', 'isError', 'message']);
            const output = event.result.output;
            const body = typeof output === 'string' ? { text: output, unsupported: false } : text(output);
            push({ ...entry('tool'), callId: event.toolCallId,
              text: body.text, unsupportedContent: body.unsupported, isError: event.result.isError === true });
            pending.delete(event.toolCallId); flush(); break;
          }
          default: unsupported();
        }
        break;
      }
      case 'context.undo': {
        fieldsKnown(value, ['type', 'time', 'count']);
        if (!Number.isSafeInteger(value.count) || Number(value.count) < 0) { unsupported(); break; }
        if (value.count === 0) break;
        let removed = 0;
        for (let index = entries.length - 1; index >= floor; index--) {
          const message = entries[index]!;
          if (message.origin === 'injection') continue;
          if (message.origin === 'compaction_summary') break;
          entries.splice(index, 1); foldedLength = Math.max(0, foldedLength - 1);
          if (message.realPrompt && ++removed >= Number(value.count)) break;
        }
        reset(); break;
      }
      case 'context.apply_compaction': {
        fieldsKnown(value, ['type', 'time', 'compactedCount', 'summary', 'tokensBefore', 'tokensAfter']);
        if (!Number.isSafeInteger(value.compactedCount) || Number(value.compactedCount) < 0 || typeof value.summary !== 'string') { unsupported(); break; }
        const tail = Math.max(0, foldedLength - Number(value.compactedCount));
        entries.splice(Math.max(0, entries.length - tail), 0, { ...entry(), text: value.summary, origin: 'compaction_summary' });
        foldedLength = tail + 1; steps.clear(); flush(); break;
      }
      case 'context.clear': fieldsKnown(value, ['type', 'time']); floor = entries.length; foldedLength = 0; reset(); break;
      default: if (!bookkeeping.has(value.type)) unsupported();
    }
  }
  if (!metadata) throw new KimiStoreError('unsupported');
  const items: AgentExternalSessionTranscriptItem[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    control?.checkWork();
    if (entry.origin === 'injection') continue;
    if (entry.unsupported) {
      items.push(createExternalSessionUnsupportedTranscriptItem({ agentId: 'kimi', id: entry.id, createdAtMs: entry.time }));
      continue;
    }
    const base = { id: entry.id, createdAtMs: entry.time };
    if (entry.role === 'user') items.push({ ...base, messageRole: 'user', userProjection: 'source_fact',
      raw: { role: 'user', content: { type: 'text', text: entry.text } } });
    else if (entry.role === 'tool') items.push({ ...base, raw: { role: 'agent', content: {
      type: 'acp', agentId: 'kimi', data: { type: 'tool-result', callId: entry.callId ?? entry.id, output: entry.text, isError: entry.isError ?? false },
    } } });
    else if (entry.text) items.push({ ...base, messageRole: 'agent', raw: { role: 'agent', content: {
      type: 'acp', agentId: 'kimi', data: { type: 'message', message: entry.text },
    } } });
    for (const [index, call] of entry.calls.entries()) items.push({ ...base, id: `${entry.id}:call:${index}`, raw: {
      role: 'agent', content: { type: 'acp', agentId: 'kimi', data: { type: 'tool-call', callId: call.id, name: call.name, input: call.input } },
    } });
    if (entry.unsupportedContent) items.push(createExternalSessionUnsupportedTranscriptItem({
      agentId: 'kimi', id: `${entry.id}:unsupported`, createdAtMs: entry.time,
    }));
  }
  return { items, partial, identity: fingerprint([path, before.dev, before.ino, before.birthtimeMs]) };
}

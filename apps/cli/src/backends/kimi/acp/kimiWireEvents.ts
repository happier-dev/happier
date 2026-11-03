import type { ToolCallContent } from '@agentclientprotocol/sdk';
import { z } from 'zod';

import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { SessionUpdate } from '@/agent/acp/updates/types';

export type KimiWireEvent =
  | Readonly<{ kind: 'metadata'; version: string }>
  | Readonly<{ kind: 'turn-start'; turnId: string; originKind: string; taskId?: string }>
  | Readonly<{ kind: 'task'; taskId: string; parentToolCallId: string }>
  | Readonly<{
    kind: 'update'; turnId?: string; updates: SessionUpdate[];
    toolCallId?: string; toolCallUuid?: string; parentToolCallUuid?: string;
  }>
  | Readonly<{ kind: 'turn-end'; turnId: string; outcome: AcpTurnOutcome }>;

const identifier = z.string().refine(value => value.trim().length > 0);
const turnIdSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)]).transform(String);
const turnStartSchema = z.object({ turnId: turnIdSchema, origin: z.object({ kind: identifier, taskId: identifier.optional() }) });
const taskSchema = z.object({ info: z.object({ taskId: identifier, parentToolCallId: identifier, detached: z.literal(true) }) });
const turnEndSchema = z.object({
  turnId: turnIdSchema, reason: z.enum(['completed', 'cancelled', 'blocked', 'failed']),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});
const contentSchema = z.object({
  turnId: turnIdSchema,
  part: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('think'), think: z.string(), hidden: z.boolean().optional() }),
  ]),
});
const tokenCountSchema = z.number().finite().nonnegative();
const stepUsageSchema = z.object({ uuid: identifier, turnId: turnIdSchema, usage: z.object({
  inputOther: tokenCountSchema, output: tokenCountSchema,
  inputCacheRead: tokenCountSchema, inputCacheCreation: tokenCountSchema,
}) });
const toolCallSchema = z.object({ turnId: turnIdSchema, uuid: identifier, toolCallId: identifier, name: identifier, args: z.unknown(), display: z.unknown().optional() });
const toolResultSchema = z.object({
  parentUuid: identifier, toolCallId: identifier,
  result: z.object({ output: z.unknown(), isError: z.boolean().optional() }),
});
const diffSchema = z.object({ kind: z.enum(['diff', 'file_io']), path: identifier, before: z.string(), after: z.string() });
const planSchema = z.object({ kind: z.literal('todo_list'), items: z.array(z.object({
  title: identifier, status: z.enum(['pending', 'in_progress', 'done', 'completed']),
})).min(1) });
const planReviewSchema = z.object({ kind: z.literal('plan_review'), plan: identifier, path: identifier.optional() });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Omit native hidden-output markers before projecting tool content into the shared transcript representation. */
function textContent(value: unknown): ToolCallContent[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value) && value.some(part => asRecord(part)?.__kind === 'acp-hide-output')) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text ? [{ type: 'content', content: { type: 'text', text } }] : [];
}

/** Translate native loop records; turn admission stays with the source and step UUIDs identify usage reports. */
function decodeLoopEvent(event: Record<string, unknown>): KimiWireEvent | null {
  if (event.type === 'content.part') {
    const parsed = contentSchema.safeParse(event);
    if (!parsed.success) return null;
    const { part, turnId } = parsed.data;
    if (part.type === 'think' && part.hidden === true) return null;
    const text = part.type === 'text' ? part.text : part.think;
    return text ? { kind: 'update', turnId, updates: [{
      sessionUpdate: part.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
      content: { type: 'text', text },
    }] } : null;
  }
  if (event.type === 'step.end') {
    const parsed = stepUsageSchema.safeParse(event);
    if (!parsed.success) return null;
    const { uuid, turnId, usage } = parsed.data;
    // Usage reports replace by key: the persisted native step identity survives replay and resume.
    return { kind: 'update', turnId, updates: [{ sessionUpdate: 'usage_update', key: `kimi-step:${uuid}`,
      inputTokens: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
      outputTokens: usage.output, cacheReadTokens: usage.inputCacheRead, cacheWriteTokens: usage.inputCacheCreation,
    }] };
  }
  if (event.type === 'tool.call') {
    const parsed = toolCallSchema.safeParse(event);
    if (!parsed.success) return null;
    const { turnId, uuid, toolCallId, name, args, display } = parsed.data;
    const content = textContent(args);
    const diff = diffSchema.safeParse(display);
    if (diff.success) content.unshift({ type: 'diff', path: diff.data.path, oldText: diff.data.before, newText: diff.data.after });
    const review = planReviewSchema.safeParse(display);
    if (review.success) content.unshift(...textContent(review.data.path ? `Plan saved to: ${review.data.path}\n\n${review.data.plan}` : review.data.plan));
    const updates: SessionUpdate[] = [{ sessionUpdate: 'tool_call', toolCallId, title: name, status: 'in_progress', rawInput: args, content }];
    const plan = planSchema.safeParse(display);
    if (plan.success) updates.push({ sessionUpdate: 'plan', entries: plan.data.items.map(item => ({
      content: item.title, priority: 'medium', status: item.status === 'done' ? 'completed' : item.status,
    })) });
    return { kind: 'update', turnId, toolCallId, toolCallUuid: uuid, updates };
  }
  if (event.type === 'tool.result') {
    const parsed = toolResultSchema.safeParse(event);
    if (!parsed.success) return null;
    const { parentUuid, toolCallId, result } = parsed.data;
    return { kind: 'update', toolCallId, parentToolCallUuid: parentUuid, updates: [{
      sessionUpdate: 'tool_call_update', toolCallId, status: result.isError === true ? 'failed' : 'completed',
      rawOutput: result.output, content: textContent(result.output),
    }] };
  }
  return null;
}

/** Decode committed main-agent records; the reader owns admission and turn correlation. */
export function decodeKimiWireRecord(value: unknown): KimiWireEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.type === 'metadata') {
    const version = identifier.safeParse(record.protocol_version);
    return version.success ? { kind: 'metadata', version: version.data } : null;
  }
  if (record.agentId !== 'main') return null;
  if (record.type === 'turn.prompt') {
    const parsed = turnStartSchema.safeParse(record);
    if (!parsed.success) return null;
    const { turnId, origin } = parsed.data;
    if (origin.kind === 'task') return origin.taskId ? { kind: 'turn-start', turnId, originKind: origin.kind, taskId: origin.taskId } : null;
    return { kind: 'turn-start', turnId, originKind: origin.kind };
  }
  if (record.type === 'task.started') {
    const parsed = taskSchema.safeParse(record);
    return parsed.success ? { kind: 'task', taskId: parsed.data.info.taskId, parentToolCallId: parsed.data.info.parentToolCallId } : null;
  }
  if (record.type === 'turn.ended') {
    const parsed = turnEndSchema.safeParse(record);
    if (!parsed.success) return null;
    const { turnId, reason, error } = parsed.data;
    let outcome: AcpTurnOutcome;
    if (reason === 'completed') outcome = { kind: 'completed', stopReason: 'end_turn' };
    else if (reason === 'cancelled') outcome = { kind: 'aborted', stopReason: 'cancelled' };
    else if (reason === 'blocked' || error?.code === 'provider.filtered') outcome = { kind: 'refused', stopReason: 'refusal' };
    else outcome = { kind: 'failed', error: new Error(error?.message ?? 'Kimi background turn failed') };
    return { kind: 'turn-end', turnId, outcome };
  }
  if (record.type === 'context.append_loop_event') {
    const event = asRecord(record.event);
    if (!event) return null;
    try {
      return decodeLoopEvent(event);
    } catch {
      // Non-JSON caller input cannot be a persisted wire record.
      return null;
    }
  }
  return null;
}

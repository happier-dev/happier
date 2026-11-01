import { z } from 'zod';

import type { SessionWorkStateItemV1, SessionWorkStateStatusV1 } from '../../sessionWorkState/sessionWorkStateV1.js';
import { lazySchema } from '../../lazySchema.js';

const OPEN_CODE_TODO_ITEM_ID_PREFIX = 'todo:opencode:';

export const OpenCodeSessionTodoStatusSchema = lazySchema(() => z.string().min(1));
export const OpenCodeSessionTodoSchema = lazySchema(() => z
  .object({
    id: z.string().min(1).optional(),
    content: z.string().trim().min(1),
    status: OpenCodeSessionTodoStatusSchema,
    priority: z.string().min(1).optional(),
  })
  .passthrough());
export type OpenCodeSessionTodo = z.infer<typeof OpenCodeSessionTodoSchema>;

function normalizeOpenCodeTodoStatus(status: string): SessionWorkStateStatusV1 {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'complete';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

function encodeItemIdPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOpenCodeTodoItemId(params: Readonly<{
  vendorRef?: string;
  content: string;
  index: number;
}>): string {
  if (params.vendorRef) {
    return `${OPEN_CODE_TODO_ITEM_ID_PREFIX}${encodeItemIdPart(params.vendorRef)}`;
  }
  return `${OPEN_CODE_TODO_ITEM_ID_PREFIX}derived:${encodeItemIdPart(`${params.content}|${params.index}`)}`;
}

export function normalizeOpenCodeSessionTodosToWorkStateItems(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: unknown;
}>): SessionWorkStateItemV1[] {
  const todos = Array.isArray(params.todos) ? params.todos : [];
  return todos.flatMap((todo, index): SessionWorkStateItemV1[] => {
    const parsed = OpenCodeSessionTodoSchema.safeParse(todo);
    if (!parsed.success) return [];
    const vendorRef = parsed.data.id;
    return [{
      id: buildOpenCodeTodoItemId({
        ...(vendorRef ? { vendorRef } : {}),
        content: parsed.data.content,
        index,
      }),
      kind: 'todo',
      origin: 'vendor',
      status: normalizeOpenCodeTodoStatus(parsed.data.status),
      title: parsed.data.content.trim(),
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(vendorRef ? { vendorRef } : {}),
      order: index,
      ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
      updatedAt: params.updatedAt,
    }];
  });
}

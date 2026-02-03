import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall, Message } from '@/sync/typesMessage';
import { t } from '@/text';
import { ICON_TODO } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { TodoResultV2Schema, TodoWriteInputV2Schema } from '@happier-dev/protocol';

export const coreTodoTools = {
    'TodoWrite': {
        title: t('tools.names.todoList'),
        icon: ICON_TODO,
        noStatus: true,
        minimal: (opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => {
            // Check if there are todos in the input
            if (opts.tool.input?.todos && Array.isArray(opts.tool.input.todos) && opts.tool.input.todos.length > 0) {
                return false; // Has todos, show expanded
            }

            // Check if there are todos in the result
            if (opts.tool.result?.todos && Array.isArray(opts.tool.result.todos) && opts.tool.result.todos.length > 0) {
                return false; // Has todos, show expanded
            }
            if (opts.tool.result?.newTodos && Array.isArray(opts.tool.result.newTodos) && opts.tool.result.newTodos.length > 0) {
                return false; // Has todos, show expanded
            }

            return true; // No todos, render as minimal
        },
        input: TodoWriteInputV2Schema,
        result: TodoResultV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const count =
                Array.isArray(opts.tool.input?.todos)
                    ? opts.tool.input.todos.length
                    : Array.isArray(opts.tool.result?.todos)
                        ? opts.tool.result.todos.length
                        : Array.isArray(opts.tool.result?.newTodos)
                            ? opts.tool.result.newTodos.length
                            : null;
            if (typeof count === 'number') return t('tools.desc.todoListCount', { count });
            return t('tools.names.todoList');
        },
    },
    'TodoRead': {
        title: t('tools.names.todoList'),
        icon: ICON_TODO,
        noStatus: true,
        minimal: true,
        result: TodoResultV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const list = Array.isArray(opts.tool.result?.todos) ? opts.tool.result.todos : null;
            if (list) {
                return t('tools.desc.todoListCount', { count: list.length });
            }
            return t('tools.names.todoList');
        },
    },
} satisfies Record<string, KnownToolDefinition>;

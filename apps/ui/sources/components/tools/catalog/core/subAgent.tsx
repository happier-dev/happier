import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall, Message } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import { ICON_TASK } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { SubAgentInputV2Schema, TaskInputV2Schema } from '@happier-dev/protocol';

const subAgentToolDefinition = {
        title: () => t('tools.names.subAgent'),
        icon: ICON_TASK,
        isMutable: true,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const raw = (opts.tool.input as any)?.description;
            const description = typeof raw === 'string' ? raw.trim() : '';
            return description.length > 0 ? description : null;
        },
        minimal: (opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => {
            // Check if there would be any filtered tasks
            const messages = opts.messages || [];
            for (let m of messages) {
                if (m.kind === 'tool-call' &&
                    (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error')) {
                    return false; // Has active sub-tasks, show expanded
                }
            }
            return true; // No active sub-tasks, render as minimal
        },
        input: SubAgentInputV2Schema,
    } satisfies KnownToolDefinition;

export const coreSubAgentTools = {
    'SubAgent': subAgentToolDefinition,
    'Task': { ...subAgentToolDefinition, input: TaskInputV2Schema },
} satisfies Record<string, KnownToolDefinition>;

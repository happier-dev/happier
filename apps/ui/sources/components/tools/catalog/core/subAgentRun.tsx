import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import { ICON_TASK } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { SubAgentRunInputV2Schema } from '@happier-dev/protocol';

export const coreSubAgentRunTools = {
    SubAgentRun: {
        title: () => t('tools.names.subAgent'),
        icon: ICON_TASK,
        isMutable: true,
        extractSubtitle: (opts: { metadata: Metadata | null; tool: ToolCall }) => {
            const input = opts.tool.input as any;
            const rawLabel = typeof input?.label === 'string' ? input.label : null;
            const label = rawLabel ? rawLabel.trim() : '';
            if (label) return label;

            const desc = typeof opts.tool.description === 'string' ? opts.tool.description.trim() : '';
            if (desc) return desc;

            const summary = typeof (opts.tool.result as any)?.summary === 'string' ? String((opts.tool.result as any).summary).trim() : '';
            if (summary) return summary;

            const intent = typeof input?.intent === 'string' ? input.intent.trim() : '';
            const backendId = typeof input?.backendId === 'string' ? input.backendId.trim() : '';
            if (intent && backendId) return `${intent} · ${backendId}`;
            if (intent) return intent;
            if (backendId) return backendId;

            return null;
        },
        input: SubAgentRunInputV2Schema,
    },
} satisfies Record<string, KnownToolDefinition>;

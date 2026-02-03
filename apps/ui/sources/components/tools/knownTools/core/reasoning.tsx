import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
import { ICON_REASONING } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { ReasoningInputV2Schema, ReasoningResultV2Schema } from '@happier-dev/protocol';

export const coreReasoningTools = {
    Reasoning: {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        icon: ICON_REASONING,
        minimal: true,
        input: ReasoningInputV2Schema,
        result: ReasoningResultV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
    },
} satisfies Record<string, KnownToolDefinition>;

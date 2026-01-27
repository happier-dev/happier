import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_REASONING } from '../icons';
import type { KnownToolDefinition } from '../_types';

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
        input: z.object({
            title: z.string().optional().describe('Optional title for the reasoning'),
        }).partial().loose(),
        result: z.object({
            content: z.string().optional().describe('Reasoning content (markdown)'),
            text: z.string().optional().describe('Reasoning text'),
            status: z.enum(['completed', 'in_progress', 'canceled', 'error']).optional(),
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
    },
} satisfies Record<string, KnownToolDefinition>;


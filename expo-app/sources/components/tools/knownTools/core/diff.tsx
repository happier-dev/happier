import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreDiffTools = {
    Diff: {
        title: t('tools.names.viewDiff'),
        icon: ICON_EDIT,
        minimal: false,
        hideDefaultError: true,
        noStatus: true,
        input: z.object({
            unified_diff: z.string().describe('Unified diff content'),
        }).partial().loose(),
        result: z.object({
            status: z.literal('completed').optional(),
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return null;
            const lines = diff.split('\n');
            for (const line of lines) {
                if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
                    const fileName = line.replace(/^\+\+\+ (b\/)?/, '');
                    const basename = fileName.split('/').pop() || fileName;
                    return basename;
                }
            }
            return null;
        },
        extractDescription: () => t('tools.desc.showingDiff'),
    },
} satisfies Record<string, KnownToolDefinition>;


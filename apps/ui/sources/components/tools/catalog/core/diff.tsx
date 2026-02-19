import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { DiffInputV2Schema } from '@happier-dev/protocol';
import { parseUnifiedDiffFilePaths } from '../parseUnifiedDiffFilePaths';

export const coreDiffTools = {
    Diff: {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return t('tools.names.viewDiff');
            const paths = parseUnifiedDiffFilePaths(diff);
            return paths.length > 1 ? t('tools.names.turnDiff') : t('tools.names.viewDiff');
        },
        icon: ICON_EDIT,
        minimal: false,
        hideDefaultError: true,
        noStatus: true,
        input: DiffInputV2Schema,
        result: z.object({
            status: z.literal('completed').optional(),
        }).partial().passthrough(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return null;

            const paths = parseUnifiedDiffFilePaths(diff);
            if (paths.length !== 1) return null;

            const filePath = paths[0]!;
            const basename = filePath.split('/').pop() || filePath;
            return basename;
        },
        extractDescription: () => t('tools.desc.showingDiff'),
    },
} satisfies Record<string, KnownToolDefinition>;

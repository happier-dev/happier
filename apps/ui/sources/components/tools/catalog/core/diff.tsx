import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import * as z from 'zod';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { DiffInputV2Schema } from '@happier-dev/protocol';
import { resolveDiffToolHeaderPresentation } from '../resolveDiffToolHeaderPresentation';

export const coreDiffTools = {
    Diff: {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).title;
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
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).subtitle;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).description;
        },
    },
} satisfies Record<string, KnownToolDefinition>;

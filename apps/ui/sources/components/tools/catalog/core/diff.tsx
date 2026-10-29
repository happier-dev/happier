import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import * as z from 'zod/mini';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { DiffInputV2Schema } from '@happier-dev/protocol/tools/v2/schemas';
import { resolveDiffToolHeaderPresentation } from '../resolveDiffToolHeaderPresentation';

export const coreDiffTools = {
    Diff: {
        title: createKnownToolTitle("Diff"),
        icon: ICON_EDIT,
        minimal: false,
        hideDefaultError: true,
        noStatus: true,
        input: DiffInputV2Schema,
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            status: z.optional(z.literal('completed')),
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).subtitle;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).description;
        },
    },
} satisfies Record<string, KnownToolDefinition>;

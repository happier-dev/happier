import { createKnownToolTitle } from '../toolTitles';
import * as z from 'zod/mini';

import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerUiTools = {
    'change_title': {
        title: createKnownToolTitle("change_title"),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            title: z.optional(z.string()).check(z.describe('New session title'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({})))
    },
    WorkspaceIndexingPermission: {
        title: createKnownToolTitle("WorkspaceIndexingPermission"),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            toolCall: z.optional(z.partial(z.object({
                title: z.optional(z.string()),
                toolCallId: z.optional(z.string()),
            }))),
            options: z.optional(z.array(z.partial(z.object({
                id: z.optional(z.string()),
                name: z.optional(z.string()),
                kind: z.optional(z.string()),
            })))),
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({}))),
    },
} satisfies Record<string, KnownToolDefinition>;

import { createKnownToolTitle } from '../toolTitles';
import * as z from 'zod/mini';

import { ICON_SEARCH } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerSearchTools = {
    // Gemini internal tools - should be hidden (minimal)
    'search': {
        title: createKnownToolTitle("search"),
        icon: ICON_SEARCH,
        minimal: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            items: z.optional(z.array(z.any())),
            locations: z.optional(z.array(z.any()))
        })))
    },
} satisfies Record<string, KnownToolDefinition>;


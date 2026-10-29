import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import * as z from 'zod/mini';
import { t } from '@/text';
import { ICON_REASONING } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerReasoningTools = {
    'CodexReasoning': {
        title: createKnownToolTitle("CodexReasoning"),
        icon: ICON_REASONING,
        minimal: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            title: z.string().check(z.describe('The title of the reasoning'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            content: z.string().check(z.describe('The reasoning content')),
            status: z.optional(z.enum(['completed', 'in_progress', 'error'])).check(z.describe('The status of the reasoning'))
        }))),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
    'GeminiReasoning': {
        title: createKnownToolTitle("GeminiReasoning"),
        icon: ICON_REASONING,
        minimal: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            title: z.string().check(z.describe('The title of the reasoning'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            content: z.string().check(z.describe('The reasoning content')),
            status: z.optional(z.enum(['completed', 'in_progress', 'canceled'])).check(z.describe('The status of the reasoning'))
        }))),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
    'think': {
        title: createKnownToolTitle("think"),
        icon: ICON_REASONING,
        minimal: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            title: z.optional(z.string()).check(z.describe('The title of the thinking')),
            items: z.optional(z.array(z.any())).check(z.describe('Items to think about')),
            locations: z.optional(z.array(z.any())).check(z.describe('Locations to consider'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            content: z.optional(z.string()).check(z.describe('The reasoning content')),
            text: z.optional(z.string()).check(z.describe('The reasoning text')),
            status: z.optional(z.enum(['completed', 'in_progress', 'canceled'])).check(z.describe('The status'))
        }))),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
} satisfies Record<string, KnownToolDefinition>;


import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import * as z from 'zod/mini';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { resolveDiffToolHeaderPresentation } from '../resolveDiffToolHeaderPresentation';

export const providerDiffTools = {
    'CodexDiff': {
        title: createKnownToolTitle("CodexDiff"),
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            unified_diff: z.string().check(z.describe('Unified diff content'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            status: z.literal('completed').check(z.describe('Always completed'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).subtitle;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({ tool: opts.tool }).description;
        }
    },
    'GeminiDiff': {
        title: createKnownToolTitle("GeminiDiff"),
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            unified_diff: z.optional(z.string()).check(z.describe('Unified diff content')),
            filePath: z.optional(z.string()).check(z.describe('File path')),
            description: z.optional(z.string()).check(z.describe('Edit description'))
        }))),
        result: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            status: z.literal('completed').check(z.describe('Always completed'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({
                tool: opts.tool,
                filePathFallback: typeof opts.tool.input?.filePath === 'string' ? opts.tool.input.filePath : null,
            }).subtitle;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return resolveDiffToolHeaderPresentation({
                tool: opts.tool,
                filePathFallback: typeof opts.tool.input?.filePath === 'string' ? opts.tool.input.filePath : null,
            }).description;
        }
    },
} satisfies Record<string, KnownToolDefinition>;

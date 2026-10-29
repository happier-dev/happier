import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { resolvePath } from '@/utils/path/pathUtils';
import * as z from 'zod/mini';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerPatchTools = {
    'edit': {
        title: createKnownToolTitle("edit"),
        icon: ICON_EDIT,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            path: z.string().check(z.describe('The file path to edit')),
            oldText: z.string().check(z.describe('The text to replace')),
            newText: z.string().check(z.describe('The new text')),
            type: z.optional(z.string()).check(z.describe('Type of edit (diff)'))
        })))
    },
    'CodexPatch': {
        title: createKnownToolTitle("CodexPatch"),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            auto_approved: z.optional(z.boolean()).check(z.describe('Whether changes were auto-approved')),
            changes: z.record(z.string(), z.looseObject({
                add: z.optional(z.object({
                    content: z.string()
                })),
                modify: z.optional(z.object({
                    old_content: z.string(),
                    new_content: z.string()
                })),
                delete: z.optional(z.object({
                    content: z.string()
                }))
            })).check(z.describe('File changes to apply'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the first file being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                if (files.length > 0) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    if (files.length > 1) {
                        return t('tools.desc.modifyingMultipleFiles', {
                            file: fileName,
                            count: files.length - 1
                        });
                    }
                    return fileName;
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the number of files being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                const fileCount = files.length;
                if (fileCount === 1) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    return t('tools.desc.modifyingFile', { file: fileName });
                } else if (fileCount > 1) {
                    return t('tools.desc.modifyingFiles', { count: fileCount });
                }
            }
            return t('tools.names.applyChanges');
        }
    },
    'GeminiPatch': {
        title: createKnownToolTitle("GeminiPatch"),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            auto_approved: z.optional(z.boolean()).check(z.describe('Whether changes were auto-approved')),
            changes: z.record(z.string(), z.looseObject({
                add: z.optional(z.object({
                    content: z.string()
                })),
                modify: z.optional(z.object({
                    old_content: z.string(),
                    new_content: z.string()
                })),
                delete: z.optional(z.object({
                    content: z.string()
                }))
            })).check(z.describe('File changes to apply'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the first file being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                if (files.length > 0) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    if (files.length > 1) {
                        return t('tools.desc.modifyingMultipleFiles', {
                            file: fileName,
                            count: files.length - 1
                        });
                    }
                    return fileName;
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the number of files being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                const fileCount = files.length;
                if (fileCount === 1) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    return t('tools.desc.modifyingFile', { file: fileName });
                } else if (fileCount > 1) {
                    return t('tools.desc.modifyingFiles', { count: fileCount });
                }
            }
            return t('tools.names.applyChanges');
        }
    },
} satisfies Record<string, KnownToolDefinition>;


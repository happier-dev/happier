import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const corePatchTools = {
    Patch: {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: z.object({
            // Optional; some providers include it.
            auto_approved: z.boolean().optional(),
            changes: z.record(z.string(), z.object({
                add: z.object({ content: z.string() }).optional(),
                modify: z.object({ old_content: z.string(), new_content: z.string() }).optional(),
                delete: z.object({ content: z.string() }).optional(),
            }).loose()).describe('File changes to apply'),
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const changes = opts.tool.input?.changes;
            if (!changes || typeof changes !== 'object') return null;
            const files = Object.keys(changes as Record<string, unknown>);
            if (files.length === 0) return null;
            if (files.length === 1) {
                const fileName = files[0].split('/').pop() || files[0];
                return fileName;
            }
            return t('tools.desc.modifyingFiles', { count: files.length });
        },
    },
} satisfies Record<string, KnownToolDefinition>;


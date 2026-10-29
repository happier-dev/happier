import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { resolvePath } from '@/utils/path/pathUtils';
import * as z from 'zod/mini';
import { t } from '@/text';
import { ICON_READ, ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreNotebookTools = {
    'NotebookRead': {
        title: createKnownToolTitle("NotebookRead"),
        icon: ICON_READ,
        minimal: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            notebook_path: z.string().check(z.describe('The absolute path to the Jupyter notebook file')),
            cell_id: z.optional(z.string()).check(z.describe('The ID of a specific cell to read'))
        })))
    },
    'NotebookEdit': {
        title: createKnownToolTitle("NotebookEdit"),
        icon: ICON_EDIT,
        isMutable: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            notebook_path: z.string().check(z.describe('The absolute path to the notebook file')),
            new_source: z.string().check(z.describe('The new source for the cell')),
            cell_id: z.optional(z.string()).check(z.describe('The ID of the cell to edit')),
            cell_type: z.optional(z.enum(['code', 'markdown'])).check(z.describe('The type of the cell')),
            edit_mode: z.optional(z.enum(['replace', 'insert', 'delete'])).check(z.describe('The type of edit to make'))
        }))),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                const mode = opts.tool.input.edit_mode || 'replace';
                return t('tools.desc.editNotebookMode', { path, mode });
            }
            return t('tools.names.editNotebook');
        }
    },
} satisfies Record<string, KnownToolDefinition>;


import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerUiTools = {
    'change_title': {
        title: t('tools.names.changeTitle'),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            title: z.string().optional().describe('New session title')
        }).partial().loose(),
        result: z.object({}).partial().loose()
    },
    WorkspaceIndexingPermission: {
        title: 'Workspace indexing',
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            toolCall: z.object({
                title: z.string().optional(),
                toolCallId: z.string().optional(),
            }).partial().optional(),
            options: z.array(z.object({
                id: z.string().optional(),
                name: z.string().optional(),
                kind: z.string().optional(),
            }).partial()).optional(),
        }).partial().loose(),
        result: z.object({}).partial().loose(),
    },
} satisfies Record<string, KnownToolDefinition>;

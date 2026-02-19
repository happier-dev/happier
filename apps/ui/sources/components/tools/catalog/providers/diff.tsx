import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { parseUnifiedDiffFilePaths } from '../parseUnifiedDiffFilePaths';

export const providerDiffTools = {
    'CodexDiff': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return t('tools.names.viewDiff');
            const paths = parseUnifiedDiffFilePaths(diff);
            return paths.length > 1 ? t('tools.names.turnDiff') : t('tools.names.viewDiff');
        },
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: z.object({
            unified_diff: z.string().describe('Unified diff content')
        }).partial().passthrough(),
        result: z.object({
            status: z.literal('completed').describe('Always completed')
        }).partial().passthrough(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return null;

            const paths = parseUnifiedDiffFilePaths(diff);
            if (paths.length !== 1) return null;

            const filePath = paths[0]!;
            const basename = filePath.split('/').pop() || filePath;
            return basename;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return t('tools.desc.showingDiff');
        }
    },
    'GeminiDiff': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return t('tools.names.viewDiff');
            const paths = parseUnifiedDiffFilePaths(diff);
            return paths.length > 1 ? t('tools.names.turnDiff') : t('tools.names.viewDiff');
        },
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: z.object({
            unified_diff: z.string().optional().describe('Unified diff content'),
            filePath: z.string().optional().describe('File path'),
            description: z.string().optional().describe('Edit description')
        }).partial().passthrough(),
        result: z.object({
            status: z.literal('completed').describe('Always completed')
        }).partial().passthrough(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Try to extract filename from filePath first
            if (opts.tool.input?.filePath && typeof opts.tool.input.filePath === 'string') {
                const basename = opts.tool.input.filePath.split('/').pop() || opts.tool.input.filePath;
                return basename;
            }
            // Fall back to extracting from unified diff
            const diff = opts.tool.input?.unified_diff;
            if (typeof diff !== 'string' || !diff) return null;

            const paths = parseUnifiedDiffFilePaths(diff);
            if (paths.length !== 1) return null;

            const filePath = paths[0]!;
            const basename = filePath.split('/').pop() || filePath;
            return basename;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return t('tools.desc.showingDiff');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

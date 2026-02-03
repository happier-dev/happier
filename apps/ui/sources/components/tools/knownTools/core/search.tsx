import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import { t } from '@/text';
import { ICON_SEARCH, ICON_READ } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { CodeSearchInputV2Schema, GlobInputV2Schema, GrepInputV2Schema, LSInputV2Schema } from '@happier-dev/protocol';

export const coreSearchTools = {
    'Glob': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return opts.tool.input.pattern;
            }
            return t('tools.names.searchFiles');
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: GlobInputV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return t('tools.desc.searchPattern', { pattern: opts.tool.input.pattern });
            }
            return t('tools.names.search');
        }
    },
    'Grep': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return `grep(pattern: ${opts.tool.input.pattern})`;
            }
            return 'Search Content';
        },
        icon: ICON_READ,
        minimal: true,
        input: GrepInputV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                const pattern = opts.tool.input.pattern.length > 20
                    ? opts.tool.input.pattern.substring(0, 20) + '...'
                    : opts.tool.input.pattern;
                return `Search(pattern: ${pattern})`;
            }
            return 'Search';
        }
    },
    'LS': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return t('tools.names.listFiles');
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: LSInputV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                const path = resolvePath(opts.tool.input.path, opts.metadata);
                const basename = path.split('/').pop() || path;
                return t('tools.desc.searchPath', { basename });
            }
            return t('tools.names.search');
        }
    },
    'CodeSearch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const query = typeof opts.tool.input?.query === 'string'
                ? opts.tool.input.query
                : typeof opts.tool.input?.pattern === 'string'
                    ? opts.tool.input.pattern
                    : null;
            if (query && query.trim()) return query.trim();
            return 'Code Search';
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: CodeSearchInputV2Schema,
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const query = typeof opts.tool.input?.query === 'string'
                ? opts.tool.input.query
                : typeof opts.tool.input?.pattern === 'string'
                    ? opts.tool.input.pattern
                    : null;
            if (query && query.trim()) {
                const truncated = query.length > 30 ? query.substring(0, 30) + '...' : query;
                return truncated;
            }
            return 'Search in code';
        }
    },
} satisfies Record<string, KnownToolDefinition>;

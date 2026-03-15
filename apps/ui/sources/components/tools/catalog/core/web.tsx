import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import { ICON_WEB } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { WebFetchInputV2Schema, WebSearchInputV2Schema } from '@happier-dev/protocol';

export const coreWebTools = {
    'WebFetch': {
        title: () => t('tools.names.fetchUrl'),
        icon: ICON_WEB,
        minimal: true,
        input: WebFetchInputV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url !== 'string') return null;
            try {
                const url = new URL(opts.tool.input.url);
                return url.hostname || null;
            } catch {
                return null;
            }
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url === 'string') {
                try {
                    const url = new URL(opts.tool.input.url);
                    return t('tools.desc.fetchUrlHost', { host: url.hostname });
                } catch {
                    return t('tools.names.fetchUrl');
                }
            }
            return 'Fetch URL';
        }
    },
    'WebSearch': {
        title: () => t('tools.names.webSearch'),
        icon: ICON_WEB,
        minimal: true,
        input: WebSearchInputV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const query = typeof opts.tool.input.query === 'string' ? opts.tool.input.query.trim() : '';
            return query.length > 0 ? query : null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                const query = opts.tool.input.query.length > 30
                    ? opts.tool.input.query.substring(0, 30) + '...'
                    : opts.tool.input.query;
                return t('tools.desc.webSearchQuery', { query });
            }
            return t('tools.names.webSearch');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

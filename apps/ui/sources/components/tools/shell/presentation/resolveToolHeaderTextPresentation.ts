import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { knownTools } from '@/components/tools/catalog';
import { inferToolNameForRendering } from '@/components/tools/normalization/policy/toolNameInference';
import { formatMCPSubtitle, formatMCPTitle } from '@/components/tools/renderers/system/MCPToolView';
import { t } from '@/text';

const KNOWN_TOOL_KEYS = Object.keys(knownTools);

export type ToolHeaderTextPresentation = Readonly<{
    normalizedToolName: string;
    usedInferenceFallback: boolean;
    title: string;
    subtitle: string | null;
    statusText: string | null;
}>;

export function resolveToolHeaderTextPresentation(params: {
    tool: ToolCall;
    metadata: Metadata | null;
}): ToolHeaderTextPresentation {
    const { tool, metadata } = params;

    if (tool.name.startsWith('mcp__')) {
        return {
            normalizedToolName: tool.name,
            usedInferenceFallback: false,
            title: formatMCPTitle(tool.name),
            subtitle: formatMCPSubtitle(tool.input),
            statusText: null,
        };
    }

    const inferred = inferToolNameForRendering({
        toolName: tool.name,
        toolInput: tool.input,
        toolDescription: tool.description,
        knownToolKeys: KNOWN_TOOL_KEYS,
    });
    const normalizedToolName = inferred.normalizedToolName;
    const usedInferenceFallback = inferred.source !== 'original' && inferred.normalizedToolName !== tool.name;

    const knownTool = knownTools[normalizedToolName as keyof typeof knownTools] as any;

    let statusText: string | null = null;
    if (knownTool && typeof knownTool.extractStatus === 'function') {
        const extracted = knownTool.extractStatus({ tool, metadata });
        if (typeof extracted === 'string' && extracted) {
            statusText = extracted;
        }
    }

    let title = normalizedToolName;
    if (knownTool?.title) {
        title = typeof knownTool.title === 'function' ? knownTool.title({ tool, metadata }) : knownTool.title;
    }

    if (usedInferenceFallback && !knownTool && typeof tool.description === 'string' && tool.description.trim().length > 0) {
        title = tool.description.trim();
    }

    let subtitle: string | null = null;
    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
        const extractedSubtitle = knownTool.extractSubtitle({ tool, metadata });
        if (typeof extractedSubtitle === 'string' && extractedSubtitle) {
            subtitle = extractedSubtitle;
        }
    }

    if (!subtitle) {
        const raw = typeof tool.description === 'string' ? tool.description.trim() : '';
        if (raw) {
            const rawLower = raw.toLowerCase();
            if (rawLower !== 'execute') {
                const titleTrimmed = typeof title === 'string' ? title.trim() : '';
                if (!titleTrimmed || raw !== titleTrimmed) {
                    subtitle = raw;
                }
            }
        }
    }

    const isExplicitUnknown = normalizedToolName.trim().toLowerCase() === 'unknown';
    if (isExplicitUnknown) {
        const titleLower = typeof title === 'string' ? title.trim().toLowerCase() : '';
        if (titleLower === 'unknown') {
            title = t('tools.common.unknownToolTitle');
        }
        if (subtitle) {
            const match = subtitle.trim().match(/^tool:\s*(.+)$/i);
            if (match?.[1]) {
                subtitle = match[1].trim();
            }
        }
    }

    return {
        normalizedToolName,
        usedInferenceFallback,
        title,
        subtitle,
        statusText,
    };
}

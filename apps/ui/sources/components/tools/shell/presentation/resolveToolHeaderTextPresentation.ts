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

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function parseJsonLikeSubtitle(subtitle: string): Record<string, unknown> | null {
    const trimmed = subtitle.trim();
    if (!trimmed) return null;

    const parseAsObject = (value: unknown): Record<string, unknown> | null => {
        if (typeof value !== 'string') return asObject(value);
        const inner = value.trim();
        if (!inner) return null;
        if (inner[0] !== '{' && inner[0] !== '[' && inner[0] !== '"') return null;
        try {
            return parseAsObject(JSON.parse(inner));
        } catch {
            return null;
        }
    };

    return parseAsObject(trimmed);
}

function compactSubAgentRunSubtitle(subtitle: string | null, normalizedToolName: string): string | null {
    if (!subtitle || normalizedToolName !== 'SubAgentRun') return subtitle;
    const parsed = parseJsonLikeSubtitle(subtitle);
    if (!parsed) return subtitle;

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (summary) return summary;

    const errorObj = asObject(parsed.error);
    const errorMessage = typeof errorObj?.message === 'string' ? errorObj.message.trim() : '';
    if (errorMessage) return errorMessage;

    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (message) return message;

    return null;
}

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

    subtitle = compactSubAgentRunSubtitle(subtitle, normalizedToolName);

    if (!knownTool) {
        const rawTitle = typeof title === 'string' ? title.trim() : '';
        // When OpenCode (and other providers) emit simple lowercase tool names like "skill" or "question",
        // prefer a minimally humanized title instead of showing raw lowercase.
        if (rawTitle && /^[a-z][a-z0-9]*$/.test(rawTitle)) {
            title = rawTitle[0]!.toUpperCase() + rawTitle.slice(1);
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

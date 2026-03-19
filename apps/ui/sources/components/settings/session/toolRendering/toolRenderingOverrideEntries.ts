import { KNOWN_CANONICAL_TOOL_NAMES_V2 } from '@happier-dev/protocol/tools/v2';

import { normalizeToolNameForView } from '@/components/tools/normalization/policy/normalizeToolNameForView';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export type ToolRenderingOverrideEntry = Readonly<{
    toolName: string;
    title: string;
}>;

const SAMPLE_TOOL_BASE = {
    state: 'completed',
    input: {},
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    description: null,
} satisfies Omit<ToolCall, 'name'>;

function buildSampleTool(name: string): ToolCall {
    return {
        ...SAMPLE_TOOL_BASE,
        name,
    };
}

function humanizeToolName(toolName: string): string {
    const trimmed = toolName.trim();
    if (!trimmed) return toolName;
    return trimmed
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveToolRenderingOverrideTitle(toolName: string): string {
    const resolved = resolveToolHeaderTextPresentation({
        tool: buildSampleTool(toolName),
        metadata: null,
    }).title.trim();

    if (!resolved) return humanizeToolName(toolName);
    if (resolved === toolName) return humanizeToolName(toolName);
    return resolved;
}

export const TOOL_RENDERING_OVERRIDE_ENTRIES: ReadonlyArray<ToolRenderingOverrideEntry> = (() => {
    const seen = new Set<string>();
    const entries: ToolRenderingOverrideEntry[] = [];

    for (const canonicalToolName of KNOWN_CANONICAL_TOOL_NAMES_V2) {
        const normalizedToolName = normalizeToolNameForView(canonicalToolName);
        if (seen.has(normalizedToolName)) continue;
        seen.add(normalizedToolName);
        entries.push({
            toolName: normalizedToolName,
            title: resolveToolRenderingOverrideTitle(normalizedToolName),
        });
    }

    return entries;
})();

import { ResolvedMcpToolIdentityV1Schema, type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { ToolCall } from '../messages/index.js';

/** Presentation fallback used after the same tool-title catalog and name inference on every host. */
export function resolveToolDisplayTitle(input: Readonly<{
    tool: ToolCall; normalizedToolName: string; usedInferenceFallback: boolean;
    knownTitle?: string | null; unknownTitle: string;
}>): string {
    let title = input.knownTitle ?? input.normalizedToolName;
    if (input.usedInferenceFallback && input.knownTitle == null && input.tool.description?.trim()) {
        title = input.tool.description.trim();
    }
    if (input.normalizedToolName.trim().toLowerCase() === 'unknown' && title.trim().toLowerCase() === 'unknown') {
        title = input.unknownTitle;
    }
    if (input.knownTitle == null) {
        const raw = title.trim();
        if (raw && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(raw)) {
            const words = raw.replace(/_/g, ' ');
            title = words[0]!.toUpperCase() + words.slice(1);
        }
    }
    return title;
}

function snakeToPascalWithSpaces(value: string): string {
    return value.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

export function resolveMcpToolTitle(toolName: string, mcpTool?: ResolvedMcpToolIdentityV1,
    actionTitle?: string | null,
): string {
    if (actionTitle) return actionTitle;
    const identity = ResolvedMcpToolIdentityV1Schema.safeParse(mcpTool);
    if (identity.success) return `${identity.data.toolTitle ?? identity.data.tool} · ${identity.data.serverTitle}`;
    const withoutPrefix = toolName.replace(/^mcp__/, '');
    const parts = withoutPrefix.split('__');
    if (parts.length >= 2) {
        return `MCP: ${snakeToPascalWithSpaces(parts[0]!)} ${snakeToPascalWithSpaces(parts.slice(1).join('_'))}`;
    }
    return `MCP: ${snakeToPascalWithSpaces(withoutPrefix)}`;
}

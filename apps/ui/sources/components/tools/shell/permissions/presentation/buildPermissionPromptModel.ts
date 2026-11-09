import type { ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { McpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { McpServerToolPolicyV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { supportsSessionPermissionPersistence } from '@/sync/ops/sessionPermissionAnswers';

export type McpPermissionPromptFacts = Readonly<{
    serverId: string; toolName: string; title: string; serverTitle: string;
    badges: readonly ('destructive' | 'read_only' | 'idempotent' | 'open_world')[];
    serverDefault: McpServerToolPolicyV1['default'] | null;
    decision: McpToolDecisionV1;
    argumentFacts: readonly Readonly<{ key: string; label: string; value: string }>[];
    canAlwaysAllow: boolean;
}>;

export type PermissionPromptModel = Readonly<{
    request: PendingPermissionRequest;
    tool: ToolCall & { permission: NonNullable<ToolCall['permission']> };
    headerText: ReturnType<typeof resolveToolHeaderTextPresentation>;
    mcp?: McpPermissionPromptFacts;
}>;

export function buildPermissionPromptModel(input: {
    request: PendingPermissionRequest;
    metadata: Metadata | null;
    nowMs: number;
    serverDefault?: McpPermissionPromptFacts['serverDefault'];
}): PermissionPromptModel {
    const createdAt =
        typeof input.request.createdAt === 'number' && Number.isFinite(input.request.createdAt)
            ? input.request.createdAt
            : input.nowMs;

    const parsed = ResolvedMcpToolIdentityV1Schema.safeParse('mcpTool' in input.request ? input.request.mcpTool : undefined);
    const identity = parsed.success && parsed.data.server !== 'happier' ? parsed.data : null;
    const tool: PermissionPromptModel['tool'] = {
        id: `perm:${input.request.id}`,
        name: input.request.tool,
        state: 'running',
        input: input.request.arguments,
        createdAt,
        startedAt: createdAt,
        completedAt: null,
        description: null,
        result: null,
        permission: { id: input.request.id, status: 'pending',
            ...(input.request.turnId ? { turnId: input.request.turnId } : {}),
            ...(input.request.source ? { source: input.request.source } : {}),
            ...(input.request.permissionSuggestions !== undefined ? { suggestions: input.request.permissionSuggestions } : {}),
            ...(input.request.nativeChoices ? { nativeChoices: input.request.nativeChoices } : {}),
            ...(identity ? { mcpTool: identity } : {}) },
    };

    const headerText = resolveToolHeaderTextPresentation({ tool, metadata: input.metadata });

    if (!identity) return { request: input.request, tool, headerText };
    const annotations = identity.annotations;
    const badges: McpPermissionPromptFacts['badges'][number][] = [];
    if (annotations?.destructiveHint === true) badges.push('destructive');
    if (annotations?.readOnlyHint === true) badges.push('read_only');
    if (annotations?.idempotentHint === true) badges.push('idempotent');
    if (annotations?.openWorldHint === true) badges.push('open_world');
    const args = input.request.arguments;
    const argumentFacts = args && typeof args === 'object' && !Array.isArray(args) ? Object.entries(args).map(([key, value]) => {
        const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
        let text: string;
        try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; } catch { text = ''; }
        return { key, label: words.charAt(0).toUpperCase() + words.slice(1), value: text };
    }) : [];
    return { request: input.request, tool, headerText, mcp: {
        serverId: identity.item.serverId, toolName: identity.tool, title: identity.toolTitle ?? identity.tool,
        serverTitle: identity.serverTitle, badges, serverDefault: input.serverDefault ?? null,
        decision: identity.decision, argumentFacts, canAlwaysAllow: supportsSessionPermissionPersistence(input.request.source),
    } };
}

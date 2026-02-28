import * as React from 'react';
import { Ionicons, Octicons } from '@expo/vector-icons';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { knownTools } from '@/components/tools/catalog';
import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { normalizeToolCallForRendering } from '@/components/tools/normalization/core/normalizeToolCallForRendering';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';

export type ToolHeaderModel = Readonly<{
    toolForRendering: ToolCall;
    normalizedToolName: string;
    knownTool: any;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    icon: React.ReactNode;
    hasSpecificView: boolean;
    isUnknownTool: boolean;
    isWaitingForPermission: boolean;
    hideUnknownToolsByDefault: boolean;
    shouldHideBodyPermanently: boolean;
    shouldCollapseUnknownToolByDefault: boolean;
}>;

export function buildToolHeaderModel(input: {
    tool: ToolCall;
    metadata: Metadata | null;
    iconSize: number;
    iconColorPrimary: string;
    iconColorSecondary: string;
}): ToolHeaderModel {
    const toolForRendering = normalizeToolCallForRendering(input.tool);
    const headerText = resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: input.metadata });
    const normalizedToolName = headerText.normalizedToolName;
    const knownTool = knownTools[normalizedToolName as keyof typeof knownTools] as any;

    const hasSpecificView = !!getToolViewComponent(normalizedToolName);
    const isUnknownTool =
        !toolForRendering.name.startsWith('mcp__') &&
        !knownTool &&
        !hasSpecificView;

    const isWaitingForPermission =
        toolForRendering.permission?.status === 'pending' &&
        toolForRendering.state === 'running';

    const agentId = resolveAgentIdFromFlavor(input.metadata?.flavor);
    const hideUnknownToolsByDefault = agentId ? getAgentCore(agentId).toolRendering.hideUnknownToolsByDefault : false;

    const shouldHideBodyPermanently = hideUnknownToolsByDefault && isUnknownTool;
    const shouldCollapseUnknownToolByDefault = isUnknownTool && toolForRendering.state === 'completed';

    const icon = resolveToolHeaderIcon({
        tool: toolForRendering,
        knownTool,
        iconSize: input.iconSize,
        iconColorPrimary: input.iconColorPrimary,
        iconColorSecondary: input.iconColorSecondary,
    });

    return {
        toolForRendering,
        normalizedToolName,
        knownTool,
        title: headerText.title,
        subtitle: headerText.subtitle,
        statusText: headerText.statusText,
        icon,
        hasSpecificView,
        isUnknownTool,
        isWaitingForPermission,
        hideUnknownToolsByDefault,
        shouldHideBodyPermanently,
        shouldCollapseUnknownToolByDefault,
    };
}

function resolveToolHeaderIcon(params: {
    tool: ToolCall;
    knownTool: any;
    iconSize: number;
    iconColorPrimary: string;
    iconColorSecondary: string;
}): React.ReactNode {
    if (params.tool.name.startsWith('mcp__')) {
        return <Ionicons name="extension-puzzle-outline" size={params.iconSize} color={params.iconColorSecondary} />;
    }

    if (
        params.tool.name === 'CodexBash' &&
        (params.tool.input as any)?.parsed_cmd &&
        Array.isArray((params.tool.input as any).parsed_cmd) &&
        (params.tool.input as any).parsed_cmd.length > 0
    ) {
        const parsedCmd = (params.tool.input as any).parsed_cmd[0];
        if (parsedCmd?.type === 'read') {
            return <Octicons name="eye" size={params.iconSize} color={params.iconColorPrimary} />;
        }
        if (parsedCmd?.type === 'write') {
            return <Octicons name="file-diff" size={params.iconSize} color={params.iconColorPrimary} />;
        }
        return <Octicons name="terminal" size={params.iconSize} color={params.iconColorPrimary} />;
    }

    if (params.knownTool && typeof params.knownTool.icon === 'function') {
        return params.knownTool.icon(params.iconSize, params.iconColorPrimary);
    }

    return <Ionicons name="construct-outline" size={params.iconSize} color={params.iconColorSecondary} />;
}

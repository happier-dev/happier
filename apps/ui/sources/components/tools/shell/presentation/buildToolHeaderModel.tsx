import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import * as React from 'react';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';

import { knownTools } from '@/components/tools/catalog';
import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { normalizeToolCallForRendering } from "@happier-dev/session-core/tools";
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import {
    getAgentCore,
    } from '@/agents/catalog/catalog';

export type ToolHeaderModel = Readonly<{
    toolForRendering: ToolCall;
    normalizedToolName: string;
    knownTool: any;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    answeredBy: ReturnType<typeof resolveToolHeaderTextPresentation>['answeredBy'];
    answeredByLabel: string | null;
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
    /**
     * The Agent that produced this row, when the transcript has divider
     * evidence for it. A Session that switched Agent keeps every earlier row on
     * screen, and each Agent has its own unknown-tool policy, so the history
     * must not be re-judged by whoever is running now. `null`/absent keeps the
     * live-metadata answer.
     */
    historicalAgentId?: string | null;
    /** The call's child transcript messages (a Script header counts its inner calls). */
    messages?: readonly Message[];
    answeringSession?: Readonly<{ sessionId: string; name: string | null }>;
    serverId?: Parameters<typeof resolveToolHeaderTextPresentation>[0]['serverId'];
    viewerScope?: Parameters<typeof resolveToolHeaderTextPresentation>[0]['viewerScope'];
    answeringAccountActor?: Parameters<typeof resolveToolHeaderTextPresentation>[0]['answeringAccountActor'];
}): ToolHeaderModel {
    const toolForRendering = normalizeToolCallForRendering(input.tool);
    const headerText = resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: input.metadata,
        answeringSession: input.answeringSession, serverId: input.serverId,
        viewerScope: input.viewerScope, answeringAccountActor: input.answeringAccountActor, messages: input.messages });
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

    const agentId = input.historicalAgentId ?? resolveAgentIdFromSessionMetadata(input.metadata);
    const hideUnknownToolsByDefault = getAgentCore(agentId ?? '')?.toolRendering.hideUnknownToolsByDefault === true;

    const shouldHideBodyPermanently = hideUnknownToolsByDefault && isUnknownTool;
    const shouldCollapseUnknownToolByDefault = isUnknownTool && toolForRendering.state === 'completed';

    const icon = resolveToolHeaderIcon({
        tool: toolForRendering,
        metadata: input.metadata,
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
        answeredBy: headerText.answeredBy,
        answeredByLabel: headerText.answeredByLabel,
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
    metadata: Metadata | null;
    knownTool: any;
    iconSize: number;
    iconColorPrimary: string;
    iconColorSecondary: string;
}): React.ReactNode {
    if (params.tool.name.startsWith('mcp__')) {
        return <Icon name="puzzle-piece" size={params.iconSize} color={params.iconColorSecondary} />;
    }

    if (
        params.tool.name === 'CodexBash' &&
        (params.tool.input as any)?.parsed_cmd &&
        Array.isArray((params.tool.input as any).parsed_cmd) &&
        (params.tool.input as any).parsed_cmd.length > 0
    ) {
        const parsedCmd = (params.tool.input as any).parsed_cmd[0];
        if (parsedCmd?.type === 'read') {
            return <Icon name="eye" size={params.iconSize} color={params.iconColorPrimary} />;
        }
        if (parsedCmd?.type === 'write') {
            return <Icon name="git-diff" size={params.iconSize} color={params.iconColorPrimary} />;
        }
        return <Icon name="terminal" size={params.iconSize} color={params.iconColorPrimary} />;
    }

    if (params.knownTool && typeof params.knownTool.icon === 'function') {
        return params.knownTool.icon(params.iconSize, params.iconColorPrimary, {
            tool: params.tool,
            metadata: params.metadata,
        });
    }

    return <Icon name="wrench" size={params.iconSize} color={params.iconColorSecondary} />;
}

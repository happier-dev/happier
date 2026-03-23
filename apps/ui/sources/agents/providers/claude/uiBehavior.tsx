import * as React from 'react';

import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { ClaudeAgentLaunchActionsCard } from '@/agents/providers/claude/sessionSubagents/ClaudeAgentLaunchActionsCard';
import {
    createClaudeSubagentLauncherDetailsTab,
    isClaudeSubagentLauncherResource,
} from '@/agents/providers/claude/sessionSubagents/createClaudeSubagentLauncherDetailsTab';
import { SessionClaudeSubagentLauncherView } from '@/agents/providers/claude/sessionSubagents/SessionClaudeSubagentLauncherView';
import { resolveClaudeBrowseSourceOptions } from '@/agents/providers/claude/directSessions/resolveClaudeBrowseSourceOptions';

export const CLAUDE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    directSessions: {
        browse: {
            order: 20,
            getSourceOptions: () => resolveClaudeBrowseSourceOptions(),
        },
    },
    sessionSubagents: {
        renderLaunchCards: ({ scopeId, subagents }) => {
            const teamIds = new Set<string>();
            for (const subagent of subagents) {
                if (subagent.kind !== 'agent_team_member') continue;
                const groupKey = subagent.display.groupKey?.trim();
                if (groupKey) teamIds.add(groupKey);
            }
            return [
                <ClaudeAgentLaunchActionsCard
                    key="claude-launch-actions"
                    scopeId={scopeId}
                    teamIds={[...teamIds]}
                />,
            ];
        },
        createTeammateLauncherDetailsTab: ({ teamId }) => createClaudeSubagentLauncherDetailsTab('member', teamId),
        renderDetailsTab: ({ sessionId, tab }) => {
            if (!isClaudeSubagentLauncherResource(tab.resource)) return null;
            return (
                <SessionClaudeSubagentLauncherView
                    sessionId={sessionId}
                    mode={tab.resource.mode}
                    initialTeamId={tab.resource.initialTeamId}
                    presentation="panel"
                />
            );
        },
        getDetailsTabIconName: ({ tab }) => isClaudeSubagentLauncherResource(tab.resource) ? 'people' : null,
    },
};

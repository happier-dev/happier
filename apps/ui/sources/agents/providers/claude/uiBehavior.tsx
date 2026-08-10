import * as React from 'react';

import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { buildClaudeSessionComposerNextMessageMetaOverrides } from '@/agents/providers/claude/buildClaudeSessionComposerNextMessageMetaOverrides';
import { classifyClaudeSessionComposerNonSteerablePayload } from '@/agents/providers/claude/classifyClaudeSessionComposerNonSteerablePayload';
import { ClaudeAgentLaunchActionsCard } from '@/agents/providers/claude/sessionSubagents/ClaudeAgentLaunchActionsCard';
import {
    createClaudeSubagentLauncherDetailsTab,
    isClaudeSubagentLauncherResource,
} from '@/agents/providers/claude/sessionSubagents/createClaudeSubagentLauncherDetailsTab';
import { SessionClaudeSubagentLauncherView } from '@/agents/providers/claude/sessionSubagents/SessionClaudeSubagentLauncherView';
import { resolveClaudeBrowseSourceOptions } from '@/agents/providers/claude/directSessions/resolveClaudeBrowseSourceOptions';
import { claudeGoalActionCapabilityProfile, claudeSupportsEditableGoals } from '@/agents/providers/claude/workState/claudeEditableGoals';
import { buildClaudeSessionHandoffProviderPatch } from '@/agents/providers/claude/sessionHandoff';
import { isClaudeUnifiedAttachedSessionTerminalAvailable } from '@/agents/providers/claude/attachedSessionTerminal';
import { resolveClaudePendingDeliveryLabelKey } from '@/agents/providers/claude/pendingDeliveryPresentation';

export const CLAUDE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    pendingDelivery: {
        resolveLabelKey: ({ session, localId, detail }) => resolveClaudePendingDeliveryLabelKey({
            localId,
            detail,
            custodyObservedLocalId: session.agentState?.capabilities?.pendingInputInterruptAndRunLocalId,
        }),
        resolveTransientAction: ({ session, localId, wireMode }) => {
            if (wireMode !== 'pending_input_v1') return null;
            const capabilities = session.agentState?.capabilities;
            if (capabilities?.pendingInputInterruptAndRunLocalId !== localId) return null;
            return {
                id: 'interrupt_and_run',
                localId,
                ...(typeof capabilities.pendingInputInterruptAndRunStateAt === 'number'
                    ? { stateAtMs: capabilities.pendingInputInterruptAndRunStateAt }
                    : {}),
            };
        },
    },
    attachedSessionTerminal: {
        isAvailable: ({ session }) => isClaudeUnifiedAttachedSessionTerminalAvailable(session),
    },
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    workState: {
        supportsEditableGoals: ({ agentId, session }) => claudeSupportsEditableGoals({ agentId, session }),
        resolveGoalActionCapabilityProfile: ({ agentId, session }) => claudeGoalActionCapabilityProfile({ agentId, session }),
    },
    directSessions: {
        browse: {
            order: 20,
            getSourceOptions: () => resolveClaudeBrowseSourceOptions(),
        },
    },
    sessionHandoff: {
        buildProviderPatch: () => buildClaudeSessionHandoffProviderPatch(),
    },
    sessionComposer: {
        buildNextMessageMetaOverrides: ({ configOptionOverrides, metaOverrides }) =>
            buildClaudeSessionComposerNextMessageMetaOverrides({
                configOptionOverrides,
                metaOverrides,
            }),
        getNonSteerablePayloadReason: ({ configOptionOverrides, metaOverrides, session }) =>
            classifyClaudeSessionComposerNonSteerablePayload({
                configOptionOverrides,
                metaOverrides,
                session,
            }),
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

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import type { ExistingSessionAutomationAuthoringContext } from './sessionAuthoringContext';

export type SessionComposerState = Readonly<{
    agentId: AgentId;
    machineName: string | null;
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    profileId: string | null;
    currentPath: string;
}>;

export function resolveSessionComposerStateFromAuthoringContext(
    context: ExistingSessionAutomationAuthoringContext,
    params?: Readonly<{ fallbackAgentId?: AgentId | null }>,
): SessionComposerState {
    const agentId = isAgentId(context.draft.agentId)
        ? context.draft.agentId
        : (params?.fallbackAgentId ?? DEFAULT_AGENT_ID);
    const machineNameCandidate = context.session.metadata?.displayName
        || context.session.metadata?.host
        || context.session.metadata?.machineId
        || null;

    return {
        agentId,
        machineName: typeof machineNameCandidate === 'string' ? machineNameCandidate : null,
        permissionMode: (context.draft.permissionMode ?? 'default') as PermissionMode,
        modelMode: (context.draft.modelId ?? getAgentCore(agentId).model.defaultMode) as ModelMode,
        profileId: context.draft.profileId,
        currentPath: context.draft.directory,
    };
}


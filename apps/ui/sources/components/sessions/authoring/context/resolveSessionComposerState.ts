import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/sessionAuthoringSnapshot';

export type SessionComposerState = Readonly<{
    agentId: AgentId;
    machineName: string | null;
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    profileId: string | null;
    currentPath: string;
}>;

export function resolveSessionComposerState(params: Readonly<{
    snapshot: Pick<SessionAuthoringSnapshot, 'agentId' | 'permissionMode' | 'modelId' | 'profileId' | 'directory'>;
    session: Pick<ExistingSessionAuthoringSnapshotSession, 'metadata'>;
    fallbackAgentId?: AgentId | null;
    permissionModeOverride?: PermissionMode | null;
    modelModeOverride?: ModelMode | null;
    profileIdOverride?: string | null;
    currentPathOverride?: string | null;
}>): SessionComposerState {
    const agentId = isAgentId(params.snapshot.agentId)
        ? params.snapshot.agentId
        : (params.fallbackAgentId ?? DEFAULT_AGENT_ID);
    const machineNameCandidate = params.session.metadata?.displayName
        || params.session.metadata?.host
        || params.session.metadata?.machineId
        || null;

    return {
        agentId,
        machineName: typeof machineNameCandidate === 'string' ? machineNameCandidate : null,
        permissionMode: params.permissionModeOverride
            ?? (params.snapshot.permissionMode ?? 'default') as PermissionMode,
        modelMode: params.modelModeOverride
            ?? (params.snapshot.modelId ?? getAgentCore(agentId).model.defaultMode) as ModelMode,
        profileId: params.profileIdOverride ?? params.snapshot.profileId ?? null,
        currentPath: params.currentPathOverride ?? params.snapshot.directory,
    };
}

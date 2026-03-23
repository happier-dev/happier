import type { AgentState, Metadata, Session } from '@/sync/domains/state/storageTypes';
import { resolveAgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';

export interface SessionListRenderableMetadata {
    name?: string;
    summaryText?: string | null;
    path: string;
    homeDir?: string | null;
    host?: string | null;
    machineId?: string | null;
    flavor?: string | null;
    directSessionV1?: {
        v: 1;
        providerId?: string;
    } | null;
    hiddenSystemSession?: boolean;
}

export interface SessionListRenderableSession {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
    pendingVersion?: number;
    pendingCount?: number;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionListRenderableMetadata | null;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    optimisticThinkingAt?: number | null;
    thinkingGraceUntil?: number | null;
    owner?: string;
    accessLevel?: 'view' | 'edit' | 'admin';
    canApprovePermissions?: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
}

type DirectSessionRenderableMetadata = NonNullable<SessionListRenderableMetadata['directSessionV1']>;

type AgentRequestRecord = NonNullable<AgentState['requests']>;

function listPendingRequestEntries(agentState: AgentState | null | undefined): Array<{ kind: string }> {
    const requests = agentState?.requests;
    if (!requests) return [];
    const completed = agentState?.completedRequests ?? null;

    return Object.entries(requests as AgentRequestRecord).flatMap(([id, request]) => {
        if (!request || typeof request !== 'object') return [];
        const completedEntry = completed?.[id];
        if (completedEntry && completedEntry.completedAt != null) return [];
        return [{
            kind: resolveAgentRequestKind({
                toolName: typeof request.tool === 'string' ? request.tool : '',
                requestKind: request.kind,
            }),
        }];
    });
}

export function derivePendingRequestFlagsFromAgentState(agentState: AgentState | null | undefined): {
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
} {
    const requests = listPendingRequestEntries(agentState);
    return {
        hasPendingPermissionRequests: requests.some((request) => request.kind !== 'user_action'),
        hasPendingUserActionRequests: requests.some((request) => request.kind === 'user_action'),
    };
}

function derivePendingRequestFlags(params: Readonly<{
    agentState: AgentState | null | undefined;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
}>): {
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
} {
    if (typeof params.pendingPermissionRequestCount === 'number' || typeof params.pendingUserActionRequestCount === 'number') {
        return {
            hasPendingPermissionRequests: (params.pendingPermissionRequestCount ?? 0) > 0,
            hasPendingUserActionRequests: (params.pendingUserActionRequestCount ?? 0) > 0,
        };
    }

    return derivePendingRequestFlagsFromAgentState(params.agentState);
}

export function buildSessionListRenderableMetadata(metadata: Metadata | null | undefined): SessionListRenderableMetadata | null {
    if (!metadata) return null;
    const directSessionV1 = (() : DirectSessionRenderableMetadata | null => {
        const candidate = metadata.directSessionV1;
        if (!candidate || typeof candidate !== 'object') return null;
        if (!('v' in candidate) || candidate.v !== 1) return null;
        return {
            v: 1,
            ...('providerId' in candidate && typeof candidate.providerId === 'string'
                ? { providerId: candidate.providerId }
                : {}),
        };
    })();
    return {
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        summaryText: typeof metadata.summary?.text === 'string' ? metadata.summary.text : null,
        path: typeof metadata.path === 'string' ? metadata.path : '',
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
        flavor: typeof metadata.flavor === 'string' ? metadata.flavor : null,
        directSessionV1,
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
    };
}

export function buildSessionListRenderableFromSession(session: Session): SessionListRenderableSession {
    const pending = derivePendingRequestFlags({
        agentState: session.agentState,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
    });
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        metadata: buildSessionListRenderableMetadata(session.metadata),
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        presence: session.presence,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
    };
}

export function didSessionListRenderableStructuralFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;

    return false;
}

function resolveProjectMachineScopeId(metadata: SessionListRenderableMetadata | null | undefined): string {
    const machineId = typeof metadata?.machineId === 'string' ? metadata.machineId.trim() : '';
    if (machineId) return machineId;
    const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
    if (host) return `host:${host}`;
    return 'unknown';
}

export function didSessionListRenderableProjectGroupingFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (resolveProjectMachineScopeId(prevMeta) !== resolveProjectMachineScopeId(nextMeta)) return true;

    return false;
}

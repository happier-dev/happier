import type { SessionListLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import {
    buildMachineResolutionContextFromRecord,
    normalizeSessionPathForComparison,
    resolveSessionMachineRpcTarget,
    type SessionMachineTargetPeer,
} from '@/sync/domains/session/resolveSessionReachableMachineId';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

type MachineTargetLikeState = SessionListLookupStateLike & Readonly<{
    sessions?: Record<string, {
        active?: boolean;
        updatedAt?: number;
        metadata?: SessionTargetMetadataLike;
    }>;
    machines?: Record<string, { id?: string; active?: boolean; activeAt?: number; metadata?: { host?: string | null } | null }>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; rootPath?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export type SessionTargetMetadataLike = Readonly<{
    machineId?: string | null;
    path?: string | null;
    host?: string | null;
    homeDir?: string | null;
    directSessionV1?: Readonly<{
        v?: number;
        providerId?: string | null;
        machineId?: string | null;
        remoteSessionId?: string | null;
    }> | null;
}> | null | undefined;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveMachineTargetForSessionFromState(
    state: SessionMachineTargetState,
    sessionId: string,
): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = state.sessions?.[resolvedSessionId];
    const metadata = resolveSessionListPreferredSessionMetadataFromState(state, resolvedSessionId);
    const getProjectForSession = typeof state.getProjectForSession === 'function' ? state.getProjectForSession : null;
    const project = getProjectForSession?.(resolvedSessionId) ?? null;
    const sessionMachineId = resolveSessionMachineId(metadata);
    const sessionHostHint = (
        normalizeNonEmptyString(session?.metadata?.host)
        ?? normalizeNonEmptyString(state.sessionListRenderables?.[resolvedSessionId]?.metadata?.host)
    );
    const sessionPath = normalizeNonEmptyString(metadata?.path);
    const sessionHomeDir = normalizeNonEmptyString(metadata?.homeDir);
    const projectMachineId = project?.key?.machineId ?? null;
    const projectPath = normalizeNonEmptyString(project?.key?.rootPath);
    if (!projectPath && !sessionPath) {
        return null;
    }
    const comparableBasePath =
        normalizeSessionPathForComparison(projectPath, sessionHomeDir)
        ?? normalizeSessionPathForComparison(sessionPath, sessionHomeDir);
    const machineResolutionContext = buildMachineResolutionContextFromRecord(state.machines ?? {});

    const directTarget = resolveSessionMachineRpcTarget({
        sessionId: resolvedSessionId,
        sessionMachineId,
        sessionHostHint,
        sessionPath,
        sessionHomeDir,
        comparableBasePath,
        projectMachineId,
        projectPath,
        machineResolutionContext,
    });
    const directTargetMachine = directTarget ? machineResolutionContext.machineById.get(directTarget.machineId) ?? null : null;
    if (!comparableBasePath || directTargetMachine?.active === true) {
        return directTarget;
    }

    const peerSessions: SessionMachineTargetPeer[] = [];
    for (const candidateSessionId in state.sessions ?? {}) {
        if (candidateSessionId === resolvedSessionId) {
            continue;
        }
        const candidateSession = state.sessions?.[candidateSessionId];
        const candidateMetadata = resolveSessionListPreferredSessionMetadataFromState(state, candidateSessionId);
        const candidateHomeDir = normalizeNonEmptyString(candidateMetadata?.homeDir);
        const candidateComparableMetadataPath = normalizeSessionPathForComparison(
            normalizeNonEmptyString(candidateMetadata?.path),
            candidateHomeDir,
        );
        if (candidateComparableMetadataPath && candidateComparableMetadataPath !== comparableBasePath) {
            continue;
        }
        const candidateProject = getProjectForSession?.(candidateSessionId) ?? null;
        const candidateComparableProjectPath = normalizeSessionPathForComparison(
            normalizeNonEmptyString(candidateProject?.key?.rootPath),
            candidateHomeDir,
        );
        const candidateComparablePath: string | null = candidateComparableMetadataPath ?? candidateComparableProjectPath;
        if (candidateComparablePath !== comparableBasePath) {
            continue;
        }
        peerSessions.push({
            id: candidateSessionId,
            active: candidateSession?.active === true,
            updatedAt: typeof (candidateSession as { updatedAt?: unknown }).updatedAt === 'number'
                ? (candidateSession as { updatedAt: number }).updatedAt
                : 0,
            machineId: resolveSessionMachineId(candidateMetadata),
            hostHint: (
                normalizeNonEmptyString(candidateSession?.metadata?.host)
                ?? normalizeNonEmptyString(state.sessionListRenderables?.[candidateSessionId]?.metadata?.host)
            ),
            projectMachineId: candidateProject?.key?.machineId ?? null,
        });
    }
    if (peerSessions.length > 1) {
        peerSessions.sort((left, right) => {
            const activeDelta = Number(Boolean(right.active)) - Number(Boolean(left.active));
            if (activeDelta !== 0) {
                return activeDelta;
            }
            return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
        });
    }
    if (peerSessions.length === 0) {
        return directTarget;
    }

    return resolveSessionMachineRpcTarget({
        sessionId: resolvedSessionId,
        sessionMachineId: null,
        sessionHostHint,
        sessionPath,
        sessionHomeDir,
        comparableBasePath,
        projectMachineId: projectMachineId !== directTarget?.machineId ? projectMachineId : null,
        projectPath,
        machineResolutionContext,
        peerSessions,
        peerSessionsSorted: true,
        peerSessionsComparablePathFiltered: true,
    });
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const reachableMachineId = sessionId
        ? resolveMachineTargetForSessionFromState(input.state, sessionId)?.machineId ?? null
        : null;
    if (reachableMachineId) {
        return reachableMachineId;
    }
    return (
        resolveSessionMachineId(input.metadata)
        ?? ''
    );
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const reachableBasePath = sessionId
        ? resolveMachineTargetForSessionFromState(input.state, sessionId)?.basePath ?? null
        : null;
    if (reachableBasePath) {
        return reachableBasePath;
    }
    return normalizeNonEmptyString(input.metadata?.path) ?? '';
}

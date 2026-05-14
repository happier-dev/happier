import type { SessionListLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    resolveSessionDisplayTarget,
    resolveSessionRpcTarget,
} from '@/sync/domains/machines/identity/resolveSessionMachineTargets';

type MachineTargetLikeState = SessionListLookupStateLike & Readonly<{
    sessions?: Record<string, {
        active?: boolean;
        updatedAt?: number;
        metadata?: SessionTargetMetadataLike;
    }>;
    machines?: Record<string, Machine>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; rootPath?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export type SessionTargetMetadataLike = Readonly<{
    machineId?: string | null;
    path?: string | null;
    host?: string | null;
    homeDir?: string | null;
    externalSessionV1?: Readonly<{
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

function readMachines(state: SessionMachineTargetState): Machine[] {
    return Object.values(state.machines ?? {});
}

function readSessionTargetInput(state: SessionMachineTargetState, sessionId: string) {
    const session = state.sessions?.[sessionId];
    const metadata = resolveSessionListPreferredSessionMetadataFromState(state, sessionId);
    const getProjectForSession = typeof state.getProjectForSession === 'function' ? state.getProjectForSession : null;
    const project = getProjectForSession?.(sessionId) ?? null;

    return {
        sessionActive: session?.active === true,
        sessionMachineId: resolveSessionMachineId(metadata),
        sessionPath: normalizeNonEmptyString(metadata?.path),
        projectMachineId: project?.key?.machineId ?? null,
        projectPath: normalizeNonEmptyString(project?.key?.rootPath),
        machines: readMachines(state),
    };
}

export function resolveMachineTargetForSessionFromState(
    state: SessionMachineTargetState,
    sessionId: string,
): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const target = resolveSessionRpcTarget(readSessionTargetInput(state, resolvedSessionId));
    if (!target) return null;
    return {
        machineId: target.machineId,
        basePath: target.basePath,
    };
}

export function resolveDisplayMachineIdForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const target = sessionId
        ? resolveSessionDisplayTarget(readSessionTargetInput(input.state, sessionId))
        : null;
    if (target?.machineId) return target.machineId;
    return (
        resolveSessionMachineId(input.metadata)
        ?? ''
    );
}

export function resolveDisplayMachineTargetForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const target = sessionId
        ? resolveSessionDisplayTarget(readSessionTargetInput(input.state, sessionId))
        : null;
    if (target?.machineId && target.basePath) {
        return {
            machineId: target.machineId,
            basePath: target.basePath,
        };
    }

    const machineId = resolveSessionMachineId(input.metadata);
    const basePath = normalizeNonEmptyString(input.metadata?.path);
    if (!machineId || !basePath) return null;
    return { machineId, basePath };
}

export function resolveDisplayPathForSessionFromState(input: Readonly<{
    state: SessionMachineTargetState;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const target = sessionId
        ? resolveSessionDisplayTarget(readSessionTargetInput(input.state, sessionId))
        : null;
    if (target?.basePath) return target.basePath;
    return normalizeNonEmptyString(input.metadata?.path) ?? '';
}

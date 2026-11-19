import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
    type RpcErrorCarrier,
} from '@happier-dev/protocol/rpcErrors';
import { storage } from '@/sync/domains/state/storage';
import {
    resolveDisplayIdentityForSessionFromState,
    resolveDisplayMachineTargetForSessionFromState,
    resolveDisplayMachineIdForSessionFromState,
    resolveDisplayPathForSessionFromState,
    resolveMachineControlTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
    type SessionDisplayIdentity,
    type ExactSessionMachineTargetIdentity,
    type SessionMachineTargetIdentity,
    type SessionMachineControlTarget,
    type SessionMachineTarget,
    type SessionMachineTargetState,
    type SessionTargetMetadataLike,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
export { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcErrorCodes';

export function readMachineTargetForSession(
    session: SessionMachineTargetIdentity,
): SessionMachineTarget | null {
    return resolveMachineTargetForSessionFromState(storage.getState() as SessionMachineTargetState, session);
}

export function readMachineControlTargetForSession(
    session: SessionMachineTargetIdentity,
): SessionMachineControlTarget | null {
    return resolveMachineControlTargetForSessionFromState(storage.getState() as SessionMachineTargetState, session);
}

type SessionAuthorityReader = typeof import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority').readSessionSnapshotForAuthority;

/** Resolve an operation's target from the exact Home Session detail. Turn history is a separate demand. */
export async function readMachineControlTargetForSessionAuthority(
    input: Pick<Parameters<SessionAuthorityReader>[0], 'authority' | 'sessionId' | 'signal' | 'isCurrent'>,
): Promise<Readonly<{
    session: Awaited<ReturnType<SessionAuthorityReader>>['session'];
    target: SessionMachineControlTarget | null;
}>> {
    const { readSessionSnapshotForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { session } = await readSessionSnapshotForAuthority({ ...input, includeTurns: false });
    return { session, target: resolveMachineControlTargetForSessionFromState({
        ...storage.getState(), sessions: { [input.sessionId]: session }, sessionListRowsByServerId: {},
    }, { ...input.authority.scope, sessionId: input.sessionId }) };
}

export function readDisplayMachineIdForSession(input: Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    return resolveDisplayMachineIdForSessionFromState({
        state: storage.getState() as SessionMachineTargetState,
        sessionId: input.sessionId,
        serverId: input.serverId,
        metadata: input.metadata,
    });
}

export function readDisplayMachineTargetForSession(input: Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): { machineId: string; basePath: string } | null {
    return resolveDisplayMachineTargetForSessionFromState({
        state: storage.getState() as SessionMachineTargetState,
        sessionId: input.sessionId,
        serverId: input.serverId,
        metadata: input.metadata,
    });
}

export function readDisplayPathForSession(input: Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
}>): string {
    return resolveDisplayPathForSessionFromState({
        state: storage.getState() as SessionMachineTargetState,
        sessionId: input.sessionId,
        serverId: input.serverId,
        metadata: input.metadata,
    });
}

export function readDisplayIdentityForSession(input: Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
    metadata?: SessionTargetMetadataLike;
    preferProvidedMetadata?: boolean;
}>): SessionDisplayIdentity {
    return resolveDisplayIdentityForSessionFromState({
        state: storage.getState() as SessionMachineTargetState,
        sessionId: input.sessionId,
        serverId: input.serverId,
        metadata: input.metadata,
        ...(input.preferProvidedMetadata === true ? { preferProvidedMetadata: true } : {}),
    });
}

export function shouldFallbackFromMachineRpc(error: unknown): boolean {
    if (error instanceof Error && typeof error.message === 'string') {
        if (error.message.includes('Machine encryption not found')) return true;
        if (error.message.includes('Socket not connected')) return true;
        if (error.message.includes('Scoped RPC socket connection timeout')) return true;
        if (error.message.includes('Scoped RPC socket connection failed')) return true;
    }

    if (error && typeof error === 'object') {
        const rpcError: RpcErrorCarrier = {
            rpcErrorCode:
                typeof (error as { rpcErrorCode?: unknown }).rpcErrorCode === 'string'
                    ? (error as { rpcErrorCode: string }).rpcErrorCode
                    : undefined,
            message:
                typeof (error as { message?: unknown }).message === 'string'
                    ? (error as { message: string }).message
                    : undefined,
        };
    return isRpcMethodNotAvailableError(rpcError)
        || isRpcMethodNotFoundError(rpcError);
    }

    return false;
}

export function canUseSessionRpc(sessionId: string): boolean {
    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    if (!session) return true;
    return session.active !== false;
}

export {
    resolveDisplayIdentityForSessionFromState,
    resolveDisplayMachineTargetForSessionFromState,
    resolveDisplayMachineIdForSessionFromState,
    resolveDisplayPathForSessionFromState,
    resolveMachineControlTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
};
export type { SessionMachineTargetIdentity, ExactSessionMachineTargetIdentity, SessionDisplayIdentity, SessionMachineControlTarget, SessionMachineTarget, SessionMachineTargetState };

import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { storage } from '@/sync/domains/state/storage';
import {
  resolveDisplayMachineIdForSessionFromState,
  resolveDisplayPathForSessionFromState,
  resolveMachineTargetForSessionFromState,
  type SessionMachineTargetState,
  type SessionTargetMetadataLike,
} from './sessionMachineTargetFromState';

export const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

export function readMachineTargetForSession(
  sessionId: string,
): { machineId: string; basePath: string } | null {
  return resolveMachineTargetForSessionFromState(storage.getState() as SessionMachineTargetState, sessionId);
}

export function readDisplayMachineIdForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayMachineIdForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
}

export function readDisplayPathForSession(input: Readonly<{
  sessionId?: string | null;
  metadata?: SessionTargetMetadataLike;
}>): string {
  return resolveDisplayPathForSessionFromState({
    state: storage.getState() as SessionMachineTargetState,
    sessionId: input.sessionId,
    metadata: input.metadata,
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
    return isRpcMethodNotAvailableError(rpcError) || isRpcMethodNotFoundError(rpcError);
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
  resolveDisplayMachineIdForSessionFromState,
  resolveDisplayPathForSessionFromState,
  resolveMachineTargetForSessionFromState,
};
export type { SessionMachineTargetState };

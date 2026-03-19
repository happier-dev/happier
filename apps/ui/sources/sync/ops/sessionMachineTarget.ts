import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import { resolveSessionMachineRpcTarget } from '@/sync/domains/session/resolveSessionReachableMachineId';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';

type MachineTargetLikeState = Readonly<{
  sessions?: Record<string, {
    active?: boolean;
    updatedAt?: number;
    metadata?: {
      machineId?: string | null;
      path?: string | null;
      host?: string | null;
      homeDir?: string | null;
    } | null;
  }>;
  machines?: Record<string, { id?: string; active?: boolean; activeAt?: number; metadata?: { host?: string | null } | null }>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

type SessionTargetMetadataLike = Readonly<{
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
  const session = state.sessions?.[sessionId];
  const metadata = session?.metadata ?? null;
  const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;

  const machines = Object.values(state.machines ?? {}) as Machine[];
  const peerSessions = Object.entries(state.sessions ?? {}).map(([candidateSessionId, candidateSession]) => {
    const candidateMetadata = candidateSession?.metadata ?? null;
    const candidateProject =
      typeof state.getProjectForSession === 'function'
        ? state.getProjectForSession(candidateSessionId)
        : null;
    return {
      id: candidateSessionId,
      active: candidateSession?.active === true,
      updatedAt: typeof (candidateSession as { updatedAt?: unknown }).updatedAt === 'number'
        ? (candidateSession as { updatedAt: number }).updatedAt
        : 0,
      machineId: normalizeNonEmptyString(candidateMetadata?.machineId),
      hostHint: normalizeNonEmptyString(candidateMetadata?.host),
      path: normalizeNonEmptyString(candidateMetadata?.path),
      homeDir: normalizeNonEmptyString(candidateMetadata?.homeDir),
      projectMachineId: candidateProject?.key?.machineId ?? null,
      projectPath: normalizeNonEmptyString(candidateProject?.key?.path),
    };
  });
  return resolveSessionMachineRpcTarget({
    sessionId,
    sessionMachineId: normalizeNonEmptyString(metadata?.machineId),
    sessionHostHint: normalizeNonEmptyString(metadata?.host),
    sessionPath: normalizeNonEmptyString(metadata?.path),
    sessionHomeDir: normalizeNonEmptyString(metadata?.homeDir),
    projectMachineId: project?.key?.machineId ?? null,
    projectPath: normalizeNonEmptyString(project?.key?.path),
    machines,
    peerSessions,
  });
}

export function readMachineTargetForSession(
  sessionId: string,
): { machineId: string; basePath: string } | null {
  return resolveMachineTargetForSessionFromState(storage.getState() as SessionMachineTargetState, sessionId);
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
    normalizeNonEmptyString(input.metadata?.machineId)
    ?? normalizeNonEmptyString(input.metadata?.directSessionV1?.machineId)
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

export function resolveMachinePathFromSessionBase(input: { basePath: string; requestPath?: string }): string {
  const requestPath = input.requestPath;
  if (!requestPath || requestPath === '.') return input.basePath;
  if (requestPath.startsWith('~')) return requestPath;

  const isAbsolutePosix = requestPath.startsWith('/');
  const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestPath) || requestPath.startsWith('\\\\');
  if (isAbsolutePosix || isAbsoluteWindows) return requestPath;

  const separator = input.basePath.includes('\\') ? '\\' : '/';
  const base = input.basePath.endsWith(separator) ? input.basePath.slice(0, -1) : input.basePath;
  const rel = requestPath.startsWith(separator) ? requestPath.slice(1) : requestPath;
  return `${base}${separator}${rel}`;
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

export function shouldFallbackToSessionRpc(sessionId: string, error: unknown): boolean {
  if (!shouldFallbackFromMachineRpc(error)) return false;
  return canUseSessionRpc(sessionId);
}

export function canUseSessionRpc(sessionId: string): boolean {
  const state = storage.getState();
  const session = state.sessions?.[sessionId];
  if (!session) return true;
  return session.active !== false;
}

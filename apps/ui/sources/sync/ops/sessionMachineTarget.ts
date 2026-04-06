import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@happier-dev/protocol/rpcErrors';
import {
  buildMachineResolutionContextFromRecord,
  normalizeSessionPathForComparison,
  resolveSessionMachineRpcTarget,
  type SessionMachineTargetPeer,
} from '@/sync/domains/session/resolveSessionReachableMachineId';
import { findSessionListViewDataSession } from '@/sync/domains/session/listing/sessionListViewDataAccess';
import type { SessionListCacheStateLike } from '@/sync/domains/session/listing/sessionListCacheState';
import { storage } from '@/sync/domains/state/storage';

type MachineTargetLikeState = SessionListCacheStateLike & Readonly<{
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
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; rootPath?: string } } | null;
}>;

export type SessionMachineTargetState = MachineTargetLikeState;

export const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

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
  const metadata = findSessionListViewDataSession(state?.sessionListViewData, sessionId)?.session?.metadata ?? session?.metadata ?? null;
  const getProjectForSession = typeof state.getProjectForSession === 'function' ? state.getProjectForSession : null;
  const project = getProjectForSession?.(sessionId) ?? null;
  const sessionMachineId = normalizeNonEmptyString(metadata?.machineId);
  const sessionHostHint = normalizeNonEmptyString(metadata?.host);
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
    sessionId,
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
    if (candidateSessionId === sessionId) {
      continue;
    }
    const candidateSession = state.sessions?.[candidateSessionId];
    const candidateMetadata = findSessionListViewDataSession(state?.sessionListViewData, candidateSessionId)?.session?.metadata ?? candidateSession?.metadata ?? null;
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
      machineId: normalizeNonEmptyString(candidateMetadata?.machineId),
      hostHint: normalizeNonEmptyString(candidateMetadata?.host),
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
    sessionId,
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

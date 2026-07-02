import type { ScmWorkingSnapshot, Session } from '@/sync/domains/state/storageTypes';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import type { SessionRealtimeScmScope } from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';
import { isSessionPathWithinRepoRoot } from '@/scm/sync/paths';

type SessionRealtimeScmScopeState = Readonly<{
  sessions?: Record<string, Pick<Session, 'id' | 'metadata'>>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; path?: string | null } } | null;
  getSessionProjectScmSnapshot?: (sessionId: string) => ScmWorkingSnapshot | null;
}>;

type MountedScmConsumerResetListener = () => void;

let nextConsumerId = 1;
const mountedScmConsumerScopes = new Map<number, SessionRealtimeScmScope>();
const mountedScmConsumerResetListeners = new Set<MountedScmConsumerResetListener>();
let mountedScmConsumerResetVersion = 0;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readMachineScopeId(
  state: SessionRealtimeScmScopeState,
  sessionId: string,
  session: Pick<Session, 'metadata'>,
): string | null {
  const workspaceContext = readSessionWorkspaceContext(state, sessionId);
  return normalizeText(workspaceContext.projectMachineId)
    ?? normalizeText(resolveProjectMachineScopeId(session.metadata ?? {}));
}

export function buildSessionRealtimeScmScopeFromSnapshot(
  state: SessionRealtimeScmScopeState,
  sessionId: string,
  snapshot: ScmWorkingSnapshot | null | undefined,
): SessionRealtimeScmScope | null {
  const session = state.sessions?.[sessionId];
  if (!session || snapshot?.repo.isRepo !== true) return null;
  const repoRoot = normalizeText(snapshot.repo.rootPath);
  if (!repoRoot) return null;
  const machineScopeId = readMachineScopeId(state, sessionId, session);
  if (!machineScopeId || machineScopeId === 'unknown') return null;
  return {
    sessionId,
    canonicalProjectKey: normalizeText(snapshot.projectKey) ?? `${machineScopeId}:${repoRoot}`,
    machineScopeId,
    repoRoot,
  };
}

export function resolveSessionRealtimeScmScopeForMountedConsumers(
  state: SessionRealtimeScmScopeState,
  sessionId: string,
  mountedScopes: ReadonlyArray<SessionRealtimeScmScope>,
): SessionRealtimeScmScope | null {
  const snapshotScope = buildSessionRealtimeScmScopeFromSnapshot(
    state,
    sessionId,
    state.getSessionProjectScmSnapshot?.(sessionId) ?? null,
  );
  if (snapshotScope) return snapshotScope;

  const session = state.sessions?.[sessionId];
  if (!session) return null;
  const machineScopeId = readMachineScopeId(state, sessionId, session);
  if (!machineScopeId || machineScopeId === 'unknown') return { sessionId };

  const workspacePath = normalizeText(readSessionWorkspaceContext(state, sessionId).workspacePath);
  if (!workspacePath) return { sessionId, machineScopeId };

  for (const mountedScope of mountedScopes) {
    if (normalizeText(mountedScope.machineScopeId) !== machineScopeId) continue;
    const repoRoot = normalizeText(mountedScope.repoRoot);
    const canonicalProjectKey = normalizeText(mountedScope.canonicalProjectKey);
    if (!repoRoot || !canonicalProjectKey) continue;
    if (!isSessionPathWithinRepoRoot(workspacePath, repoRoot)) continue;
    return {
      sessionId,
      canonicalProjectKey,
      machineScopeId,
      repoRoot,
    };
  }

  return { sessionId, machineScopeId };
}

export function registerSessionRealtimeScmConsumerScope(scope: SessionRealtimeScmScope): () => void {
  const consumerId = nextConsumerId;
  nextConsumerId += 1;
  mountedScmConsumerScopes.set(consumerId, {
    ...scope,
    needsMutationTranscript: true,
  });
  return () => {
    mountedScmConsumerScopes.delete(consumerId);
  };
}

export function readMountedSessionRealtimeScmConsumerScopes(): SessionRealtimeScmScope[] {
  return Array.from(mountedScmConsumerScopes.values());
}

export function getMountedSessionRealtimeScmConsumerScopeResetVersion(): number {
  return mountedScmConsumerResetVersion;
}

export function subscribeMountedSessionRealtimeScmConsumerScopeResets(
  listener: MountedScmConsumerResetListener,
): () => void {
  mountedScmConsumerResetListeners.add(listener);
  return () => {
    mountedScmConsumerResetListeners.delete(listener);
  };
}

export function clearMountedSessionRealtimeScmConsumerScopes(): void {
  mountedScmConsumerScopes.clear();
  mountedScmConsumerResetVersion += 1;
  for (const listener of mountedScmConsumerResetListeners) {
    listener();
  }
}

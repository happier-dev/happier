import type {
  ConnectedServiceRuntimeRefreshTarget,
  ConnectedServiceRuntimeRegistry,
} from '../connectedServices/runtimeRegistry/registry';

export function resolveConnectedServiceRefreshSessionIds(params: Readonly<{
  affectedTargets: ReadonlyArray<ConnectedServiceRuntimeRefreshTarget>;
  registry: ConnectedServiceRuntimeRegistry;
  trackedSessions: ReadonlyMap<number, Readonly<{ happySessionId?: string | null }>>;
}>): ReadonlyArray<string> {
  const sessionIds = new Set<string>();
  for (const target of params.affectedTargets) {
    if (!params.registry.isSessionTarget(target)) continue;
    const sessionId = target.sessionId?.trim()
      || params.trackedSessions.get(target.pid)?.happySessionId?.trim()
      || '';
    if (sessionId) sessionIds.add(sessionId);
  }
  return [...sessionIds];
}

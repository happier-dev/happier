import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';
import { resolveSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceRuntimeTarget } from './target';

export function resolveGroupRequiredModelIds(input: Readonly<{
  serviceId: ConnectedAccountServiceKey;
  groupId: string;
  targets: ReadonlyArray<Pick<ConnectedServiceRuntimeTarget, 'pid' | 'sessionId' | 'activeBindings'>>;
  trackedSessions: Iterable<Pick<TrackedSession, 'pid' | 'happySessionId' | 'spawnOptions'> & { happySessionMetadataFromLocalWebhook?: Record<string, unknown> }>;
}>): ReadonlyArray<string> {
  const sessions = [...input.trackedSessions];
  const byPid = new Map(sessions.map(session => [session.pid, session]));
  const bySessionId = new Map(sessions.flatMap(session => session.happySessionId ? [[session.happySessionId, session] as const] : []));
  const models = new Set<string>();
  const add = (modelId: string | null | undefined) => {
    const value = modelId?.trim();
    if (value && value !== 'default') models.add(value);
  };
  for (const target of input.targets) {
    if (!target.activeBindings.some(binding => binding.serviceId === input.serviceId && binding.groupId === input.groupId)) continue;
    const session = (target.sessionId ? bySessionId.get(target.sessionId) : null) ?? byPid.get(target.pid);
    if (!session) continue;
    // The launched model and a newer next-turn intent can both consume this group's credentials.
    add(session.spawnOptions?.modelSelection?.ref.modelId);
    const { snapshot } = resolveSessionRuntimeSnapshot({ incomingOptions: session.spawnOptions ?? { directory: '.' },
      persistedMetadata: session.happySessionMetadataFromLocalWebhook });
    add(snapshot.modelSelection?.value?.modelId);
    add(snapshot.teamModelSelection?.ref.modelId);
  }
  return [...models];
}

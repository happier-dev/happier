import type {
  DirectSessionActivityV1,
  DirectSessionsProviderId,
  DirectSessionsSource,
  ObservedAgentSessionStatusV1,
  ObservedAgentSessionV1,
} from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';
import type { DirectSessionProviderOps } from '@/backends/directSessions/providerOps';
import type { ObservedProcess } from '@/backends/directSessions/processMatch';

import type { ObservedCheckout } from '../git/observedGit';
import type { CodeIntelligenceStore } from '../store/codeIntelligenceStore';

/**
 * Status comes from the direct-sessions activity owner (provider-reported busy state or recent
 * transcript writes); a live provider process can only strengthen recent activity into `running`.
 * A process alone never marks an idle session as running, since it may serve another session.
 */
export function deriveObservedSessionStatus(input: Readonly<{
  activity: DirectSessionActivityV1;
  providerProcessObserved: boolean;
}>): Readonly<{ status: ObservedAgentSessionStatusV1; confidence: number }> {
  switch (input.activity) {
    case 'running':
      return { status: 'running', confidence: 0.95 };
    case 'active_recently':
      return input.providerProcessObserved
        ? { status: 'running', confidence: 0.75 }
        : { status: 'active_recently', confidence: 0.6 };
    case 'idle':
      return { status: 'idle', confidence: input.providerProcessObserved ? 0.6 : 0.85 };
    default:
      return { status: 'unknown', confidence: 0.2 };
  }
}

export type ObservedSessionProvider = Readonly<{
  providerId: DirectSessionsProviderId;
  source: DirectSessionsSource;
  ops: DirectSessionProviderOps;
}>;

/**
 * Only sessions written to within this window are swept: the dashboard reports current work, and
 * older sessions remain browsable through direct sessions. Bounds per-sweep provider store reads.
 */
export const OBSERVED_SESSION_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANDIDATES_PER_PROVIDER = 20;

export type SessionSweepResult = Readonly<{
  observedSessionIds: string[];
  providerErrors: Array<Readonly<{ providerId: string; message: string }>>;
}>;

export async function sweepExternalSessions(input: Readonly<{
  store: CodeIntelligenceStore;
  providers: readonly ObservedSessionProvider[];
  processes: readonly ObservedProcess[];
  nowMs: number;
  /** Cached per observation id: a provider session's working directory never changes. */
  workingDirectoryCache: Map<string, string | null>;
  /** `sessionId` is the swept session, so commits found while observing it can name it. */
  observeWorkingDirectory: (cwd: string, sessionActive: boolean, sessionId: string) => Promise<ObservedCheckout | null>;
}>): Promise<SessionSweepResult> {
  const { store, nowMs } = input;
  const previousById = new Map(store.listSessions().map((session) => [session.id, session]));
  const observedSessionIds: string[] = [];
  const providerErrors: Array<Readonly<{ providerId: string; message: string }>> = [];
  const failedProviderIds = new Set<string>();

  for (const provider of input.providers) {
    let candidates;
    try {
      // `fast` lists from the provider's own files only (for Codex: rollouts, never an app-server).
      candidates = (await provider.ops.listCandidates({ source: provider.source, limit: CANDIDATES_PER_PROVIDER, searchMode: 'fast' })).candidates;
    } catch (error) {
      providerErrors.push({ providerId: provider.providerId, message: error instanceof Error ? error.message : String(error) });
      failedProviderIds.add(provider.providerId);
      continue;
    }
    const matchingProcessCount = provider.ops.matchesProviderProcess
      ? input.processes.filter((process) => provider.ops.matchesProviderProcess!(process)).length
      : 0;
    // A process proves the agent runs, not which session it serves. It only strengthens recent
    // activity when there are at least as many live agent processes as recently written sessions.
    const observed = candidates.filter((candidate) => !candidate.archived && nowMs - candidate.updatedAtMs <= OBSERVED_SESSION_RECENCY_WINDOW_MS);
    const recentlyActiveCount = observed.filter((candidate) => candidate.activity === 'active_recently').length;
    const providerProcessObserved = matchingProcessCount > 0 && matchingProcessCount >= recentlyActiveCount;

    for (const candidate of observed) {
      const id = `${provider.providerId}:${candidate.remoteSessionId}`;
      // Only resolved directories are cached; an unresolved one is asked for again next sweep.
      let workingDirectory = input.workingDirectoryCache.get(id) ?? null;
      if (!workingDirectory) {
        workingDirectory = await provider.ops.getWorkingDirectory?.({ source: provider.source, remoteSessionId: candidate.remoteSessionId }).catch(() => null) ?? null;
        if (workingDirectory) input.workingDirectoryCache.set(id, workingDirectory);
      }
      const { status, confidence } = deriveObservedSessionStatus({
        activity: candidate.activity ?? deriveDirectSessionActivityFromTimestamp({ updatedAtMs: candidate.updatedAtMs, nowMs }),
        providerProcessObserved,
      });
      const checkout = workingDirectory
        ? await input.observeWorkingDirectory(workingDirectory, status === 'running' || status === 'active_recently', id)
        : null;
      const previous = previousById.get(id) ?? null;
      const session: ObservedAgentSessionV1 = {
        id,
        providerId: provider.providerId,
        providerSessionId: candidate.remoteSessionId,
        title: candidate.title ?? null,
        workingDirectory,
        repositoryId: checkout?.repositoryId ?? null,
        worktreePath: checkout?.worktreePath ?? null,
        branch: checkout?.branch ?? null,
        status,
        providerProcessObserved,
        confidence,
        source: 'external',
        lastActivityAtMs: candidate.updatedAtMs,
        firstObservedAtMs: previous?.firstObservedAtMs ?? nowMs,
      };
      store.upsertSession(session);
      observedSessionIds.push(id);
      appendSessionTransitionEvent(store, previous, session, nowMs);
    }
  }

  // Sessions that dropped out of the recent listings settle to their timestamp-derived status, so
  // nothing stays "running" just because no later sweep listed it.
  const listed = new Set(observedSessionIds);
  for (const previous of previousById.values()) {
    if (listed.has(previous.id) || failedProviderIds.has(previous.providerId)) continue;
    if (previous.status !== 'running' && previous.status !== 'active_recently') continue;
    const { status, confidence } = deriveObservedSessionStatus({
      activity: deriveDirectSessionActivityFromTimestamp({ updatedAtMs: previous.lastActivityAtMs, nowMs }),
      providerProcessObserved: false,
    });
    const session = { ...previous, status, confidence, providerProcessObserved: false };
    store.upsertSession(session);
    appendSessionTransitionEvent(store, previous, session, nowMs);
  }

  return { observedSessionIds, providerErrors };
}

function appendSessionTransitionEvent(
  store: CodeIntelligenceStore,
  previous: ObservedAgentSessionV1 | null,
  session: ObservedAgentSessionV1,
  nowMs: number,
): void {
  if (previous && previous.status === session.status) return;
  store.appendEvent({
    kind: previous ? 'session_status_changed' : 'session_observed',
    atMs: nowMs,
    repositoryId: session.repositoryId,
    worktreePath: session.worktreePath,
    sessionId: session.id,
    commitSha: null,
    data: {
      providerId: session.providerId,
      title: session.title,
      status: session.status,
      ...(previous ? { from: previous.status } : {}),
    },
  });
}

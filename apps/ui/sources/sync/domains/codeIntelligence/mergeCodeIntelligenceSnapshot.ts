import type {
  CodeIntelligenceActivityEventV1,
  CodeIntelligenceCommitV1,
  CodeIntelligenceRepositoryV1,
  CodeIntelligenceSnapshotResponseV1,
  CodeIntelligenceWorkerStatusV1,
  ObservedAgentSessionV1,
} from '@happier-dev/protocol';

export type CodeIntelligenceViewState = Readonly<{
  worker: CodeIntelligenceWorkerStatusV1;
  repositories: readonly CodeIntelligenceRepositoryV1[];
  sessions: readonly ObservedAgentSessionV1[];
  commits: readonly CodeIntelligenceCommitV1[];
  /** Newest first. */
  events: readonly CodeIntelligenceActivityEventV1[];
  latestSeq: number;
}>;

/**
 * The feed keeps the most recent events in memory; the daemon store remains the full record and a
 * reopened screen starts from a fresh snapshot.
 */
const MAX_FEED_EVENTS = 500;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reuses previous items (and the previous array) wherever the incoming data is structurally equal. */
function reconcileList<T>(previous: readonly T[] | undefined, next: readonly T[], keyOf: (item: T) => string): readonly T[] {
  if (!previous) return next;
  const previousByKey = new Map(previous.map((item) => [keyOf(item), item]));
  let changed = previous.length !== next.length;
  const reconciled = next.map((item, index) => {
    const prior = previousByKey.get(keyOf(item));
    const kept = prior !== undefined && sameJson(prior, item) ? prior : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? reconciled : previous;
}

export function mergeCodeIntelligenceSnapshot(
  previous: CodeIntelligenceViewState | null,
  snapshot: Extract<CodeIntelligenceSnapshotResponseV1, { ok: true }>,
): CodeIntelligenceViewState {
  const incomingNewestFirst = [...snapshot.events].sort((a, b) => b.seq - a.seq);
  const events = !previous || snapshot.eventsTruncated
    ? incomingNewestFirst.slice(0, MAX_FEED_EVENTS)
    : incomingNewestFirst.length === 0
      ? previous.events
      : [...incomingNewestFirst, ...previous.events.filter((event) => event.seq < (incomingNewestFirst.at(-1)?.seq ?? 0))].slice(0, MAX_FEED_EVENTS);

  const next: CodeIntelligenceViewState = {
    worker: previous && sameJson(previous.worker, snapshot.worker) ? previous.worker : snapshot.worker,
    repositories: reconcileList(previous?.repositories, snapshot.repositories, (repository) => repository.repositoryId),
    sessions: reconcileList(previous?.sessions, snapshot.sessions, (session) => session.id),
    commits: reconcileList(previous?.commits, snapshot.commits, (commit) => `${commit.repositoryId}:${commit.sha}`),
    events,
    latestSeq: snapshot.latestSeq,
  };

  if (
    previous
    && next.worker === previous.worker
    && next.repositories === previous.repositories
    && next.sessions === previous.sessions
    && next.commits === previous.commits
    && next.events === previous.events
    && next.latestSeq === previous.latestSeq
  ) {
    return previous;
  }
  return next;
}

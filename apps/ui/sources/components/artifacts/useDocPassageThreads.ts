import * as React from 'react';
import type {
  DiscussionOpenedMessageV1,
  DiscussionOpenedSummaryV1,
} from '@happier-dev/protocol/discussions/actions';

import { useSessionCollaborationAvailabilityState, type SessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionDocSnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';

export type DocPassageThreadsRead = Readonly<{
  status: 'loading' | 'ready' | 'unavailable';
  membership: readonly DiscussionOpenedSummaryV1[] | null;
  mountThread: (discussionId: string) => () => void;
  threads: readonly Readonly<{
    discussionId: string;
    summary: DiscussionOpenedSummaryV1;
    messages: readonly DiscussionOpenedMessageV1[];
  }>[];
}>;

const UNAVAILABLE: DocPassageThreadsRead = Object.freeze({
  status: 'unavailable',
  membership: null,
  mountThread: () => () => {},
  threads: Object.freeze([]),
});

export function resolveDocPassageThreadsAdmission(input: Readonly<{
  artifactId: string;
  credential: 'resolving' | 'bound' | 'unknown_home' | 'unavailable' | 'signed_out';
  collaboration: SessionCollaborationAvailabilityState;
}>): 'loading' | 'ready' | 'unavailable' {
  if (!input.artifactId) return 'unavailable';
  if (input.credential === 'unknown_home' || input.credential === 'unavailable' || input.credential === 'signed_out'
    || input.collaboration === 'unavailable') return 'unavailable';
  if (input.credential === 'resolving' || input.collaboration === 'loading') return 'loading';
  return 'ready';
}

/**
 * The passage threads of one Doc in its Home: C3's Doc-scoped list (`discussion.list` with
 * `anchorDocArtifactId`, which carries each opened passage root) and each thread's messages through
 * the one shared Discussion repository, so the margin, the full Discussion and the Inbox read the
 * same messages, dispositions and optimistic posts.
 */
export function useDocPassageThreads(
  input: Readonly<{ serverId: string; artifactId: string }>,
): DocPassageThreadsRead {
  const credential = useServerCredentialAccountScopeBinding(input.serverId);
  const binding = credential.binding;
  const availability = useSessionCollaborationAvailabilityState(input.serverId);
  const admission = resolveDocPassageThreadsAdmission({ artifactId: input.artifactId,
    credential: binding?.isCurrent() === true ? 'bound' : credential.resolution.kind, collaboration: availability });
  const usable = admission === 'ready';
  const client = React.useMemo(
    () =>
      usable && binding
        ? createDiscussionClient({
            scope: binding.scope,
            availability: 'available',
          })
        : null,
    [binding, usable],
  );
  const repository: DiscussionRepository | null = React.useMemo(
    () =>
      client && binding
        ? getDiscussionRepository({
            scope: binding.scope,
            address: { serverId: binding.scope.serverId },
            client,
            accountLifetime: binding,
          })
        : null,
    [binding, client],
  );
  const snapshot = useDiscussionDocSnapshot(repository, input.artifactId);
  React.useEffect(() => {
    if (!repository) return;
    const controller = new AbortController();
    const release = repository.mount({ anchorDocArtifactId: input.artifactId });
    // The repository publishes settled failures; effect retirement is expected cancellation.
    void repository.refreshDocList(input.artifactId, controller.signal).catch(() => {});
    return () => { controller.abort(); release(); };
  }, [input.artifactId, repository]);

  const mountThread = React.useCallback((discussionId: string) => {
    if (!repository) return () => {};
    const release = repository.mount({ discussionId });
    void repository.refreshDiscussion(discussionId);
    return release;
  }, [repository]);

  return React.useMemo(() => {
    if (admission === 'loading') return { status: 'loading', threads: [], membership: null, mountThread };
    if (!usable) return UNAVAILABLE;
    const query = snapshot?.query;
    if (!query || query.status === 'idle' || query.status === 'loading')
      return { status: 'loading', threads: [], membership: null, mountThread };
    if (query.status !== 'ready' || query.incomplete || query.nextCursor !== null) return UNAVAILABLE;
    const threads: DocPassageThreadsRead['threads'][number][] = [];
    for (const summary of query.items) {
      const discussionId = summary.id;
      const thread = snapshot?.threads[discussionId];
      if (thread?.revoked) return UNAVAILABLE;
      if (summary.firstMessage === null) continue;
      if (!summary.firstMessage?.content) return UNAVAILABLE;
      const messages = thread?.messages.find(message => message.seq === 1)?.content
        ? thread.messages : [summary.firstMessage];
      const currentSummary = thread?.summary ?? summary;
      if (currentSummary.archivedAt !== null) continue;
      threads.push({ discussionId, summary: currentSummary, messages });
    }
    return {
      status: 'ready',
      threads,
      membership: query.items,
      mountThread,
    };
  }, [admission, mountThread, snapshot, usable]);
}

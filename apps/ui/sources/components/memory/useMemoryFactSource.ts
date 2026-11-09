import * as React from 'react';
import type { MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readSessionNameIfNamed } from '@/utils/sessions/sessionUtils';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

type MemoryFactSource =
  | Readonly<{ kind: 'session'; session: Readonly<{ serverId: string; sessionId: string }>; messageId?: string }>
  | DiscussionMessageRefV1;

/** Decisions own exact provenance; only legacy notes fall back to a Session-only source. */
export function readMemoryFactSource(fact: MemoryFactV1): MemoryFactSource | null {
  return fact.decision?.sourceMessageRef ?? (fact.sourceSessionRef ? { kind: 'session', session: fact.sourceSessionRef } : null);
}

/** Detail-only source projection. A Memory grant never supplies authority to read its source. */
export function useMemoryFactSource(fact: MemoryFactV1): Readonly<{
  source: MemoryFactSource | null;
  title: string | null;
}> {
  const sourceKey = JSON.stringify(readMemoryFactSource(fact));
  const source = React.useMemo(() => readMemoryFactSource(fact), [sourceKey]);
  const isSessionVisible = useSessionRecordingVisibility();
  const homeId = source?.kind === 'session' ? source.session.serverId : source?.discussion.serverId;
  const serverId = homeId ? resolveServerProfileScopeIdForIdentifier(homeId) : '';
  const serverIds = React.useMemo(() => serverId ? [serverId] : [], [serverId]);
  const binding = useServerCredentialAccountScopeBindings(serverIds).get(serverId);
  const [loaded, setLoaded] = React.useState<Readonly<{
    sourceKey: string;
    binding: NonNullable<typeof binding>;
    title: string | null;
  }> | null>(null);

  React.useEffect(() => {
    if (!source || !binding?.isCurrent()) return;
    let controller: AbortController | null = null;
    const retirement = binding.onRetire(() => {
      controller?.abort();
      setLoaded(null);
    });
    const read = async (signal: AbortSignal): Promise<string | null> => {
      if (source.kind === 'discussion') {
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        const result = await createDiscussionClient({ scope: binding.scope, availability: 'available' })
          .get(source.discussion.discussionId, signal);
        return result.kind === 'succeeded' ? result.value.discussion.title : null;
      }
      const [{ captureLazyActionAccountContext }, { runWithServerRequestAuthorityForServerAccountScope },
        { readSessionSnapshotForAuthority }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'),
        import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
        import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
      ]);
      const account = await captureLazyActionAccountContext(serverId, signal);
      try {
        if (!binding.isCurrent() || account.accountId !== binding.accountId) return null;
        const { session } = await runWithServerRequestAuthorityForServerAccountScope({
          scope: account.accountLifetime.scope, activeRequest: account.request,
        }, authority => readSessionSnapshotForAuthority({ authority, sessionId: source.session.sessionId,
          isCurrent: () => binding.isCurrent() && account.accountLifetime.isCurrent() }));
        account.assertCurrent();
        return readSessionNameIfNamed(session, serverId, { snapshotOnly: true });
      } finally {
        account.dispose();
      }
    };
    const refresh = () => {
      if (!binding.isCurrent()) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      // A source change may revoke access without changing its identity or title.
      setLoaded(null);
      void read(request.signal).catch(() => null).then(title => {
        if (!request.signal.aborted && binding.isCurrent()) setLoaded({ sourceKey, binding, title });
      });
    };
    const unsubscribe = subscribeHomeAccountChange(event => {
      if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
      if (event.changeKinds && !event.changeKinds.includes(source.kind)) return;
      const sourceId = source.kind === 'session' ? source.session.sessionId : source.discussion.discussionId;
      if (event.entityIds && !event.entityIds.includes(sourceId)) return;
      refresh();
    }, { reconnect: 'refresh' });
    refresh();
    return () => {
      controller?.abort();
      retirement.dispose();
      unsubscribe();
    };
  }, [source, sourceKey, binding, serverId]);

  const identityVisible = source?.kind !== 'session' || isSessionVisible(source.session);
  return { source, title: identityVisible && loaded?.sourceKey === sourceKey && loaded.binding === binding
    && binding?.isCurrent() ? loaded.title : null };
}

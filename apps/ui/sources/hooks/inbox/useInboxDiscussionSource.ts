import * as React from 'react';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useSessionConversationsAvailability } from '@/components/sessions/conversations/useSessionConversationsAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { DiscussionRepositoryAttentionSnapshot } from '@/sync/ops/discussions/discussionRepository';
import type { InboxDiscussionSource, InboxItem } from '@/components/inbox/inboxItems';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { useArtifactTitleProjections } from '@/components/artifacts/useArtifactTitleProjections';

const emptySnapshot = () => null;
const emptySubscribe = () => () => {};

/** Shared attention demand only. N2 retains paging, access, messages and private read custody. */
export function useInboxDiscussionAttention(serverId: string | null) {
    const available = useSessionConversationsAvailability(serverId ?? '');
    const serverIds = React.useMemo(() => available && serverId ? [serverId] : [], [available, serverId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const binding = [...bindings.values()][0] ?? null;
    const repository = React.useMemo(() => binding?.isCurrent() && available ? getDiscussionRepository({
        scope: binding.scope, address: { serverId: binding.scope.serverId }, accountLifetime: binding,
        client: createDiscussionClient({ scope: binding.scope, availability: 'available' }),
    }) : null, [available, binding]);
    const getAttention = React.useCallback(() => binding?.isCurrent() && repository
        ? repository.getSnapshot().attention : null, [binding, repository]);
    const attention: DiscussionRepositoryAttentionSnapshot | null = React.useSyncExternalStore(
        repository?.subscribe ?? emptySubscribe, getAttention, emptySnapshot);
    React.useEffect(() => {
        if (!repository || !binding?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        const unmount = repository.mount({ attention: true });
        fireAndForget(repository.refreshAttention(controller.signal), { tag: 'Inbox.discussions.refresh' });
        return () => { controller.abort(); retirement.dispose(); unmount(); };
    }, [binding, repository]);
    const source = React.useMemo<InboxDiscussionSource | null>(() => binding?.isCurrent() && attention
        ? { scope: binding.scope, entries: attention.discussions } : null, [binding, attention?.discussions]);
    return { available, binding, repository, attention, source };
}

/** Open-Inbox detail joins are deliberately absent from the always-mounted badge. */
export function useInboxDiscussionSource(serverId: string | null) {
    const { available, binding, repository, attention, source: attentionSource } = useInboxDiscussionAttention(serverId);
    const sessionAddresses = React.useMemo(() => binding ? [...new Set((attention?.discussions ?? [])
        .flatMap(entry => entry.occurrences.flatMap(({ message }) => message.content
            ? [...readDiscussionMentionedParticipantIdsV1(message.content).mentionedSessionIds,
                ...(message.producerV1?.kind === 'agent' ? [message.producerV1.sessionId] : [])] : [])))]
        .map(sessionId => ({ serverId: binding.scope.serverId, sessionId })) : [], [binding, attention?.discussions]);
    // A Discussion message names the Sessions it mentions from encrypted content: demanded like visible list rows.
    useSessionContentDemand(sessionAddresses, { tag: 'inbox.hydrateDiscussionSessions', hydrate: 'unsettled' });
    const sessionTitles = useSessionDisplayNameProjections(sessionAddresses, readableSessionDisplayTitle);
    const sessionDisplayNames = React.useMemo(() => new Map(sessionAddresses.map((address, index) =>
        [address.sessionId, sessionTitles[index] ?? null] as const)), [sessionAddresses, sessionTitles]);
    const docIds = React.useMemo(() => [...new Set((attention?.discussions ?? []).flatMap(({ discussion }) =>
        discussion.anchor?.kind === 'doc' ? [discussion.anchor.doc.ref.artifactId] : []))], [attention?.discussions]);
    const docTitles = useArtifactTitleProjections(binding?.scope ?? null, docIds);
    const docDisplayNames = React.useMemo(() => new Map(docIds.map((id, index) =>
        [id, docTitles[index] ?? null] as const)), [docIds, docTitles]);
    const source = React.useMemo<InboxDiscussionSource | null>(() => attentionSource
        ? { ...attentionSource, sessionDisplayNames, docDisplayNames } : null, [attentionSource, sessionDisplayNames, docDisplayNames]);
    const coverage = !available || !binding || !attention ? 'unavailable' : attention.status !== 'ready' || attention.incomplete || attention.nextCursor !== null
        ? 'partial' : 'complete';
    const markOpened = React.useCallback(async (item: InboxItem) => {
        if (!repository || !binding?.isCurrent() || !item.discussion || item.source.serverId !== binding.scope.serverId
            || item.discussion.accountId !== binding.accountId) return;
        const result = await repository.setReadState(item.source.id, item.discussion.seq);
        if (result.kind !== 'succeeded') throw new Error(result.errorCode);
    }, [binding, repository]);
    const refresh = React.useCallback(() => repository?.refreshAttention(), [repository]);
    const loadMore = React.useCallback(() => repository?.loadMoreAttention(), [repository]);
    const loading = attention?.status === 'loading';
    const status = attention?.status ?? 'idle';
    const errorCode = attention?.errorCode ?? null;
    return React.useMemo(() => ({ source, coverage, available, loading, status, errorCode, markOpened, refresh, loadMore }),
        [source, coverage, available, loading, status, errorCode, markOpened, refresh, loadMore]);
}

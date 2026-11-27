import * as React from 'react';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readRegisteredDiscussionRepository, subscribeRegisteredDiscussionRepository } from './discussionRepositoryRegistry';

import type {
    DiscussionRepository,
    DiscussionListScope,
    DiscussionRepositoryCollectionSnapshot,
    DiscussionRepositorySnapshot,
    DiscussionRepositoryListSnapshot,
    DiscussionRepositoryThreadSnapshot,
} from './discussionRepository';

type DiscussionDocSnapshot = Readonly<{
    query: DiscussionRepositoryListSnapshot;
    threads: Readonly<Record<string, Readonly<{
        summary: DiscussionRepositoryThreadSnapshot['summary'];
        messages: DiscussionRepositoryThreadSnapshot['messages'];
        revoked: boolean;
    }> | undefined>>;
}>;

type DiscussionComposerSnapshot = Readonly<{
    thread: DiscussionRepositoryThreadSnapshot | null;
    mutations: DiscussionRepositorySnapshot['mutations'];
}>;

/** A mounted inline composer reads only its thread and posts, never unrelated Home arrivals. */
export function useDiscussionComposerSnapshot(repository: DiscussionRepository, discussionId: string): DiscussionComposerSnapshot {
    const source = React.useMemo(() => {
        let previous: DiscussionComposerSnapshot | null = null;
        let mutationSource: DiscussionRepositorySnapshot['mutations'] | null = null;
        const read = () => {
            const snapshot = repository.getSnapshot();
            const thread = snapshot.threads[discussionId] ?? null;
            let mutations = previous?.mutations ?? {};
            if (mutationSource !== snapshot.mutations) {
                const next = Object.fromEntries(Object.entries(snapshot.mutations)
                    .filter(([, mutation]) => mutation.kind === 'post' && mutation.discussionId === discussionId));
                if (Object.keys(next).length !== Object.keys(mutations).length
                    || Object.entries(next).some(([key, mutation]) => mutations[key] !== mutation)) mutations = next;
                mutationSource = snapshot.mutations;
            }
            if (!previous || previous.thread !== thread || previous.mutations !== mutations) previous = { thread, mutations };
            return previous;
        };
        return { read, subscribe: repository.subscribe };
    }, [discussionId, repository]);
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}

/** A Doc consumes only its admitted query and the thread facts that its passage projection reads. */
export function useDiscussionDocSnapshot(repository: DiscussionRepository | null, artifactId: string): DiscussionDocSnapshot | null {
    const source = React.useMemo(() => {
        let previous: DiscussionDocSnapshot | null = null;
        const read = () => {
            if (!repository) return null;
            const query = repository.getDocListSnapshot(artifactId);
            const threads = repository.getSnapshot().threads;
            const current = previous;
            if (current?.query === query && query.items.every(summary => {
                const before = current.threads[summary.id];
                const next = threads[summary.id];
                return before?.summary === next?.summary && before?.messages === next?.messages
                    && (before?.revoked ?? false) === (next?.status === 'revoked');
            })) return previous;
            previous = { query, threads: Object.fromEntries(query.items.map(summary => {
                const thread = threads[summary.id];
                return [summary.id, thread ? { summary: thread.summary, messages: thread.messages, revoked: thread.status === 'revoked' } : undefined] as const;
            })) };
            return previous;
        };
        return { read, subscribe: repository?.subscribe ?? (() => () => {}) };
    }, [artifactId, repository]);
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}

/** Observe both lists and archived existence for the selected Discussion scope. */
export function useDiscussionCollectionSnapshot(
    repository: DiscussionRepository,
    scope?: DiscussionListScope,
): DiscussionRepositoryCollectionSnapshot {
    const read = React.useCallback(() => repository.getListSnapshot(scope), [repository, scope]);
    return React.useSyncExternalStore(repository.subscribe, read, read);
}

export function useDiscussionActiveListSnapshot(repository: DiscussionRepository, anchorSessionId?: string): DiscussionRepositoryListSnapshot;
export function useDiscussionActiveListSnapshot(repository: DiscussionRepository | null, anchorSessionId?: string): DiscussionRepositoryListSnapshot | null;
export function useDiscussionActiveListSnapshot(
    repository: DiscussionRepository | null,
    anchorSessionId?: string,
): DiscussionRepositoryListSnapshot | null {
    const read = React.useCallback(() => repository?.getListSnapshot(anchorSessionId).lists.active ?? null, [repository, anchorSessionId]);
    return React.useSyncExternalStore(repository?.subscribe ?? subscribeWithoutRepository, read, read);
}

/** Observe the entire Home Discussion repository when the consumer needs multiple domains. */
export function useDiscussionRepositorySnapshot(repository: DiscussionRepository): DiscussionRepositorySnapshot;
export function useDiscussionRepositorySnapshot(repository: DiscussionRepository | null): DiscussionRepositorySnapshot | null;
export function useDiscussionRepositorySnapshot(
    repository: DiscussionRepository | null,
): DiscussionRepositorySnapshot | null {
    return React.useSyncExternalStore(
        repository?.subscribe ?? subscribeWithoutRepository,
        repository?.getSnapshot ?? readWithoutRepository,
        repository?.getSnapshot ?? readWithoutRepository,
    );
}

const subscribeWithoutRepository = () => () => {};
const readWithoutRepository = () => null;

function readDiscussionSnapshotTitle(snapshot: DiscussionRepositorySnapshot | undefined, discussionId: string): string | null {
    const summary = snapshot?.lists.active.items.find(row => row.id === discussionId)
        ?? snapshot?.lists.archived.items.find(row => row.id === discussionId)
        ?? snapshot?.threads[discussionId]?.summary;
    return summary?.title ?? null;
}

/** A non-fetching snapshot only for the proven active Home/Account; other Homes need a live binding. */
export function readDiscussionTitle(address: Readonly<{ serverId: string | null; discussionId: string }>): string | null {
    const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
    const scope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), serverId);
    if (!scope) return null;
    return readDiscussionSnapshotTitle(readRegisteredDiscussionRepository(scope, { ...address, serverId })?.getSnapshot(), address.discussionId);
}

/** Narrow, non-fetching title projection for every strip; message/read-state updates retain its identity. */
export function useDiscussionTitleProjections(addresses: readonly Readonly<{
    serverId: string | null;
    discussionId: string;
}>[]): readonly (string | null)[] {
    const serverIds = React.useMemo(() => addresses.map(address => address.serverId), [addresses]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const source = React.useMemo(() => {
        const entries = addresses.map(address => {
            const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
            return { ...address, serverId, binding: bindings.get(serverId) };
        });
        let titles: readonly (string | null)[] = [];
        const read = () => {
            const next = entries.map(entry => {
                if (!entry.binding?.isCurrent()) return null;
                const snapshot = readRegisteredDiscussionRepository(entry.binding.scope, entry)?.getSnapshot();
                return readDiscussionSnapshotTitle(snapshot, entry.discussionId);
            });
            if (next.length !== titles.length || next.some((title, index) => title !== titles[index])) titles = next;
            return titles;
        };
        return { read, subscribe: (listener: () => void) => {
            const subscribed = new Set<string>();
            const disposals: Array<() => void> = [];
            for (const entry of entries) {
                if (!entry.binding?.isCurrent()) continue;
                const key = JSON.stringify([entry.serverId, entry.binding.accountId]);
                if (subscribed.has(key)) continue;
                subscribed.add(key);
                disposals.push(subscribeRegisteredDiscussionRepository(entry.binding.scope, entry, listener));
                const retirement = entry.binding.onRetire(listener);
                disposals.push(() => retirement.dispose());
            }
            return () => { for (const dispose of disposals) dispose(); };
        } };
    }, [addresses, bindings]);
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}

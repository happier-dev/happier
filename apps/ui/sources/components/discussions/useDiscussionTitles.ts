import * as React from 'react';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useSessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';

const NO_TITLES: ReadonlyMap<string, string> = new Map();
const NO_SERVER_IDS: readonly string[] = Object.freeze([]);
const NO_IDS: ReadonlySet<string> = new Set();

export type DiscussionTitleReadings = Readonly<{
    titles: ReadonlyMap<string, string>;
    /** Ids whose title is still being read: neither named nor yet known to be unreadable. */
    resolving: ReadonlySet<string>;
}>;

export function useDiscussionTitles(input: Readonly<{
    address: DiscussionHomeAddress | null;
    discussionIds: readonly string[];
}>): ReadonlyMap<string, string> {
    return useDiscussionTitleReadings(input).titles;
}

/**
 * The titles of Home conversations, for surfaces that name one without opening it:
 * an Agent conversation says it came "from Relay retry plan".
 *
 * Reads the one shared Home/Account Discussion repository (the list and Details surfaces use the
 * same instance), so a title is never fetched or decrypted twice. It subscribes only while it has
 * ids to name, and asks the repository for a discussion it has not seen yet exactly once; a title
 * that stays unknown (feature off, encrypted, access removed) is simply absent and the caller falls
 * back to a generic origin.
 */
export function useDiscussionTitleReadings(input: Readonly<{
    address: DiscussionHomeAddress | null;
    discussionIds: readonly string[];
}>): DiscussionTitleReadings {
    const serverId = input.address?.serverId ?? '';
    const wanted = input.address !== null && input.discussionIds.length > 0;
    const requestedServerIds = React.useMemo(() => wanted ? [serverId] : NO_SERVER_IDS, [serverId, wanted]);
    const scopeStates = useServerCredentialAccountScopeStates(requestedServerIds);
    const scopeState = [...scopeStates.values()][0];
    const binding = scopeState?.binding ?? null;
    // Supplementary title acquisition is data admission, not presentation; do not start it until support is settled.
    const availability = useSessionCollaborationAvailabilityState(serverId);
    const conversations = useFeatureDecision('sessions.conversations', { scopeKind: 'spawn', serverId });
    const enabled = conversations?.state === 'enabled';
    // Support that has not settled yet is a read in flight, not an unreadable title.
    const supportResolving = wanted && (availability === 'loading'
        || availability === 'available' && (conversations === null
            || enabled && (!scopeState || scopeState.resolution.kind === 'resolving' || scopeState.resolution.kind === 'bound' && !binding)));
    const address = input.address;
    const repository = React.useMemo(() => {
        if (!wanted || !address || !binding || !enabled || availability !== 'available') return null;
        return getDiscussionRepository({
            scope: binding.scope,
            address,
            client: createDiscussionClient({ scope: binding.scope, availability: 'available' }),
            accountLifetime: binding,
        });
    }, [address, availability, binding, enabled, wanted]);
    const idsKey = input.discussionIds.join('\u0000');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the id set, not the array identity
    const discussionIds = React.useMemo(() => input.discussionIds, [idsKey]);
    React.useEffect(() => {
        if (!repository) return;
        const disposals = discussionIds.map(discussionId => repository.mount({ discussionId, projection: 'summary' }));
        return () => { for (const dispose of disposals) dispose(); };
    }, [discussionIds, repository]);
    const addresses = React.useMemo(() => repository ? discussionIds.map(discussionId => ({ serverId, discussionId })) : [], [discussionIds, repository, serverId]);
    const projected = useDiscussionTitleProjections(addresses);
    const titles = React.useMemo(() => {
        if (!repository) return NO_TITLES;
        return new Map(discussionIds.flatMap((id, index): Array<readonly [string, string]> => {
            const title = projected[index]?.trim();
            return title ? [[id, title]] : [];
        }));
    }, [discussionIds, projected, repository]);

    const requested = React.useRef(new Set<string>());
    // The repository whose reads settled these ids: a replaced repository starts with none settled.
    const [settled, setSettled] = React.useState<Readonly<{ repository: typeof repository; ids: ReadonlySet<string> }>>({ repository, ids: NO_IDS });
    const markSettled = React.useCallback((owner: NonNullable<typeof repository>, discussionId: string) => setSettled(previous => {
        const ids = previous.repository === owner ? previous.ids : NO_IDS;
        return ids.has(discussionId) ? previous : { repository: owner, ids: new Set(ids).add(discussionId) };
    }), []);
    React.useEffect(() => {
        requested.current = new Set();
    }, [repository]);
    React.useEffect(() => {
        if (!repository) return;
        for (const discussionId of discussionIds) {
            if (titles.has(discussionId) || requested.current.has(discussionId)) continue;
            requested.current.add(discussionId);
            // A thread the repository already holds has had its read; only a cold one is fetched.
            if (repository.getSnapshot().threads[discussionId]) markSettled(repository, discussionId);
            else void repository.refreshSummary(discussionId).finally(() => markSettled(repository, discussionId));
        }
    }, [discussionIds, markSettled, repository, titles]);

    const settledIds = settled.repository === repository ? settled.ids : NO_IDS;
    const resolvingKey = wanted && (supportResolving || repository)
        ? discussionIds.filter(id => !titles.has(id) && (supportResolving || !settledIds.has(id))).join('\u0000') : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the resolving id set, not its array identity
    const resolving = React.useMemo(() => resolvingKey ? new Set(resolvingKey.split('\u0000')) : NO_IDS, [resolvingKey]);
    return React.useMemo(() => ({ titles, resolving }), [titles, resolving]);
}

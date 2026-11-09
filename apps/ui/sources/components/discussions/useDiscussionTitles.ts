import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';

const NO_TITLES: ReadonlyMap<string, string> = new Map();
const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

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
export function useDiscussionTitles(input: Readonly<{
    address: DiscussionHomeAddress | null;
    discussionIds: readonly string[];
}>): ReadonlyMap<string, string> {
    const serverId = input.address?.serverId ?? '';
    const wanted = input.address !== null && input.discussionIds.length > 0;
    const requestedServerIds = React.useMemo(() => wanted ? [serverId] : NO_SERVER_IDS, [serverId, wanted]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    // Supplementary title acquisition is data admission, not presentation; do not start it until support is settled.
    const availability = useSessionCollaborationAvailability(serverId);
    const enabled = useFeatureEnabled('sessions.conversations', { scopeKind: 'spawn', serverId });
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
    React.useEffect(() => {
        requested.current = new Set();
    }, [repository]);
    React.useEffect(() => {
        if (!repository) return;
        for (const discussionId of discussionIds) {
            if (titles.has(discussionId) || requested.current.has(discussionId)) continue;
            if (repository.getSnapshot().threads[discussionId]) continue;
            requested.current.add(discussionId);
            void repository.refreshSummary(discussionId);
        }
    }, [discussionIds, repository, titles]);

    return titles;
}

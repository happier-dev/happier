import { SessionListMembershipFilterV1Schema, type SessionAudienceSelectionV1, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

function audienceIdentity(audience: SessionAudienceSelectionV1): readonly string[] {
    if (audience.kind === 'outside_teams') return ['outside_teams'];
    if (audience.kind === 'team') return ['team', audience.teamId];
    return ['group', audience.teamId, audience.groupId];
}

function sortedIdentities(values: readonly (readonly string[])[]): string[][] {
    return values
        .map((value) => [...value])
        .sort((left, right) => {
            const a = JSON.stringify(left);
            const b = JSON.stringify(right);
            return a < b ? -1 : a > b ? 1 : 0;
        });
}

/**
 * Stable identity for one Home's complete filtered-listing corpus.
 *
 * Set-like selectors are normalized here, so the order in which a person picked
 * Teams or tags never becomes a second corpus. Page policy — `limit` and the two
 * cursor families — is deliberately absent: it selects how much of the corpus has
 * been loaded, not which corpus is being loaded.
 */
export function buildSessionListQueryKey(serverIdRaw: string, query: SessionListQueryV1): string {
    const serverId = serverIdRaw.trim();
    return JSON.stringify([
        serverId,
        query.storage,
        query.includeInactive,
        query.scope,
        query.attention,
        sortedIdentities(query.audiences.map(audienceIdentity)),
        [...query.tagIds].sort(),
        query.includeAttention === true,
        ...(query.coordinator === undefined ? [] : [{ coordinator: query.coordinator }]),
        ...(query.underSessionId === undefined ? [] : [query.underSessionId]),
        ...(query.folderIds?.length ? [{ folderIds: [...new Set(query.folderIds)].sort() }] : []),
        ...(query.projectKeys && (query.projectKeys.include.length || query.projectKeys.exclude.length) ? [{ projectKeys: {
            include: [...new Set(query.projectKeys.include)].sort(), exclude: [...new Set(query.projectKeys.exclude)].sort(),
        } }] : []),
        ...(query.membership ? [{ membership: {
            mode: query.membership.mode,
            tagIds: [...new Set(query.membership.tagIds)].sort(),
            ...(query.membership.filter ? { filter: SessionListMembershipFilterV1Schema.parse(query.membership.filter) } : {}),
        } }] : []),
    ]);
}

import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { ChangeKindSchema } from '@happier-dev/protocol/changes';
import { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

function hasFollowConfigurationEntity(ids: HomeAccountChangeEvent['entityIds']): boolean {
    return ids === undefined || ids.includes(ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID) || ids.includes('self');
}

/** Private Account configuration does not depend on the Session/filter corpus. */
export function isAccountFollowConfigurationChangeRelevant(event: HomeAccountChangeEvent): boolean {
    const kinds = event.changeKinds;
    return event.source === 'connected' || kinds === undefined || kinds.some(kind => !ChangeKindSchema.options.some(known => known === kind))
        || (kinds.includes('account') && hasFollowConfigurationEntity(event.entityIds));
}

/** Domain relevance only; each captured Follow lifetime checks the Home and Account. */
export function isSessionFollowAccountChangeRelevant(
    event: HomeAccountChangeEvent,
    sessionIds?: ReadonlySet<string>,
): boolean {
    const ids = event.entityIds;
    const kinds = event.changeKinds;
    // A rule preview admits future sources too; its corpus cannot be restricted to today's matches.
    if (kinds === undefined) return sessionIds === undefined || ids === undefined || ids.some(id => sessionIds.has(id) || id === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID || id === 'self');
    // The canonical list planner also knows membership changes such as tag
    // organization. Reuse its positive fact instead of another KV-key catalog.
    if (sessionIds === undefined && (event.sessionListQueryAffects === true || event.sessionListQueryAffects === 'structural')) return true;
    const projectChanged = sessionIds === undefined && (ids === undefined || ids.some(id => id.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1)));
    if (projectChanged && kinds.some(kind => kind === 'kv')) return true;
    if (kinds.some(kind => kind === 'account')
        && (hasFollowConfigurationEntity(ids) || projectChanged)) return true;
    // Corpus consumers need membership/filter facts, not transcript arrivals.
    // Exact-source readers still refresh their pending/delivery detail. Unknown
    // and structural hints remain conservative; access changes are independent.
    return kinds.some(kind => kind === 'share' || (kind === 'session'
        && (sessionIds !== undefined || event.sessionListQueryAffects !== false)))
        && (sessionIds === undefined || ids === undefined || ids.some(id => sessionIds.has(id)));
}

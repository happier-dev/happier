import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

/** GET pages cannot silently broaden a structurally selected query. */
export function canSessionListOrdinaryPageAnswerQuery(query: SessionListQueryV1): boolean {
    return !hasSessionListRowSelection(query) && query.scope === 'my_work';
}

function hasSessionListRowSelection(query: SessionListQueryV1): boolean {
    return query.membership !== undefined
        || query.audiences.length > 0
        || query.underSessionId !== undefined
        || query.coordinator !== undefined
        || query.tagIds.length > 0
        || Boolean(query.folderIds?.length)
        || Boolean(query.projectKeys?.include.length || query.projectKeys?.exclude.length)
        || query.attention !== 'any';
}

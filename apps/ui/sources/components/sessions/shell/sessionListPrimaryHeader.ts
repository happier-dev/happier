import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

type SessionListHeaderKind = Extract<SessionListIndexItem, { type: 'header' }>['headerKind'];

const SESSION_LIST_PRIMARY_HEADER_KINDS = new Set<SessionListHeaderKind>([
    'attention',
    'working',
    'pinned',
    'active',
    'inactive',
    'sessions',
]);

export function isSessionListPrimaryHeaderKind(headerKind: SessionListHeaderKind | null | undefined): boolean {
    return typeof headerKind === 'string' && SESSION_LIST_PRIMARY_HEADER_KINDS.has(headerKind);
}

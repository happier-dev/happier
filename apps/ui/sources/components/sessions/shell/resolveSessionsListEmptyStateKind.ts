import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

type SessionsListGuidanceEmptyStateKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon' | 'select_session'
>;

export type SessionsListEmptyStateKind = SessionsListGuidanceEmptyStateKind | 'external';

export function resolveSessionsListEmptyStateKind(
    kind: SessionGettingStartedDecisionKind,
    storageFilter: SessionListStorageFilter,
): SessionsListEmptyStateKind | null {
    if (storageFilter === 'direct') return 'external';
    if (kind === 'create_session' || kind === 'connect_machine' || kind === 'start_daemon' || kind === 'select_session') {
        return kind;
    }
    return null;
}

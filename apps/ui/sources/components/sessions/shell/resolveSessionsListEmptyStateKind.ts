import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';

type SessionsListEmptyStateKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon' | 'select_session'
>;

export function resolveSessionsListEmptyStateKind(kind: SessionGettingStartedDecisionKind): SessionsListEmptyStateKind | null {
    if (kind === 'create_session' || kind === 'connect_machine' || kind === 'start_daemon' || kind === 'select_session') {
        return kind;
    }
    return null;
}

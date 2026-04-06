import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';

type SessionsListEmptyStateKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon'
>;

export function resolveSessionsListEmptyStateKind(kind: SessionGettingStartedDecisionKind): SessionsListEmptyStateKind | null {
    if (kind === 'create_session' || kind === 'connect_machine' || kind === 'start_daemon') {
        return kind;
    }
    return null;
}

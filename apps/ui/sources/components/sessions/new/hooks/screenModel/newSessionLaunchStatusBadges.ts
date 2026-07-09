import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';

type NewSessionLaunchStatusBadgeParams = Readonly<{
    isCreating: boolean;
    translate: (key: 'newSession.startingSession') => string;
}>;

export function buildNewSessionLaunchStatusBadges(
    params: NewSessionLaunchStatusBadgeParams,
): ReadonlyArray<AgentInputStatusBadge> {
    if (!params.isCreating) {
        return [];
    }

    const label = params.translate('newSession.startingSession');
    return [{
        key: 'new-session-launch-starting',
        label,
        accessibilityLabel: label,
        testID: 'new-session-launch-status',
        tone: 'active',
        emphasis: 'prominent',
    }];
}

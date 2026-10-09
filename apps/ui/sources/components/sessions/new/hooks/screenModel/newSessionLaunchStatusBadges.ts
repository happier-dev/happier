import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { buildRequesterDisclosureStatusBadge, type RequesterDisclosureModel } from '@/components/machines/managed/managedComposerBadges';

type NewSessionLaunchStatusBadgeParams = Readonly<{
    isCreating: boolean;
    disabledReason?: string | null;
    requesterDisclosure?: RequesterDisclosureModel;
    translate: (key: 'newSession.startingSession') => string;
}>;

export function buildNewSessionLaunchStatusBadges(
    params: NewSessionLaunchStatusBadgeParams,
): ReadonlyArray<AgentInputStatusBadge> {
    const disclosure: ReadonlyArray<AgentInputStatusBadge> = params.requesterDisclosure
        ? [buildRequesterDisclosureStatusBadge(params.requesterDisclosure)] : [];
    if (!params.isCreating) {
        return params.disabledReason ? [...disclosure, {
            key: 'new-session-create-blocked',
            label: params.disabledReason,
            labelNumberOfLines: 0,
            accessibilityLabel: params.disabledReason,
            testID: 'new-session-create-blocked',
            tone: 'warning',
            emphasis: 'prominent',
        }] : disclosure;
    }

    const label = params.translate('newSession.startingSession');
    return [...disclosure, {
        key: 'new-session-launch-starting',
        label,
        accessibilityLabel: label,
        testID: 'new-session-launch-status',
        tone: 'active',
        emphasis: 'prominent',
    }];
}

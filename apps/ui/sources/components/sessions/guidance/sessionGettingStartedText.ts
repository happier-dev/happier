import { t } from '@/text';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';

export function getSessionGettingStartedTitle(kind: SessionGettingStartedDecisionKind): string {
    switch (kind) {
        case 'connect_machine':
            return t('sessionGettingStarted.title.connectMachine');
        case 'start_daemon':
            return t('sessionGettingStarted.title.startDaemon');
        case 'create_session':
            return t('sessionGettingStarted.title.createSession');
        case 'select_session':
            return t('sessionGettingStarted.title.selectSession');
        case 'loading':
        default:
            return t('sessionGettingStarted.title.loading');
    }
}

export function getSessionGettingStartedSubtitle(
    kind: SessionGettingStartedDecisionKind,
    targetLabel: string,
): string {
    switch (kind) {
        case 'connect_machine':
            return t('sessionGettingStarted.subtitle.connectMachine', { targetLabel });
        case 'start_daemon':
            return t('sessionGettingStarted.subtitle.startDaemon', { targetLabel });
        case 'create_session':
            return t('sessionGettingStarted.subtitle.createSession');
        case 'select_session':
            return t('sessionGettingStarted.subtitle.selectSession');
        case 'loading':
        default:
            return t('sessionGettingStarted.subtitle.loading');
    }
}

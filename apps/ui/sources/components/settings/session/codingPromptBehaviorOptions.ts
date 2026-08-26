import type {
    CodingPromptBehaviorModeV1,
    CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol';

import { t } from '@/text';

export function getCodingPromptTitleUpdatesModeItems(): ReadonlyArray<Readonly<{
    id: CodingPromptSessionTitleUpdatesModeV1;
    title: string;
    subtitle: string;
}>> {
    return [
        {
            id: 'disabled',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsNeverSubtitle'),
        },
        {
            id: 'initial',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSubtitle'),
        },
        {
            id: 'ongoing',
            title: t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingTitle'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSubtitle'),
        },
    ];
}

export function getCodingPromptResponseOptionsModeItems(): ReadonlyArray<Readonly<{
    id: CodingPromptBehaviorModeV1;
    title: string;
    subtitle: string;
}>> {
    return [
        {
            id: 'agent',
            title: t('common.enabled'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle'),
        },
        {
            id: 'disabled',
            title: t('common.disabled'),
            subtitle: t('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle'),
        },
    ];
}

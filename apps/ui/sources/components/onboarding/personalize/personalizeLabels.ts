import type { ThinkingDisplayChoice } from '@/components/settings/session/thinkingDisplayChoice';
import type { GlassMaterialChoice } from '@/components/ui/glass/glassMaterial';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { t } from '@/text';

import type {
    AttentionPlacementChoice,
    ListDensityChoice,
    PersonalizeChoices,
    PersonalizeStepId,
    StartingStyleField,
    StartingStyleId,
    ThemeModeChoice,
    ToolChromeChoice,
} from './personalizeFlowModel';

/**
 * The words the flow uses for each value. They are the settings pages' own labels, so the flow,
 * its summary and Settings always name a choice the same way.
 */
export const personalizeLabels = {
    theme: (value: ThemeModeChoice) => value === 'adaptive'
        ? t('settingsAppearance.themeOptions.adaptive')
        : value === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark'),
    glass: (value: GlassMaterialChoice) => value === 'solid' ? t('settingsAppearance.glassControls.solid')
        : value === 'auto' ? t('settingsAppearance.glassControls.auto')
            : value === 'everywhere' ? t('settingsAppearance.glassControls.everywhere') : t('settingsAppearance.glassControls.custom'),
    transcriptLayout: (value: 'turns' | 'linear') => value === 'turns'
        ? t('settingsSession.transcript.layout.turnsTitle')
        : t('settingsSession.transcript.layout.linearTitle'),
    thinking: (value: ThinkingDisplayChoice) => value === 'inline_summary' ? t('settingsSessionPages.transcript.thinkingSummary')
        : value === 'inline_full' ? t('settingsSessionPages.transcript.thinkingFull')
            : value === 'tool' ? t('settingsSession.thinking.displayMode.toolTitle') : t('settingsSession.thinking.displayMode.hiddenTitle'),
    toolChrome: (value: ToolChromeChoice) => value === 'cards'
        ? t('settingsSession.toolRendering.timelineChrome.cardsTitle')
        : t('settingsSession.toolRendering.timelineChrome.activityFeedTitle'),
    toolDetail: (value: string) => value === 'full' ? t('personalize.toolDetailFull') : t('personalize.toolDetailDefault'),
    toolTap: (value: 'expand' | 'open') => value === 'open'
        ? t('settingsSession.toolRendering.activityFeed.tapAction.openTitle')
        : t('settingsSession.toolRendering.activityFeed.tapAction.expandTitle'),
    listLayout: (value: SessionListLayoutChoice) => value === 'projects' ? t('settingsSession.sessionList.layoutProjectsTitle')
        : value === 'recent_activity' ? t('settingsSession.sessionList.layoutRecentActivityTitle') : t('settingsSession.sessionList.layoutActiveInactiveTitle'),
    listDensity: (value: ListDensityChoice) => value === 'detailed' ? t('settingsAppearance.sessionListDensity.detailed')
        : value === 'cozy' ? t('settingsAppearance.sessionListDensity.cozy') : t('settingsAppearance.sessionListDensity.narrow'),
    attention: (value: AttentionPlacementChoice) => value === 'off' ? t('settingsSession.sessionList.placementInPlaceTitle')
        : value === 'withinGroups' ? t('settingsSession.sessionList.placementWithinGroupsTitle') : t('settingsSession.sessionList.placementAtTopTitle'),
    style: (value: StartingStyleId) => value === 'activity' ? t('personalize.styleActivity')
        : value === 'conversation' ? t('personalize.styleConversation') : t('personalize.styleDetail'),
};

/** The short name of each step ("Look", "Your work"). */
export function personalizeStepName(step: PersonalizeStepId): string {
    switch (step) {
        case 'look': return t('personalize.lookName');
        case 'conversation': return t('personalize.conversationName');
        case 'tools': return t('personalize.toolsName');
        case 'work': return t('personalize.workName');
        case 'attention': return t('personalize.attentionName');
        case 'notifications': return t('personalize.notificationsName');
    }
}

/** A starting-style field's row label in the change list. */
export function personalizeStyleFieldLabel(field: StartingStyleField): string {
    switch (field) {
        case 'transcriptLayout': return t('personalize.layoutLabel');
        case 'thinking': return t('personalize.thinkingLabel');
        case 'toolChrome': return t('personalize.toolsLabel');
        case 'toolDetail': return t('personalize.toolDetailLabel');
        case 'listDensity': return t('personalize.rowsLabel');
    }
}

export function personalizeStyleFieldValue(field: StartingStyleField, value: string): string {
    switch (field) {
        case 'transcriptLayout': return personalizeLabels.transcriptLayout(value as 'turns' | 'linear');
        case 'thinking': return personalizeLabels.thinking(value as ThinkingDisplayChoice);
        case 'toolChrome': return personalizeLabels.toolChrome(value as ToolChromeChoice);
        case 'toolDetail': return personalizeLabels.toolDetail(value);
        case 'listDensity': return personalizeLabels.listDensity(value as ListDensityChoice);
    }
}

/** One line describing a step's choices, for the summary ("Turns · Summary"). */
export function describePersonalizeStep(step: PersonalizeStepId, choices: PersonalizeChoices): string {
    switch (step) {
        case 'look': return `${personalizeLabels.theme(choices.theme)} · ${t('personalize.glassLabel')} ${personalizeLabels.glass(choices.glass)}`;
        case 'conversation': return `${personalizeLabels.transcriptLayout(choices.transcriptLayout)} · ${personalizeLabels.thinking(choices.thinking)}`;
        case 'tools': return `${personalizeLabels.toolChrome(choices.toolChrome)} · ${personalizeLabels.toolTap(choices.toolTap)}`;
        case 'work': return `${personalizeLabels.listLayout(choices.listLayout)} · ${personalizeLabels.listDensity(choices.listDensity)}`;
        case 'attention': return personalizeLabels.attention(choices.attention);
        case 'notifications': {
            const events = [
                choices.notifyNeedsYou ? t('personalize.notificationsNeedsYouSummary') : null,
                choices.notifyFinished ? t('personalize.notificationsFinishedSummary') : null,
            ].filter((value): value is string => value !== null);
            if (events.length === 0) return t('personalize.notificationsOff');
            return `${events.join(' · ')} · ${choices.notifyPreview ? t('personalize.notificationsMessage') : t('personalize.notificationsStatus')}`;
        }
    }
}

/** Device-local steps say "This device"; Account preferences follow the person to every device. */
export function personalizeStepScope(step: PersonalizeStepId): string {
    return step === 'look' ? t('personalize.scopeLook')
        : step === 'notifications' ? t('personalize.scopeThisDevice') : t('personalize.scopeAllDevices');
}

import { t } from '@/text';
import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SessionListLayoutChoice, SessionListLayoutSettings } from '@/sync/domains/session/listing/sessionListLayout';

export type SessionListViewOptionDescriptor = Readonly<{ id: string; title: string; subtitle?: string; disabled?: boolean }>;

/** Both hosts consume the effective layout, including a transient Recent visit intent. */
export function resolveSessionListViewOptionsPresentation(
    settings: SessionListLayoutSettings & Readonly<{ sessionListAttentionPlacementV1?: unknown }>,
    effectiveLayout: SessionListLayoutChoice,
) {
    const selectedAttentionPlacement: AccountSettings['sessionListAttentionPlacementV1'] = settings.sessionListAttentionPlacementV1 === 'top' ? 'top'
        : settings.sessionListAttentionPlacementV1 === 'inPlace' ? 'inPlace' : 'both';
    return {
        selectedLayout: effectiveLayout,
        layoutItems: [
            { id: 'layout:projects', title: t('settingsSession.sessionList.layoutProjectsTitle') },
            { id: 'layout:recent_activity', title: t('settingsSession.sessionList.layoutRecentActivityTitle') },
        ] satisfies readonly SessionListViewOptionDescriptor[],
        selectedAttentionPlacement,
        attentionItems: [
            { id: 'attention:both', title: t('settingsSession.sessionList.placementBothTitle') },
            { id: 'attention:top', title: t('settingsSession.sessionList.placementAtTopTitle') },
            { id: 'attention:inPlace', title: t('settingsSession.sessionList.placementInPlaceTitle') },
        ] satisfies readonly SessionListViewOptionDescriptor[],
    };
}

/** The leading mark's choices (lab `clctx:menu`), in the lab's order; Avatar and None stay available. */
export function resolveSessionListIdentityItems(): readonly SessionListViewOptionDescriptor[] {
    return [
        { id: 'identity:auto', title: t('settingsSession.sessionList.identityDisplayAutoTitle') },
        { id: 'identity:agentLogo', title: t('settingsSession.sessionList.identityDisplayAgentLogoTitle') },
        { id: 'identity:project', title: t('settingsSession.sessionList.identityDisplayProjectTitle') },
        { id: 'identity:projectWithAgent', title: t('settingsSession.sessionList.identityDisplayProjectWithAgentTitle') },
        { id: 'identity:agentWithTrailingProject', title: t('settingsSession.sessionList.identityDisplayAgentWithTrailingProjectTitle') },
        { id: 'identity:avatar', title: t('settingsSession.sessionList.identityDisplayAvatarTitle') },
        { id: 'identity:none', title: t('settingsSession.sessionList.identityDisplayNoneTitle') },
    ];
}

/** Row density, from the roomiest to the most compact. */
export function resolveSessionListDensityItems(): readonly SessionListViewOptionDescriptor[] {
    return [
        { id: 'density:detailed', title: t('settingsAppearance.sessionListDensity.detailed') },
        { id: 'density:cozy', title: t('settingsAppearance.sessionListDensity.cozy') },
        { id: 'density:narrow', title: t('settingsAppearance.sessionListDensity.narrow') },
    ];
}

export { resolveSessionListViewOptionSelectionDelta } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';

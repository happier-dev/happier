import { t } from '@/text';
import {
    resolveSessionListLayoutApplicability,
    type SessionListLayoutChoice,
    type SessionListLayoutSettings,
} from '@/sync/domains/session/listing/sessionListLayout';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
} from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import {
    normalizeSessionListFolderSortModeV1,
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

export type SessionListViewOptionDescriptor = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
    disabled?: boolean;
}>;

type SessionListViewOptionsSettings = SessionListLayoutSettings & Readonly<{
    sessionListAttentionPromotionModeV1?: unknown;
    sessionListWorkingPlacementModeV1?: unknown;
    sessionFolderViewModeV1?: unknown;
    sessionListFolderSortModeV1?: unknown;
    foldersFeatureEnabled?: boolean;
}>;

const layoutItems = (): ReadonlyArray<SessionListViewOptionDescriptor & { id: `layout:${SessionListLayoutChoice}` }> => [
    { id: 'layout:projects', title: t('settingsSession.sessionList.layoutProjectsTitle') },
    { id: 'layout:recent_activity', title: t('settingsSession.sessionList.layoutRecentActivityTitle') },
    { id: 'layout:active_inactive', title: t('settingsSession.sessionList.layoutActiveInactiveTitle') },
];

const groupingItems = (section: 'active' | 'inactive'): ReadonlyArray<SessionListViewOptionDescriptor> => [
    {
        id: `grouping:${section}:project`,
        title: t('settingsFeatures.sessionListGrouping.projectTitle'),
        subtitle: t('settingsFeatures.sessionListGrouping.projectSubtitle'),
    },
    {
        id: `grouping:${section}:date`,
        title: t('settingsFeatures.sessionListGrouping.dateTitle'),
        subtitle: t('settingsFeatures.sessionListGrouping.dateSubtitle'),
    },
];

const attentionItems = (): ReadonlyArray<SessionListViewOptionDescriptor> => [
    { id: 'attention:off', title: t('settingsSession.sessionList.placementInPlaceTitle') },
    { id: 'attention:global', title: t('settingsSession.sessionList.placementAtTopTitle') },
    { id: 'attention:withinGroups', title: t('settingsSession.sessionList.placementWithinGroupsTitle') },
];

const workingItems = (): ReadonlyArray<SessionListViewOptionDescriptor> => [
    { id: 'working:off', title: t('settingsSession.sessionList.placementInPlaceTitle') },
    { id: 'working:global', title: t('settingsSession.sessionList.placementAtTopTitle') },
    { id: 'working:withinGroups', title: t('settingsSession.sessionList.placementWithinGroupsTitle') },
];

const orderingItems = (): ReadonlyArray<SessionListViewOptionDescriptor> => [
    { id: 'ordering:custom', title: t('settingsSession.sessionList.orderingOptions.custom') },
    { id: 'ordering:updated', title: t('settingsSession.sessionList.orderingOptions.updated') },
    { id: 'ordering:created', title: t('settingsSession.sessionList.orderingOptions.created') },
];

const folderDisplayItems = (): ReadonlyArray<SessionListViewOptionDescriptor> => [
    { id: 'folderDisplay:off', title: t('settingsSession.sessionList.folderDisplayOffTitle') },
    { id: 'folderDisplay:tree', title: t('settingsSession.sessionList.folderTreeView') },
];

/**
 * Builds View options from the layout that is actually rendering.
 *
 * `effectiveLayout` comes from the one effective-layout reader
 * (`useSessionListLayoutChoice`), so the checkmark, the applicability of the
 * dependent controls and the rows can never disagree.
 */
export function resolveSessionListViewOptionsPresentation(
    settings: SessionListViewOptionsSettings,
    effectiveLayout: SessionListLayoutChoice,
) {
    const selectedLayout = effectiveLayout;
    const applicability = resolveSessionListLayoutApplicability({
        choice: selectedLayout,
        activeGroupingV1: settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: settings.sessionListInactiveGroupingV1,
        folderViewModeV1: settings.sessionFolderViewModeV1,
        foldersFeatureEnabled: settings.foldersFeatureEnabled,
    });
    const selectedOrdering = normalizeSessionListOrderingModeV1(settings.sessionListOrderingModeV1);
    const isDateOrdering = selectedOrdering !== 'custom';
    return {
        selectedLayout,
        layoutItems: layoutItems(),
        showSectionGrouping: applicability.showsAdvancedSectionGrouping,
        activeGroupingItems: groupingItems('active'),
        inactiveGroupingItems: groupingItems('inactive'),
        selectedActiveGroupingId: settings.sessionListActiveGroupingV1 === 'date'
            ? 'grouping:active:date'
            : 'grouping:active:project',
        selectedInactiveGroupingId: settings.sessionListInactiveGroupingV1 === 'project'
            ? 'grouping:inactive:project'
            : 'grouping:inactive:date',
        selectedAttentionPlacement: normalizeSessionListAttentionPlacementMode(
            settings.sessionListAttentionPromotionModeV1,
        ),
        attentionItems: attentionItems(),
        selectedWorkingPlacement: normalizeSessionListWorkingPlacementMode(
            settings.sessionListWorkingPlacementModeV1,
        ),
        workingItems: workingItems(),
        showProjectOrdering: applicability.usesProjectGrouping,
        selectedOrdering,
        orderingItems: orderingItems(),
        showFolderOptions: applicability.usesProjectGrouping && settings.foldersFeatureEnabled === true,
        selectedFolderDisplay: settings.sessionFolderViewModeV1 === 'tree' ? 'tree' : 'off',
        folderDisplayItems: folderDisplayItems(),
        selectedFolderSort: resolveEffectiveSessionListFolderSortMode({
            orderingMode: selectedOrdering,
            folderSortMode: normalizeSessionListFolderSortModeV1(settings.sessionListFolderSortModeV1),
        }),
        folderSortItems: [
            {
                id: 'folderSort:foldersFirst',
                title: t('settingsSession.sessionList.folderSortModeFoldersFirstTitle'),
                subtitle: t('settingsSession.sessionList.folderSortModeFoldersFirstSubtitle'),
            },
            {
                id: 'folderSort:mixed',
                title: t('settingsSession.sessionList.folderSortModeMixedTitle'),
                subtitle: isDateOrdering
                    ? t('settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle')
                    : t('settingsSession.sessionList.folderSortModeMixedSubtitle'),
                disabled: isDateOrdering,
            },
        ] satisfies ReadonlyArray<SessionListViewOptionDescriptor>,
    };
}

export { resolveSessionListViewOptionSelectionDelta } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';

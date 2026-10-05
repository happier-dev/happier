import { defineSettingsPage, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import {
    resolveSessionListLayoutChoice, resolveSessionListLayoutSettingsDelta, SESSION_LIST_LAYOUT_CHOICES, type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';

const isSessionListLayoutChoice = (value: unknown): value is SessionListLayoutChoice =>
    typeof value === 'string' && (SESSION_LIST_LAYOUT_CHOICES as readonly string[]).includes(value);

/** Projects / Recent activity / Active and inactive, read and written by the layout owner (not a raw section key). */
const sessionListLayoutStorageBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    allowedValues: SESSION_LIST_LAYOUT_CHOICES,
    read: settings => resolveSessionListLayoutChoice(settings),
    parse: value => isSessionListLayoutChoice(value) ? { success: true, value } : { success: false },
    mutate: (settings, value) => isSessionListLayoutChoice(value) ? resolveSessionListLayoutSettingsDelta(value, settings) : null,
};

/**
 * The Sessions page's searchable settings. Rows render their labels from these declarations. A row
 * whose subtitle describes its current value declares no description; its choices are keywords.
 */
export const SESSION_SETTINGS = defineSettingsPage({
    pageId: 'session',
    sections: {
        launchDefaults: {
            titleKey: 'settingsSession.rootGroups.launchDefaults.title',
            settings: {
                startWith: { storage: { scope: 'account', key: 'useEnhancedSessionWizard', access: 'read_write' },
                    titleKey: 'settingsSession.sessionCreation.startWithTitle',
                    descriptionKey: 'settingsSession.sessionCreation.startWithDescription',
                    keywordKeys: [
                        'settingsSession.sessionCreation.startWithComposer',
                        'settingsSession.sessionCreation.startWithWizard',
                    ],
                },
                wizardDisposition: {
                    titleKey: 'settingsSession.sessionCreation.wizardDispositionTitle',
                    descriptionKey: 'settingsSession.sessionCreation.wizardDispositionSubtitle',
                },
                rememberProjectSelections: { titleKey: 'settingsSession.sessionCreation.rememberLastProjectSelectionsTitle', storage: { scope: 'account', key: 'rememberLastProjectSessionSelections', access: 'read_write' } },
                rememberEngineSelections: { titleKey: 'settingsSession.sessionCreation.rememberLastEngineSelectionsTitle', storage: { scope: 'account', key: 'rememberLastEngineSelectionsV1', access: 'read_write' } },
            },
        },
        listOrganization: {
            titleKey: 'settingsSession.rootGroups.listOrganization.title',
            settings: {
                listDensity: {
                    titleKey: 'settingsAppearance.sessionListDensity.title',
                    descriptionKey: 'settingsAppearance.sessionListDensity.subtitle',
                    storage: { scope: 'account', key: 'sessionListDensity', access: 'read_write' },
                },
                ordering: {
                    titleKey: 'settingsSession.sessionList.orderingTitle',
                    descriptionKey: 'settingsSession.sessionList.orderingSubtitle',
                },
                folderView: { titleKey: 'settingsSession.sessionList.folderTreeView' },
                folderSort: {
                    titleKey: 'settingsSession.sessionList.folderSortModeTitle',
                    descriptionKey: 'settingsSession.sessionList.folderSortModeSubtitle',
                },
                layout: {
                    titleKey: 'settingsSession.sessionList.layoutTitle',
                    descriptionKey: 'settingsSession.sessionList.layoutSubtitle',
                    storage: sessionListLayoutStorageBinding,
                },
                activeGrouping: {
                    titleKey: 'settingsFeatures.sessionListActiveGrouping',
                    descriptionKey: 'settingsFeatures.sessionListActiveGroupingSubtitle',
                },
                inactiveGrouping: {
                    titleKey: 'settingsFeatures.sessionListInactiveGrouping',
                    descriptionKey: 'settingsFeatures.sessionListInactiveGroupingSubtitle',
                },
                hideInactive: {
                    titleKey: 'settingsFeatures.hideInactiveSessions',
                    descriptionKey: 'settingsFeatures.hideInactiveSessionsSubtitle',
                    storage: { scope: 'account', key: 'hideInactiveSessions', access: 'read_write' },
                },
                rightPaneDefaultOpen: {
                    titleKey: 'settingsAppearance.sessionsRightPaneDefaultOpen',
                    descriptionKey: 'settingsAppearance.sessionsRightPaneDefaultOpenDescription',
                    storage: { scope: 'local', key: 'sessionsRightPaneDefaultOpen', access: 'read_write' },
                },
            },
        },
        rowDetails: {
            titleKey: 'settingsSession.rootGroups.rowDetails.title',
            settings: {
                tags: { titleKey: 'settingsSession.sessionList.tagsTitle', storage: { scope: 'account', key: 'sessionTagsEnabled', access: 'read_write' } },
                identityDisplay: {
                    titleKey: 'settingsSession.sessionList.identityDisplayTitle',
                    descriptionKey: 'settingsSession.sessionList.identityDisplaySubtitle',
                    storage: { scope: 'account', key: 'sessionListIdentityDisplay', access: 'read_write' },
                },
                headerIdentityDisplay: {
                    titleKey: 'settingsSession.sessionList.headerIdentityDisplayTitle',
                    descriptionKey: 'settingsSession.sessionList.headerIdentityDisplaySubtitle',
                    storage: { scope: 'account', key: 'sessionHeaderIdentityDisplay', access: 'read_write' },
                },
                activeColor: {
                    titleKey: 'settingsSession.sessionList.activeColorTitle',
                    descriptionKey: 'settingsSession.sessionList.activeColorSubtitle',
                    storage: { scope: 'account', key: 'sessionListActiveColorModeV1', access: 'read_write' },
                },
                workspacePathDisplay: { titleKey: 'settingsSession.sessionList.workspacePathDisplayTitle', storage: { scope: 'account', key: 'workspacePathDisplayModeV1', access: 'read_write' } },
                workspaceFavicons: { titleKey: 'settingsSession.sessionList.workspaceFaviconsTitle', storage: { scope: 'account', key: 'workspaceFaviconsEnabled', access: 'read_write' } },
                workspaceMachineSubtitles: { titleKey: 'settingsSession.sessionList.workspaceMachineSubtitlesTitle', storage: { scope: 'account', key: 'workspaceMachineSubtitlesEnabled', access: 'read_write' } },
            },
        },
        activitySignals: {
            titleKey: 'settingsSession.rootGroups.activitySignals.title',
            settings: {
                workingStatusAnimatedText: { titleKey: 'settingsSession.sessionList.workingStatusAnimatedTextTitle', storage: { scope: 'account', key: 'sessionListWorkingStatusAnimatedTextEnabled', access: 'read_write' } },
                attentionPromotion: {
                    titleKey: 'settingsSession.sessionList.attentionPromotionModeTitle',
                    descriptionKey: 'settingsSession.sessionList.attentionPromotionModeSubtitle',
                    storage: { scope: 'account', key: 'sessionListAttentionPromotionModeV1', access: 'read_write' },
                },
                attentionStandingDefault: { titleKey: 'settingsSession.sessionList.attentionStandingDefaultTitle', storage: { scope: 'account', key: 'sessionListAttentionStandingDefaultV1', access: 'read_write' } },
                workingPlacement: {
                    titleKey: 'settingsSession.sessionList.workingPlacementModeTitle',
                    descriptionKey: 'settingsSession.sessionList.workingPlacementModeSubtitle',
                },
                workingIndicator: { titleKey: 'settingsSession.sessionList.workingIndicatorTitle', storage: { scope: 'account', key: 'sessionListNarrowWorkingIndicatorStyle', access: 'read_write' } },
            },
        },
        mobileLayout: {
            titleKey: 'settingsSession.rootGroups.mobileLayout.title',
            settings: {
                mobileWorkspaceExperience: { titleKey: 'settingsSession.mobileWorkspaceExperience.title', storage: { scope: 'account', key: 'mobileWorkspaceExperienceV1', access: 'read_write' } },
                swipeSideways: {
                    titleKey: 'phoneNav.settings.swipeSidewaysTitle',
                    storage: { scope: 'account', key: 'sessionCockpitSwipeNavigationEnabled', access: 'read_write' },
                },
                alwaysSwipe: {
                    titleKey: 'phoneNav.settings.alwaysSwipeTitle',
                    storage: { scope: 'account', key: 'sessionCockpitSwipeAlwaysSessionsEnabled', access: 'read_write' },
                },
                dragUp: {
                    titleKey: 'phoneNav.settings.dragUpTitle',
                    descriptionKey: 'phoneNav.settings.dragUpDescription',
                    storage: { scope: 'account', key: 'sessionSwitcherDragUpEnabled', access: 'read_write' },
                },
                dragUpSource: {
                    titleKey: 'phoneNav.settings.dragUpSourceTitle',
                    keywordKeys: ['phoneNav.settings.sourceRecent', 'phoneNav.settings.sourceList'],
                    storage: { scope: 'account', key: 'sessionSwitcherDragUpSource', access: 'read_write' },
                },
                swipeSource: {
                    titleKey: 'phoneNav.settings.swipeSourceTitle',
                    keywordKeys: ['phoneNav.settings.sourceList', 'phoneNav.settings.sourceRecent'],
                    storage: { scope: 'account', key: 'sessionCockpitSwipeSource', access: 'read_write' },
                },
                flick: {
                    titleKey: 'phoneNav.settings.flickTitle',
                    descriptionKey: 'phoneNav.settings.flickDescription',
                    storage: { scope: 'account', key: 'sessionSwitcherFlickEnabled', access: 'read_write' },
                },
                holdToDock: {
                    titleKey: 'phoneNav.settings.holdToDockTitle',
                    descriptionKey: 'phoneNav.settings.holdToDockDescription',
                    storage: { scope: 'account', key: 'sessionSwitcherHoldToDockEnabled', access: 'read_write' },
                },
                pullAllTabs: {
                    titleKey: 'phoneNav.settings.pullAllTabsTitle',
                    descriptionKey: 'phoneNav.settings.pullAllTabsDescription',
                    storage: { scope: 'account', key: 'sessionHeaderPullAllTabsEnabled', access: 'read_write' },
                },
            },
        },
        openTabs: {
            titleKey: 'workspaceTabs.sectionTitle',
            settings: {
                syncOpenTabs: {
                    titleKey: 'workspaceTabs.syncTitle',
                    descriptionKey: 'workspaceTabs.syncDescription',
                    storage: { scope: 'account', key: 'workspaceTabsSyncEnabled', access: 'read_write' },
                },
            },
        },
        agentPersonalization: {
            titleKey: 'settingsSession.rootGroups.agentPersonalization.title',
            settings: {
                renameSessions: { titleKey: 'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle' },
                suggestReplyOptions: { titleKey: 'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle' },
            },
        },
        detailedBehavior: {
            titleKey: 'settingsSession.detailedBehavior.title',
            settings: {
                composer: { titleKey: 'settingsSession.composer.title', descriptionKey: 'settingsSession.composer.entrySubtitle' },
                providerLimits: { titleKey: 'settingsSession.providerLimits.title', descriptionKey: 'settingsSession.providerLimits.entrySubtitle' },
                resume: { titleKey: 'settingsSession.resume.title', descriptionKey: 'settingsSession.resume.entrySubtitle' },
                runtime: { titleKey: 'settingsSession.runtime.title', descriptionKey: 'settingsSession.runtime.entrySubtitle' },
            },
        },
    },
});

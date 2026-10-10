import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

import { sessionListLayoutStorageBinding, listChoiceStorage, responseOptionsStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

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
                startWith: {},
                wizardDisposition: {},
                rememberProjectSelections: {},
                rememberEngineSelections: {},
            },
        },
        listOrganization: {
            titleKey: 'settingsSession.rootGroups.listOrganization.title',
            settings: {
                listDensity: {},
                ordering: {
                    storage: listChoiceStorage('sessionListOrderingModeV1', 'ordering'),

                },
                folderView: { storage: listChoiceStorage('sessionFolderViewModeV1', 'folderDisplay') },
                folderSort: {
                    storage: listChoiceStorage('sessionListFolderSortModeV1', 'folderSort'),

                },
                layout: {

                    storage: sessionListLayoutStorageBinding,
                },
                activeGrouping: {
                    storage: listChoiceStorage('sessionListActiveGroupingV1', 'grouping:active'),

                },
                inactiveGrouping: {
                    storage: listChoiceStorage('sessionListInactiveGroupingV1', 'grouping:inactive'),

                },
                hideInactive: {},
                rightPaneDefaultOpen: {},
            },
        },
        rowDetails: {
            titleKey: 'settingsSession.rootGroups.rowDetails.title',
            settings: {
                tags: {},
                identityDisplay: {},
                headerIdentityDisplay: {},
                activeColor: {},
                workspacePathDisplay: {},
                workspaceFavicons: {},
                workspaceMachineSubtitles: {},
            },
        },
        activitySignals: {
            titleKey: 'settingsSession.rootGroups.activitySignals.title',
            settings: {
                workingStatusAnimatedText: {},
                attentionPromotion: {},
                reminderAutoClearOnOpen: {},
                attentionStandingDefault: {},
                workingPlacement: {
                    storage: listChoiceStorage('sessionListWorkingPlacementModeV1', 'working'),

                },
                workingIndicator: {},
            },
        },
        mobileLayout: {
            titleKey: 'settingsSession.rootGroups.mobileLayout.title',
            settings: {
                mobileWorkspaceExperience: {},
                swipeSideways: {},
                alwaysSwipe: {},
                dragUp: {},
                dragUpSource: {},
                swipeSource: {},
                flick: {},
                holdToDock: {},
                pullAllTabs: {},
            },
        },
        openTabs: {
            titleKey: 'workspaceTabs.sectionTitle',
            settings: {
                syncOpenTabs: {},
            },
        },
        agentPersonalization: {
            titleKey: 'settingsSession.rootGroups.agentPersonalization.title',
            settings: {
                renameSessions: {},
                suggestReplyOptions: { storage: responseOptionsStorage },
            },
        },
        detailedBehavior: {
            titleKey: 'settingsSession.detailedBehavior.title',
            settings: {
                composer: {},
                providerLimits: {},
                resume: {},
                runtime: {},
            },
        },
    },
});

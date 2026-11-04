import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { sessionListDisclosureBinding } from './sessionListDisclosureBinding';

import { responseOptionsStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

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
        mcpServersReliability: {
            titleKey: 'mcpSettings.failureSection',
            settings: {
                mcpServersStrictMode: {},
            },
        },
        listOrganization: {
            titleKey: 'settingsSession.rootGroups.listOrganization.title',
            settings: {
                listDensity: { anchor: 'session.list.density' },
                layout: { anchor: 'session.list.layout' },
                attentionPromotion: { anchor: 'session.list.attentionPlacement' },
                hideInactive: { anchor: 'session.list.hideInactive' },
                collapsedGroups: { anchor: 'session.list.collapsedGroups', storage: sessionListDisclosureBinding },
                rightPaneDefaultOpen: {},
            },
        },
        rowDetails: {
            titleKey: 'settingsSession.rootGroups.rowDetails.title',
            settings: {
                tags: { anchor: 'session.list.tags' },
                rowContext: { anchor: 'session.list.rowContext' },
                statusWords: { anchor: 'session.list.statusWords' },
                identityDisplay: { anchor: 'session.list.identity' },
                headerIdentityDisplay: {},
                activeColor: { anchor: 'session.list.activeColor' },
                workspaceFavicons: { anchor: 'session.list.workspaceFavicons' },
                workspaceMachineSubtitles: {},
            },
        },
        activitySignals: {
            titleKey: 'settingsSession.rootGroups.activitySignals.title',
            settings: {
                backgroundWorkAttention: { anchor: 'session.list.backgroundWorkAttention' },
                reminderAutoClearOnOpen: {},
                attentionStandingDefault: { anchor: 'session.list.attentionStandingDefault' },
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
                suggestCompaction: {},
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

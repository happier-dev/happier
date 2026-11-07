import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
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

/**
 * Sections (Settings → Sessions → Sections): the organizer over the section Actions. Its anchor is the
 * page's navigation target; each row's controls dispatch `session.sections.*`, never a settings write.
 */
export const SESSION_SECTIONS_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'sections', route: SETTINGS_ROUTES.sessionSections, titleKey: 'sessionsList.sectionsMenuTitle', anchors: 'page' },
    sections: {
        sections: {
            titleKey: 'sessionsList.sectionsMenuTitle',
            settings: {
                sections: { anchor: 'session.list.sections' },
            },
        },
    },
});

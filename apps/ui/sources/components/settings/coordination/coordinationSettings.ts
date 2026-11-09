import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `coordination` page. Rows render their labels from these declarations. */
export const COORDINATION_SETTINGS = defineSettingsPage({
    pageId: 'coordination',
    sections: {
        newCoordinatorDefaults: {
            settings: {
                newCoordinatorRole: {},
                newCoordinatorKeep: {},
                suggestProjectRule: {},
                suggestHomeRule: {},
                newCoordinatorAnswersWorkerQuestions: {},
            },
        },
        defaultLevels: {
            titleKey: 'settingsCoordination.defaultLevelsTitle',
            featureId: 'sessions.following',
            settings: {
                managerPolicy: {},
                runReportPolicy: {},
                discussionReceivePolicy: {},
            },
        },
        // Follow automatically: the four default rules, each a level (lab P5), moved here from Notifications.
        autoFollow: {
            titleKey: 'session.follow.preferences.title',
            featureId: 'sessions.following',
            settings: {
                autoFollowAssigned: {},
                autoFollowDirect: {},
                autoFollowTeam: {},
                autoFollowGroup: {},
            },
        },
        checkIn: {
            settings: {
                autonomousCheckIn: {},
            },
        },
    },
});

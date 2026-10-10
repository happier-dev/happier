import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * Static Action settings attach to the portable declarations; other surfaces come from the catalog.
 */
export const ACTIONS_CREATE_SESSION_SETTINGS = defineSettingsPage({
    pageId: 'actions',
    subpage: { id: 'createSession', route: '/settings/actions/session.spawn_new', titleKey: 'settingsActions.spawnPolicy.title' },
    sections: {
        spawnPolicy: {
            titleKey: 'settingsActions.spawnPolicy.title',
            settings: {
                allowCustomDirectory: {},
                allowCrossMachine: {},
                allowBackendTargetOverride: {},
                allowModelOverride: {},
                allowPermissionModeOverride: {},
                allowAgentModeOverride: {},
                allowConfigOptionOverrides: {},
                allowProfileOverride: {},
                allowEnvironmentVariables: {},
                allowConnectedServicesOverride: {},
                allowMcpSelectionOverride: {},
                allowTranscriptStorageOverride: {},
                permissionCeiling: {},
                allowedRoleIds: {},
                allowedAgentTargetKeys: {},
            },
        },
    },
});

/** Work's exact Agent prompt-document policy operand; authority lives in the portable declaration. */
export const ACTIONS_PROMPT_DOCUMENT_SETTINGS = defineSettingsPage({
    pageId: 'actions',
    sections: {
        instructions: {
            settings: { promptDocAgentEdits: {} },
        },
    },
});

export type {
    PluginSettingsActionDeclaration,
    PluginSettingsActionInput,
    PluginSettingsActionResult,
    PluginSettingsActionRuntime,
} from '../settingsActions.js';

export type {
    PluginSettingFieldIdV2,
    PluginSettingFieldSchemaV2,
    PluginSettingFieldV2 as SettingField,
    PluginSettingsContribution,
} from '@happier-dev/protocol';

export { PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1 } from '@happier-dev/protocol/plugins/settings/accountSettingsLimits';

/** @realm daemon */
export type {
    PluginSettingDescriptor as SettingDescriptor,
    PluginSettingsChange as SettingsChange,
    PluginSettingsMutationResult as SettingsMutationResult,
    PluginSettingsSnapshot as SettingsSnapshot,
    ScopedSettingsService,
    SettingsScopeRef,
    SettingsService,
} from '../services/core.js';

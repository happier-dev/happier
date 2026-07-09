export {
    definePluginManifest,
    definePluginSettingsContribution,
    booleanAgentSetting,
    buildAgentSettingsDefaults,
    defineAgentSettingsContribution,
    enumArrayAgentSetting,
    enumAgentSetting,
    jsonObjectStringAgentSetting,
    positiveIntegerAgentSetting,
    agentSettingsContributionToUiDescriptor,
    stringRecordAgentSetting,
    stringAgentSetting,
} from './manifest.browser.js';
export {
    defineSessionHeaderAction,
    defineStructuredMessage,
    defineSurfaceContribution,
    defineUiArtifact,
    defineUiTranslations,
} from './ui.js';
export {
    defineBrowserAction,
    defineBrowserTarget,
} from './browser/index.js';

export type * from './index.js';

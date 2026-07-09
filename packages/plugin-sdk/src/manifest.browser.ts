export function definePluginManifest<const TManifest>(
    manifest: TManifest,
): TManifest {
    return manifest;
}

export function definePluginSettingsContribution<const TContribution>(
    contribution: TContribution,
): TContribution {
    return contribution;
}

export {
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
} from './manifest/agentSettings.js';

export type * from './manifest.js';

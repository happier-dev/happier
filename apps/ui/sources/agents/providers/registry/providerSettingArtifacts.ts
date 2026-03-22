import type { SettingArtifacts, SettingDefinitionMap } from '@happier-dev/protocol';

import { PROVIDER_SETTINGS_PLUGINS } from './providerSettingsRegistry';
import { buildProviderSettingArtifactEntries } from './buildProviderSettingArtifactEntries';

export const PROVIDER_SETTING_ARTIFACT_ENTRIES = buildProviderSettingArtifactEntries(PROVIDER_SETTINGS_PLUGINS);

type UnionToIntersection<TValue> =
    (TValue extends unknown ? (value: TValue) => void : never) extends ((value: infer TIntersection) => void)
        ? TIntersection
        : never;

type ProviderSettingDefinitionsUnion = (typeof PROVIDER_SETTINGS_PLUGINS)[number]['settings'];
type ProviderSettingDefinitions = UnionToIntersection<ProviderSettingDefinitionsUnion> extends infer TDefinitions
    ? TDefinitions extends SettingDefinitionMap
        ? TDefinitions
        : never
    : never;

type ProviderSettingArtifacts = SettingArtifacts<ProviderSettingDefinitions>;

export const PROVIDER_SETTINGS_SHAPE: ProviderSettingArtifacts['shape'] = Object.assign(
    {},
    ...PROVIDER_SETTING_ARTIFACT_ENTRIES.map(({ artifacts }) => artifacts.shape),
);

export const PROVIDER_SETTINGS_DEFAULTS: ProviderSettingArtifacts['defaults'] = (() => {
    const merged: Record<string, unknown> = {};
    for (const { artifacts } of PROVIDER_SETTING_ARTIFACT_ENTRIES) {
        for (const [key, value] of Object.entries(artifacts.defaults)) {
            if (value === undefined) continue;
            merged[key] = value;
        }
    }
    return merged as ProviderSettingArtifacts['defaults'];
})();

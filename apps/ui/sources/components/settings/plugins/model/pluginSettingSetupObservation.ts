import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

export type SettingsSetupField = Pick<PluginProjectionEditableSettingField, 'key' | 'secretCustody' | 'title' | 'defaultValue' | 'required'>;

/** Presence-only facts from the Account or Machine Settings owner. */
export type PluginSettingSetupObservation = Readonly<{
    field: SettingsSetupField;
    status: 'missing' | 'configured' | 'unknown';
}>;

export type PublishPluginSettingSetup = (observations: readonly PluginSettingSetupObservation[]) => () => void;

export function requiresPluginSettingSetup(field: SettingsSetupField): boolean {
    return field.required === true && field.defaultValue === undefined;
}

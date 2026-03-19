import type { Settings } from '@/sync/domains/settings/settings';
import { PROVIDER_SETTING_ARTIFACT_ENTRIES } from '@/agents/providers/registry/providerSettingArtifacts';
import { ACCOUNT_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/account/accountSettingArtifacts';

import type { SettingsAnalyticsSnapshot } from './types';
import { buildSettingsPropertiesFromArtifacts } from './buildSettingsPropertiesFromArtifacts';

export function buildAccountSettingsSnapshot(settings: Settings): SettingsAnalyticsSnapshot {
    const settingsRecord = settings as Record<string, unknown>;
    const properties: SettingsAnalyticsSnapshot['properties'] = buildSettingsPropertiesFromArtifacts({
        artifacts: ACCOUNT_SETTING_ARTIFACTS,
        record: settingsRecord,
        currentPrefix: 'acct_setting__',
        derivedPrefix: 'derived__',
        identityScope: 'person',
    });

    for (const { artifacts } of PROVIDER_SETTING_ARTIFACT_ENTRIES) {
        Object.assign(
            properties,
            buildSettingsPropertiesFromArtifacts({
                artifacts,
                record: settingsRecord,
                currentPrefix: 'acct_setting__',
                derivedPrefix: 'derived__',
                identityScope: 'person',
            }),
        );
    }

    return { properties };
}

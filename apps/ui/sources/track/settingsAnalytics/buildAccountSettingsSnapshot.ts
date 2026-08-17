import type { Settings } from '@/sync/domains/settings/settings';
import { ACCOUNT_SETTING_ANALYTICS_ARTIFACTS } from '@/sync/domains/settings/registry/account/accountSettingAnalytics';

import type { SettingsAnalyticsSnapshot } from './types';
import { buildSettingsPropertiesFromArtifacts } from './buildSettingsPropertiesFromArtifacts';

export function buildAccountSettingsSnapshot(settings: Settings): SettingsAnalyticsSnapshot {
    const settingsRecord = settings as Record<string, unknown>;
    const properties: SettingsAnalyticsSnapshot['properties'] = buildSettingsPropertiesFromArtifacts({
        artifacts: ACCOUNT_SETTING_ANALYTICS_ARTIFACTS,
        record: settingsRecord,
        currentPrefix: 'acct_setting__',
        derivedPrefix: 'derived__',
        identityScope: 'person',
    });

    return { properties };
}

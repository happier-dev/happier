import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { LOCAL_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';

import type { SettingsAnalyticsSnapshot } from './types';
import { buildSettingsPropertiesFromArtifacts } from './buildSettingsPropertiesFromArtifacts';

export function buildLocalSettingsSnapshot(localSettings: LocalSettings): SettingsAnalyticsSnapshot {
    return {
        properties: buildSettingsPropertiesFromArtifacts({
            artifacts: LOCAL_SETTING_ARTIFACTS,
            record: localSettings as Record<string, unknown>,
            currentPrefix: 'local_setting__',
            derivedPrefix: 'local_derived__',
            identityScope: 'device_user',
        }),
    };
}

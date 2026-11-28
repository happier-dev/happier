import { ACCOUNT_SETTING_DEFINITIONS, ACCOUNT_SETTING_KEYS, type AccountSettingKey } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingAnalyticsMetadata, SettingDefinition, SettingDefinitionMap } from '@happier-dev/protocol/settings/registry/settingDefinition';

import type { AnalyticsSettingArtifacts } from '@/track/settingsAnalytics/analyticsSettingArtifacts';

import { ACCOUNT_BACKEND_SETTING_ANALYTICS } from './accountBackendSettingDefinitions';
import { ACCOUNT_PERMISSION_SETTING_ANALYTICS } from './accountPermissionSettingDefinitions';
import { ACCOUNT_VOICE_SETTING_ANALYTICS } from './accountVoiceSettingAnalytics';

const runtimeSerializers: Readonly<Partial<Record<AccountSettingKey, SettingAnalyticsMetadata['serializeCurrentProperties']>>> = {
    ...ACCOUNT_BACKEND_SETTING_ANALYTICS,
    ...ACCOUNT_PERMISSION_SETTING_ANALYTICS,
    ...ACCOUNT_VOICE_SETTING_ANALYTICS,
};

export const ACCOUNT_SETTING_ANALYTICS: Readonly<Partial<Record<AccountSettingKey, SettingAnalyticsMetadata>>> =
    Object.fromEntries(ACCOUNT_SETTING_KEYS.flatMap(key => {
        const metadata = (ACCOUNT_SETTING_DEFINITIONS[key] as SettingDefinition).analytics;
        if (!metadata) return [];
        const serializer = runtimeSerializers[key];
        return [[key, serializer ? { ...metadata, serializeCurrentProperties: serializer } : metadata]];
    }));

function buildAccountSettingAnalyticsArtifacts(): AnalyticsSettingArtifacts<SettingDefinitionMap> {
    const definitions: Record<string, SettingDefinition> = {};
    const trackedCurrentStateDefinitions: Record<string, SettingDefinition> = {};
    const trackedChangeDefinitions: Record<string, SettingDefinition> = {};
    const trackedDerivedDefinitions: Record<string, SettingDefinition> = {};

    for (const key of Object.keys(ACCOUNT_SETTING_ANALYTICS) as AccountSettingKey[]) {
        const analytics = ACCOUNT_SETTING_ANALYTICS[key];
        if (!analytics) continue;

        const definition: SettingDefinition = {
            ...ACCOUNT_SETTING_DEFINITIONS[key],
            analytics,
        };
        definitions[key] = definition;
        if (analytics.trackCurrentState) {
            trackedCurrentStateDefinitions[key] = definition;
        }
        if (analytics.trackChanges) {
            trackedChangeDefinitions[key] = definition;
        }
        if (analytics.serializeDerivedProperties || analytics.serializeDerivedPropertiesWithContext) {
            trackedDerivedDefinitions[key] = definition;
        }
    }

    return {
        definitions,
        trackedCurrentStateDefinitions,
        trackedChangeDefinitions,
        trackedDerivedDefinitions,
    };
}

/**
 * Derived projection for analytics consumers only. It projects Protocol metadata and runtime-only
 * serializers, but deliberately has no schema shape or defaults and cannot back persistence.
 */
export const ACCOUNT_SETTING_ANALYTICS_ARTIFACTS: ReturnType<typeof buildAccountSettingAnalyticsArtifacts> = buildAccountSettingAnalyticsArtifacts();

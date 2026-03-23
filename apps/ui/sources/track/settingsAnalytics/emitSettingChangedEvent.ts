import { getTrackingAnonymousUserId, tracking } from '@/track';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { PROVIDER_SETTING_ARTIFACT_ENTRIES } from '@/agents/providers/registry/providerSettingArtifacts';
import { ACCOUNT_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/account/accountSettingArtifacts';
import { LOCAL_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';

import { diffAnalyticsProperties } from './diffAnalyticsSnapshot';
import { buildFeaturePreferenceAnalyticsSnapshot } from './buildFeatureAnalyticsSnapshot';
import { buildSettingPropertyValueKindMapFromArtifacts } from './buildSettingPropertyValueKindMapFromArtifacts';
import { buildSettingsPropertiesFromArtifacts } from './buildSettingsPropertiesFromArtifacts';
import { flushTrackingClient } from './flushTrackingClient';
import type {
    SettingsAnalyticsPropertyValue,
    SettingsAnalyticsSource,
} from './types';

type SettingsAnalyticsChangeScope = 'account_setting' | 'local_setting' | 'derived' | 'feature_pref';

function inferValueKind(value: SettingsAnalyticsPropertyValue): 'boolean' | 'enum' | 'count' | 'presence' {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'count';
    if (value === null) return 'presence';
    return 'enum';
}

function captureChange(params: {
    propertyKey: string;
    previousValue: SettingsAnalyticsPropertyValue;
    nextValue: SettingsAnalyticsPropertyValue;
    scope: SettingsAnalyticsChangeScope;
    identityScope: 'person' | 'device_user';
    source: SettingsAnalyticsSource;
    wasDefaultBefore: boolean;
    isDefaultAfter: boolean;
    valueKind?: 'boolean' | 'enum' | 'bucket' | 'count' | 'presence';
}) {
    if (!tracking) return;

    tracking.capture('setting_changed', {
        setting_key: params.propertyKey,
        scope: params.scope,
        identity_scope: params.identityScope,
        value_kind: params.valueKind ?? inferValueKind(params.nextValue),
        prev_value: params.previousValue,
        next_value: params.nextValue,
        was_default_before: params.wasDefaultBefore,
        is_default_after: params.isDefaultAfter,
        source: params.source,
    });
}

function buildTrackedAccountChangeProperties(record: Record<string, unknown>): Record<string, SettingsAnalyticsPropertyValue> {
    const properties = buildSettingsPropertiesFromArtifacts({
        artifacts: ACCOUNT_SETTING_ARTIFACTS,
        record,
        currentPrefix: 'acct_setting__',
        derivedPrefix: 'derived__',
        identityScope: 'person',
        trackingMode: 'change',
    });

    for (const { artifacts } of PROVIDER_SETTING_ARTIFACT_ENTRIES) {
        Object.assign(
            properties,
            buildSettingsPropertiesFromArtifacts({
                artifacts,
                record,
                currentPrefix: 'acct_setting__',
                derivedPrefix: 'derived__',
                identityScope: 'person',
                trackingMode: 'change',
            }),
        );
    }

    return properties;
}

function buildTrackedAccountChangePropertyKinds(record: Record<string, unknown>) {
    const propertyKinds = buildSettingPropertyValueKindMapFromArtifacts({
        artifacts: ACCOUNT_SETTING_ARTIFACTS,
        record,
        currentPrefix: 'acct_setting__',
        derivedPrefix: 'derived__',
        identityScope: 'person',
        trackingMode: 'change',
    });

    for (const { artifacts } of PROVIDER_SETTING_ARTIFACT_ENTRIES) {
        Object.assign(propertyKinds, buildSettingPropertyValueKindMapFromArtifacts({
            artifacts,
            record,
            currentPrefix: 'acct_setting__',
            derivedPrefix: 'derived__',
            identityScope: 'person',
            trackingMode: 'change',
        }));
    }

    return propertyKinds;
}

export function emitAccountSettingChangedEvents(params: {
    previousSettings: Settings;
    nextSettings: Settings;
    source?: SettingsAnalyticsSource;
}) {
    if (!tracking) return;

    const source = params.source ?? 'unknown';
    const previousProperties = buildTrackedAccountChangeProperties(params.previousSettings as Record<string, unknown>);
    const nextProperties = buildTrackedAccountChangeProperties(params.nextSettings as Record<string, unknown>);
    const defaultProperties = buildTrackedAccountChangeProperties(settingsDefaults as Record<string, unknown>);
    const changedProperties = diffAnalyticsProperties(previousProperties, nextProperties);
    const accountPropertyKinds = buildTrackedAccountChangePropertyKinds(params.nextSettings as Record<string, unknown>);
    let didEmitAnalyticsUpdate = false;

    if (changedProperties) {
        for (const [fullKey, nextValue] of Object.entries(changedProperties)) {
            const previousValue = previousProperties[fullKey] ?? null;

            if (fullKey.startsWith('acct_setting__')) {
                const propertyKey = fullKey.slice('acct_setting__'.length) as keyof Settings;
                captureChange({
                    propertyKey,
                    previousValue,
                    nextValue,
                    scope: 'account_setting',
                    identityScope: 'person',
                    source,
                    wasDefaultBefore: previousProperties[fullKey] === (defaultProperties[fullKey] ?? null),
                    isDefaultAfter: nextProperties[fullKey] === (defaultProperties[fullKey] ?? null),
                    valueKind: accountPropertyKinds[fullKey],
                });
                didEmitAnalyticsUpdate = true;
                continue;
            }

            if (fullKey.startsWith('derived__')) {
                captureChange({
                    propertyKey: fullKey.slice('derived__'.length),
                    previousValue,
                    nextValue,
                    scope: 'derived',
                    identityScope: 'person',
                    source,
                    wasDefaultBefore: false,
                    isDefaultAfter: false,
                    valueKind: accountPropertyKinds[fullKey],
                });
                didEmitAnalyticsUpdate = true;
            }
        }

        if (Object.prototype.hasOwnProperty.call(changedProperties, 'acct_setting__analyticsOptOut')) {
            const anonymousUserId = getTrackingAnonymousUserId();
            if (anonymousUserId) {
                tracking.identify(anonymousUserId, {
                    acct_setting__analyticsOptOut: Boolean(params.nextSettings.analyticsOptOut),
                });
                didEmitAnalyticsUpdate = true;
            }
        }
    }

    const previousFeaturePrefProperties = buildFeaturePreferenceAnalyticsSnapshot(params.previousSettings).properties;
    const nextFeaturePrefProperties = buildFeaturePreferenceAnalyticsSnapshot(params.nextSettings).properties;
    const changedFeaturePrefProperties = diffAnalyticsProperties(previousFeaturePrefProperties, nextFeaturePrefProperties);
    if (changedFeaturePrefProperties) {
        for (const [fullKey, nextValue] of Object.entries(changedFeaturePrefProperties)) {
            if (!fullKey.startsWith('feature_pref__')) continue;
            captureChange({
                propertyKey: fullKey.slice('feature_pref__'.length),
                previousValue: previousFeaturePrefProperties[fullKey] ?? null,
                nextValue,
                scope: 'feature_pref',
                identityScope: 'person',
                source,
                wasDefaultBefore: false,
                isDefaultAfter: false,
            });
            didEmitAnalyticsUpdate = true;
        }
    }

    if (didEmitAnalyticsUpdate) {
        flushTrackingClient(tracking);
    }
}

export function emitLocalSettingChangedEvents(params: {
    previousSettings: LocalSettings;
    nextSettings: LocalSettings;
    source?: SettingsAnalyticsSource;
}) {
    if (!tracking) return;

    const source = params.source ?? 'unknown';
    const previousProperties = buildSettingsPropertiesFromArtifacts({
        artifacts: LOCAL_SETTING_ARTIFACTS,
        record: params.previousSettings as Record<string, unknown>,
        currentPrefix: 'local_setting__',
        derivedPrefix: 'local_derived__',
        identityScope: 'device_user',
        trackingMode: 'change',
    });
    const nextProperties = buildSettingsPropertiesFromArtifacts({
        artifacts: LOCAL_SETTING_ARTIFACTS,
        record: params.nextSettings as Record<string, unknown>,
        currentPrefix: 'local_setting__',
        derivedPrefix: 'local_derived__',
        identityScope: 'device_user',
        trackingMode: 'change',
    });
    const defaultProperties = buildSettingsPropertiesFromArtifacts({
        artifacts: LOCAL_SETTING_ARTIFACTS,
        record: localSettingsDefaults as Record<string, unknown>,
        currentPrefix: 'local_setting__',
        derivedPrefix: 'local_derived__',
        identityScope: 'device_user',
        trackingMode: 'change',
    });
    const changedProperties = diffAnalyticsProperties(previousProperties, nextProperties);
    const localPropertyKinds = buildSettingPropertyValueKindMapFromArtifacts({
        artifacts: LOCAL_SETTING_ARTIFACTS,
        record: params.nextSettings as Record<string, unknown>,
        currentPrefix: 'local_setting__',
        derivedPrefix: 'local_derived__',
        identityScope: 'device_user',
        trackingMode: 'change',
    });
    if (!changedProperties) return;

    let didEmitAnalyticsUpdate = false;

    for (const [fullKey, nextValue] of Object.entries(changedProperties)) {
        const previousValue = previousProperties[fullKey] ?? null;

        if (fullKey.startsWith('local_setting__')) {
            const propertyKey = fullKey.slice('local_setting__'.length) as keyof LocalSettings;
            captureChange({
                propertyKey,
                previousValue,
                nextValue,
                scope: 'local_setting',
                identityScope: 'device_user',
                source,
                wasDefaultBefore: previousProperties[fullKey] === (defaultProperties[fullKey] ?? null),
                isDefaultAfter: nextProperties[fullKey] === (defaultProperties[fullKey] ?? null),
                valueKind: localPropertyKinds[fullKey],
            });
            didEmitAnalyticsUpdate = true;
            continue;
        }

        if (fullKey.startsWith('local_derived__')) {
            captureChange({
                propertyKey: fullKey.slice('local_derived__'.length),
                previousValue,
                nextValue,
                scope: 'derived',
                identityScope: 'device_user',
                source,
                wasDefaultBefore: false,
                isDefaultAfter: false,
                valueKind: localPropertyKinds[fullKey],
            });
            didEmitAnalyticsUpdate = true;
        }
    }

    if (didEmitAnalyticsUpdate) {
        flushTrackingClient(tracking);
    }
}

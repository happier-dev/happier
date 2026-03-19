import type { SettingDefinition } from '@happier-dev/protocol';

import type { SettingsAnalyticsPropertyValue } from './types';

function isAnalyticsScalar(value: unknown): value is SettingsAnalyticsPropertyValue {
    return (
        value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || typeof value === 'string'
    );
}

function canUseRawAnalyticsFallback(definition: SettingDefinition): boolean {
    const valueKind = definition.analytics?.valueKind;
    return valueKind === 'boolean' || valueKind === 'enum';
}

export function serializeTrackedSettingEntries(
    definition: SettingDefinition,
    rawValue: unknown,
    propertyKey: string,
    record?: Readonly<Record<string, unknown>>,
): Record<string, SettingsAnalyticsPropertyValue> {
    const properties: Record<string, SettingsAnalyticsPropertyValue> = {};
    const structured = record && definition.analytics?.serializeCurrentPropertiesWithContext
        ? definition.analytics.serializeCurrentPropertiesWithContext(rawValue, record)
        : definition.analytics?.serializeCurrentProperties?.(rawValue);

    if (structured) {
        for (const [structuredKey, structuredValue] of Object.entries(structured)) {
            if (!isAnalyticsScalar(structuredValue)) continue;
            properties[`${propertyKey}__${structuredKey}`] = structuredValue;
        }
        return properties;
    }

    const serialized = record && definition.analytics?.serializeCurrentWithContext
        ? definition.analytics.serializeCurrentWithContext(rawValue, record)
        : definition.analytics?.serializeCurrent
            ? definition.analytics.serializeCurrent(rawValue)
            : canUseRawAnalyticsFallback(definition)
                ? rawValue
                : undefined;

    if (isAnalyticsScalar(serialized)) {
        properties[propertyKey] = serialized;
    }

    return properties;
}

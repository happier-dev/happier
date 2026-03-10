import type { SettingDefinition } from '@happier-dev/protocol';

import type { SettingsAnalyticsPropertyValue } from './types';

type DerivedAnalyticsDefinition = Pick<SettingDefinition, 'analytics'>;

function isAnalyticsScalar(value: unknown): value is SettingsAnalyticsPropertyValue {
    return (
        value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || typeof value === 'string'
    );
}

export function serializeDerivedSettingEntries(
    definition: DerivedAnalyticsDefinition,
    rawValue: unknown,
    propertyKeyPrefix: string,
    record?: Readonly<Record<string, unknown>>,
): Record<string, SettingsAnalyticsPropertyValue> {
    const properties: Record<string, SettingsAnalyticsPropertyValue> = {};
    const structured = record && definition.analytics?.serializeDerivedPropertiesWithContext
        ? definition.analytics.serializeDerivedPropertiesWithContext(rawValue, record)
        : definition.analytics?.serializeDerivedProperties?.(rawValue);

    if (!structured) return properties;

    for (const [structuredKey, structuredValue] of Object.entries(structured)) {
        if (!isAnalyticsScalar(structuredValue)) continue;
        properties[`${propertyKeyPrefix}${structuredKey}`] = structuredValue;
    }

    return properties;
}

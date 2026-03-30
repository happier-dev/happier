import type { SettingArtifacts, SettingDefinitionMap } from '@happier-dev/protocol';

import type { SettingsAnalyticsSnapshot } from './types';
import { serializeDerivedSettingEntries } from './serializeDerivedSettingEntries';
import { serializeTrackedSettingEntries } from './serializeTrackedSettingEntries';

export function buildSettingsPropertiesFromArtifacts<TDefinitions extends SettingDefinitionMap>(params: {
    artifacts: SettingArtifacts<TDefinitions>;
    record: Record<string, unknown>;
    currentPrefix: string;
    derivedPrefix: string;
    identityScope: 'person' | 'device_user';
    trackingMode?: 'current' | 'change';
}): SettingsAnalyticsSnapshot['properties'] {
    const properties: SettingsAnalyticsSnapshot['properties'] = {};
    const trackingMode = params.trackingMode ?? 'current';
    const trackedDefinitions = trackingMode === 'change'
        ? params.artifacts.trackedChangeDefinitions
        : params.artifacts.trackedCurrentStateDefinitions;
    const trackedDerivedDefinitions = trackingMode === 'change'
        ? Object.fromEntries(
            Object.entries(params.artifacts.trackedDerivedDefinitions).filter(([key]) =>
                Object.prototype.hasOwnProperty.call(params.artifacts.trackedChangeDefinitions, key),
            ),
        )
        : params.artifacts.trackedDerivedDefinitions;

    for (const [key, definition] of Object.entries(trackedDefinitions) as Array<
        [string, NonNullable<(typeof trackedDefinitions)[keyof typeof trackedDefinitions]>]
    >) {
        if (!definition) continue;
        if (definition.analytics?.identityScope !== params.identityScope) continue;
        Object.assign(
            properties,
            serializeTrackedSettingEntries(
                definition,
                params.record[key],
                `${params.currentPrefix}${key}`,
                params.record,
            ),
        );
    }

    for (const [key, definition] of Object.entries(trackedDerivedDefinitions) as Array<
        [string, NonNullable<(typeof trackedDerivedDefinitions)[keyof typeof trackedDerivedDefinitions]>]
    >) {
        if (!definition) continue;
        if (definition.analytics?.identityScope !== params.identityScope) continue;
        Object.assign(
            properties,
            serializeDerivedSettingEntries(definition, params.record[key], params.derivedPrefix, params.record),
        );
    }

    return properties;
}

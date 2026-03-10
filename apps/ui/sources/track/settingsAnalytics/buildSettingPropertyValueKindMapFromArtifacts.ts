import type { SettingArtifacts, SettingDefinitionMap, SettingValueKind } from '@happier-dev/protocol';

import { serializeDerivedSettingEntries } from './serializeDerivedSettingEntries';
import { serializeTrackedSettingEntries } from './serializeTrackedSettingEntries';

export function buildSettingPropertyValueKindMapFromArtifacts<TDefinitions extends SettingDefinitionMap>(params: {
    artifacts: SettingArtifacts<TDefinitions>;
    record: Record<string, unknown>;
    currentPrefix: string;
    derivedPrefix: string;
    identityScope: 'person' | 'device_user';
    trackingMode?: 'current' | 'change';
}): Partial<Record<string, SettingValueKind>> {
    const propertyKinds: Partial<Record<string, SettingValueKind>> = {};
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

        const entries = serializeTrackedSettingEntries(
            definition,
            params.record[key],
            `${params.currentPrefix}${key}`,
            params.record,
        );

        for (const fullKey of Object.keys(entries)) {
            const structuredKey = fullKey.startsWith(`${params.currentPrefix}${key}__`)
                ? fullKey.slice(`${params.currentPrefix}${key}__`.length)
                : '';
            const overrideKind = structuredKey
                ? definition.analytics?.currentPropertyValueKinds?.[structuredKey]
                : undefined;
            const valueKind = overrideKind ?? (definition.analytics?.valueKind === 'bucket' ? 'bucket' : undefined);
            if (valueKind) {
                propertyKinds[fullKey] = valueKind;
            }
        }
    }

    for (const [key, definition] of Object.entries(trackedDerivedDefinitions) as Array<
        [string, NonNullable<(typeof trackedDerivedDefinitions)[keyof typeof trackedDerivedDefinitions]>]
    >) {
        if (!definition) continue;
        if (definition.analytics?.identityScope !== params.identityScope) continue;

        const entries = serializeDerivedSettingEntries(
            definition,
            params.record[key],
            params.derivedPrefix,
            params.record,
        );

        for (const fullKey of Object.keys(entries)) {
            const derivedKey = fullKey.slice(params.derivedPrefix.length);
            const valueKind = definition.analytics?.derivedPropertyValueKinds?.[derivedKey]
                ?? (definition.analytics?.valueKind === 'bucket' ? 'bucket' : undefined);
            if (valueKind) {
                propertyKinds[fullKey] = valueKind;
            }
        }
    }

    return propertyKinds;
}

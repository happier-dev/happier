import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function objectKeyCount(value: unknown): number {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).length
        : 0;
}

function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function readObjectProperty(value: unknown, key: string): unknown {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function buildPromptStacksSummaryProperties(value: unknown): Record<string, number> {
    const surfaces = value && typeof value === 'object' && !Array.isArray(value) && 'surfaces' in (value as Record<string, unknown>)
        ? ((value as {
            surfaces?: Record<string, unknown>;
        }).surfaces ?? {})
        : {};
    const coding = Array.isArray(surfaces.coding) ? surfaces.coding.length : 0;
    const voice = Array.isArray(surfaces.voice) ? surfaces.voice.length : 0;
    const profilesById = surfaces.profilesById && typeof surfaces.profilesById === 'object' && !Array.isArray(surfaces.profilesById)
        ? surfaces.profilesById as Record<string, unknown>
        : {};
    return {
        codingCount: coding,
        voiceCount: voice,
        profileOverrideCount: Object.keys(profilesById).length,
    };
}

export const ACCOUNT_PROMPT_LIBRARY_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    promptStacksV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrentProperties: buildPromptStacksSummaryProperties,
    },
    promptFoldersV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'folders')),
    },
    promptInvocationsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'entries')),
    },
    promptExternalLinksV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'links')),
    },
    promptRegistrySourcesV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'sources')),
    },
    contextSelectionsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: unknown) => objectKeyCount(readObjectProperty(value, 'selectionsByKey')),
    },
});

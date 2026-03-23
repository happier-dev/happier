import {
    PromptExternalLinksV1Schema,
    PromptFoldersV1Schema,
    PromptInvocationsV1Schema,
    PromptRegistrySourcesV1Schema,
    PromptStacksV1Schema,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';
import { z } from 'zod';

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
    const surfaces =
        value && typeof value === 'object' && !Array.isArray(value) && 'surfaces' in (value as Record<string, unknown>)
            ? ((value as { surfaces?: Record<string, unknown> }).surfaces ?? {})
            : {};
    const coding = Array.isArray(surfaces.coding) ? surfaces.coding.length : 0;
    const voice = Array.isArray(surfaces.voice) ? surfaces.voice.length : 0;
    const profilesById =
        surfaces.profilesById && typeof surfaces.profilesById === 'object' && !Array.isArray(surfaces.profilesById)
            ? surfaces.profilesById as Record<string, unknown>
            : {};

    return {
        codingCount: coding,
        voiceCount: voice,
        profileOverrideCount: Object.keys(profilesById).length,
    };
}

export const ContextSelectionEntrySchema = z.object({
    machineId: z.string().nullable().optional(),
    workspacePath: z.string().nullable().optional(),
});

export const ContextSelectionsV1Schema = z.object({
    v: z.literal(1),
    selectionsByKey: z.record(z.string(), ContextSelectionEntrySchema).default({}),
});

export const ACCOUNT_PROMPT_LIBRARY_SETTING_DEFINITIONS = defineSettingDefinitions({
    promptStacksV1: {
        schema: PromptStacksV1Schema.default({ v: 1, surfaces: { coding: [], voice: [], profilesById: {} } }),
        default: { v: 1, surfaces: { coding: [], voice: [], profilesById: {} } },
        description: 'Prompt stacks for coding/voice surfaces and per-profile overrides',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildPromptStacksSummaryProperties,
        },
    },
    promptFoldersV1: {
        schema: PromptFoldersV1Schema.default({ v: 1, folders: [] }),
        default: { v: 1, folders: [] },
        description: 'Named prompt library folders for organizing prompts and skills',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'folders')),
        },
    },
    promptInvocationsV1: {
        schema: PromptInvocationsV1Schema.default({ v: 1, entries: [] }),
        default: { v: 1, entries: [] },
        description: 'Prompt template invocations (slash tokens mapped to prompt docs)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'entries')),
        },
    },
    promptExternalLinksV1: {
        schema: PromptExternalLinksV1Schema.default({ v: 1, links: [] }),
        default: { v: 1, links: [] },
        description: 'Stored external prompt asset links for drift-safe exports',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'links')),
        },
    },
    promptRegistrySourcesV1: {
        schema: PromptRegistrySourcesV1Schema.default({ v: 1, sources: [] }),
        default: { v: 1, sources: [] },
        description: 'User-configured prompt registry sources (git / marketplace connectors)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => arrayLength(readObjectProperty(value, 'sources')),
        },
    },
    contextSelectionsV1: {
        schema: ContextSelectionsV1Schema.default({ v: 1, selectionsByKey: {} }),
        default: { v: 1, selectionsByKey: {} },
        description: 'Reusable machine/workspace context selections keyed by screen/domain',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: unknown) => objectKeyCount(readObjectProperty(value, 'selectionsByKey')),
        },
    },
});

export const ACCOUNT_PROMPT_LIBRARY_SETTING_ARTIFACTS = buildSettingArtifacts(
    ACCOUNT_PROMPT_LIBRARY_SETTING_DEFINITIONS,
);

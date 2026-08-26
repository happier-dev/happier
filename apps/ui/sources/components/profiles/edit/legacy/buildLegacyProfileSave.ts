import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';

import {
    resolveProfileBackendTargetKeyForEntry,
    stripLegacyProviderSentinelTargetKeys,
} from '../profileBackendEntryStorage';

function stripUndefinedRecordValues<TValue>(
    record: Readonly<Record<string, TValue | undefined>>,
): Record<string, TValue> {
    const next: Record<string, TValue> = {};
    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) next[key] = value;
    }
    return next;
}

export function buildLegacyProfileSave(input: Readonly<{
    profile: AIBackendProfile;
    name: string;
    environmentVariables: AIBackendProfile['environmentVariables'];
    envVarRequirements: AIBackendProfile['envVarRequirements'];
    authMode: AIBackendProfile['authMode'];
    machineLoginTargetKey: string | null;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    supportedDirectBackendEntries: readonly ResolvedBackendCatalogEntry[];
    defaultPermissionModesByTargetKey: Readonly<Record<string, PermissionMode | null>>;
    defaultTranscriptStorageModesByTargetKey: Readonly<Record<string, SessionTranscriptStorageMode | null>>;
    compatibilityByTargetKey: Readonly<Record<string, boolean>>;
    updatedAt: number;
}>): AIBackendProfile {
    const {
        codingPromptBehaviorOverrides: _canonicalCodingPromptBehaviorOverrides,
        defaultPermissionModeClaude: _legacyClaude,
        defaultPermissionModeCodex: _legacyCodex,
        defaultPermissionModeGemini: _legacyGemini,
        ...profileBase
    } = input.profile as AIBackendProfile & Record<string, unknown>;
    const defaultPermissionModeByTargetKey = stripLegacyProviderSentinelTargetKeys(
        stripUndefinedRecordValues<PermissionMode>(
            (profileBase.defaultPermissionModeByTargetKey as Record<string, PermissionMode | undefined>) ?? {},
        ),
        input.resolvedBackendEntries,
    );
    for (const entry of input.resolvedBackendEntries) {
        const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const mode = input.defaultPermissionModesByTargetKey[targetKey];
        if (mode) defaultPermissionModeByTargetKey[targetKey] = mode;
        else delete defaultPermissionModeByTargetKey[targetKey];
    }
    const defaultPersistenceModeByTargetKey = stripLegacyProviderSentinelTargetKeys(
        stripUndefinedRecordValues<SessionTranscriptStorageMode>(
            (profileBase.defaultPersistenceModeByTargetKey as Record<string, SessionTranscriptStorageMode | undefined>) ?? {},
        ),
        input.resolvedBackendEntries,
    );
    for (const entry of input.supportedDirectBackendEntries) {
        const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const mode = input.defaultTranscriptStorageModesByTargetKey[targetKey];
        if (mode === 'direct' || mode === 'persisted') defaultPersistenceModeByTargetKey[targetKey] = mode;
        else delete defaultPersistenceModeByTargetKey[targetKey];
    }
    const compatibilityByTargetKey = stripLegacyProviderSentinelTargetKeys(
        stripUndefinedRecordValues<boolean>(
            (profileBase.compatibilityByTargetKey as Record<string, boolean | undefined>) ?? {},
        ),
        input.resolvedBackendEntries,
    );
    for (const entry of input.resolvedBackendEntries) {
        const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
        compatibilityByTargetKey[targetKey] = input.compatibilityByTargetKey[targetKey] === true;
    }

    return {
        ...profileBase,
        name: input.name.trim(),
        environmentVariables: input.environmentVariables,
        authMode: input.authMode,
        requiresMachineLoginTargetKey: input.authMode === 'machineLogin'
            ? input.machineLoginTargetKey ?? undefined
            : undefined,
        requiresMachineLogin: undefined,
        envVarRequirements: input.envVarRequirements,
        defaultPermissionMode: undefined,
        defaultPermissionModeByTargetKey,
        defaultPermissionModeByAgent: {},
        defaultPersistenceModeByTargetKey,
        defaultPersistenceModeByAgent: {},
        compatibilityByTargetKey,
        compatibility: {},
        updatedAt: input.updatedAt,
    };
}

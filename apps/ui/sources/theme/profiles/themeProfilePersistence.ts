import { z } from 'zod/mini';
import { ThemeProfileIdSchema, ThemeProfileStoredSchema, ThemeReferenceSchema, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
export { ThemeProfileLibrarySchema, ThemeProfileLibraryStoredSchema } from '@happier-dev/protocol/account/settings/themeProfiles';

import { projectThemeProfileMigration } from './themeProfileMigrationEdits';
export { mergeThemeProfileLibraries } from './themeProfileLibraryComposition';
import {
    migrateThemeProfileOverrideTokenIds,
    isRouteSafeThemeProfileId,
    isReservedThemeProfileId,
} from './themeProfileImportExport';
import type { ThemeProfileMigrationIntent, ThemeProfileDeviceSelectionByMode, ThemeProfileMode, ThemeProfileSelectionByMode, ThemeProfileV1, ThemeProfilesLocalStateV1, ThemeProfilesStateSnapshot } from './themeProfileTypes';
import { getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from './builtInThemeProfiles';
import { inferThemeProfileAssetAppearance, isThemeProfileAssetAppearance } from './themeProfileAssetAppearance';

export const DEFAULT_THEME_PROFILE_SELECTION_BY_MODE: ThemeProfileSelectionByMode = Object.freeze({
    light: null,
    dark: null,
});

export const DEFAULT_THEME_PROFILES_LOCAL_STATE: ThemeProfilesLocalStateV1 = Object.freeze({
    profiles: [],
    activeProfileIds: DEFAULT_THEME_PROFILE_SELECTION_BY_MODE,
});

type ParseThemeProfilesLocalStateResult = Readonly<{
    state: ThemeProfilesLocalStateV1;
    changed: boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stableStringify = (value: unknown): string => JSON.stringify(value);

const isKnownThemeProfileId = (
    value: unknown,
    seenIds: ReadonlySet<string>,
): value is string => (
    typeof value === 'string' && (seenIds.has(value) || isBuiltInThemeProfilePresetId(value))
);

const sanitizeActiveProfileId = (
    value: unknown,
    seenIds: ReadonlySet<string>,
): string | null => (isKnownThemeProfileId(value, seenIds) ? value : null);

export const parseThemeProfile = (value: unknown): Readonly<{ profile: ThemeProfileV1; changed: boolean }> | null => {
    if (!isRecord(value)) return null;
    const candidate = { ...value };
    if (!isThemeProfileAssetAppearance(candidate.assetAppearance)) delete candidate.assetAppearance;
    const parsed = ThemeProfileStoredSchema.safeParse(candidate);
    if (!parsed.success) return null;
    const profile: ThemeProfileV1 = {
        ...parsed.data,
        assetAppearance: parsed.data.assetAppearance ?? inferThemeProfileAssetAppearance(parsed.data),
    };
    return { profile, changed: stableStringify(profile) !== stableStringify(value) };
};

export const parseThemeProfilesLocalState = (value: unknown): ParseThemeProfilesLocalStateResult => {
    if (!isRecord(value) || !Array.isArray(value.profiles)) {
        return { state: DEFAULT_THEME_PROFILES_LOCAL_STATE, changed: value !== undefined };
    }

    const profiles: ThemeProfileV1[] = [];
    let changed = false;
    const seenIds = new Set<string>();

    for (const sourceProfile of value.profiles) {
        const parsedProfile = parseThemeProfile(sourceProfile);
        if (!parsedProfile || seenIds.has(parsedProfile.profile.id) || isBuiltInThemeProfilePresetId(parsedProfile.profile.id)) {
            changed = true;
            continue;
        }

        profiles.push(parsedProfile.profile);
        seenIds.add(parsedProfile.profile.id);
        changed = changed || parsedProfile.changed;
    }

    let activeProfileIds: ThemeProfileSelectionByMode;
    if (isRecord(value.activeProfileIds)) {
        activeProfileIds = {
            light: sanitizeActiveProfileId(value.activeProfileIds.light, seenIds),
            dark: sanitizeActiveProfileId(value.activeProfileIds.dark, seenIds),
        };
        if (stableStringify(activeProfileIds) !== stableStringify(value.activeProfileIds)) {
            changed = true;
        }
    } else {
        const legacyActiveProfileId = sanitizeActiveProfileId(value.activeProfileId, seenIds);
        activeProfileIds = {
            light: legacyActiveProfileId,
            dark: legacyActiveProfileId,
        };
        if (legacyActiveProfileId !== null || value.activeProfileId !== undefined) {
            changed = true;
        }
    }

    if (value.activeProfileId !== undefined) {
        changed = true;
    }

    const state: ThemeProfilesLocalStateV1 = { profiles, activeProfileIds };
    return {
        state,
        changed: changed || stableStringify(state) !== stableStringify(value),
    };
};

export const migrateThemeProfileLocalStateTokenIds = (state: ThemeProfilesLocalStateV1): ParseThemeProfilesLocalStateResult => {
    let changed = false;
    const profiles = state.profiles.map((profile) => {
        const light = migrateThemeProfileOverrideTokenIds(profile.overrides.light);
        const dark = migrateThemeProfileOverrideTokenIds(profile.overrides.dark);
        if (light.migratedTokenIds.length === 0 && dark.migratedTokenIds.length === 0) {
            return profile;
        }

        changed = true;
        return {
            ...profile,
            overrides: { light: light.overrides, dark: dark.overrides },
        };
    });

    return {
        state: { ...state, profiles },
        changed,
    };
};

export const ThemeProfilesLocalStateSchema: z.ZodMiniType<ThemeProfilesLocalStateV1> = z.pipe(z
    .unknown(), z.transform((value) => parseThemeProfilesLocalState(value).state));

export const ThemeProfileSelectionSchema: z.ZodMiniType<ThemeProfileSelectionByMode> = z.pipe(z.unknown(), z.transform((value) => {
    const record = isRecord(value) ? value : {};
    const read = (id: unknown): string | null => (
        typeof id === 'string' && isRouteSafeThemeProfileId(id)
        && (!isReservedThemeProfileId(id) || isBuiltInThemeProfilePresetId(id)) ? id : null
    );
    return { light: read(record.light), dark: read(record.dark) };
}));

const ThemeProfileLegacySelectionSchema = z.strictObject({
    legacyProfileId: ThemeProfileIdSchema.check(z.refine((id) => !isReservedThemeProfileId(id))),
});

export const ThemeProfileDeviceSelectionSchema: z.ZodMiniType<ThemeProfileDeviceSelectionByMode> = z.pipe(z.unknown(), z.transform((value) => {
    const record = isRecord(value) ? value : {};
    const canonical = ThemeProfileSelectionSchema.parse(record);
    const read = (mode: ThemeProfileMode): ThemeProfileDeviceSelectionByMode[ThemeProfileMode] => {
        if (!isRecord(record[mode])) return canonical[mode];
        const reference = ThemeReferenceSchema.safeParse(record[mode]);
        if (reference.success) return reference.data;
        const parsed = ThemeProfileLegacySelectionSchema.safeParse(record[mode]);
        return parsed.success ? parsed.data : null;
    };
    return { light: read('light'), dark: read('dark') };
}));

/** Released custom ids remain migration input; current writes use tagged references. */
export function readThemeProfileReferenceSelection(selection: ThemeProfileDeviceSelectionByMode | null): Readonly<Record<ThemeProfileMode, ThemeReference | null>> {
    const read = (mode: ThemeProfileMode): ThemeReference | null => {
        const value = selection?.[mode];
        if (value && typeof value === 'object' && 'kind' in value) return value;
        return typeof value === 'string' && isBuiltInThemeProfilePresetId(value) ? { kind: 'built-in', presetId: value } : null;
    };
    return { light: read('light'), dark: read('dark') };
}

/** Resolve visible definitions, including released migration input when supplied. */
export function resolveThemeProfilesStateSnapshot(
    profiles: readonly ThemeProfileV1[],
    legacy: ThemeProfilesLocalStateV1,
    activeProfileIds: ThemeProfileDeviceSelectionByMode | null,
    pendingIntent?: ThemeProfileMigrationIntent | null,
    pendingProfiles?: readonly ThemeProfileV1[],
): ThemeProfilesStateSnapshot {
    const selection = activeProfileIds ?? legacy.activeProfileIds;
    const merged = projectThemeProfileMigration(profiles, legacy, pendingIntent, pendingProfiles);
    const composedProfiles = merged.profiles;
    const composedIds = new Set(composedProfiles.map((profile) => profile.id));
    const resolve = (id: ThemeProfileDeviceSelectionByMode[ThemeProfileMode]): string | null => {
        let resolved: string | null = null;
        if (typeof id === 'string') {
            resolved = activeProfileIds === null && !isBuiltInThemeProfilePresetId(id) ? merged.legacyProfileIds.get(id) ?? null : id;
        } else if (id && 'kind' in id) {
            if (id.kind === 'artifact') resolved = id.id;
            if (id.kind === 'built-in') resolved = id.presetId;
        } else if (id) {
            resolved = merged.legacyProfileIds.get(id.legacyProfileId) ?? null;
        }
        return sanitizeActiveProfileId(resolved, composedIds);
    };
    const origins: Array<[string, string]> = [];
    if (merged.legacy.profiles.length) {
        const legacyIds = new Set(merged.legacy.profiles.map(profile => profile.id));
        const accountIds = new Set(profiles.map((profile) => profile.id));
        for (const [legacyId, displayedId] of merged.legacyProfileIds) {
            if (legacyIds.has(legacyId) && !accountIds.has(displayedId)) origins.push([displayedId, legacyId]);
        }
    }
    return {
        themeProfiles: {
            profiles: composedProfiles,
            activeProfileIds: { light: resolve(selection.light), dark: resolve(selection.dark) },
        },
        legacyProfileIds: Object.fromEntries(origins),
    };
}

export function resolveThemeProfilesState(
    profiles: readonly ThemeProfileV1[],
    legacy: ThemeProfilesLocalStateV1,
    activeProfileIds: ThemeProfileDeviceSelectionByMode | null,
    pendingIntent?: ThemeProfileMigrationIntent | null,
    pendingProfiles?: readonly ThemeProfileV1[],
): ThemeProfilesLocalStateV1 {
    return resolveThemeProfilesStateSnapshot(profiles, legacy, activeProfileIds, pendingIntent, pendingProfiles).themeProfiles;
}


export const findThemeProfileById = (
    state: ThemeProfilesLocalStateV1,
    profileId: string | null | undefined,
): ThemeProfileV1 | null => (
    state.profiles.find((profile) => profile.id === profileId)
    ?? (isBuiltInThemeProfilePresetId(profileId) ? getBuiltInThemeProfileDefinition(profileId)?.profile ?? null : null)
);

export const getActiveThemeProfileIdForMode = (
    state: ThemeProfilesLocalStateV1,
    mode: ThemeProfileMode,
): string | null => state.activeProfileIds[mode] ?? null;

export const findActiveThemeProfileForMode = (
    state: ThemeProfilesLocalStateV1,
    mode: ThemeProfileMode,
): ThemeProfileV1 | null => findThemeProfileById(state, getActiveThemeProfileIdForMode(state, mode));

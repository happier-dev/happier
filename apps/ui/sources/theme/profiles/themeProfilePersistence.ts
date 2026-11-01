import { z } from 'zod';

import { THEME_PROFILE_ID_MAX_LENGTH, THEME_PROFILE_SCHEMA_VERSION } from './themeProfileConstants';
import {
    migrateThemeProfileOverrideTokenIds,
    sanitizeThemeProfileName,
    sanitizeThemeProfileOverridesForV1TrustBoundary,
    isRouteSafeThemeProfileId,
    isReservedThemeProfileId,
} from './themeProfileImportExport';
import type { ThemeProfileMode, ThemeProfileSelectionByMode, ThemeProfileStoredSelectionByMode, ThemeProfileV1, ThemeProfilesLocalStateV1 } from './themeProfileTypes';
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

const themeProfileModes = ['light', 'dark'] as const satisfies readonly ThemeProfileMode[];

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
    if (value.schemaVersion !== THEME_PROFILE_SCHEMA_VERSION) return null;
    if (typeof value.id !== 'string' || value.id.trim().length === 0) return null;
    if (!isRouteSafeThemeProfileId(value.id.trim())) return null;
    if (isReservedThemeProfileId(value.id.trim())) return null;
    const name = sanitizeThemeProfileName(value.name);
    if (!name) return null;
    if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
    if (!isRecord(value.base) || value.base.light !== 'light' || value.base.dark !== 'dark') return null;
    if (!isRecord(value.overrides)) return null;

    const sanitizedOverrides = sanitizeThemeProfileOverridesForV1TrustBoundary({
        light: value.overrides.light,
        dark: value.overrides.dark,
    });
    if (!sanitizedOverrides) return null;

    const profileWithoutAssetAppearance = {
        schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
        id: value.id.trim(),
        name,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        base: { light: 'light', dark: 'dark' },
        overrides: sanitizedOverrides,
    } satisfies Omit<ThemeProfileV1, 'assetAppearance'>;

    const profile: ThemeProfileV1 = {
        ...profileWithoutAssetAppearance,
        assetAppearance: isThemeProfileAssetAppearance(value.assetAppearance)
            ? value.assetAppearance
            : inferThemeProfileAssetAppearance(profileWithoutAssetAppearance),
    };

    return {
        profile,
        changed: stableStringify(profile) !== stableStringify(value),
    };
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
        const overrides = sanitizeThemeProfileOverridesForV1TrustBoundary({
            light: light.overrides,
            dark: dark.overrides,
        });
        if (!overrides) throw new Error('Invalid stored theme overrides during token migration');
        return {
            ...profile,
            overrides,
        };
    });

    return {
        state: { ...state, profiles },
        changed,
    };
};

export const ThemeProfilesLocalStateSchema: z.ZodType<ThemeProfilesLocalStateV1> = z
    .unknown()
    .transform((value) => parseThemeProfilesLocalState(value).state);

// The creation limit must not truncate valid profiles collected from several devices.
// Keep the profile parser shared with legacy persistence instead of introducing another schema.
export const ThemeProfileLibrarySchema: z.ZodType<readonly ThemeProfileV1[]> = z.unknown().transform((value) => (
    migrateThemeProfileLocalStateTokenIds(parseThemeProfilesLocalState({ profiles: value }).state).state.profiles
));

export const ThemeProfileSelectionSchema: z.ZodType<ThemeProfileStoredSelectionByMode> = z.unknown().transform((value) => {
    const record = isRecord(value) ? value : {};
    const read = (id: unknown): string | null => (
        typeof id === 'string' && isRouteSafeThemeProfileId(id)
        && (!isReservedThemeProfileId(id) || isBuiltInThemeProfilePresetId(id)) ? id : null
    );
    const selection = (value: unknown) => isRecord(value) && read(value.legacyProfileId)
        ? { legacyProfileId: read(value.legacyProfileId)! } : read(value);
    return { light: selection(record.light), dark: selection(record.dark) };
});

export function mergeThemeProfileLibraries(
    profiles: readonly ThemeProfileV1[],
    legacy: ThemeProfilesLocalStateV1,
    previousLegacyProfileIds: ReadonlyMap<string, string> = new Map(),
): Readonly<{ profiles: readonly ThemeProfileV1[]; legacyProfileIds: ReadonlyMap<string, string> }> {
    if (legacy.profiles.length === 0) return { profiles, legacyProfileIds: new Map() };
    const merged = [...profiles];
    const byId = new Map(merged.map((profile) => [profile.id, profile]));
    const remapped = new Map<string, string>();
    for (const profile of legacy.profiles) {
        let id = profile.id;
        const previousId = previousLegacyProfileIds.get(profile.id);
        // A retry may find the original collision removed. Reuse a previously displayed ID
        // only when its current definition is exactly the one being imported.
        if (previousId && stableStringify(byId.get(previousId)) === stableStringify({ ...profile, id: previousId })) id = previousId;
        let suffix = 2;
        while (byId.has(id) && stableStringify(byId.get(id)) !== stableStringify({ ...profile, id })) {
            const ending = `_${suffix++}`;
            id = `${profile.id.slice(0, THEME_PROFILE_ID_MAX_LENGTH - ending.length)}${ending}`;
        }
        if (!byId.has(id)) {
            const next = id === profile.id ? profile : { ...profile, id };
            merged.push(next);
            byId.set(id, next);
        }
        remapped.set(profile.id, id);
    }
    return { profiles: merged, legacyProfileIds: remapped };
}

export function resolveThemeProfileSelection(
    selection: ThemeProfileStoredSelectionByMode | null,
    legacy: ThemeProfilesLocalStateV1,
    legacyProfileIds: ReadonlyMap<string, string>,
): ThemeProfileSelectionByMode {
    const read = (mode: ThemeProfileMode) => {
        const legacyId = legacy.activeProfileIds[mode];
        const value = selection ? selection[mode] : legacyId
            ? isBuiltInThemeProfilePresetId(legacyId) ? legacyId : { legacyProfileId: legacyId } : null;
        return value && typeof value !== 'string' ? legacyProfileIds.get(value.legacyProfileId) ?? null : value;
    };
    return { light: read('light'), dark: read('dark') };
}

/** One composition for migration, live consumers, and startup; legacy profiles are read-only. */
export function resolveThemeProfilesState(
    profiles: readonly ThemeProfileV1[],
    legacy: ThemeProfilesLocalStateV1,
    selection: ThemeProfileStoredSelectionByMode | null,
): ThemeProfilesLocalStateV1 {
    const merged = mergeThemeProfileLibraries(profiles, legacy);
    return { profiles: merged.profiles,
        activeProfileIds: resolveThemeProfileSelection(selection, legacy, merged.legacyProfileIds) };
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

export const setActiveThemeProfileForMode = (
    state: ThemeProfilesLocalStateV1,
    mode: ThemeProfileMode,
    profileId: string | null,
): ThemeProfilesLocalStateV1 => ({
    ...state,
    activeProfileIds: {
        ...state.activeProfileIds,
        [mode]: findThemeProfileById(state, profileId) ? profileId : null,
    },
});

export const clearActiveThemeProfiles = (
    state: ThemeProfilesLocalStateV1,
): ThemeProfilesLocalStateV1 => ({
    ...state,
    activeProfileIds: DEFAULT_THEME_PROFILE_SELECTION_BY_MODE,
});

export const clearActiveThemeProfileReferences = (
    state: ThemeProfilesLocalStateV1,
    profileId: string,
): ThemeProfilesLocalStateV1 => ({
    ...state,
    activeProfileIds: {
        light: state.activeProfileIds.light === profileId ? null : state.activeProfileIds.light,
        dark: state.activeProfileIds.dark === profileId ? null : state.activeProfileIds.dark,
    },
});

export const isThemeProfileActive = (
    state: ThemeProfilesLocalStateV1,
    profileId: string,
): boolean => themeProfileModes.some((mode) => state.activeProfileIds[mode] === profileId);

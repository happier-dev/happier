import { THEME_PROFILE_ID_MAX_LENGTH } from './themeProfileConstants';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from './themeProfileTypes';

const stableStringify = (value: unknown): string => JSON.stringify(value);

/** Interpret released Account/local collision identities during one-shot import. */
export function mergeThemeProfileLibraries(
    profiles: readonly ThemeProfileV1[],
    legacy: ThemeProfilesLocalStateV1,
    capturedLegacyProfileIds?: Readonly<Record<string, string>>,
): Readonly<{ profiles: readonly ThemeProfileV1[]; legacyProfileIds: ReadonlyMap<string, string> }> {
    const merged = [...profiles];
    const byId = new Map(merged.map((profile) => [profile.id, profile]));
    const accountIds = new Set(profiles.map(profile => profile.id));
    const remapped = new Map<string, string>();
    for (const profile of legacy.profiles) {
        const hint = capturedLegacyProfileIds && Object.prototype.hasOwnProperty.call(capturedLegacyProfileIds, profile.id)
            ? capturedLegacyProfileIds[profile.id] : undefined;
        let id = hint && accountIds.has(hint) && stableStringify(byId.get(hint)) === stableStringify({ ...profile, id: hint })
            ? hint : profile.id;
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

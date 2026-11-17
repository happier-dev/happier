import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { z } from 'zod/mini';
import { ThemeReferenceSchema, parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { readThemeSettingStateSnapshot, persistThemeProfilesForSetting, parseThemeProfileLegacyIds, readCanonicalThemeProfiles, withThemeProfilesForSetting, themeReferenceForViewId } from './themeProfiles/themeProfilesSettingBinding';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';

export const THEME_MODE_CHOICES = ['adaptive', 'light', 'dark'] as const;
type ThemeModeChoice = typeof THEME_MODE_CHOICES[number];
const isThemeMode = (value: unknown): value is ThemeModeChoice => value === 'adaptive' || value === 'light' || value === 'dark';
const preferenceSchema = z.strictObject({ themePreference: z.enum(THEME_MODE_CHOICES) });
const referenceSelectionSchema = z.strictObject({ themePreference: z.enum(THEME_MODE_CHOICES),
    select: z.strictObject({ mode: z.enum(['light', 'dark']), reference: z.nullable(ThemeReferenceSchema) }) });
const compoundSelectionSchema = z.strictObject({ themePreference: z.enum(THEME_MODE_CHOICES), themeProfiles: z.unknown(), legacyProfileIds: z.optional(z.unknown()) });
const activationSchema = z.strictObject({ activation: z.strictObject({ profileId: z.nullable(z.string()),
    profileMode: z.optional(z.enum(['light', 'dark', 'all'])), nextThemePreference: z.optional(z.enum(THEME_MODE_CHOICES)),
    profile: z.optional(z.unknown()), saveDocument: z.optional(z.unknown()), before: z.optional(z.unknown()), legacyProfileIds: z.optional(z.unknown()) }),
    forceAnimate: z.optional(z.boolean()), reduceMotion: z.optional(z.boolean()) });
function readThemeSelectionIntent(value: unknown) {
    if (isThemeMode(value)) return { kind: 'preference' as const, themePreference: value };
    const preference = preferenceSchema.safeParse(value);
    if (preference.success) return { kind: 'preference' as const, ...preference.data };
    const reference = referenceSelectionSchema.safeParse(value);
    if (reference.success) return { kind: 'reference' as const, ...reference.data };
    const activation = activationSchema.safeParse(value);
    if (activation.success) {
        const { profile, saveDocument, before: beforeValue, legacyProfileIds: legacyIdsValue, ...selection } = activation.data.activation;
        if (profile !== undefined && saveDocument !== undefined) return null;
        const document = saveDocument === undefined ? undefined : parseThemeProfileDocument(saveDocument);
        if (document && !document.ok) return null;
        const before = beforeValue === undefined ? undefined : readCanonicalThemeProfiles(beforeValue);
        if (before === null) return null;
        const legacyProfileIds = legacyIdsValue === undefined ? undefined : before ? parseThemeProfileLegacyIds(legacyIdsValue, before) : null;
        if (legacyProfileIds === null) return null;
        const provenance = { ...(before ? { before } : {}), ...(legacyProfileIds ? { legacyProfileIds } : {}) };
        const profiles = profile === undefined ? undefined : readCanonicalThemeProfiles({ profiles: [profile], activeProfileIds: { light: null, dark: null } });
        if (profile !== undefined && !profiles) return null;
        return { kind: 'activation' as const, ...activation.data, activation: { ...selection, ...provenance,
            ...(profiles ? { profile: profiles.profiles[0]! } : {}),
            ...(document?.ok ? { document: document.document } : {}) } };
    }
    const parsed = compoundSelectionSchema.safeParse(value);
    if (!parsed.success) return null;
    const profiles = readCanonicalThemeProfiles(parsed.data.themeProfiles);
    if (!profiles) return null;
    const legacyProfileIds = parsed.data.legacyProfileIds === undefined ? undefined : parseThemeProfileLegacyIds(parsed.data.legacyProfileIds, profiles);
    if (legacyProfileIds === null) return null;
    return { kind: 'compound' as const, themePreference: parsed.data.themePreference, themeProfiles: profiles, legacyProfileIds };
}

/** Preference, selection and runtime transitions remain one declared setting owner. */
export const themeModeStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: THEME_MODE_CHOICES,
    read: local => isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
    parse: value => {
        const selection = readThemeSelectionIntent(value);
        // Keep the existing Action value unchanged; the discriminant is owner-local.
        const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
        return selection !== null && parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const selection = readThemeSelectionIntent(value);
        if (selection === null) return;
        const { commitThemeSelection, resolveActivationModes } = await import('@/theme/profiles/themeProfileRuntime');
        const initial = readThemeSettingStateSnapshot(local, context).themeProfiles;
        const preference = selection.kind === 'activation' ? selection.activation.nextThemePreference ?? local.themePreference : selection.themePreference;
        if (selection.kind !== 'preference') {
            const selected = await withThemeProfilesForSetting(context, async library => {
                if (selection.kind === 'reference') return library.select(selection.select);
                if (selection.kind === 'compound') {
                    if (Object.keys(selection.legacyProfileIds ?? {}).length) return SETTING_VALUE_UNAVAILABLE;
                    for (const mode of ['light', 'dark'] as const) {
                        if (initial.activeProfileIds[mode] === selection.themeProfiles.activeProfileIds[mode]) continue;
                        await library.select({ mode, reference: await themeReferenceForViewId(library, selection.themeProfiles.activeProfileIds[mode]) });
                    }
                    return;
                }
                const baseline = selection.activation.before ?? initial;
                if (Object.keys(selection.activation.legacyProfileIds ?? {}).length) return SETTING_VALUE_UNAVAILABLE;
                const saved = selection.activation.document ? await library.save({ document: selection.activation.document }) : undefined;
                if (saved && !saved.entry) return SETTING_VALUE_UNAVAILABLE;
                let profileId = saved?.entry?.id ?? selection.activation.profileId;
                if (selection.activation.profile) {
                    const { upsertThemeProfile } = await import('./themeProfiles/themeProfileScreenUtils');
                    const persisted = await persistThemeProfilesForSetting({ before: baseline,
                        next: upsertThemeProfile(baseline, selection.activation.profile), context, library });
                    if (persisted === SETTING_VALUE_UNAVAILABLE) return persisted;
                    profileId = profileId ? persisted.profileIds.get(profileId) ?? profileId : null;
                }
                const reference = saved?.entry?.reference ?? await themeReferenceForViewId(library, profileId);
                if (profileId && !reference) return SETTING_VALUE_UNAVAILABLE;
                for (const mode of resolveActivationModes({ profileMode: selection.activation.profileMode, themePreference: preference })) {
                    await library.select({ mode, reference });
                }
            });
            if (selected === SETTING_VALUE_UNAVAILABLE) return selected;
        }
        await commitThemeSelection({ currentPreference: local.themePreference, nextPreference: preference,
            nextThemeProfiles: initial, resolveSelection: () => {
                const latest = context?.readLocalSettings?.() ?? local;
                const themeProfiles = readThemeSettingStateSnapshot(latest, context).themeProfiles;
                const activatedProfile = selection.kind === 'activation' ? selection.activation.document?.profile : undefined;
                return { themePreference: selection.kind === 'activation' && selection.activation.nextThemePreference === undefined
                    ? latest.themePreference : preference,
                    themeProfiles: activatedProfile ? { ...themeProfiles,
                        profiles: [...themeProfiles.profiles.filter(profile => profile.id !== activatedProfile.id), activatedProfile],
                    } : themeProfiles };
            }, reduceMotion: readReducedMotionPreference() || (selection.kind === 'activation' && selection.reduceMotion === true),
            ...(selection.kind === 'activation' ? { forceAnimate: selection.forceAnimate } : {}),
            writeLocal: delta => {
                throwIfAborted(context?.signal);
                if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
                writeLocal({ themePreference: delta.themePreference });
            } });
    },
} satisfies SettingStorageBinding;

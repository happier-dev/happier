import { readThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { z } from 'zod/mini';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { readThemeSettingState, readThemeSettingStateSnapshot, persistThemeProfilesForSetting, parseThemeProfileLegacyIds, areThemeProfileLegacyIdsCurrent, readCanonicalThemeProfiles } from './themeProfiles/themeProfilesSettingBinding';
import { canUseLegacyThemeProfiles } from '@/sync/domains/settings/themeProfiles';
import { loadPendingAccountSettingsState } from '@/sync/domains/state/accountSettingsPersistence';
import { projectThemeProfileMigration } from '@/theme/profiles/themeProfileMigrationEdits';
import { ThemeProfileMigrationSourceExpiredError } from '@/theme/profiles/themeProfileMigrationEdits';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';

export const THEME_MODE_CHOICES = ['adaptive', 'light', 'dark'] as const;
type ThemeModeChoice = typeof THEME_MODE_CHOICES[number];

const isThemeMode = (value: unknown): value is ThemeModeChoice =>
    value === 'adaptive' || value === 'light' || value === 'dark';

const compoundSelectionSchema = z.strictObject({
    themePreference: z.enum(THEME_MODE_CHOICES),
    themeProfiles: z.unknown(),
    legacyProfileIds: z.optional(z.unknown()),
});
const activationSchema = z.strictObject({
    activation: z.strictObject({
        profileId: z.nullable(z.string()),
        profileMode: z.optional(z.enum(['light', 'dark', 'all'])),
        nextThemePreference: z.optional(z.enum(THEME_MODE_CHOICES)),
        profile: z.optional(z.unknown()),
        before: z.optional(z.unknown()),
        legacyProfileIds: z.optional(z.unknown()),
    }),
    forceAnimate: z.optional(z.boolean()),
    reduceMotion: z.optional(z.boolean()),
});

function readThemeSelectionIntent(value: unknown) {
    if (isThemeMode(value)) return value;
    const activation = activationSchema.safeParse(value);
    if (activation.success) {
        const { profile, before: beforeValue, legacyProfileIds: legacyIdsValue, ...selection } = activation.data.activation;
        const before = beforeValue === undefined ? undefined : readCanonicalThemeProfiles(beforeValue);
        if (before === null) return null;
        const legacyProfileIds = legacyIdsValue === undefined ? undefined
            : before ? parseThemeProfileLegacyIds(legacyIdsValue, before) : null;
        if (legacyProfileIds === null) return null;
        const provenance = { ...(before ? { before } : {}), ...(legacyProfileIds ? { legacyProfileIds } : {}) };
        if (profile === undefined) return { ...activation.data, activation: { ...selection, ...provenance } };
        const profiles = readCanonicalThemeProfiles({ profiles: [profile], activeProfileIds: { light: null, dark: null } });
        const canonical = profiles?.profiles[0];
        if (!canonical) return null;
        return { ...activation.data, activation: { ...selection, ...provenance, profile: canonical } };
    }
    const parsed = compoundSelectionSchema.safeParse(value);
    if (!parsed.success) return null;
    const profiles = readCanonicalThemeProfiles(parsed.data.themeProfiles);
    if (!profiles) return null;
    const legacyProfileIds = parsed.data.legacyProfileIds === undefined ? undefined
        : parseThemeProfileLegacyIds(parsed.data.legacyProfileIds, profiles);
    if (legacyProfileIds === null) return null;
    return { themePreference: parsed.data.themePreference, themeProfiles: profiles, ...(legacyProfileIds ? { legacyProfileIds } : {}) };
}

/**
 * The theme mode as a declared device setting: Actions write it through the theme owner, which
 * also applies the running theme and status bar and keeps the theme each mode uses — a raw
 * `themePreference` write would store a choice the screen does not show.
 */
export const themeModeStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    allowedValues: THEME_MODE_CHOICES,
    read: local => isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
    parse: value => {
        const selection = readThemeSelectionIntent(value);
        const parsed = SettingsDeclarationValueV1Schema.safeParse(selection);
        return selection !== null && parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const selection = readThemeSelectionIntent(value);
        if (selection === null) return;
        const { encodeThemeProfileSelection } = await import('@/sync/domains/settings/themeProfiles');
        let snapshot = await readThemeSettingState(local, context);
        const before = snapshot.themeProfiles;
        const composedLocal = { ...local, themeProfiles: before };
        const persist = (delta: Parameters<typeof writeLocal>[0]) => {
            throwIfAborted(context?.signal);
            if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
            const { themeProfiles, ...deviceDelta } = delta;
            const latest = context?.readLocalSettings?.() ?? local;
            const legacy = canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), context?.accountScope ?? null)
                ? latest.themeProfiles : DEFAULT_THEME_PROFILES_LOCAL_STATE;
            const pending = context?.accountScope ? loadPendingAccountSettingsState(context.accountScope) : null;
            writeLocal({ ...deviceDelta, ...(themeProfiles ? { themeProfileSelection:
                encodeThemeProfileSelection(snapshot.accountProfiles, legacy, themeProfiles.activeProfileIds,
                    pending?.themeProfileMigration, pending?.settings.themeProfiles) } : {}) });
        };
        const resolveQualifiedId = (id: string | null, baseline: typeof before,
            legacyProfileIds: Readonly<Record<string, string>> | undefined) => {
            const latest = context?.readLocalSettings?.() ?? local;
            if (legacyProfileIds && !areThemeProfileLegacyIdsCurrent(latest, baseline, legacyProfileIds, context)) {
                throw new ThemeProfileMigrationSourceExpiredError();
            }
            snapshot = readThemeSettingStateSnapshot(latest, context);
            if (!id || !legacyProfileIds || !Object.hasOwn(legacyProfileIds, id)) return id;
            const legacy = canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), context?.accountScope ?? null)
                ? latest.themeProfiles : DEFAULT_THEME_PROFILES_LOCAL_STATE;
            const pending = context?.accountScope ? loadPendingAccountSettingsState(context.accountScope) : null;
            return projectThemeProfileMigration(snapshot.accountProfiles, legacy,
                pending?.themeProfileMigration, pending?.settings.themeProfiles).legacyProfileIds.get(legacyProfileIds[id]!) ?? null;
        };
        if (typeof selection !== 'string' && 'activation' in selection) {
            const { activateThemeProfileFromSettingsScreen, upsertThemeProfile } = await import('./themeProfiles/themeProfileScreenUtils');
            const baseline = selection.activation.before ?? before;
            let profileId = selection.activation.profileId;
            if ('profile' in selection.activation && selection.activation.profile) {
                const next = upsertThemeProfile(baseline, selection.activation.profile);
                const persisted = await persistThemeProfilesForSetting({ local, before: baseline, next, writeLocal, context, legacyProfileIds: selection.activation.legacyProfileIds });
                if (persisted === SETTING_VALUE_UNAVAILABLE) return persisted;
                profileId = profileId ? persisted.profileIds.get(profileId) ?? profileId : null;
                snapshot = await readThemeSettingState(context?.readLocalSettings?.() ?? local, context);
            }
            await activateThemeProfileFromSettingsScreen({
                profileId, profileMode: selection.activation.profileMode,
                resolveProfileId: () => 'profile' in selection.activation && selection.activation.profile ? profileId
                    : resolveQualifiedId(profileId, baseline, selection.activation.legacyProfileIds),
                nextThemePreference: selection.activation.nextThemePreference,
                readLocalSettings: () => {
                    const latest = context?.readLocalSettings?.() ?? composedLocal;
                    snapshot = readThemeSettingStateSnapshot(latest, context);
                    return { ...latest, themeProfiles: snapshot.themeProfiles };
                },
                writeLocalSettings: persist,
                forceAnimate: selection.forceAnimate,
                reduceMotion: readReducedMotionPreference() || selection.reduceMotion === true,
            });
            return;
        }
        if (typeof selection !== 'string' && selection.legacyProfileIds
            && !areThemeProfileLegacyIdsCurrent(local, selection.themeProfiles, selection.legacyProfileIds, context)) return SETTING_VALUE_UNAVAILABLE;
        const resolveSelection = () => {
            throwIfAborted(context?.signal);
            if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
            const latest = context?.readLocalSettings?.() ?? local;
            snapshot = readThemeSettingStateSnapshot(latest, context);
            const resolveSelectedId = (id: string | null) => typeof selection === 'string' ? id
                : resolveQualifiedId(id, selection.themeProfiles, selection.legacyProfileIds);
            return {
                themePreference: typeof selection === 'string' ? selection : selection.themePreference,
                themeProfiles: typeof selection === 'string' ? snapshot.themeProfiles : { ...snapshot.themeProfiles, activeProfileIds: {
                    light: resolveSelectedId(selection.themeProfiles.activeProfileIds.light),
                    dark: resolveSelectedId(selection.themeProfiles.activeProfileIds.dark),
                } },
            };
        };
        // The owner carries the runtime theme and status-bar modules; load them only when a write happens.
        const { commitThemeSelection } = await import('@/theme/profiles/themeProfileRuntime');
        await commitThemeSelection({
            currentPreference: isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
            nextPreference: typeof selection === 'string' ? selection : selection.themePreference,
            nextThemeProfiles: before,
            resolveSelection,
            reduceMotion: readReducedMotionPreference(),
            writeLocal: persist,
        });
    },
} satisfies SettingStorageBinding;

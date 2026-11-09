import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { z } from 'zod/mini';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, resolveThemeProfilesState, ThemeProfileLibrarySchema, ThemeProfileSelectionSchema } from '@/theme/profiles/themeProfilePersistence';
import { canUseLegacyThemeProfiles, resolveAccountThemeProfiles } from '@/sync/domains/settings/themeProfiles';
import { loadAccountSettings, loadPendingAccountSettingsState } from '@/sync/domains/state/accountSettingsPersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ThemeProfileMigrationEdit, ThemeProfileMigrationIntent, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { projectThemeProfileMigration } from '@/theme/profiles/themeProfileMigrationEdits';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type LocalOwnerBinding = Extract<SettingStorageBinding, { kind: 'localOwner' }>;
export type ThemeSettingContext = Parameters<LocalOwnerBinding['commit']>[3];
type ThemeSettingState = Readonly<{ accountProfiles: readonly ThemeProfileV1[]; themeProfiles: ThemeProfilesLocalStateV1 }>;

const themeProfilesValueSchema = z.strictObject({ profiles: ThemeProfileLibrarySchema, activeProfileIds: z.unknown() });

export function readCanonicalThemeProfiles(value: unknown): ThemeProfilesLocalStateV1 | null {
    const parsed = themeProfilesValueSchema.safeParse(value);
    if (!parsed.success) return null;
    const selection = ThemeProfileSelectionSchema.parse(parsed.data.activeProfileIds);
    const state = resolveThemeProfilesState(parsed.data.profiles, DEFAULT_THEME_PROFILES_LOCAL_STATE, selection);
    return sameStrictJsonValue(state.activeProfileIds, parsed.data.activeProfileIds) ? state : null;
}

const legacyIdsSchema = z.record(z.string(), z.string());
const editIntentSchema = z.strictObject({ edit: z.strictObject({ before: z.unknown(), next: z.unknown(), legacyProfileIds: legacyIdsSchema }) });

export function parseThemeProfileLegacyIds(value: unknown, before: ThemeProfilesLocalStateV1): Readonly<Record<string, string>> | null {
    const parsed = legacyIdsSchema.safeParse(value);
    if (!parsed.success) return null;
    const ids = new Set(before.profiles.map(profile => profile.id));
    if (Object.keys(parsed.data).some(id => !ids.has(id))
        || new Set(Object.values(parsed.data)).size !== Object.keys(parsed.data).length) return null;
    return parsed.data;
}

export function areThemeProfileLegacyIdsCurrent(local: LocalSettings, before: ThemeProfilesLocalStateV1,
    ids: Readonly<Record<string, string>>, context: ThemeSettingContext): boolean {
    if (!canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), context?.accountScope ?? null)) return Object.keys(ids).length === 0;
    const sourceById = new Map(local.themeProfiles.profiles.map(profile => [profile.id, profile]));
    const pending = context?.accountScope ? loadPendingAccountSettingsState(context.accountScope) : null;
    const projected = projectThemeProfileMigration([], local.themeProfiles, pending?.themeProfileMigration, pending?.settings.themeProfiles);
    const projectedById = new Map(projected.legacy.profiles.map(profile => [profile.id, profile]));
    const shownById = new Map(before.profiles.map(profile => [profile.id, profile]));
    return Object.entries(ids).every(([viewId, sourceId]) => {
        const source = sourceById.get(sourceId);
        const shown = shownById.get(viewId);
        const projectedSource = projectedById.get(sourceId);
        return source && shown ? sameStrictJsonValue({ ...source, id: viewId }, shown)
            || (projectedSource ? sameStrictJsonValue({ ...projectedSource, id: viewId }, shown) : false) : false;
    });
}

function readLibraryIntent(value: unknown) {
    const edit = editIntentSchema.safeParse(value);
    if (edit.success) {
        const before = readCanonicalThemeProfiles(edit.data.edit.before);
        const next = readCanonicalThemeProfiles(edit.data.edit.next);
        const legacyProfileIds = before ? parseThemeProfileLegacyIds(edit.data.edit.legacyProfileIds, before) : null;
        return before && next && legacyProfileIds
            ? { before, next, legacyProfileIds, value: { edit: { before, next, legacyProfileIds } } } : null;
    }
    const next = readCanonicalThemeProfiles(value);
    return next ? { before: null, next, legacyProfileIds: undefined, value: next } : null;
}

function composeThemeSettingState(local: LocalSettings, context: ThemeSettingContext, accountProfiles: readonly ThemeProfileV1[]) {
    const pending = context?.accountScope ? loadPendingAccountSettingsState(context.accountScope) : null;
    const themeProfiles = resolveAccountThemeProfiles({ profiles: accountProfiles, legacy: local.themeProfiles,
        pendingProfiles: pending?.settings.themeProfiles, pendingIntent: pending?.themeProfileMigration,
        selection: local.themeProfileSelection, legacyScope: readThemeProfileLegacyAccountScope(),
        scope: context?.accountScope ?? null });
    return { accountProfiles, themeProfiles };
}

/** Transition callbacks read the current exact-scope projection without another network request. */
export function readThemeSettingStateSnapshot(local: LocalSettings, context: ThemeSettingContext): ThemeSettingState {
    const state = getStorage().getState();
    const settings = context?.accountScope
        ? areAccountSettingsScopesEqual(state.settingsScope, context.accountScope) ? state.settings
            : settingsParse(loadAccountSettings(context.accountScope).settings)
        : undefined;
    return composeThemeSettingState(local, context, settings?.themeProfiles ?? []);
}

export async function readThemeSettingState(local: LocalSettings, context: ThemeSettingContext): Promise<ThemeSettingState> {
    const settings = context?.accountScope ? await context.readSettings?.() : undefined;
    return composeThemeSettingState(local, context, settings?.themeProfiles ?? []);
}

export async function readThemeProfilesForSetting(local: LocalSettings, context: ThemeSettingContext): Promise<ThemeProfilesLocalStateV1> {
    return (await readThemeSettingState(local, context)).themeProfiles;
}

/** Apply only the user's library delta on every CAS candidate, preserving concurrent unrelated profiles. */
export async function persistThemeProfilesForSetting(input: Readonly<{
    local: LocalSettings;
    before: ThemeProfilesLocalStateV1;
    next: ThemeProfilesLocalStateV1;
    writeLocal: (delta: Partial<LocalSettings>) => void;
    context: ThemeSettingContext;
    legacyProfileIds?: Readonly<Record<string, string>>;
    replaceLibrary?: true;
}>): Promise<Readonly<{ profileIds: ReadonlyMap<string, string> }> | typeof SETTING_VALUE_UNAVAILABLE> {
    const { local, before, next, writeLocal, context } = input;
    const consumesLegacy = local.themeProfiles.profiles.length > 0
        && canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), context?.accountScope ?? null);
    const previous = new Map(before.profiles.map(profile => [profile.id, profile]));
    const capturedLegacyIds = input.legacyProfileIds;
    if (capturedLegacyIds && !areThemeProfileLegacyIdsCurrent(local, before, capturedLegacyIds, context)) {
        return SETTING_VALUE_UNAVAILABLE;
    }
    const desired = new Map(next.profiles.map(profile => [profile.id, profile]));
    const removed = new Set(before.profiles.filter(profile => !desired.has(profile.id)).map(profile => profile.id));
    const changed = next.profiles.filter(profile => !sameStrictJsonValue(previous.get(profile.id), profile));
    let committedIds = new Map<string, string>();
    let committedLegacyIds: ReadonlyMap<string, string> = new Map();
    const legacyDisplayedIds = new Map(Object.entries(capturedLegacyIds ?? {}).map(([displayed, original]) => [original, displayed]));
    const migrationEdits: ThemeProfileMigrationEdit[] = [...removed].map(id => ({
        target: { kind: capturedLegacyIds && Object.hasOwn(capturedLegacyIds, id) ? 'legacy' : 'account',
            id: capturedLegacyIds?.[id] ?? id }, profile: null,
    }));
    migrationEdits.push(...changed.map(profile => ({
        target: { kind: capturedLegacyIds && Object.hasOwn(capturedLegacyIds, profile.id) ? 'legacy' as const : 'account' as const,
            id: capturedLegacyIds?.[profile.id] ?? profile.id }, profile,
    })));
    let intent: ThemeProfileMigrationIntent = { edits: migrationEdits,
        legacyProfileIds: Object.fromEntries(local.themeProfiles.profiles.map(profile => [profile.id, legacyDisplayedIds.get(profile.id) ?? profile.id])),
        ...(input.replaceLibrary ? { replaceLibrary: true } : {}) };
    let completed = false;
    const complete = () => {
        throwIfAborted(context?.signal);
        if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
        const latest = context?.readLocalSettings?.() ?? local;
        const storedSelection = latest.themeProfileSelection;
        const readStoredId = (value: NonNullable<LocalSettings['themeProfileSelection']>['light']) => (
            value && typeof value !== 'string' ? committedLegacyIds.get(value.legacyProfileId) ?? null : value
        );
        const selectionChanged = !sameStrictJsonValue(latest.themeProfileSelection, local.themeProfileSelection);
        const latestSelection = input.replaceLibrary && !selectionChanged ? next.activeProfileIds
            : storedSelection ? { light: readStoredId(storedSelection.light), dark: readStoredId(storedSelection.dark) }
                : before.activeProfileIds;
        const remap = (id: string | null) => id ? committedIds.get(id) ?? id : null;
        const selection = {
            light: before.activeProfileIds.light === next.activeProfileIds.light
                ? selectionChanged ? latestSelection.light : remap(latestSelection.light) : remap(next.activeProfileIds.light),
            dark: before.activeProfileIds.dark === next.activeProfileIds.dark
                ? selectionChanged ? latestSelection.dark : remap(latestSelection.dark) : remap(next.activeProfileIds.dark),
        };
        const removedIds = new Set([...removed].map(id => committedIds.get(id) ?? id));
        if (selection.light && removedIds.has(selection.light)) selection.light = null;
        if (selection.dark && removedIds.has(selection.dark)) selection.dark = null;
        const clearsLegacy = consumesLegacy && sameStrictJsonValue(latest.themeProfiles, local.themeProfiles);
        writeLocal({ themeProfileSelection: selection,
            ...(clearsLegacy ? { themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE } : {}) });
        if (clearsLegacy) writeThemeProfileLegacyAccountScope(null);
        completed = true;
    };
    if (input.replaceLibrary || consumesLegacy || removed.size > 0 || changed.length > 0) {
        if (!context?.accountScope || !context.mutateSettings) return SETTING_VALUE_UNAVAILABLE;
        await context.mutateSettings(settings => {
            if (consumesLegacy && context.readLocalSettings
                && !sameStrictJsonValue(context.readLocalSettings().themeProfiles, local.themeProfiles)) return null;
            const projected = projectThemeProfileMigration(settings.themeProfiles,
                consumesLegacy ? local.themeProfiles : DEFAULT_THEME_PROFILES_LOCAL_STATE,
                consumesLegacy ? intent : { ...intent, legacyProfileIds: {} },
                intent.replaceLibrary ? next.profiles : undefined);
            committedIds = new Map();
            committedLegacyIds = projected.legacyProfileIds;
            for (const [viewId, sourceId] of Object.entries(capturedLegacyIds ?? {})) {
                const actual = projected.legacyProfileIds.get(sourceId);
                if (actual) committedIds.set(viewId, actual);
            }
            return { themeProfiles: [...projected.profiles] };
        }, consumesLegacy ? { themeProfileMigration: { source: local.themeProfiles, intent,
            prepareIntent: merged => { intent = merged; },
            getLegacyProfileIds: () => Object.fromEntries(committedLegacyIds), complete } } : undefined);
    }
    if (!completed) complete();
    return { profileIds: committedIds };
}

/** The composed intent has a local selection and an account-owned library; transport stays in the admitted CAS owner. */
export const themeProfilesStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', requiresAccountScope: true,
    read: (local, context) => readThemeProfilesForSetting(local, context ? { ...context, isCurrent: () => true } : undefined),
    parse: value => {
        const intent = readLibraryIntent(value);
        return intent ? { success: true, value: SettingsDeclarationValueV1Schema.parse(intent.value) } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const intent = readLibraryIntent(value);
        if (!intent) return;
        const profiles = intent.next;
        const before = intent.before ?? await readThemeProfilesForSetting(local, context);
        const persisted = await persistThemeProfilesForSetting({ local, before, next: profiles, writeLocal, context, legacyProfileIds: intent.legacyProfileIds, ...(intent.before ? {} : { replaceLibrary: true }) });
        if (persisted === SETTING_VALUE_UNAVAILABLE) return persisted;
        const { commitThemeSelection } = await import('@/theme/profiles/themeProfileRuntime');
        const latest = context?.readLocalSettings?.() ?? local;
        const runtimeProfiles = await readThemeProfilesForSetting(latest, context);
        await commitThemeSelection({ currentPreference: latest.themePreference, nextPreference: latest.themePreference,
            nextThemeProfiles: runtimeProfiles, reduceMotion: true, writeLocal: () => {
                throwIfAborted(context?.signal);
                if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
            } });
    },
} satisfies SettingStorageBinding;

import { z } from 'zod/mini';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseThemeProfileDocument, mergeThemeProfileDocumentEdit, type ThemeProfileLibrary, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, resolveThemeProfilesState, ThemeProfileLibrarySchema, ThemeProfileSelectionSchema, readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { readThemeProfilesSnapshot } from '@/sync/store/useThemeProfiles';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { HappyError } from '@/utils/errors/errors';

type LocalOwnerBinding = Extract<SettingStorageBinding, { kind: 'localOwner' }>;
export type ThemeSettingContext = Parameters<LocalOwnerBinding['commit']>[3];
type ThemeSettingReadContext = Parameters<LocalOwnerBinding['read']>[1];
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
const saveDocumentSchema = z.strictObject({ saveDocument: z.unknown() });
export function parseThemeProfileLegacyIds(value: unknown, before: ThemeProfilesLocalStateV1): Readonly<Record<string, string>> | null {
    const parsed = legacyIdsSchema.safeParse(value);
    if (!parsed.success) return null;
    const ids = new Set(before.profiles.map(profile => profile.id));
    return Object.keys(parsed.data).some(id => !ids.has(id)) || new Set(Object.values(parsed.data)).size !== Object.keys(parsed.data).length ? null : parsed.data;
}
function readLibraryIntent(value: unknown) {
    const raw = saveDocumentSchema.safeParse(value);
    if (raw.success) {
        const parsed = parseThemeProfileDocument(raw.data.saveDocument);
        return parsed.ok ? { kind: 'document' as const, document: parsed.document, value: { saveDocument: parsed.document.raw } } : null;
    }
    const edit = editIntentSchema.safeParse(value);
    if (edit.success) {
        const before = readCanonicalThemeProfiles(edit.data.edit.before);
        const next = readCanonicalThemeProfiles(edit.data.edit.next);
        const legacyProfileIds = before ? parseThemeProfileLegacyIds(edit.data.edit.legacyProfileIds, before) : null;
        return before && next && legacyProfileIds ? { kind: 'edit' as const, before, next, legacyProfileIds,
            value: { edit: { before, next, legacyProfileIds } } } : null;
    }
    const next = readCanonicalThemeProfiles(value);
    return next ? { kind: 'edit' as const, before: null, next, legacyProfileIds: undefined, value: next } : null;
}
export function readThemeSettingStateSnapshot(_local: LocalSettings, context: ThemeSettingReadContext) {
    const snapshot = readThemeProfilesSnapshot(context?.accountScope);
    return { themeProfiles: snapshot.themeProfiles };
}
export async function readThemeProfilesForSetting(local: LocalSettings, context: ThemeSettingReadContext): Promise<ThemeProfilesLocalStateV1> {
    return readThemeSettingStateSnapshot(local, context).themeProfiles;
}
async function readThemeLibraryForSetting(_local: LocalSettings, context: ThemeSettingReadContext) {
    if (!context?.accountScope) return SETTING_VALUE_UNAVAILABLE;
    const { sync } = await import('@/sync/sync');
    try {
        return await sync.withThemeProfileLibrary(async library => ({ entries: await library.list(),
            selection: readThemeProfileReferenceSelection(loadLocalSettings().themeProfileSelection) }),
        { signal: context.signal, expectedScope: context.accountScope });
    } catch (error) {
        if (error instanceof HappyError && error.code === 'artifact_content_unavailable') return SETTING_VALUE_UNAVAILABLE;
        throw error;
    }
}
export async function withThemeProfilesForSetting<T>(context: ThemeSettingContext, operation: (library: ThemeProfileLibrary) => Promise<T>): Promise<T | typeof SETTING_VALUE_UNAVAILABLE> {
    if (!context?.accountScope) return SETTING_VALUE_UNAVAILABLE;
    const { sync } = await import('@/sync/sync');
    return sync.withThemeProfileLibrary(operation, { signal: context.signal, expectedScope: context.accountScope });
}
export async function themeReferenceForViewId(library: ThemeProfileLibrary, id: string | null): Promise<ThemeReference | null> {
    return id ? (await library.list()).find(entry => entry.id === id)?.reference ?? null : null;
}
/** Old settings Actions are consumers of addressed Artifact operations. */
export async function persistThemeProfilesForSetting(input: Readonly<{
    before: ThemeProfilesLocalStateV1; next: ThemeProfilesLocalStateV1; context: ThemeSettingContext;
    legacyProfileIds?: Readonly<Record<string, string>>; replaceLibrary?: true; library?: ThemeProfileLibrary;
}>): Promise<Readonly<{ profileIds: ReadonlyMap<string, string> }> | typeof SETTING_VALUE_UNAVAILABLE> {
    const { before, next } = input;
    if (Object.keys(input.legacyProfileIds ?? {}).length) return SETTING_VALUE_UNAVAILABLE;
    const previous = new Map(before.profiles.map(profile => [profile.id, profile]));
    const desired = new Set(next.profiles.map(profile => profile.id));
    const changed = input.replaceLibrary ? next.profiles : next.profiles.filter(profile => !sameStrictJsonValue(previous.get(profile.id), profile));
    const persist = async (library: ThemeProfileLibrary) => {
        const removed = new Set((input.replaceLibrary
            ? (await library.list()).filter(entry => entry.reference.kind === 'artifact' && entry.deletable)
            : before.profiles).filter(profile => !desired.has(profile.id)).map(profile => profile.id));
        const profileIds = new Map<string, string>();
        for (const profile of changed) {
            const beforeProfile = previous.get(profile.id);
            const current = beforeProfile || input.replaceLibrary ? await library.get({ kind: 'artifact', id: profile.id }) : null;
            const parsed = parseThemeProfileDocument(profile);
            if (!parsed.ok) throw new Error('Invalid theme profile');
            const edits = Object.fromEntries(Object.entries(profile).filter(([key, value]) => key !== 'schemaVersion'
                && !sameStrictJsonValue(value, beforeProfile?.[key as keyof ThemeProfileV1])));
            const document = current ? mergeThemeProfileDocumentEdit(current, edits) : parsed.document;
            const result = await library.save({ document });
            if (result.entry) profileIds.set(profile.id, result.entry.id);
        }
        for (const id of removed) await library.delete(id);
        for (const mode of ['light', 'dark'] as const) {
            if (!input.replaceLibrary && before.activeProfileIds[mode] === next.activeProfileIds[mode]) continue;
            // Removing a record leaves its retained reference unavailable.
            if (!input.replaceLibrary && next.activeProfileIds[mode] === null && removed.has(before.activeProfileIds[mode] ?? '')) continue;
            const id = next.activeProfileIds[mode];
            await library.select({ mode, reference: await themeReferenceForViewId(library, id ? profileIds.get(id) ?? id : null) });
        }
        return { profileIds };
    };
    return input.library ? persist(input.library) : withThemeProfilesForSetting(input.context, persist);
}
export const themeProfilesStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', requiresAccountScope: true,
    read: readThemeLibraryForSetting,
    parse: value => {
        const intent = readLibraryIntent(value);
        return intent ? { success: true, value: SettingsDeclarationValueV1Schema.parse(intent.value) } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const intent = readLibraryIntent(value);
        if (!intent) return;
        const persisted = intent.kind === 'document'
            ? await withThemeProfilesForSetting(context, library => library.save({ document: intent.document }))
            : await persistThemeProfilesForSetting({ before: intent.before ?? await readThemeProfilesForSetting(local, context),
                next: intent.next, context, legacyProfileIds: intent.legacyProfileIds, ...(intent.before ? {} : { replaceLibrary: true }) });
        if (persisted === SETTING_VALUE_UNAVAILABLE) return persisted;
        const { commitThemeSelection } = await import('@/theme/profiles/themeProfileRuntime');
        const latest = context?.readLocalSettings?.() ?? local;
        await commitThemeSelection({ currentPreference: latest.themePreference, nextPreference: latest.themePreference,
            nextThemeProfiles: await readThemeProfilesForSetting(latest, context), reduceMotion: true, writeLocal: () => {
                throwIfAborted(context?.signal);
                if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
            } });
    },
} satisfies SettingStorageBinding;

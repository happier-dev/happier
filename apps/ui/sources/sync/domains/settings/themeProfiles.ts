import { DEFAULT_THEME_PROFILES_LOCAL_STATE, findThemeProfileById, mergeThemeProfileLibraries, resolveThemeProfileSelection } from '@/theme/profiles/themeProfilePersistence';
import { applyThemeProfileMigrationEdits } from '@/theme/profiles/themeProfileMigrationEdits';
import { isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import type { ThemeProfileMigrationEdit, ThemeProfileMigrationIntent, ThemeProfileStoredSelectionByMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { areAccountSettingsJsonValuesEqual } from './accountSettingsStructuralEquality';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual, createAccountSettingsScope, type AccountSettingsScope } from './scope/accountSettingsScope';

const acknowledgedLegacyIds = new Map<string, ReadonlyMap<string, string>>();
export type ThemeProfileView = Readonly<{
    scope: AccountSettingsScope | null;
    state: ThemeProfilesLocalStateV1;
    legacyProfileIds: ReadonlyMap<string, string>;
    representedLegacyProfileIds: ReadonlyMap<string, string>;
    migratedLegacyProfileIds: ReadonlyMap<string, string>;
}>;

/** Live drafts can outlast the durable migration checkpoint and its legacy backup. */
export function rememberThemeProfileMigration(scope: AccountSettingsScope, legacyIds: ReadonlyMap<string, string>): void {
    acknowledgedLegacyIds.set(accountSettingsScopeKeySuffix(scope), new Map(legacyIds));
}

export function canUseLegacyThemeProfiles(legacyScope: AccountSettingsScope | null, scope: AccountSettingsScope | null): boolean {
    return !legacyScope || areAccountSettingsScopesEqual(legacyScope, scope);
}

const sameScope = (a: AccountSettingsScope | null, b: AccountSettingsScope | null) => (
    a === null && b === null || areAccountSettingsScopesEqual(a, b)
);

const themeProfileTarget = (view: ThemeProfileView, id: string): ThemeProfileMigrationEdit['target'] => {
    for (const [original, displayed] of view.legacyProfileIds) {
        if (displayed === id) return { kind: 'legacy', id: original };
    }
    return { kind: 'account', id };
};

const resolveTargetId = (view: ThemeProfileView, target: ThemeProfileMigrationEdit['target']) => (
    target.kind === 'account' ? target.id
        : view.legacyProfileIds.get(target.id) ?? view.migratedLegacyProfileIds.get(target.id) ?? null
);

/** Route state carries provenance as a string so delayed navigation cannot reinterpret a legacy ID. */
export function createThemeProfileNavigationParams(view: ThemeProfileView | undefined, profileId: string) {
    if (isBuiltInThemeProfilePresetId(profileId)) return { profileId };
    const target = view && !view.scope ? { kind: 'legacy' as const, id: profileId }
        : view ? themeProfileTarget(view, profileId) : null;
    return { profileId, ...(view && target
        ? { themeProfileIdentity: JSON.stringify({ scope: view.scope, target }) } : {}) };
}

export function resolveThemeProfileNavigationId(
    view: ThemeProfileView | undefined, profileId: string | null, identity: string | null,
): string | null {
    if (!identity) return profileId;
    if (!view) return null;
    try {
        const value: unknown = JSON.parse(identity);
        if (!value || typeof value !== 'object' || !('scope' in value) || !('target' in value)) return null;
        const origin = value.scope;
        const scope = origin === null ? null : origin && typeof origin === 'object' && 'serverId' in origin && 'accountId' in origin
            ? createAccountSettingsScope(origin.serverId, origin.accountId) ?? undefined : undefined;
        const target = value.target;
        if (scope === undefined || !sameScope(scope, view.scope) || !target || typeof target !== 'object'
            || !('kind' in target) || !('id' in target) || typeof target.id !== 'string'
            || (target.kind !== 'legacy' && target.kind !== 'account')) return null;
        return resolveTargetId(view, { kind: target.kind, id: target.id });
    } catch {
        return null;
    }
}

export function resolveAccountThemeProfileView(input: Readonly<{
    profiles: readonly ThemeProfileV1[];
    legacy: ThemeProfilesLocalStateV1;
    selection: ThemeProfileStoredSelectionByMode | null;
    legacyScope: AccountSettingsScope | null;
    scope: AccountSettingsScope | null;
    pendingProfiles?: readonly ThemeProfileV1[];
    pendingIntent?: ThemeProfileMigrationIntent | null;
}>): ThemeProfileView {
    const legacy = canUseLegacyThemeProfiles(input.legacyScope, input.scope)
        ? input.legacy : DEFAULT_THEME_PROFILES_LOCAL_STATE;
    const merged = mergeThemeProfileLibraries(input.profiles,
        input.pendingIntent?.acknowledged ? DEFAULT_THEME_PROFILES_LOCAL_STATE : legacy);
    const legacyProfileIds = new Map<string, string>();
    const representedLegacyProfileIds = new Map<string, string>();
    if (input.pendingIntent) {
        if (!input.pendingIntent.acknowledged) {
            for (const [original, displayed] of Object.entries(input.pendingIntent.legacyProfileIds)) legacyProfileIds.set(original, displayed);
            for (const [original, displayed] of Object.entries(input.pendingIntent.representedLegacyProfileIds ?? {})) representedLegacyProfileIds.set(original, displayed);
        }
    } else {
        const accountIds = new Set(input.profiles.map(profile => profile.id));
        for (const [original, displayed] of merged.legacyProfileIds) {
            (accountIds.has(displayed) ? representedLegacyProfileIds : legacyProfileIds).set(original, displayed);
        }
    }
    const migratedLegacyProfileIds = input.pendingIntent?.acknowledged
        ? new Map(Object.entries(input.pendingIntent.legacyProfileIds))
        : new Map<string, string>(input.scope ? acknowledgedLegacyIds.get(accountSettingsScopeKeySuffix(input.scope)) : undefined);
    const ids = new Map([...migratedLegacyProfileIds, ...representedLegacyProfileIds, ...legacyProfileIds]);
    const state = {
        profiles: input.pendingIntent && input.pendingProfiles ? input.pendingProfiles : merged.profiles,
        activeProfileIds: { ...resolveThemeProfileSelection(input.selection, legacy, ids) },
    };
    for (const mode of ['light', 'dark'] as const) {
        if (!findThemeProfileById(state, state.activeProfileIds[mode])) state.activeProfileIds[mode] = null;
    }
    const view = { scope: input.scope, state, legacyProfileIds, representedLegacyProfileIds,
        migratedLegacyProfileIds: new Map([...migratedLegacyProfileIds, ...representedLegacyProfileIds]) };
    return view;
}

/** Rebase only the accepted UI delta; a rendered library is never a replacement authority. */
export function rebaseThemeProfileUiChange(
    captured: ThemeProfileView, next: ThemeProfilesLocalStateV1, current: ThemeProfileView,
): ThemeProfilesLocalStateV1 {
    const before = captured.state;
    if (!sameScope(captured.scope, current.scope)) {
        throw new Error('This theme edit belongs to an inactive account');
    }
    const resolveId = (id: string) => {
        const resolved = resolveTargetId(current, themeProfileTarget(captured, id));
        if (!resolved) throw new Error('This legacy theme edit no longer has a proven account identity');
        return resolved;
    };
    const edits = createThemeProfileMigrationEdits(before, next, new Map()).map(edit => {
        const id = resolveId(edit.target.id);
        const existed = before.profiles.some(profile => profile.id === edit.target.id);
        const exists = current.state.profiles.some(profile => profile.id === id);
        if (edit.profile && (existed ? !exists : exists)) throw new Error('This theme edit target is no longer available');
        return { target: { kind: 'account' as const, id }, profile: edit.profile ? { ...edit.profile, id } : null };
    });
    const profiles = applyThemeProfileMigrationEdits(current.state.profiles, edits, new Map());
    const removedIds = new Set(edits.filter(edit => edit.profile === null).map(edit => edit.target.id));
    const activeProfileIds = { ...current.state.activeProfileIds };
    for (const mode of ['light', 'dark'] as const) {
        if (before.activeProfileIds[mode] !== next.activeProfileIds[mode]) {
            const requested = next.activeProfileIds[mode];
            const id = requested ? resolveId(requested) : null;
            if (id && !findThemeProfileById({ profiles, activeProfileIds }, id)) {
                throw new Error('This theme selection is no longer available');
            }
            const previousId = before.activeProfileIds[mode];
            const deletedPreviousId = previousId ? resolveId(previousId) : null;
            if (!(id === null && deletedPreviousId && removedIds.has(deletedPreviousId)
                && current.state.activeProfileIds[mode] !== deletedPreviousId)) activeProfileIds[mode] = id;
        }
        if (!findThemeProfileById({ profiles, activeProfileIds }, activeProfileIds[mode])) activeProfileIds[mode] = null;
    }
    return { profiles, activeProfileIds };
}

export function resolveAccountThemeProfiles(input: Parameters<typeof resolveAccountThemeProfileView>[0]): ThemeProfilesLocalStateV1 {
    return resolveAccountThemeProfileView(input).state;
}

export function encodeThemeProfileSelection(
    value: ThemeProfilesLocalStateV1, legacyProfileIds: ReadonlyMap<string, string>,
): ThemeProfileStoredSelectionByMode {
    const originalIds = new Map([...legacyProfileIds].map(([original, displayed]) => [displayed, original]));
    const read = (id: string | null) => id && originalIds.has(id) ? { legacyProfileId: originalIds.get(id)! } : id;
    return { light: read(value.activeProfileIds.light), dark: read(value.activeProfileIds.dark) };
}

export function createThemeProfileMigrationEdits(
    before: ThemeProfilesLocalStateV1, next: ThemeProfilesLocalStateV1, legacyProfileIds: ReadonlyMap<string, string>,
): readonly ThemeProfileMigrationEdit[] {
    const originalIds = new Map([...legacyProfileIds].map(([original, displayed]) => [displayed, original]));
    const previous = new Map(before.profiles.map(profile => [profile.id, profile]));
    const desired = new Map(next.profiles.map(profile => [profile.id, profile]));
    const edits: ThemeProfileMigrationEdit[] = [];
    for (const id of new Set([...previous.keys(), ...desired.keys()])) {
        if (areAccountSettingsJsonValuesEqual(previous.get(id), desired.get(id))) continue;
        edits.push({ target: originalIds.has(id) ? { kind: 'legacy', id: originalIds.get(id)! } : { kind: 'account', id },
            profile: desired.get(id) ?? null });
    }
    return edits;
}

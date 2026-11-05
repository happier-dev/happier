import * as React from 'react';
import { create } from 'zustand';
import type { Settings, SettingsWriteDelta } from '../domains/settings/settings';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { ProjectAtmosphere, AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { getStorage } from '../domains/state/storageStore';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '../domains/settings/scope/accountSettingsScope';
import { buildBuiltInAccountSettingMutationV1, readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { ProjectAtmosphereSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingsDeclarationTargetV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

type PreviewEntry<T> = Readonly<{ value: T; owner: symbol }>;
type PreviewValues<T> = { [K in keyof T]?: PreviewEntry<T[K]> };
const EMPTY_ACCOUNT: PreviewValues<Settings> = {};
const EMPTY_LOCAL: PreviewValues<LocalSettings> = {};

/** Gesture drafts and write-owned holds. Persistence and Action admission read the real store. */
export const useSettingsPreviewStore = create<{
    scope: AccountSettingsScope | null;
    account: PreviewValues<Settings>;
    local: PreviewValues<LocalSettings>;
    projects: Record<string, PreviewEntry<ProjectAtmosphere | 'home'> | undefined>;
    profiles: Record<string, PreviewEntry<AtmospherePresentation> | undefined>;
}>(() => ({ scope: null, account: EMPTY_ACCOUNT, local: EMPTY_LOCAL, projects: {}, profiles: {} }));

export function settingsPreviewScopeMatches(scope: AccountSettingsScope | null, previewScope: AccountSettingsScope | null) {
    return scope !== null && areAccountSettingsScopesEqual(scope, previewScope);
}

/** Synchronous edit input; admission and persistence never use this presentation projection. */
export function readSettingWithPreview<K extends keyof Settings>(name: K): Settings[K] {
    const stored = getStorage().getState();
    const preview = useSettingsPreviewStore.getState();
    const entry = settingsPreviewScopeMatches(stored.settingsScope, preview.scope) ? preview.account[name] : undefined;
    return entry ? entry.value : stored.settings[name];
}

/** Current presentation preference for commands that do not need a mounted subscription. */
export function readLocalSettingWithPreview<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    const entry = useSettingsPreviewStore.getState().local[name];
    return entry ? entry.value : getStorage().getState().localSettings[name];
}

export function readProjectAtmospherePreview(project: Readonly<{ serverId: string; projectKey: string }>) {
    const stored = getStorage().getState();
    const preview = useSettingsPreviewStore.getState();
    return settingsPreviewScopeMatches(stored.settingsScope, preview.scope)
        ? preview.projects[projectAtmospherePreviewKey(project)]?.value : undefined;
}

/** One hold per write, transferred from any gesture owner and withdrawn only by this write. */
export function holdSettingWrite(setting: Readonly<{ anchor: string; target?: SettingsDeclarationTargetV1 }>, value: unknown,
    mutate?: (current: Settings) => SettingsWriteDelta | null) {
    const scope = getStorage().getState().settingsScope;
    const owner = Symbol(setting.anchor);
    const declaration = readBuiltInSettingDeclarationV1(setting.anchor);
    const project = declaration?.storage?.scope === 'project' && setting.target?.kind === 'project' ? setting.target : null;
    const projectKey = project ? projectAtmospherePreviewKey(project) : null;
    const projectValue = project ? (value === 'home' ? { success: true as const, data: 'home' as const }
        : ProjectAtmosphereSchema.safeParse(value)) : null;
    const keys: Array<keyof Settings> = [];
    useSettingsPreviewStore.setState(state => {
        if (!scope || !settingsPreviewScopeMatches(scope, getStorage().getState().settingsScope)) return state;
        const same = settingsPreviewScopeMatches(scope, state.scope);
        if (projectKey && projectValue?.success) return { scope,
            projects: { ...(same ? state.projects : {}), [projectKey]: { owner, value: projectValue.data } },
            account: same ? state.account : {}, profiles: same ? state.profiles : {} };
        if (!declaration || declaration.sensitive || declaration.storage?.scope !== 'account'
            || declaration.storage.access !== 'read_write') return state;
        if (setting.target) return state;
        const held = same ? Object.fromEntries(Object.entries(state.account).map(([key, entry]) => [key, entry?.value])) : {};
        const current = { ...getStorage().getState().settings, ...held };
        const delta = mutate ? mutate(current) : buildBuiltInAccountSettingMutationV1(declaration, current, value);
        if (!delta) return state;
        // Canonical declaration mutations name keys in this Settings projection.
        keys.push(...Object.keys(delta) as Array<keyof Settings>);
        return { scope, account: { ...(same ? state.account : {}),
            ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, { owner, value }])) },
            projects: same ? state.projects : {}, profiles: same ? state.profiles : {} };
    });
    return () => useSettingsPreviewStore.setState(state => {
        if (!settingsPreviewScopeMatches(scope, state.scope)) return state;
        if (projectKey) {
            if (state.projects[projectKey]?.owner !== owner) return state;
            const projects = { ...state.projects }; delete projects[projectKey]; return { projects };
        }
        const owned = keys.filter(key => state.account[key]?.owner === owner);
        if (!owned.length) return state;
        const account = { ...state.account };
        for (const key of owned) delete account[key];
        return { account };
    });
}

export function useSettingPreview<K extends keyof Settings>(name: K) {
    const scope = getStorage()(state => state.settingsScope);
    const [owner] = React.useState(() => Symbol(name));
    const preview = React.useCallback((value: Settings[K] | undefined) => {
        useSettingsPreviewStore.setState(state => {
            const same = settingsPreviewScopeMatches(scope, state.scope);
            if (value === undefined) {
                if (!same || state.account[name]?.owner !== owner) return state;
                const account = { ...state.account };
                delete account[name];
                return { account };
            }
            if (!settingsPreviewScopeMatches(scope, getStorage().getState().settingsScope)) return state;
            return { scope, account: { ...(same ? state.account : {}), [name]: { owner, value } },
                projects: same ? state.projects : {}, profiles: same ? state.profiles : {} };
        });
    }, [name, owner, scope]);
    React.useEffect(() => () => preview(undefined), [preview]);
    return preview;
}

export function useLocalSettingPreview<K extends keyof LocalSettings>(name: K) {
    const [owner] = React.useState(() => Symbol(name));
    const preview = React.useCallback((value: LocalSettings[K] | undefined) => {
        useSettingsPreviewStore.setState(state => {
            if (value === undefined) {
                if (state.local[name]?.owner !== owner) return state;
                const local = { ...state.local };
                delete local[name];
                return { local };
            }
            return { local: { ...state.local, [name]: { owner, value } } };
        });
    }, [name, owner]);
    React.useEffect(() => () => preview(undefined), [preview]);
    return preview;
}

export function useLocalSettingPreviewValue<K extends keyof LocalSettings>(name: K) {
    return useSettingsPreviewStore(state => state.local[name]?.value);
}

export function useSettingPreviewValue<K extends keyof Settings>(name: K) {
    const scope = getStorage()(state => state.settingsScope);
    return useSettingsPreviewStore(state => settingsPreviewScopeMatches(scope, state.scope) ? state.account[name]?.value : undefined);
}

export function projectAtmospherePreviewKey(project: Readonly<{ serverId: string; projectKey: string }>) {
    return JSON.stringify([project.serverId, project.projectKey]);
}

export function useProjectAtmospherePreview(project: Readonly<{ serverId: string; projectKey: string }>) {
    const scope = getStorage()(state => state.settingsScope);
    const key = projectAtmospherePreviewKey(project);
    const [owner] = React.useState(() => Symbol(key));
    const preview = React.useCallback((value: ProjectAtmosphere | undefined) => {
        useSettingsPreviewStore.setState(state => {
            const same = settingsPreviewScopeMatches(scope, state.scope);
            if (value === undefined) {
                if (!same || state.projects[key]?.owner !== owner) return state;
                const projects = { ...state.projects };
                delete projects[key];
                return { projects };
            }
            if (!settingsPreviewScopeMatches(scope, getStorage().getState().settingsScope)) return state;
            return { scope, projects: { ...(same ? state.projects : {}), [key]: { owner, value } }, account: same ? state.account : {}, profiles: same ? state.profiles : {} };
        });
    }, [key, owner, scope]);
    React.useEffect(() => () => preview(undefined), [preview]);
    return preview;
}

/** Private profile drafts share the gesture lifetime, while their real Action still owns edits. */
export function usePublicProfileAtmospherePreview(serverId: string) {
    const scope = getStorage()(state => state.settingsScope);
    const [owner] = React.useState(() => Symbol(serverId));
    const preview = React.useCallback((value: AtmospherePresentation | undefined) => {
        useSettingsPreviewStore.setState(state => {
            const same = settingsPreviewScopeMatches(scope, state.scope);
            if (value === undefined) {
                if (!same || state.profiles[serverId]?.owner !== owner) return state;
                const profiles = { ...state.profiles };
                delete profiles[serverId];
                return { profiles };
            }
            if (!settingsPreviewScopeMatches(scope, getStorage().getState().settingsScope)) return state;
            return { scope, profiles: { ...(same ? state.profiles : {}), [serverId]: { owner, value } },
                account: same ? state.account : {}, projects: same ? state.projects : {} };
        });
    }, [owner, scope, serverId]);
    React.useEffect(() => () => preview(undefined), [preview]);
    return preview;
}

export function usePublicProfileAtmospherePreviewValue(serverId: string | undefined) {
    const scope = getStorage()(state => state.settingsScope);
    return useSettingsPreviewStore(state => serverId && settingsPreviewScopeMatches(scope, state.scope)
        ? state.profiles[serverId]?.value : undefined);
}

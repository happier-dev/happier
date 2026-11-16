import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ThemeLibraryEntry, ThemeProfileDocument, ThemeProfileMode, ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_ARTIFACT_KIND } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { useArtifactBody, type ArtifactBodyState } from '@/components/artifacts/useArtifactBody';
import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { isArtifactInventoryLoaded, isArtifactInventoryReady } from '@/sync/domains/artifacts/artifactInventory';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageSubscriptionScope } from '@/sync/domains/state/storageSubscriptions';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getBuiltInThemeLibraryEntries, getBuiltInThemeProfileDocument } from '@/theme/profiles/builtInThemeProfiles';
import { projectThemeProfileArtifactSummary, readThemeProfileArtifactDocument } from '@/theme/profiles/themeProfileArtifactProjection';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import { projectPluginThemeLibraryEntries, projectPluginThemeProfileDocument, projectThemeLibraryEntries } from '@/theme/profiles/themeProfilePresentation';
import { readPluginThemeList, type PluginThemeListItem } from '@/theme/profiles/pluginThemeCatalog';
import { usePluginThemeList } from '@/theme/profiles/usePluginThemeList';
import type { ThemeProfilesLocalStateV1, ThemeProfilesStateSnapshot } from '@/theme/profiles/themeProfileTypes';

export const THEME_PROFILE_ARTIFACT_KINDS: readonly string[] = Object.freeze([THEME_ARTIFACT_KIND]);
const selectionScope = { settingsScope: true, localSettings: ['themeProfileSelection'] } satisfies StorageSubscriptionScope;
const inventoryStatusScope = { settingsScope: true, artifactsLoaded: true,
    artifactInventoryKindsLoaded: true, artifactInventoryKindsPartial: true } satisfies StorageSubscriptionScope;
const inventoryScope = { settingsScope: true, artifactThemeLibraryArtifacts: true } satisfies StorageSubscriptionScope;

function pluginDocument(item: PluginThemeListItem): ThemeProfileDocument | null {
    return projectPluginThemeProfileDocument(item.theme, { kind: 'plugin', pluginId: item.pluginId,
        contributionId: item.contributionId });
}

function libraryEntries(rows: Readonly<Record<string, DecryptedArtifact>>, scope: AccountSettingsScope | null,
    plugins: readonly PluginThemeListItem[]): readonly ThemeLibraryEntry[] {
    const saved = scope ? Object.values(rows).flatMap(row => {
        const summary = projectThemeProfileArtifactSummary(row, scope);
        return summary ? [summary.entry] : [];
    }) : [];
    return projectThemeLibraryEntries(saved, projectPluginThemeLibraryEntries(plugins), getBuiltInThemeLibraryEntries());
}

/** Settings reads expose the complete header library, separately from demanded editor bodies. */
export function readThemeLibrarySnapshot(expectedScope?: AccountSettingsScope | null): Readonly<{
    entries: readonly ThemeLibraryEntry[]; selection: Readonly<Record<ThemeProfileMode, ThemeReference | null>>;
}> | null {
    const state = getStorage().getState();
    if (!state.settingsScope || expectedScope !== undefined && !areAccountSettingsScopesEqual(expectedScope, state.settingsScope)
        || !isArtifactInventoryLoaded(state, THEME_PROFILE_ARTIFACT_KINDS)) return null;
    return { entries: libraryEntries(state.artifactThemeLibraryArtifacts, state.settingsScope, readPluginThemeList()),
        selection: readThemeProfileReferenceSelection(state.localSettings.themeProfileSelection) };
}

/** The library consumes private header inputs. Its CSS-heavy bodies stay on demand. */
export function useThemeLibraryInventory(): Readonly<{ entries: readonly ThemeLibraryEntry[]; loaded: boolean; failed: boolean; retry(): void }> {
    const input = getStorage()(useShallow(state => ({ rows: state.artifactThemeLibraryArtifacts, scope: state.settingsScope })), inventoryScope);
    const status = getStorage()(useShallow(state => ({ loaded: isArtifactInventoryReady(state, THEME_PROFILE_ARTIFACT_KINDS),
        complete: isArtifactInventoryLoaded(state, THEME_PROFILE_ARTIFACT_KINDS) })), inventoryStatusScope);
    const read = useArtifactInventoryRead(!status.loaded, THEME_PROFILE_ARTIFACT_KINDS);
    const plugins = usePluginThemeList();
    const entries = React.useMemo(() => libraryEntries(input.rows, input.scope, plugins), [input.rows, input.scope, plugins]);
    return { entries, loaded: status.loaded, failed: read.failed || status.loaded && !status.complete, retry: read.retry };
}

export function useThemeLibraryEntries(): readonly ThemeLibraryEntry[] {
    return useThemeLibraryInventory().entries;
}

/** Editors, export and selected runtime consumers share Artifact's addressed loading lifecycle. */
export function useThemeProfileDocument(reference: ThemeReference | null): Readonly<{
    state: ArtifactBodyState; document: ThemeProfileDocument | null; failure?: unknown; retry(): void;
}> {
    const scope = useAccountSettingsScope();
    const id = reference?.kind === 'artifact' ? reference.id : '';
    const subscription = React.useMemo(() => ({ artifacts: [id] } satisfies StorageSubscriptionScope), [id]);
    const row = getStorage()(React.useCallback(state => id ? state.artifacts[id] ?? null : null, [id]), subscription);
    const read = useArtifactBody(id, row, { readMissing: reference?.kind === 'artifact' });
    const plugin = usePluginThemeList(reference?.kind === 'plugin' ? reference : null);
    const pluginProfile = React.useMemo(() => plugin ? pluginDocument(plugin) : null, [plugin]);
    const currentRow = read.result?.artifact ?? row;
    const opened = React.useMemo(() => currentRow && scope ? readThemeProfileArtifactDocument(currentRow, scope)?.document ?? null : null,
        [currentRow, scope]);
    const retained = React.useRef<Readonly<{ id: string; scope: AccountSettingsScope | null; document: ThemeProfileDocument }> | null>(null);
    if (retained.current && (retained.current.id !== id || !areAccountSettingsScopesEqual(retained.current.scope, scope))) retained.current = null;
    if (opened) retained.current = { id, scope, document: opened };
    if (read.state === 'missing' || read.state === 'ready' && !opened) retained.current = null;
    if (reference?.kind === 'built-in') {
        const document = getBuiltInThemeProfileDocument(reference.presetId);
        return { state: document ? 'ready' : 'missing', document, retry: read.retry };
    }
    if (reference?.kind === 'plugin') return { state: pluginProfile ? 'ready' : 'missing', document: pluginProfile, retry: read.retry };
    if (reference?.kind !== 'artifact') return { state: 'missing', document: null, retry: read.retry };
    const document = opened ?? retained.current?.document ?? null;
    return { state: opened ? 'ready' : read.state === 'ready' ? 'missing' : read.state,
        document, failure: read.failure, retry: read.retry };
}

function snapshot(documents: readonly (ThemeProfileDocument | null)[]): ThemeProfilesStateSnapshot {
    const [light, dark] = documents;
    const profiles = documents.flatMap(document => document ? [document.profile] : []);
    return { themeProfiles: { activeProfileIds: { light: light?.profile.id ?? null, dark: dark?.profile.id ?? null },
        profiles: profiles.filter((profile, index) => profiles.findIndex(candidate => candidate.id === profile.id) === index) }, legacyProfileIds: {} };
}

/** Runtime demands only the two selected documents; browsing uses the header hook above. */
export function useThemeProfilesSnapshot(): ThemeProfilesStateSnapshot {
    const input = getStorage()(useShallow(state => ({ selection: state.localSettings.themeProfileSelection, scope: state.settingsScope })), selectionScope);
    const references = React.useMemo(() => readThemeProfileReferenceSelection(input.selection), [input.selection]);
    const light = useThemeProfileDocument(references.light).document;
    const dark = useThemeProfileDocument(references.dark).document;
    return React.useMemo(() => snapshot([light, dark]), [light, dark]);
}

/** Event-time reads never acquire bodies or disclose another Account's projection. */
export function readThemeProfilesSnapshot(expectedScope?: AccountSettingsScope | null): ThemeProfilesStateSnapshot {
    const state = getStorage().getState();
    if (expectedScope !== undefined && !areAccountSettingsScopesEqual(expectedScope, state.settingsScope)) {
        return { themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE, legacyProfileIds: {} };
    }
    const references = readThemeProfileReferenceSelection(state.localSettings.themeProfileSelection);
    return snapshot([references.light, references.dark].map(reference => {
        if (reference?.kind === 'built-in') return getBuiltInThemeProfileDocument(reference.presetId);
        if (reference?.kind === 'plugin') {
            const item = readPluginThemeList().find(candidate => candidate.pluginId === reference.pluginId && candidate.contributionId === reference.contributionId);
            return item ? pluginDocument(item) : null;
        }
        if (reference?.kind !== 'artifact' || !state.settingsScope) return null;
        const row = state.artifacts[reference.id];
        return row ? readThemeProfileArtifactDocument(row, state.settingsScope)?.document ?? null : null;
    }));
}

export function useThemeProfiles(): ThemeProfilesLocalStateV1 {
    return useThemeProfilesSnapshot().themeProfiles;
}

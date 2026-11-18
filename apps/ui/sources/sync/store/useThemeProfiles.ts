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
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';

export const THEME_PROFILE_ARTIFACT_KINDS: readonly string[] = Object.freeze([THEME_ARTIFACT_KIND]);
const NO_ARTIFACT_KINDS: readonly string[] = Object.freeze([]);
const selectionScope = { settingsScope: true, localSettings: ['themeProfileSelection'] } satisfies StorageSubscriptionScope;
const inventoryStatusScope = { settingsScope: true, artifactsLoaded: true,
    artifactInventoryKindsLoaded: true, artifactInventoryKindsPartial: true } satisfies StorageSubscriptionScope;
const inventoryScope = { settingsScope: true, artifactThemeLibraryArtifacts: true } satisfies StorageSubscriptionScope;
const noSubscription = {} satisfies StorageSubscriptionScope;
const noSelectionSubscription = { localSettings: [] } satisfies StorageSubscriptionScope;
const noArtifactSubscription = { artifacts: [] } satisfies StorageSubscriptionScope;
const noStatus = Object.freeze({ loaded: false, complete: false });
const noEntries: readonly ThemeLibraryEntry[] = Object.freeze([]);

function pluginDocument(item: PluginThemeListItem): ThemeProfileDocument | null {
    return projectPluginThemeProfileDocument(item.theme, { kind: 'plugin', pluginId: item.pluginId,
        contributionId: item.contributionId });
}

function artifactLibraryEntries(rows: Readonly<Record<string, DecryptedArtifact>>, scope: AccountSettingsScope | null): readonly ThemeLibraryEntry[] {
    return scope ? Object.values(rows).flatMap(row => {
        const summary = projectThemeProfileArtifactSummary(row, scope);
        return summary ? [summary.entry] : [];
    }) : [];
}

function libraryEntries(rows: Readonly<Record<string, DecryptedArtifact>>, scope: AccountSettingsScope | null,
    plugins: readonly PluginThemeListItem[]): readonly ThemeLibraryEntry[] {
    return projectThemeLibraryEntries(artifactLibraryEntries(rows, scope), projectPluginThemeLibraryEntries(plugins), getBuiltInThemeLibraryEntries());
}

/** Selection controls consume tagged references without demanding any theme document. */
export function useThemeProfileReferenceSelection(enabled = true): Readonly<Record<ThemeProfileMode, ThemeReference | null>> {
    const selection = getStorage()(state => state.localSettings.themeProfileSelection, enabled ? selectionScope : noSelectionSubscription);
    return React.useMemo(() => readThemeProfileReferenceSelection(selection), [selection]);
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

type ThemeLibraryInventory<Entry extends ThemeLibraryEntry = ThemeLibraryEntry> = Readonly<{
    entries: readonly Entry[]; loaded: boolean; failed: boolean; retry(): void;
}>;
const allEntries = (entries: readonly ThemeLibraryEntry[]) => entries;

/** Saved-theme consumers select private headers before rendering, without plugin or built-in demand. */
export function useThemeLibraryArtifactInventory(enabled?: boolean): ThemeLibraryInventory;
export function useThemeLibraryArtifactInventory<Entry extends ThemeLibraryEntry>(enabled: boolean,
    selectEntries: (entries: readonly ThemeLibraryEntry[]) => readonly Entry[]): ThemeLibraryInventory<Entry>;
export function useThemeLibraryArtifactInventory(enabled = true,
    selectEntries: (entries: readonly ThemeLibraryEntry[]) => readonly ThemeLibraryEntry[] = allEntries): ThemeLibraryInventory {
    const entries = getStorage()(useShallow(state => enabled
        ? selectEntries(artifactLibraryEntries(state.artifactThemeLibraryArtifacts, state.settingsScope)) : noEntries), enabled ? inventoryScope : noSubscription);
    const status = getStorage()(useShallow(state => enabled ? { loaded: isArtifactInventoryReady(state, THEME_PROFILE_ARTIFACT_KINDS),
        complete: isArtifactInventoryLoaded(state, THEME_PROFILE_ARTIFACT_KINDS) } : noStatus), enabled ? inventoryStatusScope : noSubscription);
    const read = useArtifactInventoryRead(enabled && !status.loaded, enabled ? THEME_PROFILE_ARTIFACT_KINDS : NO_ARTIFACT_KINDS);
    return { entries, loaded: status.loaded, failed: read.failed || status.loaded && !status.complete, retry: read.retry };
}

/** The library consumes private header inputs. Its CSS-heavy bodies stay on demand. */
export function useThemeLibraryInventory(enabled = true): ThemeLibraryInventory & Readonly<{ plugins: readonly PluginThemeListItem[] }> {
    const inventory = useThemeLibraryArtifactInventory(enabled);
    const plugins = usePluginThemeList(enabled);
    const entries = React.useMemo(() => enabled
        ? projectThemeLibraryEntries(inventory.entries, projectPluginThemeLibraryEntries(plugins), getBuiltInThemeLibraryEntries()) : noEntries,
        [enabled, inventory.entries, plugins]);
    return { ...inventory, entries, plugins };
}

export function useThemeLibraryEntries(enabled = true): readonly ThemeLibraryEntry[] {
    return useThemeLibraryInventory(enabled).entries;
}

/** A transcript result reads one retained header without acquiring the library or its bodies. */
export function useThemeLibraryEntry(reference: ThemeReference | null, enabled = true): ThemeLibraryEntry | null {
    const scope = useAccountSettingsScope();
    const id = reference?.kind === 'artifact' ? reference.id : '';
    const subscription = React.useMemo(() => ({ artifacts: [id] } satisfies StorageSubscriptionScope), [id]);
    const row = getStorage()(React.useCallback(state => id ? state.artifacts[id] ?? null : null, [id]), enabled ? subscription : noArtifactSubscription);
    const plugin = usePluginThemeList(reference?.kind === 'plugin' ? reference : null, enabled);
    return React.useMemo(() => {
        if (reference?.kind === 'artifact') return row && scope ? projectThemeProfileArtifactSummary(row, scope)?.entry ?? null : null;
        if (reference?.kind === 'built-in') return getBuiltInThemeLibraryEntries().find(entry => entry.reference.kind === 'built-in'
            && entry.reference.presetId === reference.presetId) ?? null;
        return plugin ? projectPluginThemeLibraryEntries([plugin])[0] ?? null : null;
    }, [reference, row, scope, plugin]);
}

/** Editors, export and selected runtime consumers share Artifact's addressed loading lifecycle. */
export function useThemeProfileDocument(reference: ThemeReference | null, enabled = true): Readonly<{
    state: ArtifactBodyState; document: ThemeProfileDocument | null; failure?: unknown; retry(): void;
}> {
    const scope = useAccountSettingsScope();
    const id = reference?.kind === 'artifact' ? reference.id : '';
    const subscription = React.useMemo(() => ({ artifacts: [id] } satisfies StorageSubscriptionScope), [id]);
    const row = getStorage()(React.useCallback(state => enabled && id ? state.artifacts[id] ?? null : null, [enabled, id]), enabled ? subscription : noSubscription);
    const read = useArtifactBody(enabled ? id : '', row, { readMissing: enabled && reference?.kind === 'artifact' });
    const plugin = usePluginThemeList(enabled && reference?.kind === 'plugin' ? reference : null);
    const pluginProfile = React.useMemo(() => plugin ? pluginDocument(plugin) : null, [plugin]);
    const currentRow = read.result?.artifact ?? row;
    const opened = React.useMemo(() => currentRow && scope ? readThemeProfileArtifactDocument(currentRow, scope)?.document ?? null : null,
        [currentRow, scope]);
    const pluginId = reference?.kind === 'plugin' ? reference.pluginId : null;
    const contributionId = reference?.kind === 'plugin' ? reference.contributionId : null;
    const retained = React.useRef<Readonly<{ id: string; pluginId: string | null; contributionId: string | null;
        scope: AccountSettingsScope | null; document: ThemeProfileDocument }> | null>(null);
    if (retained.current && (retained.current.id !== id || retained.current.pluginId !== pluginId
        || retained.current.contributionId !== contributionId || !areAccountSettingsScopesEqual(retained.current.scope, scope))) retained.current = null;
    const currentDocument = reference?.kind === 'plugin' ? pluginProfile : opened;
    if (currentDocument) retained.current = { id, pluginId, contributionId, scope, document: currentDocument };
    if (enabled && (reference?.kind === 'plugin' ? !pluginProfile : read.state === 'missing' || read.state === 'ready' && !opened)) retained.current = null;
    if (reference?.kind === 'built-in') {
        const document = getBuiltInThemeProfileDocument(reference.presetId);
        return { state: document ? 'ready' : 'missing', document, retry: read.retry };
    }
    if (reference?.kind === 'plugin') {
        const document = pluginProfile ?? retained.current?.document ?? null;
        return { state: document ? 'ready' : 'missing', document, retry: read.retry };
    }
    if (reference?.kind !== 'artifact') return { state: 'missing', document: null, retry: read.retry };
    const document = opened ?? retained.current?.document ?? null;
    return { state: opened ? 'ready' : read.state === 'ready' ? 'missing' : read.state,
        document, failure: read.failure, retry: read.retry };
}

function selectedProfiles(documents: readonly (ThemeProfileDocument | null)[], references: readonly (ThemeReference | null)[]): ThemeProfilesLocalStateV1 {
    // This paint-only adapter keys profiles by the admitted reference namespace;
    // plugin-local document ids can coincide across contributions or with an Artifact.
    const [light, dark] = documents.map((document, index) => {
        const reference = references[index];
        return document && reference
            ? { ...document.profile, id: JSON.stringify(reference, Object.keys(reference).sort()) } : null;
    });
    const profiles = [light, dark].flatMap(profile => profile ? [profile] : []);
    return { activeProfileIds: { light: light?.id ?? null, dark: dark?.id ?? null },
        profiles: profiles.filter((profile, index) => profiles.findIndex(candidate => candidate.id === profile.id) === index) };
}

/** Runtime demands only the two selected documents; browsing uses the header hook above. */
export function useSelectedThemeProfiles(): ThemeProfilesLocalStateV1 {
    const input = getStorage()(useShallow(state => ({ selection: state.localSettings.themeProfileSelection, scope: state.settingsScope })), selectionScope);
    const references = React.useMemo(() => readThemeProfileReferenceSelection(input.selection), [input.selection]);
    const light = useThemeProfileDocument(references.light).document;
    const dark = useThemeProfileDocument(references.dark).document;
    return React.useMemo(() => selectedProfiles([light, dark], [references.light, references.dark]), [light, dark, references]);
}

/** Event-time reads never acquire bodies or disclose another Account's projection. */
export function readSelectedThemeProfiles(expectedScope?: AccountSettingsScope | null): ThemeProfilesLocalStateV1 {
    const state = getStorage().getState();
    if (expectedScope !== undefined && !areAccountSettingsScopesEqual(expectedScope, state.settingsScope)) {
        return DEFAULT_THEME_PROFILES_LOCAL_STATE;
    }
    const references = readThemeProfileReferenceSelection(state.localSettings.themeProfileSelection);
    const selectedReferences = [references.light, references.dark];
    return selectedProfiles(selectedReferences.map(reference => {
        if (reference?.kind === 'built-in') return getBuiltInThemeProfileDocument(reference.presetId);
        if (reference?.kind === 'plugin') {
            const item = readPluginThemeList().find(candidate => candidate.pluginId === reference.pluginId && candidate.contributionId === reference.contributionId);
            return item ? pluginDocument(item) : null;
        }
        if (reference?.kind !== 'artifact' || !state.settingsScope) return null;
        const row = state.artifacts[reference.id];
        return row ? readThemeProfileArtifactDocument(row, state.settingsScope)?.document ?? null : null;
    }), selectedReferences);
}

import type { ThemeRegistryItemKey } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ThemeLibraryEntry, ThemeMiniatureData, ThemeProfileMode } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreThemeCardView } from '../storeThemeViewTypes';

const NO_FACES: readonly ThemeMiniatureData[] = [];

/** A browse summary never acquires a package to discover modes or draw a preview. */
export function themeSummaryMatchesMode(item: RegistryCatalogItemSummary, mode: ThemeProfileMode | null): boolean {
    return mode === null || item.themeMetadata?.includes.some(face => face.mode === mode) === true;
}

export function projectStoreThemeCard(item: RegistryCatalogItemSummary, sourceTitle: string): StoreThemeCardView {
    return {
        key: `theme|${item.sourceId}|${item.itemId}`,
        name: item.title,
        byline: item.publisher ? `${item.publisher.name} · ${sourceTitle}` : sourceTitle,
        summary: [...new Set(item.themeMetadata?.includes.flatMap(face => face.mode ? [face.mode] : []))]
            .map(mode => t(mode === 'light' ? 'themeCard.light' : 'themeCard.dark')).join(' · '),
        faces: item.themeMetadata?.preview ?? NO_FACES,
        ...(item.brandMark ? { mark: item.brandMark } : {}),
    };
}

/**
 * An opened listing's Changes and Works on facts (lab C2, finding 7), said as the agent card says them: colours only,
 * or what the CSS reshapes; it works everywhere, with the phone rule count only when some rules stay on web and desktop.
 */
export function projectStoreThemeCoverageFacts(coverage: Readonly<{
    total: number; native: number; webOnly: number; affectedSurfaces: readonly Readonly<{ surface: string }>[];
}>): Readonly<{ changes: string; worksOn: Readonly<{ value: string; note?: string }> }> {
    return {
        changes: coverage.affectedSurfaces.length === 0 ? t('themeStore.colorsOnly')
            : `${t('themeStore.colors')} · ${t('themeCard.reshapes', { areas: joinList(coverage.affectedSurfaces.map(address => address.surface)) })}`,
        worksOn: coverage.webOnly > 0
            ? { value: t('themeStore.everywhere'), note: t('themeCard.coverage', { native: coverage.native, total: coverage.total }) }
            : { value: t('themeStore.everywhere') },
    };
}

export type InstalledStoreThemeEntry = ThemeLibraryEntry & Readonly<{
    source: Extract<ThemeLibraryEntry['source'], { kind: 'store' }>;
}>;
function isStoreThemeEntry(entry: ThemeLibraryEntry): entry is InstalledStoreThemeEntry {
    return entry.source.kind === 'store';
}
export type InstalledStoreThemeGroup = Readonly<{
    key: string;
    listing: ThemeRegistryItemKey;
    /** Keep every face's own provenance, including a partially updated listing's differing versions. */
    entries: readonly InstalledStoreThemeEntry[];
}>;

/** Installed lists a Store listing once; editable copies belong to Yours and carry no upstream demand. */
export function groupInstalledStoreThemes(entries: readonly ThemeLibraryEntry[]): readonly InstalledStoreThemeGroup[] {
    const groups = new Map<string, { key: string; listing: ThemeRegistryItemKey; entries: InstalledStoreThemeEntry[] }>();
    for (const entry of entries) {
        if (!isStoreThemeEntry(entry)) continue;
        const { sourceId, itemId } = entry.source.provenance;
        const key = JSON.stringify([sourceId, itemId]);
        const held = groups.get(key);
        if (held) held.entries.push(entry);
        else groups.set(key, { key, listing: { sourceId, itemId }, entries: [entry] });
    }
    return [...groups.values()];
}

export type InstalledThemeRow = Readonly<{
    kind: 'theme';
    key: string;
    scope: ServerAccountScope;
    native: InstalledStoreThemeGroup;
}>;

export function projectInstalledStoreThemeRows(entries: readonly ThemeLibraryEntry[], scope: ServerAccountScope): readonly InstalledThemeRow[] {
    return groupInstalledStoreThemes(entries).map(native => ({ kind: 'theme',
        key: serverAccountScopedResourceKey(scope, 'theme', native.key), scope, native }));
}

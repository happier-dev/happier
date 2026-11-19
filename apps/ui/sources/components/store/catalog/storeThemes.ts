import type { ThemeActionOutput, ThemeRegistryItemKey } from '@happier-dev/protocol/actions/themeActionFamily';
import type { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeLibraryEntry, ThemeMiniatureData, ThemeProfileMode } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { t } from '@/text';
import { themeSurfaceLabel } from '@/theme/css/themeSurfaceLabels';
import { joinList } from '@/utils/text/joinList';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreThemeCardView, StoreThemeListingFact } from '../storeThemeViewTypes';

const NO_FACES: readonly ThemeMiniatureData[] = [];
export type StorePluginThemeItem = Readonly<{ kind: 'pluginTheme'; entry: ThemeLibraryEntry;
    pluginId: string; contributionId: string; pluginName: string }>;
export type StoreThemeItem = RegistryCatalogItemSummary | StorePluginThemeItem;

export function storeThemeSummary(item: StoreThemeItem) {
    return item.kind === 'pluginTheme'
        ? { key: JSON.stringify(['pluginTheme', item.pluginId, item.contributionId]), ref: item,
            title: item.entry.name, description: item.pluginName, mark: undefined }
        : { key: JSON.stringify([item.kind, item.sourceId, item.itemId]), ref: item,
            title: item.title, description: item.description, mark: item.brandMark };
}

/** Mode filtering consumes only facts already present in the browse summary. */
export function themeSummaryMatchesMode(item: StoreThemeItem, mode: ThemeProfileMode | null): boolean {
    return mode === null || (item.kind === 'pluginTheme' ? item.entry.mode === mode : item.themeMetadata?.includes.some(face => face.mode === mode) === true);
}

/** Which modes a listing covers, said once (lab C1/C2 "Light and dark"), for its card and its listing kicker. */
export function describeStoreThemeModes(modes: Iterable<ThemeProfileMode>): string {
    const covered = new Set(modes);
    if (covered.has('light') && covered.has('dark')) return t('themeStore.lightAndDark');
    if (covered.has('light')) return t('themeCard.light');
    return covered.has('dark') ? t('themeCard.dark') : '';
}

export function projectStoreThemeCard(item: StoreThemeItem, sourceTitle: string): StoreThemeCardView {
    if (item.kind === 'pluginTheme') return { key: storeThemeSummary(item).key, name: item.entry.name,
        byline: item.pluginName, summary: describeStoreThemeModes([item.entry.mode]), faces: [item.entry.miniature] };
    return {
        key: `theme|${item.sourceId}|${item.itemId}`,
        name: item.title,
        byline: item.publisher ? `${item.publisher.name} · ${sourceTitle}` : sourceTitle,
        summary: describeStoreThemeModes(item.themeMetadata?.includes.flatMap(face => face.mode ? [face.mode] : []) ?? []),
        faces: item.themeMetadata?.preview ?? NO_FACES,
        ...(item.version ? { listing: { sourceId: item.sourceId, itemId: item.itemId, version: item.version } } : {}),
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
            : `${t('themeStore.colors')} · ${t('themeCard.reshapes', { areas: joinList(coverage.affectedSurfaces.map(address => themeSurfaceLabel(address.surface))) })}`,
        worksOn: coverage.webOnly > 0
            ? { value: t('themeStore.everywhere'), note: t('themeCard.coverage', { native: coverage.native, total: coverage.total }) }
            : { value: t('themeStore.everywhere') },
    };
}

type StoreThemeListingMetadata = ThemeActionOutput<typeof THEME_ACTION_IDS.storeGet>['listing']['metadata'];
type StoreThemeCoverage = Parameters<typeof projectStoreThemeCoverageFacts>[0];

/**
 * A theme listing's four facts. Until its content first opens, the keys hold their rows with no value, so the card keeps
 * its shape and claims nothing (a pending listing is a stable shell). Once open, a fact the content does not state
 * reads Unknown.
 */
export function projectStoreThemeListingFacts(metadata: StoreThemeListingMetadata | null,
    coverage: StoreThemeCoverage | null): readonly StoreThemeListingFact[] {
    if (!metadata) return PENDING_LISTING_FACTS;
    const unknown = t('common.unknown');
    const coverageFacts = coverage ? projectStoreThemeCoverageFacts(coverage) : null;
    return [
        { key: 'includes', value: t('themeStore.includesCount', { count: metadata.includes.length }) },
        { key: 'changes', value: coverageFacts?.changes ?? unknown },
        { key: 'worksOn', ...(coverageFacts?.worksOn ?? { value: unknown }) },
        { key: 'licence', value: metadata.licenseKind === 'custom' ? t('themeStore.customLicence') : metadata.license ?? unknown,
            ...(metadata.licenseUrl ? { url: metadata.licenseUrl } : {}) },
    ];
}
const PENDING_LISTING_FACTS: readonly StoreThemeListingFact[] = (['includes', 'changes', 'worksOn', 'licence'] as const)
    .map(key => ({ key, value: '' }));

export type InstalledStoreThemeEntry = ThemeLibraryEntry & Readonly<{
    source: Extract<ThemeLibraryEntry['source'], { kind: 'store' }>;
}>;
function isStoreThemeEntry(entry: ThemeLibraryEntry): entry is InstalledStoreThemeEntry {
    return entry.source.kind === 'store';
}

export function selectInstalledStoreThemeEntries(entries: readonly ThemeLibraryEntry[]): readonly InstalledStoreThemeEntry[] {
    return entries.filter(isStoreThemeEntry);
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

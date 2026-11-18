import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { RegistryItemPointerV1 } from '@happier-dev/protocol/registries';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { usePluginCatalog, type PluginCatalogState } from '@/components/settings/plugins/model/usePluginCatalog';
import type { PluginMarketplaceCatalogEntry } from '@/components/settings/plugins/readPluginMarketplaceCatalog';
import { getResolvedAgentCatalogEntries, type ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBuiltInAgentForRegistryId } from '@/agents/registry/resolveBuiltInAgentForRegistryId';
import { BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION } from '@/agents/registry/generatedBundledPluginEntries';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { useInstalledMcpServers, useInstalledSkills, useInstalledAgents, useInstalledProviders, useInstalledPlugins } from './storeInstalled';
import { softwareSummary, useSoftwareList, type StoreSoftwareItem, type StoreSoftwareTarget } from './storeSoftware';
import { useInstalledSoftware } from './storeSoftwareInstalled';
import { useInstalledApps } from './storeApps';
import { useInstalledBrowserExtensions } from './storeBrowserExtensions';
import { useInstalledThemes } from './storeThemesInstalled';
import { APP_STORE_KIND } from './storeKindContributions';
import { projectPluginThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { usePluginThemeList } from '@/theme/profiles/usePluginThemeList';
import { storeThemeSummary, type StoreThemeItem } from './storeThemes';
import { storeBuiltInPets, storePetSummary, type StorePetItem } from './storePets';
export type { InstalledAppRow } from './storeApps';
export type { InstalledBrowserExtensionRow } from './storeBrowserExtensions';
export type { InstalledRow, InstalledMcpServerRow, InstalledSkillRow, InstalledAgentRow, InstalledProviderRow, InstalledPluginRow } from './storeInstalled';

/** Host presentation only. The family retains its own incomplete/unavailable facts and next-page handle. */
export type InstalledFamilyResult<InstalledRow, NativeReason, NativeContinuation> = Readonly<{
    rows: readonly InstalledRow[];
    coverage: 'loading' | 'available' | Readonly<{ unavailable: NativeReason }> | Readonly<{ partial: NativeReason }>;
    continuation?: NativeContinuation;
}>;
export type StoreDemand = Readonly<{ presented: boolean }>;
export type StoreInstalledInput = Readonly<{
    scope: ServerAccountScope | null;
    machine: MachineAdministrationTargetV1 | null;
    projectKey: string | null;
}>;
export type StoreListInput = Readonly<{ query: string; sourceIds?: readonly string[]; softwareTarget?: StoreSoftwareTarget | null; refreshKey?: string }>;
export type StoreItemSummary<Ref> = Readonly<{
    key: string;
    ref: Ref;
    title: string;
    description?: string | null;
    mark?: HostCatalogMark;
}>;

export function storeRegistryPointer(item: RegistryCatalogItemSummary): RegistryItemPointerV1 | null {
    return item.version ? { sourceId: item.sourceId, itemId: item.itemId, version: item.version } : null;
}
function registrySummary(item: RegistryCatalogItemSummary): StoreItemSummary<RegistryCatalogItemSummary> {
    return { key: JSON.stringify([item.kind, item.sourceId, item.itemId]), ref: item,
        title: item.title, description: item.description, mark: item.brandMark };
}
type RegistryList = ReturnType<typeof useRegistryItems>;
function useAppList(input: StoreListInput, demand: StoreDemand): RegistryList {
    return useRegistryItems({ kind: 'app', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
function useThemeList(input: StoreListInput, demand: StoreDemand): Omit<RegistryList, 'items'> & Readonly<{ items: readonly StoreThemeItem[] }> {
    const registry = useRegistryItems({ kind: 'theme', query: input.query, sourceIds: input.sourceIds }, demand.presented);
    const plugins = usePluginThemeList(demand.presented);
    const items = React.useMemo<readonly StoreThemeItem[]>(() => {
        const query = input.query.trim().toLocaleLowerCase();
        return [...registry.items, ...plugins.flatMap((plugin): StoreThemeItem[] => {
            if (input.sourceIds !== undefined && !input.sourceIds.includes(plugin.pluginId)) return [];
            if (!`${plugin.theme.name} ${plugin.pluginName}`.toLocaleLowerCase().includes(query)) return [];
            return [{ kind: 'pluginTheme', entry: projectPluginThemeLibraryEntry(plugin), pluginId: plugin.pluginId,
                contributionId: plugin.contributionId, pluginName: plugin.pluginName }];
        })];
    }, [registry.items, plugins, input.query, input.sourceIds]);
    return { ...registry, items };
}
/** Built-in pets lead (they need no catalog); registry pets follow from every pet catalog the Account holds. */
function usePetList(input: StoreListInput, demand: StoreDemand): Omit<RegistryList, 'items'> & Readonly<{ items: readonly StorePetItem[] }> {
    const registry = useRegistryItems({ kind: 'pet', query: input.query, sourceIds: input.sourceIds }, demand.presented);
    const items = React.useMemo<readonly StorePetItem[]>(() => [
        ...(demand.presented && input.sourceIds === undefined ? storeBuiltInPets(input.query) : []), ...registry.items,
    ], [demand.presented, input.sourceIds, input.query, registry.items]);
    return { ...registry, items };
}
function useStarterList(input: StoreListInput, demand: StoreDemand): RegistryList {
    return useRegistryItems({ kind: 'starter', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
function useBrowserExtensionList(input: StoreListInput, demand: StoreDemand): RegistryList {
    return useRegistryItems({ kind: 'browserExtension', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
function useMcpList(input: StoreListInput, demand: StoreDemand): RegistryList {
    return useRegistryItems({ kind: 'mcpServer', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
function useSkillList(input: StoreListInput, demand: StoreDemand): RegistryList {
    return useRegistryItems({ kind: 'skill', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
/** A built-in Agent, carrying the outcome line of the registry row that names it (folded into it, never listed twice). */
export type StoreBuiltInAgentItem = ResolvedAgentCatalogEntry & Readonly<{ registryDescription?: string }>;
export type StoreAgentItem = RegistryCatalogItemSummary | StoreBuiltInAgentItem;

/**
 * A registry row whose id a built-in Agent declares (`resolveBuiltInAgentForRegistryId`, the one identity owner) is
 * that built-in: the row folds into it and lends its description; every other row stays as it is.
 */
export function linkBuiltInAgentRegistryRows(
    builtIns: readonly ResolvedAgentCatalogEntry[],
    registry: readonly RegistryCatalogItemSummary[],
): readonly StoreAgentItem[] {
    const lent = new Map<string, string>();
    const rest = registry.filter(item => {
        const entry = resolveBuiltInAgentForRegistryId(builtIns, item.itemId);
        if (!entry || !builtIns.includes(entry)) return true;
        const description = item.description?.trim();
        if (description && !lent.has(entry.qualifiedId)) lent.set(entry.qualifiedId, description);
        return false;
    });
    return [...builtIns.map(entry => {
        const registryDescription = lent.get(entry.qualifiedId);
        return registryDescription ? { ...entry, registryDescription } : entry;
    }), ...rest];
}

/** What the Agent does, in its plugin's own words, else its registry row's; its subtitle only restates its name. */
function builtInAgentDescription(item: StoreBuiltInAgentItem): string | null {
    const pluginId = item.identity?.pluginId;
    const own = pluginId ? resolvePluginLocalizedText({ projection: null, pluginId,
        value: BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION[pluginId]?.description }).trim() : '';
    return own || item.registryDescription || null;
}

function agentSummary(item: StoreAgentItem): StoreItemSummary<StoreAgentItem> {
    if ('itemId' in item) return registrySummary(item);
    return { key: item.backendTargetKey ?? item.qualifiedId, ref: item, title: item.title,
        description: builtInAgentDescription(item) };
}
type AgentList = Omit<RegistryList, 'items'> & Readonly<{ items: readonly StoreAgentItem[] }>;
function useAgentList(input: StoreListInput, demand: StoreDemand): AgentList {
    const registry = useRegistryItems({ kind: 'agent', query: input.query, sourceIds: input.sourceIds }, demand.presented);
    // Portable declarations do not imply an installed executable or require Machine discovery.
    const bundled = React.useMemo(() => demand.presented && input.sourceIds === undefined
        ? getResolvedAgentCatalogEntries({ enabledAgentIds: [] }).filter(item =>
            `${item.title} ${item.subtitle ?? ''}`.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase()))
        : [], [demand.presented, input.query, input.sourceIds]);
    const items = React.useMemo(() => linkBuiltInAgentRegistryRows(bundled, registry.items), [bundled, registry.items]);
    return { ...registry, items };
}
type ProviderList = Readonly<{ items: readonly AccountProviderDeclarationV1[]; loading: false; stale: false; hasNextPage: false }>;
function useProviderList(input: StoreListInput, demand: StoreDemand): ProviderList {
    const items = React.useMemo(() => demand.presented && input.sourceIds === undefined ? readAccountProviderDeclarations({ kind: 'account' })
        .filter(item => item.definition.name.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())) : [],
    [demand.presented, input.query, input.sourceIds]);
    return { items, loading: false, stale: false, hasNextPage: false } as const;
}
function providerSummary(item: AccountProviderDeclarationV1): StoreItemSummary<AccountProviderDeclarationV1> {
    return { key: item.contributionKey, ref: item, title: item.definition.name };
}
type PluginList = Readonly<{
    items: PluginCatalogState['discoverEntries']; loading: boolean; stale: boolean; hasNextPage: boolean;
    nextPage: PluginCatalogState['loadMoreDiscover']; refresh: PluginCatalogState['refreshDiscover'];
    sources: PluginCatalogState['discoverSources']; sourceStatuses: PluginCatalogState['discoverSourceStatuses'];
    sourceFailures: PluginCatalogState['discoverSourceFailures'];
    error: PluginCatalogState['discoverError'];
}>;
function usePluginList(input: StoreListInput, demand: StoreDemand): PluginList {
    const catalog = usePluginCatalog({ enabled: demand.presented, browse: true,
        query: { text: input.query, sourceId: null, sourceIds: input.sourceIds } });
    return { items: catalog.discoverEntries, loading: catalog.loadingDiscover, stale: catalog.discoverStale,
        hasNextPage: catalog.discoverNextCursor !== null, nextPage: catalog.loadMoreDiscover,
        refresh: catalog.refreshDiscover, sources: catalog.discoverSources,
        sourceStatuses: catalog.discoverSourceStatuses, sourceFailures: catalog.discoverSourceFailures,
        error: catalog.discoverError };
}
function pluginSummary(item: PluginMarketplaceCatalogEntry): StoreItemSummary<PluginMarketplaceCatalogEntry> {
    return { key: JSON.stringify(['plugin', item.sourceId, item.itemId]), ref: item,
        title: item.title, description: item.description };
}

/** Closed host UI adapters. Each kind is mounted by a static leaf; never iterate this map to call hooks. */
export const storeKinds = {
    app: { ...APP_STORE_KIND, summary: registrySummary, useList: useAppList, useInstalled: useInstalledApps },
    theme: { summary: storeThemeSummary, useList: useThemeList, useInstalled: useInstalledThemes },
    pet: { summary: storePetSummary, useList: usePetList, useInstalled: undefined },
    // Software second: what a Machine runs sits beside the Apps it hosts (S40-R02).
    software: { summary: softwareSummary, useList: useSoftwareList, useInstalled: useInstalledSoftware },
    starter: { summary: registrySummary, useList: useStarterList, useInstalled: undefined },
    browserExtension: { summary: registrySummary, useList: useBrowserExtensionList, useInstalled: useInstalledBrowserExtensions },
    mcpServer: { summary: registrySummary, useList: useMcpList, useInstalled: useInstalledMcpServers },
    skill: { summary: registrySummary, useList: useSkillList, useInstalled: useInstalledSkills },
    agent: { summary: agentSummary, useList: useAgentList, useInstalled: useInstalledAgents },
    provider: { summary: providerSummary, useList: useProviderList, useInstalled: useInstalledProviders },
    plugin: { summary: pluginSummary, useList: usePluginList, useInstalled: useInstalledPlugins },
} as const;
export type StoreKind = keyof typeof storeKinds;
/** Adapter declaration order is the shared browse/search order. */
export const STORE_KIND_ORDER: readonly StoreKind[] = Object.keys(storeKinds) as StoreKind[];

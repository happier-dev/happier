import * as React from 'react';
import type { RegistryItemPointerV1 } from '@happier-dev/protocol/registries';
import { PluginGitSourceV1Schema, type PluginGitSourceV1 } from '@happier-dev/protocol/plugins/source-spec';

import { CapabilityAddDetailAction, CapabilityAddModalBody, openCapabilityAddModalHost, type CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlotWithSources } from '@/registries/useRegistrySourcesSlot';
import { t } from '@/text';

import { PluginMark } from '../PluginMark';
import { PluginListingAddsSection, PluginListingFacts } from '../listing/PluginListingFacts';
import { catalogReviewStatusLabel } from '../model/pluginMarketplaceModel';
import { buildPluginListingRoute, type PluginListingRouteParams, type PluginsSurfaceHost } from '../model/pluginsSurfaceRoutes';
import { usePluginCatalogWithSources } from '../model/usePluginCatalog';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

export type OpenPluginAddModalParams = Readonly<{
    host?: PluginsSurfaceHost;
    initialSelection?: RegistryItemPointerV1;
    onInstallGit?: (source: PluginGitSourceV1) => boolean;
}>;
const TEST_ID = 'plugins.add';
const keyOf = (entry: PluginMarketplaceCatalogEntry) => `${entry.sourceId}|${entry.itemId}`;
type Selection = Readonly<{ key: string; pointer: PluginListingRouteParams | null }>;

/** Presentation only. Installation, target selection and trust stay with the existing listing owner. */
export function openPluginAddModal(params: OpenPluginAddModalParams = {}) {
    return openCapabilityAddModalHost(PluginAddModal, { params }, {
        title: t('settingsPlugins.catalog.addTitle'), testID: TEST_ID,
    });
}

export function PluginAddModal(props: CustomModalInjectedProps & Readonly<{ params: OpenPluginAddModalParams }>) {
    const router = useRouter();
    const [query, setQuery] = React.useState('');
    const [catalogDemanded, setCatalogDemanded] = React.useState(true);
    const [seedRequested, setSeedRequested] = React.useState(props.params.initialSelection !== undefined);
    const discardSeed = React.useCallback(() => setSeedRequested(false), []);
    const sources = useRegistrySources('plugin');
    const slot = useRegistrySourcesSlotWithSources('plugin', sources, { testID: `${TEST_ID}.registries`,
        onSelectionChange: discardSeed,
        ...(props.params.initialSelection ? { initialSelection: props.params.initialSelection.sourceId } : {}) });
    // A failed source is named once on its line, as the MCP and Skill catalogs name theirs.
    const catalog = usePluginCatalogWithSources({ enabled: catalogDemanded, browse: !seedRequested,
        ...(seedRequested ? { selection: props.params.initialSelection } : {}),
        query: { text: query, sourceId: slot.selection === 'all' ? null : slot.selection } }, sources);
    const seedEntry = seedRequested ? catalog.discoverEntries[0] : undefined;
    const items = React.useMemo(() => seedRequested ? seedEntry ? [seedEntry] : []
        : catalog.discoverEntries, [seedRequested, seedEntry, catalog.discoverEntries]);
    const changeQuery = React.useCallback((text: string) => { setQuery(text); setSeedRequested(false); }, []);
    const [selection, setSelection] = React.useState<Selection | null>(null);
    const anatomy = React.useMemo(() => buildCapabilityCollectionAnatomy<PluginMarketplaceCatalogEntry>({
        title: entry => entry.title,
        description: entry => entry.description,
        mark: entry => <PluginMark title={entry.title} pluginId={entry.id} size="row" />,
        facts: entry => ({ source: { kind: 'registry', label: entry.sourceTitle },
            extra: [entry.publisher.displayName, entry.version].filter((fact): fact is string => Boolean(fact)) }),
        accessibilityLabel: entry => entry.title,
        testID: entry => `${TEST_ID}.row.${entry.sourceId}.${entry.itemId}`,
    }), []);
    const config: CapabilityAddModalConfig<PluginMarketplaceCatalogEntry> = {
        title: t('settingsPlugins.catalog.addTitle'), testID: TEST_ID,
        onCatalogDemandChange: setCatalogDemanded,
        modes: [{ key: 'catalog', kind: 'catalog', label: t('settingsPlugins.catalog.browse'), icon: 'cube' },
            ...(props.params.onInstallGit ? [{ key: 'git', kind: 'input' as const, label: t('settingsPlugins.gitInstall.mode'), icon: 'link' as const,
                renderBody: () => <PluginGitSourceInput onInstall={source => {
                    if (catalog.execution.isCurrent() && props.params.onInstallGit?.(source)) props.onClose();
                }} /> }] : [])],
        sources: slot.sources,
        ...(seedEntry ? { initialItemKey: keyOf(seedEntry) } : {}),
        catalog: {
            query, onQueryChange: changeQuery, searchPlaceholder: t('settingsPlugins.discoverSearchPlaceholder'),
            items, itemKey: keyOf, anatomy, loading: catalog.loadingDiscover,
            ...(catalog.discoverNextCursor ? { loadMore: { label: t('common.more'), loading: catalog.loadingMoreDiscover,
                onPress: async () => { catalog.loadMoreDiscover(); } } } : {}),
            sourceFailures: catalog.discoverDiagnostics.map(diagnostic => {
                const title = sources.sources.find(source => source.id === diagnostic.id)?.title;
                return { sourceId: diagnostic.id, message: title ? `${title} · ${diagnostic.message}` : diagnostic.message,
                    onRetry: catalog.refreshDiscover };
            }),
            empty: <SurfaceStateCard kind={catalog.discoverError ? 'error' : seedRequested ? 'unavailable' : 'empty'} size="line"
                title={catalog.discoverError ?? t(seedRequested ? 'settingsPlugins.surfaces.listingNotFoundTitle' : 'settingsPlugins.surfaces.emptyTitle')}
                action={catalog.discoverError ? { label: t('common.retry'), onPress: catalog.refreshDiscover } : undefined} />,
        },
        renderDetail: entry => <PluginAddDetail entry={entry} sources={sources} onSelection={setSelection} />,
        detailFooter: entry => ({ primary: {
            label: t('settingsPlugins.pendingChangeReviewAction'),
            ...(!selection?.pointer || selection.key !== keyOf(entry) ? { disabledReason: t('common.loading') } : {}),
            onPress: async () => {
                if (!catalog.execution.isCurrent() || selection?.key !== keyOf(entry) || !selection.pointer) return null;
                props.onClose();
                router.push(buildPluginListingRoute(props.params.host ?? 'settings', selection.pointer));
                return null;
            },
        } }),
    };
    return <CapabilityAddModalBody {...props} config={config} />;
}

function PluginGitSourceInput({ onInstall }: Readonly<{ onInstall: (source: PluginGitSourceV1) => void }>) {
    const [locator, setLocator] = React.useState('');
    const [subdirectory, setSubdirectory] = React.useState('');
    const source = PluginGitSourceV1Schema.safeParse({ locator: locator.trim(), subdirectory: subdirectory.trim() || undefined });
    const submit = () => { if (source.success) onInstall(source.data); };
    return <>
        <FieldTextInput testID={`${TEST_ID}.git.url`} value={locator} onChangeText={setLocator}
            accessibilityLabel={t('settingsPlugins.gitInstall.repository')} placeholder={t('settingsPlugins.gitInstall.repository')}
            inputMode="url" autoCapitalize="none" />
        <FieldTextInput testID={`${TEST_ID}.git.subdirectory`} value={subdirectory} onChangeText={setSubdirectory}
            accessibilityLabel={t('settingsPlugins.gitInstall.subdirectory')} placeholder={t('settingsPlugins.gitInstall.subdirectory')}
            autoCapitalize="none" onSubmitEditing={submit} />
        <RoundButton testID={`${TEST_ID}.git.review`} title={t('settingsPlugins.pendingChangeReviewAction')}
            disabled={!source.success} onPress={submit} />
    </>;
}

function PluginAddDetail(props: Readonly<{ entry: PluginMarketplaceCatalogEntry; sources: ReturnType<typeof useRegistrySources>;
    onSelection: (selection: Selection) => void }>) {
    const { entry, onSelection } = props;
    // Native identity and the published pin select one body; package/trust facts never come from a title or route guess.
    const detail = usePluginCatalogWithSources({ enabled: entry.itemId !== undefined, selection: { sourceId: entry.sourceId, itemId: entry.itemId ?? '',
        ...(entry.version ? { version: entry.version } : {}) } }, props.sources);
    const selected = detail.discoverEntries[0];
    const selectedItem = detail.selectedItem;
    React.useEffect(() => {
        onSelection({ key: keyOf(entry), pointer: detail.current && selected && selectedItem && (selectedItem.summary.version || selected.gitCatalogItemId)
            ? { sourceId: selected.sourceId, pluginId: selected.id, itemId: selectedItem.summary.itemId, version: selectedItem.summary.version }
            : null });
    }, [entry.sourceId, entry.itemId, detail.current, selected, selectedItem, onSelection]);
    if (!selected) return <SurfaceStateCard kind={detail.loadingDiscover ? 'loading' : 'unavailable'} size="line"
        title={detail.loadingDiscover ? t('common.loading') : t('settingsPlugins.surfaces.listingNotFoundTitle')}
        action={{ label: t('common.retry'), onPress: detail.refreshDiscover }} />;
    return <>
        <CapabilityDetailHeader testID={`${TEST_ID}.detail.header`} title={selected.title} purpose={selected.description ?? undefined}
            mark={<PluginMark title={selected.title} pluginId={selected.id} size="page" />}
            facts={{ source: { kind: 'registry', label: selected.sourceTitle },
                extra: [selected.publisher.displayName, selected.version, catalogReviewStatusLabel(selected)].filter((fact): fact is string => Boolean(fact)) }} />
        <CapabilityAddDetailAction />
        <PluginListingAddsSection entry={selected} />
        <PluginListingFacts entry={selected} />
    </>;
}

import * as React from 'react';
import type { RegistryItemPointerV1 } from '@happier-dev/protocol/registries';
import { PluginGitSourceV1Schema, type PluginGitSourceV1 } from '@happier-dev/protocol/plugins/source-spec';

import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CapabilityAddDetailAction, CapabilityAddModalBody, openCapabilityAddModalHost, useAddDialogEdge, type CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
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
import { describePluginContentOmissions } from '../model/pluginInstallationReviewFacts';
import type { PluginGitSourcePreviewResult } from '../model/usePluginSettingsScreenState';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

export type OpenPluginAddModalParams = Readonly<{
    host?: PluginsSurfaceHost;
    initialSelection?: RegistryItemPointerV1;
    onInstallGit?: (source: PluginGitSourceV1) => boolean;
    /** Reads what a Git link resolves to before Review (`plugins.git.preview`); absent where the host has no Machine. */
    onPreviewGit?: (source: PluginGitSourceV1) => Promise<PluginGitSourcePreviewResult | null>;
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
                renderBody: () => <PluginGitSourceInput onPreview={props.params.onPreviewGit} onInstall={source => {
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

/**
 * The Git mode of the shared Add dialog (lab ideas-1118-platform scene 1, "Add from GitHub"): the repository link with
 * Preview beside it and the optional folder; Preview shows what the link resolves to on the selected Machine (name,
 * release or default branch, commit, what it contains and what will not be imported) through `plugins.git.preview`,
 * which installs nothing. Review then leads to the listing's single evaluated confirmation through `plugins.install`.
 */
function PluginGitSourceInput({ onInstall, onPreview }: Readonly<{
    onInstall: (source: PluginGitSourceV1) => void;
    onPreview?: (source: PluginGitSourceV1) => Promise<PluginGitSourcePreviewResult | null>;
}>) {
    const edge = useAddDialogEdge();
    const { theme } = useUnistyles();
    const [locator, setLocator] = React.useState('');
    const [subdirectory, setSubdirectory] = React.useState('');
    const parsed = PluginGitSourceV1Schema.safeParse({ locator: locator.trim(), subdirectory: subdirectory.trim() || undefined });
    const sourceKey = parsed.success ? JSON.stringify([parsed.data.locator, parsed.data.subdirectory ?? '']) : null;
    // The preview belongs to the exact link it read; editing the link drops it.
    const [preview, setPreview] = React.useState<Readonly<{ key: string; result: PluginGitSourcePreviewResult | 'loading' }> | null>(null);
    const current = preview && preview.key === sourceKey ? preview.result : null;
    const requestPreview = () => {
        if (!parsed.success || !onPreview || sourceKey === null) return;
        const key = sourceKey;
        setPreview({ key, result: 'loading' });
        void onPreview(parsed.data).then((result) => setPreview((now) => now?.key === key
            ? { key, result: result ?? { kind: 'failed', message: t('common.unavailable') } } : now));
    };
    const review = () => { if (parsed.success) onInstall(parsed.data); };
    const ready = onPreview ? current !== null && current !== 'loading' && current.kind === 'preview' : parsed.success;
    return (
        <View style={[gitStyles.body, edge]}>
            <View style={gitStyles.fieldRow}>
                <View style={gitStyles.field}>
                    <FieldTextInput testID={`${TEST_ID}.git.url`} value={locator} onChangeText={setLocator}
                        accessibilityLabel={t('settingsPlugins.gitInstall.repository')} placeholder={t('settingsPlugins.gitInstall.repository')}
                        inputMode="url" autoCapitalize="none" autoFocus monospace returnKeyType="go"
                        onSubmitEditing={onPreview ? requestPreview : review} />
                </View>
                {onPreview ? (
                    <RoundButton testID={`${TEST_ID}.git.preview`} size="normal" display="secondary"
                        title={t('settingsPlugins.gitInstall.preview')} disabled={!parsed.success}
                        loading={current === 'loading'} onPress={requestPreview} />
                ) : null}
            </View>
            <FieldTextInput testID={`${TEST_ID}.git.subdirectory`} value={subdirectory} onChangeText={setSubdirectory}
                accessibilityLabel={t('settingsPlugins.gitInstall.subdirectory')} placeholder={t('settingsPlugins.gitInstall.subdirectory')}
                autoCapitalize="none" monospace onSubmitEditing={onPreview ? requestPreview : review} />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('settingsPlugins.gitInstall.latestNote')}</Text>
            {current && current !== 'loading' && current.kind === 'failed' ? (
                <SurfaceStateCard testID={`${TEST_ID}.git.previewFailed`} kind="error" size="line" title={current.message}
                    action={{ label: t('common.retry'), onPress: requestPreview }} />
            ) : null}
            {current && current !== 'loading' && current.kind === 'preview' ? <PluginGitPreviewSummary preview={current.preview} /> : null}
            <View style={gitStyles.footer}>
                <RoundButton testID={`${TEST_ID}.git.review`} title={t('settingsPlugins.pendingChangeReviewAction')}
                    disabled={!ready} onPress={review} />
            </View>
        </View>
    );
}

/** What the previewed link holds, in the listing's own words: identity, where it resolves, contents, what is left out. */
function PluginGitPreviewSummary({ preview }: Readonly<{ preview: Extract<PluginGitSourcePreviewResult, { kind: 'preview' }>['preview'] }>) {
    const { theme } = useUnistyles();
    const { summary } = preview;
    const facts = [
        summary.publisher?.name,
        preview.source.subdirectory ? `${preview.source.locator} · ${preview.source.subdirectory}` : preview.source.locator,
        preview.release.kind === 'stableRelease'
            ? t('settingsPlugins.gitInstall.latestRelease', { tag: preview.release.tag })
            : t('settingsPlugins.gitInstall.defaultBranch'),
        t('settingsPlugins.gitInstall.commit', { commit: preview.resolvedCommit.slice(0, 7) }),
    ].filter((fact): fact is string => Boolean(fact));
    const omissions = describePluginContentOmissions(summary.vendorPlugin?.notImported);
    return (
        <View testID={`${TEST_ID}.git.previewSummary`} style={gitStyles.preview}>
            <CapabilityDetailHeader testID={`${TEST_ID}.git.previewHeader`} title={summary.title}
                purpose={summary.description ?? undefined}
                mark={<PluginMark title={summary.title} pluginId={summary.itemId || summary.title} size="page" />}
                facts={{ source: { kind: 'registry', label: facts[0] ?? summary.title }, extra: facts.slice(1) }} />
            {omissions.length > 0 ? (
                <Text variant="meta" style={{ color: theme.colors.text.secondary }} testID={`${TEST_ID}.git.notImported`}>
                    {`${t('settingsPlugins.gitInstall.notImported')} · ${omissions.join(', ')}`}
                </Text>
            ) : null}
        </View>
    );
}

const gitStyles = StyleSheet.create((theme) => ({
    body: { paddingTop: theme.space.s16, paddingBottom: theme.space.s24, gap: theme.space.s12 },
    fieldRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s12 },
    field: { flex: 1, minWidth: 0 },
    preview: { gap: theme.space.s8, paddingTop: theme.space.s8 },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: theme.space.s8 },
}));

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

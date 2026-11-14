import * as React from 'react';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection, type CollectionAnatomy, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import type { ArtifactStorageUsageV1} from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CollectionTitleButton } from '@/components/ui/lists/collection/CollectionTitleButton';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { MainScreenHeader, type MainScreenSearch } from '@/components/navigation/shell/MainScreenHeader';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PhonePageBackLine, usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifacts, useArtifactsLoaded, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useArtifactInventoryRead } from './useArtifactInventoryRead';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useArtifactStorageUsage } from './artifactActionsClient';
import {
    ARTIFACT_BROWSER_KINDS,
    artifactViewRoute,
    countArtifactBrowserKinds,
    countArtifactBrowserSavedSince,
    opensInArtifactView,
    projectArtifactBrowserRows,
    readArtifactCodeLanguage,
    readArtifactPreview,
    readArtifactProvenance,
    resolveArtifactOpenRoute,
    type ArtifactBrowserKind,
    type ArtifactBrowserRow,
    type ArtifactBrowserSort,
} from './artifactBrowserModel';
import { ArtifactCardPreview } from './ArtifactCardPreview';
import { ArtifactFolderTree, useArtifactFolderCommands, type ArtifactFolderTreeHandle } from './ArtifactFolderTree';
import { ARTIFACT_KIND_ICONS, artifactKindFact, artifactKindFilterLabel } from './artifactKindPresentation';
import { ArtifactProvenanceLabel, readArtifactProvenanceFallback } from './ArtifactProvenance';
import { ArtifactQuotaNotice } from './ArtifactQuotaNotice';
import { ArtifactView } from './ArtifactView';
import { useArtifactOperations } from './useArtifactOperations';

const SORTS: readonly ArtifactBrowserSort[] = ['updated_desc', 'created_desc', 'title_asc'];
/** The narrowest card that still shows a readable preview beside another on a tablet or desktop. */
const CARD_MIN_WIDTH_PX = 260;
/**
 * A phone's cards, when chosen, stand two across (a short preview each): the narrowest card the shared grid draws
 * that still holds the mark, a readable title and its insets (the Collection's compact card track).
 */
const PHONE_CARD_MIN_WIDTH_PX = 160;
const LIST_MIN_WIDTH_PX = 320;
/** Below this the page is too narrow to keep the grid beside an open artifact. */
const PAGE_MIN_WIDTH_PX = 560;

/** Cards, a list, or the personal folder tree (EC D49): three presentations of the same library. */
type BrowserPresentation = 'grid' | 'list' | 'folders';

function sortLabel(sort: ArtifactBrowserSort): string {
    switch (sort) {
        case 'updated_desc': return t('artifacts.browser.sort.updated_desc');
        case 'created_desc': return t('artifacts.browser.sort.created_desc');
        case 'title_asc': return t('artifacts.browser.sort.title_asc');
    }
}

function rowTitle(row: ArtifactBrowserRow): string {
    return row.artifact.title || t('artifacts.untitled');
}

/** Listed artifacts saved since local midnight: the page's present-tense line. */
function countSavedToday(artifacts: readonly DecryptedArtifact[], nowMs: number): number {
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    return countArtifactBrowserSavedSince(artifacts, midnight.getTime());
}

/**
 * The Artifacts destination (RU2 §9.6, lab `app-surfaces/artifacts` A1–A8): every ordinary Account
 * Artifact as one Collection — search, kind, sort, Grid | List | Folders — whose cards show the thing itself.
 * Folders (EC D49, lab `lane12-final/c-art`) is the same library as one personal folder tree. Opening a
 * document shows it in the app's details pane beside the grid (a phone pushes its page); every other kind
 * opens in its own destination.
 */
export function ArtifactsBrowserScreen(): React.ReactElement {
    const artifacts = useArtifacts('browserListed');
    const loaded = useArtifactsLoaded('browserListed');
    const usage = useArtifactStorageUsage();
    const { value: folders } = usePromptLibraryCatalogValue('folders');
    // The browser opening is the intent to read the list; the sync owner keeps it fresh after that.
    const { failed: loadFailed, retry } = useArtifactInventoryRead(true, 'browserListed', { includeProvenance: true });
    return <ArtifactsBrowser artifacts={artifacts} folders={folders} loaded={loaded} loadFailed={loadFailed} onRetry={retry} usage={usage} />;
}

/** The browser itself, over the artifacts and budget it is given (the screen binds the store; `/dev/artifacts` binds fixtures). */
export function ArtifactsBrowser(props: Readonly<{
    artifacts: readonly DecryptedArtifact[];
    folders?: PromptFoldersV1 | null;
    loaded: boolean;
    loadFailed: boolean;
    onRetry: () => void;
    usage: ArtifactStorageUsageV1 | null;
    /** Opens this artifact beside the grid on arrival (the specimen's selected state). */
    initialOpenId?: string;
}>): React.ReactElement {
    const router = useRouter();
    const { theme } = useUnistyles();
    // The phone's browser has no native header (its PageHeader owns the identity), so its Back sits on the page's head
    // line and never strands a direct load: with no history it goes Home.
    const deviceType = useDeviceType();
    const phoneLayout = deviceType === 'phone';
    const inheritedBack = useNavigationBackControl();
    const phoneBack = usePhoneDestinationBack('artifacts:back');
    const { artifacts, loaded, loadFailed, usage } = props;
    const [query, setQuery] = React.useState('');
    const [kind, setKind] = React.useState<ArtifactBrowserKind | 'all'>('all');
    const [sort, setSort] = React.useState<ArtifactBrowserSort>('updated_desc');
    const [view, setView] = useLocalSettingMutable('artifactsBrowserViewV1');
    // A phone lists by default (dense, scannable); cards lead only where two fit side by side (tablet, desktop).
    // The person's own choice, once made, is kept.
    const presentation: BrowserPresentation = view?.presentation ?? (deviceType === 'phone' ? 'list' : 'grid');
    const setPresentation = React.useCallback((next: BrowserPresentation) => setView({ presentation: next }), [setView]);
    const filter = React.useMemo(() => ({ query, kind, sort }), [query, kind, sort]);
    const folderTree = React.useRef<ArtifactFolderTreeHandle>(null);

    const rows = React.useMemo(() => projectArtifactBrowserRows(artifacts, filter, { folders: props.folders }),
        [artifacts, filter, props.folders]);
    const counts = React.useMemo(() => countArtifactBrowserKinds(artifacts), [artifacts]);
    const total = React.useMemo(() => [...counts.values()].reduce((sum, count) => sum + count, 0), [counts]);
    const savedToday = React.useMemo(() => countSavedToday(artifacts, Date.now()), [artifacts]);

    const besidePage = useDetailsPaneAvailable();
    const [openId, setOpenId] = React.useState<string | null>(props.initialOpenId ?? null);
    const openArtifact = React.useCallback((key: string | null) => {
        if (key === null) { setOpenId(null); return; }
        const artifact = artifacts.find((candidate) => candidate.id === key);
        if (!artifact) return;
        if (!opensInArtifactView(artifact)) { router.push(resolveArtifactOpenRoute(artifact) as never); return; }
        if (besidePage) setOpenId(key);
        else router.push(artifactViewRoute(key) as never);
    }, [artifacts, besidePage, router]);
    const openRow = artifacts.find((artifact) => artifact.id === openId) ?? null;
    const paneOpen = openRow !== null;

    const model = useHappierCollection<ArtifactBrowserRow>({
        items: rows,
        keyOf: readRowKey,
        openKey: paneOpen ? openId : null,
        onOpenChange: openArtifact,
    });
    // Opening beside the grid narrows it and re-flows the cards, which carries the opened one out of view: bring it back and keep it ringed.
    const requestFocus = model.actions.requestFocus;
    React.useEffect(() => { if (openId !== null && paneOpen) requestFocus(openId); }, [openId, paneOpen, requestFocus]);
    // A phone's list is the page's one sheet of rows (lab A1p); wider layouts keep the table that recomposes by width.
    const collectionPresentation = presentation === 'grid' ? 'grid' : phoneLayout ? 'list' : 'table';
    const anatomy = useBrowserAnatomy(presentation === 'grid' ? 'grid' : 'list');
    const newDocument = React.useCallback(() => router.push('/artifacts/new' as never), [router]);
    // The title row's "+" and, on a phone, the bar's "+" beside the tabs run the same action (the main-screen head).
    const create = React.useMemo<PageCreateAction>(() => ({
        label: t('artifacts.browser.newDocument'), testID: 'artifacts:new', onPress: newDocument,
    }), [newDocument]);
    // A main screen's search waits behind its magnifier (nothing to search in an empty library).
    const searchPlaceholder = t('artifacts.browser.searchPlaceholder');
    const firstVisitForSearch = loaded && total === 0 && !loadFailed;
    const search = React.useMemo<MainScreenSearch | null>(() => firstVisitForSearch ? null
        : { value: query, onChangeText: setQuery, placeholder: searchPlaceholder, testID: 'artifacts:search' },
    [firstVisitForSearch, query, searchPlaceholder]);

    const viewSwitch = <ArtifactViewSwitch presentation={presentation} onPresentationChange={setPresentation} />;
    const firstVisit = loaded && total === 0 && !loadFailed;
    // Rows another surface already admitted (Context's Prompt kinds) are a part of the library, not all of it.
    const partial = !loaded && !loadFailed && total > 0;
    const header = (
        <>
            <BrowserHeader
                total={total}
                partial={!loaded}
                savedToday={savedToday}
                usage={usage}
                // A count is a fact about a list that has been read: never "0 artifacts" over the skeleton. The
                // unread list keeps the line's space, so the toolbar and grid do not move when it arrives.
                showPresent={total > 0}
                reservePresent={!loaded && !loadFailed}
                create={create}
                search={search}
                // A phone's title opens the library's choices (kind and order), as every main screen's title does.
                titleFilters={phoneLayout && !firstVisit ? { kind, onKindChange: setKind, counts, sort, onSortChange: setSort } : null}
                // A phone's view switch sits with the count, below the choices (lab A1p keeps the search a full row).
                viewSwitch={firstVisit ? null : viewSwitch}
                toolbar={firstVisit ? null : (
                    <BrowserToolbar
                        kind={kind}
                        onKindChange={setKind}
                        counts={counts}
                        sort={sort}
                        onSortChange={setSort}
                        presentation={presentation}
                        viewSwitch={viewSwitch}
                        onNewFolder={() => folderTree.current?.createFolder(null)}
                    />
                )}
            />
            {/* On the grid's edges, like the quota notice above: the column's padding is not the page's edge. */}
            {loadFailed && total > 0 ? <View style={stylesheet.freshness}><SurfaceFreshnessLine
                testID="artifacts:stale"
                tone="warning"
                reason={t('artifacts.browser.retainedBody')}
                action={{ label: t('common.retry'), onPress: props.onRetry }}
            /></View> : null}
            {partial ? <View style={stylesheet.freshness}><SurfaceFreshnessLine testID="artifacts:pending" busy reason={t('artifacts.browser.loadingBody')} /></View> : null}
        </>
    );

    const empty = firstVisit ? (
        <EmptyState
            testID="artifacts:empty"
            layout="page"
            scene="noNotes"
            title={t('artifacts.browser.emptyTitle')}
            subtitle={t('artifacts.browser.emptyBody')}
            primaryAction={{ label: t('artifacts.browser.newDocument'), onPress: newDocument, testID: 'artifacts:empty:new' }}
            action={<Text style={stylesheet.hint}>{t('artifacts.browser.emptyHint')}</Text>}
        />
    ) : loadFailed && total === 0 ? (
        <EmptyState
            testID="artifacts:failed"
            layout="page"
            iconName="warning-circle"
            title={t('artifacts.browser.loadFailedTitle')}
            subtitle={t('artifacts.browser.loadFailedBody')}
            primaryAction={{ label: t('common.retry'), onPress: props.onRetry }}
        />
    ) : partial ? (
        // The unread remainder could still match: not a definitive answer until the full list has been read.
        <EmptyState testID="artifacts:noMatchSoFar" layout="line" title={t('artifacts.browser.noMatchSoFar', { query: query.trim() || artifactKindFilterLabel(kind) })} />
    ) : (
        <EmptyState testID="artifacts:noMatch" layout="line" title={t('artifacts.browser.noMatch', { query: query.trim() || artifactKindFilterLabel(kind) })} />
    );

    const rowCommands = React.useMemo(() => ({ open: openArtifact, deleted: (id: string) => setOpenId(current => current === id ? null : current) }), [openArtifact]);
    // An empty or unread library keeps the Collection's own first-visit, failure and loading states.
    const main = presentation === 'folders' && total > 0 ? (
        <CoreCollectionScope>
            <ItemList pageColumn="wide">
                <PageContentColumn>
                    {header}
                    {/* The page's sheet edge, shared with the header and the List and Grid views (Settings → Folders does the same). */}
                    <ItemGroup surface="none" header="none">
                    <ArtifactFolderTree
                        ref={folderTree}
                        testID="artifacts:folders"
                        accessibilityLabel={t('artifacts.title')}
                        artifacts={artifacts}
                        filter={filter}
                        selectedArtifactId={paneOpen ? openId : null}
                        onOpenArtifact={openArtifact}
                        onArtifactDeleted={rowCommands.deleted}
                    />
                    </ItemGroup>
                </PageContentColumn>
            </ItemList>
        </CoreCollectionScope>
    ) : (
        <ArtifactRowCommandsContext.Provider value={rowCommands}>
            <CoreCollectionScope renderPageScroller={renderBrowserPageScroller}>
                <Collection<ArtifactBrowserRow>
                    testID="artifacts:collection"
                    model={model}
                    anatomy={anatomy}
                    useRowActions={useArtifactRowActions}
                    accessibilityLabel={t('artifacts.title')}
                    presentation={collectionPresentation}
                    detail="none"
                    scroll="page"
                    minListWidth={LIST_MIN_WIDTH_PX}
                    minDetailWidth={LIST_MIN_WIDTH_PX}
                    preferredListRatio={1}
                    minCardWidth={phoneLayout ? PHONE_CARD_MIN_WIDTH_PX : CARD_MIN_WIDTH_PX}
                    header={header}
                    loading={!loaded && total === 0 && !loadFailed}
                    empty={empty}
                />
            </CoreCollectionScope>
        </ArtifactRowCommandsContext.Provider>
    );

    return (
        // A phone's head line stands under the status bar, as every main screen's does (its Back on a page it pushes),
        // so the title stands where My work's does; wider hosts keep their inherited Back in the header.
        <NavigationBackChromeProvider control={phoneLayout ? null : inheritedBack}>
        <View style={stylesheet.screen}>
        {phoneLayout ? <PhonePageBackLine control={phoneBack} page /> : null}
        <DetailsPaneHost
            testID="artifacts:detailPane"
            mainColumn={{
                hideLabel: t('panes.mainColumn.hidePage', { title: t('artifacts.title') }),
                showLabel: t('panes.mainColumn.showPage', { title: t('artifacts.title') }),
                identity: { name: t('artifacts.title') },
            }}
            main={main}
            mainMinWidthPx={PAGE_MIN_WIDTH_PX}
            onCloseDetails={() => setOpenId(null)}
            details={paneOpen && openRow ? {
                header: {
                    title: openRow.title || t('artifacts.untitled'),
                    actions: (
                        <CorePluginUiPresentationScope><DetailsPaneOpenAsPageButton
                            testID="artifacts:detailPane:openAsPage"
                            accessibilityLabel={t('artifacts.browser.openAsPage')}
                            onPress={() => router.push(artifactViewRoute(openRow.id) as never)}
                        /></CorePluginUiPresentationScope>
                    ),
                },
                content: <ArtifactView key={openRow.id} artifactId={openRow.id} artifact={openRow} presentation="pane" onDeleted={() => setOpenId(null)} />,
            } : null}
        />
        </View>
        </NavigationBackChromeProvider>
    );
}

const ArtifactRowCommandsContext = React.createContext<Readonly<{ open: (key: string) => void; deleted: (key: string) => void }> | null>(null);

function useArtifactRowActions(row: ArtifactBrowserRow): CollectionRowActions {
    const commands = React.useContext(ArtifactRowCommandsContext);
    const operations = useArtifactOperations(row.artifact, () => commands?.deleted(row.key));
    // A phone's row opens the artifact, whose own page carries Share, History and Delete (lab A1p: no ⋯ on every row).
    const phone = useDeviceType() === 'phone';
    if (phone || !operations.canRead) return {};
    return {
        busy: operations.deleting,
        secondaryActions: [
            { id: 'open', label: t('common.open') },
            ...(operations.canShare ? [{ id: 'share', label: t('artifacts.browser.actions.share') }] : []),
            { id: 'history', label: t('artifacts.browser.actions.history') },
            ...(operations.canManage ? [{ id: 'delete', label: t('artifacts.delete'), destructive: true, disabled: operations.deleting }] : []),
        ],
        onSecondaryAction: (id, selection) => {
            if (id === 'open') commands?.open(row.key);
            else if (id === 'share') operations.share(resolvePressTriggerAnchor({ currentTarget: selection?.anchorRef?.current }));
            else if (id === 'history') operations.history();
            else if (id === 'delete') return operations.remove();
        },
    };
}

function rowKindFact(row: ArtifactBrowserRow) {
    return artifactKindFact(row.kind, readArtifactCodeLanguage(row.artifact));
}

function readRowKey(row: ArtifactBrowserRow): string {
    return row.key;
}

function renderBrowserPageScroller(children: React.ReactNode): React.ReactNode {
    return (
        <ItemList pageColumn="wide">
            <PageContentColumn>{children}</PageContentColumn>
        </ItemList>
    );
}

/** A phone row's second line: "Prompt", or "Document · Shared with you" — only facts the artifact carries. */
function ArtifactListFacts(props: Readonly<{ row: ArtifactBrowserRow }>) {
    const { row } = props;
    const kind = row.artifact.isDecrypted === false ? null : rowKindFact(row).label;
    const provenance = readArtifactProvenance(row.artifact);
    const fallback = readArtifactProvenanceFallback(row.artifact);
    const source = provenance === null && fallback === null ? null : (
        <ArtifactProvenanceLabel provenance={provenance} fallback={fallback ?? ''} presentation="line" testID={`artifacts:row:${row.key}:provenance`} />
    );
    return (
        <View style={stylesheet.listFacts} testID={`artifacts:row:${row.key}:facts`}>
            {kind === null ? null : <Text numberOfLines={1} style={stylesheet.listFactsText}>{kind}</Text>}
            {kind !== null && source !== null ? <Text style={stylesheet.listFactsText}>·</Text> : null}
            {source}
        </View>
    );
}

/** The page's one hero, its purpose and the present line: count, today, and the meter when there is a budget. */
function BrowserHeader(props: Readonly<{
    total: number;
    /** The rows shown are only what is loaded so far: the count is not a final total. */
    partial: boolean;
    savedToday: number;
    usage: ArtifactStorageUsageV1 | null;
    showPresent: boolean;
    reservePresent: boolean;
    create: PageCreateAction;
    /** The title row's magnifier and its field; absent while the library is empty (nothing to search yet). */
    search: MainScreenSearch | null;
    titleFilters: ArtifactTitleFiltersProps | null;
    /** A phone shows the Grid | List | Folders switch on the line with the count. */
    viewSwitch: React.ReactNode;
    toolbar: React.ReactNode;
}>) {
    const styles = stylesheet;
    const limit = props.usage?.limitBytes ?? null;
    const phone = useDeviceType() === 'phone';
    const overQuota = props.usage !== null && limit !== null && props.usage.usedBytes >= limit;
    // The library's reported counts go to the shared count line; the storage meter stays beside the title (or the switch).
    const count = props.showPresent ? [
        props.partial ? t('artifacts.browser.countSoFar', { count: props.total })
            : props.total === 1 ? t('artifacts.countSingular') : t('artifacts.countPlural', { count: props.total }),
        props.savedToday > 0 && !props.partial ? t('artifacts.browser.savedToday', { count: props.savedToday }) : null,
    ] : undefined;
    const meter = props.showPresent && props.usage !== null && limit !== null
        ? <StorageMeter usedBytes={props.usage.usedBytes} limitBytes={limit} /> : null;
    return (
        // The main-screen head (owner 11-11): the title opens the library's choices on a phone, its row ends with the
        // magnifier and the "+" (the bar's "+" runs the same action); the chips sit right under it, the count line last.
        <MainScreenHeader
            testID="artifacts:header"
            title={t('artifacts.title')}
            titleControl={props.titleFilters ? <ArtifactTitleFilters {...props.titleFilters} /> : undefined}
            alwaysShowTitle
            description={phone && (props.showPresent || props.reservePresent) ? undefined : t('artifacts.browser.description')}
            details={phone ? undefined : meter ?? undefined}
            {...(count === undefined ? {} : { count })}
            countPending={!props.showPresent && props.reservePresent}
            search={props.search}
            create={props.create}
            band={props.toolbar || overQuota ? <>
                {props.toolbar}
                {/* Under the toolbar, on the grid's edges (lab A8): it blocks saving, not finding. */}
                {overQuota && props.usage !== null && limit !== null ? (
                    <ArtifactQuotaNotice testID="artifacts:quota" placement="inline" quota={{ budget: 'account', usedBytes: props.usage.usedBytes, limitBytes: limit }} />
                ) : null}
            </> : undefined}
            status={phone && (meter || props.viewSwitch) ? (
                <View style={styles.phoneStatusRow}>
                    <View style={styles.phonePresentSlot}>{meter}</View>
                    {props.viewSwitch}
                </View>
            ) : undefined}
        />
    );
}

/** The storage meter: shown only when the server reports an Account budget (unset is the default). */
function StorageMeter(props: Readonly<{ usedBytes: number; limitBytes: number }>) {
    const styles = stylesheet;
    const ratio = props.limitBytes > 0 ? Math.min(1, props.usedBytes / props.limitBytes) : 1;
    const full = props.usedBytes >= props.limitBytes;
    const used = formatHappierDataBytes(props.usedBytes, { kind: 'storage' });
    const limit = formatHappierDataBytes(props.limitBytes, { kind: 'storage' });
    return (
        <View
            style={styles.meter}
            testID="artifacts:storageMeter"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('artifacts.browser.storage.a11y', { used, limit })}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        >
            <View style={styles.meterTrack}>
                <View style={[styles.meterFill, full ? styles.meterFillFull : null, { width: `${Math.round(ratio * 100)}%` }]} />
            </View>
            <Text style={[styles.presentText, full ? styles.meterTextFull : null]}>{t('artifacts.browser.storage.meter', { used, limit })}</Text>
        </View>
    );
}

/** Grid | List | Folders: icons only, the same three presentations of the library everywhere it is drawn. */
function ArtifactViewSwitch(props: Readonly<{
    presentation: BrowserPresentation;
    onPresentationChange: (presentation: BrowserPresentation) => void;
}>) {
    const { theme } = useUnistyles();
    const viewTabs = React.useMemo(() => [
        { id: 'grid' as const, label: t('artifacts.browser.view.grid'), icon: <Icon name="squares-four" size={16} color={theme.colors.text.secondary} /> },
        { id: 'list' as const, label: t('artifacts.browser.view.list'), icon: <Icon name="list" size={16} color={theme.colors.text.secondary} /> },
        { id: 'folders' as const, label: t('artifacts.browser.view.folders'), icon: <Icon name="folder" size={16} color={theme.colors.text.secondary} /> },
    ], [theme.colors.text.secondary]);
    return (
        <SegmentedTabBar
            tabs={viewTabs}
            activeTabId={props.presentation}
            onSelectTab={props.onPresentationChange}
            testIDPrefix="artifacts:view"
            accessibilityLabel={t('artifacts.browser.view.label')}
            segmentSizing="content"
        />
    );
}

/** The kinds the library can narrow to: only kinds that hold something; a kind that empties keeps its choice until changed. */
function useArtifactKindOptions(counts: ReadonlyMap<ArtifactBrowserKind, number>, kind: ArtifactBrowserKind | 'all') {
    const { theme } = useUnistyles();
    return React.useMemo(() => [
        { id: 'all', label: artifactKindFilterLabel('all') },
        ...ARTIFACT_BROWSER_KINDS.filter((candidate) => (counts.get(candidate) ?? 0) > 0 || candidate === kind)
            .map((candidate) => ({
                id: candidate,
                label: artifactKindFilterLabel(candidate),
                icon: <Icon name={ARTIFACT_KIND_ICONS[candidate]} size={16} color={theme.colors.text.secondary} />,
            })),
    ], [counts, kind, theme.colors.text.secondary]);
}

function readArtifactKind(id: string): ArtifactBrowserKind | 'all' {
    return ARTIFACT_BROWSER_KINDS.find((candidate) => candidate === id) ?? 'all';
}

function readArtifactSort(id: string): ArtifactBrowserSort {
    return SORTS.find((candidate) => candidate === id) ?? 'updated_desc';
}

type ArtifactTitleFiltersProps = Readonly<{
    kind: ArtifactBrowserKind | 'all';
    onKindChange: (kind: ArtifactBrowserKind | 'all') => void;
    counts: ReadonlyMap<ArtifactBrowserKind, number>;
    sort: ArtifactBrowserSort;
    onSortChange: (sort: ArtifactBrowserSort) => void;
}>;

const KIND_ITEM_PREFIX = 'kind:';
const SORT_ITEM_PREFIX = 'sort:';

/** A phone's title: "Artifacts ⌄" opens the library's choices, the same kind and order the toolbar's chips set. */
function ArtifactTitleFilters(props: ArtifactTitleFiltersProps) {
    const [open, setOpen] = React.useState(false);
    const kindOptions = useArtifactKindOptions(props.counts, props.kind);
    const items = React.useMemo<readonly DropdownMenuItem[]>(() => [
        ...kindOptions.map((option): DropdownMenuItem => ({
            id: `${KIND_ITEM_PREFIX}${option.id}`,
            testID: `artifacts:title-menu:kind:${option.id}`,
            title: option.label,
            ...('icon' in option ? { icon: option.icon } : {}),
            checked: option.id === props.kind,
            category: 'kind',
        })),
        ...SORTS.map((candidate): DropdownMenuItem => ({
            id: `${SORT_ITEM_PREFIX}${candidate}`,
            testID: `artifacts:title-menu:sort:${candidate}`,
            title: sortLabel(candidate),
            checked: candidate === props.sort,
            category: 'sort',
        })),
    ], [kindOptions, props.kind, props.sort]);
    const { onKindChange, onSortChange } = props;
    const select = React.useCallback((itemId: string) => {
        setOpen(false);
        if (itemId.startsWith(KIND_ITEM_PREFIX)) onKindChange(readArtifactKind(itemId.slice(KIND_ITEM_PREFIX.length)));
        else if (itemId.startsWith(SORT_ITEM_PREFIX)) onSortChange(readArtifactSort(itemId.slice(SORT_ITEM_PREFIX.length)));
    }, [onKindChange, onSortChange]);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={select}
            variant="slim"
            search={false}
            separateCategories
            matchTriggerWidth={false}
            popoverPortalWebTarget="body"
            placement="bottom"
            popoverAnchorAlign="start"
            popoverAccessibilityLabel={t('artifacts.title')}
            trigger={({ toggle }) => (
                <CollectionTitleButton
                    testID="artifacts:title"
                    label={t('artifacts.title')}
                    accessibilityLabel={t('artifacts.title')}
                    expanded={open}
                    hasPopup="menu"
                    onPress={toggle}
                />
            )}
        />
    );
}

function BrowserToolbar(props: Readonly<{
    kind: ArtifactBrowserKind | 'all';
    onKindChange: (kind: ArtifactBrowserKind | 'all') => void;
    counts: ReadonlyMap<ArtifactBrowserKind, number>;
    sort: ArtifactBrowserSort;
    onSortChange: (sort: ArtifactBrowserSort) => void;
    presentation: BrowserPresentation;
    viewSwitch: React.ReactNode;
    onNewFolder: () => void;
}>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    // A phone's Folders view is one compact row under the search (lab `c-art Tp`): kind, then New folder
    // as its glyph. The order choice is made in List or Grid and still orders items here.
    const compactFolders = phone && props.presentation === 'folders';
    const styles = stylesheet;
    const folders = useArtifactFolderCommands();
    const kindOptions = useArtifactKindOptions(props.counts, props.kind);
    const sortOptions = React.useMemo(() => SORTS.map((candidate) => ({ id: candidate, label: sortLabel(candidate) })), []);
    // The search field is the main-screen head's, under these choices (its magnifier is on the title row).
    return (
        <View style={styles.toolbar} testID="artifacts:toolbar">
            <View style={styles.toolbarChoices}>
                <SelectionListFilterChip filter={{
                    id: 'artifacts-kind',
                    testID: 'artifacts:kind',
                    label: t('artifacts.browser.kindLabel'),
                    options: kindOptions,
                    selectedId: props.kind,
                    onChange: (id) => props.onKindChange(readArtifactKind(id)),
                }} />
                {compactFolders ? null : (
                    <SelectionListFilterChip filter={{
                        id: 'artifacts-sort',
                        testID: 'artifacts:sort',
                        label: t('artifacts.browser.sort.label'),
                        options: sortOptions,
                        selectedId: props.sort,
                        onChange: (id) => props.onSortChange(readArtifactSort(id)),
                    }} />
                )}
                <View style={styles.grow} />
                {compactFolders ? (
                    <IconButton
                        testID="artifacts:folders:new"
                        iconName="folder-plus"
                        variant="plain"
                        accessibilityLabel={t('artifacts.browser.folders.newFolder')}
                        tooltip={t('artifacts.browser.folders.newFolder')}
                        disabled={!folders.canWrite}
                        onPress={props.onNewFolder}
                    />
                ) : props.presentation === 'folders' ? (
                    <ToolbarButton
                        testID="artifacts:folders:new"
                        label={t('artifacts.browser.folders.newFolder')}
                        icon={<Icon name="folder-plus" size={15} color={theme.colors.text.secondary} />}
                        disabled={!folders.canWrite}
                        onPress={props.onNewFolder}
                    />
                ) : null}
                {phone ? null : props.viewSwitch}
            </View>
        </View>
    );
}

/** One anatomy for both presentations: kind mark, title, provenance, kind and age; cards add the preview. */
function useBrowserAnatomy(presentation: 'grid' | 'list'): CollectionAnatomy<ArtifactBrowserRow> {
    const { theme } = useUnistyles();
    // A phone's row already shows the kind as its mark (lab A1p): the word under the age would say it twice.
    const phone = useDeviceType() === 'phone';
    return React.useMemo((): CollectionAnatomy<ArtifactBrowserRow> => ({
        glyph: (row) => <Icon name={row.artifact.isDecrypted === false ? 'lock' : rowKindFact(row).icon} size={20} color={theme.colors.text.secondary} />,
        title: (row) => (row.artifact.isDecrypted === false ? t('settingsAccount.restoreRequiredTitle') : rowTitle(row)),
        // A phone's one list line says what the row is: its kind, then where it came from (owner 11-11).
        where: phone && presentation === 'list' ? (row) => <ArtifactListFacts row={row} /> : (row) => {
            const provenance = readArtifactProvenance(row.artifact);
            const fallback = readArtifactProvenanceFallback(row.artifact);
            if (provenance === null && fallback === null) return undefined;
            return <ArtifactProvenanceLabel provenance={provenance} fallback={fallback ?? ''} presentation="line"
                testID={`artifacts:row:${row.key}:provenance`} />;
        },
        // Shared card anatomy composes the held kind, age and provenance as quiet facts.
        ...(phone && presentation === 'list' ? {} : { reason: (row: ArtifactBrowserRow) => rowKindFact(row).label }),
        // The "Edited" column is a narrow tabular one: the bare age ("45m") fits where "45m ago" was cut off (lab A2).
        age: (row) => formatShortRelativeTime(row.artifact.updatedAt),
        ...(presentation === 'grid' ? {
            preview: (row: ArtifactBrowserRow) => (
                <ArtifactCardPreview preview={readArtifactPreview(row.artifact)} kind={row.kind} testID={`artifacts:row:${row.key}:previewBody`} />
            ),
        } : {}),
        accessibilityLabel: (row) => `${rowTitle(row)}, ${rowKindFact(row).label}`,
        testID: (row) => `artifacts:row:${row.key}`,
        columnTitles: {
            title: t('artifacts.browser.folders.columnName'),
            reason: t('artifacts.browser.kindLabel'),
            where: t('artifacts.browser.sourceLabel'),
            age: t('artifacts.browser.folders.columnEdited'),
        },
    }), [phone, presentation, theme.colors.text.secondary]);
}

const stylesheet = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
    },
    phonePresentSlot: {
        flex: 1,
        minWidth: 0,
    },
    phoneStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
    },
    listFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
        flexShrink: 1,
    },
    listFactsText: {
        flexShrink: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    presentText: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    meter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    meterTrack: {
        width: 72,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: theme.colors.border.default,
    },
    meterFill: {
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.text.secondary,
    },
    meterFillFull: {
        backgroundColor: theme.colors.state.warning.foreground,
    },
    meterTextFull: {
        color: theme.colors.state.warning.foreground,
    },
    freshness: {
        marginHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    },
    // The main-screen head stands the toolbar on the sheets' edge right under the title and spaces its rows.
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    toolbarChoices: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 'auto',
        minWidth: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    grow: {
        flex: 1,
    },
    hint: {
        fontSize: 13,
        color: theme.colors.text.tertiary,
        textAlign: 'center',
        marginTop: theme.space.s12,
    },
}));

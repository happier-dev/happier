import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import type { ArtifactStorageUsageV1 } from '@happier-dev/protocol';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { ToolbarSelect } from '@/components/ui/forms/ToolbarSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { Text } from '@/components/ui/text/Text';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifacts, useArtifactsLoaded, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { useDeviceType } from '@/utils/platform/responsive';

import { useArtifactStorageUsage } from './artifactActionsClient';
import {
    ARTIFACT_BROWSER_KINDS,
    artifactViewRoute,
    countArtifactBrowserKinds,
    opensInArtifactView,
    projectArtifactBrowserRows,
    readArtifactPreview,
    readArtifactProvenance,
    resolveArtifactOpenRoute,
    type ArtifactBrowserKind,
    type ArtifactBrowserRow,
    type ArtifactBrowserSort,
} from './artifactBrowserModel';
import { ArtifactCardPreview } from './ArtifactCardPreview';
import { ARTIFACT_KIND_ICONS, artifactKindFilterLabel, artifactKindLabel } from './artifactKindPresentation';
import { ArtifactProvenanceLabel } from './ArtifactProvenance';
import { ArtifactView } from './ArtifactView';
import { ArtifactsEmptyMark } from './ArtifactsEmptyMark';

const SORTS: readonly ArtifactBrowserSort[] = ['updated_desc', 'created_desc', 'title_asc'];
/** The narrowest card that still shows a readable preview; one column on a 390 pt phone. */
const CARD_MIN_WIDTH_PX = 260;
const LIST_MIN_WIDTH_PX = 320;
/** Below this the page is too narrow to keep the grid beside an open artifact. */
const PAGE_MIN_WIDTH_PX = 560;

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

/** Artifacts saved since local midnight: the page's present-tense line. */
function countSavedToday(artifacts: readonly DecryptedArtifact[], nowMs: number): number {
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    return artifacts.reduce((count, artifact) => count + (artifact.createdAt >= midnight.getTime() ? 1 : 0), 0);
}

/**
 * The Artifacts destination (RU2 §9.6, lab `app-surfaces/artifacts` A1–A8): every ordinary Account
 * Artifact as one Collection — search, kind, sort, Grid | List — whose cards show the thing itself.
 * Opening a document shows it in the app's details pane beside the grid (a phone pushes its page);
 * every other kind opens in its own destination.
 */
export function ArtifactsBrowserScreen(): React.ReactElement {
    const artifacts = useArtifacts();
    const loaded = useArtifactsLoaded();
    const usage = useArtifactStorageUsage();
    const [loadFailed, setLoadFailed] = React.useState(false);
    const refresh = React.useCallback(() => {
        void sync.fetchArtifactsList().then(() => setLoadFailed(false), () => setLoadFailed(true));
    }, []);
    // The browser opening is the intent to read the list; the sync owner keeps it fresh after that.
    React.useEffect(refresh, [refresh]);
    return <ArtifactsBrowser artifacts={artifacts} loaded={loaded} loadFailed={loadFailed} onRetry={refresh} usage={usage} />;
}

/** The browser itself, over the artifacts and budget it is given (the screen binds the store; `/dev/artifacts` binds fixtures). */
export function ArtifactsBrowser(props: Readonly<{
    artifacts: readonly DecryptedArtifact[];
    loaded: boolean;
    loadFailed: boolean;
    onRetry: () => void;
    usage: ArtifactStorageUsageV1 | null;
    /** Opens this artifact beside the grid on arrival (the specimen's selected state). */
    initialOpenId?: string;
}>): React.ReactElement {
    const router = useRouter();
    const { artifacts, loaded, loadFailed, usage } = props;
    const [query, setQuery] = React.useState('');
    const [kind, setKind] = React.useState<ArtifactBrowserKind | 'all'>('all');
    const [sort, setSort] = React.useState<ArtifactBrowserSort>('updated_desc');
    const [view, setView] = useLocalSettingMutable('artifactsBrowserViewV1');
    const deviceType = useDeviceType();
    // A phone lists by default (one card per screen hides the collection); wider screens show cards.
    const presentation = view?.presentation ?? (deviceType === 'phone' ? 'list' : 'grid');
    const setPresentation = React.useCallback((next: 'grid' | 'list') => setView({ presentation: next }), [setView]);

    const rows = React.useMemo(() => projectArtifactBrowserRows(artifacts, { query, kind, sort }), [artifacts, query, kind, sort]);
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
    const paneOpen = besidePage && openRow !== null;

    const model = useHappierCollection<ArtifactBrowserRow>({
        items: rows,
        keyOf: readRowKey,
        openKey: paneOpen ? openId : null,
        onOpenChange: openArtifact,
    });
    const anatomy = useBrowserAnatomy(presentation);
    const newDocument = React.useCallback(() => router.push('/artifacts/new' as never), [router]);

    const firstVisit = loaded && total === 0 && !loadFailed;
    const header = (
        <BrowserHeader
            total={total}
            savedToday={savedToday}
            usage={usage}
            showPresent={!firstVisit}
            onNewDocument={newDocument}
            toolbar={firstVisit ? null : (
                <BrowserToolbar
                    query={query}
                    onQueryChange={setQuery}
                    kind={kind}
                    onKindChange={setKind}
                    counts={counts}
                    sort={sort}
                    onSortChange={setSort}
                    presentation={presentation}
                    onPresentationChange={setPresentation}
                />
            )}
        />
    );

    const empty = firstVisit ? (
        <EmptyState
            testID="artifacts:empty"
            layout="page"
            icon={<ArtifactsEmptyMark />}
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
    ) : (
        <EmptyState testID="artifacts:noMatch" layout="line" title={t('artifacts.browser.noMatch', { query: query.trim() || artifactKindFilterLabel(kind) })} />
    );

    const main = (
        <CoreCollectionScope renderPageScroller={renderBrowserPageScroller}>
            <Collection<ArtifactBrowserRow>
                testID="artifacts:collection"
                model={model}
                anatomy={anatomy}
                accessibilityLabel={t('artifacts.title')}
                presentation={presentation}
                detail="none"
                scroll="page"
                minListWidth={LIST_MIN_WIDTH_PX}
                minDetailWidth={LIST_MIN_WIDTH_PX}
                preferredListRatio={1}
                minCardWidth={CARD_MIN_WIDTH_PX}
                header={header}
                loading={!loaded && total === 0 && !loadFailed}
                empty={empty}
            />
        </CoreCollectionScope>
    );

    return (
        <DetailsPaneHost
            testID="artifacts:detailPane"
            main={main}
            mainMinWidthPx={PAGE_MIN_WIDTH_PX}
            onCloseDetails={() => setOpenId(null)}
            details={paneOpen && openRow ? {
                header: {
                    title: openRow.title || t('artifacts.untitled'),
                    actions: (
                        <IconButton
                            testID="artifacts:detailPane:openAsPage"
                            iconName="arrow-square-out"
                            accessibilityLabel={t('artifacts.browser.openAsPage')}
                            tooltip={t('artifacts.browser.openAsPage')}
                            variant="plain"
                            onPress={() => router.push(artifactViewRoute(openRow.id) as never)}
                        />
                    ),
                },
                content: <ArtifactView key={openRow.id} artifactId={openRow.id} artifact={openRow} presentation="pane" onDeleted={() => setOpenId(null)} />,
            } : null}
        />
    );
}

function readRowKey(row: ArtifactBrowserRow): string {
    return row.key;
}

function BrowserPageColumn(props: Readonly<{ children?: React.ReactNode }>) {
    const maxWidthStyle = useLayoutMaxWidthStyle();
    return <View style={[stylesheet.pageColumn, maxWidthStyle]}>{props.children}</View>;
}

function renderBrowserPageScroller(children: React.ReactNode): React.ReactNode {
    return (
        <ItemList pageColumn="wide">
            <BrowserPageColumn>{children}</BrowserPageColumn>
        </ItemList>
    );
}

/** The page's one hero, its purpose and the present line: count, today, and the meter when there is a budget. */
function BrowserHeader(props: Readonly<{
    total: number;
    savedToday: number;
    usage: ArtifactStorageUsageV1 | null;
    showPresent: boolean;
    onNewDocument: () => void;
    toolbar: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const limit = props.usage?.limitBytes ?? null;
    return (
        <View>
            <PageHeader
                testID="artifacts:header"
                title={t('artifacts.title')}
                description={t('artifacts.browser.description')}
                details={props.showPresent ? (
                    <View style={styles.present} testID="artifacts:present">
                        <Text style={styles.presentText}>
                            {props.total === 1 ? t('artifacts.countSingular') : t('artifacts.countPlural', { count: props.total })}
                        </Text>
                        {props.savedToday > 0 ? (
                            <Text style={styles.presentText}>{`· ${t('artifacts.browser.savedToday', { count: props.savedToday })}`}</Text>
                        ) : null}
                        {props.usage !== null && limit !== null ? <StorageMeter usedBytes={props.usage.usedBytes} limitBytes={limit} /> : null}
                    </View>
                ) : undefined}
                actions={(
                    <RoundButton
                        testID="artifacts:new"
                        size="small"
                        title={t('artifacts.browser.newDocument')}
                        leading={<Icon name="plus" size={14} color={theme.colors.button.primary.tint} />}
                        onPress={props.onNewDocument}
                    />
                )}
            />
            {props.usage !== null && limit !== null && props.usage.usedBytes >= limit ? (
                <QuotaBanner usedBytes={props.usage.usedBytes} limitBytes={limit} />
            ) : null}
            {props.toolbar}
        </View>
    );
}

/** The storage meter: shown only when the server reports an Account budget (unset is the default). */
function StorageMeter(props: Readonly<{ usedBytes: number; limitBytes: number }>) {
    const styles = stylesheet;
    const ratio = props.limitBytes > 0 ? Math.min(1, props.usedBytes / props.limitBytes) : 1;
    const full = props.usedBytes >= props.limitBytes;
    const used = formatByteSize(props.usedBytes);
    const limit = formatByteSize(props.limitBytes);
    return (
        <View
            style={styles.meter}
            testID="artifacts:storageMeter"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('artifacts.browser.storage.a11y', { used, limit })}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        >
            <Text style={styles.presentText}>·</Text>
            <View style={styles.meterTrack}>
                <View style={[styles.meterFill, full ? styles.meterFillFull : null, { width: `${Math.round(ratio * 100)}%` }]} />
            </View>
            <Text style={[styles.presentText, full ? styles.meterTextFull : null]}>{t('artifacts.browser.storage.meter', { used, limit })}</Text>
        </View>
    );
}

/** `quota_exceeded {budget: 'account'}` before it happens: one banner naming the budget and the recovery. */
function QuotaBanner(props: Readonly<{ usedBytes: number; limitBytes: number }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View style={styles.banner} testID="artifacts:quota" accessibilityRole="alert">
            <Icon name="warning" size={18} color={theme.colors.state.warning.foreground} />
            <View style={styles.bannerText}>
                <Text style={styles.bannerTitle}>{t('artifacts.browser.quota.accountTitle')}</Text>
                <Text style={styles.bannerBody}>
                    {t('artifacts.browser.quota.accountBody', { used: formatByteSize(props.usedBytes), limit: formatByteSize(props.limitBytes) })}
                </Text>
            </View>
        </View>
    );
}

function BrowserToolbar(props: Readonly<{
    query: string;
    onQueryChange: (query: string) => void;
    kind: ArtifactBrowserKind | 'all';
    onKindChange: (kind: ArtifactBrowserKind | 'all') => void;
    counts: ReadonlyMap<ArtifactBrowserKind, number>;
    sort: ArtifactBrowserSort;
    onSortChange: (sort: ArtifactBrowserSort) => void;
    presentation: 'grid' | 'list';
    onPresentationChange: (presentation: 'grid' | 'list') => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // Only kinds that hold something are offered; a kind that empties keeps its choice until changed.
    const kindItems = React.useMemo(() => [
        { id: 'all', title: artifactKindFilterLabel('all') },
        ...ARTIFACT_BROWSER_KINDS.filter((candidate) => (props.counts.get(candidate) ?? 0) > 0 || candidate === props.kind)
            .map((candidate) => ({
                id: candidate,
                title: artifactKindFilterLabel(candidate),
                icon: <Icon name={ARTIFACT_KIND_ICONS[candidate]} size={16} color={theme.colors.text.secondary} />,
            })),
    ], [props.counts, props.kind, theme.colors.text.secondary]);
    const sortItems = React.useMemo(() => SORTS.map((candidate) => ({ id: candidate, title: sortLabel(candidate) })), []);
    const viewTabs = React.useMemo(() => [
        { id: 'grid' as const, label: t('artifacts.browser.view.grid'), icon: <Icon name="squares-four" size={16} color={theme.colors.text.secondary} /> },
        { id: 'list' as const, label: t('artifacts.browser.view.list'), icon: <Icon name="list" size={16} color={theme.colors.text.secondary} /> },
    ], [theme.colors.text.secondary]);
    return (
        <View style={styles.toolbar} testID="artifacts:toolbar">
            <CompactSearchField
                testID="artifacts:search"
                value={props.query}
                onChangeText={props.onQueryChange}
                placeholder={t('artifacts.browser.searchPlaceholder')}
                style={styles.search}
            />
            <ToolbarSelect
                testID="artifacts:kind"
                label={t('artifacts.browser.kindLabel')}
                items={kindItems}
                selectedId={props.kind}
                onSelect={(id) => props.onKindChange(id === 'all' ? 'all' : ARTIFACT_BROWSER_KINDS.find((candidate) => candidate === id) ?? 'all')}
            />
            <ToolbarSelect
                testID="artifacts:sort"
                label={t('artifacts.browser.sort.label')}
                items={sortItems}
                selectedId={props.sort}
                onSelect={(id) => props.onSortChange(SORTS.find((candidate) => candidate === id) ?? 'updated_desc')}
            />
            <View style={styles.grow} />
            <SegmentedTabBar
                tabs={viewTabs}
                activeTabId={props.presentation}
                onSelectTab={props.onPresentationChange}
                testIDPrefix="artifacts:view"
                accessibilityLabel={t('artifacts.browser.view.label')}
                segmentSizing="content"
                slidingThumb
                targetSize="platform"
            />
        </View>
    );
}

/** One anatomy for both presentations: kind mark, title, provenance, kind and age; cards add the preview. */
function useBrowserAnatomy(presentation: 'grid' | 'list'): CollectionAnatomy<ArtifactBrowserRow> {
    const { theme } = useUnistyles();
    return React.useMemo((): CollectionAnatomy<ArtifactBrowserRow> => ({
        glyph: (row) => <Icon name={row.artifact.isDecrypted === false ? 'lock' : ARTIFACT_KIND_ICONS[row.kind]} size={18} color={theme.colors.text.secondary} />,
        title: (row) => (row.artifact.isDecrypted === false ? t('settingsAccount.restoreRequiredTitle') : rowTitle(row)),
        where: (row) => (
            <ArtifactProvenanceLabel
                provenance={readArtifactProvenance(row.artifact)}
                fallback={row.artifact.access && row.artifact.access !== 'owner' ? t('artifacts.browser.provenance.sharedWithYou') : t('artifacts.browser.provenance.savedByYou')}
                presentation="line"
                testID={`artifacts:row:${row.key}:provenance`}
            />
        ),
        // A card has no age column, so its footer carries the age after the kind (lab A1).
        reason: (row) => (
            <Text style={stylesheet.reason}>
                {presentation === 'grid'
                    ? `${artifactKindLabel(row.kind)} · ${formatRelativeTimeShort(row.artifact.updatedAt, Date.now())}`
                    : artifactKindLabel(row.kind)}
            </Text>
        ),
        age: (row) => formatRelativeTimeShort(row.artifact.updatedAt, Date.now()),
        ...(presentation === 'grid' ? {
            preview: (row: ArtifactBrowserRow) => (
                <ArtifactCardPreview preview={readArtifactPreview(row.artifact)} kind={row.kind} testID={`artifacts:row:${row.key}:previewBody`} />
            ),
        } : {}),
        accessibilityLabel: (row) => `${rowTitle(row)}, ${artifactKindLabel(row.kind)}`,
        testID: (row) => `artifacts:row:${row.key}`,
        columnTitles: { title: t('artifacts.title'), where: t('artifacts.browser.kindLabel'), age: t('artifacts.browser.sort.updated_desc') },
    }), [presentation, theme.colors.text.secondary]);
}

const stylesheet = StyleSheet.create((theme) => ({
    pageColumn: {
        width: '100%',
        alignSelf: 'center',
    },
    present: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 8,
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
        gap: 6,
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
    banner: {
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        padding: 14,
        borderRadius: 12,
        marginTop: 16,
        backgroundColor: theme.colors.state.warning.background,
    },
    bannerText: {
        flex: 1,
        gap: 2,
    },
    bannerTitle: {
        fontSize: 14,
        lineHeight: 19,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    bannerBody: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 20,
        marginBottom: 14,
    },
    search: {
        width: 280,
        maxWidth: '100%',
    },
    grow: {
        flex: 1,
    },
    reason: {
        fontSize: 12,
        color: theme.colors.text.tertiary,
    },
    hint: {
        fontSize: 13,
        color: theme.colors.text.tertiary,
        textAlign: 'center',
        marginTop: 12,
    },
}));

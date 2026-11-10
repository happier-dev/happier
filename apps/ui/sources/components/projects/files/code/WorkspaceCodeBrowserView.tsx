import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TREE_ROW_METRICS, HappierPressable, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import type { WorkspaceFileTarget } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import type { WorkspaceRepositoryDirectoryState } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatScmHistoryTimestamp } from '@/scm/history/historyPresentation';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceEntryHistory } from '@/hooks/workspaces/files/useWorkspaceEntryHistory';
import { useWorkspaceRepositoryDirectoryRevision } from '@/hooks/workspaces/files/useWorkspaceRepositoryDirectoryRevision';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { CheckoutReachabilityLine, CheckoutReachabilityScope, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { HeaderActionsScope } from '@/components/navigation/stackHeaderActions';

import { CodeBrowserBar } from './CodeBrowserBar';
import { useQuickOpenFilesLauncher } from '@/components/workspaces/files/useQuickOpenEmptyState';
import { CodeCommitStrip } from './CodeCommitStrip';
import { CodeEntryHistoryCells } from './CodeEntryHistoryCells';
import { CodeReadmeCard, findCodeReadmePath } from './CodeReadmeCard';
import { CODE_ENTRY_HISTORY_PENDING, type CodeEntryHistoryState } from './codeEntryHistoryPresentation';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

/**
 * The per-entry history a Code page shows (plan 13 §5 `scm.history.entries`, through the history
 * adapter beside the browser): the latest commit for the current folder or file, and for each row
 * shown. `revision` changes whenever any answer lands, so the mounted rows redraw. Absent while no
 * history producer is reachable: the page then browses files without history columns.
 */
export type WorkspaceCodeEntryHistory = Readonly<{
    current: CodeEntryHistoryState;
    entry: (path: string) => CodeEntryHistoryState;
    revision: string | number;
    /** The one line for an unavailable history ("No Git history here · ~/scratch"). */
    unavailableLabel?: string | null;
}>;

export type WorkspaceCodeLocation = Readonly<{ path: string; kind: 'folder' | 'file' }>;

/**
 * Code (plan 13 §2, lab p-code): the repository as pages. A folder page is the folder's latest
 * commit over its table of entries — each with its latest commit — and its README; a file page is
 * the same strip over the existing file reader. One browser owner beneath (`folderPage` mode of
 * `WorkspaceRepositoryTreeBrowserView`), so Code, the Overview Code widget and Files share rows,
 * actions, uploads and drops.
 */
export const WorkspaceCodeBrowserView = React.memo(function WorkspaceCodeBrowserView(props: Readonly<{
    testID?: string;
    /** The pane scope the file reader registers its find surface and details under. */
    paneScopeId: string;
    scope: WorkspaceScopeBase;
    /** The root's name in the breadcrumb (the project's name). */
    rootLabel: string;
    location: WorkspaceCodeLocation;
    onNavigate: (location: WorkspaceCodeLocation) => void;
    /** File activation is owned by the host's shared workspace file opener. */
    onOpenFile: (path: string) => void;
    onOpenHistory?: ((location: WorkspaceCodeLocation) => void) | null;
    onEditFile?: ((path: string) => void) | null;
    fileHref?: (path: string) => string | null;
    /** Where a row's Copy Happier link opens (the Project). */
    fileLinkTarget?: WorkspaceFileTarget | null;
    history?: WorkspaceCodeEntryHistory | null;
    onOpenFilePinned?: (path: string) => void;
    selectedPath?: string | null;
    revealRequest?: Readonly<{ path: string }>;
    /** The visible rows changed: what the history adapter should demand next. */
    onVisibleEntriesChange?: ((paths: readonly string[]) => void) | null;
    /**
     * `page` (default): the Code page. `widget`: the Overview Code widget's body (lab p-overview HOME) —
     * the same strip and table in place, no Go to file or README (the README is its own widget), and a
     * footer line with the way into the full page. A file pressed in either presentation enters
     * the host's shared opener through `onOpenFile`.
     */
    presentation?: 'page' | 'widget';
    /** Widget: "Open in Code" (the host opens the Code page at this location). */
    onOpenInCode?: ((location: WorkspaceCodeLocation) => void) | null;
    /** An empty repository invites its first commit (lab p-code STATES 3): start a session here. */
    onStartSession?: (() => void) | null;
}>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const testID = props.testID ?? 'workspace-code';
    const { location, onNavigate } = props;
    const widget = props.presentation === 'widget';
    const workspaceKey = tryBuildWorkspaceCacheKey(props.scope) ?? '';
    // The checkout's listing revision (bumped by Refresh and by file changes the app makes): the README follows it.
    const directoryRevision = useWorkspaceRepositoryDirectoryRevision(workspaceKey);
    const demandKey = JSON.stringify([workspaceKey, location.kind, location.path]);
    const [entryData, setEntryData] = React.useState<Readonly<{ key: string; readmePath: string | null; count: number; loaded: boolean }> | null>(null);
    const readmePath = entryData?.key === demandKey ? entryData.readmePath : null;
    // A count is a fact only once the listing answered: a failed or waiting read has no "0 entries".
    const entryCount = entryData?.key === demandKey && entryData.loaded ? entryData.count : null;
    const [visibleDemand, setVisibleDemand] = React.useState<Readonly<{ key: string; paths: readonly string[] }> | null>(null);
    const machine = useMachinePresenceSummary(props.scope.serverId, props.scope.machineId);
    const available = machine.reachability === 'reachable';
    // The checkout's machine isn't answering: said once (here, unless the page above already does),
    // last-known rows stay, and history waits for the machine instead of failing on its own.
    const reachability = useCheckoutReachability(props.scope);
    const scm = useWorkspaceScmSnapshotController(available && props.history === undefined ? props.scope : null);
    const folder = location.kind === 'folder' ? location.path : location.path.slice(0, Math.max(0, location.path.lastIndexOf('/')));
    const demandedPaths = React.useMemo(() => [location.path, ...(location.kind === 'folder' && visibleDemand?.key === demandKey ? visibleDemand.paths : [])],
        [location.path, location.kind, visibleDemand, demandKey]);
    const [historyReload, setHistoryReload] = React.useState(0);
    const facts = useWorkspaceEntryHistory({ scope: props.scope, folder, paths: demandedPaths, headOid: scm.snapshot?.branch.headOid,
        repoRootPath: scm.snapshot?.repo.rootPath,
        // History is read against the repository the snapshot names: until it answers there is no root to
        // read from, and the strip waits (pending) instead of calling history unavailable.
        enabled: props.history === undefined && available && scm.snapshot != null, reloadToken: historyReload });
    const repositoryReadFailed = props.history === undefined && scm.snapshot == null && scm.error != null;
    const readEntry = React.useCallback((path: string): CodeEntryHistoryState => {
        const entry = facts.entries.get(path);
        if (entry) return entry;
        if (facts.status === 'unavailable' || !available || repositoryReadFailed) return { kind: 'unavailable', reason: facts.reason };
        return CODE_ENTRY_HISTORY_PENDING;
    }, [facts, available, repositoryReadFailed]);
    const history = React.useMemo<WorkspaceCodeEntryHistory | null>(() => props.history !== undefined ? props.history : {
        current: readEntry(location.path), entry: readEntry,
        revision: JSON.stringify([facts.status, facts.stale, facts.headOid, [...facts.entries]]),
        // Not a Git checkout says so with where it is (lab p-code STATES 2: "No Git history here · ~/scratch").
        unavailableLabel: scm.snapshot?.repo.isRepo === false
            ? t('projects.code.noGitHistory', { path: formatPathRelativeToHome(props.scope.rootPath, machine.homeDir) })
            : facts.reason === 'SCM_SOURCE_CHANGED' ? t('projects.code.historyChanged') : t('projects.code.historyUnavailable'),
    }, [props.history, readEntry, location.path, facts, scm.snapshot?.repo.isRepo, props.scope.rootPath, machine.homeDir]);
    const refreshHistory = React.useCallback(() => { setHistoryReload(value => value + 1); if (available) void scm.refresh(); }, [available, scm.refresh]);

    const openFolder = React.useCallback((path: string) => onNavigate({ path, kind: 'folder' }), [onNavigate]);
    const openFile = props.onOpenFile;
    // Go to file is quick open scoped to this project (P3 §3.6): one picker, one ranking.
    const quickOpenScope = React.useMemo(() => props.scope, [props.scope.serverId, props.scope.machineId, props.scope.rootPath]);
    const launchQuickOpen = useQuickOpenFilesLauncher({ scope: quickOpenScope });
    const openQuickOpen = React.useMemo(() => launchQuickOpen ? () => launchQuickOpen() : null, [launchQuickOpen]);
    const onVisibleEntriesChange = props.onVisibleEntriesChange;
    const onNodesChange = React.useCallback((nodes: readonly LazyDirectoryTreeNode[], directory: WorkspaceRepositoryDirectoryState) => {
        const entries = nodes.filter((node) => node.depth === 0 && (node.type === 'file' || node.type === 'directory'));
        const readmePath = findCodeReadmePath(entries);
        const loaded = directory.loaded && !directory.loading && !directory.error;
        setEntryData(previous => previous?.key === demandKey && previous.readmePath === readmePath && previous.count === entries.length && previous.loaded === loaded ? previous : { key: demandKey, readmePath, count: entries.length, loaded });
    }, [demandKey]);
    const onVisibleNodesChange = React.useCallback((nodes: readonly LazyDirectoryTreeNode[]) => {
        const paths = nodes.filter((node) => node.type === 'file' || node.type === 'directory').map((node) => node.path);
        setVisibleDemand(previous => previous?.key === demandKey && JSON.stringify(previous.paths) === JSON.stringify(paths) ? previous : { key: demandKey, paths });
        onVisibleEntriesChange?.(paths);
    }, [onVisibleEntriesChange, demandKey]);

    // Read through a ref so the row renderers stay one identity while answers land; `revision` (via
    // the browser's extraData) is what redraws the mounted rows.
    const historyRef = React.useRef(history);
    historyRef.current = history;
    const historyRevision = history ? String(history.revision) : null;
    // The table's commit columns take the rest of the row after the name (lab p-code BROWSE: name ≈ a
    // third, subject, time at the end), so they are sized from the table's own width rather than the
    // row's trailing slot, which only wraps its content.
    const [tableWidth, setTableWidth] = React.useState<number | null>(null);
    const onTableLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setTableWidth((previous) => (previous === next ? previous : next));
    }, []);
    const historyColumnsWidth = tableWidth ? Math.round(tableWidth * CODE_HISTORY_COLUMNS_SHARE) : null;
    // Names win: a table too narrow for the name column beside the commit columns (a phone, the
    // Overview widget in a narrow column) stacks each row as the phone does — name, time at the end,
    // subject under the name — instead of squeezing names to a letter.
    const stackedRows = phone || (tableWidth !== null && tableWidth < CODE_TABLE_COLUMNS_MIN_WIDTH_PX);
    // Not a Git checkout (or history otherwise unknowable here): the table keeps the names and drops
    // the commit columns; the strip says why once (lab p-code STATES 2).
    // A folder no commit touches says "No commits yet" once in the strip; its rows don't repeat it.
    const historyColumns = history != null && history.current.kind !== 'unavailable' && history.current.kind !== 'none';
    const renderRowMetadata = React.useCallback((node: LazyDirectoryTreeNode) => {
        const current = historyRef.current;
        if (!current || (node.type !== 'file' && node.type !== 'directory')) return null;
        return <CodeEntryHistoryCells testID={`${testID}-history-${node.path}`} state={current.entry(node.path)} layout={stackedRows ? 'time' : 'columns'} columnsWidth={historyColumnsWidth} />;
        // `historyRevision` re-mints the renderer so the browser's row extraData changes with each answer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyRevision, stackedRows, testID, historyColumnsWidth]);
    const renderRowSubtitle = React.useCallback((node: LazyDirectoryTreeNode) => {
        const current = historyRef.current;
        if (!stackedRows || !current || (node.type !== 'file' && node.type !== 'directory')) return null;
        return <CodeEntryHistoryCells state={current.entry(node.path)} layout="subject" />;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyRevision, stackedRows]);
    const folderPage = React.useMemo(() => (location.kind === 'folder' ? {
        path: location.path,
        onOpenFolder: openFolder,
        renderRowMetadata: historyColumns ? renderRowMetadata : null,
        renderRowSubtitle: historyColumns ? renderRowSubtitle : null,
        onNodesChange,
        onVisibleNodesChange,
    } : null), [historyColumns, location.kind, location.path, onNodesChange, onVisibleNodesChange, openFolder, renderRowMetadata, renderRowSubtitle]);

    const strip = history && !reachability.unreachable ? (
        <CodeCommitStrip
            testID={`${testID}-strip`}
            state={history.current ?? CODE_ENTRY_HISTORY_PENDING}
            unavailableLabel={history.unavailableLabel}
            onOpenHistory={props.onOpenHistory && history.current.kind === 'commit' ? () => props.onOpenHistory?.(location) : null}
        />
    ) : null;

    const sheetStyle = [styles.sheet, resolveThemeHairlineBorderStyle(theme.colors.border.surface), phone ? styles.sheetPhone : null];
    const historyFreshness = props.history === undefined && facts.stale && available ? <SurfaceFreshnessLine
        testID={`${testID}-history-stale`} asOf={null}
        reason={t('projects.code.historyChanged')}
        action={{ label: t('common.retry'), onPress: refreshHistory }} /> : null;
    const reachabilityLine = reachability.unreachable && !reachability.announced
        ? <CheckoutReachabilityLine scope={props.scope} testID={`${testID}-offline`} /> : null;
    // An unborn repository with nothing in it yet: the page invites the first commit instead of an empty table.
    const emptyRepository = available && location.kind === 'folder' && location.path === '' && entryData?.key === demandKey && entryData.loaded && entryCount === 0 && history?.current.kind === 'none';
    const emptyRepositoryState = emptyRepository ? (
        <SurfaceStateCard
            testID={`${testID}-empty-repository`}
            kind="empty"
            iconName="code"
            title={t('projects.code.emptyRepositoryTitle', { name: props.rootLabel })}
            reason={t('projects.code.emptyRepositoryBody')}
            action={props.onStartSession ? { label: t('projects.code.startSession'), onPress: props.onStartSession } : undefined}
        />
    ) : null;
    // The first listing of a folder hasn't answered yet: its rows hold their place, so the sheet doesn't
    // open from a hairline when the names land (the strip above keeps its own pending line).
    // Pending while the Machine's presence is still resolving too: only a Machine known not to answer has its own state.
    const listingPending = !reachability.unreachable && location.kind === 'folder' && !(entryData?.key === demandKey && entryData.loaded) && entryCount === null;
    const listEmpty = emptyRepositoryState ?? (listingPending ? <CodeListingSkeleton testID={`${testID}-listing-pending`} /> : null);
    const folderFooter = <>
        {widget ? (reachability.unreachable ? null :
            <CodeWidgetFooter
                testID={`${testID}-footer`}
                entryCount={entryCount}
                current={history?.current ?? null}
                onOpenInCode={props.onOpenInCode ? () => props.onOpenInCode?.(location) : null}
            />
        ) : readmePath ? (
            <CodeReadmeCard testID={`${testID}-readme`} scope={props.scope} path={readmePath} onEdit={props.onEditFile} reloadToken={directoryRevision} />
        ) : null}
        {historyFreshness}
    </>;
    // The Code page puts the browser's View and + controls in its own bar beside Go to file (lab
    // p-code BROWSE: one line above the table), so the table opens on its latest commit, not on tools.
    const composeFolderPage = (parts: Readonly<{ controls: React.ReactNode; body: React.ReactNode; status: React.ReactNode }>) => <>
        <CodeBrowserBar
            testID={`${testID}-bar`}
            rootLabel={props.rootLabel}
            path={location.path}
            onNavigateFolder={openFolder}
            onQuickOpen={openQuickOpen}
            compact={phone}
            trailing={parts.controls}
            status={parts.status}
        />
        {reachabilityLine}
        <GlassSurface surfaceGroup="card" nested finishRole="card" testID={`${testID}-table`} style={[sheetStyle, styles.tableSheet]} onLayout={onTableLayout}>
            {parts.body}
        </GlassSurface>
    </>;
    const folderBrowser = (
            <WorkspaceRepositoryTreeBrowserView
                scope={props.scope}
                folderPage={folderPage ? { ...folderPage, listHeader: strip, listFooter: folderFooter, listEmpty,
                    // The widget previews the folder's first entries (lab p-overview HOME); its footer counts them all and opens Code.
                    maxRows: widget ? (phone ? CODE_WIDGET_PREVIEW_ROWS.phone : CODE_WIDGET_PREVIEW_ROWS.wide) : null,
                    ...(widget ? {} : { compose: composeFolderPage }) } : null}
                onOpenFile={openFile}
                onOpenFilePinned={props.onOpenFilePinned}
                selectedPath={props.selectedPath}
                revealRequest={props.revealRequest}
                fileHref={props.fileHref}
                fileLinkTarget={props.fileLinkTarget}
                showSearchBar={false}
                // Code is the repository as committed pages (lab p-code): change marks belong to Changes.
                scmSnapshot={null}
                // Refresh also re-reads this page's own repository snapshot and history, not only the listing.
                onRefreshScm={props.history === undefined ? refreshHistory : undefined}
            />
    );
    // Nothing was ever listed and the machine isn't answering: the widget keeps only its header (the
    // page's line says why), so no empty sheet is drawn around nothing.
    const waitingWithNothing = reachability.unreachable && entryCount === null;
    const body = location.kind === 'folder' ? (widget && !waitingWithNothing ? (
        <GlassSurface surfaceGroup="card" nested finishRole="card" testID={`${testID}-table`} style={[sheetStyle, styles.fileSheet]} onLayout={onTableLayout}>
            {folderBrowser}
        </GlassSurface>
    ) : folderBrowser) : (
        <GlassSurface surfaceGroup="card" nested finishRole="card" testID={`${testID}-file`} style={[sheetStyle, styles.fileSheet]}>
            {strip}
            {/* The reader sits inside the Code page, under the Project's own header: it doesn't take the pane's controls into its band. */}
            <HeaderActionsScope scopeKey={null}>
                <WorkspaceFileDetailsView scopeId={props.paneScopeId} scope={props.scope} filePath={location.path} presentation="screen"
                    targetKind="project" workspaceRefId={props.fileLinkTarget?.kind === 'project' ? props.fileLinkTarget.workspaceRefId : undefined}
                    breadcrumbRoot={props.rootLabel} onOpenFolder={openFolder} />
            </HeaderActionsScope>
        </GlassSurface>
    );

    if (widget) {
        return (
            <CheckoutReachabilityScope scope={props.scope}>
            <View testID={testID} style={styles.fileColumn}>
                {reachabilityLine}
                {location.path ? (
                    <CodeBrowserBar
                        testID={`${testID}-bar`}
                        rootLabel={props.rootLabel}
                        path={location.path}
                        onNavigateFolder={openFolder}
                    />
                ) : null}
                {body}
                {location.kind === 'file' ? historyFreshness : null}
            </View>
            </CheckoutReachabilityScope>
        );
    }

    // Folder rows and README share the browser's recycler scroll. The location bar stays above
    // its bounded viewport; a file continues to hand scrolling to the existing reader.
    const fileMode = location.kind === 'file';
    const page = (
        // The Code column (lab `.pj-solo`) is the wide page column: a name, a commit subject and a time.
        <PageFrame column="wide" content="column" style={styles.fileColumn}>
            {/* A file names itself and its folders in its own header (P3 §3.2); the bar keeps only quick open. */}
            {fileMode ? <CodeBrowserBar
                testID={`${testID}-bar`}
                rootLabel={props.rootLabel}
                path={location.path}
                onNavigateFolder={openFolder}
                onQuickOpen={openQuickOpen}
                compact={phone}
                crumbs={false}
            /> : null}
            {fileMode ? reachabilityLine : null}
            {body}
            {fileMode ? historyFreshness : null}
        </PageFrame>
    );
    return <CheckoutReachabilityScope scope={props.scope}>{fileMode ? (
        <ScrollView testID={testID} style={styles.scroll} scrollEnabled={false}
            contentContainerStyle={[phone ? styles.contentPhone : styles.content, styles.fileContent]}>
            {page}
        </ScrollView>
    ) : (
        <View testID={testID} style={[styles.scroll, phone ? styles.contentPhone : styles.content]}>{page}</View>
    )}</CheckoutReachabilityScope>;
});

/** How many entries the Overview Code widget previews (lab p-overview HOME / HOMEp). */
const CODE_WIDGET_PREVIEW_ROWS = { wide: 8, phone: 5 } as const;

/** The share of a table row the commit subject and time take; the name keeps the first third. */
const CODE_HISTORY_COLUMNS_SHARE = 0.62;
/**
 * Below this table width the name's third would fall under the lab's 150 px name minimum
 * (`minmax(150px, 34%)`, lab p-code BROWSE): 150 / (1 − 0.62) ≈ 400, plus the row's own disclosure,
 * glyph and insets. Narrower tables stack their rows.
 */
const CODE_TABLE_COLUMNS_MIN_WIDTH_PX = 480;

const CODE_LISTING_SKELETON_WIDTHS = ['22%', '31%', '18%', '27%', '35%', '24%'] as const;

/** Rows standing in for a folder's first listing, at the table's own row height. */
function CodeListingSkeleton(props: Readonly<{ testID: string }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const heights = HAPPIER_TREE_ROW_METRICS.tableMinHeightPx;
    const minHeight = useHappierTouchPrimaryPointer(Platform.OS) ? heights.touch : heights.precise;
    return (
        <View testID={props.testID} aria-busy>
            {CODE_LISTING_SKELETON_WIDTHS.map((width) => (
                <View key={width} style={[styles.skeletonRow, { minHeight }]}>
                    <HappierSkeletonBlock width={16} height={16} radius={4} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                    <HappierSkeletonBlock width={width} height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                </View>
            ))}
        </View>
    );
}

/** The widget's last line (lab p-overview HOME): how much is here, how fresh, and the way into Code. */
function CodeWidgetFooter(props: Readonly<{
    testID: string;
    entryCount: number | null;
    current: CodeEntryHistoryState | null;
    onOpenInCode: (() => void) | null;
}>) {
    const { theme } = useUnistyles();
    const facts = [
        props.entryCount != null ? t('projects.code.entryCount', { count: props.entryCount }) : null,
        props.current?.kind === 'commit' ? t('projects.code.lastCommit', { time: formatScmHistoryTimestamp(props.current.commit.committedAt) }) : null,
    ].filter((fact): fact is string => fact !== null);
    return (
        <View testID={props.testID} style={styles.footer}>
            <Text numberOfLines={1} style={styles.footerFacts}>{facts.join(' · ')}</Text>
            {props.onOpenInCode ? (
                <HappierPressable
                    testID={`${props.testID}-open`}
                    accessibilityRole="link"
                    onPress={props.onOpenInCode}
                    style={(state) => [
                        styles.footerLink,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        state.pressed || state.hovered ? { backgroundColor: theme.colors.surface.pressed } : null,
                    ]}
                >
                    <Text style={styles.footerLinkLabel}>{t('projects.code.openInCode')}</Text>
                    <Icon name="caret-right" size={12} color={theme.colors.text.secondary} />
                </HappierPressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    skeletonRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
    },
    // The widget's last line sits inside the table's card: it takes the strip's inset so its facts
    // line up with the commit strip and the names above, not with the card's edge.
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 40,
        paddingLeft: 14,
        paddingRight: 8,
        borderTopWidth: StyleSheet.hairlineWidth || 1,
        borderTopColor: theme.colors.border.subtle,
    },
    footerFacts: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
    },
    footerLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    footerLinkLabel: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    scroll: {
        flex: 1,
    },
    // The page insets every Project tab takes (Overview's `wideColumn`): the sheets' inset and a section gap.
    content: {
        paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
        paddingTop: PAGE_LIST_METRICS.sectionGapPx,
        paddingBottom: PAGE_LIST_METRICS.pagePaddingBottomPx,
    },
    contentPhone: {
        paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
        paddingTop: PAGE_LIST_METRICS.sectionGapPx,
        paddingBottom: 120,
    },
    fileSheet: {
        flex: 1,
        minHeight: 0,
    },
    // Web fits short folders to their rows; native recyclers need the page's remaining viewport.
    tableSheet: {
        flexGrow: Platform.OS === 'web' ? 0 : 1,
        flexShrink: 1,
        minHeight: 0,
    },
    fileContent: {
        flexGrow: 1,
    },
    fileColumn: {
        flex: 1,
        minHeight: 0,
    },
    sheet: {
        borderRadius: GROUPED_SURFACE_RADIUS_PX,
        backgroundColor: theme.colors.edge.cardFill,
        overflow: 'hidden',
    },
    sheetPhone: {
        borderRadius: GROUPED_SURFACE_RADIUS_PX + 2,
    },
}));

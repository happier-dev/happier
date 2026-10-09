import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierColumn, HappierColumns, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import type { WorkspaceRepositoryDirectoryState } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatScmHistoryTimestamp } from '@/scm/history/historyPresentation';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceEntryHistory } from '@/hooks/workspaces/files/useWorkspaceEntryHistory';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { CodeBrowserBar } from './CodeBrowserBar';
import { CodeCommitStrip } from './CodeCommitStrip';
import { CodeEntryHistoryCells } from './CodeEntryHistoryCells';
import { CodeReadmeCard, findCodeReadmePath } from './CodeReadmeCard';
import { CODE_ENTRY_HISTORY_PENDING, type CodeEntryHistoryState } from './codeEntryHistoryPresentation';

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
    onOpenHistory?: ((location: WorkspaceCodeLocation) => void) | null;
    onEditFile?: ((path: string) => void) | null;
    fileHref?: (path: string) => string | null;
    history?: WorkspaceCodeEntryHistory | null;
    onOpenFilePinned?: (path: string) => void;
    selectedPath?: string | null;
    revealRequest?: Readonly<{ path: string }>;
    /** Code-page widgets, bound by the Project host to its accepted checkout and dashboard. */
    aside?: React.ReactNode;
    /** The visible rows changed: what the history adapter should demand next. */
    onVisibleEntriesChange?: ((paths: readonly string[]) => void) | null;
    /** The machine isn't answering: last-known rows stay under one freshness line. */
    offline?: Readonly<{ asOf: number | null; reason: string; onRetry?: () => void }> | null;
    /**
     * `page` (default): the Code page. `widget`: the Overview Code widget's body (lab p-overview HOME) —
     * the same strip and table in place, no Go to file or README (the README is its own widget), and a
     * footer line with the way into the full page. A file pressed in the widget is handed to
     * `onNavigate` for the host to open in Code.
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
    const demandKey = JSON.stringify([workspaceKey, location.kind, location.path]);
    const [entryData, setEntryData] = React.useState<Readonly<{ key: string; readmePath: string | null; count: number; loaded: boolean }> | null>(null);
    const readmePath = entryData?.key === demandKey ? entryData.readmePath : null;
    const entryCount = entryData?.key === demandKey ? entryData.count : null;
    const [visibleDemand, setVisibleDemand] = React.useState<Readonly<{ key: string; paths: readonly string[] }> | null>(null);
    const machine = useServerScopedMachine(props.scope.serverId, props.scope.machineId);
    const available = Boolean(machine && isMachineOnline(machine));
    const scm = useWorkspaceScmSnapshotController(available && props.history === undefined ? props.scope : null);
    const folder = location.kind === 'folder' ? location.path : location.path.slice(0, Math.max(0, location.path.lastIndexOf('/')));
    const demandedPaths = React.useMemo(() => [location.path, ...(location.kind === 'folder' && visibleDemand?.key === demandKey ? visibleDemand.paths : [])],
        [location.path, location.kind, visibleDemand, demandKey]);
    const [historyReload, setHistoryReload] = React.useState(0);
    const facts = useWorkspaceEntryHistory({ scope: props.scope, folder, paths: demandedPaths, headOid: scm.snapshot?.branch.headOid,
        repoRootPath: scm.snapshot?.repo.rootPath,
        enabled: props.history === undefined && available, reloadToken: historyReload });
    const readEntry = React.useCallback((path: string): CodeEntryHistoryState => {
        const entry = facts.entries.get(path);
        if (entry) return entry;
        if (facts.status === 'unavailable' || !available) return { kind: 'unavailable', reason: facts.reason };
        return CODE_ENTRY_HISTORY_PENDING;
    }, [facts, available]);
    const history = React.useMemo<WorkspaceCodeEntryHistory | null>(() => props.history !== undefined ? props.history : {
        current: readEntry(location.path), entry: readEntry,
        revision: JSON.stringify([facts.status, facts.stale, facts.headOid, [...facts.entries]]),
        // Not a Git checkout says so with where it is (lab p-code STATES 2: "No Git history here · ~/scratch").
        unavailableLabel: scm.snapshot?.repo.isRepo === false
            ? t('projects.code.noGitHistory', { path: formatPathRelativeToHome(props.scope.rootPath, machine?.metadata?.homeDir) })
            : facts.reason === 'SCM_SOURCE_CHANGED' ? t('projects.code.historyChanged') : t('projects.code.historyUnavailable'),
    }, [props.history, readEntry, location.path, facts, scm.snapshot?.repo.isRepo, props.scope.rootPath, machine?.metadata?.homeDir]);
    const refreshHistory = React.useCallback(() => { setHistoryReload(value => value + 1); if (available) void scm.refresh(); }, [available, scm.refresh]);

    const openFolder = React.useCallback((path: string) => onNavigate({ path, kind: 'folder' }), [onNavigate]);
    const openFile = React.useCallback((path: string) => onNavigate({ path, kind: 'file' }), [onNavigate]);
    const onVisibleEntriesChange = props.onVisibleEntriesChange;
    const onNodesChange = React.useCallback((nodes: readonly LazyDirectoryTreeNode[], directory: WorkspaceRepositoryDirectoryState) => {
        const entries = nodes.filter((node) => node.depth === 0 && (node.type === 'file' || node.type === 'directory'));
        const readmePath = findCodeReadmePath(entries);
        const loaded = directory.loaded && !directory.loading && !directory.error;
        setEntryData(previous => previous?.key === demandKey && previous.readmePath === readmePath && previous.count === entries.length && previous.loaded === loaded ? previous : { key: demandKey, readmePath, count: entries.length, loaded });
        const paths = nodes.filter((node) => node.type === 'file' || node.type === 'directory').map((node) => node.path);
        setVisibleDemand(previous => previous?.key === demandKey && JSON.stringify(previous.paths) === JSON.stringify(paths) ? previous : { key: demandKey, paths });
        onVisibleEntriesChange?.(paths);
    }, [onVisibleEntriesChange, demandKey]);

    // Read through a ref so the row renderers stay one identity while answers land; `revision` (via
    // the browser's extraData) is what redraws the mounted rows.
    const historyRef = React.useRef(history);
    historyRef.current = history;
    const historyRevision = history ? String(history.revision) : null;
    // Not a Git checkout (or history otherwise unknowable here): the table keeps the names and drops
    // the commit columns; the strip says why once (lab p-code STATES 2).
    const historyColumns = history != null && history.current.kind !== 'unavailable';
    const renderRowMetadata = React.useCallback((node: LazyDirectoryTreeNode) => {
        const current = historyRef.current;
        if (!current || (node.type !== 'file' && node.type !== 'directory')) return null;
        return <CodeEntryHistoryCells testID={`${testID}-history-${node.path}`} state={current.entry(node.path)} layout={phone ? 'time' : 'columns'} />;
        // `historyRevision` re-mints the renderer so the browser's row extraData changes with each answer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyRevision, phone, testID]);
    const renderRowSubtitle = React.useCallback((node: LazyDirectoryTreeNode) => {
        const current = historyRef.current;
        if (!phone || !current || (node.type !== 'file' && node.type !== 'directory')) return null;
        return <CodeEntryHistoryCells state={current.entry(node.path)} layout="subject" />;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [historyRevision, phone]);
    const folderPage = React.useMemo(() => (location.kind === 'folder' ? {
        path: location.path,
        onOpenFolder: openFolder,
        renderRowMetadata: historyColumns ? renderRowMetadata : null,
        renderRowSubtitle: historyColumns ? renderRowSubtitle : null,
        onNodesChange,
    } : null), [historyColumns, location.kind, location.path, onNodesChange, openFolder, renderRowMetadata, renderRowSubtitle]);

    const strip = history ? (
        <CodeCommitStrip
            testID={`${testID}-strip`}
            state={history.current ?? CODE_ENTRY_HISTORY_PENDING}
            unavailableLabel={history.unavailableLabel}
            onOpenHistory={props.onOpenHistory && history.current.kind === 'commit' ? () => props.onOpenHistory?.(location) : null}
        />
    ) : null;

    const sheetStyle = [styles.sheet, resolveThemeHairlineBorderStyle(theme.colors.border.surface), phone ? styles.sheetPhone : null];
    // An unborn repository with nothing in it yet: the page invites the first commit instead of an empty table.
    const emptyRepository = available && location.kind === 'folder' && location.path === '' && entryData?.key === demandKey && entryData.loaded && entryCount === 0 && history?.current.kind === 'none';
    const body = emptyRepository ? (
        <View testID={`${testID}-empty-repository`} style={sheetStyle}>
            <SurfaceStateCard
                kind="empty"
                iconName="code"
                title={t('projects.code.emptyRepositoryTitle', { name: props.rootLabel })}
                reason={t('projects.code.emptyRepositoryBody')}
                action={props.onStartSession ? { label: t('projects.code.startSession'), onPress: props.onStartSession } : undefined}
            />
        </View>
    ) : location.kind === 'folder' ? (
        <>
            <View testID={`${testID}-table`} style={sheetStyle}>
                {strip}
                <WorkspaceRepositoryTreeBrowserView
                    scope={props.scope}
                    folderPage={folderPage}
                    onOpenFile={openFile}
                    onOpenFilePinned={props.onOpenFilePinned}
                    selectedPath={props.selectedPath}
                    revealRequest={props.revealRequest}
                    fileHref={props.fileHref}
                    showSearchBar={false}
                    // Code is the repository as committed pages (lab p-code): change marks belong to Changes.
                    scmSnapshot={null}
                />
            </View>
            {widget ? (
                <CodeWidgetFooter
                    testID={`${testID}-footer`}
                    entryCount={entryCount}
                    current={history?.current ?? null}
                    onOpenInCode={props.onOpenInCode ? () => props.onOpenInCode?.(location) : null}
                />
            ) : readmePath ? (
                <CodeReadmeCard testID={`${testID}-readme`} scope={props.scope} path={readmePath} onEdit={props.onEditFile} />
            ) : null}
        </>
    ) : (
        <View testID={`${testID}-file`} style={[sheetStyle, styles.fileSheet]}>
            {strip}
            <WorkspaceFileDetailsView scopeId={props.paneScopeId} scope={props.scope} filePath={location.path} presentation="screen" />
        </View>
    );

    const historyFreshness = props.history === undefined && (facts.stale || !available) ? <SurfaceFreshnessLine
        testID={`${testID}-history-stale`} asOf={null}
        reason={!available ? t('projects.code.offline') : t('projects.code.historyChanged')}
        action={{ label: t('common.retry'), onPress: refreshHistory }} /> : null;
    if (widget) {
        return (
            <View testID={testID}>
                {location.path ? (
                    <CodeBrowserBar
                        testID={`${testID}-bar`}
                        scope={props.scope}
                        rootLabel={props.rootLabel}
                        path={location.path}
                        onNavigateFolder={openFolder}
                        onOpenFile={openFile}
                        fileHref={props.fileHref}
                        goToFile={false}
                    />
                ) : null}
                {body}
                {historyFreshness}
            </View>
        );
    }

    // A folder page scrolls as one page (table, then README); a file page hands scrolling to the file
    // reader, whose own list must have a bounded height, so it fills the page instead of a scroll view.
    const fileMode = location.kind === 'file';
    return (
        <ScrollView
            testID={testID}
            style={styles.scroll}
            scrollEnabled={!fileMode}
            contentContainerStyle={[phone ? styles.contentPhone : styles.content, fileMode ? styles.fileContent : null]}
        >
            <ConstrainedScreenContent style={fileMode ? [styles.column, styles.fileColumn] : styles.column}>
                {phone ? null : (
                    <CodeBrowserBar
                        testID={`${testID}-bar`}
                        scope={props.scope}
                        rootLabel={props.rootLabel}
                        path={location.path}
                        onNavigateFolder={openFolder}
                        onOpenFile={openFile}
                        fileHref={props.fileHref}
                    />
                )}
                {props.offline ? (
                    <SurfaceFreshnessLine
                        testID={`${testID}-offline`}
                        asOf={props.offline.asOf}
                        reason={props.offline.reason}
                        action={props.offline.onRetry ? { label: t('common.retry'), onPress: props.offline.onRetry } : undefined}
                    />
                ) : null}
                {!fileMode && props.aside ? <HappierColumns columns={phone ? 1 : 2} paddingHorizontal={0} paddingVertical={0}
                    testID={`${testID}-columns`}>
                    {phone ? <HappierColumn>{props.aside}</HappierColumn> : null}
                    <HappierColumn>{body}</HappierColumn>
                    {!phone ? <HappierColumn>{props.aside}</HappierColumn> : null}
                </HappierColumns> : body}
                {historyFreshness}
            </ConstrainedScreenContent>
        </ScrollView>
    );
});

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
                    hitSlop={8}
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
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginTop: 10,
        minHeight: 24,
    },
    footerFacts: {
        ...Typography.rowMeta(),
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
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    scroll: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 32,
        paddingTop: 22,
        paddingBottom: 40,
    },
    contentPhone: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 120,
    },
    fileSheet: {
        flex: 1,
        minHeight: 0,
    },
    fileContent: {
        flexGrow: 1,
    },
    fileColumn: {
        flex: 1,
        minHeight: 0,
    },
    column: {
        // The Code column (lab `.pj-solo`): wide enough for a name, a commit subject and a time.
        maxWidth: 944,
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

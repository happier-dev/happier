import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeList } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { ChangedFilesLayoutSwitch, useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { indexPathsByFileName } from '@/components/ui/path/InlineRepoPathLabel';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { DiffFilesListViewProps } from '@/components/ui/code/diff/DiffFilesListView';
import { HAPPIER_TREE_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { SCM_COMPARISON_RAIL_INSET_PX, ScmComparisonRailCaption, ScmComparisonRailKeys } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { projectChangedFilesAsScmSnapshot } from '@/scm/scmStatusFiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { resolveScmChangeCompactRowHeight, ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { ChangedFilesReviewFindCount } from './ChangedFilesReviewFind';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';


/**
 * Review's file list, first (details lab 2, R1): every changed file on one row — its status, where
 * it lives, its comments, how much changed and whether it goes in the next commit. A row jumps to
 * that file in the stream below. Every file stays listed at any size, and only the rows on screen are
 * drawn: the rail through its own virtualized list, the stream's rows as leading rows of the review's
 * own list (`useChangedFilesReviewIndexLeadingRows`), so the stream keeps one scroll.
 */
type ChangedFilesReviewIndexProps = Readonly<{
    files: readonly ScmFileStatus[];
    findModel?: ChangedFilesReviewFindModel;
    activePath: string | null;
    commentCountByPath: ReadonlyMap<string, number>;
    onFocusPath: (path: string) => void;
    /** The shared active-review-file scope, so the row Review is on stays highlighted. */
    activeReviewFileKey?: string | null;
    /** The commit checkbox for a file (the Review owner's commit selection control). */
    renderCommitToggle?: ((file: ScmFileStatus) => React.ReactNode) | null;
    /** Beside a file's name (the comparison's Explain: the stops that explain it). */
    renderRowAccessory?: ((path: string) => React.ReactNode) | null;
    onLayout?: (event: LayoutChangeEvent) => void;
    /**
     * `stream` (default) and `comparisonStream` draw the caption here and the rows as the review list's
     * leading rows (`useChangedFilesReviewIndexLeadingRows`); a tree draws in place.
     * `stream` (default): the list heads the review stream. `rail`: the comparison view's left rail
     * (Walkthrough lab WT8), its own scroll beside the stream, with the shared list | tree switch.
     * `comparisonStream`: the same list heading a narrow comparison stream; it follows the shared
     * list | tree preference, whose switch the comparison header carries on narrow widths.
     */
    placement?: 'stream' | 'rail' | 'comparisonStream';
    /** Where the files live (the tree's identity); only the tree reads it, and it reads no listing. */
    rootPath?: string | null;
}>;

type ChangedFilesReviewIndexRowContext = Readonly<{
    rail: boolean;
    pathsByFileName: ReadonlyMap<string, readonly string[]>;
    findModel?: ChangedFilesReviewFindModel;
    activePath: string | null;
    commentCountByPath: ReadonlyMap<string, number>;
    onFocusPath: (path: string) => void;
    activeReviewFileKey: string | null;
    renderCommitToggle: ((file: ScmFileStatus) => React.ReactNode) | null;
    renderRowAccessory: ((path: string) => React.ReactNode) | null;
}>;

function useIndexRowContext(props: ChangedFilesReviewIndexProps, rail: boolean): ChangedFilesReviewIndexRowContext {
    const pathsByFileName = React.useMemo(() => indexPathsByFileName(props.files), [props.files]);
    const activeReviewFileKey = props.activeReviewFileKey ?? null;
    const renderCommitToggle = props.renderCommitToggle ?? null;
    const renderRowAccessory = props.renderRowAccessory ?? null;
    return React.useMemo(() => ({
        rail, pathsByFileName, findModel: props.findModel, activePath: props.activePath,
        commentCountByPath: props.commentCountByPath, onFocusPath: props.onFocusPath, activeReviewFileKey,
        renderCommitToggle, renderRowAccessory,
    }), [rail, pathsByFileName, props.findModel, props.activePath, props.commentCountByPath, props.onFocusPath,
        activeReviewFileKey, renderCommitToggle, renderRowAccessory]);
}

/** One file of the index: its status, where it lives, its comments, how much changed, its commit toggle. */
const ChangedFilesReviewIndexRow = React.memo(function ChangedFilesReviewIndexRow(props: Readonly<{
    file: ScmFileStatus;
    context: ChangedFilesReviewIndexRowContext;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { file, context } = props;
    const comments = context.commentCountByPath.get(file.fullPath) ?? 0;
    return (
        <ScmChangeRow
            theme={theme}
            file={file}
            layout="compact"
            statusTone="neutral"
            tag={context.rail ? resolveScmChangePathTag(file.fullPath) : null}
            siblingPaths={context.pathsByFileName.get(file.fileName)}
            highlighted={context.activePath === file.fullPath}
            activeReviewFileKey={context.activeReviewFileKey}
            onPress={() => context.onFocusPath(file.fullPath)}
            leadingElement={context.renderCommitToggle ? context.renderCommitToggle(file) : null}
            pathAccessory={context.renderRowAccessory?.(file.fullPath) ?? null}
            trailingElement={<View style={styles.trailing}>
                <ChangedFilesReviewFindCount model={context.findModel} path={file.fullPath} />
                {comments > 0 ? (
                    <View style={styles.comments} accessibilityLabel={t('detailsSurface.review.comments', { count: comments })}>
                        <Icon name="chat-circle" size={12} color={theme.colors.state.active.foreground} />
                        <Text style={[styles.count, { color: theme.colors.state.active.foreground }]}>{String(comments)}</Text>
                    </View>
                ) : null}
            </View>}
        />
    );
});

/**
 * The stream's index rows, for the review's own list to draw before the files (`DiffFilesListView`
 * `leadingRows`): one scroll, and only the rows on screen mount. `leadingRows` is null when the index is
 * not drawn in the stream as a list (the rail, the phone picker, or the tree the person chose). The rows
 * read their files and handlers from `rows`, provided around the list with `ChangedFilesReviewIndexRowsScope`,
 * so a changed handler reaches the mounted index rows without redrawing the list's diffs.
 */
export function useChangedFilesReviewIndexLeadingRows(props: ChangedFilesReviewIndexProps & Readonly<{
    enabled: boolean;
    onViewableChange?: (viewable: boolean) => void;
}>): Readonly<{ leadingRows: DiffFilesListViewProps['leadingRows']; rows: ChangedFilesReviewIndexRowsValue | null }> {
    const display = useGitDisplaySettings();
    const { theme } = useUnistyles();
    const rail = props.placement === 'comparisonStream';
    const listed = props.enabled && props.placement !== 'rail' && !(rail && display.changesLayout === 'tree');
    const files = listed ? props.files : NO_FILES;
    const context = useIndexRowContext({ ...props, files }, rail);
    const keys = React.useMemo(() => files.map((file) => file.fullPath), [files]);
    const onViewableChange = props.onViewableChange;
    // Each row draws at the compact row height; the last also closes the index (its inset and hairline).
    const lastRowExtra = theme.space.s10 + StyleSheet.hairlineWidth;
    const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
    const estimatedSize = React.useCallback((index: number) => (
        resolveScmChangeCompactRowHeight(touchPrimaryPointer) + (index === files.length - 1 ? lastRowExtra : 0)
    ), [files.length, lastRowExtra, touchPrimaryPointer]);
    const leadingRows = React.useMemo(() => (listed ? { keys, render: renderLeadingIndexRow, estimatedSize, onViewableChange } : null),
        [estimatedSize, keys, listed, onViewableChange]);
    const rows = React.useMemo(() => (listed ? { files, context } : null), [context, files, listed]);
    return { leadingRows, rows };
}

type ChangedFilesReviewIndexRowsValue = Readonly<{ files: readonly ScmFileStatus[]; context: ChangedFilesReviewIndexRowContext }>;
const IndexRowsContext = React.createContext<ChangedFilesReviewIndexRowsValue | null>(null);

/** Provides the stream index rows' files and handlers to the leading rows drawn inside the list. */
export function ChangedFilesReviewIndexRowsScope(props: React.PropsWithChildren<{ rows: ChangedFilesReviewIndexRowsValue | null }>) {
    return <IndexRowsContext.Provider value={props.rows}>{props.children}</IndexRowsContext.Provider>;
}

function LeadingIndexRow(props: Readonly<{ index: number }>) {
    const rows = React.useContext(IndexRowsContext);
    const file = rows?.files[props.index];
    if (!rows || !file) return null;
    return (
        <View style={[stylesheet.indexRow, props.index === rows.files.length - 1 ? stylesheet.indexRowLast : null]}>
            <ChangedFilesReviewIndexRow file={file} context={rows.context} />
        </View>
    );
}
const renderLeadingIndexRow = (index: number) => <LeadingIndexRow index={index} />;

const NO_FILES: readonly ScmFileStatus[] = [];

export const ChangedFilesReviewIndex = React.memo(function ChangedFilesReviewIndex(props: ChangedFilesReviewIndexProps) {
    const styles = stylesheet;
    const rail = props.placement === 'rail' || props.placement === 'comparisonStream';
    if (!rail) {
        return (
            <View testID="scm-review-index" style={styles.indexHead} onLayout={props.onLayout}>
                <View style={styles.caption}>
                    <Text style={styles.captionTitle}>{t('detailsSurface.review.changedFiles')}</Text>
                    <Text style={styles.captionCount}>{String(props.files.length)}</Text>
                    <View style={styles.grow} />
                    {props.renderCommitToggle ? <Text style={styles.captionCount}>{t('detailsSurface.review.commitColumn')}</Text> : null}
                </View>
            </View>
        );
    }
    return (
        <ChangedFilesReviewRail
            index={props}
            inline={props.placement === 'comparisonStream'}
        />
    );
});

/** The rail's list rows, through the canonical virtualized list: only the rows on screen mount. */
function ChangedFilesReviewRailRows(props: Readonly<{ index: ChangedFilesReviewIndexProps }>) {
    const context = useIndexRowContext(props.index, true);
    const renderItem = React.useCallback(({ item }: Readonly<{ item: ScmFileStatus }>) => (
        <ChangedFilesReviewIndexRow file={item} context={context} />
    ), [context]);
    return (
        <VirtualizedList<ScmFileStatus>
            testID="scm-review-index-rows"
            data={props.index.files}
            keyExtractor={railRowKey}
            renderItem={renderItem}
            extraData={context}
            style={stylesheet.railScroll}
            contentContainerStyle={stylesheet.railRows}
            estimatedItemSize={HAPPIER_TREE_ROW_METRICS.minHeightPx.precise}
        />
    );
}
const railRowKey = (file: ScmFileStatus) => file.fullPath;

/** The rail reads the list | tree preference only where the switch is drawn. */
const ChangedFilesReviewRail = React.memo(function ChangedFilesReviewRail(props: Readonly<{
    index: ChangedFilesReviewIndexProps;
    /** In the stream (narrow): rows in place, no scroll of its own, no switch in the caption. */
    inline: boolean;
}>) {
    const styles = stylesheet;
    const display = useGitDisplaySettings();
    const index = props.index;
    const tree = display.changesLayout === 'tree' ? (
        <ChangedFilesReviewRailTree
            files={index.files}
            findModel={index.findModel}
            rootPath={index.rootPath ?? null}
            activeReviewFileKey={index.activeReviewFileKey ?? null}
            activePath={index.activePath}
            onFocusPath={index.onFocusPath}
            inline={props.inline}
        />
    ) : null;
    if (props.inline) {
        // A list's rows are the stream's leading rows (`useChangedFilesReviewIndexLeadingRows`); a tree sits here.
        return (
            <View testID="scm-review-index" style={tree ? styles.index : styles.indexHead} onLayout={index.onLayout}>
                <View style={styles.caption}>
                    <Text style={styles.captionTitle}>{t('detailsSurface.review.changedFiles')}</Text>
                    <Text style={styles.captionCount}>{String(index.files.length)}</Text>
                </View>
                {tree}
            </View>
        );
    }
    return (
        <View testID="scm-review-index" style={styles.rail}>
            <ScmComparisonRailCaption title={t('detailsSurface.review.changedFiles')} count={String(index.files.length)} countPlacement="leading"
                trailing={<ChangedFilesLayoutSwitch testIDPrefix="scm-review-index-layout" />} />
            {tree ?? <ChangedFilesReviewRailRows index={index} />}
            {Platform.OS === 'web' ? (
                // The Review commands as bound here (no hint when single-key shortcuts are off).
                <ScmComparisonRailKeys testID="scm-review-index-keys" keys={[
                    { commands: ['review.file.next', 'review.file.previous'], label: t('scmComparison.keys.nextFile') },
                    { commands: ['review.change.next', 'review.change.previous'], label: t('scmComparison.keys.nextChange') },
                ]} />
            ) : null}
        </View>
    );
});

const NO_EXPANDED_PATHS: readonly string[] = [];
const noop = () => {};

const ChangedFilesReviewRailTree = React.memo(function ChangedFilesReviewRailTree(props: Readonly<{
    files: readonly ScmFileStatus[];
    findModel?: ChangedFilesReviewFindModel;
    rootPath: string | null;
    activeReviewFileKey: string | null;
    activePath: string | null;
    onFocusPath: (path: string) => void;
    inline?: boolean;
}>) {
    const { theme } = useUnistyles();
    const scopedActivePath = useActiveReviewFilePath(props.activeReviewFileKey);
    const activePath = props.activeReviewFileKey ? scopedActivePath : props.activePath;
    const snapshot = React.useMemo(
        () => projectChangedFilesAsScmSnapshot(props.files, { projectKey: `review:${props.rootPath ?? ''}`, rootPath: props.rootPath }),
        [props.files, props.rootPath],
    );
    const scope = React.useMemo(() => ({ serverId: '', machineId: '', rootPath: props.rootPath ?? '' }), [props.rootPath]);
    const renderFindCount = React.useCallback((node: Parameters<NonNullable<React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowMetadata']>>[0]) => (
        node.type === 'file' ? <ChangedFilesReviewFindCount model={props.findModel} path={node.path} /> : null
    ), [props.findModel]);
    return (
        <View style={props.inline ? null : stylesheet.railScroll}>
            <WorkspaceRepositoryTreeList
                presentation={props.inline ? 'inline' : 'scroll'}
                theme={theme}
                scope={scope}
                scmSnapshot={snapshot}
                changedOnly
                rowStyle="changes"
                directoryListing={false}
                expandedPaths={NO_EXPANDED_PATHS}
                onExpandedPathsChange={noop}
                selectedPath={activePath}
                renderRowMetadata={renderFindCount}
                onOpenFile={props.onFocusPath}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    index: {
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s10,
        paddingHorizontal: theme.space.s8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    // The same index when its rows are the list's leading rows: the caption here, the rows and the
    // closing inset and hairline on the rows themselves, so it reads exactly as one block.
    indexHead: {
        paddingTop: theme.space.s6,
        paddingHorizontal: theme.space.s8,
    },
    indexRow: {
        paddingHorizontal: theme.space.s8,
    },
    indexRowLast: {
        paddingBottom: theme.space.s10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    caption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s4,
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s8,
    },
    captionTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    captionCount: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    grow: {
        flex: 1,
    },
    rail: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: SCM_COMPARISON_RAIL_INSET_PX,
        paddingTop: theme.space.s12,
    },
    railScroll: {
        flex: 1,
        minHeight: 0,
    },
    railRows: {
        paddingBottom: theme.space.s12,
    },
    comments: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    count: {
        ...Typography.variant('micro'),
        fontVariant: ['tabular-nums'],
    },
}));

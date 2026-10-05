import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeList } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { ChangedFilesLayoutSwitch, useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { projectChangedFilesAsScmSnapshot } from '@/scm/scmStatusFiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { ChangedFilesReviewFindCount } from './ChangedFilesReviewFind';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';


/**
 * Review's file list, first (details lab 2, R1): every changed file on one row — its status, where
 * it lives, its comments, how much changed and whether it goes in the next commit. A row jumps to
 * that file in the stream below. Drawn only when the change set is small enough to stream; a large
 * one keeps the one-file-at-a-time list, so this never lays out thousands of rows.
 */
export const ChangedFilesReviewIndex = React.memo(function ChangedFilesReviewIndex(props: Readonly<{
    files: readonly ScmFileStatus[];
    findModel?: ChangedFilesReviewFindModel;
    activePath: string | null;
    commentCountByPath: ReadonlyMap<string, number>;
    onFocusPath: (path: string) => void;
    /** The shared active-review-file scope, so the row Review is on stays highlighted. */
    activeReviewFileKey?: string | null;
    /** The commit checkbox for a file (the Review owner's commit selection control). */
    renderCommitToggle?: ((file: ScmFileStatus) => React.ReactNode) | null;
    onLayout?: (event: LayoutChangeEvent) => void;
    /**
     * `stream` (default): the list heads the review stream. `rail`: the comparison view's left rail
     * (Walkthrough lab WT8), its own scroll beside the stream, with the shared list | tree switch.
     * `comparisonStream`: the same list heading a narrow comparison stream; it follows the shared
     * list | tree preference, whose switch the comparison header carries on narrow widths.
     */
    placement?: 'stream' | 'rail' | 'comparisonStream';
    /** Where the files live (the tree's identity); only the tree reads it, and it reads no listing. */
    rootPath?: string | null;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const siblingPaths = React.useMemo(() => props.files.map((file) => file.fullPath), [props.files]);
    const rail = props.placement === 'rail' || props.placement === 'comparisonStream';
    const rows = (
        <>
            {props.files.map((file) => {
                const comments = props.commentCountByPath.get(file.fullPath) ?? 0;
                return (
                    <ScmChangeRow
                        key={file.fullPath}
                        theme={theme}
                        file={file}
                        layout="compact"
                        statusTone="neutral"
                        tag={rail ? resolveScmChangePathTag(file.fullPath) : null}
                        siblingPaths={siblingPaths}
                        highlighted={props.activePath === file.fullPath}
                        activeReviewFileKey={props.activeReviewFileKey ?? null}
                        onPress={() => props.onFocusPath(file.fullPath)}
                        leadingElement={props.renderCommitToggle ? props.renderCommitToggle(file) : null}
                        trailingElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <ChangedFilesReviewFindCount model={props.findModel} path={file.fullPath} />
                            {comments > 0 ? (
                            <View style={styles.comments} accessibilityLabel={t('detailsSurface.review.comments', { count: comments })}>
                                <Icon name="chat-circle" size={12} color={theme.colors.state.active.foreground} />
                                <Text style={[styles.count, { color: theme.colors.state.active.foreground }]}>{String(comments)}</Text>
                            </View>
                        ) : null}</View>}
                    />
                );
            })}
        </>
    );
    if (!rail) {
        return (
            <View testID="scm-review-index" style={styles.index} onLayout={props.onLayout}>
                <View style={styles.caption}>
                    <Text style={styles.captionTitle}>{t('detailsSurface.review.changedFiles')}</Text>
                    <Text style={styles.captionCount}>{String(props.files.length)}</Text>
                    <View style={styles.grow} />
                    {props.renderCommitToggle ? <Text style={styles.captionCount}>{t('detailsSurface.review.commitColumn')}</Text> : null}
                </View>
                {rows}
            </View>
        );
    }
    return (
        <ChangedFilesReviewRail
            files={props.files}
            findModel={props.findModel}
            rows={rows}
            inline={props.placement === 'comparisonStream'}
            onLayout={props.onLayout}
            rootPath={props.rootPath ?? null}
            activeReviewFileKey={props.activeReviewFileKey ?? null}
            onFocusPath={props.onFocusPath}
        />
    );
});

/** The rail reads the list | tree preference only where the switch is drawn. */
const ChangedFilesReviewRail = React.memo(function ChangedFilesReviewRail(props: Readonly<{
    files: readonly ScmFileStatus[];
    findModel?: ChangedFilesReviewFindModel;
    rows: React.ReactNode;
    /** In the stream (narrow): rows in place, no scroll of its own, no switch in the caption. */
    inline: boolean;
    onLayout?: (event: LayoutChangeEvent) => void;
    rootPath: string | null;
    activeReviewFileKey: string | null;
    onFocusPath: (path: string) => void;
}>) {
    const styles = stylesheet;
    const display = useGitDisplaySettings();
    if (props.inline) {
        return (
            <View testID="scm-review-index" style={styles.index} onLayout={props.onLayout}>
                <View style={styles.caption}>
                    <Text style={styles.captionTitle}>{t('detailsSurface.review.changedFiles')}</Text>
                    <Text style={styles.captionCount}>{String(props.files.length)}</Text>
                </View>
                {display.changesLayout === 'tree' ? (
                    <ChangedFilesReviewRailTree
                        files={props.files}
                        findModel={props.findModel}
                        rootPath={props.rootPath}
                        activeReviewFileKey={props.activeReviewFileKey}
                        onFocusPath={props.onFocusPath}
                        inline
                    />
                ) : props.rows}
            </View>
        );
    }
    return (
        <View testID="scm-review-index" style={styles.rail}>
            <View style={styles.railCaption}>
                <Text style={styles.captionTitle}>{t('detailsSurface.review.changedFiles')}</Text>
                <Text style={styles.captionCount}>{String(props.files.length)}</Text>
                <View style={styles.grow} />
                <ChangedFilesLayoutSwitch testIDPrefix="scm-review-index-layout" />
            </View>
            {display.changesLayout === 'tree' ? (
                <ChangedFilesReviewRailTree
                    files={props.files}
                    findModel={props.findModel}
                    rootPath={props.rootPath}
                    activeReviewFileKey={props.activeReviewFileKey}
                    onFocusPath={props.onFocusPath}
                />
            ) : (
                <ScrollView style={styles.railScroll} contentContainerStyle={styles.railRows}>{props.rows}</ScrollView>
            )}
            {Platform.OS === 'web' ? (
                // The keys `ChangedFilesReviewKeyboardShortcuts` binds for this view (web only).
                <View testID="scm-review-index-keys" style={styles.railKeys}>
                    <View style={styles.railKey}><KeyHint label="J" /><KeyHint label="K" /><Text style={styles.captionCount}>{t('scmComparison.keys.nextFile')}</Text></View>
                    <View style={styles.railKey}><KeyHint label="N" /><Text style={styles.captionCount}>{t('scmComparison.keys.nextChange')}</Text></View>
                </View>
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
    onFocusPath: (path: string) => void;
    inline?: boolean;
}>) {
    const { theme } = useUnistyles();
    const activePath = useActiveReviewFilePath(props.activeReviewFileKey);
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
        paddingTop: 6,
        paddingBottom: 10,
        paddingHorizontal: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    caption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: 6,
        paddingBottom: 4,
        paddingLeft: 12,
        paddingRight: 8,
    },
    captionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    captionCount: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.tertiary,
    },
    grow: {
        flex: 1,
    },
    rail: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 8,
        paddingTop: 10,
    },
    railCaption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 4,
        paddingBottom: 6,
    },
    railScroll: {
        flex: 1,
        minHeight: 0,
    },
    railRows: {
        paddingBottom: 12,
    },
    railKeys: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 14,
        rowGap: 6,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    railKey: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    comments: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    count: {
        ...Typography.default(),
        fontSize: 11.5,
        fontVariant: ['tabular-nums'],
    },
}));

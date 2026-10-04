import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeList } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { ChangedFilesLayoutSwitch, useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { resolveChangedOnlyTreeInitiallyClosedPaths } from '@/components/workspaces/files/repositoryTree/buildChangedFilesOutlineTree';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { projectChangedFilesAsScmSnapshot, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { resolveTurnChangesCardDisplayText } from './turnChangesCardDisplayText';

import {
    TURN_CHANGES_PAGE_ROWS,
    nextTurnChangesVisibleCount,
} from './turnChangesCardModel';

export type TurnChangesCardWorkspace = Readonly<{
    serverId?: string | null;
    machineId?: string | null;
    rootPath?: string | null;
}>;

export type TurnChangesCardProps = Readonly<{
    /** Every file the turn changed, from the turn's own evidence (never the later working copy). */
    files: readonly ScmFileStatus[];
    /** Where those files live: the tree's identity. The card reads no folder listing. */
    workspace?: TurnChangesCardWorkspace | null;
    onOpenFile: (fullPath: string) => void;
    /** Opens this turn's comparison in Files. Absent: the action is not offered. */
    onOpenInFiles?: (() => void) | null;
    /** Opens this turn's walkthrough. Absent while no walkthrough destination exists. */
    onWalkThrough?: (() => void) | null;
    /** Starts open (a surface that is itself about this turn); the transcript card starts collapsed. */
    initiallyOpen?: boolean;
    testID?: string;
}>;

/**
 * A turn's changes at the end of the turn (Walkthrough lab WT9, variant R).
 *
 * One line while collapsed: the title ("Edited 4 files +65 −5") is the expand control and the two
 * actions close the same line. Opening it grows the list below a quiet toolbar; the actions never move,
 * so the button under the pointer is still the button. Narrow widths wrap the actions under the title.
 * List | tree is the one account preference shared with Git and Files (`scmChangedFilesLayout`).
 */
export const TurnChangesCard = React.memo(function TurnChangesCard(props: TurnChangesCardProps) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'turn-changes-card';
    const [open, setOpen] = React.useState(props.initiallyOpen === true);
    const displayText = React.useMemo(() => resolveTurnChangesCardDisplayText(props.files), [props.files]);
    const summary = displayText.summary;
    const titleLabel = displayText.title;
    const hasActions = Boolean(props.onWalkThrough || props.onOpenInFiles);

    const header = (state: Readonly<{ expanded: boolean; headerProps: Readonly<{ onPress: () => void }> }>) => (
        <View testID={`${testID}-header`} style={styles.header}>
            <Pressable
                testID={`${testID}-toggle`}
                onPress={state.headerProps.onPress}
                accessibilityRole="button"
                accessibilityState={{ expanded: state.expanded }}
                accessibilityLabel={titleLabel}
                style={styles.title}
            >
                <Icon name={state.expanded ? 'caret-down' : 'caret-right'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                <Text style={styles.titleText} numberOfLines={1}>{titleLabel}</Text>
                {summary.linesKnown ? <LineTotals added={displayText.added ?? ''} removed={displayText.removed ?? ''} /> : null}
            </Pressable>
            {hasActions ? (
                <View testID={`${testID}-actions`} style={styles.actions}>
                    {props.onWalkThrough ? (
                        <RoundButton
                            testID={`${testID}-walk`}
                            size="small"
                            display="secondary"
                            title={t('turnChanges.card.walkThrough')}
                            leading={<Icon name="path" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
                            onPress={props.onWalkThrough}
                        />
                    ) : null}
                    {props.onOpenInFiles ? (
                        <RoundButton
                            testID={`${testID}-open-files`}
                            size="small"
                            display="inverted"
                            title={t('turnChanges.card.openInFiles')}
                            textStyle={styles.quietActionText}
                            onPress={props.onOpenInFiles}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );

    return (
        <View testID={testID} accessibilityLabel={t('turnChanges.card.groupA11y')} style={styles.card}>
            <ExpandableItem testID={`${testID}-disclosure`} expanded={open} onExpandedChange={setOpen} header={header} showDivider={false}>
                <TurnChangesCardBody
                    testID={testID}
                    files={props.files}
                    workspace={props.workspace ?? null}
                    onOpenFile={props.onOpenFile}
                    countLabel={displayText.count}
                />
            </ExpandableItem>
        </View>
    );
});

function LineTotals(props: Readonly<{ added: string; removed: string }>) {
    return (
        <View style={styles.totals}>
            <Text style={styles.added}>{props.added}</Text>
            <Text style={styles.removed}>{props.removed}</Text>
        </View>
    );
}

const NO_FILES: readonly ScmFileStatus[] = [];

/** Mounted only while open, so a closed card in a long transcript builds no rows, tree or preference reads. */
const TurnChangesCardBody = React.memo(function TurnChangesCardBody(props: Readonly<{
    testID: string;
    files: readonly ScmFileStatus[];
    workspace: TurnChangesCardWorkspace | null;
    onOpenFile: (fullPath: string) => void;
    countLabel: string;
}>) {
    const display = useGitDisplaySettings();
    const pageRows = isTouchPrimaryPointer() ? TURN_CHANGES_PAGE_ROWS.touch : TURN_CHANGES_PAGE_ROWS.precise;
    const [visibleCount, setVisibleCount] = React.useState(() => nextTurnChangesVisibleCount({ visible: 0, total: props.files.length, pageRows }));
    const shownCount = Math.min(visibleCount, props.files.length);
    const showMore = React.useCallback(() => {
        setVisibleCount((current) => nextTurnChangesVisibleCount({ visible: current, total: props.files.length, pageRows }));
    }, [pageRows, props.files.length]);

    return (
        <View testID={`${props.testID}-body`} style={styles.body}>
            <View testID={`${props.testID}-toolbar`} style={styles.toolbar}>
                <Text style={styles.toolbarText}>{props.countLabel}</Text>
                <ChangedFilesLayoutSwitch testIDPrefix={`${props.testID}-layout`} />
            </View>
            {display.changesLayout === 'tree' ? (
                <TurnChangesTree files={props.files} workspace={props.workspace} pageRows={pageRows} onOpenFile={props.onOpenFile} />
            ) : (
                <TurnChangesList
                    testID={props.testID}
                    files={props.files.length > shownCount ? props.files.slice(0, shownCount) : props.files}
                    remaining={props.files.length - shownCount}
                    statsFiles={props.files}
                    onShowMore={showMore}
                    onOpenFile={props.onOpenFile}
                />
            )}
        </View>
    );
});

const TurnChangesList = React.memo(function TurnChangesList(props: Readonly<{
    testID: string;
    files: readonly ScmFileStatus[];
    remaining: number;
    /** Every file, so the counts column does not jump as pages arrive. */
    statsFiles: readonly ScmFileStatus[];
    onShowMore: () => void;
    onOpenFile: (fullPath: string) => void;
}>) {
    const { theme } = useUnistyles();
    const statsColumnWidth = React.useMemo(() => resolveScmChangeStatsColumnWidth(props.statsFiles), [props.statsFiles]);
    return (
        <View style={styles.rows}>
            {props.files.map((file) => (
                <ScmChangeRow
                    key={file.fullPath}
                    theme={theme}
                    file={file}
                    layout="compact"
                    density="compact"
                    statsColumnWidth={statsColumnWidth}
                    tag={resolveScmChangePathTag(file.fullPath)}
                    onPress={() => props.onOpenFile(file.fullPath)}
                />
            ))}
            {props.remaining > 0 ? (
                <Pressable
                    testID={`${props.testID}-more`}
                    accessibilityRole="button"
                    onPress={props.onShowMore}
                    style={styles.more}
                >
                    <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                    <Text style={styles.moreText}>{t('turnChanges.card.showMore', { count: props.remaining })}</Text>
                </Pressable>
            ) : null}
        </View>
    );
});

const TurnChangesTree = React.memo(function TurnChangesTree(props: Readonly<{
    files: readonly ScmFileStatus[];
    workspace: TurnChangesCardWorkspace | null;
    pageRows: number;
    onOpenFile: (fullPath: string) => void;
}>) {
    const { theme } = useUnistyles();
    const rootPath = props.workspace?.rootPath ?? null;
    const snapshot = React.useMemo(
        () => projectChangedFilesAsScmSnapshot(props.files.length > 0 ? props.files : NO_FILES, { projectKey: `turn:${rootPath ?? ''}`, rootPath }),
        [props.files, rootPath],
    );
    // A large turn opens as a page of folders; a small one opens whole.
    const initiallyClosed = React.useMemo(
        () => resolveChangedOnlyTreeInitiallyClosedPaths(props.files, props.pageRows),
        [props.files, props.pageRows],
    );
    const scope = React.useMemo(() => ({
        serverId: props.workspace?.serverId ?? '',
        machineId: props.workspace?.machineId ?? '',
        rootPath: rootPath ?? '',
    }), [props.workspace?.machineId, props.workspace?.serverId, rootPath]);
    return (
        <View style={styles.rows}>
            <WorkspaceRepositoryTreeList
                theme={theme}
                scope={scope}
                scmSnapshot={snapshot}
                changedOnly
                rowStyle="changes"
                directoryListing={false}
                presentation="inline"
                initialClosedChangedPaths={initiallyClosed}
                expandedPaths={NO_EXPANDED_PATHS}
                onExpandedPathsChange={noop}
                onOpenFile={props.onOpenFile}
            />
        </View>
    );
});

const NO_EXPANDED_PATHS: readonly string[] = [];
const noop = () => {};

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: theme.borderRadius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
        marginVertical: 4,
    },
    header: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 8,
        rowGap: 4,
        minHeight: 44,
        paddingLeft: 12,
        paddingRight: 8,
        paddingVertical: 6,
    },
    title: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 32,
    },
    titleText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        flexShrink: 1,
    },
    totals: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 5,
    },
    added: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        color: theme.colors.state.success.foreground,
        ...Typography.default(),
    },
    removed: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        color: theme.colors.state.danger.foreground,
        ...Typography.default(),
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    quietActionText: {
        color: theme.colors.text.secondary,
    },
    body: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 8,
        paddingTop: 6,
        paddingBottom: 2,
    },
    toolbarText: {
        fontSize: 12,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
    rows: {
        paddingHorizontal: 4,
        paddingBottom: 6,
    },
    more: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 32,
        paddingHorizontal: 12,
    },
    moreText: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

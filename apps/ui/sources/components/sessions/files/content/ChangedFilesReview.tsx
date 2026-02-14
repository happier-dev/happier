import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { formatFileSubtitle } from '@/components/sessions/files/filesUtils';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { ChangedFilesReviewOutline } from '@/components/sessions/files/content/review/ChangedFilesReviewOutline';
import { changedFilesReviewAnchorId } from '@/components/sessions/files/content/review/changedFilesReviewAnchorId';
import { useChangedFilesReviewCollapsedPaths } from '@/components/sessions/files/content/review/useChangedFilesReviewCollapsedPaths';
import { useChangedFilesReviewDiffLoading } from '@/components/sessions/files/content/review/useChangedFilesReviewDiffLoading';
import { ChangedFileIcon, ChangedFileStatusIcon } from '@/components/sessions/files/changedFiles/ChangedFileRowIcons';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';
import { useCodeLinesReviewComments } from '@/components/sessions/reviews/comments/useCodeLinesReviewComments';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

type ChangedFilesReviewProps = {
    theme: any;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    maxFiles: number;
    maxChangedLines: number;
    onFilePress: (file: ScmFileStatus) => void;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
};

function renderFileSubtitle(file: ScmFileStatus) {
    return formatFileSubtitle(file, t('files.projectRoot'));
}

function totalsChangedLines(snapshot: ScmWorkingSnapshot | null, area: ScmDiffArea): number {
    const totals = snapshot?.totals;
    if (!totals) return 0;
    if (area === 'included') return totals.includedAdded + totals.includedRemoved;
    if (area === 'pending') return totals.pendingAdded + totals.pendingRemoved;
    return totals.includedAdded + totals.includedRemoved + totals.pendingAdded + totals.pendingRemoved;
}

type DiffState = {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
};

function ChangedFilesReviewDiffBlock(props: {
    theme: any;
    sessionId: string;
    filePath: string;
    state: DiffState;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
}) {
    const { theme, sessionId, filePath, state } = props;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);

    if (state.status === 'loading' || state.status === 'idle') {
        return (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }
    if (state.status === 'error') {
        return (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {state.error ?? t('files.reviewUnableToLoadDiff')}
                </Text>
            </View>
        );
    }
    if (!state.diff) {
        return (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {t('files.noChanges')}
                </Text>
            </View>
        );
    }

    const lines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({ unifiedDiff: state.diff }), [state.diff]);
    const draftsForFile = React.useMemo(() => {
        if (!props.reviewCommentsEnabled) return [];
        return props.reviewCommentDrafts.filter((d) => d.filePath === filePath && d.source === 'diff');
    }, [filePath, props.reviewCommentDrafts, props.reviewCommentsEnabled]);

    const controls = useCodeLinesReviewComments({
        enabled: props.reviewCommentsEnabled,
        filePath,
        source: 'diff',
        lines,
        drafts: draftsForFile,
        onUpsertDraft: props.onUpsertReviewCommentDraft,
        onDeleteDraft: props.onDeleteReviewCommentDraft,
        onError: props.onReviewCommentError,
    });

    return (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <CodeLinesView
                lines={lines}
                onPressAddComment={controls?.onPressAddComment}
                isCommentActive={controls?.isCommentActive}
                renderAfterLine={controls?.renderAfterLine}
                virtualized={!props.reviewCommentsEnabled}
                syntaxHighlighting={syntaxHighlighting}
            />
        </View>
    );
}

export function ChangedFilesReview(props: ChangedFilesReviewProps) {
    const {
        theme,
        sessionId,
        snapshot,
        changedFilesViewMode,
        attributionReliability,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
        maxFiles,
        maxChangedLines,
        onFilePress,
    } = props;

    const isDarkTheme = theme.dark === true;
    const plugin = scmUiBackendRegistry.getPluginForSnapshot(snapshot);
    const diffConfig = plugin.diffModeConfig(snapshot);
    const reviewCommentsEnabled = props.reviewCommentsEnabled === true;
    const reviewCommentDrafts = props.reviewCommentDrafts ?? [];

    const [diffArea, setDiffArea] = React.useState<ScmDiffArea>(diffConfig.defaultMode);
    React.useEffect(() => {
        const available = new Set<ScmDiffArea>(diffConfig.availableModes);
        setDiffArea((prev) => (available.has(prev) ? prev : diffConfig.defaultMode));
    }, [diffConfig.availableModes, diffConfig.defaultMode]);

    const sections = React.useMemo(() => {
        if (changedFilesViewMode === 'repository') {
            return [
                {
                    key: 'repository',
                    title: t('files.repositoryChangedFiles', { count: allRepositoryChangedFiles.length }),
                    files: allRepositoryChangedFiles,
                },
            ] as const;
        }

        return [
            {
                key: 'session',
                title: t('files.sessionAttributedChanges', { count: sessionAttributedFiles.length }),
                files: sessionAttributedFiles.map((entry) => entry.file),
            },
            ...(repositoryOnlyFiles.length > 0
                ? ([
                    {
                        key: 'other',
                        title: t('files.otherRepositoryChanges', { count: repositoryOnlyFiles.length }),
                        files: repositoryOnlyFiles,
                    },
                ] as const)
                : ([] as const)),
        ] as const;
    }, [allRepositoryChangedFiles, changedFilesViewMode, repositoryOnlyFiles, sessionAttributedFiles]);

    const reviewFiles = React.useMemo(() => {
        const out: ScmFileStatus[] = [];
        const seen = new Set<string>();
        for (const section of sections) {
            for (const file of section.files) {
                if (!file?.fullPath) continue;
                if (seen.has(file.fullPath)) continue;
                seen.add(file.fullPath);
                out.push(file);
            }
        }
        return out;
    }, [sections]);

    const tooLarge = reviewFiles.length > maxFiles || totalsChangedLines(snapshot, diffArea) > maxChangedLines;
    const [selectedPath, setSelectedPath] = React.useState<string>(() => reviewFiles.at(0)?.fullPath ?? '');
    React.useEffect(() => {
        setSelectedPath((prev) => {
            if (!prev) return reviewFiles.at(0)?.fullPath ?? '';
            const stillPresent = reviewFiles.some((f) => f.fullPath === prev);
            return stillPresent ? prev : (reviewFiles.at(0)?.fullPath ?? '');
        });
    }, [reviewFiles]);

    const { isCollapsed, toggleCollapsed, expandPath } = useChangedFilesReviewCollapsedPaths({ reviewFiles });
    const { getDiffState } = useChangedFilesReviewDiffLoading({
        sessionId,
        isRepo: Boolean(snapshot?.repo.isRepo),
        reviewFiles,
        diffArea,
        tooLarge,
        selectedPath,
        normalizeError: plugin.errorNormalizer,
        fallbackError: t('files.reviewDiffRequestFailed'),
    });

    const { width: viewportWidth } = useWindowDimensions();
    const showOutline = Platform.OS === 'web' && viewportWidth >= 900 && reviewFiles.length > 0;

    const diffAreaSelector = diffConfig.availableModes.length > 1 ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
            {diffConfig.availableModes.map((mode) => (
                <Pressable
                    key={mode}
                    onPress={() => setDiffArea(mode)}
                    style={{
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: diffArea === mode ? theme.colors.surfaceHigh : theme.colors.surface,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {diffConfig.labels[mode]}
                    </Text>
                </Pressable>
            ))}
        </View>
    ) : null;

    const renderDiffBlock = (path: string) => {
        const state: DiffState = getDiffState(path);
        return (
            <ChangedFilesReviewDiffBlock
                theme={theme}
                sessionId={sessionId}
                filePath={path}
                state={state}
                reviewCommentsEnabled={reviewCommentsEnabled}
                reviewCommentDrafts={reviewCommentDrafts}
                onUpsertReviewCommentDraft={props.onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={props.onDeleteReviewCommentDraft}
                onReviewCommentError={props.onReviewCommentError}
            />
        );
    };

    const leftContent = (
        <>
            {diffAreaSelector}

            {tooLarge && reviewFiles.length > 0 && (
                <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.reviewLargeDiffOneAtATime')}
                    </Text>
                </View>
            )}

            {changedFilesViewMode === 'session' && (
                <View
                    style={{
                        backgroundColor: theme.colors.surfaceHigh,
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: theme.colors.divider,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {attributionReliability === 'high'
                            ? t('files.attributionReliabilityHigh')
                            : t('files.attributionReliabilityLimited')}
                    </Text>
                    {suppressedInferredCount > 0 && (
                        <Text style={{ marginTop: 2, fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('files.inferredSuppressed', { count: suppressedInferredCount })}
                        </Text>
                    )}
                </View>
            )}

            {sections.map((section) => {
                const files = section.files;
                if (files.length === 0) {
                    return null;
                }
                return (
                    <React.Fragment key={section.key}>
                        <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                            {section.title}
                        </ChangedFilesSectionHeader>
                        {files.map((file, index) => {
                            const isSelected = tooLarge && selectedPath === file.fullPath;
                            const collapsed = isCollapsed(file.fullPath);
                            const showDiff = (!tooLarge || isSelected) && !collapsed;

                            const openFileButton = (
                                <Pressable onPress={() => onFilePress(file)} style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
                                    <Octicons name="link-external" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            );

                            const collapseIndicator = (
                                <Octicons
                                    name={collapsed ? 'chevron-right' : 'chevron-down'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            );

                            const rightElement = (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                    {!tooLarge && (
                                        <ChangedFileStatusIcon file={file} theme={theme} isDarkTheme={isDarkTheme} />
                                    )}
                                    {tooLarge && !isSelected ? null : collapseIndicator}
                                    {openFileButton}
                                </View>
                            );

                            return (
                                <View
                                    key={`${section.key}-${file.fullPath}-${index}`}
                                    nativeID={changedFilesReviewAnchorId(file.fullPath)}
                                >
                                    <Item
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={<ChangedFileIcon file={file} />}
                                        rightElement={rightElement}
                                        showChevron={false}
                                        onPress={
                                            tooLarge
                                                ? () => {
                                                    if (!isSelected) {
                                                        setSelectedPath(file.fullPath);
                                                        expandPath(file.fullPath);
                                                        return;
                                                    }
                                                    toggleCollapsed(file.fullPath);
                                                }
                                                : () => toggleCollapsed(file.fullPath)
                                        }
                                        showDivider={index < files.length - 1}
                                        style={isSelected ? { backgroundColor: theme.colors.surfaceHigh } : undefined}
                                    />
                                    {showDiff && renderDiffBlock(file.fullPath)}
                                </View>
                            );
                        })}
                    </React.Fragment>
                    );
                })}
        </>
    );

    if (!showOutline) {
        return leftContent;
    }

    const jumpToPath = (path: string) => {
        if (typeof document === 'undefined') return;
        const elementId = changedFilesReviewAnchorId(path);
        const el = document.getElementById(elementId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, minWidth: 0 }}>{leftContent}</View>
            <View
                testID="scm-review-outline"
                style={{
                    width: 300,
                    marginTop: diffConfig.availableModes.length > 1 ? 0 : 8,
                    marginRight: 16,
                    marginLeft: 12,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 12,
                    backgroundColor: theme.colors.surface,
                    overflow: 'hidden',
                }}
            >
                <ChangedFilesReviewOutline
                    theme={theme}
                    files={reviewFiles}
                    selectedPath={tooLarge ? selectedPath : null}
                    onSelectFile={(file) => {
                        if (tooLarge) {
                            setSelectedPath(file.fullPath);
                            expandPath(file.fullPath);
                            return;
                        }
                        jumpToPath(file.fullPath);
                    }}
                />
            </View>
        </View>
    );
}

import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useCodeLinesReviewComments } from '@/components/sessions/reviews/comments/useCodeLinesReviewComments';
import { Typography } from '@/constants/Typography';
import type { ReviewCommentAnchor, ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { filterReviewCommentDraftsForFile } from '@/sync/domains/input/reviewComments/filterReviewCommentDrafts';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { resolveInlineCodeVirtualization } from '@/components/ui/code/diff/resolveInlineCodeVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { buildSelectedDiffLineKey } from '@/scm/scmPatchSelection';

type FileContentPanelProps = {
    theme: any;
    displayMode: 'file' | 'diff';
    sessionId: string;
    filePath: string;
    diffContent: string | null;
    fileContent: string | null;
    language: string | null;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    selectedLineKeys: Set<string>;
    lineSelectionEnabled: boolean;
    onToggleLine: (key: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    jumpToAnchor?: ReviewCommentAnchor | null;
    scrollTestID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
};

export function FileContentPanel({
    theme,
    displayMode,
    sessionId: _sessionId,
    filePath,
    diffContent,
    fileContent,
    language,
    syntaxHighlighting,
    selectedLineKeys,
    lineSelectionEnabled,
    onToggleLine,
    wrapLines,
    showLineNumbers,
    showPrefix,
    reviewCommentsEnabled,
    reviewCommentDrafts,
    onUpsertReviewCommentDraft,
    onDeleteReviewCommentDraft,
    onReviewCommentError,
    jumpToAnchor,
    scrollTestID,
    onLayout,
    onContentSizeChange,
    onScroll,
}: FileContentPanelProps) {
    const intraLineDiff = useIntraLineWordDiffConfig();
    const effectiveWrapLines = wrapLines ?? true;
    const effectiveShowLineNumbers = showLineNumbers ?? true;
    const effectiveShowPrefix = showPrefix ?? effectiveShowLineNumbers;

    const needsDiffCodeLines = displayMode === 'diff'
        && typeof diffContent === 'string'
        && (lineSelectionEnabled === true || reviewCommentsEnabled === true || jumpToAnchor?.kind === 'diffLine');

    const lines = React.useMemo(() => {
        if (displayMode === 'diff' && typeof diffContent === 'string') {
            if (!needsDiffCodeLines) return [];
            return buildCodeLinesFromUnifiedDiff({
                unifiedDiff: diffContent,
                hideFilePrelude: true,
                intraLineDiff,
            });
        }
        if (displayMode === 'file' && typeof fileContent === 'string') {
            return buildCodeLinesFromFile({ text: fileContent });
        }
        return [];
    }, [diffContent, displayMode, fileContent, intraLineDiff, needsDiffCodeLines]);

    const commentSource: ReviewCommentSource = displayMode === 'diff' ? 'diff' : 'file';
    const draftsForThisView = React.useMemo(() => {
        return filterReviewCommentDraftsForFile({
            enabled: reviewCommentsEnabled === true,
            filePath,
            source: commentSource,
            drafts: reviewCommentDrafts ?? [],
        });
    }, [commentSource, filePath, reviewCommentDrafts, reviewCommentsEnabled]);

    const reviewCommentControls = useCodeLinesReviewComments({
        enabled: Boolean(reviewCommentsEnabled),
        filePath,
        source: commentSource,
        lines,
        drafts: draftsForThisView,
        contextRadius: 2,
        onUpsertDraft: onUpsertReviewCommentDraft,
        onDeleteDraft: onDeleteReviewCommentDraft,
        onError: onReviewCommentError,
    });

    const selectedLineIds = React.useMemo(() => {
        if (displayMode !== 'diff') return undefined;
        if (!lineSelectionEnabled) return undefined;
        if (!selectedLineKeys || selectedLineKeys.size === 0) return undefined;
        const ids = new Set<string>();
        for (const line of lines) {
            if (!line.selectable) continue;
            const key = line.renderPrefixText === '-'
                ? (typeof line.oldLine === 'number' ? buildSelectedDiffLineKey('deletions', line.oldLine) : null)
                : line.renderPrefixText === '+'
                    ? (typeof line.newLine === 'number' ? buildSelectedDiffLineKey('additions', line.newLine) : null)
                    : null;
            if (!key) continue;
            if (selectedLineKeys.has(key)) ids.add(line.id);
        }
        return ids;
    }, [displayMode, lineSelectionEnabled, lines, selectedLineKeys]);

    const jumpToLineId = React.useMemo(() => {
        const anchor = jumpToAnchor ?? null;
        if (!anchor) return null;

        if (displayMode === 'file' && anchor.kind === 'fileLine') {
            const target = lines.find((l) => !l.renderIsHeaderLine && l.newLine === anchor.startLine);
            return target?.id ?? null;
        }

        if (displayMode === 'diff' && anchor.kind === 'diffLine') {
            const target = lines.find((l) => !l.renderIsHeaderLine && (l.sourceIndex + 1) === anchor.startLine);
            return target?.id ?? null;
        }

        return null;
    }, [displayMode, jumpToAnchor, lines]);

    const handlePressLine = React.useCallback((line: any) => {
        if (!lineSelectionEnabled) return;
        if (!onToggleLine) return;
        if (!line?.selectable) return;
        const key = line.renderPrefixText === '-'
            ? (typeof line.oldLine === 'number' ? buildSelectedDiffLineKey('deletions', line.oldLine) : null)
            : line.renderPrefixText === '+'
                ? (typeof line.newLine === 'number' ? buildSelectedDiffLineKey('additions', line.newLine) : null)
                : null;
        if (!key) return;
        onToggleLine(key);
    }, [lineSelectionEnabled, onToggleLine]);

    const { lineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();
    const virtualized = React.useMemo(() => {
        if (reviewCommentsEnabled !== true) return true;
        if (displayMode === 'diff') {
            return resolveInlineDiffVirtualization({
                unifiedDiff: typeof diffContent === 'string' ? diffContent : null,
                oldText: null,
                newText: null,
                lineThreshold,
                byteThreshold,
            });
        }
        if (displayMode === 'file') {
            return resolveInlineCodeVirtualization({
                text: typeof fileContent === 'string' ? fileContent : null,
                lineThreshold,
                byteThreshold,
            });
        }
        return false;
    }, [byteThreshold, diffContent, displayMode, fileContent, lineThreshold, reviewCommentsEnabled]);

    return (
        <View style={{ flex: 1 }}>
            {displayMode === 'diff' && typeof diffContent === 'string' ? (
                <ScrollView
                    style={{ flex: 1, minHeight: 0 }}
                    testID={scrollTestID}
                    onLayout={onLayout}
                    onContentSizeChange={onContentSizeChange}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                >
                    <DiffViewer
                        mode="unified"
                        filePath={filePath}
                        unifiedDiff={diffContent}
                        selectedLineIds={selectedLineIds}
                        onPressLine={handlePressLine}
                        onPressAddComment={reviewCommentControls?.onPressAddComment}
                        isCommentActive={reviewCommentControls?.isCommentActive}
                        renderAfterLine={reviewCommentControls?.renderAfterLine}
                        contentPaddingHorizontal={16}
                        contentPaddingVertical={16}
                        virtualized={jumpToLineId ? false : virtualized}
                        scrollToLineId={jumpToLineId ?? undefined}
                        highlightLineId={jumpToLineId ?? undefined}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={effectiveShowLineNumbers}
                        showPrefix={effectiveShowPrefix}
                    />
                </ScrollView>
            ) : displayMode === 'file' && typeof fileContent === 'string' ? (
                fileContent.length > 0 ? (
                    <CodeLinesView
                        lines={lines}
                        onPressAddComment={reviewCommentControls?.onPressAddComment}
                        isCommentActive={reviewCommentControls?.isCommentActive}
                        renderAfterLine={reviewCommentControls?.renderAfterLine}
                        contentPaddingHorizontal={16}
                        contentPaddingVertical={16}
                        virtualized={virtualized}
                        scrollToLineId={jumpToLineId ?? undefined}
                        highlightLineId={jumpToLineId ?? undefined}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={effectiveShowLineNumbers}
                        showPrefix={effectiveShowPrefix}
                        syntaxHighlighting={syntaxHighlighting}
                        testID={scrollTestID}
                        onLayout={onLayout}
                        onContentSizeChange={onContentSizeChange}
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                    />
                ) : (
                    <Text
                        style={{
                            fontSize: 16,
                            color: theme.colors.textSecondary,
                            fontStyle: 'italic',
                            padding: 16,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.fileEmpty')}
                    </Text>
                )
            ) : (
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        padding: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.noChanges')}
                </Text>
            )}
        </View>
    );
}

import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useCodeLinesReviewComments } from '@/components/sessions/reviews/comments/useCodeLinesReviewComments';
import { Typography } from '@/constants/Typography';
import type { ReviewCommentAnchor, ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

type FileContentPanelProps = {
    theme: any;
    displayMode: 'file' | 'diff';
    sessionId: string;
    filePath: string;
    diffContent: string | null;
    fileContent: string | null;
    language: string | null;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    selectedLineIndexes: Set<number>;
    lineSelectionEnabled: boolean;
    onToggleLine: (index: number) => void;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    jumpToAnchor?: ReviewCommentAnchor | null;
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
    selectedLineIndexes,
    lineSelectionEnabled,
    onToggleLine,
    reviewCommentsEnabled,
    reviewCommentDrafts,
    onUpsertReviewCommentDraft,
    onDeleteReviewCommentDraft,
    onReviewCommentError,
    jumpToAnchor,
}: FileContentPanelProps) {
    const lines = React.useMemo(() => {
        if (displayMode === 'diff' && typeof diffContent === 'string') {
            return buildCodeLinesFromUnifiedDiff({ unifiedDiff: diffContent });
        }
        if (displayMode === 'file' && typeof fileContent === 'string') {
            return buildCodeLinesFromFile({ text: fileContent });
        }
        return [];
    }, [diffContent, displayMode, fileContent]);

    const commentSource: ReviewCommentSource = displayMode === 'diff' ? 'diff' : 'file';
    const draftsForThisView = React.useMemo(() => {
        if (!reviewCommentsEnabled) return [];
        const all = reviewCommentDrafts ?? [];
        return all.filter((d) => d.filePath === filePath && d.source === commentSource);
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
        if (!selectedLineIndexes || selectedLineIndexes.size === 0) return undefined;
        const ids = new Set<string>();
        for (const line of lines) {
            if (!line.selectable) continue;
            if (selectedLineIndexes.has(line.sourceIndex)) {
                ids.add(line.id);
            }
        }
        return ids;
    }, [displayMode, lineSelectionEnabled, lines, selectedLineIndexes]);

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
        onToggleLine(line.sourceIndex);
    }, [lineSelectionEnabled, onToggleLine]);

    // Inline review-comment composers currently require non-virtual rendering for consistent updates
    // across React Native Web + FlatList. This keeps behavior reliable while the feature is experimental.
    const virtualized = !(reviewCommentsEnabled === true);

    return (
        <View style={{ flex: 1 }}>
            {displayMode === 'diff' && typeof diffContent === 'string' ? (
                <CodeLinesView
                    lines={lines}
                    selectedLineIds={selectedLineIds}
                    onPressLine={handlePressLine}
                    onPressAddComment={reviewCommentControls?.onPressAddComment}
                    isCommentActive={reviewCommentControls?.isCommentActive}
                    renderAfterLine={reviewCommentControls?.renderAfterLine}
                    contentPaddingHorizontal={16}
                    contentPaddingVertical={16}
                    virtualized={virtualized}
                    scrollToLineId={jumpToLineId ?? undefined}
                    highlightLineId={jumpToLineId ?? undefined}
                    syntaxHighlighting={syntaxHighlighting}
                />
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
                        syntaxHighlighting={syntaxHighlighting}
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

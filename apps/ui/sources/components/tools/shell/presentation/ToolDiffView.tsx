import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useSetting, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { useInlineDiffViewportStyle } from '@/components/ui/code/diff/useInlineDiffViewportStyle';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useCodeLinesReviewComments } from '@/components/ui/code/reviewComments/useCodeLinesReviewComments';
import { useToolFindState } from '../../renderers/core/ToolFindText';
import { buildToolFileDiffLines, toolDiffContextLines, toolDiffFindProps } from '../../renderers/fileOps/toolDiffDisplayText';

interface ToolDiffViewProps {
    sessionId?: string | null;
    serverId?: string | null;
    filePath?: string | null;
    unifiedDiff?: string | null;
    oldText: string;
    newText: string;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
    messageId?: string;
    findBlockPrefix?: string;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    sessionId,
    serverId,
    filePath,
    unifiedDiff = null,
    oldText, 
    newText, 
    style, 
    showLineNumbers = false,
    showPlusMinusSymbols = false,
    messageId,
    findBlockPrefix,
}) => {
    const find = useToolFindState(messageId);
    const contextLines = find.active ? toolDiffContextLines(oldText, newText) : 3;
    const wrapLines = useSetting('wrapLinesInDiffs');
    const reviewCommentsFeatureEnabled = useFeatureEnabled('files.reviewComments');
    const reviewScope = useWorkspaceScopeForSession(sessionId, serverId);
    const normalizedFilePath = typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = useWindowDimensions();

    const presentationStyleOverride = React.useMemo<'unified' | undefined>(() => {
        const hasOld = typeof oldText === 'string' && oldText.length > 0;
        const hasNew = typeof newText === 'string' && newText.length > 0;
        // Split diffs waste half the horizontal space (blank left/right columns) when one side is empty.
        // Force unified in those cases for a better compact UX.
        if (!hasOld || !hasNew) return 'unified';
        return undefined;
    }, [newText, oldText]);

    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);
    const virtualized = React.useMemo(() => {
        return resolveInlineDiffVirtualization({
            unifiedDiff,
            oldText: typeof oldText === 'string' ? oldText : null,
            newText: typeof newText === 'string' ? newText : null,
            lineThreshold: virtualizationLineThreshold,
            byteThreshold: virtualizationByteThreshold,
        });
    }, [newText, oldText, unifiedDiff, virtualizationByteThreshold, virtualizationLineThreshold]);
    const viewport = useInlineDiffViewportStyle(virtualized, maxVirtualizedHeight);
    const reviewCommentsEnabled =
        reviewCommentsFeatureEnabled === true &&
        Boolean(reviewScope) &&
        Boolean(normalizedFilePath);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(reviewScope);
    const codeLines = React.useMemo(() => {
        if (!reviewCommentsEnabled && !find.active) return [];
        return buildToolFileDiffLines({ oldText, newText, unifiedDiff }, find.active);
    }, [newText, oldText, unifiedDiff, reviewCommentsEnabled, find.active]);
    const findProps = React.useMemo(() => find.active && findBlockPrefix ? toolDiffFindProps(codeLines, findBlockPrefix, find.ranges) : undefined,
        [codeLines, find.active, find.blocks, findBlockPrefix]);
    const reviewControls = useCodeLinesReviewComments({
        enabled: reviewCommentsEnabled,
        filePath: normalizedFilePath ?? '',
        source: 'diff',
        lines: codeLines,
        drafts: reviewCommentDrafts,
        onUpsertDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
        onDeleteDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
        onError: reviewDraftHandlers.onReviewCommentError,
    });

    return (
        <View style={[style, viewport]}>
            <DiffViewer
                findActive={find.active}
                findRangesByLineId={findProps?.findRangesByLineId}
                scrollToLineId={findProps?.scrollToLineId}
                {...(unifiedDiff === null
                    ? { mode: 'text', oldText, newText, contextLines }
                    : { mode: 'unified', unifiedDiff })}
                filePath={filePath}
                wrapLines={wrapLines}
                virtualized={virtualized}
                presentationStyleOverride={presentationStyleOverride}
                showLineNumbers={showLineNumbers}
                showPrefix={showPlusMinusSymbols}
                onPressLine={reviewControls?.onPressAddComment}
                pressLineWhenNotSelectable={Boolean(reviewControls)}
                onPressAddComment={reviewControls?.onPressAddComment}
                isCommentActive={reviewControls?.isCommentActive}
                renderAfterLine={reviewControls?.renderAfterLine}
            />
        </View>
    );
});

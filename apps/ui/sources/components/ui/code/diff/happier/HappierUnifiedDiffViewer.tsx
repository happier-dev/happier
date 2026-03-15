import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { useSetting } from '@/sync/domains/state/storage';

import type { UnifiedDiffViewerProps } from '../diffViewerTypes';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { collapseUnifiedDiffContext } from './collapseUnifiedDiffContext';
import { UnifiedDiffFoldToggleRow } from './UnifiedDiffFoldToggleRow';

export const HappierUnifiedDiffViewer = React.memo<UnifiedDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const foldingEnabled = useSetting('filesDiffFoldingEnabled') === true;
    const contextThreshold = useSetting('filesDiffFoldingContextThreshold') ?? 0;
    const contextRadius = useSetting('filesDiffFoldingContextRadius') ?? 0;
    const intraLineDiff = useIntraLineWordDiffConfig();

    const [expandedRegionIds, setExpandedRegionIds] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        setExpandedRegionIds(new Set());
    }, [props.unifiedDiff]);

    const lines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({
        unifiedDiff: props.unifiedDiff,
        hideFilePrelude: true,
        intraLineDiff,
    }), [intraLineDiff, props.unifiedDiff]);

    const canFold = foldingEnabled
        && !props.onPressAddComment
        && !props.renderAfterLine
        && !props.isCommentActive;

    const folded = React.useMemo(() => {
        if (!canFold) return { lines, regions: [] as const };
        return collapseUnifiedDiffContext({
            lines,
            contextThreshold,
            contextRadius,
            expandedRegionIds,
        });
    }, [canFold, contextRadius, contextThreshold, expandedRegionIds, lines]);

    const foldRegionsByAfterLineId = React.useMemo(() => {
        const map = new Map<string, { id: string; hiddenCount: number }>();
        for (const region of folded.regions) {
            map.set(region.afterLineId, { id: region.id, hiddenCount: region.hiddenCount });
        }
        return map;
    }, [folded.regions]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const region = foldRegionsByAfterLineId.get(line.id) ?? null;
        if (!region) return null;
        return (
            <UnifiedDiffFoldToggleRow
                hiddenCount={region.hiddenCount}
                onPressExpand={() => {
                    setExpandedRegionIds((prev) => {
                        const next = new Set(prev);
                        next.add(region.id);
                        return next;
                    });
                }}
            />
        );
    }, [foldRegionsByAfterLineId]);

    const view = (
        <View style={{ flex: 1 }}>
            <CodeLinesView
                lines={folded.lines}
                selectedLineIds={props.selectedLineIds}
                onPressLine={props.onPressLine}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={canFold ? renderAfterLine : props.renderAfterLine}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized}
                showLineNumbers={props.showLineNumbers}
                showPrefix={props.showPrefix}
                scrollToLineId={props.scrollToLineId}
                highlightLineId={props.highlightLineId}
                syntaxHighlighting={syntaxHighlighting}
            />
        </View>
    );

    if (wrapLines) return view;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            {view}
        </ScrollView>
    );
});

import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';

interface ToolDiffViewProps {
    filePath?: string | null;
    oldText: string;
    newText: string;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    filePath,
    oldText, 
    newText, 
    style, 
    showLineNumbers = false,
    showPlusMinusSymbols = false 
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');
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
            unifiedDiff: null,
            oldText: typeof oldText === 'string' ? oldText : null,
            newText: typeof newText === 'string' ? newText : null,
            lineThreshold: virtualizationLineThreshold,
            byteThreshold: virtualizationByteThreshold,
        });
    }, [newText, oldText, virtualizationByteThreshold, virtualizationLineThreshold]);

    return (
        <View style={[{ flex: 1, ...(style ?? null) }, virtualized ? { maxHeight: maxVirtualizedHeight } : null]}>
            <DiffViewer
                mode="text"
                filePath={filePath}
                oldText={oldText}
                newText={newText}
                contextLines={3}
                wrapLines={wrapLines}
                virtualized={virtualized}
                presentationStyleOverride={presentationStyleOverride}
                showLineNumbers={showLineNumbers}
                showPrefix={showPlusMinusSymbols}
            />
        </View>
    );
});

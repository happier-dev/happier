import * as React from 'react';
import { View } from 'react-native';
import type { HappierDiffViewerRequest } from '@happier-dev/plugin-ui/presentation';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useSetting } from '@/sync/store/settingsReadHooks';

/**
 * Thin plugin-surface adapter over the incumbent app DiffViewer. It deliberately
 * owns no parser, cache, or review state: current user settings and the existing
 * inline virtualization policy remain the only decisions.
 */
export function PluginUiPrivateDiffViewer(props: Extract<HappierDiffViewerRequest, { unifiedDiff: string }>): React.ReactElement {
    const configuredWrapLines = useSetting('wrapLinesInDiffs');
    const configuredLineNumbers = useSetting('showLineNumbers');
    const thresholds = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = usePresentationWindowDimensions();
    const virtualized = resolveInlineDiffVirtualization({
        unifiedDiff: props.unifiedDiff,
        oldText: null,
        newText: null,
        lineThreshold: thresholds.lineThreshold,
        byteThreshold: thresholds.byteThreshold,
    });

    return (
        <View style={virtualized
            ? resolveInlineDiffVirtualizedViewportStyle(resolveInlineDiffVirtualizedMaxHeight(windowHeight))
            : undefined}
        >
            <DiffViewer
                mode="unified"
                unifiedDiff={props.unifiedDiff}
                filePath={props.filePath}
                wrapLines={configuredWrapLines !== false}
                showLineNumbers={configuredLineNumbers !== false}
                virtualized={virtualized}
                testID={props.testID}
            />
        </View>
    );
}

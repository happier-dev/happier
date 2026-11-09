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
/** A filling diff takes the height its panel gives it. */
const FILL_DIFF_STYLE = Object.freeze({ flex: 1, minHeight: 0 });

export function PluginUiPrivateDiffViewer(props: Extract<HappierDiffViewerRequest, { unifiedDiff: string }>): React.ReactElement {
    const configuredWrapLines = useSetting('wrapLinesInDiffs');
    const configuredLineNumbers = useSetting('showLineNumbers');
    const thresholds = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = usePresentationWindowDimensions();
    // A filling diff is its panel's one scroller, so it is always the list (QB-55/81): never a capped box nested
    // in another scroller. An inline diff keeps the existing threshold and its capped viewport.
    const fill = props.fill === true;
    const virtualized = fill || resolveInlineDiffVirtualization({
        unifiedDiff: props.unifiedDiff,
        oldText: null,
        newText: null,
        lineThreshold: thresholds.lineThreshold,
        byteThreshold: thresholds.byteThreshold,
    });

    return (
        <View style={fill ? FILL_DIFF_STYLE : virtualized
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
                {...(props.leadingContent === undefined ? {} : { leadingContent: props.leadingContent })}
                testID={props.testID}
            />
        </View>
    );
}


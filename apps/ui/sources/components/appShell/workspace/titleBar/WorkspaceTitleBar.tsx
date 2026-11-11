import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { SPLIT_CANVAS_DIVIDER_SIZE_PX } from '@/components/appShell/splitCanvas/components/SplitCanvasDivider';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ChromeGlyph } from '@/components/ui/icons/chromeGlyphInk';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { DOCUMENT_TAB_BAR_METRICS as B } from '@/components/ui/navigation/DocumentTabStrip';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from '../WorkspaceNavigationContext';
import { executeWorkspaceUiAction } from '../workspaceActionRuntime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { WorkspaceGroupTabs } from './WorkspaceGroupTabs';
import {
    resolveWorkspaceTopRowGroupIds, resolveWorkspaceBarSegmentFrame, WORKSPACE_BAR_CONTROL_GAP_PX,
    useWorkspaceBarFrames, WorkspaceBarGeometryContext, type WorkspaceBarGeometry,
} from './workspaceBarGeometry';

/** With the column hidden, the first pane's tabs start this far after the strip's own controls (lab T). */
const SEGMENT_END_PADDING_PX = 6;
const SPLIT_EDGES_PX = { leading: B.stripGapPx / 2, trailing: SEGMENT_END_PADDING_PX } as const;

/**
 * The tabs of the top-row panes, in the window's top strip (workspace lab T/S). Each pane's tabs sit
 * over that pane's own span, so the strip reads as the top of the page beneath it; a hairline tick
 * marks each divider. The strip ends with one split button for the focused pane.
 */
export function WorkspaceTitleBar(props: Readonly<{
    catalog: readonly CompactAppDestination[];
    /** Where the strip's own controls end, in the strip's coordinates. */
    clusterEndPx: number;
    stripHeightPx: number;
    /** Start of the measured trailing accessory reservation, in strip coordinates. */
    trailingStartPx?: number;
}>) {
    const workspace = useOptionalWorkspaceNavigation();
    const geometry = React.useContext(WorkspaceBarGeometryContext);
    // A phone presents its tabs in its own rail; a window narrowed from desktop must not keep the wide strip mounted hidden.
    if (!workspace?.active || workspace.phone || !geometry) return null;
    return <WorkspaceTitleBarSegments workspace={workspace} geometry={geometry} {...props} />;
}

function WorkspaceTitleBarSegments(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    geometry: WorkspaceBarGeometry;
    catalog: readonly CompactAppDestination[];
    clusterEndPx: number;
    stripHeightPx: number;
    trailingStartPx?: number;
}>) {
    const styles = stylesheet;
    const { workspace } = props;
    const frames = useWorkspaceBarFrames(props.geometry);
    const layerRef = React.useRef<View | null>(null);
    const [originX, setOriginX] = React.useState(0);
    const onLayerLayout = React.useCallback((_event: LayoutChangeEvent) => {
        layerRef.current?.measureInWindow?.((x) => {
            if (Number.isFinite(x)) setOriginX((current) => (current === x ? current : x));
        });
    }, []);
    const topRow = resolveWorkspaceTopRowGroupIds(workspace.state);
    const top = (props.stripHeightPx - B.tabHeightPx) / 2;
    const segments = topRow.flatMap((groupId, index) => {
        const group = workspace.state.groups[groupId];
        const frame = frames.get(groupId);
        if (!group || !frame) return [];
        const segment = resolveWorkspaceBarSegmentFrame({
            frame, originX,
            leadingEndPx: index === 0 ? props.clusterEndPx + WORKSPACE_BAR_CONTROL_GAP_PX : 0,
            trailingStartPx: props.trailingStartPx,
        });
        if (!segment) return [];
        return [{ group, ...segment, last: index === topRow.length - 1 }];
    });
    return (
        <View ref={layerRef} onLayout={onLayerLayout} pointerEvents="box-none" style={styles.layer} testID="workspace-title-bar">
            {segments.map((segment, index) => (
                <React.Fragment key={segment.group.id}>
                    {index > 0 ? (
                        <View pointerEvents="none" style={[styles.tick, { left: segment.paneLeft - SPLIT_CANVAS_DIVIDER_SIZE_PX.row / 2, top: top + 8 }]} />
                    ) : null}
                    <View
                        testID={`workspace-bar-segment-${segment.group.id}`}
                        style={[styles.segment, { left: segment.left, width: segment.width, top, height: B.tabHeightPx }]}
                    >
                        <WorkspaceGroupTabs
                            workspace={workspace}
                            group={segment.group}
                            catalog={props.catalog}
                            focused={workspace.state.focusedGroupId === segment.group.id}
                            placement="bar"
                            trailing={segment.last ? <WorkspaceSplitButton workspace={workspace} /> : undefined}
                        />
                    </View>
                </React.Fragment>
            ))}
        </View>
    );
}

/** Split right for the focused pane, admitted by its measured width like every other split. */
function WorkspaceSplitButton(props: Readonly<{ workspace: WorkspaceNavigationContextValue }>) {
    const { workspace } = props;
    const shortcut = useKeyboardShortcutLabel('workspace.splitRight');
    const label = shortcut ? `${t('workspaceBar.splitRight')} (${shortcut})` : t('workspaceBar.splitRight');
    const split = React.useCallback(() => {
        const groupId = workspace.state.focusedGroupId;
        fireAndForget(executeWorkspaceUiAction({ actionId: 'workspace.split', input: { groupId, direction: 'right' } }, href => {
            const navigation = workspace.navigationForTab(workspace.state.groups[groupId].activeTabId);
            (navigation.pushRetainingCurrent ?? navigation.push)(href);
        }), { tag: 'Workspace.split' });
    }, [workspace]);
    return (
        <IconButton
            testID="workspace-split-right"
            variant="plain"
            size={28}
            // The strip's glyph ink, as the tabs' + and caret beside it.
            icon={<ChromeGlyph name="square-split-horizontal" size={M.actionGlyphPx} />}
            // Half the strip's gap to All tabs before it; the segment's end padding after it.
            interactiveTargetEdgesPx={SPLIT_EDGES_PX}
            accessibilityLabel={t('workspaceBar.splitRight')}
            tooltip={label}
            tooltipPlacement="bottom"
            onPress={split}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    layer: {
        ...StyleSheet.absoluteFillObject,
    },
    segment: {
        position: 'absolute',
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: SEGMENT_END_PADDING_PX,
        minWidth: 0,
    },
    tick: {
        position: 'absolute',
        width: StyleSheet.hairlineWidth,
        height: 14,
        backgroundColor: theme.colors.border.strong,
    },
}));

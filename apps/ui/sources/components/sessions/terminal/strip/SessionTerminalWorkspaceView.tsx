import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SplitCanvasHost, type SplitCanvasHostControls } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SplitCanvasAction, SplitCanvasLeafNode, SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { t } from '@/text';

import type { SessionTerminalDescriptor, SessionTerminalTabDescriptor } from '../presentation/describeSessionTerminal';
import type { SessionTerminalWorkspaceCommand } from '../sessionTerminalWorkspace';
import { sessionTerminalTabToSplitCanvas } from '../sessionTerminalWorkspace';
import { registerSessionTerminalSplitMeasurements } from '../sessionTerminalWorkspaceRuntime';
import { SessionTerminalList, SESSION_TERMINAL_LIST_METRICS } from './SessionTerminalList';
import { SessionTerminalStrip, type SessionTerminalStripProps } from './SessionTerminalStrip';

type ResizeCommand = Extract<SessionTerminalWorkspaceCommand, { type: 'resize' }>;

export type SessionTerminalWorkspaceViewProps = Readonly<{
    scopeId: string;
    workspace: SessionTerminalWorkspaceV1;
    tabs: readonly SessionTerminalTabDescriptor[];
    /** One terminal's body. Only the visible tab's members are mounted; hidden tabs keep running. */
    renderLeaf: (member: SessionTerminalMemberV1, state: Readonly<{ focused: boolean; descriptor: SessionTerminalDescriptor | null }>) => React.ReactNode;
    /** The narrowest a terminal may get, so a split never leaves a PTY too narrow to read. */
    minimumTerminalWidthPx: number;
    onFocusTerminal: (terminalId: string) => void;
    onResize: (command: ResizeCommand) => void;
    tabMenuItems: (tabId: string) => readonly DropdownMenuItem[];
    onTabMenuSelect: (tabId: string, itemId: string) => void;
    emptyAction?: () => void;
    testIdPrefix?: string;
}> & Omit<SessionTerminalStripProps, 'tabs' | 'activeTabId' | 'listShowing' | 'activeTerminal' | 'onTabMenu' | 'testIdPrefix'>;

/**
 * The session's bottom pane (terminal lab B1–B3): one strip, the visible tab's terminals side by side
 * through the workspace split engine, and the list view beside them when it is on and there is room.
 * Layout comes from the AppPane terminal workspace; this view only presents it and reports intent.
 */
export const SessionTerminalWorkspaceView = React.memo(function SessionTerminalWorkspaceView(props: SessionTerminalWorkspaceViewProps) {
    const styles = stylesheet;
    const { workspace } = props;
    const [widthPx, setWidthPx] = React.useState<number | null>(null);
    const [tabMenu, setTabMenu] = React.useState<Readonly<{ tabId: string; anchor: PopoverAnchor | undefined }> | null>(null);
    const controlsRef = React.useRef<SplitCanvasHostControls | null>(null);

    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
    const activeDescriptor = props.tabs.find((tab) => tab.tabId === workspace.activeTabId) ?? null;
    const focusedDescriptor = activeDescriptor?.members.find((member) => member.terminalId === activeTab?.focusedTerminalId) ?? null;
    // The list is a view, not a mode: below the width it needs, this window shows tabs (lab B3).
    const listShowing = workspace.showList && widthPx !== null && widthPx >= SESSION_TERMINAL_LIST_METRICS.minimumPaneWidthPx;

    // Split admission and divider moves go through the mounted split engine's own measurements.
    const activeTabId = activeTab?.id ?? null;
    const focusedTerminalId = activeTab?.focusedTerminalId ?? null;
    React.useEffect(() => registerSessionTerminalSplitMeasurements(props.scopeId, (tabId) => {
        if (!focusedTerminalId || (tabId && tabId !== activeTabId)) return null;
        const measurement = controlsRef.current?.readSplitMeasurement(focusedTerminalId, 'right') ?? null;
        return measurement ? { availableWidthPx: measurement.availableSizePx, minimumTerminalWidthPx: measurement.minimumExistingSizePx } : null;
    }, (tabId, splitId, ratio) => (tabId === activeTabId ? controlsRef.current?.resizeSplit(splitId, ratio) ?? false : false)),
    [activeTabId, focusedTerminalId, props.scopeId]);

    const canvas = React.useMemo(() => (activeTab ? sessionTerminalTabToSplitCanvas(activeTab) : null), [activeTab]);
    const onCanvasAction = React.useCallback((action: SplitCanvasAction<SessionTerminalMemberV1>) => {
        if (!activeTabId) return;
        if (action.type === 'focusLeaf' && action.leafId) props.onFocusTerminal(action.leafId);
        if (action.type === 'setSplitRatio' && typeof action.availableSizePx === 'number') {
            props.onResize({
                type: 'resize', tabId: activeTabId, splitId: action.splitId, ratio: action.ratio,
                availableWidthPx: action.availableSizePx,
                minimumTerminalWidthPx: props.minimumTerminalWidthPx,
                ...(action.minimumFirstSizePx !== undefined ? { minimumFirstWidthPx: action.minimumFirstSizePx } : {}),
                ...(action.minimumSecondSizePx !== undefined ? { minimumSecondWidthPx: action.minimumSecondSizePx } : {}),
            });
        }
    }, [activeTabId, props.minimumTerminalWidthPx, props.onFocusTerminal, props.onResize]);
    const getLeafMinimumSizePx = React.useCallback(() => ({ width: props.minimumTerminalWidthPx, height: 0 }), [props.minimumTerminalWidthPx]);
    const renderLeaf = React.useCallback((input: Readonly<{ leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>; isFocused: boolean }>) => (
        props.renderLeaf(input.leaf.payload, {
            focused: input.isFocused,
            descriptor: activeDescriptor?.members.find((member) => member.terminalId === input.leaf.id) ?? null,
        })
    ), [activeDescriptor, props.renderLeaf]);

    const onTabMenu = React.useCallback((tabId: string, event: unknown) => setTabMenu({ tabId, anchor: resolvePointerMenuAnchor(event) }), []);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidthPx((current) => (current === next ? current : next));
    }, []);

    return (
        <View testID={props.testIdPrefix ? `${props.testIdPrefix}-root` : undefined} style={styles.root} onLayout={onLayout}>
            <SessionTerminalStrip
                {...props}
                tabs={props.tabs}
                activeTabId={workspace.activeTabId}
                listShowing={listShowing}
                activeTerminal={focusedDescriptor}
                onTabMenu={onTabMenu}
                testIdPrefix={props.testIdPrefix ? `${props.testIdPrefix}-strip` : undefined}
            />
            {/* A terminal state card takes the Details step: a wide, short pane (lab ST). */}
            <SurfaceStateSizeProvider size="details">
            <View style={styles.body}>
                {canvas ? (
                    <View style={styles.canvas}>
                        <TypedTerminalSplitCanvasHost
                            state={canvas}
                            dispatch={onCanvasAction}
                            renderLeaf={renderLeaf}
                            getLeafMinimumSizePx={getLeafMinimumSizePx}
                            controlsRef={controlsRef}
                            keyboardEnabled={false}
                            chrome="flat"
                        />
                    </View>
                ) : (
                    <View style={styles.empty}>
                        <SurfaceStateCard
                            kind="empty"
                            iconName="terminal"
                            scene="noTerminal"
                            title={t('terminalWorkspace.states.empty')}
                            {...(props.emptyAction ? { action: { label: t('terminalWorkspace.states.emptyAction'), onPress: props.emptyAction } } : {})}
                        />
                    </View>
                )}
                {listShowing ? (
                    <SessionTerminalList
                        tabs={props.tabs}
                        activeTabId={workspace.activeTabId}
                        focusedTerminalId={focusedTerminalId}
                        onActivateTab={props.onActivateTab}
                        onFocusTerminal={props.onFocusTerminal}
                        onTabMenu={onTabMenu}
                        testIdPrefix={props.testIdPrefix ? `${props.testIdPrefix}-list` : undefined}
                    />
                ) : null}
            </View>
            </SurfaceStateSizeProvider>
            {tabMenu ? (
                <DropdownMenu
                    open
                    onOpenChange={(open) => { if (!open) setTabMenu(null); }}
                    items={props.tabMenuItems(tabMenu.tabId)}
                    onSelect={(itemId) => { const tabId = tabMenu.tabId; setTabMenu(null); props.onTabMenuSelect(tabId, itemId); }}
                    search={false}
                    trigger={null}
                    popoverAnchor={tabMenu.anchor}
                    matchTriggerWidth={false}
                    maxWidthCap={280}
                    maxHeightCap={560}
                    placement="top"
                    popoverAnchorAlign="start"
                    allowEmptySelection
                />
            ) : null}
        </View>
    );
});

const TypedTerminalSplitCanvasHost = SplitCanvasHost as unknown as React.ComponentType<Readonly<{
    state: SplitCanvasState<SessionTerminalMemberV1>;
    dispatch: (action: SplitCanvasAction<SessionTerminalMemberV1>) => void;
    renderLeaf: (input: Readonly<{ leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>; isFocused: boolean; isMaximized: boolean }>) => React.ReactNode;
    getLeafMinimumSizePx: (leaf: SplitCanvasLeafNode<SessionTerminalMemberV1>) => Readonly<{ width: number; height: number }>;
    controlsRef: React.MutableRefObject<SplitCanvasHostControls | null>;
    keyboardEnabled: boolean;
    chrome: 'framed' | 'flat';
}>>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'row',
    },
    canvas: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    empty: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

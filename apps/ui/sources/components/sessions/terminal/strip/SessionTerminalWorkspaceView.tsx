import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { t } from '@/text';

import type { SessionTerminalDescriptor, SessionTerminalTabDescriptor } from '../presentation/describeSessionTerminal';
import type { SessionTerminalWorkspaceCommand } from '../sessionTerminalWorkspace';
import { SessionTerminalList, SESSION_TERMINAL_LIST_METRICS } from './SessionTerminalList';
import { SessionTerminalStrip, type SessionTerminalStripProps } from './SessionTerminalStrip';
import { SessionTerminalTabCanvas } from './SessionTerminalTabCanvas';

type ResizeCommand = Extract<SessionTerminalWorkspaceCommand, { type: 'resize' }>;

export type SessionTerminalWorkspaceViewProps = Readonly<{
    scopeId: string;
    workspace: SessionTerminalWorkspaceV1;
    tabs: readonly SessionTerminalTabDescriptor[];
    /** A full page keeps discovery while another host presents its active terminal. */
    renderTerminals?: boolean;
    /** Visited tabs retain their renderers and connections until closed. */
    renderLeaf: (member: SessionTerminalMemberV1, state: Readonly<{ focused: boolean; descriptor: SessionTerminalDescriptor | null }>) => React.ReactNode;
    /** The narrowest a terminal may get, so a split never leaves a PTY too narrow to read. */
    minimumTerminalWidthPx: number;
    onFocusTerminal: (terminalId: string) => void;
    onResize: (command: ResizeCommand) => void;
    tabMenuItems: (tabId: string) => readonly DropdownMenuItem[];
    onTabMenuSelect: (tabId: string, itemId: string) => void;
    emptyAction?: () => void;
    /** Why the list stands in for the terminal (recovered Shells), said once above it. */
    listNote?: string;
    testIdPrefix?: string;
}> & Omit<SessionTerminalStripProps, 'tabs' | 'activeTabId' | 'listShowing' | 'narrow' | 'activeTerminal' | 'onTabMenu' | 'testIdPrefix'>;

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

    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
    const activeDescriptor = props.tabs.find((tab) => tab.tabId === workspace.activeTabId) ?? null;
    const focusedDescriptor = activeDescriptor?.members.find((member) => member.terminalId === activeTab?.focusedTerminalId) ?? null;
    // The list is a view, not a mode: below the width it needs, this window shows tabs (lab B3).
    const listShowing = props.renderTerminals !== false && workspace.showList && widthPx !== null && widthPx >= SESSION_TERMINAL_LIST_METRICS.minimumPaneWidthPx;
    // The same width decides how much the strip can say: a pane with no room for the list keeps its tabs first.
    const narrow = widthPx === null || widthPx < SESSION_TERMINAL_LIST_METRICS.minimumPaneWidthPx;

    const focusedTerminalId = activeTab?.focusedTerminalId ?? null;

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
                narrow={narrow}
                activeTerminal={focusedDescriptor}
                onTabMenu={onTabMenu}
                testIdPrefix={props.testIdPrefix ? `${props.testIdPrefix}-strip` : undefined}
            />
            {/* A terminal state card takes the Details step: a wide, short pane (lab ST). */}
            <SurfaceStateSizeProvider size="details">
            <View style={styles.body}>
                {props.renderTerminals === false && props.tabs.length > 0 ? (
                    <SessionTerminalList tabs={props.tabs} activeTabId={workspace.activeTabId} focusedTerminalId={focusedTerminalId}
                        onActivateTab={props.onActivateTab} onFocusTerminal={props.onFocusTerminal} onTabMenu={onTabMenu} note={props.listNote}
                        testIdPrefix={props.testIdPrefix ? `${props.testIdPrefix}-list` : undefined} />
                ) : activeTab && props.renderTerminals !== false ? (
                    <View style={styles.canvas}>
                        {workspace.tabs.map(tab => (
                            <RetainedPanelSurface key={tab.id} isActive={tab.id === workspace.activeTabId} mode="flow">
                                <SessionTerminalTabCanvas scopeId={props.scopeId} tab={tab}
                                    descriptor={props.tabs.find(descriptor => descriptor.tabId === tab.id) ?? null}
                                    active={tab.id === workspace.activeTabId} minimumTerminalWidthPx={props.minimumTerminalWidthPx}
                                    onFocusTerminal={props.onFocusTerminal} onResize={props.onResize} renderLeaf={props.renderLeaf} />
                            </RetainedPanelSurface>
                        ))}
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

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
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

import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { DocumentTabStrip, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import type { PopoverAnchor } from '@/components/ui/popover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import {
    describeSessionTerminalStatus,
    type SessionTerminalDescribeContext,
    type SessionTerminalDescriptor,
    type SessionTerminalTabDescriptor,
} from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import {
    useSessionTerminalDescribeContext,
    useSessionTerminalTabDescriptors,
} from '@/components/sessions/terminal/presentation/useSessionTerminalPresentation';
import { renderSessionTerminalMark, SESSION_TERMINAL_STATUS_TONE } from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { useSessionTerminalWorkspace } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import { useOpenTerminalJump } from '@/components/sessions/terminal/jump/useOpenTerminalJump';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

type ChipItem = DocumentTabItem & Readonly<{ descriptor: SessionTerminalTabDescriptor }>;

/** A horizontal swipe this long on the terminal moves a split tab to its next or previous half. */
const PAGER_SWIPE_PX = 48;

type SessionTerminalAction = 'session.terminals.focus' | 'session.terminals.close_tab' | 'session.terminals.open';

/**
 * The phone's Terminal page (terminal lab P1, B1p, B2p, A1p, STp): the session's terminals as chips,
 * then the active terminal, then the key rail and arrow pad its pane brings. The chips are the same
 * terminal workspace the desktop strip shows, so a tab is described the same way on every device;
 * every change goes through the session terminal Actions.
 */
export const SessionTerminalPage = React.memo(function SessionTerminalPage(props: Readonly<{
    sessionId: string;
    scopeId: string;
    testIdPrefix?: string | null;
}>) {
    const { workspace, execute } = useSessionTerminalWorkspace(props.scopeId);
    const serverId = parseSessionPaneScopeId(props.scopeId)?.address?.serverId ?? null;
    const context = useSessionTerminalDescribeContext(props.sessionId, serverId);
    const tabs = useSessionTerminalTabDescriptors({ sessionId: props.sessionId, scopeId: props.scopeId, workspace, context });
    const onAction = React.useCallback((actionId: SessionTerminalAction, input: Readonly<Record<string, unknown>>) => {
        void execute(actionId, input);
    }, [execute]);
    const openJump = useOpenTerminalJump();
    const onOpenJump = React.useMemo(() => openJump ? () => openJump({ sessionId: props.sessionId, serverId, scopeId: props.scopeId }) : undefined, [openJump, props.scopeId, props.sessionId, serverId]);
    const run = React.useCallback((actionId: Parameters<typeof execute>[0], input?: Readonly<Record<string, unknown>>) => execute(actionId, input), [execute]);
    const tabMenu = useSessionTerminalTabMenu({ scopeId: props.scopeId, workspace, tabs, run });
    const renderTerminal = React.useCallback((member: SessionTerminalMemberV1, descriptor: SessionTerminalDescriptor) => (
        <SessionEmbeddedTerminalPane
            key={member.id}
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            currentDockLocation="sidebar"
            terminal={member}
            chrome="none"
            title={descriptor.title}
            machineName={context.sessionMachineName}
            focused
            testIdPrefix={props.testIdPrefix ?? null}
        />
    ), [context.sessionMachineName, props.scopeId, props.sessionId, props.testIdPrefix]);
    return (
        <SessionTerminalPageView
            workspace={workspace}
            tabs={tabs}
            context={context}
            onAction={onAction}
            tabMenu={tabMenu}
            onOpenJump={onOpenJump}
            renderTerminal={renderTerminal}
            testIdPrefix={props.testIdPrefix}
        />
    );
});

/** The page's presentation over a terminal workspace; the dev specimen drives it with fixture data. */
export const SessionTerminalPageView = React.memo(function SessionTerminalPageView(props: Readonly<{
    workspace: SessionTerminalWorkspaceV1;
    tabs: readonly SessionTerminalTabDescriptor[];
    context: SessionTerminalDescribeContext;
    onAction: (actionId: SessionTerminalAction, input: Readonly<Record<string, unknown>>) => void;
    tabMenu?: Readonly<{ items: (tabId: string) => readonly DropdownMenuItem[]; select: (tabId: string, itemId: string) => void }> | null;
    onOpenJump?: () => void;
    renderTerminal: (member: SessionTerminalMemberV1, descriptor: SessionTerminalDescriptor) => React.ReactNode;
    testIdPrefix?: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { workspace, tabs, context, onAction } = props;
    const touchTarget = resolveTouchTargetFloorPx() ?? 32;
    const actionGap = Math.max(0, touchTarget - 32);
    const testId = (suffix: string) => (props.testIdPrefix ? `${props.testIdPrefix}-${suffix}` : undefined);
    const [menu, setMenu] = React.useState<Readonly<{ tabId: string; anchor: PopoverAnchor | undefined }> | null>(null);

    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
    const activeDescriptor = tabs.find((tab) => tab.tabId === activeTab?.id) ?? null;
    const focusedIndex = activeTab ? Math.max(0, activeTab.terminals.findIndex((member) => member.id === activeTab.focusedTerminalId)) : 0;
    const focusedMember = activeTab?.terminals[focusedIndex] ?? null;
    const focusedDescriptor = activeDescriptor?.members[focusedIndex] ?? null;
    const memberCount = activeTab?.terminals.length ?? 0;

    const chips = React.useMemo((): readonly ChipItem[] => tabs.map((tab) => {
        const split = tab.members.length > 1;
        const tabModel = workspace.tabs.find((item) => item.id === tab.tabId);
        const index = split && tabModel ? Math.max(0, tabModel.terminals.findIndex((member) => member.id === tabModel.focusedTerminalId)) : 0;
        return {
            key: tab.tabId,
            // A split chip names the half that shows, and counts its halves (lab B2p: "zsh 1 of 2").
            title: split ? tab.members[index]?.title ?? tab.title : tab.title,
            subtitle: split ? t('terminalWorkspace.keys.pagerA11y', { index: index + 1, count: tab.members.length }) : null,
            isPreview: false,
            isPinned: false,
            descriptor: tab,
        };
    }), [tabs, workspace.tabs]);

    const focusTerminal = React.useCallback((terminalId: string) => {
        onAction('session.terminals.focus', { terminalId });
    }, [onAction]);

    const activateChip = React.useCallback((tabId: string) => {
        const tab = workspace.tabs.find((item) => item.id === tabId);
        if (!tab) return;
        if (tab.id === workspace.activeTabId && tab.terminals.length > 1) {
            // Tapping the open split chip pages to its next half.
            const index = tab.terminals.findIndex((member) => member.id === tab.focusedTerminalId);
            focusTerminal(tab.terminals[(index + 1) % tab.terminals.length]!.id);
            return;
        }
        focusTerminal(tab.focusedTerminalId);
    }, [focusTerminal, workspace.activeTabId, workspace.tabs]);

    const closeChip = React.useCallback((tabId: string) => {
        onAction('session.terminals.close_tab', { tabId });
    }, [onAction]);

    const openShell = React.useCallback(() => {
        onAction('session.terminals.open', { target: { kind: 'workspace_shell' } });
    }, [onAction]);

    // A split tab is a pager: a horizontal swipe on the terminal shows the next or previous half.
    const swipeStart = React.useRef<{ x: number; y: number } | null>(null);
    const pageBy = React.useCallback((step: number) => {
        if (!activeTab || activeTab.terminals.length < 2) return;
        const next = activeTab.terminals[focusedIndex + step];
        if (next) focusTerminal(next.id);
    }, [activeTab, focusTerminal, focusedIndex]);
    const pagerResponder = memberCount > 1 ? {
        onTouchStart: (event: GestureResponderEvent) => { swipeStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }; },
        onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => {
            const start = swipeStart.current;
            if (!start) return false;
            const dx = event.nativeEvent.pageX - start.x;
            const dy = event.nativeEvent.pageY - start.y;
            return Math.abs(dx) > PAGER_SWIPE_PX / 2 && Math.abs(dx) > Math.abs(dy) * 2;
        },
        onResponderRelease: (event: GestureResponderEvent) => {
            const start = swipeStart.current;
            swipeStart.current = null;
            if (!start) return;
            const dx = event.nativeEvent.pageX - start.x;
            if (Math.abs(dx) >= PAGER_SWIPE_PX) pageBy(dx < 0 ? 1 : -1);
        },
        onResponderTerminate: () => { swipeStart.current = null; },
    } : null;

    // The meta line says where the terminal runs only when that differs from the session header,
    // and on a split tab, what a swipe shows next.
    const place = focusedDescriptor?.mark.kind === 'agent' && context.agentName && context.agentTerminalHost
        ? t('terminalWorkspace.agentTerminalHost', { agent: context.agentName, host: context.agentTerminalHost })
        : focusedDescriptor?.place ?? null;
    const nextHalf = memberCount > 1 ? activeDescriptor?.members[(focusedIndex + 1) % memberCount] ?? null : null;

    return (
        <View testID={testId('page')} style={styles.page}>
            <View style={styles.chips}>
                <DocumentTabStrip
                    variant="rail"
                    tabs={chips}
                    activeTabKey={workspace.activeTabId}
                    accessibilityLabel={t('terminalWorkspace.stripA11y')}
                    onActivate={activateChip}
                    onPin={() => undefined}
                    onUnpin={() => undefined}
                    onClose={closeChip}
                    onTabMenu={props.onOpenJump ?? (props.tabMenu ? (tabId, event) => setMenu({ tabId, anchor: resolvePointerMenuAnchor(event) }) : undefined)}
                    renderLeadingIcon={(tab, active) => renderSessionTerminalMark(tab.descriptor.mark, ICON_SIZE.sm, active ? theme.colors.text.primary : theme.colors.text.secondary)}
                    resolveTabPresentation={(tab) => (tab.descriptor.status ? {
                        status: { tone: SESSION_TERMINAL_STATUS_TONE[tab.descriptor.status], label: describeSessionTerminalStatus(tab.descriptor.status) },
                    } : null)}
                    tabNativeId={(key) => `session-terminal-chip-${toTestIdSafeValue(key)}`}
                    panelNativeId={(key) => `session-terminal-panel-${toTestIdSafeValue(key)}`}
                    testIds={{
                        tab: (key) => testId(`chip-${key}`),
                        tabClose: (key) => testId(`chip-close-${key}`),
                        tabStatus: (key) => testId(`chip-status-${key}`),
                    }}
                    railTrailing={(
                        <View style={{ flexDirection: 'row', gap: actionGap }}>
                            {props.tabMenu && activeTab ? (
                                <IconButton
                                    testID={testId('tab-menu')}
                                    accessibilityLabel={t('terminalWorkspace.actions.more')}
                                    onPress={(event) => setMenu({ tabId: activeTab.id, anchor: resolvePointerMenuAnchor(event) })}
                                    iconName="dots-three"
                                    size={32}
                                    minimumInteractiveTargetSize={touchTarget}
                                    interactiveTargetGapPx={actionGap}
                                />
                            ) : null}
                            <IconButton
                                testID={testId('new-shell')}
                                accessibilityLabel={t('terminalWorkspace.actions.newShell')}
                                onPress={openShell}
                                iconName="plus"
                                size={32}
                                minimumInteractiveTargetSize={touchTarget}
                                interactiveTargetGapPx={actionGap}
                            />
                        </View>
                    )}
                />
            </View>
            {place || nextHalf ? (
                <View style={styles.meta}>
                    {place ? <Text style={styles.metaText} numberOfLines={1}>{place}</Text> : null}
                    <View style={styles.grow} />
                    {nextHalf ? (
                        <Pressable
                            testID={testId('pager-next')}
                            accessibilityRole="button"
                            accessibilityLabel={t('terminalWorkspace.keys.pagerNext', { title: nextHalf.title })}
                            onPress={() => focusTerminal(nextHalf.terminalId)}
                            hitSlop={8}
                        >
                            <Text style={styles.metaHint} numberOfLines={1}>{t('terminalWorkspace.keys.pagerNext', { title: nextHalf.title })}</Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            <View style={styles.body} {...pagerResponder}>
                {focusedMember && focusedDescriptor ? props.renderTerminal(focusedMember, focusedDescriptor) : (
                    <View style={styles.empty}>
                        <SurfaceStateCard
                            testID={testId('empty')}
                            kind="empty"
                            title={t('terminalWorkspace.states.empty')}
                            icon={<Icon name="terminal" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                            action={{ label: t('terminalWorkspace.states.emptyAction'), onPress: openShell, testID: testId('empty-new-shell') }}
                        />
                    </View>
                )}
            </View>
            {menu && props.tabMenu ? (
                <DropdownMenu
                    open
                    onOpenChange={(open) => { if (!open) setMenu(null); }}
                    items={props.tabMenu.items(menu.tabId)}
                    onSelect={(itemId) => { const tabId = menu.tabId; setMenu(null); props.tabMenu?.select(tabId, itemId); }}
                    search={false}
                    trigger={null}
                    popoverAnchor={menu.anchor}
                    matchTriggerWidth={false}
                    maxWidthCap={300}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    allowEmptySelection
                />
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
    chips: {
        paddingTop: 4,
        paddingBottom: 8,
    },
    meta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
        paddingBottom: 6,
    },
    metaText: {
        flexShrink: 1,
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    metaHint: {
        fontSize: 12,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    grow: {
        flex: 1,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
}));

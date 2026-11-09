import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import { View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DocumentTabStrip } from '@/components/ui/navigation/DocumentTabStrip';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import type { PopoverAnchor } from '@/components/ui/popover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
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
import { useSessionTerminalDocumentTabs, type SessionTerminalDocumentTab } from '@/components/sessions/terminal/presentation/useSessionTerminalDocumentTabs';
import { renderSessionTerminalMark, SESSION_TERMINAL_STATUS_TONE } from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { useSessionTerminalWorkspace } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import { useOpenTerminalJump } from '@/components/sessions/terminal/jump/useOpenTerminalJump';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { SessionTerminalList } from '@/components/sessions/terminal/strip/SessionTerminalList';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { selectSessionTerminalWorkspaceHost } from '@/components/sessions/terminal/sessionTerminalWorkspace';

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
    presentation?: 'page';
}>) {
    const { workspace, execute } = useSessionTerminalWorkspace(props.scopeId);
    const renderTerminals = useAppPaneContext(value =>
        selectSessionTerminalWorkspaceHost(value.state, props.scopeId) === (props.presentation ?? 'right'));
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
    const renderTerminal = React.useCallback((member: SessionTerminalMemberV1, descriptor: SessionTerminalDescriptor, focused: boolean) => (
        <SessionEmbeddedTerminalPane
            key={member.id}
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            currentDockLocation="sidebar"
            presentationId={tabMenu.presentationId}
            terminal={member}
            chrome="none"
            title={descriptor.title}
            machineName={context.sessionMachineName}
            focused={focused}
            testIdPrefix={props.testIdPrefix ?? null}
        />
    ), [context.sessionMachineName, props.scopeId, props.sessionId, props.testIdPrefix, tabMenu.presentationId]);
    return (
        <SessionTerminalPageView
            workspace={workspace}
            renderTerminals={renderTerminals}
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
    renderTerminal: (member: SessionTerminalMemberV1, descriptor: SessionTerminalDescriptor, focused: boolean) => React.ReactNode;
    /** The page keeps its discovery controls when a companion pane owns the live renderer. */
    renderTerminals?: boolean;
    /** Why the list stands in for the terminal (recovered Shells), said once above it. */
    listNote?: string;
    testIdPrefix?: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { workspace, tabs, context, onAction } = props;
    const testId = (suffix: string) => (props.testIdPrefix ? `${props.testIdPrefix}-${suffix}` : undefined);
    const [menu, setMenu] = React.useState<Readonly<{ tabId: string; anchor: PopoverAnchor | undefined }> | null>(null);

    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
    const activeDescriptor = tabs.find((tab) => tab.tabId === activeTab?.id) ?? null;
    const focusedIndex = activeTab ? Math.max(0, activeTab.terminals.findIndex((member) => member.id === activeTab.focusedTerminalId)) : 0;
    const focusedMember = activeTab?.terminals[focusedIndex] ?? null;
    const focusedDescriptor = activeDescriptor?.members[focusedIndex] ?? null;
    const memberCount = activeTab?.terminals.length ?? 0;

    const chips = useSessionTerminalDocumentTabs(tabs, workspace);
    const renderLeadingIcon = React.useCallback((tab: SessionTerminalDocumentTab, active: boolean) => renderSessionTerminalMark(
        tab.mark, ICON_SIZE.sm, active ? theme.colors.text.primary : theme.colors.text.secondary,
    ), [theme.colors.text.primary, theme.colors.text.secondary]);

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
            {/* The chips scroll; New terminal and the tab menu stay pinned at the end, however many Shells run. */}
            <View style={styles.chips}>
                <View style={styles.chipRail}>
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
                    renderLeadingIcon={renderLeadingIcon}
                    resolveTabPresentation={(tab) => (tab.status ? {
                        status: { tone: SESSION_TERMINAL_STATUS_TONE[tab.status], label: describeSessionTerminalStatus(tab.status) },
                    } : null)}
                    tabNativeId={(key) => `session-terminal-chip-${toTestIdSafeValue(key)}`}
                    panelNativeId={(key) => `session-terminal-panel-${toTestIdSafeValue(key)}`}
                    testIds={{
                        tab: (key) => testId(`chip-${key}`),
                        tabClose: (key) => testId(`chip-close-${key}`),
                        tabStatus: (key) => testId(`chip-status-${key}`),
                    }}
                />
                </View>
                <View style={styles.chipActions}>
                    {props.tabMenu && activeTab ? (
                        <IconButton
                            testID={testId('tab-menu')}
                            accessibilityLabel={t('terminalWorkspace.actions.more')}
                            onPress={(event) => setMenu({ tabId: activeTab.id, anchor: resolvePointerMenuAnchor(event) })}
                            iconName="dots-three"
                            size={32}
                            interactiveTargetGapPx={0}
                        />
                    ) : null}
                    <IconButton
                        testID={testId('new-shell')}
                        accessibilityLabel={t('terminalWorkspace.actions.newShell')}
                        onPress={openShell}
                        iconName="plus"
                        size={32}
                        interactiveTargetGapPx={0}
                    />
                </View>
            </View>
            {place || nextHalf ? (
                <View style={styles.meta}>
                    {place ? <Text style={styles.metaText} numberOfLines={1}>{place}</Text> : null}
                    <View style={styles.grow} />
                    {nextHalf ? (
                        <HappierPressable
                            testID={testId('pager-next')}
                            accessibilityRole="button"
                            accessibilityLabel={t('terminalWorkspace.keys.pagerNext', { title: nextHalf.title })}
                            onPress={() => focusTerminal(nextHalf.terminalId)}
                        >
                            <Text style={styles.metaHint} numberOfLines={1}>{t('terminalWorkspace.keys.pagerNext', { title: nextHalf.title })}</Text>
                        </HappierPressable>
                    ) : null}
                </View>
            ) : null}
            <View style={styles.body} {...pagerResponder}>
                {props.renderTerminals === false && tabs.length > 0 ? (
                    <SessionTerminalList tabs={tabs} activeTabId={workspace.activeTabId} focusedTerminalId={focusedMember?.id ?? null}
                        onActivateTab={activateChip} onFocusTerminal={focusTerminal} note={props.listNote}
                        onTabMenu={(tabId, event) => setMenu({ tabId, anchor: resolvePointerMenuAnchor(event) })}
                        testIdPrefix={props.testIdPrefix ? `${props.testIdPrefix}-list` : undefined} />
                ) : focusedMember && focusedDescriptor && props.renderTerminals !== false ? workspace.tabs.flatMap(tab => tab.terminals.map(member => {
                    const descriptor = tabs.find(item => item.tabId === tab.id)?.members.find(item => item.terminalId === member.id);
                    if (!descriptor) return null;
                    const active = tab.id === workspace.activeTabId && member.id === focusedMember.id;
                    return <RetainedPanelSurface key={member.id} isActive={active} mode="flow">
                        {props.renderTerminal(member, descriptor, active)}
                    </RetainedPanelSurface>;
                })) : (
                    <View style={styles.empty}>
                        <SurfaceStateCard
                            testID={testId('empty')}
                            kind="empty"
                            title={t('terminalWorkspace.states.empty')}
                            iconName="terminal"
                            scene="noTerminal"
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
    },
    chips: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 8,
    },
    chipRail: {
        flex: 1,
        minWidth: 0,
    },
    chipActions: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: theme.space.s8,
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

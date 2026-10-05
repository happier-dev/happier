import * as React from 'react';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { useOpenTerminalJump } from '@/components/sessions/terminal/jump/useOpenTerminalJump';
import { resolveAttachedTerminalUnavailableMessage, useOpenAttachedSessionTerminal } from '@/components/sessions/terminal/openAttachedSessionTerminal';
import type { SessionTerminalDescriptor } from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import { useSessionTerminalDescribeContext, useSessionTerminalTabDescriptors } from '@/components/sessions/terminal/presentation/useSessionTerminalPresentation';
import { readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import {
    buildSessionTerminalNewMenuItems,
    buildSessionTerminalPaneMenuItems,
    TERMINAL_MENU_GLYPH_PX,
} from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { SessionTerminalWorkspaceView } from '@/components/sessions/terminal/strip/SessionTerminalWorkspaceView';
import { useSessionTerminalWorkspace } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { Modal } from '@/modal';
import { getStorage } from '@/sync/domains/state/storage';
import { selectLocalServiceLaunchTargets, useLocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../../shell/sessionScreenTestIds';

/** A terminal narrower than the session's own minimum content width is too narrow to read; a split stops there. */
const MINIMUM_TERMINAL_WIDTH_PX = PANE_SIZING_DEFAULTS.mainMinPx;

function basename(path: string | null | undefined): string | null {
    const trimmed = path?.replace(/[\\/]+$/, '') ?? '';
    if (!trimmed) return null;
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

/**
 * The session's bottom pane: its terminal tabs, split and list view (terminal lab B1–B3, A1, L, M,
 * ST). Layout lives in the AppPane terminal workspace; every verb that changes it goes through the
 * `session.terminals.*` Actions, so the strip, the menus, Jump and an agent change it the same way.
 */
export const SessionBottomPanel = React.memo((props: Readonly<{ sessionId: string; scopeId: string; onRequestClose?: () => void }>) => {
    const pane = useAppPaneScope(props.scopeId);
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeTabId = pane.scopeState?.bottom?.activeTabId ?? null;
    const rawWorkspace = pane.scopeState?.bottom.tabState.terminal;
    const workspace = React.useMemo(() => readSessionTerminalWorkspace(rawWorkspace), [rawWorkspace]);
    const { execute, dispatchResize } = useSessionTerminalWorkspace(props.scopeId);
    const serverId = parseSessionPaneScopeId(props.scopeId)?.address?.serverId ?? null;
    const context = useSessionTerminalDescribeContext(props.sessionId, serverId);
    const tabs = useSessionTerminalTabDescriptors({ sessionId: props.sessionId, scopeId: props.scopeId, workspace, context });
    const machineTarget = useSessionMachineTarget(props.sessionId, serverId);
    const attach = useOpenAttachedSessionTerminal(props.sessionId, serverId);
    const openJump = useOpenTerminalJump();
    const shortcutLabels = React.useContext(KeyboardShortcutLabelsContext);
    const requestClose = props.onRequestClose ?? pane.closeBottom;
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const [newMenuOpen, setNewMenuOpen] = React.useState(false);

    const run = React.useCallback(async (actionId: Parameters<typeof execute>[0], input?: Readonly<Record<string, unknown>>) => {
        const result = await execute(actionId, input);
        if (!result.ok) Modal.alert(t('terminalWorkspace.actionFailed'));
        return result;
    }, [execute]);

    const glyph = React.useCallback((name: IconName) => <Icon name={name} size={TERMINAL_MENU_GLYPH_PX} color={theme.colors.text.secondary} />, [theme.colors.text.secondary]);
    const agentMark = React.useCallback((agentId: string) => <AgentIcon agentId={agentId} size={TERMINAL_MENU_GLYPH_PX} />, []);

    // The + menu reads package scripts and machines only while it is open (lab M).
    const launcherState = useLocalServiceLauncherState({
        machineId: machineTarget?.machineId ?? null,
        serverId,
        sessionId: props.sessionId,
        scope: 'workspace',
        workspaceRoot: machineTarget?.basePath ?? null,
        enabled: newMenuOpen,
    });
    const scripts = React.useMemo(() => (newMenuOpen ? selectLocalServiceLaunchTargets(launcherState)
        .filter((target) => target.source === 'package_script' && target.sourceClass?.kind === 'package_script') : []), [launcherState, newMenuOpen]);
    const otherMachines = React.useMemo(() => {
        if (!newMenuOpen) return [];
        const machines = (serverId ? getStorage().getState().machineListByServerId?.[serverId] : null) ?? [];
        return machines.filter((machine) => machine.id !== context.sessionMachineId).map((machine) => ({
            id: machine.id,
            name: getMachineDisplayName(machine) ?? machine.id,
            online: isMachineOnline(machine),
            cwd: machine.metadata?.homeDir ?? null,
            lastSeen: null,
        }));
    }, [context.sessionMachineId, newMenuOpen, serverId]);

    const newMenuItems = React.useMemo(() => (newMenuOpen ? buildSessionTerminalNewMenuItems({
        folder: basename(machineTarget?.basePath),
        machineName: context.sessionMachineName,
        shellShortcut: shortcutLabels['terminal.newShell'],
        agent: context.agentId && context.agentName ? {
            agentId: context.agentId,
            name: context.agentName,
            available: attach.available,
            unavailableReason: resolveAttachedTerminalUnavailableMessage(attach.unavailableReason, { includeNotAttachable: true }),
        } : null,
        scripts: scripts.map((target) => ({
            id: target.id,
            title: target.sourceClass?.kind === 'package_script' ? target.sourceClass.scriptName : target.title,
            command: target.commandPreview ?? null,
        })),
        machines: otherMachines,
    }, glyph, agentMark) : []), [agentMark, attach.available, attach.unavailableReason, context, glyph, machineTarget?.basePath, newMenuOpen, otherMachines, scripts, shortcutLabels]);

    const openShell = React.useCallback(() => { void run('session.terminals.open', { target: { kind: 'workspace_shell' } }); }, [run]);
    const splitShell = React.useCallback((tabId?: string) => {
        void run('session.terminals.split', { ...(tabId ? { tabId } : {}), target: { kind: 'workspace_shell' } });
    }, [run]);
    const focusTerminal = React.useCallback((terminalId: string) => { void run('session.terminals.focus', { terminalId }); }, [run]);
    const activateTab = React.useCallback((tabId: string) => {
        const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
        if (tab) focusTerminal(tab.focusedTerminalId);
    }, [focusTerminal, workspace.tabs]);

    const onNewMenuSelect = React.useCallback((itemId: string) => {
        if (itemId === 'shell') return openShell();
        if (itemId === 'allScripts') return pane.openRight({ tabId: 'services' });
        if (itemId === 'agent') {
            const existing = workspace.tabs.flatMap((tab) => tab.terminals).find((terminal) => terminal.target.kind === 'session_attach');
            if (existing) return focusTerminal(existing.id);
            return attach.open();
        }
        if (itemId.startsWith('script:')) {
            const target = scripts.find((candidate) => `script:${candidate.id}` === itemId);
            if (target?.sourceClass?.kind !== 'package_script') return;
            void run('session.terminals.run_script', {
                machineId: target.machineId, cwd: target.sourceClass.cwd, runTargetId: target.sourceClass.runTargetId, title: target.sourceClass.scriptName,
            });
            return;
        }
        if (itemId.startsWith('machine:')) {
            const machine = otherMachines.find((candidate) => `machine:${candidate.id}` === itemId);
            if (!machine?.cwd) return;
            void run('session.terminals.open', { target: { kind: 'machine_shell', machineId: machine.id, cwd: machine.cwd } });
        }
    }, [attach, focusTerminal, openShell, otherMachines, pane, run, scripts, workspace.tabs]);

    const tabMenu = useSessionTerminalTabMenu({ scopeId: props.scopeId, workspace, tabs, run });

    const paneMenuItems = React.useMemo(() => buildSessionTerminalPaneMenuItems({
        showList: workspace.showList,
        canJump: openJump !== null,
        jumpShortcut: shortcutLabels['terminal.jump'],
        hideShortcut: shortcutLabels['terminal.toggle'],
        // Terminal settings are the renderer choice, which only native apps offer.
        canOpenSettings: Platform.OS !== 'web',
    }, glyph), [glyph, openJump, shortcutLabels, workspace.showList]);
    const onPaneMenuSelect = React.useCallback((itemId: string) => {
        switch (itemId) {
            case 'jump': return openJump?.({ sessionId: props.sessionId, serverId });
            case 'showList': return void run('session.terminals.list_view', { showList: !workspace.showList });
            case 'hide': return requestClose();
            case 'settings': return router.push('/settings/features' as never);
        }
    }, [openJump, props.sessionId, requestClose, router, run, serverId, workspace.showList]);

    const renderLeaf = React.useCallback((member: SessionTerminalMemberV1, state: Readonly<{ focused: boolean; descriptor: SessionTerminalDescriptor | null }>) => (
        <SessionEmbeddedTerminalPane
            sessionId={props.sessionId}
            scopeId={props.scopeId}
            currentDockLocation="bottom"
            terminal={member}
            chrome="none"
            title={state.descriptor?.title}
            machineName={member.target.kind === 'machine_shell' || member.target.kind === 'terminal_view'
                ? context.machineName(member.target.machineId) : context.sessionMachineName}
            focused={state.focused}
            onRequestClose={requestClose}
            testIdPrefix={sessionScreenTestIdsEnabled ? `session-bottompanel-terminal-${member.id}` : null}
        />
    ), [context, props.scopeId, props.sessionId, requestClose, sessionScreenTestIdsEnabled]);

    return (
        <View
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-bottom-panel-root')}
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        >
            {activeTabId === 'terminal' ? (
                <View
                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-bottompanel-surface-terminal')}
                    style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                >
                        <SessionTerminalWorkspaceView
                            scopeId={props.scopeId}
                            workspace={workspace}
                            tabs={tabs}
                            renderLeaf={renderLeaf}
                            minimumTerminalWidthPx={MINIMUM_TERMINAL_WIDTH_PX}
                            onActivateTab={activateTab}
                            onFocusTerminal={focusTerminal}
                            onCloseTab={(tabId) => { void run('session.terminals.close_tab', { tabId }); }}
                            onResize={dispatchResize}
                            onNewShell={openShell}
                            newMenuOpen={newMenuOpen}
                            onNewMenuOpenChange={setNewMenuOpen}
                            newMenuItems={newMenuItems}
                            onNewMenuSelect={onNewMenuSelect}
                            canSplit={workspace.activeTabId !== null}
                            onSplit={() => splitShell()}
                            tabMenuItems={tabMenu.items}
                            onTabMenuSelect={tabMenu.select}
                            paneMenuItems={paneMenuItems}
                            onPaneMenuSelect={onPaneMenuSelect}
                            onHide={requestClose}
                            onOpenUrl={(url) => { void openExternalUrl(url, Platform.OS === 'web' ? { platformOS: 'web' } : undefined); }}
                            emptyAction={openShell}
                            testIdPrefix={sessionScreenTestIdsEnabled ? 'session-bottompanel-terminals' : undefined}
                        />
                </View>
            ) : null}
        </View>
    );
});

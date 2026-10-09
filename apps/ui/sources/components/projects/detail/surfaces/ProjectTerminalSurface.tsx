import * as React from 'react';
import { Platform, View } from 'react-native';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { useUnistyles } from 'react-native-unistyles';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { SessionTerminalPageView } from '@/components/sessions/panes/terminal/SessionTerminalPage';
import { EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { useSessionTerminalWorkspace } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import { SessionTerminalWorkspaceView } from '@/components/sessions/terminal/strip/SessionTerminalWorkspaceView';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { buildSessionTerminalNewMenuItems, buildSessionTerminalPaneMenuItems, TERMINAL_MENU_GLYPH_PX } from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { describeSessionTerminal, describeSessionTerminalTab, type SessionTerminalDescriptor, type SessionTerminalDescribeContext } from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import { forgetTerminalSurfaceSummary, useTerminalSurfaceSummaries } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { createEmptyTerminalSurfaceState, replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachineListForServer, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { Modal } from '@/modal';
import { t } from '@/text';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from '../projectTerminalScope';
import { MachineShareTrustDisclosure } from '@/components/sharing/machines/MachineShareTrustDisclosure';

/** Project host of the same terminal workspace; the accepted checkout, not a Session, is its target. */
export const ProjectTerminalSurface = React.memo((props: Readonly<{
    scopeId: string; workspaceRefId: string; machineId: string; rootPath: string; serverId: string;
    terminalInstanceId?: string; closeOnUnmount?: boolean;
    workspace?: WorkspaceAddressV1 | null;
}>) => {
    const pane = useAppPaneScope(props.scopeId);
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const refs = useWorkspaceRefs();
    const machines = useMachineListForServer(props.workspace?.serverId ?? props.serverId);
    const { workspace, execute, dispatchResize } = useSessionTerminalWorkspace(props.scopeId, EMPTY_TERMINAL_WORKSPACE);
    const authority = React.useMemo(() => props.workspace
        ? resolveProjectTerminalScope(props.scopeId, props.workspace) : null,
    [props.scopeId, props.workspace, refs]);
    const [retired, setRetired] = React.useState(false);
    const privateKeys = React.useRef<readonly string[]>([]);
    const clearPrivatePresentation = React.useCallback(() => {
        for (const key of privateKeys.current) {
            replaceTerminalSurfaceState(key, createEmptyTerminalSurfaceState());
            forgetTerminalSurfaceSummary(key);
        }
        privateKeys.current = [];
    }, []);
    React.useEffect(() => {
        setRetired(false);
        if (!authority) clearPrivatePresentation();
        const subscription = authority?.lifetime.onRetire(() => {
            clearPrivatePresentation();
            setRetired(true);
        });
        return () => subscription?.dispose();
    }, [authority, clearPrivatePresentation]);
    const context = React.useMemo((): SessionTerminalDescribeContext => {
        const names = new Map((machines ?? []).map(machine => [machine.id, getMachineDisplayName(machine) ?? machine.id]));
        const machineId = authority?.workspace.machineId ?? null;
        return { agentId: null, agentName: null, agentAsking: false, agentTerminalHost: null,
            sessionMachineId: machineId, sessionMachineName: machineId ? names.get(machineId) ?? null : null,
            machineName: id => names.get(id) ?? null };
    }, [machines, authority]);
    const keys = React.useMemo(() => workspace.tabs.flatMap(tab => tab.terminals.map(member => authority
        ? buildProjectTerminalKey(authority.scope, member.target.kind === 'workspace_shell'
            ? member.target.workspace ?? authority.workspace : authority.workspace, member.id) : '')),
    [authority, workspace.tabs]);
    React.useEffect(() => { if (authority?.lifetime.isCurrent()) privateKeys.current = keys; }, [authority, keys]);
    const summaries = useTerminalSurfaceSummaries(keys);
    const tabs = React.useMemo(() => {
        let index = 0;
        return workspace.tabs.map(tab => describeSessionTerminalTab(tab,
            tab.terminals.map(member => describeSessionTerminal(member, summaries[index++] ?? null, context))));
    }, [context, summaries, workspace.tabs]);
    const run = React.useCallback(async (actionId: Parameters<typeof execute>[0], input: Readonly<Record<string, unknown>> = {}) => {
        if (!authority?.lifetime.isCurrent() || retired) return { ok: false as const, error: 'project_terminal_scope_unavailable' };
        const target = input.target;
        const selectedInput = target && typeof target === 'object' && 'kind' in target && target.kind === 'workspace_shell'
            ? { ...input, target: { ...target, workspace: authority.workspace } } : input;
        const result = await execute(actionId, selectedInput);
        if (!result.ok) Modal.alert(t('terminalWorkspace.actionFailed'));
        return result;
    }, [authority, execute, retired]);
    const tabMenu = useSessionTerminalTabMenu({ scopeId: props.scopeId, workspace, tabs, run });
    const openShell = React.useCallback(() => { void run('session.terminals.open', { target: { kind: 'workspace_shell' } }); }, [run]);
    const focus = React.useCallback((terminalId: string) => { void run('session.terminals.focus', { terminalId }); }, [run]);
    const [newMenuOpen, setNewMenuOpen] = React.useState(false);
    const glyph = React.useCallback((name: IconName) => <Icon name={name} size={TERMINAL_MENU_GLYPH_PX} color={theme.colors.text.secondary} />, [theme.colors.text.secondary]);
    const newMenuItems = React.useMemo(() => buildSessionTerminalNewMenuItems({ folder: authority?.workspace.rootPath ?? '',
        machineName: context.sessionMachineName, agent: null, scripts: [], machines: [] }, glyph, () => null)
        .filter(item => item.id === 'shell').map(item => ({ ...item, category: authority?.workspace.rootPath ?? '' })), [context.sessionMachineName, glyph, authority]);
    const paneMenuItems = React.useMemo(() => buildSessionTerminalPaneMenuItems({ showList: workspace.showList,
        canJump: false, canOpenSettings: false }, glyph), [glyph, workspace.showList]);
    const renderLeaf = React.useCallback((member: SessionTerminalMemberV1, state: Readonly<{ focused: boolean; descriptor: SessionTerminalDescriptor | null }>) => {
        if (!authority) return null;
        const captured = member.target.kind === 'workspace_shell' ? member.target.workspace ?? authority.workspace : authority.workspace;
        return <WorkspaceEmbeddedTerminalPane scopeId={props.scopeId} workspaceRefId={captured.workspaceId}
            machineId={member.target.kind === 'terminal_view' ? member.target.machineId : captured.machineId}
            rootPath={member.target.kind === 'terminal_view' ? member.target.cwd : captured.rootPath} serverId={captured.serverId}
            workspace={captured} terminalInstanceId={member.id} terminalKey={buildProjectTerminalKey(authority.scope, captured, member.id)}
            {...(member.target.kind === 'terminal_view' ? { attachedTerminalId: member.target.terminalId } : {})}
            title={state.descriptor?.title} focused={state.focused} chrome="none" />;
    }, [authority, props.scopeId]);
    if (!authority || retired) return <SurfaceStateCard kind="unavailable" iconName="terminal" title={t('machines.terminals.denied')} />;
    const disclosure = <MachineShareTrustDisclosure disclosure={t('machines.terminals.sharedOs', { machine: context.sessionMachineName ?? props.machineId })}
        notes={[]} idPrefix="project-terminal-" />;
    if (props.terminalInstanceId) {
        const member = workspace.tabs.flatMap(tab => tab.terminals).find(candidate => candidate.id === props.terminalInstanceId);
        const descriptor = tabs.flatMap(tab => tab.members).find(candidate => candidate.terminalId === member?.id) ?? null;
        return member ? <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{disclosure}{renderLeaf(member, { focused: true, descriptor })}</View>
            : <SurfaceStateCard kind="unavailable" iconName="terminal" title={t('machines.terminals.unavailable')} />;
    }
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {disclosure}
        {deviceType === 'phone' ? <SessionTerminalPageView workspace={workspace} tabs={tabs} context={context}
            onAction={(actionId, input) => { void run(actionId, input); }} tabMenu={tabMenu}
            renderTerminal={(member, descriptor) => renderLeaf(member, { focused: true, descriptor })}
            testIdPrefix="project-terminal-workspace" /> : <SessionTerminalWorkspaceView
                scopeId={props.scopeId} workspace={workspace} tabs={tabs} renderLeaf={renderLeaf}
                minimumTerminalWidthPx={PANE_SIZING_DEFAULTS.mainMinPx} onFocusTerminal={focus} onResize={dispatchResize}
                onActivateTab={id => { const tab = workspace.tabs.find(candidate => candidate.id === id); if (tab) focus(tab.focusedTerminalId); }}
                onCloseTab={tabId => { void run('session.terminals.close_tab', { tabId }); }}
                onNewShell={openShell} newMenuOpen={newMenuOpen} onNewMenuOpenChange={setNewMenuOpen}
                newMenuItems={newMenuItems} onNewMenuSelect={openShell} canSplit={workspace.activeTabId !== null}
                onSplit={() => { void run('session.terminals.split', { target: { kind: 'workspace_shell' } }); }}
                tabMenuItems={tabMenu.items} onTabMenuSelect={tabMenu.select} paneMenuItems={paneMenuItems}
                onPaneMenuSelect={id => { if (id === 'hide') pane.closeBottom(); if (id === 'showList') void run('session.terminals.list_view', { showList: !workspace.showList }); }}
                onHide={pane.closeBottom} onOpenUrl={url => { void openExternalUrl(url, Platform.OS === 'web' ? { platformOS: 'web' } : undefined); }}
                emptyAction={openShell} testIdPrefix="project-terminal-workspace" />}
    </View>;
});

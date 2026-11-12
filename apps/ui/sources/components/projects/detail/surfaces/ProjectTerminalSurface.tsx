import * as React from 'react';
import { View } from 'react-native';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal/workspace';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { isWorkspacePathWithinRootV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useUnistyles } from 'react-native-unistyles';
import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { SessionTerminalPageView } from '@/components/sessions/panes/terminal/SessionTerminalPage';
import { EMPTY_TERMINAL_WORKSPACE, selectSessionTerminalWorkspaceHost, type SessionTerminalWorkspaceHost } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useSessionTerminalWorkspace } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import { SessionTerminalWorkspaceView } from '@/components/sessions/terminal/strip/SessionTerminalWorkspaceView';
import { useSessionTerminalTabMenu } from '@/components/sessions/terminal/strip/useSessionTerminalTabMenu';
import { buildSessionTerminalNewMenuItems, buildSessionTerminalPaneMenuItems, TERMINAL_MENU_GLYPH_PX } from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { describeSessionTerminalTabs, type SessionTerminalDescriptor, type SessionTerminalDescribeContext } from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import { forgetTerminalSurfaceSummary, useTerminalSurfaceSummaries } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { createEmptyTerminalSurfaceState, replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { useWorkspaceRefs, useMachineListForServer } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { presentTerminalActionFailure } from '@/components/sessions/terminal/terminalActionFailure';
import { t } from '@/text';
import { buildProjectMemberTerminalKey, buildProjectTerminalKey, resolveProjectTerminalScope } from '../projectTerminalScope';
import { SessionTerminalTrustNotice } from '@/components/sessions/terminal/strip/SessionTerminalTrustNotice';
import { usePaneDestinationWindowActions } from '@/components/appShell/panes/useOpenPaneDestinationWindow';
import { useProjectRunningTerminals } from '../useProjectRunningTerminals';
import { useMachineShellAvailability } from '@/hooks/machine/useMachineShellAvailability';
import { resolveTerminalFailureMessage } from '@/components/sessions/terminal/terminalErrorCopy';
import { readSafeFailureDetails } from '@/utils/errors/alertActionFailure';
import { initializeSessionTerminalWorkspaceForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { describeMachineShareTrust } from '@/components/sharing/machines/machineShareTrust';

/** Project host of the same terminal workspace; the accepted checkout, not a Session, is its target. */
export const ProjectTerminalSurface = React.memo((props: Readonly<{
    scopeId: string; workspaceRefId: string; machineId: string; rootPath: string; serverId: string;
    terminalInstanceId?: string; closeOnUnmount?: boolean;
    workspace?: WorkspaceAddressV1 | null;
    presentation?: SessionTerminalWorkspaceHost;
    onHideWorkspace?: () => void;
}>) => {
    const { theme } = useUnistyles();
    const openActions = usePaneDestinationWindowActions(props.presentation === 'bottom' ? props.scopeId : null, 'bottom');
    const deviceType = useDeviceType();
    // A phone page's floating tab bar covers the surface's bottom. The surface reserves it once, as the
    // Session cockpit's fullscreen surfaces do, so its last rows, key rail and seated Find bar sit above it.
    const chromeClearance = useFloatingChromeClearance();
    const refs = useWorkspaceRefs();
    const machines = useMachineListForServer(props.workspace?.serverId ?? props.serverId);
    const { workspace, execute, dispatchResize, hideWorkspace } = useSessionTerminalWorkspace(props.scopeId, EMPTY_TERMINAL_WORKSPACE);
    const renderTerminals = useAppPaneContext(value => props.presentation === undefined
        || selectSessionTerminalWorkspaceHost(value.state, props.scopeId, props.terminalInstanceId) === props.presentation);
    const requestHide = props.onHideWorkspace ?? hideWorkspace;
    const authority = React.useMemo(() => props.workspace
        ? resolveProjectTerminalScope(props.scopeId, props.workspace) : null,
    [props.scopeId, props.workspace, refs]);
    const [retired, setRetired] = React.useState(false);
    const dispatch = useAppPaneContext(value => value.dispatch);
    const running = useProjectRunningTerminals(props.scopeId, authority, renderTerminals && !retired && workspace.tabs.length === 0);
    const shell = useMachineShellAvailability({
        serverId: authority?.workspace.serverId ?? props.serverId,
        machineId: authority?.workspace.machineId ?? props.machineId,
        enabled: renderTerminals && !retired && workspace.tabs.length === 0 && Boolean(authority),
    });
    const recovering = workspace.tabs.length === 0 && running.status === 'ready' && running.workspace.tabs.length > 0;
    const presentedWorkspace = recovering ? running.workspace : workspace;
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
    const keys = React.useMemo(() => presentedWorkspace.tabs.flatMap(tab => tab.terminals.map(member => authority
        ? buildProjectMemberTerminalKey(authority, member) : '')),
    [authority, presentedWorkspace.tabs]);
    React.useEffect(() => { if (authority?.lifetime.isCurrent()) privateKeys.current = keys; }, [authority, keys]);
    const summaries = useTerminalSurfaceSummaries(keys);
    const tabs = React.useMemo(() => describeSessionTerminalTabs(presentedWorkspace.tabs, summaries, context), [context, summaries, presentedWorkspace.tabs]);
    const run = React.useCallback(async (actionId: Parameters<typeof execute>[0], input: Readonly<Record<string, unknown>> = {}) => {
        if (!authority?.lifetime.isCurrent() || retired) return { ok: false as const, error: 'project_terminal_scope_unavailable' };
        if (recovering && (actionId === 'session.terminals.focus' || actionId === 'session.terminals.open'
            || actionId === 'session.terminals.close_tab')) {
            const member = running.workspace.tabs.flatMap(tab => tab.terminals).find(candidate => candidate.id === input.terminalId);
            const tab = actionId === 'session.terminals.close_tab'
                ? running.workspace.tabs.find(candidate => candidate.id === input.tabId) : null;
            if (member || tab || actionId === 'session.terminals.open') {
                if (!initializeSessionTerminalWorkspaceForScope(props.scopeId, EMPTY_TERMINAL_WORKSPACE)) {
                    return { ok: false as const, error: 'project_terminal_scope_unavailable' };
                }
                // Discovery ends once membership is restored; keep the other listed Shells reachable too.
                for (const tab of running.workspace.tabs) for (const terminal of tab.terminals) {
                    dispatch({ type: 'terminalWorkspace', scopeId: props.scopeId, command: { type: 'open', terminal } });
                }
            }
        }
        const target = input.target;
        const selectedInput = target && typeof target === 'object' && 'kind' in target && target.kind === 'workspace_shell'
            ? { ...input, target: { ...target, workspace: authority.workspace } } : input;
        const result = await execute(actionId, selectedInput);
        if (!result.ok) presentTerminalActionFailure(result);
        return result;
    }, [authority, dispatch, execute, props.scopeId, recovering, retired, running]);
    const tabMenu = useSessionTerminalTabMenu({ scopeId: props.scopeId, workspace, tabs, run });
    const openShell = React.useCallback(() => { void run('session.terminals.open', { target: { kind: 'workspace_shell' } }); }, [run]);
    const focus = React.useCallback((terminalId: string) => { void run('session.terminals.focus', { terminalId }); }, [run]);
    const [newMenuOpen, setNewMenuOpen] = React.useState(false);
    const glyph = React.useCallback((name: IconName) => <Icon name={name} size={TERMINAL_MENU_GLYPH_PX} color={theme.colors.text.secondary} />, [theme.colors.text.secondary]);
    const newMenuItems = React.useMemo(() => buildSessionTerminalNewMenuItems({ folder: authority?.workspace.rootPath ?? '',
        machineName: context.sessionMachineName, agent: null, scripts: [], machines: [] }, glyph, () => null)
        .filter(item => item.id === 'shell').map(item => ({ ...item, category: authority?.workspace.rootPath ?? '' })), [context.sessionMachineName, glyph, authority]);
    // A side pane hides toward the window's edge; the strip's Hide and the menu's Hide terminals say the same.
    const hideToward = props.presentation === 'right' ? 'end' as const : 'bottom' as const;
    const paneMenuItems = React.useMemo(() => [...buildSessionTerminalPaneMenuItems({ showList: workspace.showList,
        canJump: false, canOpenSettings: false, hideToward }, glyph), ...openActions.presentationItems], [glyph, hideToward, openActions.presentationItems, workspace.showList]);
    const renderLeaf = React.useCallback((member: SessionTerminalMemberV1, state: Readonly<{ focused: boolean; descriptor: SessionTerminalDescriptor | null }>) => {
        if (!authority) return null;
        const selected = member.target.kind === 'workspace_shell' || member.target.kind === 'terminal_view'
            ? member.target.workspace ?? authority.workspace : authority.workspace;
        const captured = resolveProjectTerminalScope(props.scopeId, selected)?.workspace;
        if (!captured || member.target.kind === 'terminal_view' && (member.target.machineId !== captured.machineId
            || !isWorkspacePathWithinRootV1(member.target.cwd, captured.rootPath))) return null;
        return <WorkspaceEmbeddedTerminalPane scopeId={props.scopeId} workspaceRefId={captured.workspaceId}
            presentationId={tabMenu.presentationId}
            machineId={member.target.kind === 'terminal_view' ? member.target.machineId : captured.machineId}
            rootPath={member.target.kind === 'terminal_view' ? member.target.cwd : captured.rootPath} serverId={captured.serverId}
            workspace={captured} terminalInstanceId={member.id} terminalKey={buildProjectTerminalKey(authority.scope, captured, member.id)}
            {...(member.target.kind === 'terminal_view' ? { attachedTerminalId: member.target.terminalId } : {})}
            title={state.descriptor?.title} focused={state.focused} chrome="none" />;
    }, [authority, props.scopeId, tabMenu.presentationId]);
    const terminalMachine = context.sessionMachineName ?? props.machineId;
    const canOpenNewShell = shell.state.kind === 'available';
    const shellStateBlocksEmpty = workspace.tabs.length === 0 && shell.state.kind !== 'available';
    if (!authority || retired || running.status === 'loading' || running.status === 'unavailable' || shellStateBlocksEmpty) {
        const loading = authority && !retired && (running.status === 'loading' || shell.state.kind === 'loading');
        const shellFailure = authority && !retired && !loading && shell.state.kind === 'unavailable' ? shell.failure : null;
        const failureDetails = shellFailure ? readSafeFailureDetails(shellFailure.details) : {};
        return <SurfaceStateCard kind={loading ? 'loading' : 'unavailable'} iconName="terminal"
            title={!authority || retired ? t('machines.terminals.denied')
                : loading ? t('common.loading')
                    : shell.state.kind === 'offline' ? t('terminalWorkspace.states.offline', { machine: terminalMachine })
                        : shellFailure ? resolveTerminalFailureMessage(shellFailure) : t('machines.terminals.unavailable')}
            diagnosticCode={shellFailure?.errorCode}
            diagnosticDetail={Object.keys(failureDetails).length ? JSON.stringify(failureDetails, null, 2) : undefined}
            action={authority && !retired && canOpenNewShell ? { label: t('terminalWorkspace.states.emptyAction'), onPress: openShell } : undefined} />;
    }
    // Shells this device did not open, found running on the Machine: the list says what they are before one is opened.
    const recoveredNote = recovering ? t('terminalWorkspace.recovered.note', {
        machine: terminalMachine, count: presentedWorkspace.tabs.reduce((total, tab) => total + tab.terminals.length, 0) }) : undefined;
    const machine = machines?.find(machine => machine.id === authority.workspace.machineId);
    const { separateUsers } = presentMachineAuthorityV1({ platform: machine?.metadata?.platform,
        isolationPolicy: machine?.metadata?.agentIsolation, isolation: machine?.daemonState?.agentIsolation });
    const notice = describeMachineShareTrust(separateUsers.placement, true, terminalMachine);
    // The desktop pane carries the line in its own strip; a page without a strip carries it as one quiet row.
    const noticeRow = <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}><SessionTerminalTrustNotice notice={notice} /></View>;
    if (props.terminalInstanceId) {
        if (!renderTerminals) return null;
        const member = workspace.tabs.flatMap(tab => tab.terminals).find(candidate => candidate.id === props.terminalInstanceId);
        const descriptor = tabs.flatMap(tab => tab.members).find(candidate => candidate.terminalId === member?.id) ?? null;
        return member ? <View style={{ flex: 1, minHeight: 0, minWidth: 0, paddingBottom: chromeClearance }}>{noticeRow}{renderLeaf(member, { focused: true, descriptor })}</View>
            : <SurfaceStateCard kind="unavailable" iconName="terminal" title={t('machines.terminals.unavailable')} />;
    }
    return <View style={{ flex: 1, minHeight: 0, minWidth: 0, paddingBottom: chromeClearance }}>
        {deviceType === 'phone' ? noticeRow : null}
        {deviceType === 'phone' ? <SessionTerminalPageView workspace={presentedWorkspace} tabs={tabs} context={context} renderTerminals={renderTerminals && !recovering} listNote={recoveredNote}
            onAction={(actionId, input) => { void run(actionId, input); }} tabMenu={tabMenu}
            renderTerminal={(member, descriptor, focused) => renderLeaf(member, { focused, descriptor })}
            testIdPrefix="project-terminal-workspace" /> : <SessionTerminalWorkspaceView
                scopeId={props.scopeId} workspace={presentedWorkspace} tabs={tabs} renderLeaf={renderLeaf} notice={notice} renderTerminals={renderTerminals && !recovering} listNote={recoveredNote}
                minimumTerminalWidthPx={PANE_SIZING_DEFAULTS.mainMinPx} onFocusTerminal={focus} onResize={dispatchResize}
                onActivateTab={id => { const tab = presentedWorkspace.tabs.find(candidate => candidate.id === id); if (tab) focus(tab.focusedTerminalId); }}
                onCloseTab={tabId => { void run('session.terminals.close_tab', { tabId }); }}
                onNewShell={openShell} newMenuOpen={newMenuOpen} onNewMenuOpenChange={setNewMenuOpen}
                newMenuItems={newMenuItems} onNewMenuSelect={openShell} canSplit={workspace.activeTabId !== null}
                onSplit={() => { void run('session.terminals.split', { target: { kind: 'workspace_shell' } }); }}
                tabMenuItems={tabMenu.items} onTabMenuSelect={tabMenu.select} paneMenuItems={paneMenuItems}
                onPaneMenuSelect={id => { if (openActions.select(id)) return; if (id === 'hide') requestHide(); if (id === 'showList') void run('session.terminals.list_view', { showList: !workspace.showList }); }}
                onHide={requestHide} hideToward={hideToward} onOpenUrl={url => { void openExternalUrl(url); }}
                canOpenNewShell={canOpenNewShell} emptyAction={canOpenNewShell ? openShell : undefined} testIdPrefix="project-terminal-workspace" />}
    </View>;
});

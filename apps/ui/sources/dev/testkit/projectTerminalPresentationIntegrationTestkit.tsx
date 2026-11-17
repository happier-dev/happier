import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { readSessionTerminalWorkspaceForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { readTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { peekTerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { createMountedCurrentUiContextWrapper } from './harness/mountedCurrentUiContext';
import { renderScreen } from './render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

function RetainedProjectTerminal(props: Readonly<{ scopeId: string; workspace: WorkspaceAddressV1; presented: boolean }>) {
    const dispatch = useAppPaneContext(value => value.dispatch);
    React.useLayoutEffect(() => { dispatch({ type: 'activateScope', scopeId: props.scopeId }); }, [dispatch, props.scopeId]);
    return <PluginSurfaceFocusEligibilityProvider active={props.presented} presentationActive={props.presented}>
        <ProjectTerminalSurface scopeId={props.scopeId} workspaceRefId={props.workspace.workspaceId}
            workspace={props.workspace} machineId={props.workspace.machineId} rootPath={props.workspace.rootPath}
            serverId={props.workspace.serverId} />
    </PluginSurfaceFocusEligibilityProvider>;
}

/** Mount the incumbent Project terminal and its real pane owner after real Account bootstrap. */
export async function mountUiRetainedProjectTerminal(workspace: WorkspaceAddressV1) {
    const scopeId = buildProjectPaneScopeId(workspace.workspaceId, workspace.serverId);
    const authority = resolveProjectTerminalScope(scopeId, workspace);
    if (!authority) throw new Error('Retained Project terminal requires an accepted Account checkout');
    const node = (presented: boolean) => <RetainedProjectTerminal scopeId={scopeId} workspace={workspace} presented={presented} />;
    const screen = await renderScreen(node(true), { wrapper: await createMountedCurrentUiContextWrapper({ withAccountLifecycle: true }) });
    let terminalKey: string | undefined;
    const newControl = () => screen.findByTestId('project-terminal-workspace-strip-new')
        ? 'project-terminal-workspace-strip-new' : 'project-terminal-workspace-new-shell';
    return {
        scopeId,
        accountId: authority.scope.accountId,
        // A narrow strip exposes its Machine name through the trust icon's
        // accessible label, while a wide strip paints the same label inline.
        text: () => [screen.getTextContent(), ...screen.findAll(node => typeof node.type === 'string'
            && typeof node.props.accessibilityLabel === 'string').map(node => node.props.accessibilityLabel)].join(' '),
        ready: () => Boolean(screen.findByTestId(newControl())),
        machineName: () => getMachineDisplayName(storage.getState().machineListByServerId[workspace.serverId]
            ?.find(machine => machine.id === workspace.machineId)),
        async open() { await screen.pressByTestIdAsync(newControl()); },
        async setPresented(presented: boolean) { await screen.update(node(presented)); },
        read() {
            const tabs = readSessionTerminalWorkspaceForScope(scopeId)?.tabs ?? [];
            const member = tabs[0]?.terminals[0];
            if (member) terminalKey = buildProjectTerminalKey(authority.scope, workspace, member.id);
            return { tabs, current: authority.lifetime.isCurrent(),
                surface: terminalKey ? readTerminalSurfaceState(terminalKey) : null,
                summary: terminalKey ? peekTerminalSurfaceSummary(terminalKey) : null };
        },
        close: screen.unmount,
    };
}

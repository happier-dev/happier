import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { buildMachineTerminalSessionRequest } from '@/hooks/machine/machineTerminalSessionRequest';
import { resolveSessionTerminalIdentity } from './sessionTerminalMode';

/** Resolve immutable process operands through the incumbent Session/Project owners. */
export async function resolveSessionTerminalRequest(scopeId: string, member: SessionTerminalMemberV1) {
    if (member.target.kind === 'terminal_view') return null;
    const address = parseSessionPaneScopeId(scopeId)?.address;
    if (!address) {
        if (member.target.kind !== 'workspace_shell') return null;
        const project = resolveProjectTerminalScope(scopeId, member.target.workspace);
        if (!project || !project.lifetime.isCurrent()) return null;
        const terminalKey = buildProjectTerminalKey(project.scope, project.workspace, member.id);
        return { serverId: project.scope.serverId, accountId: project.scope.accountId,
            machineId: project.workspace.machineId, terminalKey, isCurrent: project.lifetime.isCurrent,
            request: buildMachineTerminalSessionRequest({ terminalKey, cwd: project.workspace.rootPath,
                workspace: project.workspace, launch: member.target.launch, initialCommand: member.target.initialCommand }) };
    }
    let machineId: string | undefined;
    let cwd: string | undefined;
    if (member.target.kind === 'machine_shell') { machineId = member.target.machineId; cwd = member.target.cwd; }
    else {
        const [{ getStorage }, { resolveMachineTargetForSessionFromState }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/sync/domains/session/resolveMachineTargetForSessionFromState'),
        ]);
        const target = resolveMachineTargetForSessionFromState(getStorage().getState(), address);
        machineId = target?.machineId; cwd = target?.basePath;
    }
    if (!machineId) return null;
    const terminalKey = resolveSessionTerminalIdentity({ sessionId: address.sessionId, scopeId, terminal: member }).terminalKey;
    const launch = member.target.kind === 'session_attach' ? { kind: 'session_attach' as const, sessionId: address.sessionId }
        : member.target.launch;
    const initialCommand = member.target.kind === 'session_attach' ? undefined : member.target.initialCommand;
    return { serverId: address.serverId, accountId: undefined, machineId, terminalKey, isCurrent: () => true,
        request: { ...buildMachineTerminalSessionRequest({ terminalKey, cwd: cwd ?? null, launch, initialCommand,
            ...(member.target.kind === 'workspace_shell' && member.target.workspace ? { workspace: member.target.workspace } : {}) }),
            sessionId: address.sessionId } };
}

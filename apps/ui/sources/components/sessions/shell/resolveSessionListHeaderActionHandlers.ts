import type { SessionListHeaderViewState } from './resolveSessionListHeaderViewState';
export type SessionListHeaderActionHandlers = Readonly<{
    onOpenProject: () => void;
    onCreateSession: () => void;
    onRename: () => void;
    onReset: () => void;
    onToggleCollapse: () => void;
}>;

type SessionListHeaderToggleCollapseHandler = (collapseKey: string, ...args: readonly unknown[]) => void;
type WorkspaceScopeHint = Readonly<{ serverId: string; machineId: string; rootPath: string }>;
/**
 * Where "New session" from a list group starts: a folder group's workspace scope, or a machine's
 * Chats group, which starts another no-folder session on that machine.
 */
export type NewSessionGroupTarget =
    | WorkspaceScopeHint
    | Readonly<{ kind: 'managed'; serverId: string; machineId: string }>;
export type CreateSessionFromWorkspaceScopeOptions = Readonly<{
    seedSessionId?: string | null;
}>;
export type CreateSessionFromWorkspaceScopeHandler = (
    target: NewSessionGroupTarget,
    options?: CreateSessionFromWorkspaceScopeOptions,
) => void;

/** The one reading of a list header's new-session target (folder scope, else its Chats scope). */
export function resolveNewSessionGroupTarget(header: Readonly<{
    workspaceScopeHint?: WorkspaceScopeHint | null;
    workspace?: Readonly<{ t: string; serverId?: string | null; machineId?: string | null }> | null;
}>): NewSessionGroupTarget | null {
    if (header.workspaceScopeHint) return header.workspaceScopeHint;
    const workspace = header.workspace;
    return workspace?.t === 'managedSessions' && workspace.serverId && workspace.machineId
        ? { kind: 'managed', serverId: workspace.serverId, machineId: workspace.machineId }
        : null;
}

const noop = () => {};

export function resolveSessionListHeaderActionHandlers(input: Readonly<{
    headerViewState: SessionListHeaderViewState | null;
    onOpenProject: (workspaceRefId: string, serverId?: string) => void;
    onCreateSessionFromWorkspaceScope: CreateSessionFromWorkspaceScopeHandler;
    onRenameWorkspace: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        currentLabel: string;
    }>) => void;
    onResetWorkspaceName: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    }>) => void;
    onToggleCollapse: SessionListHeaderToggleCollapseHandler;
}>): SessionListHeaderActionHandlers | null {
    const headerViewState = input.headerViewState;
    if (!headerViewState) {
        return null;
    }

    const onToggleCollapse = () => {
        input.onToggleCollapse(headerViewState.collapseKey);
    };

    const next = headerViewState.kind === 'project'
        ? {
            onOpenProject: () => {
                if (!headerViewState.workspaceRefId) {
                    return;
                }
                input.onOpenProject(headerViewState.workspaceRefId, headerViewState.scopeHint?.serverId);
            },
            onCreateSession: () => {
                if (!headerViewState.newSessionTarget) {
                    return;
                }
                input.onCreateSessionFromWorkspaceScope(headerViewState.newSessionTarget, {
                    seedSessionId: headerViewState.seedSessionId,
                });
            },
            onRename: () => {
                input.onRenameWorkspace({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                    currentLabel: headerViewState.displayTitle,
                });
            },
            onReset: () => {
                input.onResetWorkspaceName({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                });
            },
            onToggleCollapse,
        }
        : {
            onOpenProject: noop,
            onCreateSession: noop,
            onRename: noop,
            onReset: noop,
            onToggleCollapse,
        };

    return next;
}

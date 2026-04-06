import type { SessionListHeaderViewState } from './resolveSessionListHeaderViewState';

export type SessionListHeaderActionHandlers = Readonly<{
    onOpenProject: () => void;
    onRename: () => void;
    onReset: () => void;
    onToggleCollapse: () => void;
}>;

type SessionListHeaderToggleCollapseHandler = (collapseKey: string, ...args: readonly unknown[]) => void;

const SESSION_LIST_HEADER_ACTION_HANDLERS_CACHE = new Map<string, SessionListHeaderActionHandlers>();
const FUNCTION_ID_BY_REFERENCE = new WeakMap<Function, number>();

let nextFunctionId = 1;

function getFunctionIdentity(fn: Function): number {
    const cached = FUNCTION_ID_BY_REFERENCE.get(fn);
    if (cached) {
        return cached;
    }
    const next = nextFunctionId;
    nextFunctionId += 1;
    FUNCTION_ID_BY_REFERENCE.set(fn, next);
    return next;
}

function buildProjectHeaderActionCacheKey(input: Readonly<{
    headerViewState: Extract<SessionListHeaderViewState, { kind: 'project' }>;
    onOpenProject: (workspaceRefId: string) => void;
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
}>): string {
    const { headerViewState } = input;
    const scopeHint = headerViewState.scopeHint;
    return [
        'project',
        headerViewState.collapseKey,
        headerViewState.displayTitle,
        headerViewState.hasCustomLabel ? '1' : '0',
        headerViewState.workspaceRefId ?? '',
        headerViewState.legacyWorkspaceKey,
        scopeHint?.serverId ?? '',
        scopeHint?.machineId ?? '',
        scopeHint?.rootPath ?? '',
        getFunctionIdentity(input.onOpenProject),
        getFunctionIdentity(input.onRenameWorkspace),
        getFunctionIdentity(input.onResetWorkspaceName),
        getFunctionIdentity(input.onToggleCollapse),
    ].join('|');
}

function buildSectionHeaderActionCacheKey(input: Readonly<{
    headerViewState: Extract<SessionListHeaderViewState, { kind: 'section' }>;
    onToggleCollapse: SessionListHeaderToggleCollapseHandler;
}>): string {
    return [
        'section',
        input.headerViewState.collapseKey,
        input.headerViewState.title,
        input.headerViewState.collapsed ? '1' : '0',
        getFunctionIdentity(input.onToggleCollapse),
    ].join('|');
}

export function resolveSessionListHeaderActionHandlers(input: Readonly<{
    headerViewState: SessionListHeaderViewState | null;
    onOpenProject: (workspaceRefId: string) => void;
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

    const cacheKey = headerViewState.kind === 'project'
        ? buildProjectHeaderActionCacheKey({
            headerViewState,
            onOpenProject: input.onOpenProject,
            onRenameWorkspace: input.onRenameWorkspace,
            onResetWorkspaceName: input.onResetWorkspaceName,
            onToggleCollapse: input.onToggleCollapse,
        })
        : buildSectionHeaderActionCacheKey({
            headerViewState,
            onToggleCollapse: input.onToggleCollapse,
        });

    const cached = SESSION_LIST_HEADER_ACTION_HANDLERS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = headerViewState.kind === 'project'
        ? {
            onOpenProject: () => {
                if (headerViewState.kind !== 'project' || !headerViewState.workspaceRefId) {
                    return;
                }
                input.onOpenProject(headerViewState.workspaceRefId);
            },
            onRename: () => {
                if (headerViewState.kind !== 'project') {
                    return;
                }
                input.onRenameWorkspace({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                    currentLabel: headerViewState.displayTitle,
                });
            },
            onReset: () => {
                if (headerViewState.kind !== 'project') {
                    return;
                }
                input.onResetWorkspaceName({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                });
            },
            onToggleCollapse: () => {
                input.onToggleCollapse(headerViewState.collapseKey);
            },
        }
        : {
            onOpenProject: () => {},
            onRename: () => {},
            onReset: () => {},
            onToggleCollapse: () => {
                input.onToggleCollapse(headerViewState.collapseKey);
            },
        };

    const cachedActions = next as SessionListHeaderActionHandlers;
    SESSION_LIST_HEADER_ACTION_HANDLERS_CACHE.set(cacheKey, cachedActions);
    return cachedActions;
}

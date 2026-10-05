import * as React from 'react';
import { createSessionPaneScopeId, parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import type { SessionTerminalMemberV1, SessionTerminalTargetV1 } from '@happier-dev/protocol';
import { getActiveSessionTerminal, readSessionTerminalWorkspace } from './sessionTerminalWorkspace';
import { dispatchSessionTerminalWorkspaceCommand, readSessionTerminalWorkspaceForScope, subscribeSessionTerminalWorkspace } from './sessionTerminalWorkspaceRuntime';

export type SessionTerminalMode = 'workspace_shell' | 'session_attach';

export function readSessionTerminalMode(sessionId: string, serverId?: string | null): SessionTerminalMode {
    return readModeForScope(createSessionPaneScopeId(sessionId, serverId));
}

function readModeForScope(scopeId: string): SessionTerminalMode {
    const workspace = readSessionTerminalWorkspaceForScope(scopeId);
    return workspace && getActiveSessionTerminal(workspace)?.target.kind === 'session_attach' ? 'session_attach' : 'workspace_shell';
}

export function setSessionTerminalMode(sessionId: string, mode: SessionTerminalMode, serverId?: string | null, scopeId = createSessionPaneScopeId(sessionId, serverId)): void {
    const workspace = readSessionTerminalWorkspaceForScope(scopeId) ?? readSessionTerminalWorkspace(undefined);
    const existing = workspace.tabs.flatMap((tab) => tab.terminals).find((terminal) => terminal.target.kind === mode);
    dispatchSessionTerminalWorkspaceCommand(scopeId, existing
        ? { type: 'focus', terminalId: existing.id }
        : { type: 'open', terminal: { id: mode === 'session_attach' ? 'session-attach' : 'embedded', target: { kind: mode } } });
}

export function useSessionTerminalMode(sessionId: string, serverId?: string | null, scopeId = createSessionPaneScopeId(sessionId, serverId)): SessionTerminalMode {
    return React.useSyncExternalStore(
        subscribeSessionTerminalWorkspace,
        React.useCallback(() => readModeForScope(scopeId), [scopeId]),
        React.useCallback(() => readModeForScope(scopeId), [scopeId]),
    );
}

export type SessionTerminalIdentity = Readonly<{
    available: boolean;
    terminalId: string | null;
    serverId: string | null;
    terminalMode: SessionTerminalMode;
    terminalKey: string;
    terminalTarget?: SessionTerminalTargetV1;
}>;

export function resolveSessionTerminalIdentity(params: Readonly<{
    sessionId: string; scopeId: string; terminal?: SessionTerminalMemberV1 | null;
    terminalMode?: SessionTerminalMode; terminalInstanceId?: string;
}>): SessionTerminalIdentity {
    const serverId = parseSessionPaneScopeId(params.scopeId)?.address?.serverId ?? null;
    const scopeId = parseSessionPaneScopeId(params.scopeId) ? params.scopeId : createSessionPaneScopeId(params.sessionId, serverId);
    const terminalMode = params.terminal ? params.terminal.target.kind === 'session_attach' ? 'session_attach' : 'workspace_shell' : params.terminalMode ?? 'workspace_shell';
    const instanceId = params.terminal?.id ?? params.terminalInstanceId;
    const terminalKey = terminalMode === 'session_attach'
        ? params.terminal && params.terminal.id !== 'session-attach'
            ? `${scopeId}:attach:${params.terminal.id}`
            : serverId ? `${scopeId}:attach` : `session-attach:${params.sessionId}`
        : instanceId && instanceId !== 'embedded' ? `${scopeId}:terminal:${instanceId}` : `${scopeId}:terminal`;
    return { available: Boolean(params.terminal) || !params.terminalInstanceId, terminalId: params.terminal?.id ?? null, serverId, terminalMode, terminalKey, terminalTarget: params.terminal?.target };
}

export function useSessionTerminalIdentity(params: Readonly<{
    sessionId: string;
    scopeId: string;
    terminalMode?: SessionTerminalMode;
    terminalInstanceId?: string;
    terminal?: SessionTerminalMemberV1;
}>): SessionTerminalIdentity {
    const storedWorkspace = React.useSyncExternalStore(
        subscribeSessionTerminalWorkspace,
        React.useCallback(() => readSessionTerminalWorkspaceForScope(params.scopeId), [params.scopeId]),
        React.useCallback(() => readSessionTerminalWorkspaceForScope(params.scopeId), [params.scopeId]),
    );
    const selectedTerminal = params.terminal ?? (params.terminalMode ? null : params.terminalInstanceId
        ? storedWorkspace?.tabs.flatMap((tab) => tab.terminals).find((terminal) => terminal.id === params.terminalInstanceId)
        : storedWorkspace ? getActiveSessionTerminal(storedWorkspace) : null);
    return React.useMemo(() => resolveSessionTerminalIdentity({ ...params, terminal: selectedTerminal }), [params.sessionId, params.scopeId, selectedTerminal, params.terminalInstanceId, params.terminalMode]);
}

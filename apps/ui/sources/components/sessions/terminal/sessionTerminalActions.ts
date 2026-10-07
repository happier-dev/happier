import { randomUUID } from '@/platform/randomUUID';
import { SESSION_TERMINAL_ACTION_INPUT_SCHEMAS, type SessionTerminalActionId } from '@happier-dev/protocol/actions/sessionTerminalActionFamily';
import type { SessionTerminalTargetV1 } from '@happier-dev/protocol/terminal/workspace';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { dispatchSessionTerminalWorkspaceCommand, getSplitMeasurementsForScope, openSessionTerminalInDetailsForScope, readSessionTerminalWorkspaceForScope, resizeSessionTerminalSplitForScope } from './sessionTerminalWorkspaceRuntime';
import { reduceSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from './sessionTerminalWorkspace';
import { closeOwnedSessionTerminals } from './closeOwnedSessionTerminals';
import { createSessionTerminalLeafHandles } from './strip/sessionTerminalLeafHandles';

export function sessionTerminalActionFailure(errorCode: string) {
    return { ok: false as const, errorCode, error: errorCode };
}

/** Stateless intent adapter over the mounted AppPane owner and daemon PTY authority. */
export async function invokeSessionTerminalAction(request: Readonly<{
    actionId: SessionTerminalActionId;
    input: unknown;
    signal?: AbortSignal;
}>) {
    if (request.signal?.aborted) return sessionTerminalActionFailure('action_cancelled');
    const parsed = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS[request.actionId].safeParse(request.input);
    if (!parsed.success) return sessionTerminalActionFailure('invalid_parameters');
    const data = parsed.data;
    if (!parseSessionPaneScopeId(data.scopeId)?.address) return sessionTerminalActionFailure('terminal_scope_unavailable');
    const workspace = readSessionTerminalWorkspaceForScope(data.scopeId);
    if (!workspace) return sessionTerminalActionFailure('unsupported_action');
    if (request.actionId === 'session.terminals.list') return { ok: true as const, workspace };
    const tabId = 'tabId' in data ? data.tabId : undefined;
    const tab = workspace.tabs.find((item) => item.id === (tabId ?? workspace.activeTabId));
    if ('terminalId' in data && !workspace.tabs.some((item) => item.terminals.some((member) => member.id === data.terminalId))) {
        return sessionTerminalActionFailure('terminal_not_found');
    }
    let command: SessionTerminalWorkspaceCommand | undefined;
    let terminalId: string | undefined;
    let closedTerminalIds: string[] | undefined;
    switch (request.actionId) {
        case 'session.terminals.open_in_details': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.open_in_details'].parse(request.input);
            return openSessionTerminalInDetailsForScope(data.scopeId, input.terminalId) ? { ok: true as const } : sessionTerminalActionFailure('unsupported_action');
        }
        case 'session.terminals.restart': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.restart'].parse(request.input);
            const member = workspace.tabs.flatMap((item) => item.terminals).find((terminal) => terminal.id === input.terminalId);
            const handle = createSessionTerminalLeafHandles(data.scopeId).get(input.terminalId);
            if (!member || member.target.kind === 'terminal_view' || !handle) return sessionTerminalActionFailure('terminal_restart_unavailable');
            handle.restart();
            return { ok: true as const };
        }
        case 'session.terminals.open':
        case 'session.terminals.split':
        case 'session.terminals.run_script': {
            const terminalInput = request.actionId === 'session.terminals.run_script'
                ? SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.run_script'].safeParse(request.input)
                : request.actionId === 'session.terminals.split'
                    ? SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.split'].safeParse(request.input)
                    : SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.open'].safeParse(request.input);
            if (!terminalInput.success) return sessionTerminalActionFailure('invalid_parameters');
            const terminalData = terminalInput.data;
            const target: SessionTerminalTargetV1 = 'target' in terminalData ? terminalData.target
                : { kind: 'machine_shell', machineId: terminalData.machineId, cwd: terminalData.cwd,
                    launch: { kind: 'package_script', runTargetId: terminalData.runTargetId } };
            terminalId = randomUUID();
            const terminal = { id: terminalId, target, ...(terminalData.title ? { title: terminalData.title } : {}) };
            if (request.actionId === 'session.terminals.split') {
                if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
                const measurement = getSplitMeasurementsForScope(data.scopeId, tab.id);
                if (!measurement) return sessionTerminalActionFailure('terminal_layout_unmeasured');
                command = { type: 'split', tabId: tab.id, terminal, ...measurement };
                if (reduceSessionTerminalWorkspace(workspace, command) === workspace) return sessionTerminalActionFailure('terminal_split_unavailable');
            } else command = { type: 'open', terminal };
            break;
        }
        case 'session.terminals.focus': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.focus'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            command = { type: 'focus', terminalId: input.data.terminalId };
            break;
        }
        case 'session.terminals.close': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.close'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: workspace.tabs.flatMap((item) => item.terminals).filter((terminal) => terminal.id === input.data.terminalId), signal: request.signal });
            if (!result.ok) return result;
            closedTerminalIds = [input.data.terminalId];
            break;
        }
        case 'session.terminals.close_others':
            if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
            {
                const selected = workspace.tabs.filter((item) => item.id !== tab.id).flatMap((item) => item.terminals);
                const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: selected, signal: request.signal });
                if (!result.ok) return result;
                closedTerminalIds = selected.map((terminal) => terminal.id);
            }
            break;
        case 'session.terminals.close_tab':
            if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
            {
                const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: tab.terminals, signal: request.signal });
                if (!result.ok) return result;
                closedTerminalIds = tab.terminals.map((terminal) => terminal.id);
            }
            break;
        case 'session.terminals.resize': {
            if (!tab || tab.terminals.length < 2) return sessionTerminalActionFailure('terminal_split_unavailable');
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.resize'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            const resized = resizeSessionTerminalSplitForScope(data.scopeId, tab.id, input.data.splitId, input.data.ratio);
            return resized === null ? sessionTerminalActionFailure('terminal_layout_unmeasured')
                : resized ? { ok: true as const } : sessionTerminalActionFailure('terminal_split_unavailable');
        }
        case 'session.terminals.detach': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.detach'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            command = { type: 'detach', terminalId: input.data.terminalId, newTabId: randomUUID() };
            break;
        }
        case 'session.terminals.reorder': {
            if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.reorder'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            command = { type: 'reorder', tabId: tab.id, index: input.data.index };
            break;
        }
        case 'session.terminals.rename': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.rename'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            command = { type: 'rename', terminalId: input.data.terminalId, title: input.data.title };
            break;
        }
        case 'session.terminals.list_view': {
            const input = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS['session.terminals.list_view'].safeParse(request.input);
            if (!input.success) return sessionTerminalActionFailure('invalid_parameters');
            command = { type: 'showList', showList: input.data.showList };
            break;
        }
        default: return sessionTerminalActionFailure('unsupported_action');
    }
    if (closedTerminalIds) {
        // RPC waits permit new panes to open or split. Commit only the captured
        // members whose ownership was checked, never newly added shell members.
        for (const id of closedTerminalIds) if (!dispatchSessionTerminalWorkspaceCommand(data.scopeId, { type: 'close', terminalId: id })) return sessionTerminalActionFailure('unsupported_action');
        if (request.actionId === 'session.terminals.close_others' && tab
            && readSessionTerminalWorkspaceForScope(data.scopeId)?.tabs.some((current) => current.id === tab.id)) {
            dispatchSessionTerminalWorkspaceCommand(data.scopeId, { type: 'focus', terminalId: tab.focusedTerminalId });
        }
    } else if (!command || !dispatchSessionTerminalWorkspaceCommand(data.scopeId, command)) return sessionTerminalActionFailure('unsupported_action');
    return terminalId ? { ok: true as const, terminalId } : { ok: true as const };
}

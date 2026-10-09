import { randomUUID } from '@/platform/randomUUID';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { SESSION_TERMINAL_ACTION_INPUT_SCHEMAS, type SessionTerminalActionId } from '@happier-dev/protocol/actions/sessionTerminalActionFamily';
import type { SessionTerminalMemberV1, SessionTerminalTargetV1 } from '@happier-dev/protocol/terminal/workspace';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { dispatchSessionTerminalWorkspaceCommand, getSplitMeasurementsForScope, initializeSessionTerminalWorkspaceForScope, openSessionTerminalInDetailsForScope, readSessionTerminalWorkspaceForScope, resizeSessionTerminalSplitForScope } from './sessionTerminalWorkspaceRuntime';
import { EMPTY_TERMINAL_WORKSPACE, reduceSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from './sessionTerminalWorkspace';
import { closeOwnedSessionTerminals } from './closeOwnedSessionTerminals';
import { createSessionTerminalLeafHandles } from './strip/sessionTerminalLeafHandles';
import { resolveSessionTerminalRequest } from './sessionTerminalRequest';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export function sessionTerminalActionFailure(errorCode: string) {
    return { ok: false as const, errorCode, error: errorCode };
}

async function admitOriginalTerminalCreation(scopeId: string, terminal: SessionTerminalMemberV1,
    context: ActionExecutorContext, signal?: AbortSignal) {
    const resolved = await resolveSessionTerminalRequest(scopeId, terminal);
    if (!resolved || !resolved.isCurrent()) return sessionTerminalActionFailure('terminal_target_unavailable');
    if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, resolved.serverId)) {
        return sessionTerminalActionFailure('terminal_scope_unavailable');
    }
    const account = await captureLazyActionAccountContext(resolved.serverId, signal);
    try {
        account.assertCurrent();
        if (resolved.accountId && resolved.accountId !== account.accountId
            || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) {
            return sessionTerminalActionFailure('terminal_scope_unavailable');
        }
        const result = await createFrontDoorActionExecute()('machines.terminal.open', {
            ...resolved.request, serverId: account.serverId, machineId: resolved.machineId,
        }, { ...context, bypassApprovals: false, serverId: account.serverId, expectedAccountId: account.accountId,
            actionRequestId: context.actionRequestId ?? randomUUID(), ...(signal ? { signal } : {}) });
        if (!result.ok) return result;
        account.assertCurrent();
        if (!resolved.isCurrent()) return sessionTerminalActionFailure('terminal_scope_unavailable');
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (pending.success) return { ok: true as const, terminal: { ...terminal, pendingActionApproval: {
            scope: account.accountLifetime.scope, artifactId: pending.data.artifactId, actionId: 'machines.terminal.open' as const,
        } } };
        const receipt = DaemonTerminalEnsureResponseSchema.safeParse(result.result);
        if (!receipt.success) return sessionTerminalActionFailure('terminal_invalid_response');
        return receipt.data.ok ? { ok: true as const, terminal } : sessionTerminalActionFailure(receipt.data.errorCode);
    } finally { account.dispose(); }
}

/** Stateless intent adapter over the mounted AppPane owner and daemon PTY authority. */
export async function invokeSessionTerminalAction(request: Readonly<{
    actionId: SessionTerminalActionId;
    input: unknown;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
}>) {
    if (request.signal?.aborted) return sessionTerminalActionFailure('action_cancelled');
    const parsed = SESSION_TERMINAL_ACTION_INPUT_SCHEMAS[request.actionId].safeParse(request.input);
    if (!parsed.success) return sessionTerminalActionFailure('invalid_parameters');
    const data = parsed.data;
    const sessionAddress = parseSessionPaneScopeId(data.scopeId)?.address;
    const project = sessionAddress ? null : resolveProjectTerminalScope(data.scopeId);
    if (!sessionAddress && !project) return sessionTerminalActionFailure('terminal_scope_unavailable');
    const workspace = readSessionTerminalWorkspaceForScope(data.scopeId, project ? EMPTY_TERMINAL_WORKSPACE : undefined);
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
            handle.restart(request.context);
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
            let target: SessionTerminalTargetV1 = 'target' in terminalData ? terminalData.target
                : { kind: 'machine_shell', machineId: terminalData.machineId, cwd: terminalData.cwd,
                    launch: { kind: 'package_script', runTargetId: terminalData.runTargetId } };
            if (project) {
                if (target.kind === 'session_attach') return sessionTerminalActionFailure('terminal_target_unavailable');
                const selected = target.kind === 'workspace_shell' ? target.workspace
                    : { ...project.workspace, machineId: target.machineId, rootPath: target.cwd };
                const admitted = resolveProjectTerminalScope(data.scopeId, selected);
                if (!admitted) return sessionTerminalActionFailure('terminal_target_unavailable');
                if (target.kind === 'workspace_shell') target = { ...target, workspace: admitted.workspace };
                else if (target.kind === 'machine_shell') {
                    target = { kind: 'workspace_shell', workspace: admitted.workspace,
                        ...(target.initialCommand === undefined ? {} : { initialCommand: target.initialCommand }),
                        ...(target.launch === undefined ? {} : { launch: target.launch }) };
                }
            }
            terminalId = randomUUID();
            let terminal: SessionTerminalMemberV1 = { id: terminalId, target, ...(terminalData.title ? { title: terminalData.title } : {}) };
            if (request.actionId === 'session.terminals.split') {
                if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
                const measurement = getSplitMeasurementsForScope(data.scopeId, tab.id);
                if (!measurement) return sessionTerminalActionFailure('terminal_layout_unmeasured');
                command = { type: 'split', tabId: tab.id, terminal, ...measurement };
                if (reduceSessionTerminalWorkspace(workspace, command) === workspace) return sessionTerminalActionFailure('terminal_split_unavailable');
            } else command = { type: 'open', terminal };
            // A mounted present user's intent is admitted by its existing lazy
            // controller. Other verified callers must reach the Machine gate
            // with their ORIGINAL provenance before a mount can invent UI context.
            if (target.kind !== 'terminal_view' && request.context
                && !(request.context.surface === 'ui' && request.context.authority === 'present_user'
                    && request.context.actionCaller?.kind === 'host')) {
                const admitted = await admitOriginalTerminalCreation(data.scopeId, terminal, request.context, request.signal);
                if (!admitted.ok) return admitted;
                terminal = admitted.terminal;
                command = { ...command, terminal };
            }
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
            const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: workspace.tabs.flatMap((item) => item.terminals).filter((terminal) => terminal.id === input.data.terminalId), context: request.context, signal: request.signal });
            if (!result.ok) return result;
            closedTerminalIds = [input.data.terminalId];
            break;
        }
        case 'session.terminals.close_others':
            if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
            {
                const selected = workspace.tabs.filter((item) => item.id !== tab.id).flatMap((item) => item.terminals);
                const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: selected, context: request.context, signal: request.signal });
                if (!result.ok) return result;
                closedTerminalIds = selected.map((terminal) => terminal.id);
            }
            break;
        case 'session.terminals.close_tab':
            if (!tab) return sessionTerminalActionFailure('terminal_tab_not_found');
            {
                const result = await closeOwnedSessionTerminals({ scopeId: data.scopeId, terminals: tab.terminals, context: request.context, signal: request.signal });
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
    if (project && !project.lifetime.isCurrent()) return sessionTerminalActionFailure('terminal_scope_unavailable');
    if (project && !initializeSessionTerminalWorkspaceForScope(data.scopeId, EMPTY_TERMINAL_WORKSPACE)) return sessionTerminalActionFailure('unsupported_action');
    if (closedTerminalIds) {
        // RPC waits permit new panes to open or split. Commit only the captured
        // members whose ownership was checked, never newly added shell members.
        for (const id of closedTerminalIds) if (!dispatchSessionTerminalWorkspaceCommand(data.scopeId, { type: 'close', terminalId: id })) return sessionTerminalActionFailure('unsupported_action');
        if (request.actionId === 'session.terminals.close_others' && tab
            && readSessionTerminalWorkspaceForScope(data.scopeId)?.tabs.some((current) => current.id === tab.id)) {
            dispatchSessionTerminalWorkspaceCommand(data.scopeId, { type: 'focus', terminalId: tab.focusedTerminalId });
        }
    } else {
        if (!command || !dispatchSessionTerminalWorkspaceCommand(data.scopeId, command)) return sessionTerminalActionFailure('unsupported_action');
        if (terminalId) {
            const containsMember = () => readSessionTerminalWorkspaceForScope(data.scopeId)?.tabs
                .some(current => current.terminals.some(member => member.id === terminalId)) === true;
            if (!containsMember() && command.type === 'split') {
                // Closing a captured tab does not cancel a concurrent admitted
                // creation. Keep its actual member/Artifact custody in a new tab
                // when that original split placement disappeared during admission.
                if (!dispatchSessionTerminalWorkspaceCommand(data.scopeId, { type: 'open', terminal: command.terminal })) {
                    return sessionTerminalActionFailure('unsupported_action');
                }
            }
            if (!containsMember()) return sessionTerminalActionFailure('terminal_target_unavailable');
        }
    }
    return terminalId ? { ok: true as const, terminalId } : { ok: true as const };
}

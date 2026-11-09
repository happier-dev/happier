import { z } from 'zod/mini';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { awaitPendingMachineTerminalCreation, machineTerminalClose, machineTerminalList } from '@/sync/ops/machineTerminal';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { buildProjectMemberTerminalKey, resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';
import { resolveSessionTerminalRequest } from './sessionTerminalRequest';
import { inspectMachineTerminalMemberApproval } from './machineTerminalApproval';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalListResponseV1Schema, DaemonTerminalCloseResponseSchema, type DaemonTerminalEnsureRequest } from '@happier-dev/protocol/daemon/terminal';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { randomUUID } from '@/platform/randomUUID';
import { readSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { Modal } from '@/modal';
import { isActionApprovalRequiredForHome } from '@/sync/domains/settings/actionsSettings';
import { t } from '@/text';
import { describeSessionTerminalTabs, type SessionTerminalDescribeContext } from './presentation/describeSessionTerminal';
import { peekTerminalSurfaceSummary } from './terminalSurfaceSummary';

/** A Project's Shells need no Session or Agent facts to be named. */
const PROJECT_SHELL_NAMING_CONTEXT: SessionTerminalDescribeContext = { agentId: null, agentName: null, agentAsking: false,
    agentTerminalHost: null, sessionMachineId: null, sessionMachineName: null, machineName: () => null };

/** What the strip calls this Project Shell ("Shell 2", "api server"), read from the same naming owner. */
function readProjectShellName(scopeId: string, project: NonNullable<ReturnType<typeof resolveProjectTerminalScope>>, memberId: string): string | null {
    const tabs = readSessionTerminalWorkspaceForScope(scopeId)?.tabs ?? [];
    const summaries = tabs.flatMap(tab => tab.terminals.map(member => peekTerminalSurfaceSummary(buildProjectMemberTerminalKey(project, member))));
    return describeSessionTerminalTabs(tabs, summaries, PROJECT_SHELL_NAMING_CONTEXT)
        .flatMap(tab => tab.members).find(member => member.terminalId === memberId)?.title ?? null;
}

/** Pane ownership never implies ownership of an agent or a borrowed terminal. */
export async function closeOwnedSessionTerminals(input: Readonly<{
    scopeId: string; terminals: readonly SessionTerminalMemberV1[]; context?: ActionExecutorContext; signal?: AbortSignal;
}>): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
    const failed = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    const address = parseSessionPaneScopeId(input.scopeId)?.address;
    const project = address ? null : resolveProjectTerminalScope(input.scopeId);
    if (!address && !project) return failed('terminal_scope_unavailable');
    const serverId = address?.serverId ?? project!.scope.serverId;
    const accountId = project?.scope.accountId;
    if (input.context?.serverId && !areServerProfileIdentifiersEquivalent(input.context.serverId, serverId)
        || accountId && input.context?.runtimeAccountId && input.context.runtimeAccountId !== accountId) {
        return failed('terminal_scope_unavailable');
    }
    const isCurrent = () => !project || project.lifetime.isCurrent();
    const owned = input.terminals.filter((terminal) => terminal.target.kind === 'workspace_shell' || terminal.target.kind === 'machine_shell');
    if (owned.length === 0) return { ok: true };
    const execute = createFrontDoorActionExecute();
    const invocation = input.context ?? { surface: 'ui' as const, source: 'ui_button' as const,
        authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    // Set once the person confirmed the whole batch, so each Machine close does not ask again.
    let batchConfirmed = false;
    const actionContext = () => ({ ...invocation, serverId,
        ...(accountId ? { expectedAccountId: accountId } : {}), bypassApprovals: false, actionRequestId: randomUUID(),
        ...(batchConfirmed ? { presentUserConfirmation: { actionId: 'machines.terminal.close' as const } } : {}),
        ...(input.signal ? { signal: input.signal } : {}) });
    try {
        const identities: { machineId: string; terminalKey: string; member: SessionTerminalMemberV1; request: DaemonTerminalEnsureRequest }[] = [];
        for (const terminal of owned) {
            const resolved = await resolveSessionTerminalRequest(input.scopeId, terminal);
            if (!resolved || !resolved.isCurrent() || !isCurrent()) return failed('terminal_target_unavailable');
            identities.push({ machineId: resolved.machineId, terminalKey: resolved.terminalKey, member: terminal, request: resolved.request });
        }
        const approvalReceipts = new Map<string, string>();
        for (const identity of identities) {
            if (!identity.member.pendingActionApproval) {
                await awaitPendingMachineTerminalCreation(identity.machineId, identity.terminalKey, { serverId, accountId,
                    signal: input.signal,
                    shouldStopWaiting: () => Boolean(readSessionTerminalWorkspaceForScope(input.scopeId)?.tabs
                        .flatMap(tab => tab.terminals).find(member => member.id === identity.member.id)?.pendingActionApproval),
                });
                if (input.signal?.aborted || !isCurrent()) return failed('terminal_scope_unavailable');
                const currentMember = readSessionTerminalWorkspaceForScope(input.scopeId)?.tabs
                    .flatMap(tab => tab.terminals).find(member => member.id === identity.member.id);
                if (!currentMember) return failed('terminal_not_found');
                identity.member = currentMember;
            }
            const pending = identity.member.pendingActionApproval;
            if (!pending) continue;
            if (!areServerProfileIdentifiersEquivalent(pending.scope.serverId, serverId)
                || (accountId !== undefined && pending.scope.accountId !== accountId)) return failed('terminal_scope_unavailable');
            const account = await captureLazyActionAccountContext(serverId, input.signal);
            try {
                if (account.accountId !== pending.scope.accountId || !isCurrent()
                    || input.context?.runtimeAccountId && input.context.runtimeAccountId !== account.accountId) return failed('terminal_scope_unavailable');
                const artifact = await account.fetchArtifact(pending.artifactId);
                account.assertCurrent();
                if (!artifact) return failed('terminal_approval_unavailable');
                const request = inspectMachineTerminalMemberApproval({ artifact, pending, machineId: identity.machineId, request: identity.request });
                if (!request) return failed('terminal_approval_binding_mismatch');
                if (request.status === 'open') {
                    const canceled = await createFrontDoorActionExecute()('approval.request.decide', {
                        artifactId: pending.artifactId, decision: 'cancel',
                    }, { ...(input.context ?? { surface: 'ui', source: 'ui_button', authority: 'present_user' }),
                        bypassApprovals: false, serverId: account.serverId,
                        expectedAccountId: account.accountId, signal: input.signal });
                    if (!canceled.ok) return failed(canceled.errorCode ?? canceled.error);
                    const receipt = canceled.result;
                    if (!receipt || typeof receipt !== 'object' || !('status' in receipt) || receipt.status !== 'canceled') {
                        return failed('terminal_approval_cancellation_pending');
                    }
                } else if (request.status === 'executing' || request.status === 'approved') return failed('terminal_approval_cancellation_pending');
                else if (request.status === 'executed') {
                    const receipt = DaemonTerminalEnsureResponseSchema.safeParse(request.execution?.result);
                    if (!receipt.success || !receipt.data.ok) return failed('terminal_close_identity_unavailable');
                    approvalReceipts.set(identity.terminalKey, receipt.data.terminalId);
                }
                account.assertCurrent();
            } finally { account.dispose(); }
        }
        // Resolve every required identity before stopping any process. Listing is
        // authoritative even when the bounded output projection was evicted.
        const lists = new Map<string, Awaited<ReturnType<typeof machineTerminalList>>>();
        const closable: { machineId: string; terminalId: string; terminalKey: string; member: SessionTerminalMemberV1 }[] = [];
        await Promise.all(identities.map((identity) => awaitPendingMachineTerminalCreation(identity.machineId, identity.terminalKey, { serverId, accountId, signal: input.signal })));
        for (const identity of identities) {
            if (input.signal?.aborted) return failed('action_cancelled');
            if (!isCurrent()) return failed('terminal_scope_unavailable');
            const queryWorkspace = project ? identity.request.workspace : undefined;
            const censusKey = JSON.stringify([identity.machineId, queryWorkspace ?? null]);
            if (!lists.has(censusKey)) {
                if (project) {
                    // Private Project discovery needs the same requester Account
                    // carrier as open/return; raw Machine Use cannot read its rows.
                    const result = await execute('machines.terminal.list', { serverId, machineId: identity.machineId,
                        ...(queryWorkspace ? { workspace: queryWorkspace } : {}) }, actionContext());
                    if (!result.ok) return failed(result.errorCode ?? result.error);
                    const parsed = z.nullable(DaemonTerminalListResponseV1Schema).safeParse(result.result);
                    if (!parsed.success) return failed('terminal_invalid_response');
                    lists.set(censusKey, parsed.data);
                } else lists.set(censusKey, await machineTerminalList(identity.machineId, {
                    serverId, accountId, signal: input.signal,
                }));
            }
            if (!isCurrent()) return failed('terminal_scope_unavailable');
            const list = lists.get(censusKey);
            if (list && !list.ok) return failed(list.errorCode);
            const terminalId = list?.ok
                ? list.terminals.find((terminal) => terminal.terminalKey === identity.terminalKey
                    && (identity.request.sessionId === undefined || terminal.sessionId === identity.request.sessionId)
                    && (identity.request.cwd === undefined || terminal.cwd === identity.request.cwd))?.terminalId
                : approvalReceipts.get(identity.terminalKey) ?? readTerminalSurfaceState(identity.terminalKey)?.terminalId;
            if (!list && !terminalId) return failed('terminal_close_identity_unavailable');
            if (terminalId) closable.push({ ...identity, terminalId });
        }
        // A person closing Project Shells answers one question about the Shells themselves: "Close Shell 2?",
        // or "Close 3 terminals?" for several, never one Machine-close dialog per process naming the host.
        // It asks only where the Machine close itself would (the person's Home policy decides that, so a waived
        // close stays direct). An explicit Ask-first setting for Machine closes still asks for each.
        if (project && closable.length > 0 && invocation.surface === 'ui' && isPresentUserHostInvocation(invocation)
            && await isActionApprovalRequiredForHome('machines.terminal.close', invocation, serverId)) {
            const name = closable.length === 1 ? readProjectShellName(input.scopeId, project, closable[0]!.member.id) : null;
            const confirmed = await Modal.confirm(name
                ? t('terminalWorkspace.closeOne.title', { title: name }) : t('terminalWorkspace.closeMany.title', { count: closable.length }),
            t(name ? 'terminalWorkspace.closeOne.body' : 'terminalWorkspace.closeMany.body'), { confirmText: t('common.close'), destructive: true,
                ...(input.signal ? { signal: input.signal } : {}) });
            if (input.signal?.aborted) return failed('action_cancelled');
            if (!confirmed) return failed('approval_canceled');
            batchConfirmed = true;
        }
        for (const terminal of closable) {
            if (input.signal?.aborted) return failed('action_cancelled');
            if (!isCurrent()) return failed('terminal_scope_unavailable');
            let outcome;
            if (project) {
                const result = await execute('machines.terminal.close', { serverId, machineId: terminal.machineId,
                    terminalId: terminal.terminalId }, actionContext());
                if (!result.ok) return failed(result.errorCode ?? result.error);
                const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                // A pending close has not stopped the process; retain its member
                // until approval settles and the next census proves absence.
                if (pending.success) return failed(pending.data.kind);
                const parsed = DaemonTerminalCloseResponseSchema.safeParse(result.result);
                if (!parsed.success) return failed('terminal_invalid_response');
                outcome = parsed.data;
            } else outcome = await machineTerminalClose(terminal.machineId, { terminalId: terminal.terminalId }, { serverId, accountId, signal: input.signal });
            if (!outcome.ok) return failed(outcome.errorCode);
        }
        if (!isCurrent()) return failed('terminal_scope_unavailable');
        for (const identity of identities) replaceTerminalSurfaceState(identity.terminalKey, createEmptyTerminalSurfaceState());
        return { ok: true };
    } catch {
        return failed(input.signal?.aborted ? 'action_cancelled' : 'terminal_close_unavailable');
    }
}

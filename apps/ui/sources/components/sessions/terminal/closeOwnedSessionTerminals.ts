import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { awaitPendingMachineTerminalCreation, machineTerminalClose, machineTerminalList } from '@/sync/ops/machineTerminal';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';
import { resolveSessionTerminalRequest } from './sessionTerminalRequest';
import { inspectMachineTerminalMemberApproval } from './machineTerminalApproval';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { DaemonTerminalEnsureResponseSchema, type DaemonTerminalEnsureRequest } from '@happier-dev/protocol/daemon/terminal';
import { readSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';

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
        const closable: { machineId: string; terminalId: string; terminalKey: string }[] = [];
        await Promise.all(identities.map((identity) => awaitPendingMachineTerminalCreation(identity.machineId, identity.terminalKey, { serverId, accountId })));
        for (const identity of identities) {
            if (input.signal?.aborted) return failed('action_cancelled');
            if (!isCurrent()) return failed('terminal_scope_unavailable');
            const queryWorkspace = project ? identity.request.workspace : undefined;
            const censusKey = JSON.stringify([identity.machineId, queryWorkspace ?? null]);
            if (!lists.has(censusKey)) lists.set(censusKey, await machineTerminalList(identity.machineId, {
                serverId, accountId, signal: input.signal, ...(queryWorkspace ? { workspace: queryWorkspace } : {}),
            }));
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
        for (const terminal of closable) {
            if (input.signal?.aborted) return failed('action_cancelled');
            if (!isCurrent()) return failed('terminal_scope_unavailable');
            const outcome = await machineTerminalClose(terminal.machineId, { terminalId: terminal.terminalId }, { serverId, accountId, signal: input.signal });
            if (!outcome.ok) return failed(outcome.errorCode);
        }
        if (!isCurrent()) return failed('terminal_scope_unavailable');
        for (const identity of identities) replaceTerminalSurfaceState(identity.terminalKey, createEmptyTerminalSurfaceState());
        return { ok: true };
    } catch {
        return failed(input.signal?.aborted ? 'action_cancelled' : 'terminal_close_unavailable');
    }
}

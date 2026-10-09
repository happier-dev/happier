import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalListResponseV1Schema, type DaemonTerminalEnsureRequest, type DaemonTerminalEnsureResponse } from '@happier-dev/protocol/daemon/terminal';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation, awaitActionApprovalResult } from '@/components/approvals/actionApprovalContinuation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { randomUUID } from '@/platform/randomUUID';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readSessionTerminalWorkspaceForScope, setSessionTerminalPendingActionApproval } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { inspectMachineTerminalMemberApproval } from '@/components/sessions/terminal/machineTerminalApproval';
import { buildProjectTerminalKey, resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { resolveSessionTerminalIdentity } from '@/components/sessions/terminal/sessionTerminalMode';
import { awaitPendingMachineTerminalCreation, trackPendingMachineTerminalCreation } from '@/sync/ops/machineTerminal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** The mounted controller consumes the original Action result, never replays an approved open. */
export type MachineTerminalAdmissionResult = Extract<DaemonTerminalEnsureResponse, { ok: true }>
    | Readonly<{ ok: false; errorCode: string; error: string }>;
export function useMachineTerminalActionAdmission(input: Readonly<{ terminalKey: string; workspace?: WorkspaceAddressV1;
    serverId?: string | null; machineId?: string | null; scopeId?: string; memberId?: string }>) {
    const workspace = React.useMemo(() => input.workspace, [input.workspace?.serverId, input.workspace?.machineId,
        input.workspace?.workspaceId, input.workspace?.rootPath]);
    const lifetime = React.useMemo(() => workspace ? captureActiveServerAccountScopeLifetime() : null,
        [input.terminalKey, workspace]);
    const serverId = React.useMemo(() => workspace?.serverId ?? input.serverId ?? getActiveServerSnapshot().serverId,
        [input.terminalKey, input.serverId, workspace?.serverId]);
    const accountContext = React.useRef<LazyActionAccountContext | null>(null);
    React.useEffect(() => () => {
        const captured = accountContext.current;
        accountContext.current = null;
        if (!captured) return;
        const machineId = workspace?.machineId ?? input.machineId;
        // The existing in-flight creation owner, not the mounted view, keeps
        // credential retirement observed until issued receipt custody settles.
        if (machineId) void awaitPendingMachineTerminalCreation(machineId, input.terminalKey, {
            serverId: captured.serverId, accountId: captured.accountId,
        }).then(() => captured.dispose(), () => captured.dispose());
        else captured.dispose();
    }, [input.terminalKey, input.machineId, serverId, workspace]);
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const approval = useActionApprovalContinuation({ scopeKey: input.terminalKey,
        serverId, onExecuted: () => {} });
    const capture = React.useCallback(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        const authority = accountContext.current ?? await captureLazyActionAccountContext(serverId);
        if (signal.aborted) {
            if (accountContext.current !== authority) authority.dispose();
            signal.throwIfAborted();
        }
        if (accountContext.current && accountContext.current !== authority) authority.dispose();
        const captured = accountContext.current ?? authority;
        accountContext.current = captured;
        captured.assertAccountCurrent();
        if (workspace && (!lifetime?.isCurrent()
            || !areServerProfileIdentifiersEquivalent(captured.serverId, workspace.serverId)
            || captured.accountId !== lifetime.scope.accountId)) {
            throw Object.assign(new Error('terminal_access_denied'), { code: 'terminal_access_denied' });
        }
        return captured.accountLifetime;
    }, [serverId, workspace, lifetime]);
    const admit = React.useCallback(async (request: DaemonTerminalEnsureRequest, restart: boolean, signal: AbortSignal,
        context?: ActionExecutorContext,
        onIssuedReceipt?: (receipt: Extract<DaemonTerminalEnsureResponse, { ok: true }>, scope: ServerAccountScope) => void | Promise<void>,
    ): Promise<MachineTerminalAdmissionResult> => {
        if (workspace && (!lifetime?.isCurrent()
            || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, workspace.serverId))) {
            return { ok: false, errorCode: 'terminal_access_denied', error: 'terminal_access_denied' };
        }
        const fail = (code: string): MachineTerminalAdmissionResult => ({ ok: false, errorCode: code, error: code });
        await capture(signal);
        const capturedAuthority = accountContext.current!;
        if (context?.signal?.aborted) return fail('action_cancelled');
        if (context?.runtimeAccountId && context.runtimeAccountId !== capturedAuthority.accountId) return fail('terminal_access_denied');
        if (context?.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, capturedAuthority.serverId)) return fail('terminal_access_denied');
        if (!capturedAuthority.accountLifetime.isCurrent()) return fail('terminal_access_denied');
        const machineId = workspace?.machineId ?? input.machineId;
        if (!machineId) return fail('terminal_missing_machine_target');
        const actionId = restart ? 'machines.terminal.restart' as const : 'machines.terminal.open' as const;
        const payload = { ...request, ...(workspace ? { workspace } : {}), serverId: capturedAuthority.serverId, machineId };
        const requestId = randomUUID();
        const readMember = () => input.scopeId ? readSessionTerminalWorkspaceForScope(input.scopeId,
            parseSessionPaneScopeId(input.scopeId) ? readSessionTerminalWorkspace(undefined) : undefined)?.tabs
            .flatMap(tab => tab.terminals).find(member => member.id === input.memberId) : undefined;
        let member = readMember();
        if (member && !member.pendingActionApproval) {
            // A returning view joins the existing issuance stage before it may
            // discover a process or request another approval. The member, not
            // the old view, owns the eventual acknowledgement association.
            await awaitPendingMachineTerminalCreation(machineId, request.terminalKey, {
                serverId: capturedAuthority.serverId, accountId: capturedAuthority.accountId,
                shouldStopWaiting: () => signal.aborted || !capturedAuthority.accountLifetime.isCurrent()
                    || Boolean(readMember()?.pendingActionApproval),
            });
            if (signal.aborted || !capturedAuthority.accountLifetime.isCurrent()) return fail('terminal_access_denied');
            member = readMember();
        }
        if (input.scopeId && input.memberId && !member) return fail('terminal_not_found');
        const retained = member?.pendingActionApproval;
        // A view returning to an existing member discovers its actual process
        // through the requester's current daemon census, not a cached PTY id.
        // Pending Artifact custody and explicit restart always take their own path.
        if (member && !retained && !restart && input.scopeId) {
            const session = parseSessionPaneScopeId(input.scopeId)?.address;
            const project = workspace ? resolveProjectTerminalScope(input.scopeId, workspace) : null;
            const memberKey = project ? buildProjectTerminalKey(project.scope, project.workspace, member.id)
                : session ? resolveSessionTerminalIdentity({ sessionId: session.sessionId, scopeId: input.scopeId, terminal: member }).terminalKey : null;
            if (memberKey === request.terminalKey && (project || (session && session.sessionId === request.sessionId
                && areServerProfileIdentifiersEquivalent(session.serverId, capturedAuthority.serverId)))) {
                const census = await execute('machines.terminal.list', { serverId: capturedAuthority.serverId, machineId,
                    ...(project ? { workspace: project.workspace } : {}) }, {
                    surface: 'ui', source: 'ui_button', authority: 'present_user', serverId: capturedAuthority.serverId,
                    expectedAccountId: capturedAuthority.accountId, signal,
                });
                if (!capturedAuthority.accountLifetime.isCurrent() || signal.aborted) return fail('terminal_access_denied');
                if (!census.ok) return fail(census.errorCode ?? census.error);
                // Released own-Session daemons may lack census support. They
                // retain the approved create path; a new Project requires its
                // admitted requester/Workspace-aware backend.
                if (census.result === null) {
                    if (project) return fail('terminal_unavailable');
                } else {
                    const listed = DaemonTerminalListResponseV1Schema.safeParse(census.result);
                    if (!listed.success) return fail('terminal_invalid_response');
                    if (!listed.data.ok) return fail(listed.data.errorCode);
                    const cwd = request.cwd ?? project?.workspace.rootPath;
                    const existing = listed.data.terminals.find(terminal => terminal.terminalKey === memberKey
                        && (cwd === undefined || terminal.cwd === cwd)
                        && (request.sessionId === undefined || terminal.sessionId === request.sessionId));
                    if (existing) return { ok: true, terminalId: existing.terminalId, reused: true };
                }
            }
        }
        const settleAssociation = (artifactId: string) => {
            if (input.scopeId && input.memberId) setSessionTerminalPendingActionApproval(input.scopeId, input.memberId, null, artifactId);
        };
        return awaitActionApprovalResult<unknown, MachineTerminalAdmissionResult>({ signal,
            succeeded: value => {
                if (!capturedAuthority.accountLifetime.isCurrent()) return fail('terminal_access_denied');
                const parsed = DaemonTerminalEnsureResponseSchema.safeParse(value);
                return parsed.success ? parsed.data : fail('terminal_invalid_response');
            }, failed: fail, aborted: () => fail('terminal_access_denied'),
            execute: async callbacks => {
                if (retained) {
                    if (retained.scope.accountId !== capturedAuthority.accountId
                        || !areServerProfileIdentifiersEquivalent(retained.scope.serverId, capturedAuthority.serverId)) return fail('approval_binding_mismatch');
                    const artifact = await capturedAuthority.fetchArtifact(retained.artifactId);
                    if (signal.aborted) return fail('terminal_access_denied');
                    const original = artifact && inspectMachineTerminalMemberApproval({ artifact, pending: retained, machineId, request });
                    if (!original || !artifact) return fail('approval_binding_mismatch');
                    const continuation = createActionApprovalContinuation<unknown, typeof actionId>({ artifactId: retained.artifactId,
                        actionId: retained.actionId, scope: capturedAuthority.accountLifetime.scope, signal,
                        expectedInput: original.actionArgs, expectedRequestId: original.executionOriginV1.requestId,
                        expectedExecutionOrigin: original.executionOriginV1,
                        onSucceeded: value => { settleAssociation(retained.artifactId); callbacks.onApprovalSucceeded(value); },
                        onFailed: code => { settleAssociation(retained.artifactId); callbacks.onApprovalFailed(code); } });
                    if (original.status === 'executed') await continuation.onExecuted(artifact);
                    else if (original.status === 'canceled' || original.status === 'failed' || original.status === 'rejected') continuation.onTerminal?.(original.status, artifact);
                    else approval.requestApproval(continuation);
                    return { approvalPending: true as const };
                }
                return trackPendingMachineTerminalCreation(machineId, request.terminalKey, async () => {
                const originContext: ActionExecutorContext = context ?? { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } };
                // A member survives view hide. Its in-flight Action keeps the
                // original caller/Account lifetime, while `signal` releases only
                // this mounted view's receipt interest. Temporary view-owned
                // terminals retain their incumbent cancellation signal.
                const executionSignal = context?.signal ?? (member ? undefined : signal);
                const result = await execute(actionId, payload, { ...originContext,
                    bypassApprovals: false, serverId: capturedAuthority.serverId, expectedAccountId: capturedAuthority.accountId,
                    actionRequestId: requestId, signal: executionSignal });
                if (!result.ok) return fail(result.errorCode ?? result.error);
                const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                if (!pending.success) {
                    const parsed = DaemonTerminalEnsureResponseSchema.safeParse(result.result);
                    // Aborting a view releases its interest, not an already
                    // issued effect. Temporary terminal owners still receive
                    // the actual receipt for their existing late cleanup.
                    if (parsed.success && parsed.data.ok) await onIssuedReceipt?.(parsed.data, capturedAuthority.accountLifetime.scope);
                    if (!capturedAuthority.accountLifetime.isCurrent()) return fail('terminal_access_denied');
                    return parsed.success ? parsed.data : fail('terminal_invalid_response');
                }
                if (!capturedAuthority.accountLifetime.isCurrent()) return fail('terminal_access_denied');
                if (input.scopeId && input.memberId) {
                    const associated = setSessionTerminalPendingActionApproval(input.scopeId, input.memberId, {
                        scope: capturedAuthority.accountLifetime.scope, artifactId: pending.data.artifactId, actionId,
                    });
                    // A receipt may arrive after the explicit member-removal Action.
                    // A hidden/unmounted pane still has its member and retains the same Artifact.
                    const current = readSessionTerminalWorkspaceForScope(input.scopeId);
                    if (!associated && current && !current.tabs.some(tab => tab.terminals.some(member => member.id === input.memberId))) {
                        const canceled = await execute('approval.request.decide', { artifactId: pending.data.artifactId, decision: 'cancel' }, {
                            ...originContext, bypassApprovals: false,
                            serverId: capturedAuthority.serverId, expectedAccountId: capturedAuthority.accountId,
                        });
                        if (!canceled.ok) return fail(canceled.errorCode ?? 'outcome_unknown');
                        const receipt = canceled.result;
                        return fail(receipt && typeof receipt === 'object' && 'status' in receipt && receipt.status === 'canceled'
                            ? 'approval_canceled' : 'terminal_approval_cancellation_pending');
                    }
                }
                const originalArtifact = await capturedAuthority.fetchArtifact(pending.data.artifactId);
                const original = originalArtifact && inspectMachineTerminalMemberApproval({ artifact: originalArtifact,
                    pending: { scope: capturedAuthority.accountLifetime.scope, artifactId: pending.data.artifactId, actionId }, machineId, request });
                if (!original || original.executionOriginV1.requestId !== requestId) return fail('approval_binding_mismatch');
                approval.requestApproval(createActionApprovalContinuation<unknown, typeof actionId>({ artifactId: pending.data.artifactId,
                    actionId, scope: capturedAuthority.accountLifetime.scope, signal, expectedInput: payload, expectedRequestId: requestId,
                    expectedExecutionOrigin: original.executionOriginV1,
                    onSucceeded: value => { settleAssociation(pending.data.artifactId); callbacks.onApprovalSucceeded(value); },
                    onFailed: code => { settleAssociation(pending.data.artifactId); callbacks.onApprovalFailed(code); } }));
                return { approvalPending: true as const };
                }, { serverId: capturedAuthority.serverId, accountId: capturedAuthority.accountId });
            },
        });
    }, [approval.requestApproval, capture, execute, workspace, lifetime, input.machineId, input.scopeId, input.memberId]);
    return { admit, capture, approvalId: approval.approvalId, approvalPending: approval.approvalPending, approvalServerId: serverId,
        get lifetime() { return lifetime ?? accountContext.current?.accountLifetime ?? null; } };
}

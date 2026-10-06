import { randomUUID } from 'node:crypto';
import { SessionActionConfirmationResponseTargetV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import { HAPPIER_ACTION_REQUEST_SOURCE } from '@/agent/permissions/requestKind';
import { deepEqual, hashObject } from '@/utils/deterministicJson';

const RESPONSE_TARGET_KIND = 'happier_action_confirmation_v1';
const SessionActionResponseTargetSchema = SessionActionConfirmationResponseTargetV1Schema;

type Confirmation = NonNullable<ActionExecutorDeps['sessionActionConfirmation']>;
type ConfirmationRequest = Parameters<Confirmation>[0];
type Decision = 'approve' | 'reject' | 'canceled';

export type SessionActionConfirmationRuntimeBinding = Readonly<{
    turnId: string;
    /** The existing runtime-owned signal, retained across individual MCP requests. */
    lifetimeSignal: AbortSignal;
    /** Re-read the actual runtime occurrence and its currently admitted turn. */
    isCurrent: () => boolean;
    /** Exact Run occurrence supplied by the host's existing occurrence owner. */
    run?: Readonly<{ runId: string; occurrenceId: string; sidechainId: string }>;
}>;

/** A process restart cannot restore an in-memory Action continuation. */
export function retireRecoveredSessionActionConfirmations(store: AgentStateRequestStore): Promise<void> {
    return store.cancelRequestsBySource({
        source: HAPPIER_ACTION_REQUEST_SOURCE,
        reason: 'Action continuation unavailable; retry the operation explicitly',
        decision: 'abort',
        requestIds: [],
    });
}

/** One adapter per SessionClient lifetime; the permission store remains the decision owner. */
export function createSessionActionConfirmationAdapter(params: Readonly<{
    sessionId: string;
    store: AgentStateRequestStore;
    sessionSignal: AbortSignal;
    getAuthenticatedAccountId: () => Promise<string | null>;
}>) {
    const coordinator = createPermissionRequestCoordinator<Decision>({ store: params.store });
    let disposed = false;

    // A newly constructed owner has no restorable in-process Action continuation.
    // Completed response redelivery below never creates or executes one.
    const recoveredRequestsRetired = retireRecoveredSessionActionConfirmations(params.store);
    const unregister = params.store.registerResponseTargetHandler(RESPONSE_TARGET_KIND, async (dispatch) => {
        const target = SessionActionResponseTargetSchema.safeParse(dispatch.responseTarget);
        const context = coordinator.getResponseContext(dispatch.requestId);
        if (
            disposed
            || !target.success
            || target.data.requestId !== dispatch.requestId
            || target.data.sessionId !== params.sessionId
            || !context
            || context.source !== HAPPIER_ACTION_REQUEST_SOURCE
            || !deepEqual(context.responseTarget, target.data)
        ) return false;
        const completed = dispatch.completedRequest;
        const decision: Decision | null = completed.status === 'approved' && completed.decision === 'approved'
            ? 'approve'
            : completed.status === 'denied' && (completed.decision === 'denied' || completed.decision === 'abort')
                ? 'reject'
                : completed.status === 'canceled'
                    ? 'canceled'
                    : null;
        if (!decision) return false;
        return await coordinator.handleResponse({
            requestId: dispatch.requestId,
            buildCompletion: () => ({
                result: decision,
                completedRequest: {
                    status: String(completed.status),
                    ...(typeof completed.decision === 'string' ? { decision: completed.decision } : {}),
                },
            }),
        });
    });

    return {
        async confirm(
            request: ConfirmationRequest,
            binding: SessionActionConfirmationRuntimeBinding | null,
        ): ReturnType<Confirmation> {
            await recoveredRequestsRetired;
            const unavailable = { decision: 'canceled' as const, isCurrent: () => false };
            const source = SessionInputSourceSessionV1Schema.safeParse(request.context.sessionInputSource);
            if (
                disposed || !binding || !binding.isCurrent() || binding.lifetimeSignal.aborted || params.sessionSignal.aborted
                || !source.success || source.data.sourceSessionId !== params.sessionId
                || source.data.sourceTurnId !== binding.turnId
                || request.sessionId !== params.sessionId
                || request.context.defaultSessionId !== params.sessionId
                || request.context.surface !== 'agent'
                || request.context.authority !== 'account_automation'
                || resolveActionExecutionPlacementForInput(getActionSpec(request.actionId), request.input) !== 'session'
            ) return unavailable;
            const runtimeAccountId = await params.getAuthenticatedAccountId();
            if (!runtimeAccountId) return unavailable;
            const signal = AbortSignal.any([
                params.sessionSignal,
                binding.lifetimeSignal,
                ...(request.context.signal ? [request.context.signal] : []),
            ]);
            if (signal.aborted || disposed || !binding.isCurrent()) return unavailable;
            const target = SessionActionResponseTargetSchema.parse({
                kind: RESPONSE_TARGET_KIND,
                requestId: `action:${randomUUID()}`,
                actionId: request.actionId,
                inputDigestV1: `sha256:${hashObject(request.input, { undefinedBehavior: 'throw' })}`,
                runtimeAccountId,
                sessionId: params.sessionId,
                turnId: binding.turnId,
                ...(binding.run ? { run: binding.run } : {}),
            });
            const isCurrent = async () => await params.getAuthenticatedAccountId() === runtimeAccountId
                && !disposed && !signal.aborted && binding.isCurrent();
            try {
                const decision = await coordinator.requestDecision({
                    requestId: target.requestId,
                    toolName: 'Happier Action confirmation',
                    kind: 'user_action',
                    toolInput: { actionId: target.actionId, preview: request.preview, sessionId: target.sessionId, turnId: target.turnId },
                    source: HAPPIER_ACTION_REQUEST_SOURCE,
                    turnId: target.turnId,
                    ...(target.run ? { sidechainId: target.run.sidechainId } : {}),
                    responseTarget: target,
                }, { signal });
                return { decision, isCurrent };
            } catch (error) {
                if (signal.aborted || disposed) return unavailable;
                throw error;
            }
        },
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            unregister();
            await recoveredRequestsRetired;
            await params.store.cancelRequestsBySource({
                source: HAPPIER_ACTION_REQUEST_SOURCE,
                reason: 'Action continuation unavailable; retry the operation explicitly',
                decision: 'abort',
                requestIds: [],
            });
            for (const context of coordinator.listResponseContexts()) {
                if (context.source === HAPPIER_ACTION_REQUEST_SOURCE) {
                    coordinator.cancelRequest(context.requestId, 'Action continuation unavailable');
                }
            }
        },
    };
}

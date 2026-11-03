import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { randomUUID } from '@/platform/randomUUID';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import { WorkflowActionError } from './workflowActionError';

/**
 * The one dispatch seam for every workflow Action caller.
 *
 * Definitions, Run now, the Run list and Run detail all reach the server the
 * same way: through the canonical Action front door, with the failure envelope
 * raised as {@link WorkflowActionError} so a caller can branch on the closed
 * Protocol code instead of matching prose. Keeping this in one place is what
 * stops four callers from drifting into four slightly different error
 * contracts.
 *
 * `createFrontDoorActionExecute` rather than the collapsed UI adapter: the
 * collapsed adapter discards `errorCode`, which is exactly the field a
 * currentness conflict or an access denial has to survive on. It is the same
 * single front door, so surface enablement, approval routing and provenance
 * remain owned there.
 */

export type WorkflowActionExecute = ReturnType<typeof createFrontDoorActionExecute>;
type WorkflowChildActionExecute = (...args: Parameters<WorkflowActionExecute>) => ReturnType<WorkflowActionExecute>;
/** Caller facts retained across a mounted operation's child Actions, without parent consent. */
export type WorkflowActionCallerContext = Pick<ActionExecutorContext,
    'surface' | 'authority' | 'serverId' | 'serverIdentityId' | 'runtimeAccountId' | 'expectedAccountId'
    | 'actionCaller' | 'defaultSessionId' | 'defaultSessionMachineId' | 'runtimeRunId' | 'runtimeRunOccurrenceId'
    | 'workspaceWrites' | 'sessionListAccess' | 'callerPermissionMode' | 'sessionAgentSpawnPolicyV1'
    | 'causalPermissionAuthority' | 'sessionInputSource' | 'agentStartContext' | 'sessionRoleConfiguration'
    | 'requesterWorkAttributionV1' | 'actionsSettings' | 'approvalOrigin' | 'externalActionCredential'
    | 'externalActionTarget' | 'rpcSessionAuthorization' | 'requiredContributedActionDangerLevel'
    | 'expectedContributedActionOccurrenceId' | 'signal' | 'onTransportIssued'> & Readonly<{
    /** In-process continuation of the admitted executor; never part of wire context or consent. */
    executeChildAction?: WorkflowChildActionExecute;
}>;

let sharedExecute: WorkflowActionExecute | null = null;

function resolveExecute(): WorkflowActionExecute {
    // Resolved lazily and reused, so mounting a surface never eagerly builds the
    // executor dependency graph.
    sharedExecute ??= createFrontDoorActionExecute();
    return sharedExecute;
}

export async function callWorkflowAction<TResult>(params: Readonly<{
    actionId: ActionId;
    input: unknown;
    /** The canonical result schema's parse, so a malformed reply fails closed. */
    parseResult: (value: unknown) => TResult;
    signal?: AbortSignal;
    /** Host-owned target facts; never merged into caller-authored Action input. */
    context?: Omit<ActionExecutorContext, 'signal'> & Pick<WorkflowActionCallerContext, 'executeChildAction'>;
    /** Routed fields use their captured Home binding; undefined preserves incumbent workflow scope. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** Supplied by tests and by callers that own their executor lifetime. */
    execute?: WorkflowActionExecute;
    /** Used only for the fallback message when the owner returned none. */
    fallbackMessage?: string;
}>): Promise<TResult> {
    const activeLifetime = params.accountLifetime === undefined
        ? params.execute ? null : captureActiveServerAccountScopeLifetime() : params.accountLifetime;
    if (params.accountLifetime !== undefined && !activeLifetime?.isCurrent()) {
        throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    }
    if (activeLifetime && ((params.context?.serverId && !areServerProfileIdentifiersEquivalent(params.context.serverId, activeLifetime.scope.serverId))
        || (params.context?.runtimeAccountId && params.context.runtimeAccountId !== activeLifetime.scope.accountId))) {
        throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    }
    const { executeChildAction, ...context } = params.context ?? {};
    const execute = params.execute ?? executeChildAction ?? resolveExecute();
    const result = await execute(params.actionId, params.input, {
        ...context,
        ...(activeLifetime ? {
            serverId: activeLifetime.scope.serverId,
            runtimeAccountId: activeLifetime.scope.accountId,
        } : {}),
        // Admitted callers retain their attribution; native callers default to UI.
        surface: params.context && 'surface' in params.context ? params.context.surface : 'ui',
        // A child has its own approval invocation, never its parent's request
        // identity or consent. Native UI callers retain the front door's id owner.
        ...(params.context && 'surface' in params.context ? { actionRequestId: randomUUID() } : {}),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    if (activeLifetime && !activeLifetime.isCurrent()) {
        throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    }
    if (!result.ok) {
        const failure = WorkflowActionFailureV1Schema.safeParse(result);
        throw new WorkflowActionError({
            message: result.error || params.fallbackMessage || 'Workflow request failed',
            rawCode: result.errorCode || null,
            ...(failure.success ? { failure: failure.data } : {}),
        });
    }
    return params.parseResult(result.result);
}

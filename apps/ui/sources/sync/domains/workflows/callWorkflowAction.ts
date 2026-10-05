import type { ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

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

let sharedExecute: WorkflowActionExecute | null = null;

function resolveExecute(injected: WorkflowActionExecute | undefined): WorkflowActionExecute {
    if (injected !== undefined) return injected;
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
    context?: Omit<ActionExecutorContext, 'surface' | 'signal'>;
    /** Supplied by tests and by callers that own their executor lifetime. */
    execute?: WorkflowActionExecute;
    /** Used only for the fallback message when the owner returned none. */
    fallbackMessage?: string;
}>): Promise<TResult> {
    const activeLifetime = params.execute ? null : captureActiveServerAccountScopeLifetime();
    if (activeLifetime && params.context?.serverId
        && params.context.serverId !== activeLifetime.scope.serverId) {
        throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    }
    const result = await resolveExecute(params.execute)(params.actionId, params.input, {
        ...params.context,
        ...(activeLifetime ? {
            serverId: activeLifetime.scope.serverId,
            runtimeAccountId: activeLifetime.scope.accountId,
        } : {}),
        surface: 'ui',
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

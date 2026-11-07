import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    WorkspaceSyncRelationshipDisableActionOutputV1Schema,
    WorkspaceSyncRelationshipEnableActionOutputV1Schema,
    WorkspaceSyncRelationshipFlushActionOutputV1Schema,
    WorkspaceSyncRelationshipTerminateActionOutputV1Schema,
    type WorkspaceSyncRelationshipDisableActionInputV1,
    type WorkspaceSyncRelationshipEnableActionInputV1,
    type WorkspaceSyncRelationshipFlushActionInputV1,
    type WorkspaceSyncRelationshipTerminateActionInputV1,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

type RelationshipActionExecute = (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;

async function executeRelationshipAction<T>(
    actionId: ActionId,
    input: unknown,
    outputSchema: Readonly<{ parse(value: unknown): T }>,
    lifetime: ActiveServerAccountScopeLifetime | null,
    execute?: RelationshipActionExecute,
) {
    const retired = { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    if (!execute && !lifetime?.isCurrent()) return retired;
    try {
        const outcome = execute
            ? await execute(actionId, input)
            : await (async () => {
                const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
                if (!lifetime?.isCurrent()) return retired;
                return await createFrontDoorActionExecute(createDefaultActionExecutor())(actionId, input, {
                    surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                });
            })();
        if (!outcome.ok) return outcome;
        const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result);
        if (deferred.success) return { ok: true as const, ...deferred.data };
        const parsed = outputSchema.parse(outcome.result);
        return { ok: true as const, ...parsed };
    } catch {
        return { ok: false as const, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    }
}

/** Present-user relationship lifecycle intent through the canonical Action owner. */
export async function terminateWorkspaceSyncRelationship(
    input: WorkspaceSyncRelationshipTerminateActionInputV1,
    lifetime: ActiveServerAccountScopeLifetime | null = captureActiveServerAccountScopeLifetime(),
    execute?: RelationshipActionExecute,
) {
    return await executeRelationshipAction('workspace.sync.relationship.terminate', input,
        WorkspaceSyncRelationshipTerminateActionOutputV1Schema, lifetime, execute);
}

export async function disableWorkspaceSyncRelationshipAction(
    input: WorkspaceSyncRelationshipDisableActionInputV1,
    lifetime: ActiveServerAccountScopeLifetime | null = captureActiveServerAccountScopeLifetime(),
    execute?: RelationshipActionExecute,
) {
    return await executeRelationshipAction('workspace.sync.relationship.disable', input,
        WorkspaceSyncRelationshipDisableActionOutputV1Schema, lifetime, execute);
}

export async function enableWorkspaceSyncRelationshipAction(
    input: WorkspaceSyncRelationshipEnableActionInputV1,
    lifetime: ActiveServerAccountScopeLifetime | null = captureActiveServerAccountScopeLifetime(),
    execute?: RelationshipActionExecute,
) {
    return await executeRelationshipAction('workspace.sync.relationship.enable', input,
        WorkspaceSyncRelationshipEnableActionOutputV1Schema, lifetime, execute);
}

export async function flushWorkspaceSyncRelationshipAction(
    input: WorkspaceSyncRelationshipFlushActionInputV1,
    lifetime: ActiveServerAccountScopeLifetime | null = captureActiveServerAccountScopeLifetime(),
    execute?: RelationshipActionExecute,
) {
    return await executeRelationshipAction('workspace.sync.relationship.flush', input,
        WorkspaceSyncRelationshipFlushActionOutputV1Schema, lifetime, execute);
}

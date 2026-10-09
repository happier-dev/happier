import { ProjectWorkspaceForgetOutputV1Schema, ProjectWorkspaceUpdateOutputV1Schema,
    type ProjectWorkspaceUpdateInputV1, type ProjectWorkspaceForgetInputV1 } from '@happier-dev/protocol/projects/projectWorkspaceActionsV1';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

/** UI intents enter Action admission; its captured Account adapter owns row effects. */
export async function updateProjectWorkspace(input: ProjectWorkspaceUpdateInputV1,
    lifetime = captureActiveServerAccountScopeLifetime()) {
    return invokeWorkspaceAction('projects.workspace.update', input, lifetime, ProjectWorkspaceUpdateOutputV1Schema);
}

export async function forgetProjectWorkspace(input: ProjectWorkspaceForgetInputV1,
    lifetime = captureActiveServerAccountScopeLifetime()) {
    return invokeWorkspaceAction('projects.workspace.forget', input, lifetime, ProjectWorkspaceForgetOutputV1Schema);
}

async function invokeWorkspaceAction<T>(actionId: 'projects.workspace.update' | 'projects.workspace.forget',
    input: ProjectWorkspaceUpdateInputV1 | ProjectWorkspaceForgetInputV1, lifetime: ActiveServerAccountScopeLifetime | null,
    schema: Readonly<{ parse(value: unknown): T }>) {
    const retired = { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(input.serverId, lifetime.scope.serverId)) return retired;
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        if (!lifetime.isCurrent()) return retired;
        const outcome = await createFrontDoorActionExecute(createDefaultActionExecutor())(actionId, input, {
            surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
        });
        if (!lifetime.isCurrent()) return retired;
        const deferred = outcome.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result) : null;
        if (deferred?.success) return { ok: true as const, ...deferred.data };
        return outcome.ok ? schema.parse(outcome.result) : outcome;
    } catch {
        return { ok: false as const, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    }
}

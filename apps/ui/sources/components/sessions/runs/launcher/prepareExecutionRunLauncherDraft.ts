import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { randomUUID } from '@/platform/randomUUID';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { executionRunLauncherDraftKey } from '@/components/sessions/agents/launch/agentStartDrafts';
import { resolveRoleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { createExecutionRunLauncherDetailsTab, type ExecutionRunIntent } from './executionRunLauncherModel';

type ExecutionRunLauncherDraftInput = Readonly<{
    scope: ServerAccountScope;
    input: Record<string, unknown>;
}>;
export type ExecutionRunLauncherDraftSeed = ExecutionRunLauncherDraftInput & (
    | Readonly<{ sessionId: string; actionId: ActionId }>
    | Readonly<{ sessionId: null; actionId: 'review.start' }>
);

export function prepareExecutionRunLauncherDraft(seed: ExecutionRunLauncherDraftSeed & Readonly<{ sessionId: string }>) {
    const intent: ExecutionRunIntent = seed.actionId === 'subagents.plan.start' ? 'plan'
        : seed.actionId === 'subagents.delegate.start' ? 'delegate' : 'review';
    const roleId = typeof seed.input.roleId === 'string' ? seed.input.roleId : null;
    writeExistingSessionDraft({ scope: seed.scope, sessionId: seed.sessionId, patch: {
        executionRunLauncher: { key: executionRunLauncherDraftKey({ intent, roleId }), patch: {
            text: typeof seed.input.instructions === 'string' ? seed.input.instructions : '',
            selection: StrictJsonValueSchema.parse({
                identity: { correlationId: randomUUID(), inputLocalId: randomUUID() },
                actionInput: seed.input,
            }),
        } },
    } });
    return createExecutionRunLauncherDetailsTab(intent, roleId ? {
        roleId, title: resolveRoleDisplayName(roleId),
    } : undefined);
}

import {
    ActionApprovalRequestCreatedResultSchema, ProjectWorkerActionOutputSchemasV1, getActionSpec,
    type ProjectWorkerActionIdV1, type ProjectWorkerActionInputV1, type ProjectWorkerActionOutputV1,
} from '@happier-dev/protocol';
import { randomUUID } from '@/platform/randomUUID';
import { withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';

export class ProjectWorkerActionError extends Error {
    constructor(readonly errorCode: string, readonly approvalArtifactId?: string) {
        super(errorCode);
        this.name = 'ProjectWorkerActionError';
    }
}

/** Settings controls consume the public Action front door, never the row HTTP port. */
export async function executeProjectWorkerActionV1<TActionId extends ProjectWorkerActionIdV1>(
    actionId: TActionId, input: ProjectWorkerActionInputV1<TActionId>, options?: Readonly<{ expectedAccountId?: string }>,
): Promise<ProjectWorkerActionOutputV1<TActionId>> {
    return await withDefaultActionExecuteContext(undefined, {
        serverId: 'workspace' in input ? input.workspace.serverId : input.serverId,
        ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
    }, async (executor, account) => {
        account.assertCurrent();
        const outcome = await executor.execute(actionId, input, {
            surface: 'ui', serverId: account.serverId, runtimeAccountId: account.accountId, actionRequestId: randomUUID(),
        });
        account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
        if (!outcome.ok) throw new ProjectWorkerActionError(outcome.errorCode ?? 'unsupported_action');
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result);
        if (approval.success) throw new ProjectWorkerActionError('approval_required', approval.data.artifactId);
        return ProjectWorkerActionOutputSchemasV1[actionId].parse(outcome.result) as ProjectWorkerActionOutputV1<TActionId>;
    }, actionId);
}

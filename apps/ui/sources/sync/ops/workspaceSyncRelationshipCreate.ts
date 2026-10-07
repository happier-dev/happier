import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkspaceSyncRelationshipCreateActionInputV1Schema, WorkspaceSyncRelationshipCreateResultV1Schema, type WorkspaceSyncRelationshipCreateActionInputV1, type WorkspaceSyncRelationshipCreateResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

/**
 * Present-user adapter for direct Project linking ("Add machine").
 *
 * The Action owner decides whether this destination needs a human decision, so
 * this adapter never auto-approves: it reports the pending approval and lets the
 * surface show the exact consequence the user is about to authorize. Relationship
 * identity is derived from `actionRequestId`, so a retry of the same draft keeps
 * its operation identity instead of minting a second relationship.
 */
export type CreateWorkspaceSyncRelationshipRequest = Readonly<{
    input: WorkspaceSyncRelationshipCreateActionInputV1;
    serverId?: string | null;
    actionRequestId: string;
    signal?: AbortSignal;
}>;

export type CreateWorkspaceSyncRelationshipOutcome =
    | Readonly<{ kind: 'linked'; result: WorkspaceSyncRelationshipCreateResultV1 }>
    | Readonly<{ kind: 'approval_required'; artifactId: string }>;

function actionError(errorCode: string, message: string): Error {
    return Object.assign(new Error(message), { code: errorCode });
}

function readCreateResult(raw: unknown): WorkspaceSyncRelationshipCreateResultV1 {
    const parsed = WorkspaceSyncRelationshipCreateResultV1Schema.safeParse(raw);
    if (!parsed.success) {
        throw actionError('workspace_sync_unavailable', 'Unsupported workspace link result');
    }
    return parsed.data;
}

/**
 * Reads the exact execution outcome recorded on an approved artifact. A decided
 * approval reports its own execution result, so a failure here is the real
 * effect's failure rather than a rejected decision.
 */
function readApprovedCreateResult(raw: unknown): WorkspaceSyncRelationshipCreateResultV1 {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw actionError('workspace_sync_unavailable', 'Unsupported workspace link approval result');
    }
    const decision = raw as Readonly<Record<string, unknown>>;
    const execution = decision.execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
        throw actionError('workspace_sync_unavailable', 'Unsupported workspace link approval result');
    }
    const executionRecord = execution as Readonly<Record<string, unknown>>;
    if (executionRecord.ok !== true) {
        const errorCode = typeof executionRecord.errorCode === 'string' && executionRecord.errorCode.trim()
            ? executionRecord.errorCode.trim()
            : 'approval_execution_failed';
        const message = typeof executionRecord.error === 'string' && executionRecord.error.trim()
            ? executionRecord.error.trim()
            : errorCode;
        throw actionError(errorCode, message);
    }
    return readCreateResult(executionRecord.result);
}

export async function createWorkspaceSyncRelationship(
    request: CreateWorkspaceSyncRelationshipRequest,
): Promise<CreateWorkspaceSyncRelationshipOutcome> {
    const actionInput = WorkspaceSyncRelationshipCreateActionInputV1Schema.parse(request.input);
    const executor = createDefaultActionExecutor();
    const started = await executor.execute('workspace.sync.relationship.create', actionInput, {
        serverId: request.serverId ?? undefined,
        surface: 'ui',
        actionRequestId: request.actionRequestId,
        signal: request.signal,
    });
    if (!started.ok) throw actionError(started.errorCode, started.error);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(started.result);
    if (approval.success) {
        return { kind: 'approval_required', artifactId: approval.data.artifactId };
    }
    return { kind: 'linked', result: readCreateResult(started.result) };
}

/**
 * Completes a link whose destination consequence the person just accepted. The
 * approved artifact replays the exact input it stored; this adapter cannot
 * substitute a different destination for the one that was shown.
 */
export async function approveWorkspaceSyncRelationshipCreate(
    request: Readonly<{ artifactId: string; serverId?: string | null; signal?: AbortSignal }>,
): Promise<WorkspaceSyncRelationshipCreateResultV1> {
    const executor = createDefaultActionExecutor();
    const decided = await executor.execute('approval.request.decide', {
        artifactId: request.artifactId,
        decision: 'approve',
    }, {
        serverId: request.serverId ?? undefined,
        surface: 'ui',
        signal: request.signal,
    });
    if (!decided.ok) throw actionError(decided.errorCode, decided.error);
    return readApprovedCreateResult(decided.result);
}

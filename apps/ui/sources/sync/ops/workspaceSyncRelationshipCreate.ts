import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkspaceSyncRelationshipWriteActionInputV1Schema, WorkspaceSyncRelationshipCreateResultV1Schema, type WorkspaceSyncRelationshipWriteActionInputV1, type WorkspaceSyncRelationshipCreateResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import type { Machine } from '@/sync/domains/state/storageTypes';

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
    input: WorkspaceSyncRelationshipWriteActionInputV1;
    serverId?: string | null;
    actionRequestId: string;
    signal?: AbortSignal;
    /** From `resolveWorkspaceSyncDestinationPlacement`; absent keeps the source-run relationship. */
    placement?: WorkspaceSyncDestinationPlacement;
}>;

export type CreateWorkspaceSyncRelationshipOutcome =
    | Readonly<{ kind: 'linked'; result: WorkspaceSyncRelationshipCreateResultV1 }>
    | Readonly<{ kind: 'opened'; workspace: WorkspaceAddressV1 }>
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

/**
 * Where Add Machine runs, decided once from the published Machine access fact.
 * Manage keeps the source-run relationship Action, whose target admission
 * needs Manage even on the source Machine itself. A Can use destination, the
 * source Machine included, opens the source Workspace there through Project
 * Open Sync, whose native member owner admits only the person's own member
 * folder (owner ruling 2026-11-14).
 */
export type WorkspaceSyncDestinationPlacement = 'source_relationship' | 'destination_open';

export function resolveWorkspaceSyncDestinationPlacement(
    destination: Pick<Machine, 'isShared' | 'access'>,
): WorkspaceSyncDestinationPlacement {
    return canManageMachine(destination) ? 'source_relationship' : 'destination_open';
}

/** Project Open Sync result in this adapter's outcome; refusals keep their typed code. */
function readDestinationOpenResult(raw: unknown): CreateWorkspaceSyncRelationshipOutcome {
    const parsed = OpenProjectResultV1Schema.safeParse(raw);
    if (!parsed.success) throw actionError('workspace_sync_unavailable', 'Unsupported workspace link result');
    const result = parsed.data;
    if (result.kind === 'opened') return { kind: 'opened', workspace: result.workspace };
    if (result.kind === 'refused') throw actionError(result.code, result.code);
    if (result.kind === 'outcomeUnknown') throw actionError('indeterminate', 'The workspace link outcome is unknown');
    throw actionError('workspace_sync_unavailable', 'The source Workspace is ambiguous');
}

async function openSourceIntoDestination(request: CreateWorkspaceSyncRelationshipRequest,
    actionInput: WorkspaceSyncRelationshipWriteActionInputV1): Promise<CreateWorkspaceSyncRelationshipOutcome> {
    // Replacement and worker copies need Manage; Project Open Sync cannot express them.
    if ('replaceRelationshipId' in actionInput || actionInput.purpose) {
        throw actionError('machine_manage_required', 'This needs Manage access to the destination Machine');
    }
    if (!request.serverId) throw actionError('workspace_sync_unavailable', 'The source Home is unavailable');
    const input = OpenProjectInputV1Schema.parse({
        serverId: request.serverId, machineId: actionInput.targetMachineId,
        source: { kind: 'workspace', workspaceId: actionInput.sourceWorkspaceRefId },
        materialization: { kind: 'sync', targetPath: actionInput.targetPath, workspaceAction: {
            kind: 'create_relationship', mode: actionInput.mode, contentPolicy: actionInput.contentPolicy, flushBeforeCommit: true } },
    });
    const opened = await createDefaultActionExecutor().execute('projects.open', input, {
        serverId: request.serverId, surface: 'ui', actionRequestId: request.actionRequestId, signal: request.signal,
    });
    if (!opened.ok) throw actionError(opened.errorCode, opened.error);
    return readDestinationOpenResult(opened.result);
}

export async function createWorkspaceSyncRelationship(
    request: CreateWorkspaceSyncRelationshipRequest,
): Promise<CreateWorkspaceSyncRelationshipOutcome> {
    const actionInput = WorkspaceSyncRelationshipWriteActionInputV1Schema.parse(request.input);
    if (request.placement === 'destination_open') return await openSourceIntoDestination(request, actionInput);
    const executor = createDefaultActionExecutor();
    const started = await executor.execute('replaceRelationshipId' in actionInput ? 'workspace.sync.relationship.replace' : 'workspace.sync.relationship.create', actionInput, {
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

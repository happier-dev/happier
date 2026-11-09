import type { TriggerTargetV1} from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import {
    updateSessionTrigger,
    updateWorkflowTrigger,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
import type { WorkflowActionCallerContext } from '@/sync/domains/workflows/callWorkflowAction';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * Save as workflow (F1; 04 §5.4; 07 S16b): a trigger that holds its own steps opens them as an
 * unsaved workflow draft, carrying which trigger to point at the saved workflow. Nothing changes
 * until that draft's first Save: it writes the definition, then retargets this trigger to
 * `{kind:'workflow', ref}` through the trigger's own Action. Closing the draft leaves the trigger as
 * it was. Only an opaque id travels in the route (the temporary-data store, like the Run seed).
 */
export type TriggerRetarget =
    | Readonly<{ scope: 'session'; sessionId: string; triggerId: string; expectedRevision: number }>
    | Readonly<{ scope: 'account'; automationId: string; triggerId?: string; expectedRevision: number }>;

export type TriggerWorkflowSeed = Readonly<{
    definition: WorkflowDefinitionV1;
    retarget: TriggerRetarget;
}>;

const TRIGGER_WORKFLOW_SEED_KIND = 'trigger-workflow-seed.v1';

/** The draft seed for an inline target, or null for a target that already names a workflow. */
export function buildTriggerWorkflowSeed(target: TriggerTargetV1, retarget: TriggerRetarget): TriggerWorkflowSeed | null {
    return target.kind === 'inline' ? { definition: target.definition, retarget } : null;
}

export function storeTriggerWorkflowSeed(seed: TriggerWorkflowSeed, accountLifetime?: ServerAccountScopeLifetime | null): string {
    return storeWorkflowEditorDraftSeed(TRIGGER_WORKFLOW_SEED_KIND, seed, accountLifetime);
}

/** Read safely during render; committed intake consumes the handle against history reuse. */
export function readTriggerWorkflowSeed(id: string, scope?: ServerAccountScope | null): TriggerWorkflowSeed | null {
    return readWorkflowEditorDraftSeed(TRIGGER_WORKFLOW_SEED_KIND, id, scope);
}

/** Points the originating trigger at the saved workflow, through that trigger's own Action. */
export async function retargetTriggerToWorkflow(retarget: TriggerRetarget, workflowRef: string,
    caller?: WorkflowActionCallerContext, accountLifetime?: ServerAccountScopeLifetime | null): Promise<void> {
    const target = { kind: 'workflow', ref: workflowRef } as const;
    if (retarget.scope === 'account') {
        await updateWorkflowTrigger({
            automationId: retarget.automationId,
            ...(retarget.triggerId === undefined ? {} : { triggerId: retarget.triggerId }),
            expectedRevision: retarget.expectedRevision,
            patch: { target },
        }, { ...(caller === undefined ? {} : { context: caller, signal: caller.signal }),
            ...(accountLifetime === undefined ? {} : { accountLifetime }) });
        return;
    }
    const machineId = readMachineControlTargetForSession(retarget.sessionId)?.machineId;
    await updateSessionTrigger({
        sessionId: retarget.sessionId,
        triggerId: retarget.triggerId,
        expectedRevision: retarget.expectedRevision,
        patch: { target },
    }, {
        ...(caller === undefined ? {} : { signal: caller.signal }),
        context: { ...caller, ...(machineId ? { externalActionTarget: { kind: 'machine', machineId } as const } : {}) },
    });
}

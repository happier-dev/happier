import type { TriggerTargetV1, WorkflowDefinitionV1 } from '@happier-dev/protocol';

import {
    updateSessionTrigger,
    updateWorkflowTrigger,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';

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

type StoredSeed = Readonly<{ kind: typeof TRIGGER_WORKFLOW_SEED_KIND; seed: TriggerWorkflowSeed }>;

/** The draft seed for an inline target, or null for a target that already names a workflow. */
export function buildTriggerWorkflowSeed(target: TriggerTargetV1, retarget: TriggerRetarget): TriggerWorkflowSeed | null {
    return target.kind === 'inline' ? { definition: target.definition, retarget } : null;
}

export function storeTriggerWorkflowSeed(seed: TriggerWorkflowSeed): string {
    return storeTempData({ kind: TRIGGER_WORKFLOW_SEED_KIND, seed } satisfies StoredSeed);
}

/** Read once: returning through history never reseeds a draft over edited work. */
export function readTriggerWorkflowSeed(id: string): TriggerWorkflowSeed | null {
    const stored = getTempData<StoredSeed>(id);
    return stored !== null && stored.kind === TRIGGER_WORKFLOW_SEED_KIND ? stored.seed : null;
}

/** Points the originating trigger at the saved workflow, through that trigger's own Action. */
export async function retargetTriggerToWorkflow(retarget: TriggerRetarget, workflowRef: string): Promise<void> {
    const target = { kind: 'workflow', ref: workflowRef } as const;
    if (retarget.scope === 'account') {
        await updateWorkflowTrigger({
            automationId: retarget.automationId,
            ...(retarget.triggerId === undefined ? {} : { triggerId: retarget.triggerId }),
            expectedRevision: retarget.expectedRevision,
            patch: { target },
        });
        return;
    }
    const machineId = readMachineControlTargetForSession(retarget.sessionId)?.machineId;
    await updateSessionTrigger({
        sessionId: retarget.sessionId,
        triggerId: retarget.triggerId,
        expectedRevision: retarget.expectedRevision,
        patch: { target },
    }, machineId ? { context: { externalActionTarget: { kind: 'machine', machineId } } } : {});
}

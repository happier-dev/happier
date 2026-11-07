import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { runManagedMachineCreation } from '@/components/settings/machines/managed/managedMachineCreation';
import { bindNewManagedMachineCreationScope, type ManagedCreationScopeBindingResult } from '@/sync/ops/actions/managedCreationScopeBinding';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type AcceptedManagedWorkflowCreation = Readonly<{
    machine: ManagedMachineV1 & { enrolledMachineId: string };
    run: WorkflowRunStartResultV1;
}>;

/** New's durable-task continuation composes the existing acquisition and Run admission owners. */
export async function runNewManagedWorkflowCreation(input: Omit<Parameters<typeof runManagedMachineCreation>[0], 'draft' | 'executeAction'> & Readonly<{
    draft: ManagedMachineSelectionDraft;
    executeAction?: FrontDoorActionExecute;
    accepted?: AcceptedManagedWorkflowCreation;
    /** The scope choice remains editable while its Machine is being created. */
    readScopeDraft?: () => ManagedMachineSelectionDraft | null;
    startRun: (machineId: string, managedCreation: SessionManagedCreationV1) => Promise<WorkflowRunStartResultV1 | null>;
    onAccepted: (value: AcceptedManagedWorkflowCreation) => void;
}>): Promise<Readonly<{ kind: 'accepted'; accepted: AcceptedManagedWorkflowCreation; binding: ManagedCreationScopeBindingResult }>
    | Readonly<{ kind: 'pending' | 'failed'; code?: string }>> {
    let accepted = input.accepted;
    if (!accepted) {
        const acquired = await runManagedMachineCreation(input);
        if (acquired.kind !== 'enrolled') return { kind: acquired.kind === 'pending' ? 'pending' : 'failed',
            ...('code' in acquired ? { code: acquired.code } : {}) };
        if (!input.isCurrent() || input.signal.aborted) return { kind: 'failed', code: 'continuation_retired' };
        const run = await input.startRun(acquired.machine.enrolledMachineId, {
            homeId: acquired.machine.homeId, managedId: acquired.machine.id, controller: acquired.machine.controller,
        });
        if (!run) return { kind: 'pending' };
        accepted = { machine: acquired.machine, run };
        input.onAccepted(accepted);
    }
    const scopeDraft = input.readScopeDraft ? input.readScopeDraft() : input.draft;
    const binding = scopeDraft === null ? { kind: 'incomplete' as const, code: 'continuation_retired' }
        : await bindNewManagedMachineCreationScope({
            draft: scopeDraft, machine: accepted.machine,
            source: { kind: 'run', source: { kind: 'workflow_run', runId: accepted.run.run.id } },
            scope: input.scope, signal: input.signal, isCurrent: input.isCurrent,
            executeAction: input.executeAction, onApprovalPending: input.onApprovalPending,
        });
    return { kind: 'accepted', accepted, binding };
}

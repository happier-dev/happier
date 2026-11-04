import { buildAutomationRunMachineWakeUpdate, emitAutomationRunUpdatedToMachineOnly } from '@/app/automations/automationChangePublisher';
import { AUTOMATION_RUN_TERMINAL_STATES } from '@/app/automations/automationTypes';
import { db } from '@/storage/db';
import { afterTx, type Tx } from '@/storage/inTx';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import type { Socket } from 'socket.io';

type AdmittedWorkflowMachineTarget = Pick<Extract<MachineAdmission, { kind: 'admitted' }>, 'machineId' | 'custodianAccountId'>;

/** The connect owner has already authenticated this exact installed Machine socket. */
export async function replayWorkflowRunMachineWakes(input: Readonly<{
    custodianAccountId: string; machineId: string; installationId: string; socket: Socket;
}>): Promise<void> {
    const assignments = await db.automationRunAssignment.findMany({ where: {
        machineId: input.machineId, admittedMachineInstallationId: input.installationId,
        run: { workflowCustodyState: 'pending', state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } },
    }, select: { run: { select: {
        id: true, accountId: true, automationId: true, triggerId: true, state: true,
        scheduledAt: true, startedAt: true, finishedAt: true, updatedAt: true,
        claimedByMachineId: true, attempt: true, account: { select: { seq: true } },
    } } } });
    for (const { run } of assignments) {
        if (!input.socket.connected) return;
        input.socket.emit('update', buildAutomationRunMachineWakeUpdate({ accountId: input.custodianAccountId,
            machineId: input.machineId, run, cursor: run.account.seq,
            ...(run.accountId !== input.custodianAccountId ? { requesterScope: {
                kind: 'workflow_trigger', id: run.triggerId ?? run.id,
            } } : {}),
        }));
    }
}

/** Immutable admission chooses the executor; grant changes apply to the next admission. */
export async function publishWorkflowRunMachineWakeInTx(tx: Tx, params: Readonly<{
    accountId: string;
    run: Parameters<typeof emitAutomationRunUpdatedToMachineOnly>[0]['run'] & { triggerId?: string | null };
    cursor: { resolveCursor(): number };
    workflowControl?: 'cancel_requested' | 'review_resolved';
    admittedTargets?: readonly AdmittedWorkflowMachineTarget[];
}>) {
    const targets = params.admittedTargets ?? await readWorkflowRunMachineTargetsInTx(tx, params);
    for (const target of targets) {
        afterTx(tx, () => emitAutomationRunUpdatedToMachineOnly({ accountId: target.custodianAccountId,
            machineId: target.machineId, run: params.run, cursor: params.cursor.resolveCursor(),
            ...(target.custodianAccountId !== params.accountId ? { requesterScope: {
                kind: 'workflow_trigger', id: params.run.triggerId ?? params.run.id,
            } } : {}),
            ...(params.workflowControl ? { workflowControl: params.workflowControl } : {}),
        }));
    }
}

async function readWorkflowRunMachineTargetsInTx(tx: Tx, params: Readonly<{
    accountId: string; run: Readonly<{ id: string }>;
}>): Promise<AdmittedWorkflowMachineTarget[]> {
    const assignments = await tx.automationRunAssignment.findMany({ where: { runId: params.run.id },
        select: { machineId: true, admittedMachineInstallationId: true } });
    const machines = await tx.machine.findMany({ where: { id: { in: assignments.map(row => row.machineId) },
        revokedAt: null, replacedByMachineId: null }, select: { id: true, accountId: true, installationId: true } });
    const machinesById = new Map(machines.map(machine => [machine.id, machine]));
    const targets: AdmittedWorkflowMachineTarget[] = [];
    for (const assignment of assignments) {
        const machine = machinesById.get(assignment.machineId);
        if (!machine || (assignment.admittedMachineInstallationId === null
            ? machine.accountId !== params.accountId
            : machine.installationId !== assignment.admittedMachineInstallationId)) continue;
        targets.push({ machineId: machine.id, custodianAccountId: machine.accountId });
    }
    return targets;
}

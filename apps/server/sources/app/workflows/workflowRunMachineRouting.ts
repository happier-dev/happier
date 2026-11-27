import { buildAutomationRunMachineWakeUpdate, emitAutomationRunUpdatedToMachineOnly } from '@/app/automations/automationChangePublisher';
import { automationRunClaimExclusionsCte } from '@/app/automations/automationRunClaimEligibility';
import { db } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { workflowRunSqlIdentifier } from './workflowRunAttention';
import { afterTx, type Tx } from '@/storage/inTx';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import type { Socket } from 'socket.io';
import { log } from '@/utils/logging/log';

type AdmittedWorkflowMachineTarget = Pick<Extract<MachineAdmission, { kind: 'admitted' }>, 'machineId' | 'custodianAccountId'>;
type WorkflowWakeRun = Parameters<typeof emitAutomationRunUpdatedToMachineOnly>[0]['run']
    & Readonly<{ triggerId?: string | null; causeKind?: string | null }>;

function requesterCustodyWake(run: WorkflowWakeRun, accountId: string, custodianAccountId: string): Pick<
    Parameters<typeof emitAutomationRunUpdatedToMachineOnly>[0], 'requesterScope' | 'workflowAutomationRequesterAccountId'
> {
    if (accountId === custodianAccountId) return {};
    // Run now is admitted for the saved Automation, with no individual trigger as its cause.
    return run.automationId && run.causeKind === 'manual' ? { workflowAutomationRequesterAccountId: accountId }
        : { requesterScope: { kind: 'workflow_trigger', id: run.triggerId ?? run.id } };
}

/** The connect owner has already authenticated this exact installed Machine socket. */
export async function replayWorkflowRunMachineWakes(input: Readonly<{
    custodianAccountId: string; machineId: string; installationId: string; socket: Socket;
}>): Promise<void> {
    const assignments = await db.automationRunAssignment.findMany({ where: {
        machineId: input.machineId, admittedMachineInstallationId: input.installationId,
        run: { workflowCustodyState: 'pending' },
    }, select: { run: { select: {
        id: true, accountId: true, automationId: true, triggerId: true, causeKind: true, state: true,
        scheduledAt: true, startedAt: true, finishedAt: true, updatedAt: true,
        claimedByMachineId: true, attempt: true, account: { select: { seq: true } },
    } } } });
    for (const { run } of assignments) {
        if (!input.socket.connected) return;
        if (run.state === 'queued') log({ event: 'workflow_run_phase', runId: run.id, phase: 'dispatch_publication',
            timestamp: new Date().toISOString(), machineId: input.machineId });
        input.socket.emit('update', buildAutomationRunMachineWakeUpdate({ accountId: input.custodianAccountId,
            machineId: input.machineId, run, cursor: run.account.seq,
            ...requesterCustodyWake(run, run.accountId, input.custodianAccountId),
        }));
    }
}

/** Immutable admission chooses the executor; grant changes apply to the next admission. */
export async function publishWorkflowRunMachineWakeInTx(tx: Tx, params: Readonly<{
    accountId: string;
    run: WorkflowWakeRun;
    cursor: { resolveCursor(): number };
    workflowControl?: 'cancel_requested' | 'review_resolved';
    admittedTargets?: readonly AdmittedWorkflowMachineTarget[];
}>) {
    const targets = params.admittedTargets ?? await readWorkflowRunMachineTargetsInTx(tx, params);
    for (const target of targets) {
        afterTx(tx, () => {
            if (params.run.state === 'queued' && !params.workflowControl) log({ event: 'workflow_run_phase', runId: params.run.id, phase: 'dispatch_publication',
                timestamp: new Date().toISOString(), machineId: target.machineId });
            emitAutomationRunUpdatedToMachineOnly({ accountId: target.custodianAccountId,
                machineId: target.machineId, run: params.run, cursor: params.cursor.resolveCursor(),
                ...requesterCustodyWake(params.run, params.accountId, target.custodianAccountId),
                ...(params.workflowControl ? { workflowControl: params.workflowControl } : {}),
            });
        });
    }
}

/** Send one claim hint per frozen route after a rule frees capacity. The worker claim still selects the Run. */
export async function publishQueuedAutomationRuleMachineWakesInTx(tx: Tx, params: Readonly<{
    accountId: string;
    automationId: string;
    cursor: { resolveCursor(): number };
    capRaised?: boolean;
}>) {
    const id = workflowRunSqlIdentifier;
    type Timestamp = Date | number | bigint;
    type WakeRow = Readonly<Omit<WorkflowWakeRun, 'scheduledAt' | 'startedAt' | 'finishedAt' | 'updatedAt' | 'state'> & {
        scheduledAt: Timestamp; startedAt: Timestamp | null; finishedAt: Timestamp | null; updatedAt: Timestamp;
        machineId: string; accountId: string; installationId: string | null; admittedMachineInstallationId: string | null;
    }>;
    const rows = await tx.$queryRaw<WakeRow[]>(prismaRuntime.sql`
        WITH ${automationRunClaimExclusionsCte(params.accountId, params.automationId)}, ranked AS (
            SELECT r.${id('id')}, r.${id('automationId')}, r.${id('triggerId')}, r.${id('causeKind')},
                r.${id('scheduledAt')}, r.${id('startedAt')}, r.${id('finishedAt')}, r.${id('updatedAt')},
                r.${id('claimedByMachineId')}, r.${id('attempt')}, a.${id('machineId')}, a.${id('admittedMachineInstallationId')},
                m.${id('accountId')}, m.${id('installationId')},
                ROW_NUMBER() OVER (PARTITION BY a.${id('machineId')}, a.${id('admittedMachineInstallationId')},
                    CASE WHEN m.${id('accountId')} = r.${id('accountId')} OR r.${id('causeKind')} = 'manual' THEN NULL
                        ELSE COALESCE(r.${id('triggerId')}, r.${id('id')}) END
                    ORDER BY r.${id('id')}) AS ordinal
            FROM ${id('AutomationRun')} r JOIN ${id('AutomationRunAssignment')} a ON a.${id('runId')} = r.${id('id')}
                JOIN ${id('Machine')} m ON m.${id('id')} = a.${id('machineId')}
                JOIN ${id('Automation')} rule ON rule.${id('id')} = r.${id('automationId')}
            WHERE r.${id('accountId')} = ${params.accountId} AND r.${id('automationId')} = ${params.automationId}
                AND r.${id('state')} = 'queued' AND m.${id('revokedAt')} IS NULL AND m.${id('replacedByMachineId')} IS NULL
                ${params.capRaised ? prismaRuntime.empty : prismaRuntime.sql`AND rule.${id('maxConcurrentRuns')} IS NOT NULL`}
                AND NOT EXISTS (SELECT 1 FROM claim_exclusions e WHERE (e.kind = 'rule' AND e.id = r.${id('automationId')})
                    OR (e.kind = 'trigger' AND e.id = r.${id('triggerId')}))
        ) SELECT * FROM ranked WHERE ordinal = 1`);
    const timestamp = (value: Timestamp) => value instanceof Date ? value : new Date(Number(value));
    const emittedRoutes = new Set<string>();
    for (const row of rows) {
        const target = workflowRunAdmittedMachineTarget(params.accountId, row, { ...row, id: row.machineId });
        if (!target) continue;
        const route = JSON.stringify([target.machineId, requesterCustodyWake(row, params.accountId, target.custodianAccountId)]);
        if (emittedRoutes.has(route)) continue;
        emittedRoutes.add(route);
        await publishWorkflowRunMachineWakeInTx(tx, { ...params, admittedTargets: [target], run: {
            ...row, state: 'queued', scheduledAt: timestamp(row.scheduledAt), updatedAt: timestamp(row.updatedAt),
            startedAt: row.startedAt === null ? null : timestamp(row.startedAt),
            finishedAt: row.finishedAt === null ? null : timestamp(row.finishedAt),
        } });
    }
}

function workflowRunAdmittedMachineTarget(accountId: string, assignment: Readonly<{ admittedMachineInstallationId: string | null }>,
    machine: Readonly<{ id: string; accountId: string; installationId: string | null }> | undefined): AdmittedWorkflowMachineTarget | null {
    if (!machine || (assignment.admittedMachineInstallationId === null
        ? machine.accountId !== accountId
        : machine.installationId !== assignment.admittedMachineInstallationId)) return null;
    return { machineId: machine.id, custodianAccountId: machine.accountId };
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
        const target = workflowRunAdmittedMachineTarget(params.accountId, assignment, machinesById.get(assignment.machineId));
        if (target) targets.push(target);
    }
    return targets;
}

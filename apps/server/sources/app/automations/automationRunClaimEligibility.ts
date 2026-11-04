import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { automationRunWithoutExecutionWhere } from './automationPersistenceSelect';
import type { AutomationRecipeFeaturePolicy } from './automationRecipeFeaturePolicy';
import { AUTOMATION_RUN_TERMINAL_STATES } from './automationTypes';

export function runAssignmentClaimWhere(machineId: string): Prisma.AutomationRunAssignmentListRelationFilter {
    return { some: { machineId } };
}

export function leasedAutomationRunClaimWhere(machineId: string): Prisma.AutomationRunWhereInput {
    return {
        assignments: runAssignmentClaimWhere(machineId),
        OR: [
            { state: { in: ['claimed', 'running'] } },
            { state: 'pause_requested', workflowCustodyState: 'pending' },
        ],
    };
}

/** One candidate owner serves immediate claims and their future deadline projection. */
export async function readAutomationRunClaimEligibilityWhereInTx(tx: Pick<Tx, 'automationRun'>, params: Readonly<{
    accountId: string;
    machineId: string;
    scope?: 'session_scoped' | 'workflow' | 'execution';
    recipeFeaturePolicy: AutomationRecipeFeaturePolicy;
    /** Absent for a wake inventory: retain future due times and lease expiries. */
    now?: Date;
    admittedMachineInstallationId?: string | null;
    allowUnboundMachineAssignment?: boolean;
}>): Promise<Prisma.AutomationRunWhereInput | null> {
    if (params.scope === 'workflow' && !params.recipeFeaturePolicy.workflowsEnabled) return null;
    const activeScoped = await tx.automationRun.findMany({
        where: { accountId: params.accountId, triggerId: { not: null },
            automation: { is: { scopeSessionId: { not: null } } },
            state: { notIn: ['queued', ...AUTOMATION_RUN_TERMINAL_STATES] } },
        select: { triggerId: true }, distinct: ['triggerId'],
    });
    const activeTriggerIds = activeScoped.flatMap(run => run.triggerId ? [run.triggerId] : []);
    return {
        accountId: params.accountId,
        ...(params.admittedMachineInstallationId !== undefined ? { assignments: { some: {
            machineId: params.machineId,
            OR: [...(params.admittedMachineInstallationId
                ? [{ admittedMachineInstallationId: params.admittedMachineInstallationId }] : []),
                ...(params.allowUnboundMachineAssignment ? [{ admittedMachineInstallationId: null }] : [])],
        } } } : {}),
        ...(params.scope === 'session_scoped' ? { automation: { is: { scopeSessionId: { not: null } } } } : {}),
        ...(params.scope === 'workflow' ? { AND: [{ OR: [
            { workflowCustodyState: { not: null } },
            { workflowCustodyState: null, originKind: 'automation', ...automationRunWithoutExecutionWhere,
                OR: [{ causeKind: 'manual' }, { causeKind: 'trigger', causeTriggerKind: 'schedule' }] },
        ] }] } : {}),
        ...(!params.recipeFeaturePolicy.workflowsEnabled ? { workflowCustodyState: null } : {}),
        ...(params.now ? { dueAt: { lte: params.now } } : {}),
        OR: [
            { state: 'queued', assignments: runAssignmentClaimWhere(params.machineId),
                ...(activeTriggerIds.length ? { OR: [{ triggerId: null }, { triggerId: { notIn: activeTriggerIds } }] } : {}) },
            { ...leasedAutomationRunClaimWhere(params.machineId),
                ...(params.now ? { leaseExpiresAt: { lt: params.now } } : { leaseExpiresAt: { not: null } }) },
        ],
    };
}

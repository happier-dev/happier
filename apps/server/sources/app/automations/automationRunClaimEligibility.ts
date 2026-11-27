import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { getDbProviderFromEnv } from '@/config/databaseProvider';
import { workflowRunSqlIdentifier } from '@/app/workflows/workflowRunAttention';
import { automationRunWithoutExecutionWhere } from './automationPersistenceSelect';
import type { AutomationRecipeFeaturePolicy } from './automationRecipeFeaturePolicy';
import { AUTOMATION_RUN_TERMINAL_STATES } from './automationTypes';

export function runAssignmentClaimWhere(machineId: string): Prisma.AutomationRunAssignmentListRelationFilter {
    return { some: { machineId } };
}

const machineClaimStates = ['claimed', 'running'] as const;
const pendingPauseState = 'pause_requested';

export function occupiesAutomationRuleSlot(state: string, custody: string | null): boolean {
    return machineClaimStates.some(claimState => claimState === state)
        || (state === pendingPauseState && custody === 'pending');
}

export function leasedAutomationRunClaimWhere(machineId: string): Prisma.AutomationRunWhereInput {
    return {
        assignments: runAssignmentClaimWhere(machineId),
        OR: [
            { state: { in: [...machineClaimStates] } },
            { state: pendingPauseState, workflowCustodyState: 'pending' },
        ],
    };
}

type ClaimExclusion = Readonly<{ kind: 'trigger' | 'rule'; id: string }>;

/** Read scoped-trigger and rule occupancy together. The claim transaction re-reads
 * after taking its existing Account publication lock, before changing a Run. */
export function automationRunClaimExclusionsCte(accountId: string, automationId?: string): Prisma.Sql {
    const id = workflowRunSqlIdentifier;
    const textType = prismaRuntime.raw(getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? 'CHAR' : 'TEXT');
    return prismaRuntime.sql`
        admitted AS (
            SELECT r.${id('automationId')} AS rule_id, r.${id('triggerId')} AS trigger_id,
                a.${id('scopeSessionId')} AS scope_session_id, a.${id('maxConcurrentRuns')} AS run_cap,
                CAST(r.${id('state')} AS ${textType}) AS run_state,
                CAST(r.${id('workflowCustodyState')} AS ${textType}) AS custody_state
            FROM ${id('AutomationRun')} r JOIN ${id('Automation')} a ON a.${id('id')} = r.${id('automationId')}
            WHERE r.${id('accountId')} = ${accountId}
                ${automationId === undefined ? prismaRuntime.empty : prismaRuntime.sql`AND r.${id('automationId')} = ${automationId}`}
                AND CAST(r.${id('state')} AS ${textType}) NOT IN (${prismaRuntime.join(['queued', ...AUTOMATION_RUN_TERMINAL_STATES])})
                AND (a.${id('maxConcurrentRuns')} IS NOT NULL
                    OR (a.${id('scopeSessionId')} IS NOT NULL AND r.${id('triggerId')} IS NOT NULL))
        ), claim_exclusions AS (
            SELECT 'trigger' AS kind, trigger_id AS id FROM admitted
                WHERE scope_session_id IS NOT NULL AND trigger_id IS NOT NULL GROUP BY trigger_id
            UNION ALL
            SELECT 'rule' AS kind, rule_id AS id FROM admitted
                WHERE run_cap IS NOT NULL AND (run_state IN (${prismaRuntime.join([...machineClaimStates])})
                    OR (run_state = ${pendingPauseState} AND custody_state = 'pending'))
                GROUP BY rule_id, run_cap HAVING COUNT(*) >= run_cap
        )`;
}

/** One candidate owner serves immediate claims and their future deadline projection. */
export async function readAutomationRunClaimEligibilityWhereInTx(tx: Pick<Tx, '$queryRaw'>, params: Readonly<{
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
    const exclusions = await tx.$queryRaw<ClaimExclusion[]>(prismaRuntime.sql`
        WITH ${automationRunClaimExclusionsCte(params.accountId)} SELECT kind, id FROM claim_exclusions`);
    const activeTriggerIds = exclusions.filter(row => row.kind === 'trigger').map(row => row.id);
    const cappedRuleIds = exclusions.filter(row => row.kind === 'rule').map(row => row.id);
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
                AND: [
                    ...(activeTriggerIds.length ? [{ OR: [{ triggerId: null }, { triggerId: { notIn: activeTriggerIds } }] }] : []),
                    ...(cappedRuleIds.length ? [{ OR: [{ automationId: null }, { automationId: { notIn: cappedRuleIds } }] }] : []),
                ] },
            { ...leasedAutomationRunClaimWhere(params.machineId),
                ...(params.now ? { leaseExpiresAt: { lt: params.now } } : { leaseExpiresAt: { not: null } }) },
        ],
    };
}

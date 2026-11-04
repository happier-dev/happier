import type { AutomationDefinitionCreateRequest } from '@happier-dev/protocol/automations/automationApiV3';
import { readSharedWorkflowTriggerSummaryRecipientsInTx, type SharedWorkflowSummaryDefinition } from '@/app/automations/automationSharedWorkflowSummaries';
import type { Prisma } from "@prisma/client";
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { readAutomationSessionReviewProjectionIdsInTx } from "@/app/automations/sessionReviewProjectionInvalidation";
import { automationRunCauseSelect } from "@/app/automations/automationPersistenceSelect";
import { isAutomationCauseRow, retainedV2OriginKindForRun } from "@/app/automations/automationRunCauseCodec";
import { resolveAutomationPendingInputSessionIdTx } from "@/app/automations/automationRunSessionTarget";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readManagedWakePublicationAccountIdsInTx } from "@/app/machines/managed/managedWake";
import {
    resolveWorkflowRunAdmissionRecipientAccountIdsInTx,
    resolveWorkflowRunAdmissionVisibilityInTx,
    resolveWorkflowRunRecipientAccountIdsInTx,
} from "./workflowRunAccess";

export interface WorkflowPublicationScope {
    accountId: string;
    runIds?: readonly string[];
    runWhere?: Prisma.AutomationRunWhereInput;
    automationIds?: readonly string[];
    /** Prospective structural facts must be admitted before a definition reseal. */
    automationDefinitionWrite?: Readonly<Pick<AutomationDefinitionCreateRequest, 'workflowDefinitionId' | 'scopeSessionId' | 'executionRecipe'> & {
        id: string; accountId: string;
    }>;
    automationWhere?: Prisma.AutomationWhereInput;
    triggerIds?: readonly string[];
    runSourceTriggerWhere?: Prisma.AutomationTriggerWhereInput;
    sessionIds?: readonly string[];
    machineIds?: readonly string[];
    admission?: Readonly<{
        sourceArtifactId: string | null;
        visibleTeamId?: string | null;
        authentication?: TeamOperationAuthenticationContext;
    }>;
}

export interface WorkflowPublicationAudience {
    accountIds: string[];
    sessionIds: string[];
}

async function readAutomationPublicationAudienceInTx(tx: Tx, automationIds: readonly string[],
    definitionWrite?: WorkflowPublicationScope['automationDefinitionWrite']): Promise<WorkflowPublicationAudience> {
    if (automationIds.length === 0 && !definitionWrite) return { accountIds: [], sessionIds: [] };
    const automations: (SharedWorkflowSummaryDefinition & { id: string; assignments: { machineId: string }[] })[] = [];
    // The enabled-assignment predicate and portable Prisma offset share the ID budget.
    for (const ids of portableQueryChunks({ values: [...new Set(automationIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await tx.automation.findMany({ where: { id: { in: [...ids] } }, select: {
            id: true, accountId: true, workflowDefinitionId: true, scopeSessionId: true, templateCiphertext: true,
            account: { select: { encryptionMode: true } },
            assignments: { where: { enabled: true }, select: { machineId: true } },
        } });
        automations.push(...rows);
    }
    const sessionIds = [...new Set([
        ...automations.flatMap(automation => automation.scopeSessionId ? [automation.scopeSessionId] : []),
        ...await readAutomationSessionReviewProjectionIdsInTx(tx, automationIds),
    ])].sort();
    const managedAccounts = await readManagedWakePublicationAccountIdsInTx(tx, {
        machineTargets: automations.flatMap(automation => automation.assignments.map(assignment => ({
            accountId: automation.accountId, machineId: assignment.machineId,
        }))),
        sessionIds,
    });
    const summaries: SharedWorkflowSummaryDefinition[] = automations.filter(row => row.id !== definitionWrite?.id);
    if (definitionWrite) {
        const stored = automations.find(row => row.id === definitionWrite.id);
        const account = stored?.account ?? await tx.account.findUnique({ where: { id: definitionWrite.accountId }, select: { encryptionMode: true } });
        if (account) summaries.push({ accountId: definitionWrite.accountId, account,
            workflowDefinitionId: definitionWrite.workflowDefinitionId === undefined ? stored?.workflowDefinitionId ?? null : definitionWrite.workflowDefinitionId,
            scopeSessionId: definitionWrite.scopeSessionId === undefined ? stored?.scopeSessionId ?? null : definitionWrite.scopeSessionId,
            templateCiphertext: definitionWrite.executionRecipe === undefined ? stored?.templateCiphertext ?? '' : JSON.stringify(definitionWrite.executionRecipe),
        });
    }
    const sharedAccounts = (await Promise.all(summaries.map(row => readSharedWorkflowTriggerSummaryRecipientsInTx(tx, row)))).flat();
    return { accountIds: [...new Set([...automations.map(automation => automation.accountId), ...managedAccounts, ...sharedAccounts])].sort(), sessionIds };
}

/** Session fact writers collect lifecycle admission's review/wake audience before locking their source. */
export async function getSessionLifecycleAutomationPublicationAudienceInTx(tx: Tx, sourceSessionIds: readonly string[]): Promise<WorkflowPublicationAudience> {
    if (sourceSessionIds.length === 0) return { accountIds: [], sessionIds: [] };
    const automationIds = new Set<string>();
    // Kind, both enabled predicates and the portable Prisma offset are fixed bindings.
    for (const ids of portableQueryChunks({ values: [...new Set(sourceSessionIds)], bindingsPerValue: 1, fixedBindings: 4 })) {
        const triggers = await tx.automationTrigger.findMany({ where: {
            kind: "sessionLifecycle", sourceSessionId: { in: [...ids] }, enabled: true, deletedAt: null,
            automation: { enabled: true, deletedAt: null },
        }, distinct: ["automationId"], select: { automationId: true } });
        for (const trigger of triggers) automationIds.add(trigger.automationId);
    }
    return readAutomationPublicationAudienceInTx(tx, [...automationIds]);
}

/** Pure census of the immediate source, watcher, review and managed-wake composition; never acquires locks. */
export async function getWorkflowPublicationAudienceInTx(tx: Tx, scope: WorkflowPublicationScope): Promise<WorkflowPublicationAudience & Readonly<{ runIds: readonly string[] }>> {
    const selectedAutomations = scope.automationWhere || scope.triggerIds?.length ? await tx.automation.findMany({
        where: { accountId: scope.accountId, OR: [
            ...(scope.automationWhere ? [scope.automationWhere] : []),
            ...(scope.triggerIds?.length ? [{ triggers: { some: { id: { in: [...scope.triggerIds] } } } }] : []),
        ] }, select: { id: true },
    }) : [];
    const automationIds = new Set([...(scope.automationIds ?? []), ...selectedAutomations.map(automation => automation.id)]);
    // Definition writers validate and catch up their retained Run sources in the
    // same transaction. Those source owners must precede the target's mode fence.
    const sourceTriggers = scope.runSourceTriggerWhere ? await tx.automationTrigger.findMany({ where: {
        AND: [scope.runSourceTriggerWhere], kind: "runLifecycle", sourceRunMachineId: null, deletedAt: null,
    }, select: { sourceRunId: true } }) : [];
    const runIds = [...new Set([...(scope.runIds ?? []), ...sourceTriggers.flatMap(trigger => trigger.sourceRunId ? [trigger.sourceRunId] : [])])];
    const runs = runIds.length > 0 || scope.runWhere ? await tx.automationRun.findMany({ where: { OR: [
        ...(runIds.length > 0 ? [{ id: { in: runIds } }] : []),
        ...(scope.runWhere ? [scope.runWhere] : []),
    ] }, select: { ...automationRunCauseSelect, id: true, accountId: true, automationId: true,
        originSessionId: true, producedSessionId: true, executionInputEnvelope: true,
        account: { select: { encryptionMode: true } },
        workflowCustodyState: true, assignments: { select: { machineId: true } } } }) : [];
    for (const run of runs) if (run.automationId) automationIds.add(run.automationId);
    const watchers = runs.length > 0 ? await tx.automationTrigger.findMany({ where: {
        kind: "runLifecycle", sourceRunId: { in: runs.map(run => run.id) }, sourceRunMachineId: null,
        enabled: true, deletedAt: null, remainingOccurrences: 1, automation: { enabled: true, deletedAt: null },
    }, distinct: ["automationId"], select: { automationId: true } }) : [];
    for (const watcher of watchers) automationIds.add(watcher.automationId);
    const automationAudience = await readAutomationPublicationAudienceInTx(tx, [...automationIds], scope.automationDefinitionWrite);
    const followDestinations = runs.length ? await tx.sessionFollowEdge.findMany({ where: {
        sourceWorkflowRunId: { in: runs.map(run => run.id) }, relation: 'follower',
    }, select: { destinationSessionId: true } }) : [];
    const pendingTargetSessionIds: string[] = [];
    for (const run of runs) {
        if (!isAutomationCauseRow(run)) continue;
        // This is a pure candidate census, not mode admission. The complete
        // Account/Session cohort is fenced and reread by the caller afterward.
        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(run.account);
        if (mode.status !== "ready") continue;
        const sessionId = await resolveAutomationPendingInputSessionIdTx({
            tx, accountId: run.accountId, automationId: run.automationId, runId: run.id,
            executionInputEnvelope: run.executionInputEnvelope, accountEncryptionMode: mode.mode,
            retainedV2OriginKind: retainedV2OriginKindForRun(run),
        });
        if (sessionId !== null) pendingTargetSessionIds.push(sessionId);
    }
    const sessionIds = [...new Set([...(scope.sessionIds ?? []), ...automationAudience.sessionIds,
        ...pendingTargetSessionIds,
        ...followDestinations.map(edge => edge.destinationSessionId),
        ...runs.flatMap(run => [run.originSessionId, run.producedSessionId].filter((id): id is string => id !== null)),
    ])].sort();
    const accountIds = new Set([scope.accountId, ...runs.map(run => run.accountId), ...automationAudience.accountIds]);
    for (const run of runs) {
        if (run.workflowCustodyState !== null) {
            for (const accountId of await resolveWorkflowRunRecipientAccountIdsInTx(tx, run.id)) accountIds.add(accountId);
        }
    }
    if (scope.admission) {
        const visibleTeamId = await resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: scope.accountId, ...scope.admission,
        });
        for (const accountId of await resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
            accountId: scope.accountId, sourceArtifactId: scope.admission.sourceArtifactId, visibleTeamId,
        })) accountIds.add(accountId);
    }
    for (const accountId of await readManagedWakePublicationAccountIdsInTx(tx, {
        machineTargets: [
            ...runs.flatMap(run => run.assignments.map(assignment => ({ accountId: run.accountId, machineId: assignment.machineId }))),
            ...(scope.machineIds ?? []).map(machineId => ({ accountId: scope.accountId, machineId })),
        ], sessionIds,
    })) accountIds.add(accountId);
    return { accountIds: [...accountIds].sort(), sessionIds, runIds: runs.map(run => run.id).sort() };
}

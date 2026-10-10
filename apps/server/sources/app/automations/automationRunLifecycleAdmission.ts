import {
    AutomationRunLifecycleOccurrenceEvidenceV1Schema,
    AutomationRunCauseSchema, deriveAutomationOccurrenceKeyV1, createCanonicalJsonSigningInput,
    type AutomationRunLifecycleTrigger, type AutomationRunLifecycleOccurrenceEvidenceV1,
} from "@happier-dev/protocol";
import type { Tx } from "@/storage/inTx";
import { resolveWorkflowRunAccessInTx } from "@/app/workflows/workflowRunAccess";
import { workflowRunAttentionWhere } from "@/app/workflows/workflowRunAttention";
import { AUTOMATION_RUN_TERMINAL_STATES } from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { decodeAutomationRunLifecycleConfiguration } from "./automationRunLifecycleConfigurationCodec";
import { isAutomationOriginRunPublisherTx, readAutomationLifecycleOriginRunIdTx, readAutomationOriginTriggerIdsTx } from "./automationTriggerCauseChain";

/** Registration uses the source's existing Account access owner, never the target's placement. */
export async function validateAutomationRunLifecycleSourceTx(tx: Tx, accountId: string, definition: AutomationRunLifecycleTrigger): Promise<void> {
    if (definition.source.kind === "workflow_run") {
        if (!await resolveWorkflowRunAccessInTx(tx, { actorAccountId: accountId, runId: definition.source.runId })) {
            throw new AutomationValidationError("source_unavailable");
        }
        // Registration serializes with FIN's incumbent parent control lock before inserting the source.
        // Catch-up then sees either the prior retained fact or the completed transition, never a gap.
        const source = await tx.automationRun.findUnique({ where: { id: definition.source.runId },
            select: { revision: true, updatedAt: true } });
        if (!source || (await tx.automationRun.updateMany({ where: { id: definition.source.runId, revision: source.revision },
            data: { revision: { increment: 0 }, updatedAt: source.updatedAt } })).count !== 1) {
            throw new AutomationValidationError("currentness_conflict");
        }
        return;
    }
    if (definition.condition !== "terminal") throw new AutomationValidationError("unsupported_condition");
    const machine = await tx.machine.findFirst({ where: { id: definition.source.machineId, accountId, revokedAt: null,
        replacedByMachineId: null }, select: { id: true } });
    if (!machine) throw new AutomationValidationError("source_unavailable");
    if (definition.source.sessionId && !await tx.session.findFirst({ where: { id: definition.source.sessionId, accountId }, select: { id: true } })) {
        throw new AutomationValidationError("source_unavailable");
    }
}

/** Consumes exactly one persisted source budget through the incumbent occurrence/admission owner. */
async function admitRunLifecycleOccurrenceTx(tx: Tx, accountId: string, occurrence: AutomationRunLifecycleOccurrenceEvidenceV1,
    automationId?: string) {
    const evidence = AutomationRunLifecycleOccurrenceEvidenceV1Schema.parse(occurrence);
    const rows = await tx.automationTrigger.findMany({ where: { kind: "runLifecycle", sourceRunId: evidence.source.runId,
        ...(automationId ? { automationId } : {}),
        sourceRunMachineId: evidence.source.kind === "execution_run" ? evidence.source.machineId : null,
        enabled: true, deletedAt: null, remainingOccurrences: 1,
        automation: { accountId, enabled: true, deletedAt: null } },
        select: { id: true, automationId: true, revision: true, runLifecycleConfigurationJson: true }, orderBy: { id: "asc" } });
    const originRunId = rows.length > 0 ? await readAutomationLifecycleOriginRunIdTx(tx, evidence) : null;
    const originTriggerIds = rows.length > 0 ? await readAutomationOriginTriggerIdsTx(tx, evidence, originRunId ?? undefined) : new Set<string>();
    const admitted = [];
    for (const row of rows) {
        if (originTriggerIds.has(row.id)) continue;
        const definition = decodeAutomationRunLifecycleConfiguration(row);
        if (definition.condition !== evidence.condition
            || createCanonicalJsonSigningInput(definition.source) !== createCanonicalJsonSigningInput(evidence.source)) continue;
        await validateAutomationRunLifecycleSourceTx(tx, accountId, definition);
        const reserved = await tx.automationTrigger.updateMany({ where: { id: row.id, revision: row.revision,
            enabled: true, deletedAt: null, remainingOccurrences: 1 }, data: { remainingOccurrences: 0 } });
        if (reserved.count !== 1) continue;
        const result = await admitAutomationRunTx({ tx, accountId, automationId: row.automationId,
            now: new Date(evidence.occurredAt), cause: AutomationRunCauseSchema.parse({ kind: "trigger", triggerKind: "runLifecycle",
                triggerId: row.id, triggerRevision: row.revision, occurredAt: evidence.occurredAt,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: row.id, evidence }),
                evidence: { source: evidence.source, condition: evidence.condition, sourceRevision: evidence.sourceRevision,
                    ...(evidence.originRunId !== undefined ? { originRunId: evidence.originRunId } : {}) } }) });
        if (result.kind === "ineligible") {
            await tx.automationTrigger.updateMany({ where: { id: row.id, revision: row.revision, remainingOccurrences: 0 },
                data: { remainingOccurrences: 1 } });
        }
        admitted.push({ triggerId: row.id, result });
    }
    return admitted;
}

/** FIN transition and registration catch-up both re-read the same retained facts and attention predicate. */
export async function admitWorkflowRunLifecycleAutomationRunsTx(tx: Tx, runId: string, automationId?: string): Promise<void> {
    const watchers = await tx.automationTrigger.findMany({ where: { kind: "runLifecycle", sourceRunId: runId,
        ...(automationId ? { automationId } : {}),
        sourceRunMachineId: null, deletedAt: null, enabled: true, remainingOccurrences: 1,
        automation: { enabled: true, deletedAt: null } },
        select: { automation: { select: { accountId: true } } }, distinct: ["automationId"] });
    if (watchers.length === 0) return;
    const source = await tx.automationRun.findUnique({ where: { id: runId }, select: {
        id: true, state: true, revision: true, updatedAt: true, workflowCustodyState: true } });
    if (!source || source.workflowCustodyState === null) return;
    const locked = await tx.automationRun.updateMany({ where: { id: runId, revision: source.revision },
        data: { revision: { increment: 0 }, updatedAt: source.updatedAt } });
    if (locked.count !== 1) throw new AutomationValidationError("currentness_conflict");
    const terminal = AUTOMATION_RUN_TERMINAL_STATES.some(state => state === source.state);
    const attention = await tx.automationRun.findFirst({ where: { id: runId, AND: [workflowRunAttentionWhere()] }, select: { id: true } }) !== null;
    if (!terminal && !attention) return;
    for (const accountId of new Set(watchers.map(row => row.automation.accountId))) {
        if (!await resolveWorkflowRunAccessInTx(tx, { actorAccountId: accountId, runId })) continue;
        for (const condition of ["terminal", "needs_attention"] as const) {
            if (condition === "terminal" ? !terminal : !attention) continue;
            await admitRunLifecycleOccurrenceTx(tx, accountId, { v: 1, kind: "runLifecycle", source: { kind: "workflow_run", runId },
                condition, sourceRevision: source.revision, occurredAt: source.updatedAt.getTime() }, automationId);
        }
    }
}

/** Only the authenticated exact Machine publisher supplies execution-owner terminal evidence. */
export async function admitExecutionRunLifecycleAutomationRunsTx(params: Readonly<{
    tx: Tx; accountId: string; machineId: string; occurrence: AutomationRunLifecycleOccurrenceEvidenceV1;
}>) {
    const occurrence = AutomationRunLifecycleOccurrenceEvidenceV1Schema.parse(params.occurrence);
    if (occurrence.source.kind !== "execution_run" || occurrence.source.machineId !== params.machineId || occurrence.condition !== "terminal") {
        throw new AutomationValidationError("source_unavailable");
    }
    if (occurrence.originRunId !== undefined && !await isAutomationOriginRunPublisherTx(params.tx,
        { accountId: params.accountId, machineId: params.machineId, runId: occurrence.originRunId })) {
        throw new AutomationValidationError("source_unavailable");
    }
    return admitRunLifecycleOccurrenceTx(params.tx, params.accountId, occurrence);
}

/** CRUD calls this after persistence in its transaction; it cannot miss an already satisfied FIN source. */
export async function catchUpAutomationRunLifecycleSourcesTx(tx: Tx, automationId: string): Promise<void> {
    const rows = await tx.automationTrigger.findMany({ where: { automationId, kind: "runLifecycle", deletedAt: null,
        enabled: true, sourceRunMachineId: null, remainingOccurrences: 1 }, select: { sourceRunId: true } });
    for (const runId of new Set(rows.flatMap(row => row.sourceRunId ? [row.sourceRunId] : []))) {
        await admitWorkflowRunLifecycleAutomationRunsTx(tx, runId, automationId);
    }
}

/** Supported Machine undo retries only the waiting registrations assigned to that restored target. */
export async function catchUpAutomationRunLifecycleSourcesForRestoredMachineTx(tx: Tx, accountId: string, machineId: string): Promise<void> {
    const rows = await tx.automationTrigger.findMany({ where: { kind: "runLifecycle", deletedAt: null,
        enabled: true, sourceRunMachineId: null, remainingOccurrences: 1,
        automation: { accountId, enabled: true, deletedAt: null,
            assignments: { some: { machineId, enabled: true } } } },
        select: { automationId: true }, distinct: ["automationId"] });
    for (const row of rows) await catchUpAutomationRunLifecycleSourcesTx(tx, row.automationId);
}

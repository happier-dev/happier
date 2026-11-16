import {
    AutomationActionAdmitRequestV1Schema,
    type AutomationActionAdmitRequestV1,
    type AutomationActionAdmitResultV1,
} from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { automationSubjectKeyMatchesV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { inTx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { admitAutomationRunsTx, type AutomationRunAdmissionRequest } from './automationRunAdmissionService';
import { automationActionTriggerConfigurationSelect, decodeAutomationActionTriggerConfiguration } from './automationActionTriggerConfiguration';
import { readAutomationRunCauseChainTx } from './automationTriggerCauseChain';
import { findAutomationOccurrencesTx, rejoinAutomationOccurrenceInsertRace } from './automationOccurrencePersistence';

/** Selected occurrences enter ordinary actor-owned Run admission in one batch. */
export async function admitAutomationActionOccurrencesV1(params: Readonly<{
    accountId: string;
    input: AutomationActionAdmitRequestV1;
}>): Promise<AutomationActionAdmitResultV1> {
    const input = AutomationActionAdmitRequestV1Schema.parse(params.input);
    if (input.triggers.length === 0) return { results: [] };
    return rejoinAutomationOccurrenceInsertRace(() => inTx(async tx => {
        const occurrences = input.triggers.map(ref => ({ automationId: ref.automationId,
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: ref.triggerId, evidence: input.evidence }) }));
        // Current configuration is irrelevant to an immutable occurrence already admitted.
        // Ordinary admission remains the sole evidence-correspondence/rejoin decision.
        const existing = (await Promise.all(portableQueryChunks({ values: occurrences, bindingsPerValue: 2,
            fixedBindings: 1 }).map(chunk => findAutomationOccurrencesTx({ tx, accountId: params.accountId,
            occurrences: chunk, select: { automationId: true, occurrenceKey: true } })))).flat();
        const existingKeys = new Set(existing.map(row => JSON.stringify([row.automationId, row.occurrenceKey])));
        const triggerIds = [...new Set(input.triggers.map(trigger => trigger.triggerId))];
        const rows = (await Promise.all(portableQueryChunks({ values: triggerIds, bindingsPerValue: 1,
            fixedBindings: 1 }).map(ids => tx.automationTrigger.findMany({
            where: { id: { in: [...ids] }, automation: { accountId: params.accountId }, deletedAt: null },
            select: { id: true, automationId: true, kind: true, revision: true, enabled: true,
                ...automationActionTriggerConfigurationSelect },
        })))).flat();
        const rowsById = new Map(rows.map(row => [row.id, row]));
        const origin = input.evidence.originRunId === undefined ? null
            : await tx.automationRun.findFirst({ where: { id: input.evidence.originRunId, accountId: params.accountId },
                select: { id: true } });
        const causeChain = await readAutomationRunCauseChainTx(tx, origin?.id ?? null);
        const admissions: AutomationRunAdmissionRequest[] = [];
        const admissionIndexes = new Map<string, number>();
        const results: AutomationActionAdmitResultV1['results'] = [];
        const pending: { position: number; index: number }[] = [];
        for (const [position, ref] of input.triggers.entries()) {
            const skip = (reason: string) => results.push({ automationId: ref.automationId,
                triggerId: ref.triggerId, kind: 'skipped', reason });
            const occurrenceKey = occurrences[position]!.occurrenceKey;
            const rejoining = existingKeys.has(JSON.stringify([ref.automationId, occurrenceKey]));
            const row = rowsById.get(ref.triggerId);
            let consentForInvocation = false;
            if (!rejoining) {
                if (input.evidence.originRunId !== undefined && !origin) { skip('originRunNotFound'); continue; }
                if (!row || row.automationId !== ref.automationId || row.kind !== 'action') { skip('triggerNotFound'); continue; }
                if (causeChain.triggerIds.has(row.id)) { skip('causeSuppressed'); continue; }
                const definition = decodeAutomationActionTriggerConfiguration(row);
                consentForInvocation = 'consentFor' in definition;
                if (!('consentFor' in definition)) {
                    if (definition.phase !== input.evidence.phase || !definition.actionIds.includes(input.evidence.actionId)) {
                        skip('triggerKindMismatch'); continue;
                    }
                    if (definition.subjectKey !== undefined && !automationSubjectKeyMatchesV1(
                        definition.subjectKey, input.evidence.subjects, undefined, definition.subjectKind)) {
                        skip('subjectMismatch'); continue;
                    }
                }
                if (input.evidence.machineId === undefined && 'consentFor' in definition) { skip('machineRequired'); continue; }
            }
            const key = JSON.stringify([ref.automationId, ref.triggerId]);
            let index = admissionIndexes.get(key);
            if (index === undefined) {
                index = admissions.length;
                admissionIndexes.set(key, index);
                const { v: _v, kind: _kind, subjects: _subjects, occurredAt, ...evidence } = input.evidence;
                admissions.push({ automationId: ref.automationId,
                    ...(consentForInvocation && input.evidence.machineId !== undefined
                        ? { runTargetMachineId: input.evidence.machineId } : {}),
                    now: new Date(occurredAt), cause: AutomationRunCauseSchema.parse({
                        kind: 'trigger', triggerKind: 'action', triggerId: ref.triggerId,
                        triggerRevision: ref.triggerRevision, occurredAt,
                        occurrenceKey,
                        evidence,
                    }) });
            }
            pending.push({ position: results.length, index });
            // Replaced with the ordinary admission result below, preserving supplied order.
            skip('admissionPending');
        }
        const admitted = await admitAutomationRunsTx({ tx, accountId: params.accountId, admissions });
        for (const { position, index } of pending) {
            const result = admitted[index]!;
            const ref = results[position]!;
            results[position] = result.kind === 'ineligible'
                ? { automationId: ref.automationId, triggerId: ref.triggerId, kind: 'skipped', reason: result.reason }
                : { automationId: ref.automationId, triggerId: ref.triggerId, kind: result.kind, runId: result.run.id };
        }
        return { results };
    }));
}

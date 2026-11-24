import {
    AutomationActionAdmitRequestV1Schema,
    type AutomationActionAdmitRequestV1,
    type AutomationActionAdmitResultV1,
} from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { automationSubjectKeyMatchesV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { inTx } from '@/storage/inTx';
import { admitAutomationRunsTx, type AutomationRunAdmissionRequest, type AutomationRunAdmissionIneligibleReason } from './automationRunAdmissionService';
import { decodeAutomationActionTriggerConfiguration } from './automationActionTriggerConfiguration';
import { readAutomationRunCauseChainTx } from './automationTriggerCauseChain';
import { rejoinAutomationOccurrenceInsertRace } from './automationOccurrencePersistence';

/** Selected occurrences enter ordinary actor-owned Run admission in one batch. */
export async function admitAutomationActionOccurrencesV1(params: Readonly<{
    accountId: string;
    input: AutomationActionAdmitRequestV1;
}>): Promise<AutomationActionAdmitResultV1> {
    const input = AutomationActionAdmitRequestV1Schema.parse(params.input);
    if (input.triggers.length === 0) return { results: [] };
    return rejoinAutomationOccurrenceInsertRace(() => inTx(async tx => {
        const admissions: AutomationRunAdmissionRequest[] = [];
        const indexesByOccurrence = new Map<string, number>();
        const occurrenceIndexes = input.triggers.map(ref => {
            const evidence = ref.actionId === undefined ? input.evidence : { ...input.evidence, actionId: ref.actionId };
            const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId: ref.triggerId, evidence });
            const key = JSON.stringify([ref.automationId, occurrenceKey]);
            const existingIndex = indexesByOccurrence.get(key);
            if (existingIndex !== undefined) return existingIndex;
            const index = admissions.length;
            indexesByOccurrence.set(key, index);
            const { v: _v, kind: _kind, subjects: _subjects, occurredAt, ...runEvidence } = evidence;
            admissions.push({
                automationId: ref.automationId,
                now: new Date(occurredAt),
                cause: { kind: 'trigger', triggerKind: 'action', triggerId: ref.triggerId,
                    triggerRevision: ref.triggerRevision, occurredAt, occurrenceKey, evidence: runEvidence },
            });
            return index;
        });
        const admitted = await admitAutomationRunsTx({
            tx, accountId: params.accountId, admissions,
            qualifyNew: async (requests, triggers) => {
                const originId = input.evidence.originRunId;
                const origin = originId === undefined ? null
                    : await tx.automationRun.findFirst({ where: { id: originId, accountId: params.accountId },
                        select: { id: true } });
                const causeChain = await readAutomationRunCauseChainTx(tx, origin?.id ?? null);
                const qualified = new Map<AutomationRunAdmissionRequest, { kind: 'ineligible'; reason: AutomationRunAdmissionIneligibleReason }
                    | { runTargetMachineId: string }>();
                for (const request of requests) {
                    const cause = request.cause;
                    if (cause.kind !== 'trigger' || cause.triggerKind !== 'action') throw new Error('Expected Action occurrence');
                    const skip = (reason: AutomationRunAdmissionIneligibleReason) => qualified.set(request, { kind: 'ineligible', reason });
                    if (originId !== undefined && !origin) { skip('originRunNotFound'); continue; }
                    const trigger = triggers.get(cause.triggerId);
                    if (!trigger || trigger.automationId !== request.automationId || trigger.kind !== 'action') {
                        skip('triggerNotFound'); continue;
                    }
                    if (causeChain.triggerIds.has(trigger.id)) { skip('causeSuppressed'); continue; }
                    const definition = decodeAutomationActionTriggerConfiguration(trigger);
                    const evidence = cause.evidence;
                    if ('consentFor' in definition) {
                        if (evidence.machineId === undefined) skip('machineRequired');
                        else qualified.set(request, { runTargetMachineId: evidence.machineId });
                    } else if (definition.phase !== evidence.phase || !definition.actionIds.includes(evidence.actionId)) {
                        skip('triggerKindMismatch');
                    } else if (definition.subjectKey !== undefined && !automationSubjectKeyMatchesV1(
                        definition.subjectKey, input.evidence.subjects, undefined, definition.subjectKind)) {
                        skip('subjectMismatch');
                    }
                }
                return qualified;
            },
        });
        return { results: input.triggers.map(({ automationId, triggerId }, position) => {
            const result = admitted[occurrenceIndexes[position]!]!;
            return result.kind === 'ineligible'
                ? { automationId, triggerId, kind: 'skipped', reason: result.reason }
                : { automationId, triggerId, kind: result.kind, runId: result.run.id };
        }) };
    }));
}

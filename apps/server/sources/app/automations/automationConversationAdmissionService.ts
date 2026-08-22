import {
    AutomationConversationAdmitInputV1Schema,
    AutomationConversationAdmitResultV1Schema,
    AutomationConversationOccurrenceEvidenceV1Schema,
    AutomationReplyHandoffTargetV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT,
    computeCanonicalDomainSeparatedDigest,
    createCanonicalJsonSigningInput,
    deriveAutomationOccurrenceKeyV1,
    isAutomationConversationResultDeliveryOwnedByCallerV1,
    openAutomationConversationReplyContextStoredEnvelopeV1,
    sealAutomationConversationReplyContextStoredEnvelopeV1,
    type AutomationConversationAdmitInputV1,
    type AutomationConversationAdmitResultV1,
    type AutomationConversationOccurrenceEvidenceV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import {
    emitAutomationRunTransition,
    emitAutomationRunUpdatedToMachineOnly,
} from "@/app/automations/automationChangePublisher";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { afterTx, inTx } from "@/storage/inTx";

import { loadAutomationTx } from "./automationCrudService";
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    classifyPlainAutomationOccurrenceEvidence,
    encodePlainAutomationOccurrenceEvidence,
    findAutomationOccurrenceTx,
    rejoinAutomationOccurrenceInsertRace,
} from "./automationOccurrencePersistence";
import { freezeAutomationRunExecutionRecipe } from "./automationRunQueueService";
import { assertAutomationExecutionInputEnvelopeOuterForMode } from "./automationStoredContentRead";
import {
    AUTOMATION_RUN_TERMINAL_STATES,
    initialAutomationExecutionDispatchStateForRun,
    type AutomationRunItem,
} from "./automationTypes";

export type AutomationConversationAdmissionCallerV1 = AutomationEventCallerV1 & Readonly<{
    contributionLocalId: string;
}>;

/**
 * Any plugin may admit a Conversation for an Automation the Account owns. The
 * caller questions that remain are Account-scoped: is the host-stamped
 * materialization still current, and does the frozen reply target stay inside
 * the admitting plugin. Which plugin is asking is not itself an authority input.
 */
export class AutomationConversationAdmissionCallerError extends Error {
    constructor() {
        super("automation_conversation_admission_caller_not_current");
        this.name = "AutomationConversationAdmissionCallerError";
    }
}

type ExistingConversationOccurrenceRow = Readonly<{
    id: string;
    accountId: string;
    originKind: string;
    originOccurredAt: Date | null;
    occurrenceKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    originSourceSelectorId: string | null;
    triggerEvidenceEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffActionPluginId: string | null;
    replyHandoffActionLocalId: string | null;
    replyHandoffTargetMachineId: string | null;
    replyHandoffTargetMachineInstallationId: string | null;
    replyHandoffTargetMaterializationId: string | null;
    replyHandoffId: string | null;
    replyHandoffState: string;
    replyHandoffAttempt: number;
    replyHandoffDueAt: Date | null;
    replyHandoffReceiptEnvelope: string | null;
}>;

const existingConversationOccurrenceSelect = {
    id: true,
    accountId: true,
    originKind: true,
    originOccurredAt: true,
    occurrenceKey: true,
    occurrenceEvidenceEqualityTag: true,
    originSourceSelectorId: true,
    triggerEvidenceEnvelope: true,
    replyContextEnvelope: true,
    replyHandoffActionPluginId: true,
    replyHandoffActionLocalId: true,
    replyHandoffTargetMachineId: true,
    replyHandoffTargetMachineInstallationId: true,
    replyHandoffTargetMaterializationId: true,
    replyHandoffId: true,
    replyHandoffState: true,
    replyHandoffAttempt: true,
    replyHandoffDueAt: true,
    replyHandoffReceiptEnvelope: true,
} satisfies Prisma.AutomationRunSelect;

type FinalResultDeliveryV1 = Extract<
    AutomationConversationAdmitInputV1["resultDelivery"],
    Readonly<{ kind: "finalResult" }>
>;

const CONVERSATION_REPLY_CONTEXT_IDENTITY_DOMAIN_V1 =
    "happier.automation-conversation-reply-context.v1";

function blocked(reason: "capacity" | "temporarilyUnavailable" | "occurrenceConflict"):
    AutomationConversationAdmitResultV1 {
    return AutomationConversationAdmitResultV1Schema.parse({
        kind: "blocked",
        reason,
        checkpointSafe: false,
    });
}

function admitted(runId: string): AutomationConversationAdmitResultV1 {
    return AutomationConversationAdmitResultV1Schema.parse({
        kind: "admitted",
        runId,
        checkpointSafe: true,
    });
}

function rejoined(runId: string): AutomationConversationAdmitResultV1 {
    return AutomationConversationAdmitResultV1Schema.parse({
        kind: "rejoined",
        runId,
        checkpointSafe: true,
    });
}

function parseJson(raw: string | null): unknown {
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function deriveReplyContextIdentity(params: Readonly<{
    accountMode: "plain" | "e2ee";
    resultDelivery: AutomationConversationAdmitInputV1["resultDelivery"];
}>): string {
    return computeCanonicalDomainSeparatedDigest(
        CONVERSATION_REPLY_CONTEXT_IDENTITY_DOMAIN_V1,
        [
            "1",
            params.accountMode,
            createCanonicalJsonSigningInput(params.resultDelivery),
        ],
    );
}

function buildConversationEvidence(params: Readonly<{
    input: AutomationConversationAdmitInputV1;
    accountMode: "plain" | "e2ee";
    caller: AutomationConversationAdmissionCallerV1;
}>): AutomationConversationOccurrenceEvidenceV1 {
    return AutomationConversationOccurrenceEvidenceV1Schema.parse({
        v: 1,
        kind: "conversation",
        bindingId: params.input.bindingId,
        occurrenceId: params.input.occurrenceId,
        occurredAt: params.input.occurredAt,
        caller: {
            pluginId: params.caller.pluginId,
            contributionLocalId: params.caller.contributionLocalId,
            machineId: params.caller.machineId,
        },
        input: {
            sender: params.input.sender,
            text: params.input.text,
        },
        replyContextIdentity: deriveReplyContextIdentity({
            accountMode: params.accountMode,
            resultDelivery: params.input.resultDelivery,
        }),
    });
}

function deriveHandoffId(runId: string): string {
    return `automation-reply-handoff:${runId}`;
}

function hasMatchingConversationEvidence(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    occurrenceKey: string;
    evidence: AutomationConversationOccurrenceEvidenceV1;
}>): boolean {
    if (
        params.row.originKind !== "conversation"
        || params.row.originOccurredAt?.getTime() !== params.evidence.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.occurrenceEvidenceEqualityTag !== null
        || params.row.originSourceSelectorId !== null
        || params.row.triggerEvidenceEnvelope === null
    ) return false;

    return classifyPlainAutomationOccurrenceEvidence({
        triggerEvidenceEnvelope: params.row.triggerEvidenceEnvelope,
        expectedEvidence: params.evidence,
    }) === "match";
}

function hasNoReplyHandoff(row: ExistingConversationOccurrenceRow): boolean {
    return row.replyContextEnvelope === null
        && row.replyHandoffActionPluginId === null
        && row.replyHandoffActionLocalId === null
        && row.replyHandoffTargetMachineId === null
        && row.replyHandoffTargetMachineInstallationId === null
        && row.replyHandoffTargetMaterializationId === null
        && row.replyHandoffId === null
        && row.replyHandoffState === "none"
        && row.replyHandoffAttempt === 0
        && row.replyHandoffDueAt === null
        && row.replyHandoffReceiptEnvelope === null;
}

function hasMatchingFinalResultHandoff(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    accountId: string;
    automationId: string;
    templateVersion: number;
    actionRef: FinalResultDeliveryV1["actionRef"];
    opaqueContext: FinalResultDeliveryV1["opaqueContext"];
}>): boolean {
    const expectedHandoffId = deriveHandoffId(params.row.id);
    const target = AutomationReplyHandoffTargetV1Schema.safeParse({
        accountId: params.accountId,
        machineId: params.row.replyHandoffTargetMachineId,
        machineInstallationId: params.row.replyHandoffTargetMachineInstallationId,
        materializationId: params.row.replyHandoffTargetMaterializationId,
        actionRef: {
            pluginId: params.row.replyHandoffActionPluginId,
            localId: params.row.replyHandoffActionLocalId,
        },
    });
    if (
        params.row.replyHandoffState === "none"
        || !target.success
        || target.data.actionRef.pluginId !== params.actionRef.pluginId
        || target.data.actionRef.localId !== params.actionRef.localId
        || params.row.replyHandoffId !== expectedHandoffId
        || params.row.replyContextEnvelope === null
    ) return false;

    const opened = openAutomationConversationReplyContextStoredEnvelopeV1({
        mode: "plain",
        envelope: parseJson(params.row.replyContextEnvelope),
    });
    return opened.kind === "available"
        && opened.correspondence.accountId === params.accountId
        && opened.correspondence.automationId === params.automationId
        && opened.correspondence.runId === params.row.id
        && opened.correspondence.handoffId === expectedHandoffId
        && opened.source.kind === "automationResult"
        && opened.source.automationRunId === params.row.id
        && opened.source.resultId === expectedHandoffId
        && opened.source.automationId === params.automationId
        && opened.source.templateVersion === params.templateVersion
        && opened.source.resultDelivery === "finalResult"
        && createCanonicalJsonSigningInput(opened.opaqueContext)
            === createCanonicalJsonSigningInput(params.opaqueContext);
}

function existingOccurrenceMatchesAdmission(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    accountId: string;
    input: AutomationConversationAdmitInputV1;
    occurrenceKey: string;
    evidence: AutomationConversationOccurrenceEvidenceV1;
}>): boolean {
    if (!hasMatchingConversationEvidence(params)) return false;
    if (params.input.resultDelivery.kind === "none") {
        return hasNoReplyHandoff(params.row);
    }
    return hasMatchingFinalResultHandoff({
        row: params.row,
        accountId: params.accountId,
        automationId: params.input.automationId,
        templateVersion: params.input.templateVersion,
        actionRef: params.input.resultDelivery.actionRef,
        opaqueContext: params.input.resultDelivery.opaqueContext,
    });
}

/**
 * Sole server writer for a plugin-admitted Conversation occurrence. It retains only
 * the immutable Conversation evidence and the optional incumbent handoff
 * custody; target execution and result settlement remain with their existing
 * Run owners.
 */
export async function admitAutomationConversationV1(params: Readonly<{
    accountId: string;
    caller: AutomationConversationAdmissionCallerV1;
    input: unknown;
}>): Promise<AutomationConversationAdmitResultV1> {
    const input = AutomationConversationAdmitInputV1Schema.parse(params.input);
    // This writer is the one place the caller-stamped machine/installation/
    // materialization is frozen next to the payload-named delivery Action. Any
    // plugin may be that target; it must be the admitting plugin's own
    // contribution so a reply cannot be misrouted into another plugin.
    if (!isAutomationConversationResultDeliveryOwnedByCallerV1({
        callerPluginId: params.caller.pluginId,
        resultDelivery: input.resultDelivery,
    })) {
        throw new AutomationConversationAdmissionCallerError();
    }
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await rejoinAutomationOccurrenceInsertRace(() => inTx(async (tx) => {
        try {
            await assertCurrentAutomationEventCallerMaterializationTx({
                tx,
                accountId: params.accountId,
                serverIdentityId,
                caller: params.caller,
            });
        } catch (error) {
            if (error instanceof AutomationEventCurrentnessError) {
                throw new AutomationConversationAdmissionCallerError();
            }
            throw error;
        }

        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return blocked("temporarilyUnavailable");
        // The present Action transports plaintext sender/text/context. An
        // encrypted Account needs the Account-owned opaque input carrier, not
        // a server-created alternate envelope.
        if (accountFence.account.currentness.encryptionMode !== "plain") {
            return blocked("temporarilyUnavailable");
        }

        const evidence = buildConversationEvidence({
            input,
            accountMode: "plain",
            caller: params.caller,
        });
        const occurrenceKey = deriveAutomationOccurrenceKeyV1(evidence);
        const existing = await findAutomationOccurrenceTx({
            tx,
            automationId: input.automationId,
            occurrenceKey,
            select: existingConversationOccurrenceSelect,
        });
        if (existing && existing.accountId === params.accountId) {
            return existingOccurrenceMatchesAdmission({
                row: existing,
                accountId: params.accountId,
                input,
                occurrenceKey,
                evidence,
            })
                ? rejoined(existing.id)
                : blocked("occurrenceConflict");
        }

        // A conversation is an additional invocation source for an Automation
        // the Account already owns, so any current Automation admits whatever
        // its primary trigger is, and several bindings may feed one Automation.
        // The binding stays in the occurrence identity above, which is already
        // namespaced by the host-stamped caller plugin.
        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: input.automationId,
        });
        if (
            !automation
            || !automation.enabled
            || automation.templateVersion !== input.templateVersion
        ) {
            return blocked("temporarilyUnavailable");
        }

        const occupied = await tx.automationRun.count({
            where: {
                accountId: params.accountId,
                originKind: { in: ["pluginEvent", "conversation"] },
                state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            },
        });
        if (occupied >= MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT) {
            return blocked("capacity");
        }

        const now = new Date();
        let executionInputEnvelope: string;
        try {
            executionInputEnvelope = freezeAutomationRunExecutionRecipe({
                targetType: automation.targetType,
                templateVersion: automation.templateVersion,
                templateCiphertext: automation.templateCiphertext,
                origin: {
                    kind: "conversation",
                    occurrenceKey,
                    occurredAt: input.occurredAt,
                },
                triggerEvidence: AutomationStoredContentEnvelopeV1Schema.parse({
                    t: "plain",
                    v: {
                        ...evidence,
                        observationReceivedAt: now.getTime(),
                    },
                }),
            });
            assertAutomationExecutionInputEnvelopeOuterForMode({
                raw: executionInputEnvelope,
                mode: "plain",
                originKind: "conversation",
            });
        } catch {
            return blocked("temporarilyUnavailable");
        }

        let run = await tx.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: params.accountId,
                state: "queued",
                originKind: "conversation",
                originOccurredAt: new Date(input.occurredAt),
                occurrenceKey,
                occurrenceEvidenceEqualityTag: null,
                originSourceSelectorId: null,
                triggerEvidenceEnvelope: encodePlainAutomationOccurrenceEvidence(evidence),
                executionInputEnvelope,
                executionDispatchState: initialAutomationExecutionDispatchStateForRun(
                    executionInputEnvelope,
                ),
                scheduledAt: now,
                dueAt: now,
            },
            select: automationRunItemSelect,
        }) as AutomationRunItem;

        if (input.resultDelivery.kind === "finalResult") {
            const handoffId = deriveHandoffId(run.id);
            const replyContextEnvelope = JSON.stringify(
                sealAutomationConversationReplyContextStoredEnvelopeV1({
                    mode: "plain",
                    correspondence: {
                        accountId: params.accountId,
                        automationId: automation.id,
                        runId: run.id,
                        handoffId,
                    },
                    source: {
                        kind: "automationResult",
                        automationRunId: run.id,
                        resultId: handoffId,
                        automationId: automation.id,
                        templateVersion: automation.templateVersion,
                        resultDelivery: "finalResult",
                    },
                    opaqueContext: input.resultDelivery.opaqueContext,
                }),
            );
            run = await tx.automationRun.update({
                where: { id: run.id },
                data: {
                    replyContextEnvelope,
                    replyHandoffActionPluginId: input.resultDelivery.actionRef.pluginId,
                    replyHandoffActionLocalId: input.resultDelivery.actionRef.localId,
                    replyHandoffTargetMachineId: params.caller.machineId,
                    replyHandoffTargetMachineInstallationId: params.caller.machineInstallationId,
                    replyHandoffTargetMaterializationId: params.caller.materializationId,
                    replyHandoffId: handoffId,
                    replyHandoffState: "awaitingResult",
                    revision: { increment: 1 },
                },
                select: automationRunItemSelect,
            }) as AutomationRunItem;
        }

        const assignmentRows = await tx.automationAssignment.findMany({
            where: { automationId: automation.id, enabled: true },
            select: { machineId: true },
        });
        const cursor = await markAccountChanged(tx, {
            accountId: params.accountId,
            kind: "automation",
            entityId: automation.id,
        });
        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run,
                previousState: null,
                cursor,
            });
            for (const assignment of assignmentRows) {
                emitAutomationRunUpdatedToMachineOnly({
                    accountId: params.accountId,
                    machineId: assignment.machineId,
                    run,
                    cursor,
                });
            }
        });
        return admitted(run.id);
    }));
}

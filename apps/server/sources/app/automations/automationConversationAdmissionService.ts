import { AutomationConversationAdmitEncryptedHostEvidenceV1Schema, AutomationConversationAdmitReplyHandoffV1Schema, AutomationReplyHandoffTargetV1Schema, type AutomationConversationAdmitEncryptedHostEvidenceV1, type AutomationConversationAdmitReplyHandoffV1 } from '@happier-dev/protocol/automations/event';
import { AutomationConversationAdmitInputV1Schema, AutomationConversationAdmitResultV1Schema, isAutomationConversationResultDeliveryOwnedByCallerV1, isAutomationConversationAdmitScopedCorrespondenceV1, isAutomationConversationScopedActorCorrespondenceV1, type AutomationConversationAdmitInputV1, type AutomationConversationAdmitResultV1, type AutomationConversationScopedTriggerEvidenceV1 } from '@happier-dev/protocol/automations/result-delivery';
import { buildAutomationConversationOccurrenceEvidenceV1, deriveAutomationOccurrenceKeyV1, type AutomationConversationOccurrenceEvidenceV1, type AutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { isAutomationReplyHandoffIdForRunV1 } from '@happier-dev/protocol/automations/automationReplyHandoffIdentityV1';
import { isAutomationTriggerEvidenceCiphertextV1 } from '@happier-dev/protocol/automations/automationEventTriggerEvidence';
import { openAutomationConversationReplyContextStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationReplyHandoffStoredContent';
import type { Prisma } from "@prisma/client";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { acquireWorkflowPublicationLocksInTx } from "@/app/workflows/acquireWorkflowPublicationLocksInTx";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";

import { classifyAutomationConversationTargetEligibilityV1, matchesScopedAutomationConversationTriggerTx } from "./automationConversationTargetVerificationService";
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";
import {
    classifyPlainAutomationOccurrenceEvidence,
    encodePlainAutomationOccurrenceEvidence,
    rejoinAutomationOccurrenceInsertRace,
} from "./automationOccurrencePersistence";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import {
    validateAutomationStoredContentEnvelopeOuterForMode,
} from "./automationStoredContentRead";

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
    triggerId: string | null;
    causeKind: string;
    causeOccurredAt: Date | null;
    occurrenceKey: string | null;
    occurrenceEvidenceEqualityTag: string | null;
    causeSourceSelectorId: string | null;
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
}>;

const existingConversationOccurrenceSelect = {
    id: true,
    accountId: true,
    triggerId: true,
    causeKind: true,
    causeOccurredAt: true,
    occurrenceKey: true,
    occurrenceEvidenceEqualityTag: true,
    causeSourceSelectorId: true,
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
} satisfies Prisma.AutomationRunSelect;

async function findConversationOccurrenceTx(params: Readonly<{
    tx: Tx;
    automationId: string;
    occurrenceKey: string;
}>): Promise<ExistingConversationOccurrenceRow | null> {
    const row = await params.tx.automationRun.findFirst({
        where: {
            automationId: params.automationId,
            originKind: "automation",
            causeKind: "conversation",
            occurrenceKey: params.occurrenceKey,
        },
        select: existingConversationOccurrenceSelect,
    });
    if (row === null) return null;
    if (row.causeKind === null) {
        throw new Error("Stored Automation occurrence has invalid origin correspondence");
    }
    return { ...row, causeKind: row.causeKind };
}

type FinalResultDeliveryV1 = Extract<
    AutomationConversationAdmitInputV1["resultDelivery"],
    Readonly<{ kind: "finalResult" }>
>;

function blocked(
    reason:
        | "temporarilyUnavailable"
        | "occurrenceConflict"
        | "noEnabledAssignment"
        | "resultDeliveryUnsupported",
):
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

function refused(reason: Extract<AutomationConversationAdmitResultV1, { kind: 'refused' }>['reason']): AutomationConversationAdmitResultV1 {
    return { kind: 'refused', reason, checkpointSafe: true };
}

type ScopedConversationEvidenceV1 = AutomationConversationScopedTriggerEvidenceV1
    | NonNullable<AutomationConversationAdmitEncryptedHostEvidenceV1['scopedTrigger']>;

async function scopedAdmissionRefusalTx(params: Readonly<{
    tx: Tx; accountId: string; automationId: string;
    evidence: ScopedConversationEvidenceV1 | undefined;
    hasReplyHandoff: boolean;
    plainInput?: AutomationConversationAdmitInputV1;
}>): Promise<AutomationConversationAdmitResultV1 | null> {
    const automation = await params.tx.automation.findFirst({ where: { id: params.automationId,
        accountId: params.accountId, deletedAt: null }, select: { scopeSessionId: true } });
    if (!automation) return blocked('temporarilyUnavailable');
    const evidence = params.evidence;
    if (!evidence) return automation.scopeSessionId === null ? null : refused('repositoryWriteAccessUnknown');
    const corresponding = params.plainInput === undefined
        ? isAutomationConversationScopedActorCorrespondenceV1(evidence)
        : isAutomationConversationAdmitScopedCorrespondenceV1(params.plainInput);
    if (!corresponding
        || params.hasReplyHandoff) return refused('scopedTriggerIdentityMismatch');
    // The composite is one admission, but every original sender must satisfy
    // the existing trigger permission policy. Do not re-check the leader tuple.
    for (const { actor } of evidence.eventActors ?? [evidence]) {
        if (actor.repositoryWriteAccess === null) return refused('repositoryWriteAccessUnknown');
        if (actor.repositoryWriteAccess !== true) return refused('repositoryWriteAccessDenied');
    }
    return await matchesScopedAutomationConversationTriggerTx({ tx: params.tx, accountId: params.accountId,
        automationId: params.automationId, scopeSessionId: automation.scopeSessionId, scopedTrigger: evidence })
        ? null : refused('scopedTriggerIdentityMismatch');
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

function buildConversationEvidence(params: Readonly<{
    input: AutomationConversationAdmitInputV1;
    caller: AutomationConversationAdmissionCallerV1;
}>): AutomationConversationOccurrenceEvidenceV1 {
    // One Protocol owner builds Conversation evidence for both Account modes:
    // the plain writer here and the E2EE admission host that seals it.
    return buildAutomationConversationOccurrenceEvidenceV1({
        accountMode: "plain",
        bindingId: params.input.bindingId,
        occurrenceId: params.input.occurrenceId,
        occurredAt: params.input.occurredAt,
        caller: {
            pluginId: params.caller.pluginId,
            contributionLocalId: params.caller.contributionLocalId,
            machineId: params.caller.machineId,
        },
        sender: params.input.sender,
        text: params.input.text,
        ...(params.input.prUpdate === undefined ? {} : { prUpdate: params.input.prUpdate }),
        resultDelivery: params.input.resultDelivery,
        hostEvidence: params.input.hostEvidence,
    });
}

function hasMatchingConversationEvidence(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    occurrenceKey: string;
    evidence: AutomationConversationOccurrenceEvidenceV1;
}>): boolean {
    if (
        params.row.triggerId !== (params.evidence.hostEvidence?.triggerId ?? null)
        || params.row.causeKind !== "conversation"
        || params.row.causeOccurredAt?.getTime() !== params.evidence.occurredAt
        || params.row.occurrenceKey !== params.occurrenceKey
        || params.row.occurrenceEvidenceEqualityTag !== null
        || params.row.causeSourceSelectorId !== null
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
        && row.replyHandoffDueAt === null;
}

type ReplyHandoffAdmissionPlanV1 = Readonly<{
    actionRef: FinalResultDeliveryV1["actionRef"];
    /** Canonical serialized host-sealed reply context; the server never reseals it. */
    replyContextEnvelope: string;
}>;

function serializeReplyContextEnvelopeForMode(params: Readonly<{
    handoff: AutomationConversationAdmitReplyHandoffV1;
    mode: "plain" | "e2ee";
}>): string | null {
    const serialized = createCanonicalJsonSigningInput(params.handoff.replyContextEnvelope);
    return validateAutomationStoredContentEnvelopeOuterForMode({
        raw: serialized,
        mode: params.mode,
    }).kind === "available"
        ? serialized
        : null;
}

function resolvePlainReplyHandoffAdmissionPlan(params: Readonly<{
    input: AutomationConversationAdmitInputV1;
    occurrenceKey: string;
    replyHandoff: unknown;
}>): ReplyHandoffAdmissionPlanV1 | null | "invalid" {
    if (params.input.resultDelivery.kind === "none") {
        return params.replyHandoff === undefined ? null : "invalid";
    }
    const parsed = AutomationConversationAdmitReplyHandoffV1Schema.safeParse(params.replyHandoff);
    if (
        !parsed.success
        || parsed.data.actionRef.pluginId !== params.input.resultDelivery.actionRef.pluginId
        || parsed.data.actionRef.localId !== params.input.resultDelivery.actionRef.localId
    ) return "invalid";
    const replyContextEnvelope = serializeReplyContextEnvelopeForMode({
        handoff: parsed.data,
        mode: "plain",
    });
    if (replyContextEnvelope === null) return "invalid";
    const opened = openAutomationConversationReplyContextStoredEnvelopeV1({
        mode: "plain",
        envelope: parsed.data.replyContextEnvelope,
    });
    if (
        opened.kind !== "available"
        || opened.correspondence.automationId !== params.input.automationId
        || opened.correspondence.occurrenceKey !== params.occurrenceKey
        || createCanonicalJsonSigningInput(opened.opaqueContext)
            !== createCanonicalJsonSigningInput(params.input.resultDelivery.opaqueContext)
    ) return "invalid";
    return {
        actionRef: parsed.data.actionRef,
        replyContextEnvelope,
    };
}

function resolveEncryptedReplyHandoffAdmissionPlan(
    handoff: AutomationConversationAdmitEncryptedHostEvidenceV1["replyHandoff"],
): ReplyHandoffAdmissionPlanV1 | null | "invalid" {
    if (handoff === undefined) return null;
    const replyContextEnvelope = serializeReplyContextEnvelopeForMode({ handoff, mode: "e2ee" });
    return replyContextEnvelope === null
        ? "invalid"
        : { actionRef: handoff.actionRef, replyContextEnvelope };
}

function hasMatchingFinalResultHandoff(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    accountId: string;
    automationId: string;
    occurrenceKey: string;
    actionRef: FinalResultDeliveryV1["actionRef"];
    opaqueContext: FinalResultDeliveryV1["opaqueContext"];
}>): boolean {
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
        // The handoff identity is Run-owned, not a single frozen string: a
        // present user may have consciously authorized a further delivery, and
        // that successor identity still belongs to this exact Run.
        || !isAutomationReplyHandoffIdForRunV1({
            runId: params.row.id,
            handoffId: params.row.replyHandoffId,
        })
        || params.row.replyContextEnvelope === null
    ) return false;

    const opened = openAutomationConversationReplyContextStoredEnvelopeV1({
        mode: "plain",
        envelope: parseJson(params.row.replyContextEnvelope),
    });
    return opened.kind === "available"
        && opened.correspondence.automationId === params.automationId
        && opened.correspondence.occurrenceKey === params.occurrenceKey
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
        occurrenceKey: params.occurrenceKey,
        actionRef: params.input.resultDelivery.actionRef,
        opaqueContext: params.input.resultDelivery.opaqueContext,
    });
}

function encryptedFinalResultHandoffMatchesAdmission(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    accountId: string;
    handoff: AutomationConversationAdmitReplyHandoffV1 | undefined;
}>): boolean | "unavailable" {
    if (params.handoff === undefined) return hasNoReplyHandoff(params.row);
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
        || target.data.actionRef.pluginId !== params.handoff.actionRef.pluginId
        || target.data.actionRef.localId !== params.handoff.actionRef.localId
        // The handoff identity is Run-owned, not a single frozen string: a
        // present user may have consciously authorized a further delivery, and
        // that successor identity still belongs to this exact Run.
        || !isAutomationReplyHandoffIdForRunV1({
            runId: params.row.id,
            handoffId: params.row.replyHandoffId,
        })
        || params.row.replyContextEnvelope === null
    ) return false;
    const outer = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.row.replyContextEnvelope,
        mode: "e2ee",
    });
    return outer.kind === "available" && outer.envelope.t === "encrypted"
        ? true
        : "unavailable";
}

/**
 * Compares one retained encrypted Conversation occurrence with a replayed
 * admission. The server holds no Account content key, so equality is the
 * host-derived opaque tag plus the row facts it can read; the ciphertext is
 * randomized and is only checked for its authenticated cipher domain.
 */
function encryptedOccurrenceMatchesAdmission(params: Readonly<{
    row: ExistingConversationOccurrenceRow;
    accountId: string;
    hostEvidence: AutomationConversationAdmitEncryptedHostEvidenceV1;
}>): "match" | "mismatch" | "unavailable" {
    if (
        params.row.triggerId !== (params.hostEvidence.scopedTrigger?.triggerId ?? null)
        || params.row.causeKind !== "conversation"
        || params.row.causeOccurredAt?.getTime() !== params.hostEvidence.occurredAt
        || params.row.occurrenceKey !== params.hostEvidence.occurrenceKey
        || params.row.causeSourceSelectorId !== null
        || params.row.triggerEvidenceEnvelope === null
        || params.row.occurrenceEvidenceEqualityTag
            !== params.hostEvidence.occurrenceEvidenceEqualityTag
    ) return "mismatch";
    const replyHandoff = encryptedFinalResultHandoffMatchesAdmission({
        row: params.row,
        accountId: params.accountId,
        handoff: params.hostEvidence.replyHandoff,
    });
    if (replyHandoff === "unavailable") return "unavailable";
    if (!replyHandoff) return "mismatch";
    const outer = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.row.triggerEvidenceEnvelope,
        mode: "e2ee",
    });
    if (outer.kind !== "available" || outer.envelope.t !== "encrypted") return "unavailable";
    return isAutomationTriggerEvidenceCiphertextV1(outer.envelope.c) ? "match" : "unavailable";
}

function hostEvidenceMatchesAccountModeAndKey(params: Readonly<{
    hostEvidence: AutomationConversationAdmitEncryptedHostEvidenceV1;
    account: Readonly<{
        contentKeyFingerprint: string | null;
        currentness: Readonly<{ encryptionMode: "plain" | "e2ee" }>;
    }>;
}>): boolean {
    return params.account.currentness.encryptionMode === "e2ee"
        && params.hostEvidence.accountCurrentness.mode === "e2ee"
        && params.hostEvidence.accountCurrentness.contentKeyFingerprint
            === params.account.contentKeyFingerprint;
}

/**
 * The mode-resolved facts one Conversation Run row is created from. Both
 * Account modes converge here so capacity, Automation currentness, recipe
 * freezing, publication, and reply custody stay with one writer.
 */
type ConversationRunAdmissionPlanV1 = Readonly<{
    automationId: string;
    occurrenceKey: AutomationOccurrenceKeyV1;
    occurredAt: number;
    /** Serialized mode-correct occurrence evidence retained on the Run. */
    triggerEvidenceEnvelope: string;
    /** Mode-correct trigger evidence frozen into the Run execution recipe. */
    executionTriggerEvidence: unknown;
    occurrenceEvidenceEqualityTag: string | null;
    replyHandoff: ReplyHandoffAdmissionPlanV1 | null;
    scopedTrigger?: ScopedConversationEvidenceV1;
}>;

async function createConversationRunTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationConversationAdmissionCallerV1;
    plan: ConversationRunAdmissionPlanV1;
}>): Promise<AutomationConversationAdmitResultV1> {
    const { tx, plan } = params;
    const automation = await tx.automation.findFirst({
        where: {
            id: plan.automationId,
            accountId: params.accountId,
            deletedAt: null,
        },
        select: { targetType: true },
    });
    if (!automation) {
        return blocked("temporarilyUnavailable");
    }
    const scopeRefusal = await scopedAdmissionRefusalTx({ tx, accountId: params.accountId, automationId: plan.automationId,
        evidence: plan.scopedTrigger, hasReplyHandoff: plan.replyHandoff !== null });
    if (scopeRefusal) return scopeRefusal;

    const eligibility = classifyAutomationConversationTargetEligibilityV1({
        targetType: automation.targetType,
        resultDelivery: plan.replyHandoff === null ? "none" : "finalResult",
    });
    if (eligibility !== "eligible") return blocked(eligibility);

    const now = new Date();
    const result = await admitAutomationRunTx({
        tx,
        accountId: params.accountId,
        automationId: plan.automationId,
        now,
        cause: {
            kind: "conversation",
            occurrenceKey: plan.occurrenceKey,
            occurredAt: plan.occurredAt,
            ...(plan.scopedTrigger ? { triggerId: plan.scopedTrigger.triggerId } : {}),
        },
        triggerEvidenceEnvelope: plan.triggerEvidenceEnvelope,
        executionTriggerEvidenceEnvelope: createCanonicalJsonSigningInput(
            plan.executionTriggerEvidence,
        ),
        occurrenceEvidenceEqualityTag: plan.occurrenceEvidenceEqualityTag,
        ...(plan.scopedTrigger ? { scopedConversationTrigger: plan.scopedTrigger } : {}),
        ...(plan.replyHandoff
            ? {
                replyHandoff: {
                    contextEnvelope: plan.replyHandoff.replyContextEnvelope,
                    actionPluginId: plan.replyHandoff.actionRef.pluginId,
                    actionLocalId: plan.replyHandoff.actionRef.localId,
                    targetMachineId: params.caller.machineId,
                    targetMachineInstallationId: params.caller.machineInstallationId,
                    targetMaterializationId: params.caller.materializationId,
                },
            }
            : {}),
    });
    if (result.kind === "ineligible") {
        if (result.reason === "noEnabledAssignment") return blocked("noEnabledAssignment");
        return blocked("temporarilyUnavailable");
    }
    if (result.kind === "rejoined") return rejoined(result.run.id);
    return admitted(result.run.id);
}

async function assertCurrentAdmissionCallerTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    caller: AutomationConversationAdmissionCallerV1;
}>): Promise<void> {
    try {
        await assertCurrentAutomationEventCallerMaterializationTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) {
            throw new AutomationConversationAdmissionCallerError();
        }
        throw error;
    }
}

/**
 * Admits one Conversation occurrence for an E2EE Account. The admitting host
 * has already sealed the occurrence evidence and derived the opaque rejoin tag
 * with the Account content key, so this reader never sees the sender, message
 * text, or reply context and compares replays through that tag alone. It shares
 * the single Run writer with the plain arm below.
 */
export async function admitEncryptedAutomationConversationV1(params: Readonly<{
    accountId: string;
    caller: AutomationConversationAdmissionCallerV1;
    hostEvidence: unknown;
}>): Promise<AutomationConversationAdmitResultV1> {
    const hostEvidence = AutomationConversationAdmitEncryptedHostEvidenceV1Schema.parse(
        params.hostEvidence,
    );
    if (
        hostEvidence.replyHandoff !== undefined
        && hostEvidence.replyHandoff.actionRef.pluginId !== params.caller.pluginId
    ) {
        throw new AutomationConversationAdmissionCallerError();
    }
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await rejoinAutomationOccurrenceInsertRace(() => inTx(async (tx) => {
        await assertCurrentAdmissionCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        await acquireWorkflowPublicationLocksInTx(tx, { accountId: params.accountId, automationIds: [hostEvidence.automationId] });
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
        // The sealed arm is only meaningful for an Account whose persisted mode
        // is E2EE under the exact content key the host sealed with.
        if (
            accountFence.status !== "ready"
            || !hostEvidenceMatchesAccountModeAndKey({
                hostEvidence,
                account: accountFence.account,
            })
        ) {
            return blocked("temporarilyUnavailable");
        }
        const replyHandoff = resolveEncryptedReplyHandoffAdmissionPlan(hostEvidence.replyHandoff);
        if (replyHandoff === "invalid") return blocked("temporarilyUnavailable");
        const scopeRefusal = await scopedAdmissionRefusalTx({ tx, accountId: params.accountId, automationId: hostEvidence.automationId,
            evidence: hostEvidence.scopedTrigger, hasReplyHandoff: replyHandoff !== null });
        if (scopeRefusal) return scopeRefusal;

        const existing = await findConversationOccurrenceTx({
            tx,
            automationId: hostEvidence.automationId,
            occurrenceKey: hostEvidence.occurrenceKey,
        });
        if (existing && existing.accountId === params.accountId) {
            const disposition = encryptedOccurrenceMatchesAdmission({
                row: existing,
                accountId: params.accountId,
                hostEvidence,
            });
            if (disposition === "match") return rejoined(existing.id);
            return blocked(
                disposition === "mismatch" ? "occurrenceConflict" : "temporarilyUnavailable",
            );
        }
        return await createConversationRunTx({
            tx,
            accountId: params.accountId,
            caller: params.caller,
            plan: {
                automationId: hostEvidence.automationId,
                occurrenceKey: hostEvidence.occurrenceKey,
                occurredAt: hostEvidence.occurredAt,
                triggerEvidenceEnvelope: createCanonicalJsonSigningInput(
                    hostEvidence.triggerEvidenceEnvelope,
                ),
                executionTriggerEvidence: hostEvidence.executionTriggerEvidenceEnvelope,
                occurrenceEvidenceEqualityTag: hostEvidence.occurrenceEvidenceEqualityTag,
                replyHandoff,
                scopedTrigger: hostEvidence.scopedTrigger,
            },
        });
    }, { transactionClass: "automation-conversation-admit-encrypted" }));
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
    replyHandoff?: unknown;
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
        await assertCurrentAdmissionCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        await acquireWorkflowPublicationLocksInTx(tx, { accountId: params.accountId, automationIds: [input.automationId] });
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
        if (accountFence.status !== "ready") return blocked("temporarilyUnavailable");
        // The plain Action transports plaintext sender/text/context. An
        // encrypted Account must use the sealed host-evidence arm instead; the
        // server never creates an alternate envelope for it.
        if (accountFence.account.currentness.encryptionMode !== "plain") {
            return blocked("temporarilyUnavailable");
        }
        const scopeRefusal = await scopedAdmissionRefusalTx({ tx, accountId: params.accountId, automationId: input.automationId,
            evidence: input.hostEvidence, hasReplyHandoff: input.resultDelivery.kind !== 'none', plainInput: input });
        if (scopeRefusal) return scopeRefusal;

        const evidence = buildConversationEvidence({
            input,
            caller: params.caller,
        });
        const occurrenceKey = deriveAutomationOccurrenceKeyV1(evidence);
        const replyHandoff = resolvePlainReplyHandoffAdmissionPlan({
            input,
            occurrenceKey,
            replyHandoff: params.replyHandoff,
        });
        if (replyHandoff === "invalid") return blocked("temporarilyUnavailable");
        const existing = await findConversationOccurrenceTx({
            tx,
            automationId: input.automationId,
            occurrenceKey,
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

        return await createConversationRunTx({
            tx,
            accountId: params.accountId,
            caller: params.caller,
            plan: {
                automationId: input.automationId,
                occurrenceKey,
                occurredAt: input.occurredAt,
                triggerEvidenceEnvelope: encodePlainAutomationOccurrenceEvidence(evidence),
                executionTriggerEvidence: {
                    t: "plain",
                    v: {
                        ...evidence,
                        observationReceivedAt: Date.now(),
                    },
                },
                occurrenceEvidenceEqualityTag: null,
                replyHandoff,
                scopedTrigger: input.hostEvidence,
            },
        });
    }, { transactionClass: "automation-conversation-admit" }));
}

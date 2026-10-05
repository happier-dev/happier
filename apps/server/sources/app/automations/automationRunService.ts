import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { invalidateSessionReviewProjectionsForAutomationInTx } from './sessionReviewProjectionInvalidation';
import {
    AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
    AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1,
    AutomationRunResultStoredV1Schema,
    deriveSessionCreationTagV1,
    parseAutomationRunExecutionRecipeV1,
    sameAutomationAccountContentIdentityV1,
    sameAutomationAccountCurrentnessWitnessV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    type AutomationAccountCurrentnessWitnessV1,
    type ExecutionRunWaitResult,
    type AutomationRunResultStoredV1,
    type SessionServerStartDispatchResultV1,
} from "@happier-dev/protocol";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { retireAutomationPendingInputInTx } from "@/app/session/pending/pendingMessageService";
import { cancelWorkflowRunTx, WorkflowRunServiceError } from "@/app/workflows/workflowRunService";

import { emitAutomationRunTransition } from "./automationChangePublisher";
import { fetchAutomationAccountCurrentnessWitnessTx } from "./automationAccountCurrentness";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    decodeAutomationRunCause,
    projectAutomationOriginRun,
    retainedV2OriginKindForRun,
} from "./automationRunCauseCodec";
import { advanceAutomationScheduleCursorAfterTerminalRunTx } from "./automationRunQueueService";
import { applyAutomationRunSucceededTx, applyAutomationRunTerminalEffectsTx } from "./automationRunSucceeded";
import {
    assertAutomationRunFailureDetailEnvelopeOuterForMode,
    readRetainedAutomationRunExecutionTargetV2,
} from "./automationStoredContentRead";
import {
    AUTOMATION_EXECUTION_DISPATCH_MAX_ATTEMPTS,
    type AutomationRunItem,
} from "./automationTypes";

function isConversationRun(run: AutomationRunItem): boolean {
    return decodeAutomationRunCause(run).kind === "conversation";
}

type AutomationRunStartResult = Readonly<{
    run: AutomationRunItem;
    /** S: Account currentness after the start mutation's Account marker. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}>;

export type AutomationExecutionDispatchOutcome =
    | Readonly<{ kind: "noRunCreated"; errorCode: string }>
    | Readonly<{ kind: "outcomeUnknown"; errorCode: string }>
    | Readonly<{
        kind: "started";
        runId: string;
        callId: string;
        sidechainId: string;
        wait?: ExecutionRunWaitResult;
    }>;

async function hasExpectedAutomationAccountCurrentnessTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    expected: AutomationAccountCurrentnessWitnessV1 | undefined;
}>): Promise<boolean> {
    if (!params.expected) return true;
    const observed = await fetchAutomationAccountCurrentnessWitnessTx(params.tx, params.accountId);
    return observed !== null && sameAutomationAccountCurrentnessWitnessV1(observed, params.expected);
}


/**
 * Content-identity currentness for a decision taken *after* an external effect
 * already happened. `Account.seq` advances for every Account-scoped write,
 * including the canonical Session creation a strict new-Session settlement
 * reports, the cancellation that produced the terminality being reported, and
 * any unrelated Account mutation, so a post-effect report's witness is
 * routinely behind. Those terminal settlements compare the Account's mode and
 * content-key identity instead — through the one Protocol comparison owner:
 * they open no content under a new mode, and their write is still gated by the
 * exact machine/attempt/revision/lease Run CAS that authorized the effect. An
 * encryption-mode or content-key transition still refuses them. Pre-effect and
 * redispatch-permission decisions keep the exact witness.
 */
async function hasCompatibleAutomationAccountEncryptionTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    expected: AutomationAccountCurrentnessWitnessV1 | undefined;
}>): Promise<boolean> {
    if (!params.expected) return true;
    const observed = await fetchAutomationAccountCurrentnessWitnessTx(params.tx, params.accountId);
    return observed !== null
        && sameAutomationAccountContentIdentityV1(observed, params.expected);
}

/**
 * The per-transition Run audit trail. `AutomationRun` keeps only the current
 * terminal fact — one state, one errorCode — so the ordered transition history
 * (which attempt started, which dispatch retry was scheduled, and why a Run
 * became uncertain rather than cancelled) exists only here.
 *
 * Its readers are the authenticated Run detail — `automationRunDetailSelect`
 * plus `toAutomationRunV3DetailApiDto`, which project a bounded newest-first
 * tail by named payload keys only — and the operator, through the published
 * `automationRunEvents` retention domain that decides how long this history is
 * kept. A new payload key is not user-facing until that projection names it.
 */
async function appendRunEventTx(params: {
    tx: any;
    runId: string;
    type: string;
    payload?: Record<string, unknown>;
    now: Date;
}): Promise<void> {
    await params.tx.automationRunEvent.create({
        data: {
            runId: params.runId,
            ts: params.now,
            type: params.type,
            payload: params.payload ?? null,
        },
    });
}

async function fetchRunForAccount(params: {
    tx: any;
    accountId: string;
    runId: string;
}) {
    const row = await params.tx.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            originKind: "automation",
            automationId: { not: null },
            causeKind: { not: null },
        },
        select: automationRunItemSelect,
    });
    return row ? projectAutomationOriginRun(row) : null;
}

async function markRunAutomationChanged(params: { tx: any; accountId: string; automationId: string }) {
    await invalidateSessionReviewProjectionsForAutomationInTx(params.tx, params.automationId);
    return await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: params.automationId,
    });
}

async function resolveProducedSessionIdTx(params: {
    tx: any;
    accountId: string;
    producedSessionId: string | null | undefined;
}): Promise<string | null> {
    const candidate = typeof params.producedSessionId === "string" ? params.producedSessionId.trim() : "";
    if (!candidate) return null;

    const session = await params.tx.session.findFirst({
        where: {
            id: candidate,
            accountId: params.accountId,
        },
        select: { id: true },
    });
    return session ? session.id : null;
}

/**
 * A strict new-Session Run may retain only the Session created/rejoined by its
 * own immutable Automation creation identity. Other Run arms retain their
 * incumbent same-Account validation, so this does not alter predecessor flows.
 */
function deriveStrictNewSessionCreationTag(params: {
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
}): string | null {
    if (params.originKind !== "automation" || params.automationId === null) return null;
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    if (recipe.kind !== "available" || recipe.recipe.target.kind !== "newSession") return null;
    return deriveSessionCreationTagV1({
        callerCreationNamespace: `automation:${params.automationId}`,
        creationKey: `automation-run:${params.runId}`,
    });
}

async function findStrictNewSessionByRunCreationTagTx(params: {
    tx: any;
    accountId: string;
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
}): Promise<{ id: string } | null> {
    const sessionCreationTag = deriveStrictNewSessionCreationTag(params);
    if (!sessionCreationTag) return null;
    return await params.tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: params.accountId,
                tag: sessionCreationTag,
            },
        },
        select: { id: true },
    });
}

async function findNewSessionByRunCreationTagTx(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
}): Promise<{ id: string } | null> {
    const sessionCreationTag = deriveSessionCreationTagV1({
        callerCreationNamespace: `automation:${params.automationId}`,
        creationKey: `automation-run:${params.runId}`,
    });
    return await params.tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: params.accountId,
                tag: sessionCreationTag,
            },
        },
        select: { id: true },
    });
}

async function resolveStrictNewSessionProducedSessionIdTx(params: {
    tx: any;
    accountId: string;
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
    producedSessionId: string | null | undefined;
}): Promise<string | null> {
    const candidate = typeof params.producedSessionId === "string" ? params.producedSessionId.trim() : "";
    if (!candidate) return null;
    const session = await findStrictNewSessionByRunCreationTagTx(params);
    return session?.id === candidate ? session.id : null;
}

async function resolveProducedSessionIdForRunTx(params: {
    tx: any;
    accountId: string;
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
    producedSessionId: string | null | undefined;
}): Promise<string | null> {
    if (params.originKind !== "automation" || params.automationId === null) return null;
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    return recipe.kind === "available" && recipe.recipe.target.kind === "newSession"
        ? await resolveStrictNewSessionProducedSessionIdTx(params)
        : await resolveProducedSessionIdTx(params);
}

async function resolveAutomationPendingInputSessionIdTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
    executionInputEnvelope: string | null;
    accountEncryptionMode: "plain" | "e2ee";
    retainedV2OriginKind: "scheduled" | "manual" | undefined;
}>): Promise<string | null> {
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    if (recipe.kind === "available" && recipe.recipe.target.kind === "existingSession") {
        const session = await params.tx.session.findFirst({
            where: {
                id: recipe.recipe.target.sessionId,
                accountId: params.accountId,
            },
            select: { id: true },
        });
        return session?.id ?? null;
    }
    if (recipe.kind === "available" && recipe.recipe.target.kind === "newSession") {
        const session = await findStrictNewSessionByRunCreationTagTx({
            ...params,
            originKind: "automation",
        });
        return session?.id ?? null;
    }
    if (recipe.kind === "available") return null;

    const retainedTarget = params.executionInputEnvelope === null
        || params.retainedV2OriginKind === undefined
        ? null
        : readRetainedAutomationRunExecutionTargetV2({
            raw: params.executionInputEnvelope,
            mode: params.accountEncryptionMode,
            retainedV2OriginKind: params.retainedV2OriginKind,
        });
    if (retainedTarget?.kind === "existingSession") {
        const session = await params.tx.session.findFirst({
            where: { id: retainedTarget.sessionId, accountId: params.accountId },
            select: { id: true },
        });
        return session?.id ?? null;
    }
    if (retainedTarget?.kind !== "newSession") return null;
    const session = await findNewSessionByRunCreationTagTx(params);
    return session?.id ?? null;
}

/**
 * Retains the exact Session produced by the Session-owned cross-machine start
 * before its source daemon receives the outer Socket acknowledgement. This
 * is intentionally nonterminal: the incumbent worker still owns success,
 * failure, cancellation, Account currentness, and all lifecycle events.
 */
export async function retainAutomationRunProducedSession(params: {
    accountId: string;
    machineId: string;
    runId: string;
    attempt: number;
    result: SessionServerStartDispatchResultV1;
}): Promise<AutomationRunItem | null> {
    const result = params.result;
    if (result.type !== "success") return null;

    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;

        const run = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                workflowCustodyState: null,
                // Cancellation of a running Run settles outcome-uncertain, so
                // a Session the target committed around that cancellation
                // retains its exact canonical identity in that terminal state
                // too.
                state: { in: ["running", "cancelled", "outcome_uncertain"] },
            },
            select: {
                originKind: true,
                automationId: true,
                state: true,
                executionInputEnvelope: true,
                producedSessionId: true,
                revision: true,
            },
        });
        if (!run) return null;

        const session = await findStrictNewSessionByRunCreationTagTx({
            tx,
            accountId: params.accountId,
            originKind: run.originKind,
            automationId: run.automationId,
            runId: params.runId,
            executionInputEnvelope: run.executionInputEnvelope,
        });
        if (!session) return null;
        if (result.sessionId !== session.id) {
            return null;
        }

        if (run.producedSessionId !== null) {
            return run.producedSessionId === session.id
                ? await fetchRunForAccount({
                    tx,
                    accountId: params.accountId,
                    runId: params.runId,
                })
                : null;
        }

        const now = new Date();
        const retained = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: run.state,
                revision: run.revision,
                executionInputEnvelope: run.executionInputEnvelope,
                workflowCustodyState: null,
                producedSessionId: null,
            },
            data: {
                producedSessionId: session.id,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (retained.count !== 1) return null;

        return await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
        });
    });
}

/**
 * The Run terminality owner also closes the one frozen Conversation handoff.
 * No result envelope or receipt is synthesized: a failed/cancelled run cannot
 * leave a worker-visible `awaitingResult` custody obligation behind.
 */
async function blockAwaitingReplyHandoffForTerminalRunTx(params: {
    tx: Tx;
    accountId: string;
    runId: string;
    state: "failed" | "cancelled" | "outcome_uncertain";
    now: Date;
}): Promise<void> {
    await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            state: params.state,
            replyHandoffState: "awaitingResult",
        },
        data: {
            replyHandoffState: "blocked",
            replyHandoffDueAt: null,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
}

async function publishFailedAutomationRunTx(params: {
    tx: Tx;
    accountId: string;
    runId: string;
    previousState: AutomationRunItem["state"];
    now: Date;
    machineId?: string;
}): Promise<AutomationRunItem | null> {
    const run = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
    });
    if (!run) return null;
    await blockAwaitingReplyHandoffForTerminalRunTx({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
        state: "failed",
        now: params.now,
    });
    const terminalRun = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
    });
    if (!terminalRun) return null;
    await appendRunEventTx({
        tx: params.tx,
        runId: terminalRun.id,
        type: "run_failed",
        now: params.now,
        payload: {
            ...(params.machineId ? { machineId: params.machineId } : {}),
            errorCode: terminalRun.errorCode,
        },
    });
    await advanceAutomationScheduleCursorAfterTerminalRunTx({
        tx: params.tx,
        run: terminalRun as AutomationRunItem,
        now: params.now,
    });

    const cursor = await markRunAutomationChanged({
        tx: params.tx,
        accountId: params.accountId,
        automationId: terminalRun.automationId,
    });

    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run: terminalRun as AutomationRunItem,
            previousState: params.previousState,
            cursor,
        });
    });

    return terminalRun as AutomationRunItem;
}

type ParsedAutomationRunResultEnvelope = Readonly<{
    raw: string;
    envelope: AutomationRunResultStoredV1;
}>;

function parseAutomationRunResultEnvelope(
    raw: string | null | undefined,
): ParsedAutomationRunResultEnvelope | null {
    if (raw === null || raw === undefined) {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("Automation Run result envelope is invalid");
    }
    const parsed = AutomationRunResultStoredV1Schema.safeParse(value);
    if (
        !parsed.success
        || parsed.data.t === "legacySummaryCiphertext"
    ) {
        throw new Error("Automation Run result envelope is invalid");
    }
    return { raw, envelope: parsed.data };
}

function hasExactPlainRunResultCorrespondence(params: Readonly<{
    envelope: AutomationRunResultStoredV1;
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string | null;
}>): boolean {
    if (params.envelope.t !== "plain") return true;
    const correspondence = params.envelope.v.correspondence;
    return correspondence.accountId === params.accountId
        && correspondence.automationId === params.automationId
        && correspondence.runId === params.runId
        && (params.handoffId === null
            ? !("handoffId" in correspondence)
            : (
                "handoffId" in correspondence
                && correspondence.handoffId === params.handoffId
            ));
}

async function settleSucceededAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt?: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;

}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;

        const now = new Date();
        const parsedResultEnvelope = parseAutomationRunResultEnvelope(
            params.resultEnvelope,
        );
        const resultEnvelope = parsedResultEnvelope?.raw ?? null;
        const preflightRow = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                workflowCustodyState: null,
                claimedByMachineId: params.machineId,
                ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                // A current success reports an effect the server authorized at
                // the start CAS, so it can only settle a Run that is running.
                state: "running",
                // A permitted dispatch is settled only by the execution
                // dispatch owner; a generic success claim cannot know the
                // external outcome it would be asserting. Retained rows that
                // predate dispatch-state initialization hold NULL and are the
                // same "never dispatched" fact as `notStarted`, so they are
                // matched explicitly rather than left to provider NULL
                // comparison semantics.
                OR: [
                    { executionDispatchState: null },
                    { executionDispatchState: { not: "dispatchPermitted" } },
                ],
                leaseExpiresAt: { gt: now },
            },
            select: automationRunItemSelect,
        });
        const preflight = preflightRow ? projectAutomationOriginRun(preflightRow) : null;
        if (!preflight) return null;
        // The candidate is loaded under the exact Run authority first, then the
        // witness is judged by the Run's state. A `running` success reports an
        // external effect that already happened: for a strict new-Session
        // target the canonical Session creation it reports is itself an
        // Account write that advanced `Account.seq` past S, as does any
        // unrelated Account mutation, so that post-effect report compares
        // Account encryption identity instead of the stale sequence.
        if (!await hasCompatibleAutomationAccountEncryptionTx({
            tx, accountId: params.accountId, expected: params.accountCurrentness,
        })) return null;
        const strictNewSession = deriveStrictNewSessionCreationTag({
            originKind: preflight.originKind,
            automationId: preflight.automationId,
            runId: params.runId,
            executionInputEnvelope: preflight.executionInputEnvelope,
        }) !== null;
        const producedSessionId = await resolveProducedSessionIdForRunTx({
            tx,
            accountId: params.accountId,
            originKind: preflight.originKind,
            automationId: preflight.automationId,
            runId: params.runId,
            executionInputEnvelope: preflight.executionInputEnvelope,
            producedSessionId: strictNewSession
                ? preflight.producedSessionId ?? params.producedSessionId
                : params.producedSessionId,
        });
        // Strict new-Session success cannot discard an already retained
        // canonical Session or settle without one. A concurrent retention wins
        // the CAS below and the worker may retry settlement against that fact.
        if (strictNewSession && producedSessionId === null) return null;


        const isConversation = isConversationRun(preflight);
        const isConversationHandoff = isConversation
            && preflight.replyHandoffState === "awaitingResult";
        if (
            isConversation
            && (
                isConversationHandoff
                    ? (
                        resultEnvelope === null
                        || typeof preflight.replyContextEnvelope !== "string"
                        || typeof preflight.replyHandoffActionPluginId !== "string"
                        || typeof preflight.replyHandoffActionLocalId !== "string"
                        || typeof preflight.replyHandoffTargetMachineId !== "string"
                        || typeof preflight.replyHandoffTargetMachineInstallationId !== "string"
                        || typeof preflight.replyHandoffTargetMaterializationId !== "string"
                        || typeof preflight.replyHandoffId !== "string"
                    )
                    : (
                        preflight.replyHandoffState !== "none"
                        || preflight.replyContextEnvelope !== null
                        || preflight.replyHandoffActionPluginId !== null
                        || preflight.replyHandoffActionLocalId !== null
                        || preflight.replyHandoffTargetMachineId !== null
                        || preflight.replyHandoffTargetMachineInstallationId !== null
                        || preflight.replyHandoffTargetMaterializationId !== null
                        || preflight.replyHandoffId !== null
                    )
            )
        ) {
            return null;
        }
        const suppressConversationHandoff = isConversationHandoff
            && typeof preflight.replyHandoffTargetMachineId === "string"
            && await readMachineAvailabilityStateInTx({
                tx,
                accountId: params.accountId,
                machineId: preflight.replyHandoffTargetMachineId,
            }) === "revoked";
        let resultEnvelopeAccountSeq: number | undefined;
        if (
            parsedResultEnvelope !== null
            && parsedResultEnvelope.envelope.t !== "legacySummaryCiphertext"
        ) {
            const outer = validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
                content: "result",
                mode: accountFence.account.currentness.encryptionMode,
                envelope: parsedResultEnvelope.envelope,
            });
            if (outer.kind !== "available") return null;
            if (isConversation) {
                const handoffId = isConversationHandoff
                    ? preflight.replyHandoffId
                    : null;
                if (
                    (isConversationHandoff && typeof handoffId !== "string")
                    || !hasExactPlainRunResultCorrespondence({
                        envelope: parsedResultEnvelope.envelope,
                        accountId: params.accountId,
                        automationId: preflight.automationId,
                        runId: params.runId,
                        handoffId,
                    })
                ) {
                    return null;
                }
            }
            resultEnvelopeAccountSeq = accountFence.account.version;
        }
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: preflight.attempt,
                state: preflight.state,
                revision: preflight.revision,
                workflowCustodyState: null,
                ...(strictNewSession
                    ? { producedSessionId: preflight.producedSessionId }
                    : {}),
                leaseExpiresAt: { gt: now },
                ...(isConversation
                    ? {
                        causeKind: "conversation",
                        replyHandoffState: isConversationHandoff
                            ? "awaitingResult"
                            : "none",
                    }
                    : { causeKind: { not: "conversation" } }),
                ...(resultEnvelopeAccountSeq === undefined
                    ? {}
                    : { account: { is: { seq: resultEnvelopeAccountSeq } } }),
            },
            data: {
                state: "succeeded",
                finishedAt: now,
                resultEnvelope,
                // New/current settlement has one result-envelope owner. The
                // predecessor column remains read-only until its floor retires.
                summaryCiphertext: null,
                producedSessionId,
                errorCode: null,
                errorMessage: null,
                ...(isConversationHandoff
                    ? {
                        replyHandoffState: suppressConversationHandoff
                            ? "suppressed"
                            : "ready",
                        replyHandoffDueAt: suppressConversationHandoff ? null : now,
                    }
                    : {}),
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
        });
        if (!run) return null;
        return await applyAutomationRunSucceededTx({
            tx,
            accountId: params.accountId,
            runId: run.id,
            previousState: preflight.state,
            now,
            eventPayload: {
                machineId: params.machineId,
                producedSessionId: producedSessionId ?? null,
            },
        });
    });
}

async function startAutomationRunInternal(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt?: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;

}): Promise<AutomationRunStartResult | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;

        if (await readMachineAvailabilityStateInTx({
            tx, accountId: params.accountId, machineId: params.machineId,
        }) !== "available") return null;

        if (!await hasExpectedAutomationAccountCurrentnessTx({
            tx,
            accountId: params.accountId,
            expected: params.accountCurrentness,
        })) {
            return null;
        }
        const now = new Date();
        const candidateRow = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                workflowCustodyState: null,
                claimedByMachineId: params.machineId,
                ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                state: "claimed",
                leaseExpiresAt: { gt: now },
            },
            select: automationRunItemSelect,
        });
        const candidate = candidateRow ? projectAutomationOriginRun(candidateRow) : null;
        if (!candidate) return null;


        const parsedRecipe = parseAutomationRunExecutionRecipeV1(candidate.executionInputEnvelope);
        const isExecutionRun = parsedRecipe.kind === "available"
            && parsedRecipe.recipe.target.kind === "executionRun";
        if (
            isExecutionRun
            && candidate.executionDispatchState === "retryWaiting"
            && candidate.executionAttempt >= AUTOMATION_EXECUTION_DISPATCH_MAX_ATTEMPTS
        ) {
            const terminalized = await tx.automationRun.updateMany({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    originKind: "automation",
                    automationId: { not: null },
                    causeKind: { not: null },
                    revision: candidate.revision,
                    claimedByMachineId: params.machineId,
                    attempt: candidate.attempt,
                    state: "claimed",
                    leaseExpiresAt: { gt: now },
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    workflowCustodyState: null,
                    executionDispatchState: "retryWaiting",
                    executionAttempt: candidate.executionAttempt,
                    account: { is: { seq: accountFence.account.version } },
                },
                data: {
                    state: "failed",
                    executionDispatchState: "settled",
                    executionDispatchDueAt: null,
                    executionNativeRunId: null,
                    executionNativeCallId: null,
                    executionNativeSidechainId: null,
                    startedAt: null,
                    finishedAt: now,
                    claimedByMachineId: null,
                    leaseExpiresAt: null,
                    errorCode: "execution_run_retry_exhausted",
                    errorMessage: null,
                    revision: { increment: 1 },
                    updatedAt: now,
                },
            });
            if (terminalized.count !== 1) return null;
            await publishFailedAutomationRunTx({
                tx,
                accountId: params.accountId,
                runId: params.runId,
                previousState: "claimed",
                now,
                machineId: params.machineId,
            });
            return null;
        }
        if (
            isExecutionRun
            && (
                candidate.executionAttempt >= AUTOMATION_EXECUTION_DISPATCH_MAX_ATTEMPTS
                || (
                    candidate.executionDispatchState !== "notStarted"
                    && candidate.executionDispatchState !== "retryWaiting"
                )
            )
        ) {
            return null;
        }

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                revision: candidate.revision,
                claimedByMachineId: params.machineId,
                attempt: candidate.attempt,
                state: "claimed",
                leaseExpiresAt: { gt: now },
                executionInputEnvelope: candidate.executionInputEnvelope,
                workflowCustodyState: null,
                ...(isExecutionRun
                    ? {
                        executionDispatchState: candidate.executionDispatchState,
                        executionAttempt: candidate.executionAttempt,
                    }
                    : {}),
            },
            data: {
                state: "running",
                startedAt: now,
                ...(isExecutionRun
                    ? {
                        executionDispatchState: "dispatchPermitted",
                        executionAttempt: { increment: 1 },
                        executionDispatchCommittedAt: now,
                        executionDispatchDueAt: null,
                    }
                    : {}),
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
        });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_started",
            now,
            payload: { machineId: params.machineId },
        });

        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });
        const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(tx, params.accountId);
        if (!accountCurrentness) {
            // The running transition and its S witness are one contract: do
            // not commit a start a worker cannot safely settle.
            throw new Error("Automation Account currentness became unavailable during start");
        }
        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                previousState: "claimed",
                cursor,
            });
        });

        return { run: run as AutomationRunItem, accountCurrentness };
    });
}

export async function startAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    /** C: exact witness returned by a successful claim. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
}): Promise<AutomationRunStartResult | null> {
    return await startAutomationRunInternal(params);
}


function normalizeExecutionDispatchErrorCode(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 128) : "execution_run_outcome_unknown";
}

function resolveStartedExecutionDispatchSettlement(
    outcome: Extract<AutomationExecutionDispatchOutcome, { kind: "started" }>,
): Readonly<{
    state: "succeeded" | "failed" | "cancelled" | "outcome_uncertain";
    executionDispatchState: "settled" | "started";
    errorCode: string | null;
}> {
    const wait = outcome.wait;
    if (
        !wait
        || wait.ok === false
        || wait.status === "running"
        || wait.result.run.runId !== outcome.runId
    ) {
        return {
            state: "outcome_uncertain",
            executionDispatchState: "started",
            errorCode: wait?.ok === false
                ? `execution_run_wait_${wait.code}`
                : "execution_run_outcome_unknown",
        };
    }
    if (wait.status === "succeeded") {
        return { state: "succeeded", executionDispatchState: "settled", errorCode: null };
    }
    if (wait.status === "cancelled") {
        return { state: "cancelled", executionDispatchState: "settled", errorCode: "execution_run_cancelled" };
    }
    return {
        state: "failed",
        executionDispatchState: "settled",
        errorCode: wait.status === "timeout" ? "execution_run_timeout" : "execution_run_failed",
    };
}

/**
 * A permitted dispatch may be superseded by cancellation before its worker can
 * report the start it already issued. The published terminality stands, but the
 * native identity is the only pointer back to an execution that may still be
 * running, so the settlement owner retains it exactly as the incumbent
 * fail/cancel owner retains a known canonical Session identity.
 */
async function retainSupersededExecutionDispatchIdentityTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    outcome: AutomationExecutionDispatchOutcome;
    now: Date;
}>): Promise<AutomationRunItem | null> {
    if (params.outcome.kind !== "started") return null;
    const superseded = await params.tx.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            originKind: "automation",
            automationId: { not: null },
            causeKind: { not: null },
            claimedByMachineId: params.machineId,
            attempt: params.attempt,
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionNativeRunId: null,
            workflowCustodyState: null,
        },
        select: { revision: true },
    });
    if (!superseded) return null;
    const retained = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            originKind: "automation",
            automationId: { not: null },
            causeKind: { not: null },
            claimedByMachineId: params.machineId,
            attempt: params.attempt,
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionNativeRunId: null,
            workflowCustodyState: null,
            revision: superseded.revision,
        },
        data: {
            executionNativeRunId: params.outcome.runId,
            executionNativeCallId: params.outcome.callId,
            executionNativeSidechainId: params.outcome.sidechainId,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
    if (retained.count !== 1) return null;
    const run = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
    });
    if (!run || run.state !== "outcome_uncertain") return null;
    const cursor = await markRunAutomationChanged({
        tx: params.tx,
        accountId: params.accountId,
        automationId: run.automationId,
    });
    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run: run as AutomationRunItem,
            previousState: "outcome_uncertain",
            cursor,
        });
    });
    return run as AutomationRunItem;
}

/**
 * Commits the result of the one Action call authorized by dispatchPermitted.
 * Only strict pre-creation rejection returns the same logical Run to the
 * ordinary claim queue; every ambiguous or started result is terminal locally.
 */
export async function settleAutomationExecutionDispatch(params: Readonly<{
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    outcome: AutomationExecutionDispatchOutcome;
}>): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        // `started` and `outcomeUnknown` both report after the external start
        // effect may have happened. An unrelated Account write that moved only
        // the global sequence must not discard either truthful result; an
        // encryption-mode or content-key transition still fences the write.
        // `noRunCreated` is a pre-effect redispatch-permission decision and
        // therefore keeps the exact post-start witness S.
        const mayHaveProducedExternalEffect = params.outcome.kind === "started"
            || params.outcome.kind === "outcomeUnknown";
        const currentnessHolds = mayHaveProducedExternalEffect
            ? await hasCompatibleAutomationAccountEncryptionTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            })
            : await hasExpectedAutomationAccountCurrentnessTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            });
        if (!currentnessHolds) return null;

        const now = new Date();
        const candidate = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: "running",
                leaseExpiresAt: { gt: now },
                executionDispatchState: "dispatchPermitted",
                workflowCustodyState: null,
            },
            select: {
                automationId: true,
                revision: true,
                executionAttempt: true,
            },
        });
        if (!candidate) {
            return await retainSupersededExecutionDispatchIdentityTx({
                tx,
                accountId: params.accountId,
                runId: params.runId,
                machineId: params.machineId,
                attempt: params.attempt,
                outcome: params.outcome,
                now,
            });
        }

        const shouldRetry = params.outcome.kind === "noRunCreated"
            && candidate.executionAttempt < AUTOMATION_EXECUTION_DISPATCH_MAX_ATTEMPTS;
        const startedSettlement = params.outcome.kind === "started"
            ? resolveStartedExecutionDispatchSettlement(params.outcome)
            : null;
        const terminalState = params.outcome.kind === "noRunCreated"
            ? "failed"
            : params.outcome.kind === "outcomeUnknown"
                ? "outcome_uncertain"
                : startedSettlement!.state;
        const dispatchState = params.outcome.kind === "noRunCreated"
            ? "settled"
            : params.outcome.kind === "outcomeUnknown"
                ? "outcomeUnknown"
                : startedSettlement!.executionDispatchState;
        const errorCode = params.outcome.kind === "started"
            ? startedSettlement!.errorCode
            : normalizeExecutionDispatchErrorCode(params.outcome.errorCode);

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                revision: candidate.revision,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: "running",
                leaseExpiresAt: { gt: now },
                executionDispatchState: "dispatchPermitted",
                executionAttempt: candidate.executionAttempt,
                workflowCustodyState: null,
            },
            data: shouldRetry
                ? {
                    state: "queued",
                    executionDispatchState: "retryWaiting",
                    executionDispatchDueAt: now,
                    dueAt: now,
                    claimedAt: null,
                    claimedByMachineId: null,
                    leaseExpiresAt: null,
                    startedAt: null,
                    errorCode,
                    errorMessage: null,
                    revision: { increment: 1 },
                    updatedAt: now,
                }
                : {
                    state: terminalState,
                    executionDispatchState: dispatchState,
                    executionDispatchDueAt: null,
                    executionNativeRunId: params.outcome.kind === "started" ? params.outcome.runId : null,
                    executionNativeCallId: params.outcome.kind === "started" ? params.outcome.callId : null,
                    executionNativeSidechainId: params.outcome.kind === "started" ? params.outcome.sidechainId : null,
                    finishedAt: now,
                    claimedByMachineId: null,
                    leaseExpiresAt: null,
                    errorCode,
                    errorMessage: null,
                    revision: { increment: 1 },
                    updatedAt: now,
                },
        });
        if (updated.count !== 1) return null;

        const run = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
        });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: shouldRetry
                ? "execution_dispatch_retry_scheduled"
                : terminalState === "outcome_uncertain"
                    ? "run_outcome_uncertain"
                    : terminalState === "succeeded"
                        ? "run_succeeded"
                        : terminalState === "cancelled"
                            ? "run_cancelled"
                            : "run_failed",
            now,
            payload: {
                machineId: params.machineId,
                executionAttempt: candidate.executionAttempt,
                outcome: params.outcome.kind,
            },
        });

        if (!shouldRetry) {
            await tx.automation.update({
                where: { id: run.automationId },
                data: { lastRunAt: now },
            });
            await advanceAutomationScheduleCursorAfterTerminalRunTx({
                tx,
                run: run as AutomationRunItem,
                now,
            });
        }
        const cursor = await markRunAutomationChanged({
            tx,
            accountId: params.accountId,
            automationId: run.automationId,
        });
        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                previousState: "running",
                cursor,
            });
        });
        return run as AutomationRunItem;
    });
}

/** Lease recovery may classify a committed dispatch as ambiguous, never retry it. */
export async function markAbandonedAutomationExecutionDispatchOutcomeUnknownTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
    state: "claimed" | "running";
    runRevision: number;
    executionInputEnvelope: string | null;
    expectedExecutionDispatchState: "dispatchPermitted" | null;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    now: Date;
}>): Promise<AutomationRunItem | null> {
    // Lease expiry is a post-effect decision: the dispatch lease was already
    // permitted, but the daemon did not return a settlement.  The external
    // effect may therefore have happened even when unrelated Account writes
    // advanced Account.seq after the daemon's witness.  Preserve the same
    // r0.46 authority split as the explicit outcomeUnknown settlement: an
    // encryption-mode/content-key transition refuses the write, while a
    // sequence-only change does not.  The exact Run/machine/attempt/revision
    // CAS below remains the linearization point and prevents stale lease
    // recovery from mutating a newer attempt.
    if (!await hasCompatibleAutomationAccountEncryptionTx({
        tx: params.tx,
        accountId: params.accountId,
        expected: params.accountCurrentness,
    })) {
        return null;
    }
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            state: params.state,
            revision: params.runRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            executionDispatchState: params.expectedExecutionDispatchState,
            workflowCustodyState: null,
            leaseExpiresAt: { lt: params.now },
        },
        data: {
            state: "outcome_uncertain",
            executionDispatchState: "outcomeUnknown",
            executionDispatchDueAt: null,
            finishedAt: params.now,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "execution_run_outcome_unknown",
            errorMessage: null,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
    if (updated.count !== 1) return null;

    const run = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
    });
    if (!run) return null;
    await appendRunEventTx({
        tx: params.tx,
        runId: run.id,
        type: "run_outcome_uncertain",
        now: params.now,
        payload: { reason: "dispatch_result_missing_after_lease_expiry" },
    });
    await params.tx.automation.update({
        where: { id: run.automationId },
        data: { lastRunAt: params.now },
    });
    await advanceAutomationScheduleCursorAfterTerminalRunTx({
        tx: params.tx,
        run: run as AutomationRunItem,
        now: params.now,
    });
    const cursor = await markRunAutomationChanged({
        tx: params.tx,
        accountId: params.accountId,
        automationId: run.automationId,
    });
    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run: run as AutomationRunItem,
            previousState: params.state,
            cursor,
        });
    });
    return run as AutomationRunItem;
}

export async function succeedAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    /**
     * S: the post-start witness echoed unchanged from the successful start.
     * Success requires a running Run, so this compares Account encryption
     * identity rather than the exact sequence, which the reported effect
     * itself may have advanced. The exact Run CAS owns whose report is
     * accepted.
     */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;
}): Promise<AutomationRunItem | null> {
    return await settleSucceededAutomationRun({
        ...params,
    });
}

/** Strict predecessor adapter. New/current callers cannot write legacy summaries. */


/**
 * The incumbent Run terminality owner for a recipe or source that is unavailable
 * before a worker may receive it. The caller supplies the preflight snapshot,
 * so this update is one CAS over the Account witness, Run revision, and exact
 * frozen bytes; a concurrent Account transition or Run rewrite wins instead.
 */
export async function failInvalidAutomationRunBeforeClaimTx(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
    state: "queued" | "claimed" | "running";
    runRevision: number;
    executionInputEnvelope: string | null;
    workflowCustodyState?: "pending" | null;
    errorCode?: "invalid_template" | "source_unavailable";
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    now: Date;
}): Promise<AutomationRunItem | null> {
    const workflowCustodyState = params.workflowCustodyState ?? null;
    const errorCode = params.errorCode ?? "invalid_template";
    // A missing source disposes queued, pre-effect work only; existing effects
    // and accepted Workflow snapshots remain with their runtime settlement owner.
    if ((errorCode === "source_unavailable" || workflowCustodyState !== null) && params.state !== "queued") return null;
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            state: params.state,
            revision: params.runRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            workflowCustodyState,
            ...(errorCode === "source_unavailable" || workflowCustodyState !== null ? {
                startedAt: null, producedSessionId: null, workflowAcceptedSnapshotEnvelope: null,
                OR: [
                    { executionDispatchState: null },
                    { executionDispatchState: "notStarted" },
                    { executionDispatchState: "retryWaiting" },
                ],
            } : {}),
            account: {
                is: { seq: params.accountCurrentness.version },
            },
        },
        data: {
            state: "failed",
            finishedAt: params.now,
            errorCode,
            ...(workflowCustodyState !== null ? { workflowCustodyState: "settled" } : {}),
            // This server-only preflight has no Account private-content
            // material. Its structural code remains observable; V3 never
            // stores a raw detail as a substitute for a worker-sealed envelope.
            errorMessage: null,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
    if (updated.count !== 1) return null;

    if (errorCode === "source_unavailable") {
        await invalidateSessionReviewProjectionsForAutomationInTx(params.tx, params.automationId);
        return await applyAutomationRunTerminalEffectsTx({
            tx: params.tx, accountId: params.accountId, runId: params.runId,
            previousState: params.state, state: "failed", now: params.now, eventPayload: { errorCode },
        });
    }
    return await publishFailedAutomationRunTx({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
        previousState: params.state,
        now: params.now,
    });
}

async function failAutomationRunInternal(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt?: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    errorCode?: string | null;
    terminalState?: "skipped";
    /** V3 Account-mode-correct private failure detail. */
    errorDetailEnvelope?: string | null;

}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;

        const now = new Date();
        const previousRunRow = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                AND: [{ OR: [
                    { workflowCustodyState: null },
                    { workflowCustodyState: "pending", state: "claimed", startedAt: null,
                        workflowAcceptedSnapshotEnvelope: null },
                ] }],
                claimedByMachineId: params.machineId,
                ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                state: { in: params.terminalState === "skipped" ? ["claimed"] : ["claimed", "running"] },
                // See settleSucceededAutomationRun: a permitted dispatch keeps
                // its outcome with the execution dispatch settlement owner, and
                // a retained NULL dispatch state means the same as `notStarted`.
                OR: [
                    { executionDispatchState: null },
                    { executionDispatchState: { not: "dispatchPermitted" } },
                ],
                leaseExpiresAt: { gt: now },
            },
            select: automationRunItemSelect,
        });
        const previousRun = previousRunRow ? projectAutomationOriginRun(previousRunRow) : null;
        if (params.terminalState === "skipped" && (!previousRun || params.errorCode !== "diff_unchanged"
            || previousRun.startedAt !== null || previousRunRow?.workflowAcceptedSnapshotEnvelope !== null
            || previousRun.producedSessionId !== null || params.producedSessionId != null)) return null;
        if (!previousRun) {
            // Cancellation may race a completed canonical Session create. The
            // incumbent fail/cancel owner retains only that known new-Session
            // identity; it never changes terminality or creates a second
            // receipt/settlement path. A running cancellation is
            // `outcome_uncertain`, so a late failure acknowledgement can
            // attach the same canonical Session without rewriting uncertainty.
            const cancelledRunRow = await tx.automationRun.findFirst({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    originKind: "automation",
                    automationId: { not: null },
                    causeKind: { not: null },
                    workflowCustodyState: null,
                    claimedByMachineId: params.machineId,
                    ...(params.attempt === undefined ? {} : { attempt: params.attempt }),
                    state: { in: ["cancelled", "outcome_uncertain"] },
                },
                select: automationRunItemSelect,
            });
            const cancelledRun = cancelledRunRow ? projectAutomationOriginRun(cancelledRunRow) : null;
            if (!cancelledRun) return null;
            if (!await hasCompatibleAutomationAccountEncryptionTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            })) {
                return null;
            }

            const producedSessionId = await resolveProducedSessionIdForRunTx({
                tx,
                accountId: params.accountId,
                originKind: cancelledRun.originKind,
                automationId: cancelledRun.automationId,
                runId: params.runId,
                executionInputEnvelope: cancelledRun.executionInputEnvelope,
                producedSessionId: params.producedSessionId,
            });
            if (!producedSessionId) return null;
            if (cancelledRun.producedSessionId !== null) {
                return cancelledRun.producedSessionId === producedSessionId
                    ? await fetchRunForAccount({
                        tx,
                        accountId: params.accountId,
                        runId: params.runId,
                    })
                    : null;
            }
            const retained = await tx.automationRun.updateMany({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.machineId,
                    attempt: cancelledRun.attempt,
                    state: cancelledRun.state,
                    revision: cancelledRun.revision,
                    executionInputEnvelope: cancelledRun.executionInputEnvelope,
                    workflowCustodyState: null,
                    producedSessionId: null,
                },
                data: {
                    producedSessionId,
                    revision: { increment: 1 },
                    updatedAt: now,
                },
            });
            if (retained.count !== 1) return null;
            const run = await fetchRunForAccount({
                tx,
                accountId: params.accountId,
                runId: params.runId,
            });
            if (!run || run.state !== cancelledRun.state) return null;
            const cursor = await markRunAutomationChanged({
                tx,
                accountId: params.accountId,
                automationId: run.automationId,
            });
            afterTx(tx, () => {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: run as AutomationRunItem,
                    previousState: cancelledRun.state,
                    cursor,
                });
            });
            return run as AutomationRunItem;
        }
        // A `running` failure reports a post-start outcome: the start's target
        // effect and any unrelated Account write may have advanced
        // `Account.seq` past S, so it compares encryption identity under the
        // same exact Run CAS as the success settlement. A `claimed` failure is
        // a pre-effect decision — nothing has started — and keeps the exact
        // claim witness.
        if (!await (previousRun.state === "running"
            ? hasCompatibleAutomationAccountEncryptionTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            })
            : hasExpectedAutomationAccountCurrentnessTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            }))) {
            return null;
        }

        const errorMessage = params.errorDetailEnvelope ?? null;
        assertAutomationRunFailureDetailEnvelopeOuterForMode({
                raw: errorMessage,
                mode: accountFence.account.currentness.encryptionMode,
            });
        const retainedStrictSessionId = deriveStrictNewSessionCreationTag({
            originKind: previousRun.originKind,
            automationId: previousRun.automationId,
            runId: params.runId,
            executionInputEnvelope: previousRun.executionInputEnvelope,
        }) !== null
            ? previousRun.producedSessionId
            : null;
        const producedSessionId = await resolveProducedSessionIdForRunTx({
            tx,
            accountId: params.accountId,
            originKind: previousRun.originKind,
            automationId: previousRun.automationId,
            runId: params.runId,
            executionInputEnvelope: previousRun.executionInputEnvelope,
            producedSessionId: retainedStrictSessionId ?? params.producedSessionId,
        });
        // A cross-machine success may already have attached the canonical
        // Session before its outer acknowledgement was lost. A later terminal
        // error owns Run terminality, but must not erase that committed output.
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: previousRun.attempt,
                state: previousRun.state,
                revision: previousRun.revision,
                workflowCustodyState: previousRun.workflowCustodyState,
                leaseExpiresAt: { gt: now },
            },
            data: {
                state: params.terminalState ?? "failed",
                ...(previousRun.workflowCustodyState !== null ? { workflowCustodyState: "settled" } : {}),
                finishedAt: now,
                errorCode: typeof params.errorCode === "string" && params.errorCode.trim().length > 0
                    ? params.errorCode.trim().slice(0, 128)
                    : null,
                errorMessage,
                producedSessionId,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }
        if (params.terminalState === "skipped" || previousRun.workflowCustodyState !== null) {
            return await applyAutomationRunTerminalEffectsTx({ tx, accountId: params.accountId,
                runId: params.runId, previousState: previousRun.state, state: params.terminalState ?? "failed",
                now, eventPayload: { machineId: params.machineId, errorCode: params.errorCode ?? null },
            });
        }
        return await publishFailedAutomationRunTx({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            previousState: previousRun.state,
            now,
            machineId: params.machineId,
        });
    });
}

export async function failAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    /**
     * S: the post-start witness echoed unchanged from the successful start.
     * A `running` failure compares Account encryption identity against it —
     * not the exact sequence, which the reported effect itself may have
     * advanced; a `claimed` (pre-start) failure keeps the exact claim
     * witness. Either way the exact Run CAS owns whose report is accepted.
     */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    errorCode?: string | null;
    terminalState?: "skipped";
    errorDetailEnvelope?: string | null;
}): Promise<AutomationRunItem | null> {
    return await failAutomationRunInternal(params);
}


/** One settled canonical-cancellation row, consumed by the publication seam. */
export type CancelledAutomationRunTxResult = Readonly<{
    run: AutomationRunItem;
    previousState: AutomationRunItem["state"];
    transitionCause?:
        | typeof AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1
        | typeof AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1;
}>;

/**
 * The one canonical Run-cancellation row transition, shared by ordinary
 * per-Run cancellation and by the Automation-owned machine-assignment removal
 * composition when permanent machine revocation strands admitted
 * Runs. Callers own the Account encryption fence and the post-transition
 * publication; this owner owns the exact Run CAS, lifecycle event, reply
 * handoff closure, and schedule-cursor advance.
 */
export async function cancelAutomationRunRowTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    previousRun: AutomationRunItem;
    accountEncryptionMode: "plain" | "e2ee";

    /**
     * The caller is the present user's explicit per-Run cancellation rather
     * than an Automation-owned settlement such as machine-assignment removal.
     * Only that intent may be published as an authoritative cancellation the
     * claiming machine acts on.
     */
    presentUserCancellation?: boolean;
}>): Promise<CancelledAutomationRunTxResult | null> {
    const { previousRun } = params;
    if (
        previousRun.state !== "queued"
        && previousRun.state !== "claimed"
        && previousRun.state !== "running"
    ) return null;


    const now = new Date();
    // Dispatch permission is the boundary after which one external execution
    // may already be running. A Run observed running is past the same boundary
    // for its target regardless of target kind and regardless of the retained
    // dispatch bytes (session-targeted Runs keep no dispatch state at all), so
    // every running Run — and any retained/malformed dispatchPermitted row —
    // may only settle outcome-uncertain. Cancellation stays authoritative but
    // cannot claim accepted external work disappeared. Queued and claimed
    // Runs have had no permission to start and settle cleanly cancelled.
    const dispatchPermitted = previousRun.executionDispatchState === "dispatchPermitted";
    const outcomeUncertain = dispatchPermitted || previousRun.state === "running";
    const terminalState = outcomeUncertain ? "outcome_uncertain" : "cancelled";
    // Released V2 has no uncertain terminal state, so this settlement would
    // strand the Run in a shape the V2 projection cannot render at all. Refuse
    // before any mutation: the Run stays invisible/not-found to that caller
    // exactly as an unrepresentable Run already does at every other V2
    // boundary, while queued and claimed Runs still settle cleanly cancelled.

    // A Session target keeps no dispatch vocabulary at all, so its running
    // cancellation carries no dispatch fact to name. The claiming machine
    // still needs the user's authoritative intent to discard the exact
    // deterministic Automation input instead of abandoning a stale attempt.
    const sessionTargetRunningCancellation = params.presentUserCancellation === true
        && !dispatchPermitted
        && previousRun.state === "running"
        && previousRun.executionDispatchState === null;
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: previousRun.id,
            accountId: params.accountId,
            state: previousRun.state,
            revision: previousRun.revision,
            executionDispatchState: previousRun.executionDispatchState,
        },
        data: {
            state: terminalState,
            ...(outcomeUncertain
                ? {
                    // Rows that carry dispatch vocabulary record the unknown
                    // outcome in it; session-targeted Runs intentionally keep
                    // none. A terminal Run owns no dispatch-retry cursor.
                    executionDispatchState: previousRun.executionDispatchState === null
                        ? null
                        : "outcomeUnknown",
                    executionDispatchDueAt: null,
                    errorCode: dispatchPermitted
                        ? "execution_run_cancelled_outcome_unknown"
                        : "execution_run_outcome_unknown",
                }
                : {}),
            finishedAt: now,
            revision: { increment: 1 },
            updatedAt: now,
        },
    });
    if (updated.count !== 1) return null;

    if (params.presentUserCancellation === true && outcomeUncertain) {
        const sessionId = await resolveAutomationPendingInputSessionIdTx({
            tx: params.tx,
            accountId: params.accountId,
            automationId: previousRun.automationId,
            runId: previousRun.id,
            executionInputEnvelope: previousRun.executionInputEnvelope,
            accountEncryptionMode: params.accountEncryptionMode,
            retainedV2OriginKind: retainedV2OriginKindForRun(previousRun),
        });
        if (sessionId !== null) {
            await retireAutomationPendingInputInTx({
                tx: params.tx,
                accountId: params.accountId,
                sessionId,
                runId: previousRun.id,
            });
        }
    }

    await blockAwaitingReplyHandoffForTerminalRunTx({
        tx: params.tx,
        accountId: params.accountId,
        runId: previousRun.id,
        state: terminalState,
        now,
    });

    const run = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: previousRun.id,
    });
    if (!run) return null;
    await appendRunEventTx({
        tx: params.tx,
        runId: run.id,
        type: outcomeUncertain ? "run_outcome_uncertain" : "run_cancelled",
        now,
        ...(dispatchPermitted
            ? { payload: { reason: "cancelled_after_dispatch_permitted" } }
            : outcomeUncertain
                ? { payload: { reason: "cancelled_while_running" } }
                : {}),
    });
    await advanceAutomationScheduleCursorAfterTerminalRunTx({
        tx: params.tx,
        run: run as AutomationRunItem,
        now,
    });
    return {
        run: run as AutomationRunItem,
        previousState: previousRun.state,
        ...(dispatchPermitted
            ? { transitionCause: AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1 }
            : sessionTargetRunningCancellation
                ? { transitionCause: AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1 }
                : {}),
    };
}

/**
 * The one post-transition publication seam for settled cancellation rows:
 * Account/Automation change marking plus the post-commit Run transition
 * carrier (including the authoritative cancelled-after-dispatch cause when a
 * result carries one). Shared by ordinary cancellation and by the
 * machine-assignment removal composition.
 */
export async function publishCancelledAutomationRunsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    results: readonly CancelledAutomationRunTxResult[];
}>): Promise<void> {
    const automationIds = [...new Set(params.results.map((result) => result.run.automationId))];
    const cursorByAutomationId = new Map<string, number>();
    for (const automationId of automationIds) {
        cursorByAutomationId.set(automationId, await markRunAutomationChanged({
            tx: params.tx,
            accountId: params.accountId,
            automationId,
        }));
    }
    afterTx(params.tx, () => {
        for (const result of params.results) {
            const cursor = cursorByAutomationId.get(result.run.automationId);
            if (cursor === undefined) continue;
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: result.run,
                previousState: result.previousState,
                cursor,
                ...(result.transitionCause ? { transitionCause: result.transitionCause } : {}),
            });
        }
    });
}

export async function cancelAutomationRun(params: {
    accountId: string;
    runId: string;

}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const previousRun = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
        });
        if (!previousRun) return null;
        if (previousRun.workflowCustodyState !== null) {

            try {
                await cancelWorkflowRunTx(tx, {
                    accountId: params.accountId,
                    runId: params.runId,
                    expectedRevision: previousRun.revision,
                });
            } catch (error) {
                if (error instanceof WorkflowRunServiceError && error.code === "currentness_conflict") return null;
                throw error;
            }
            return await fetchRunForAccount({
                tx,
                accountId: params.accountId,
                runId: params.runId,
            });
        }
        const result = await cancelAutomationRunRowTx({
            tx,
            accountId: params.accountId,
            previousRun: previousRun as AutomationRunItem,
            accountEncryptionMode: accountFence.account.currentness.encryptionMode,
            presentUserCancellation: true,
        });
        if (!result) return null;
        await publishCancelledAutomationRunsTx({
            tx,
            accountId: params.accountId,
            results: [result],
        });
        return result.run;
    });
}

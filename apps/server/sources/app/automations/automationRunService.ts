import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    AutomationRunResultStoredV1Schema,
    deriveSessionCreationTagV1,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
    type AutomationAccountCurrentnessWitnessV1,
    type ExecutionRunWaitResult,
    type AutomationRunResultStoredV1,
    type SessionServerStartDispatchResultV1,
} from "@happier-dev/protocol";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";

import { emitAutomationRunTransition } from "./automationChangePublisher";
import {
    fetchAutomationAccountCurrentnessWitnessTx,
    sameAutomationAccountCurrentnessWitness,
} from "./automationAccountCurrentness";
import { enqueueNextScheduledRunIfMissingTx } from "./automationRunQueueService";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import { isFinalAutomationRunStatus } from "./automationSchedulingService";
import { sanitizeAutomationErrorMessage } from "./automationSummaryService";
import {
    assertAutomationRunFailureDetailEnvelopeOuterForMode,
    validateRetainedAutomationRunExecutionInputV2OuterForMode,
} from "./automationStoredContentRead";
import type {
    AutomationRunItem,
    AutomationRunOriginKind,
    AutomationTriggerKind,
} from "./automationTypes";

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
    return observed !== null && sameAutomationAccountCurrentnessWitness(observed, params.expected);
}

/**
 * Cancellation publishes an Automation Account change, so the worker's
 * start-time witness is necessarily one version behind when it later reports
 * a known Session. The cancelled-only retention path has no content or
 * lifecycle authority; it may therefore ignore that self-caused version bump,
 * but must still refuse an encryption-mode or content-key transition.
 */
async function hasCompatibleAutomationAccountEncryptionTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    expected: AutomationAccountCurrentnessWitnessV1 | undefined;
}>): Promise<boolean> {
    if (!params.expected) return true;
    const observed = await fetchAutomationAccountCurrentnessWitnessTx(params.tx, params.accountId);
    return observed !== null
        && observed.mode === params.expected.mode
        && observed.contentKeyFingerprint === params.expected.contentKeyFingerprint;
}

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
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    return await params.tx.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
            ...(params.expectedTriggerKind
                ? { automation: { triggerKind: params.expectedTriggerKind } }
                : {}),
        },
        select: automationRunItemSelect,
    });
}

/**
 * Settles queued Runs through the same durable Run lifecycle as explicit
 * cancellation. Callers use this for a pause/delete or invalidated schedule;
 * Run history is retained and no queue row is physically discarded.
 */
export async function cancelQueuedAutomationRunsTx(params: {
    tx: any;
    accountId: string;
    automationId: string;
    originKind?: AutomationRunOriginKind;
}): Promise<AutomationRunItem[]> {
    const now = new Date();
    const candidates = await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            automationId: params.automationId,
            state: "queued",
            ...(params.originKind ? { originKind: params.originKind } : {}),
        },
        select: { id: true },
    });
    if (candidates.length === 0) {
        return [];
    }

    const candidateIds = candidates.map((run: { id: string }) => run.id);
    const cancelled = await params.tx.automationRun.updateMany({
        where: {
            id: { in: candidateIds },
            accountId: params.accountId,
            automationId: params.automationId,
            state: "queued",
            ...(params.originKind ? { originKind: params.originKind } : {}),
        },
        data: {
            state: "cancelled",
            finishedAt: now,
            revision: { increment: 1 },
            updatedAt: now,
        },
    });
    if (cancelled.count === 0) {
        return [];
    }

    // A terminal cancellation owns the same custody conclusion as an explicit
    // Run failure. Only an awaiting Conversation handoff changes state; none
    // and already-terminal handoffs retain their incumbent meaning.
    await params.tx.automationRun.updateMany({
        where: {
            id: { in: candidateIds },
            accountId: params.accountId,
            automationId: params.automationId,
            state: "cancelled",
            finishedAt: now,
            replyHandoffState: "awaitingResult",
        },
        data: {
            replyHandoffState: "blocked",
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
            updatedAt: now,
        },
    });
    const terminalRuns = await params.tx.automationRun.findMany({
        where: {
            id: { in: candidateIds },
            accountId: params.accountId,
            automationId: params.automationId,
            state: "cancelled",
            finishedAt: now,
        },
        select: automationRunItemSelect,
    });
    if (terminalRuns.length > 0) {
        await params.tx.automationRunEvent.createMany({
            data: terminalRuns.map((run: { id: string }) => ({
                runId: run.id,
                ts: now,
                type: "run_cancelled",
                payload: null,
            })),
        });
    }
    return terminalRuns as AutomationRunItem[];
}

async function markRunAutomationChanged(params: { tx: any; accountId: string; automationId: string }) {
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
    automationId: string;
    runId: string;
    executionInputEnvelope: string | null;
}): string | null {
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
    automationId: string;
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

async function resolveStrictNewSessionProducedSessionIdTx(params: {
    tx: any;
    accountId: string;
    automationId: string;
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
    automationId: string;
    runId: string;
    executionInputEnvelope: string | null;
    producedSessionId: string | null | undefined;
}): Promise<string | null> {
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    return recipe.kind === "available" && recipe.recipe.target.kind === "newSession"
        ? await resolveStrictNewSessionProducedSessionIdTx(params)
        : await resolveProducedSessionIdTx(params);
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
                state: { in: ["running", "cancelled"] },
            },
            select: {
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

async function maybeEnqueueFollowUpRun(params: { tx: any; run: AutomationRunItem; now: Date }) {
    if (!isFinalAutomationRunStatus(params.run.state)) {
        return null;
    }
    return await enqueueNextScheduledRunIfMissingTx({
        tx: params.tx,
        automationId: params.run.automationId,
        now: params.now,
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
    state: "failed" | "cancelled";
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
            replyHandoffReceiptEnvelope: null,
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
    expectedTriggerKind?: AutomationTriggerKind;
    machineId?: string;
    enqueueFollowUp?: boolean;
}): Promise<AutomationRunItem | null> {
    const run = await fetchRunForAccount({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
        expectedTriggerKind: params.expectedTriggerKind,
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
        expectedTriggerKind: params.expectedTriggerKind,
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

    const nextRun = params.enqueueFollowUp === false
        ? null
        : await maybeEnqueueFollowUpRun({
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
        if (nextRun) {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: nextRun,
                previousState: null,
                cursor,
            });
        }
    });

    return terminalRun as AutomationRunItem;
}

type ParsedAutomationRunResultEnvelope = Readonly<{
    raw: string;
    envelope: AutomationRunResultStoredV1;
}>;

function parseAutomationRunResultEnvelope(
    raw: string | null | undefined,
    params: { allowLegacy: boolean },
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
        || (!params.allowLegacy && parsed.data.t === "legacySummaryCiphertext")
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
    attempt: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;
    allowLegacyResultEnvelope: boolean;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        if (!await hasExpectedAutomationAccountCurrentnessTx({
            tx,
            accountId: params.accountId,
            expected: params.accountCurrentness,
        })) {
            return null;
        }
        const now = new Date();
        const parsedResultEnvelope = parseAutomationRunResultEnvelope(
            params.resultEnvelope,
            { allowLegacy: params.allowLegacyResultEnvelope },
        );
        const resultEnvelope = parsedResultEnvelope?.raw ?? null;
        const preflight = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: { in: ["claimed", "running"] },
                leaseExpiresAt: { gt: now },
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            select: {
                automationId: true,
                state: true,
                originKind: true,
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                executionInputEnvelope: true,
                producedSessionId: true,
            },
        });
        if (!preflight) return null;
        const strictNewSession = deriveStrictNewSessionCreationTag({
            automationId: preflight.automationId,
            runId: params.runId,
            executionInputEnvelope: preflight.executionInputEnvelope,
        }) !== null;
        const producedSessionId = await resolveProducedSessionIdForRunTx({
            tx,
            accountId: params.accountId,
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
        if (
            params.requireV2RunRepresentability
            && (
                !preflight.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: preflight.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    originKind: preflight.originKind,
                })?.kind !== "available"
            )
        ) return null;

        const isConversation = preflight.originKind === "conversation";
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
                attempt: params.attempt,
                state: preflight.state,
                ...(params.requireV2RunRepresentability
                    ? { executionInputEnvelope: preflight.executionInputEnvelope }
                    : {}),
                ...(params.requireV2RunRepresentability
                    ? { AND: [{ originKind: preflight.originKind }] }
                    : {}),
                ...(strictNewSession
                    ? { producedSessionId: preflight.producedSessionId }
                    : {}),
                leaseExpiresAt: { gt: now },
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
                ...(isConversation
                    ? {
                        originKind: "conversation",
                        replyHandoffState: isConversationHandoff
                            ? "awaitingResult"
                            : "none",
                    }
                    : { originKind: { not: "conversation" } }),
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
                        replyHandoffState: "ready",
                        replyHandoffDueAt: now,
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
            expectedTriggerKind: params.expectedTriggerKind,
        });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_succeeded",
            now,
            payload: {
                machineId: params.machineId,
                producedSessionId: producedSessionId ?? null,
            },
        });

        await tx.automation.update({
            where: { id: run.automationId },
            data: { lastRunAt: now },
        });

        const nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });

        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                previousState: preflight.state,
                cursor,
            });
            if (nextRun) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: nextRun as AutomationRunItem,
                    previousState: null,
                    cursor,
                });
            }
        });

        return run as AutomationRunItem;
    });
}

async function startAutomationRunInternal(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<AutomationRunStartResult | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        if (!await hasExpectedAutomationAccountCurrentnessTx({
            tx,
            accountId: params.accountId,
            expected: params.accountCurrentness,
        })) {
            return null;
        }
        const now = new Date();
        const candidate = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: "claimed",
                leaseExpiresAt: { gt: now },
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            select: {
                revision: true,
                originKind: true,
                executionInputEnvelope: true,
                executionDispatchState: true,
                executionAttempt: true,
            },
        });
        if (!candidate) return null;
        if (
            params.requireV2RunRepresentability
            && (
                !candidate.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: candidate.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    originKind: candidate.originKind,
                })?.kind !== "available"
            )
        ) return null;

        const parsedRecipe = parseAutomationRunExecutionRecipeV1(candidate.executionInputEnvelope);
        const isExecutionRun = parsedRecipe.kind === "available"
            && parsedRecipe.recipe.target.kind === "executionRun";
        if (
            isExecutionRun
            && candidate.executionDispatchState === "retryWaiting"
            && candidate.executionAttempt >= 3
        ) {
            const terminalized = await tx.automationRun.updateMany({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    revision: candidate.revision,
                    claimedByMachineId: params.machineId,
                    attempt: params.attempt,
                    state: "claimed",
                    leaseExpiresAt: { gt: now },
                    executionInputEnvelope: candidate.executionInputEnvelope,
                    executionDispatchState: "retryWaiting",
                    executionAttempt: candidate.executionAttempt,
                    account: { is: { seq: accountFence.account.version } },
                    ...(params.requireV2RunRepresentability
                        ? { originKind: candidate.originKind }
                        : {}),
                    ...(params.expectedTriggerKind
                        ? { automation: { triggerKind: params.expectedTriggerKind } }
                        : {}),
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
                expectedTriggerKind: params.expectedTriggerKind,
                machineId: params.machineId,
            });
            return null;
        }
        if (
            isExecutionRun
            && (
                candidate.executionAttempt >= 3
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
                attempt: params.attempt,
                state: "claimed",
                leaseExpiresAt: { gt: now },
                executionInputEnvelope: candidate.executionInputEnvelope,
                ...(params.requireV2RunRepresentability
                    ? { originKind: candidate.originKind }
                    : {}),
                ...(isExecutionRun
                    ? {
                        executionDispatchState: candidate.executionDispatchState,
                        executionAttempt: candidate.executionAttempt,
                    }
                    : {}),
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
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
            expectedTriggerKind: params.expectedTriggerKind,
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
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunStartResult | null> {
    return await startAutomationRunInternal(params);
}

/** Strict released-V2 adapter. Current V3 workers must call startAutomationRun. */
export async function startAutomationRunFromV2(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    return (await startAutomationRunInternal({
        ...params,
        requireV2RunRepresentability: true,
    }))?.run ?? null;
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
    expectedTriggerKind?: AutomationTriggerKind;
}>): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        if (!await hasExpectedAutomationAccountCurrentnessTx({
            tx,
            accountId: params.accountId,
            expected: params.accountCurrentness,
        })) {
            return null;
        }

        const now = new Date();
        const candidate = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: "running",
                leaseExpiresAt: { gt: now },
                executionDispatchState: "dispatchPermitted",
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            select: {
                automationId: true,
                revision: true,
                executionAttempt: true,
            },
        });
        if (!candidate) return null;

        const shouldRetry = params.outcome.kind === "noRunCreated"
            && candidate.executionAttempt < 3;
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
                revision: candidate.revision,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: "running",
                leaseExpiresAt: { gt: now },
                executionDispatchState: "dispatchPermitted",
                executionAttempt: candidate.executionAttempt,
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
            expectedTriggerKind: params.expectedTriggerKind,
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

        let nextRun: AutomationRunItem | null = null;
        if (!shouldRetry) {
            await tx.automation.update({
                where: { id: run.automationId },
                data: { lastRunAt: now },
            });
            nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
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
            if (nextRun) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: nextRun,
                    previousState: null,
                    cursor,
                });
            }
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
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    now: Date;
    expectedTriggerKind?: AutomationTriggerKind;
}>): Promise<AutomationRunItem | null> {
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            state: params.state,
            revision: params.runRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            executionDispatchState: "dispatchPermitted",
            leaseExpiresAt: { lt: params.now },
            account: { is: { seq: params.accountCurrentness.version } },
            automation: {
                enabled: true,
                deletedAt: null,
                ...(params.expectedTriggerKind
                    ? { triggerKind: params.expectedTriggerKind }
                    : {}),
            },
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
        expectedTriggerKind: params.expectedTriggerKind,
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
    const nextRun = await maybeEnqueueFollowUpRun({ tx: params.tx, run: run as AutomationRunItem, now: params.now });
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
        if (nextRun) {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: nextRun,
                previousState: null,
                cursor,
            });
        }
    });
    return run as AutomationRunItem;
}

/**
 * The incumbent Run terminality owner resolves an expired lease whose
 * Definition or original claimant assignment was retired. A lease that is
 * still current remains owned by its claimant; once it expires, it cannot be
 * reclaimed through a retired Definition. A claimed Run has not crossed the
 * start boundary, while a running Run (or committed detached dispatch) may
 * already have produced an effect and therefore remains explicitly uncertain.
 */
export async function terminalizeRetiredAutomationRunAfterLeaseExpiryTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
    state: "claimed" | "running";
    runRevision: number;
    machineId: string;
    executionInputEnvelope: string | null;
    originKind: AutomationRunOriginKind;
    executionDispatchState: string | null;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    now: Date;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}>): Promise<AutomationRunItem | null> {
    const mayHaveStartedEffect = params.state === "running"
        || params.executionDispatchState === "dispatchPermitted"
        || params.executionDispatchState === "started";
    const terminalState = mayHaveStartedEffect ? "outcome_uncertain" : "cancelled";
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            state: params.state,
            revision: params.runRevision,
            claimedByMachineId: params.machineId,
            executionInputEnvelope: params.executionInputEnvelope,
            leaseExpiresAt: { lt: params.now },
            account: { is: { seq: params.accountCurrentness.version } },
            automation: {
                ...(params.expectedTriggerKind
                    ? { triggerKind: params.expectedTriggerKind }
                    : {}),
                OR: [
                    { enabled: false },
                    { deletedAt: { not: null } },
                    {
                        assignments: {
                            none: {
                                machineId: params.machineId,
                                enabled: true,
                            },
                        },
                    },
                ],
            },
            ...(params.requireV2RunRepresentability
                ? { originKind: params.originKind }
                : {}),
        },
        data: {
            state: terminalState,
            ...(params.executionDispatchState === "dispatchPermitted"
                ? {
                    executionDispatchState: "outcomeUnknown",
                    executionDispatchDueAt: null,
                }
                : {}),
            finishedAt: params.now,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            errorCode: "automation_retired_after_lease_expiry",
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
        expectedTriggerKind: params.expectedTriggerKind,
    });
    if (!run) return null;
    await appendRunEventTx({
        tx: params.tx,
        runId: run.id,
        type: terminalState === "outcome_uncertain" ? "run_outcome_uncertain" : "run_cancelled",
        now: params.now,
        payload: { reason: "automation_retired_after_lease_expiry" },
    });
    if (terminalState === "outcome_uncertain") {
        await params.tx.automation.update({
            where: { id: run.automationId },
            data: { lastRunAt: params.now },
        });
    }
    const nextRun = await maybeEnqueueFollowUpRun({
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
        if (nextRun) {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: nextRun,
                previousState: null,
                cursor,
            });
        }
    });
    return run as AutomationRunItem;
}

export async function succeedAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    /** S: must equal the witness returned by the successful start. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    return await settleSucceededAutomationRun({
        ...params,
        allowLegacyResultEnvelope: false,
    });
}

/** Strict predecessor adapter. New/current callers cannot write legacy summaries. */
export async function succeedAutomationRunFromV2(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    producedSessionId?: string | null;
    summaryCiphertext?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    const summaryCiphertext = typeof params.summaryCiphertext === "string"
        ? params.summaryCiphertext
        : null;
    return await settleSucceededAutomationRun({
        accountId: params.accountId,
        runId: params.runId,
        machineId: params.machineId,
        attempt: params.attempt,
        producedSessionId: params.producedSessionId,
        resultEnvelope: summaryCiphertext === null
            ? null
            : JSON.stringify({ t: "legacySummaryCiphertext", c: summaryCiphertext }),
        allowLegacyResultEnvelope: true,
        expectedTriggerKind: params.expectedTriggerKind,
        requireV2RunRepresentability: true,
    });
}

/**
 * The incumbent Run terminality owner for a recipe that is durably invalid
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
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    now: Date;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            accountId: params.accountId,
            automationId: params.automationId,
            state: params.state,
            revision: params.runRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            account: {
                is: { seq: params.accountCurrentness.version },
            },
            automation: {
                enabled: true,
                deletedAt: null,
                ...(params.expectedTriggerKind
                    ? { triggerKind: params.expectedTriggerKind }
                    : {}),
            },
        },
        data: {
            state: "failed",
            finishedAt: params.now,
            errorCode: "invalid_template",
            // This server-only preflight has no Account private-content
            // material. Its structural code remains observable; V3 never
            // stores a raw detail as a substitute for a worker-sealed envelope.
            errorMessage: null,
            revision: { increment: 1 },
            updatedAt: params.now,
        },
    });
    if (updated.count !== 1) return null;

    return await publishFailedAutomationRunTx({
        tx: params.tx,
        accountId: params.accountId,
        runId: params.runId,
        previousState: params.state,
        now: params.now,
        expectedTriggerKind: params.expectedTriggerKind,
        enqueueFollowUp: false,
    });
}

async function failAutomationRunInternal(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    errorCode?: string | null;
    /** V3 Account-mode-correct private failure detail. */
    errorDetailEnvelope?: string | null;
    /** Released-V2 raw error detail retained only by the predecessor adapter. */
    errorMessage?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const now = new Date();
        const previousRun = await tx.automationRun.findFirst({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                attempt: params.attempt,
                state: { in: ["claimed", "running"] },
                leaseExpiresAt: { gt: now },
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            select: {
                automationId: true,
                state: true,
                originKind: true,
                executionInputEnvelope: true,
                producedSessionId: true,
                revision: true,
            },
        });
        if (!previousRun) {
            // Cancellation may race a completed canonical Session create. The
            // incumbent fail/cancel owner retains only that known new-Session
            // identity; it never changes the cancelled terminality or creates a
            // second receipt/settlement path.
            const cancelledRun = await tx.automationRun.findFirst({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.machineId,
                    attempt: params.attempt,
                    state: "cancelled",
                    ...(params.expectedTriggerKind
                        ? { automation: { triggerKind: params.expectedTriggerKind } }
                        : {}),
                },
                select: {
                    automationId: true,
                    state: true,
                    originKind: true,
                    executionInputEnvelope: true,
                    producedSessionId: true,
                    revision: true,
                },
            });
            if (!cancelledRun) return null;
            if (!await hasCompatibleAutomationAccountEncryptionTx({
                tx,
                accountId: params.accountId,
                expected: params.accountCurrentness,
            })) {
                return null;
            }
            if (
                params.requireV2RunRepresentability
                && (
                    !cancelledRun.executionInputEnvelope
                    || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                        raw: cancelledRun.executionInputEnvelope,
                        mode: accountFence.account.currentness.encryptionMode,
                        originKind: cancelledRun.originKind,
                    })?.kind !== "available"
                )
            ) return null;
            const producedSessionId = await resolveProducedSessionIdForRunTx({
                tx,
                accountId: params.accountId,
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
                        expectedTriggerKind: params.expectedTriggerKind,
                    })
                    : null;
            }
            const retained = await tx.automationRun.updateMany({
                where: {
                    id: params.runId,
                    accountId: params.accountId,
                    claimedByMachineId: params.machineId,
                    attempt: params.attempt,
                    state: "cancelled",
                    revision: cancelledRun.revision,
                    executionInputEnvelope: cancelledRun.executionInputEnvelope,
                    producedSessionId: null,
                    ...(params.expectedTriggerKind
                        ? { automation: { triggerKind: params.expectedTriggerKind } }
                        : {}),
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
                expectedTriggerKind: params.expectedTriggerKind,
            });
            if (!run || run.state !== "cancelled") return null;
            const cursor = await markRunAutomationChanged({
                tx,
                accountId: params.accountId,
                automationId: run.automationId,
            });
            afterTx(tx, () => {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: run as AutomationRunItem,
                    previousState: "cancelled",
                    cursor,
                });
            });
            return run as AutomationRunItem;
        }
        if (!await hasExpectedAutomationAccountCurrentnessTx({
            tx,
            accountId: params.accountId,
            expected: params.accountCurrentness,
        })) {
            return null;
        }
        if (
            params.requireV2RunRepresentability
            && (
                !previousRun.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: previousRun.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    originKind: previousRun.originKind,
                })?.kind !== "available"
            )
        ) return null;
        const errorMessage = params.requireV2RunRepresentability
            ? sanitizeAutomationErrorMessage(params.errorMessage)
            : params.errorDetailEnvelope ?? null;
        if (!params.requireV2RunRepresentability) {
            assertAutomationRunFailureDetailEnvelopeOuterForMode({
                raw: errorMessage,
                mode: accountFence.account.currentness.encryptionMode,
            });
        }
        const retainedStrictSessionId = deriveStrictNewSessionCreationTag({
            automationId: previousRun.automationId,
            runId: params.runId,
            executionInputEnvelope: previousRun.executionInputEnvelope,
        }) !== null
            ? previousRun.producedSessionId
            : null;
        const producedSessionId = await resolveProducedSessionIdForRunTx({
            tx,
            accountId: params.accountId,
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
                attempt: params.attempt,
                state: previousRun.state,
                revision: previousRun.revision,
                ...(params.requireV2RunRepresentability
                    ? {
                        executionInputEnvelope: previousRun.executionInputEnvelope,
                        originKind: previousRun.originKind,
                    }
                    : {}),
                leaseExpiresAt: { gt: now },
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            data: {
                state: "failed",
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
        return await publishFailedAutomationRunTx({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            previousState: previousRun.state,
            now,
            expectedTriggerKind: params.expectedTriggerKind,
            machineId: params.machineId,
        });
    });
}

export async function failAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    /** S: must equal the witness returned by the successful start. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    errorCode?: string | null;
    errorDetailEnvelope?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    return await failAutomationRunInternal(params);
}

/** Strict released-V2 adapter. Current V3 workers must call failAutomationRun. */
export async function failAutomationRunFromV2(params: {
    accountId: string;
    runId: string;
    machineId: string;
    attempt: number;
    producedSessionId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    expectedTriggerKind?: AutomationTriggerKind;
}): Promise<AutomationRunItem | null> {
    return await failAutomationRunInternal({
        ...params,
        requireV2RunRepresentability: true,
    });
}

export async function cancelAutomationRun(params: {
    accountId: string;
    runId: string;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2RunRepresentability?: boolean;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (accountFence.status !== "ready") return null;
        const now = new Date();
        const previousRun = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            expectedTriggerKind: params.expectedTriggerKind,
        });
        if (
            !previousRun
            || (previousRun.state !== "queued" && previousRun.state !== "claimed" && previousRun.state !== "running")
        ) {
            return null;
        }
        if (
            params.requireV2RunRepresentability
            && (
                !previousRun.executionInputEnvelope
                || validateRetainedAutomationRunExecutionInputV2OuterForMode({
                    raw: previousRun.executionInputEnvelope,
                    mode: accountFence.account.currentness.encryptionMode,
                    originKind: previousRun.originKind,
                })?.kind !== "available"
            )
        ) return null;
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                state: previousRun.state,
                ...(params.requireV2RunRepresentability
                    ? {
                        executionInputEnvelope: previousRun.executionInputEnvelope,
                        originKind: previousRun.originKind,
                    }
                    : {}),
                ...(params.expectedTriggerKind
                    ? { automation: { triggerKind: params.expectedTriggerKind } }
                    : {}),
            },
            data: {
                state: "cancelled",
                finishedAt: now,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        await blockAwaitingReplyHandoffForTerminalRunTx({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            state: "cancelled",
            now,
        });

        const run = await fetchRunForAccount({
            tx,
            accountId: params.accountId,
            runId: params.runId,
            expectedTriggerKind: params.expectedTriggerKind,
        });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_cancelled",
            now,
        });

        const nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });

        afterTx(tx, () => {
            emitAutomationRunTransition({
                accountId: params.accountId,
                run: run as AutomationRunItem,
                previousState: previousRun.state,
                cursor,
            });
            if (nextRun) {
                emitAutomationRunTransition({
                    accountId: params.accountId,
                    run: nextRun as AutomationRunItem,
                    previousState: null,
                    cursor,
                });
            }
        });

        return run as AutomationRunItem;
    });
}

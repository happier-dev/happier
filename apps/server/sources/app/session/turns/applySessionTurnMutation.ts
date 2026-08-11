import {
    isExactSessionTurnEndMutationV1,
    SessionTurnMutationActionV1Schema,
    SessionTurnMutationDecisionV1Schema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
    type SessionTurnMutationDecisionV1,
    type SessionTurnMutationReceiptV1,
    type SessionTurnMutationV1,
    type SessionTurnRollbackStateV1,
    type SessionTurnTranscriptAnchorsV1,
    type SessionTurnV1,
} from "@happier-dev/protocol";

import { materializePrimaryTurnProjection, type PrimaryTurnMaterializedProjection } from "./materializePrimaryTurnProjection";

export type SessionTurnNoOpReason = Exclude<SessionTurnMutationDecisionV1, "applied">;

export type SessionTurnApplyDecision =
    | {
        apply: true;
        turns: readonly SessionTurnV1[];
        changedTurn: SessionTurnV1;
        latestTurnId: string | null;
        materialized: PrimaryTurnMaterializedProjection;
        receipt: SessionTurnMutationReceiptV1;
      }
    | {
        apply: false;
        reason: SessionTurnNoOpReason;
        turns: readonly SessionTurnV1[];
        latestTurnId: string | null;
        materialized: PrimaryTurnMaterializedProjection;
        receipt: SessionTurnMutationReceiptV1;
      };

function isTerminalStatus(status: PrimaryTurnStatusV1): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

function readFailedTurnObservedAt(turn: SessionTurnV1): number {
    return Math.max(turn.terminalAt ?? turn.updatedAt, turn.lastRuntimeIssue?.occurredAt ?? 0);
}

function doesProviderContextMatchFailedTurn(
    turn: SessionTurnV1,
    mutation: SessionTurnMutationV1,
): boolean {
    const mutationProviderTurnId = mutation.providerTurnId?.trim();
    if (!mutationProviderTurnId) return false;

    const providerTurnIds = new Set([
        turn.providerTurnId,
        turn.lastRuntimeIssue?.providerTurnId,
    ].flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []));
    if (!providerTurnIds.has(mutationProviderTurnId)) return false;

    const providers = new Set([
        turn.provider,
        turn.lastRuntimeIssue?.provider,
    ].flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []));
    const mutationProvider = mutation.provider?.trim();
    return providers.size === 0 || (typeof mutationProvider === "string" && providers.has(mutationProvider));
}

function isNewerMatchingRecoveryLifecycleEvidence(params: Readonly<{
    turn: SessionTurnV1;
    mutation: SessionTurnMutationV1;
    terminalStatus: PrimaryTurnStatusV1 | null;
}>): boolean {
    if (params.turn.status !== "failed") return false;
    if (params.mutation.action !== "begin" && params.terminalStatus !== "completed") return false;
    if (params.mutation.observedAt <= readFailedTurnObservedAt(params.turn)) return false;
    return doesProviderContextMatchFailedTurn(params.turn, params.mutation);
}

function resolveTerminalStatus(action: SessionTurnMutationV1["action"]): PrimaryTurnStatusV1 | null {
    if (action === "complete") return "completed";
    if (action === "fail") return "failed";
    if (action === "cancel" || action === "end_session") return "cancelled";
    return null;
}

function resolveLifecycleStatus(action: SessionTurnMutationV1["action"]): PrimaryTurnStatusV1 | null {
    if (action === "begin") return "in_progress";
    return resolveTerminalStatus(action);
}

function cloneAnchors(anchors: SessionTurnTranscriptAnchorsV1 | undefined): SessionTurnTranscriptAnchorsV1 | undefined {
    if (!anchors) return undefined;
    return {
        ...anchors,
        ...(anchors.userMessageSeqs ? { userMessageSeqs: [...anchors.userMessageSeqs] } : {}),
    };
}

function cloneTurn(turn: SessionTurnV1): SessionTurnV1 {
    return {
        ...turn,
        ...(turn.transcriptAnchors ? { transcriptAnchors: cloneAnchors(turn.transcriptAnchors) } : {}),
        ...(turn.rollback ? { rollback: { ...turn.rollback } } : {}),
    };
}

function parseRollbackState(action: SessionTurnMutationV1["action"]): SessionTurnRollbackStateV1 | null {
    if (action === "mark_rollback_eligible") return "eligible";
    if (action === "mark_rolled_back") return "rolled_back";
    return null;
}

function isFiniteSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function hasTrustedRollbackAnchors(anchors: SessionTurnTranscriptAnchorsV1 | undefined): boolean {
    return isFiniteSeq(anchors?.startUserMessageSeq) && isFiniteSeq(anchors?.endSeqInclusive);
}

function mergeTranscriptAnchors(
    existing: SessionTurnTranscriptAnchorsV1 | undefined,
    incoming: SessionTurnTranscriptAnchorsV1 | undefined,
): SessionTurnTranscriptAnchorsV1 | undefined {
    if (!incoming) return existing ? cloneAnchors(existing) : undefined;
    const userMessageSeqs = [...(existing?.userMessageSeqs ?? []), ...(incoming.userMessageSeqs ?? [])];
    return {
        ...(existing ?? {}),
        ...incoming,
        ...(userMessageSeqs.length > 0
            ? { userMessageSeqs: [...new Set(userMessageSeqs)].sort((a, b) => a - b) }
            : {}),
    };
}

function readMutationTranscriptAnchors(mutation: SessionTurnMutationV1): SessionTurnTranscriptAnchorsV1 | undefined {
    if (
        mutation.action === "begin"
        || mutation.action === "append_transcript_anchors"
        || mutation.action === "mark_rollback_eligible"
    ) {
        return mutation.transcriptAnchors;
    }
    return undefined;
}

function readRollbackMutationMetadata(mutation: SessionTurnMutationV1): Readonly<{
    reason?: string;
    providerRollbackOrdinal?: number;
}> {
    if (mutation.action !== "mark_rollback_eligible" && mutation.action !== "mark_rolled_back") {
        return {};
    }
    return {
        ...(mutation.reason ? { reason: mutation.reason } : {}),
        ...(typeof mutation.providerRollbackOrdinal === "number"
            ? { providerRollbackOrdinal: mutation.providerRollbackOrdinal }
            : {}),
    };
}

function makeReceipt(params: Readonly<{
    mutation: SessionTurnMutationV1;
    decision: SessionTurnMutationDecisionV1;
    turnId?: string;
    appliedAt: number;
}>): SessionTurnMutationReceiptV1 {
    return {
        v: 1,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        action: params.mutation.action,
        decision: params.decision,
        observedAt: params.mutation.observedAt,
        appliedAt: params.appliedAt,
    };
}

function makeNoOp(params: Readonly<{
    reason: SessionTurnNoOpReason;
    latestTurnId: string | null;
    mutation: SessionTurnMutationV1;
    turns: readonly SessionTurnV1[];
    appliedAt: number;
    turnId?: string;
}>): SessionTurnApplyDecision {
    return {
        apply: false,
        reason: params.reason,
        turns: params.turns,
        latestTurnId: params.latestTurnId,
        materialized: materializePrimaryTurnProjection({
            latestTurnId: params.latestTurnId,
            turns: params.turns,
        }),
        receipt: makeReceipt({
            mutation: params.mutation,
            decision: params.reason,
            turnId: params.turnId,
            appliedAt: params.appliedAt,
        }),
    };
}

function shouldMoveLatestTurnPointer(action: SessionTurnMutationV1["action"]): boolean {
    return action === "begin" || action === "touch_active" || action === "complete" || action === "fail" || action === "cancel";
}

function replaceTurn(turns: readonly SessionTurnV1[], nextTurn: SessionTurnV1): readonly SessionTurnV1[] {
    const existingIndex = turns.findIndex((turn) => turn.turnId === nextTurn.turnId);
    if (existingIndex < 0) return [...turns.map(cloneTurn), nextTurn];
    return turns.map((turn, index) => index === existingIndex ? nextTurn : cloneTurn(turn));
}

export function applySessionTurnMutationToTurns(params: Readonly<{
    currentLatestTurnId: string | null;
    mutation: SessionTurnMutationV1;
    turns: readonly SessionTurnV1[];
    appliedAt: number;
}>): SessionTurnApplyDecision {
    const { mutation } = params;
    const turns = params.turns.map(cloneTurn);
    const requestedTurnId = mutation.turnId ?? params.currentLatestTurnId ?? undefined;
    const existingTurn = requestedTurnId
        ? turns.find((turn) => turn.turnId === requestedTurnId) ?? null
        : null;
    const isExactSessionEnd = isExactSessionTurnEndMutationV1(mutation);

    if (isExactSessionEnd) {
        if (!existingTurn) {
            return makeNoOp({
                reason: "missing-turn",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: requestedTurnId,
            });
        }
        if (isTerminalStatus(existingTurn.status)) {
            return makeNoOp({
                reason: "duplicate-terminal",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: existingTurn.turnId,
            });
        }
        if (existingTurn.status !== "in_progress" || existingTurn.startedAt > mutation.observedAt) {
            return makeNoOp({
                reason: "stale-terminal",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: existingTurn.turnId,
            });
        }
    } else if (mutation.action === "end_session") {
        // A session-end settlement only cancels a turn that was already open when the end was
        // observed. A NEWER turn (begun after the observed end, e.g. by a replacement runner
        // while a daemon-observed exit settlement was still queued) must not be cancelled by a
        // stale settlement.
        if (
            !existingTurn
            || existingTurn.status !== "in_progress"
            || existingTurn.startedAt > mutation.observedAt
        ) {
            return makeNoOp({
                reason: "stale-terminal",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: requestedTurnId,
            });
        }
    } else if (!requestedTurnId) {
        return makeNoOp({
            reason: "missing-turn",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
        });
    }

    const terminalStatus = resolveTerminalStatus(mutation.action);
    const isRecoveryLifecycleEvidence = existingTurn
        ? isNewerMatchingRecoveryLifecycleEvidence({ turn: existingTurn, mutation, terminalStatus })
        : false;

    if (existingTurn && isTerminalStatus(existingTurn.status) && mutation.action === "begin" && !isRecoveryLifecycleEvidence) {
        return makeNoOp({
            reason: "stale-in-progress",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId: existingTurn.turnId,
        });
    }

    if (terminalStatus && !existingTurn) {
        return makeNoOp({
            reason: "missing-turn",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId: requestedTurnId,
        });
    }

    if (
        terminalStatus
        && existingTurn
        && existingTurn.status !== "in_progress"
        && !isRecoveryLifecycleEvidence
    ) {
        return makeNoOp({
            reason: existingTurn.status === terminalStatus ? "duplicate-terminal" : "stale-terminal",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId: existingTurn.turnId,
        });
    }

    if (
        terminalStatus
        && requestedTurnId
        && params.currentLatestTurnId
        && requestedTurnId !== params.currentLatestTurnId
        && !isExactSessionEnd
    ) {
        const latestTurn = turns.find((turn) => turn.turnId === params.currentLatestTurnId) ?? null;
        if (latestTurn?.status === "in_progress") {
            return makeNoOp({
                reason: "stale-terminal",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: requestedTurnId,
            });
        }
    }

    const lifecycleStatus = resolveLifecycleStatus(mutation.action);
    const rollbackState = parseRollbackState(mutation.action);
    if ((mutation.action === "mark_rollback_eligible" || mutation.action === "mark_rolled_back") && (!existingTurn || existingTurn.status !== "completed")) {
        return makeNoOp({
            reason: "stale-terminal",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId: requestedTurnId,
        });
    }

    if (mutation.action === "touch_active") {
        if (!existingTurn) {
            return makeNoOp({
                reason: "missing-turn",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: requestedTurnId,
            });
        }
        if (existingTurn.status !== "in_progress") {
            return makeNoOp({
                reason: "stale-terminal",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: existingTurn.turnId,
            });
        }
        if (params.currentLatestTurnId && existingTurn.turnId !== params.currentLatestTurnId) {
            return makeNoOp({
                reason: "stale-in-progress",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: existingTurn.turnId,
            });
        }
        if (mutation.observedAt <= existingTurn.updatedAt) {
            return makeNoOp({
                reason: "stale-in-progress",
                latestTurnId: params.currentLatestTurnId,
                mutation,
                turns,
                appliedAt: params.appliedAt,
                turnId: existingTurn.turnId,
            });
        }
    }

    if ((mutation.action === "attach_provider_turn_id" || mutation.action === "append_transcript_anchors") && !existingTurn) {
        return makeNoOp({
            reason: "missing-turn",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId: requestedTurnId,
        });
    }

    const turnId = requestedTurnId ?? existingTurn?.turnId;
    if (!turnId) {
        return makeNoOp({
            reason: "missing-turn",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
        });
    }

    const baseTurn: SessionTurnV1 = existingTurn ?? {
        turnId,
        status: lifecycleStatus ?? "in_progress",
        startedAt: mutation.observedAt,
        updatedAt: mutation.observedAt,
    };
    const transcriptAnchors = mergeTranscriptAnchors(baseTurn.transcriptAnchors, readMutationTranscriptAnchors(mutation));
    if (mutation.action === "mark_rollback_eligible" && !hasTrustedRollbackAnchors(transcriptAnchors)) {
        return makeNoOp({
            reason: "stale-terminal",
            latestTurnId: params.currentLatestTurnId,
            mutation,
            turns,
            appliedAt: params.appliedAt,
            turnId,
        });
    }

    const rollbackMetadata = readRollbackMutationMetadata(mutation);
    let nextTurn: SessionTurnV1 = {
        ...baseTurn,
        ...(isRecoveryLifecycleEvidence && mutation.action === "begin" ? { startedAt: mutation.observedAt } : {}),
        ...(!isExactSessionEnd && mutation.provider ? { provider: mutation.provider } : {}),
        ...(!isExactSessionEnd && mutation.providerTurnId ? { providerTurnId: mutation.providerTurnId } : {}),
        ...(lifecycleStatus ? { status: lifecycleStatus } : {}),
        ...(terminalStatus ? { terminalAt: mutation.observedAt } : {}),
        ...(mutation.action === "fail" ? { lastRuntimeIssue: mutation.issue } : {}),
        ...(isRecoveryLifecycleEvidence || mutation.action === "complete" || mutation.action === "cancel" || mutation.action === "end_session"
            ? { lastRuntimeIssue: null }
            : {}),
        ...(transcriptAnchors ? { transcriptAnchors } : {}),
        ...(rollbackState
            ? {
                rollback: {
                    ...(baseTurn.rollback ?? {}),
                    state: rollbackState,
                    ...(rollbackMetadata.reason ? { reason: rollbackMetadata.reason } : {}),
                    ...(typeof rollbackMetadata.providerRollbackOrdinal === "number"
                        ? { providerRollbackOrdinal: rollbackMetadata.providerRollbackOrdinal }
                        : {}),
                    updatedAt: mutation.observedAt,
                },
            }
            : {}),
        updatedAt: mutation.observedAt,
        lastMutationId: mutation.mutationId,
    };
    if (isRecoveryLifecycleEvidence && mutation.action === "begin") {
        const { terminalAt: _terminalAt, ...reopenedTurn } = nextTurn;
        nextTurn = reopenedTurn;
    }

    const latestTurnId = shouldMoveLatestTurnPointer(mutation.action)
        ? turnId
        : params.currentLatestTurnId ?? turnId;
    const nextTurns = replaceTurn(turns, nextTurn);
    const materialized = materializePrimaryTurnProjection({
        latestTurnId,
        turns: nextTurns,
    });

    return {
        apply: true,
        turns: nextTurns,
        changedTurn: nextTurn,
        latestTurnId,
        materialized,
        receipt: makeReceipt({
            mutation,
            decision: "applied",
            turnId,
            appliedAt: params.appliedAt,
        }),
    };
}

export function parseSessionTurnMutationDecision(value: string): SessionTurnMutationDecisionV1 | null {
    const parsed = SessionTurnMutationDecisionV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function parseSessionTurnMutationAction(value: string): SessionTurnMutationV1["action"] | null {
    const parsed = SessionTurnMutationActionV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

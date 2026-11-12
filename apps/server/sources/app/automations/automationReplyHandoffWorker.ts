import { AutomationReplyHandoffDispatchRequestV1Schema, AutomationReplyHandoffDispatchResultV1Schema, type AutomationReplyHandoffDispatchResultV1 } from '@happier-dev/protocol/automations/event';
import { warn } from "@/utils/logging/log";
import { withWebLatencyProducerTrace } from "@/utils/webLatencyTrace";
import { armDeadlineTimer } from "@happier-dev/protocol/common/deadlineTimer";
import { subscribeAutomationReplyHandoffWake } from "./automationScheduleWake";

import {
    claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt,
    settleAutomationReplyHandoff,
} from "./automationReplyHandoffService";

/** Retain the existing database-failure recovery cadence; healthy idle has no timer. */
const AUTOMATION_REPLY_HANDOFF_DATABASE_RECOVERY_MS = 10_000;

export type AutomationReplyHandoffDispatcher = (
    request: unknown,
) => Promise<AutomationReplyHandoffDispatchResultV1>;

export type AutomationReplyHandoffWorkerPassResult = Readonly<{
    claimed: boolean;
    settled: boolean;
    nextDueAt: Date | null;
}>;

function warnWorkerFailure(operation: "due-scan" | "pass"): void {
    // Keep worker diagnostics bounded and privacy-safe: operation is a fixed
    // cardinality label and no stored envelopes or raw error details are logged.
    warn(
        {
            module: "automation-reply-handoff-worker",
            operation,
        },
        operation === "due-scan"
            ? "Automation reply handoff worker due scan failed"
            : "Automation reply handoff worker pass failed",
    );
}

function parseStoredEnvelope(raw: string): unknown | undefined {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function buildDispatchRequest(claim: Awaited<ReturnType<typeof claimNextAutomationReplyHandoff>>) {
    if (!claim) return null;
    const resultEnvelope = parseStoredEnvelope(claim.resultEnvelope);
    const replyContextEnvelope = parseStoredEnvelope(claim.replyContextEnvelope);
    if (resultEnvelope === undefined || replyContextEnvelope === undefined) return null;

    const request = AutomationReplyHandoffDispatchRequestV1Schema.safeParse({
        v: 1,
        kind: "automation.replyHandoff.dispatch",
        target: {
            accountId: claim.accountId,
            machineId: claim.target.machineId,
            machineInstallationId: claim.target.machineInstallationId,
            materializationId: claim.target.materializationId,
            actionRef: {
                pluginId: claim.target.actionPluginId,
                localId: claim.target.actionLocalId,
            },
        },
        handoff: {
            handoffId: claim.handoffId,
            runId: claim.runId,
            automationId: claim.automationId,
            occurrenceKey: claim.occurrenceKey,
            cause: claim.cause,
            accountCurrentness: claim.accountCurrentness,
            recipeKind: claim.recipeKind,
            resultEnvelope,
            replyContextEnvelope,
        },
    });
    return request.success ? request.data : null;
}

function isRetryableUnavailable(
    code: Extract<AutomationReplyHandoffDispatchResultV1, { kind: "unavailable" }>["code"],
): boolean {
    return code === "targetUnavailable"
        || code === "actionExecutionFailed"
        || code === "cancelled";
}

/**
 * Executes one durable handoff lease. Socket RPC is the only mocked boundary:
 * the Run claim and settlement remain real database transitions below it.
 */
export async function runAutomationReplyHandoffWorkerPass(params: Readonly<{
    now: () => Date;
    dispatch: AutomationReplyHandoffDispatcher;
    dueThrough?: Date;
}>): Promise<AutomationReplyHandoffWorkerPassResult> {
    const claimNow = params.now();
    const claim = await claimNextAutomationReplyHandoff({ now: claimNow,
        dueThrough: params.dueThrough });
    if (!claim) {
        return { claimed: false, settled: false, nextDueAt: await findNextAutomationReplyHandoffDueAt() };
    }

    const request = buildDispatchRequest(claim);
    if (!request) {
        const settlement = await settleAutomationReplyHandoff({
            claim,
            now: params.now(),
            outcome: { kind: "blocked" },
        });
        return { claimed: true, settled: settlement.applied, nextDueAt: await findNextAutomationReplyHandoffDueAt() };
    }

    let rawResult: unknown;
    try {
        rawResult = await params.dispatch(request);
    } catch {
        rawResult = { kind: "unavailable", code: "targetUnavailable" };
    }
    const result = AutomationReplyHandoffDispatchResultV1Schema.safeParse(rawResult);
    if (!result.success) {
        // The daemon may have committed custody before returning a malformed
        // or truncated response. Rejoin the same handoff id instead of
        // terminalizing an outcome whose effect truth is ambiguous.
        const settlement = await settleAutomationReplyHandoff({
            claim,
            now: params.now(),
            outcome: { kind: "retry" },
        });
        return { claimed: true, settled: settlement.applied, nextDueAt: await findNextAutomationReplyHandoffDueAt() };
    }

    const settlement = result.data.kind === "unavailable"
        ? await settleAutomationReplyHandoff({
            claim,
            now: params.now(),
            outcome: result.data.code === "contractInvalid"
                ? { kind: "retry" }
                : isRetryableUnavailable(result.data.code)
                    // Rejoin the same custody; the settlement owner retains
                    // its existing lease boundary without a guessed cadence.
                    ? { kind: "retry" }
                    : { kind: "blocked" },
        })
        : await settleAutomationReplyHandoff({
            claim,
            now: params.now(),
            outcome: result.data.settlement,
            accountCurrentness: result.data.accountCurrentness,
        });
    return { claimed: true, settled: settlement.applied, nextDueAt: await findNextAutomationReplyHandoffDueAt() };
}

/**
 * The timer is only an indexed durable-row wake. It owns no handoff state and
 * uses the database lease to coordinate concurrent API replicas and restart.
 */
export function startAutomationReplyHandoffWorker(params: Readonly<{
    dispatch: AutomationReplyHandoffDispatcher;
}>): Readonly<{ stop: () => Promise<void> }> {
    let stopped = false;
    let cancelTimer: (() => void) | null = null;
    let active: Promise<void> | null = null;
    let wakePending = false;

    const schedule = async (knownNextDueAt?: Date | null, failed = false): Promise<void> => {
        if (stopped) return;
        let nextDueAt: Date | null = knownNextDueAt ?? null;
        try {
            if (!failed && knownNextDueAt === undefined) {
                nextDueAt = await findNextAutomationReplyHandoffDueAt();
            }
        } catch {
            warnWorkerFailure("due-scan");
            failed = true;
        }
        if (stopped) return;
        const deadline = failed ? Date.now() + AUTOMATION_REPLY_HANDOFF_DATABASE_RECOVERY_MS : nextDueAt?.getTime();
        if (deadline === undefined) return;
        cancelTimer = armDeadlineTimer(deadline, () => {
            cancelTimer = null;
            void trigger();
        }, { unref: true });
    };

    const trigger = async (): Promise<void> => {
        if (stopped) return;
        if (active) { wakePending = true; return; }
        cancelTimer?.();
        cancelTimer = null;
        active = withWebLatencyProducerTrace('producer.automation-reply-handoff', async () => {
            let knownNextDueAt: Date | null | undefined;
            let failed = false;
            try {
                if (!stopped) {
                    // A traversal visits the work due when demand arrived.
                    // Claims use the actual clock and move retry deadlines
                    // beyond this traversal, even if a slow RPC returns after
                    // its lease expired. No retained attempted-ID registry.
                    const dueThrough = new Date();
                    const nextDueAt = await findNextAutomationReplyHandoffDueAt();
                    if (nextDueAt === null || nextDueAt.getTime() > dueThrough.getTime()) {
                        knownNextDueAt = nextDueAt;
                        return;
                    }
                    while (!stopped) {
                        const pass = await runAutomationReplyHandoffWorkerPass({
                            now: () => new Date(), dispatch: params.dispatch,
                            dueThrough,
                        });
                        if (!pass.claimed) break;
                    }
                }
            } catch {
                failed = true;
                warnWorkerFailure("pass");
                // The durable claim remains recoverable when dispatch or DB work fails.
            } finally {
                await schedule(knownNextDueAt, failed);
            }
        });
        try {
            await active;
        } finally {
            active = null;
            if (wakePending && !stopped) { wakePending = false; void trigger(); }
        }
    };

    const unsubscribeWake = subscribeAutomationReplyHandoffWake(() => { void trigger(); });
    void trigger();
    return {
        stop: async () => {
            if (stopped) return;
            stopped = true;
            unsubscribeWake();
            cancelTimer?.();
            cancelTimer = null;
            await active;
        },
    };
}

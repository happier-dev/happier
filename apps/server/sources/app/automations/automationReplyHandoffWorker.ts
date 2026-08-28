import {
    AutomationReplyHandoffDispatchRequestV1Schema,
    AutomationReplyHandoffDispatchResultV1Schema,
    type AutomationReplyHandoffDispatchResultV1,
} from "@happier-dev/protocol";
import { warn } from "@/utils/logging/log";

import {
    claimNextAutomationReplyHandoff,
    DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
    findNextAutomationReplyHandoffDueAt,
    settleAutomationReplyHandoff,
} from "./automationReplyHandoffService";

/** Socket disconnect/restart retry; bounded like the daemon-side result contract. */
/** A durable indexed scan covers rows committed by another API replica. */
export const DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS = 10_000;

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
        || code === "contractInvalid"
        || code === "cancelled";
}

async function readNextDueAt(now: Date): Promise<Date | null> {
    return await findNextAutomationReplyHandoffDueAt({ now });
}

/**
 * Executes one durable handoff lease. Socket RPC is the only mocked boundary:
 * the Run claim and settlement remain real database transitions below it.
 */
export async function runAutomationReplyHandoffWorkerPass(params: Readonly<{
    now: Date;
    dispatch: AutomationReplyHandoffDispatcher;
}>): Promise<AutomationReplyHandoffWorkerPassResult> {
    const claim = await claimNextAutomationReplyHandoff({ now: params.now });
    if (!claim) {
        return { claimed: false, settled: false, nextDueAt: await readNextDueAt(params.now) };
    }

    const request = buildDispatchRequest(claim);
    if (!request) {
        const settlement = await settleAutomationReplyHandoff({
            claim,
            now: params.now,
            outcome: { kind: "blocked" },
        });
        return { claimed: true, settled: settlement.applied, nextDueAt: await readNextDueAt(params.now) };
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
            now: params.now,
            outcome: {
                kind: "retry",
                retryAfterMs: DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS,
            },
        });
        return { claimed: true, settled: settlement.applied, nextDueAt: await readNextDueAt(params.now) };
    }

    const settlement = result.data.kind === "unavailable"
        ? await settleAutomationReplyHandoff({
            claim,
            now: params.now,
            outcome: isRetryableUnavailable(result.data.code)
                ? { kind: "retry", retryAfterMs: DEFAULT_AUTOMATION_REPLY_HANDOFF_RETRY_AFTER_MS }
                : { kind: "blocked" },
        })
        : await settleAutomationReplyHandoff({
            claim,
            now: params.now,
            outcome: result.data.settlement,
            accountCurrentness: result.data.accountCurrentness,
            ...(result.data.receiptEnvelope === undefined
                ? {}
                : { receiptEnvelope: result.data.receiptEnvelope }),
        });
    return { claimed: true, settled: settlement.applied, nextDueAt: await readNextDueAt(params.now) };
}

/**
 * The timer is only an indexed durable-row wake. It owns no handoff state and
 * uses the database lease to coordinate concurrent API replicas and restart.
 */
export function startAutomationReplyHandoffWorker(params: Readonly<{
    dispatch: AutomationReplyHandoffDispatcher;
    idlePollMs?: number;
}>): Readonly<{ stop: () => Promise<void> }> {
    const idlePollMs = Number.isSafeInteger(params.idlePollMs) && params.idlePollMs! > 0
        ? params.idlePollMs!
        : DEFAULT_AUTOMATION_REPLY_HANDOFF_IDLE_POLL_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: Promise<void> | null = null;

    const schedule = async (): Promise<void> => {
        if (stopped) return;
        const now = new Date();
        let nextDueAt: Date | null = null;
        try {
            nextDueAt = await readNextDueAt(now);
        } catch {
            warnWorkerFailure("due-scan");
            // A future indexed scan recovers a transient database failure.
        }
        if (stopped) return;
        const dueDelay = nextDueAt === null
            ? idlePollMs
            : Math.max(0, nextDueAt.getTime() - now.getTime());
        timer = setTimeout(() => {
            timer = null;
            void trigger();
        }, dueDelay);
        timer.unref?.();
    };

    const trigger = async (): Promise<void> => {
        if (stopped || active) return;
        active = (async () => {
            try {
                await runAutomationReplyHandoffWorkerPass({
                    now: new Date(),
                    dispatch: params.dispatch,
                });
            } catch {
                warnWorkerFailure("pass");
                // The durable claim remains recoverable when dispatch or DB work fails.
            } finally {
                active = null;
                await schedule();
            }
        })();
        await active;
    };

    void trigger();
    return {
        stop: async () => {
            if (stopped) return;
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            await active;
        },
    };
}

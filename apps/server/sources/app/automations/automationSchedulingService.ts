import {
    isTerminalAutomationRunState,
    type AutomationRunState,
    type AutomationScheduleKind,
} from "./automationTypes";
import { CronExpressionParser } from "cron-parser";

/**
 * Retained scheduling-facing alias for the server-domain terminality owner.
 */
export function isFinalAutomationRunStatus(state: AutomationRunState): boolean {
    return isTerminalAutomationRunState(state);
}

export function computeNextDueAtForAutomation(params: {
    now: Date;
    scheduleKind: AutomationScheduleKind;
    everyMs: number | null;
    scheduleExpr: string | null;
    timezone?: string | null;
}): Date | null {
    if (params.scheduleKind === "interval") {
        if (typeof params.everyMs !== "number" || !Number.isFinite(params.everyMs) || params.everyMs <= 0) {
            return null;
        }
        return new Date(params.now.getTime() + Math.floor(params.everyMs));
    }

    const expr = typeof params.scheduleExpr === "string" ? params.scheduleExpr.trim() : "";
    if (!expr) return null;

    try {
        const cron = CronExpressionParser.parse(expr, {
            currentDate: params.now,
            tz: typeof params.timezone === "string" && params.timezone.trim().length > 0
                ? params.timezone.trim()
                : "UTC",
        });
        return cron.next().toDate();
    } catch {
        return null;
    }
}

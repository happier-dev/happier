import * as Sentry from "@sentry/node";

import { parseOptionalBooleanEnv } from "@/config/env";

function isMonitorsEnabled(env: NodeJS.ProcessEnv): boolean {
    return parseOptionalBooleanEnv(env.SENTRY_MONITORS_ENABLED ?? env.HAPPIER_SENTRY_MONITORS_ENABLED) ?? false;
}

function intervalScheduleFromMs(intervalMs: number): { type: "interval"; value: number; unit: "minute" } {
    const minutes = Math.max(1, Math.ceil(intervalMs / 60_000));
    return { type: "interval", value: minutes, unit: "minute" };
}

export function maybeCaptureSentryMonitorCheckIn(params: {
    env: NodeJS.ProcessEnv;
    monitorSlug: string;
    intervalMs?: number;
    run: () => Promise<void>;
}): Promise<void> {
    if (!isMonitorsEnabled(params.env)) {
        return params.run();
    }
    if (!Sentry.getClient()) {
        return params.run();
    }

    const startedAt = Date.now();
    const monitorConfig =
        typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs) && params.intervalMs > 0
            ? { schedule: intervalScheduleFromMs(params.intervalMs), maxRuntime: Math.max(1, Math.ceil(params.intervalMs / 60_000)) }
            : undefined;

    const checkInId = Sentry.captureCheckIn({ monitorSlug: params.monitorSlug, status: "in_progress" }, monitorConfig);

    return params
        .run()
        .then(() => {
            const duration = Math.max(0, (Date.now() - startedAt) / 1000);
            Sentry.captureCheckIn({ monitorSlug: params.monitorSlug, status: "ok", checkInId, duration });
        })
        .catch((err) => {
            const duration = Math.max(0, (Date.now() - startedAt) / 1000);
            Sentry.captureCheckIn({ monitorSlug: params.monitorSlug, status: "error", checkInId, duration });
            throw err;
        });
}

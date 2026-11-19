/**
 * Day/hour/minute/second-granular reset countdown formatting.
 *
 * Single owner for the countdown algorithm previously duplicated in
 * quota presentation components.
 * Pure + formatter-injected so the domain layer stays free of `@/text`; the
 * gauge's `ConnectedServiceQuotaGaugeLabelFormatter` structurally satisfies
 * `ResetCountdownFormatter`, and UI callers build the formatter from `t(...)`.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type ResetCountdownFormatter = Readonly<{
    durationNow: () => string;
    durationOutdated: () => string;
    durationDaysHours: (params: Readonly<{ days: number; hours: number }>) => string;
    durationHoursMinutes: (params: Readonly<{ hours: number; minutes: number }>) => string;
    durationHours: (params: Readonly<{ hours: number }>) => string;
    durationMinutes: (params: Readonly<{ minutes: number }>) => string;
    durationSeconds?: (params: Readonly<{ seconds: number }>) => string;
}>;

export function formatResetCountdown(
    nowMs: number,
    resetsAtMs: number | null,
    formatter: ResetCountdownFormatter,
): string | null {
    if (!resetsAtMs) return null;
    const delta = resetsAtMs - nowMs;
    if (!Number.isFinite(delta)) return formatter.durationOutdated();
    if (delta < 0) return formatter.durationOutdated();
    if (delta === 0) return formatter.durationNow();

    if (delta < MINUTE_MS && formatter.durationSeconds) {
        return formatter.durationSeconds({ seconds: Math.ceil(delta / 1_000) });
    }
    const totalMinutes = Math.floor(delta / MINUTE_MS);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
    const minutes = totalMinutes - days * 60 * 24 - hours * 60;

    if (days > 0) return formatter.durationDaysHours({ days, hours });
    if (hours > 0) {
        return minutes > 0
            ? formatter.durationHoursMinutes({ hours, minutes })
            : formatter.durationHours({ hours });
    }
    return formatter.durationMinutes({ minutes });
}

/**
 * The countdown inside its "in …" phrase while the reset is still ahead; at or past the moment the bare
 * "now"/"Outdated" word stands alone, so a passed reset never reads "in Outdated".
 */
export function formatResetCountdownPhrase(
    nowMs: number,
    resetsAtMs: number | null,
    formatter: ResetCountdownFormatter,
    inPhrase: (countdown: string) => string,
): string | null {
    const countdown = formatResetCountdown(nowMs, resetsAtMs, formatter);
    if (countdown === null) return null;
    const ahead = resetsAtMs! - nowMs;
    return Number.isFinite(ahead) && ahead > 0 ? inPhrase(countdown) : countdown;
}

/** The next visible change for a live countdown using the seconds formatter. */
export function readResetCountdownWakeAtMs(nowMs: number, resetsAtMs: number | null): number | null {
    if (resetsAtMs === null || !Number.isFinite(resetsAtMs) || resetsAtMs < nowMs) return null;
    const remainingMs = resetsAtMs - nowMs;
    if (remainingMs === 0) return nowMs + 1;
    if (remainingMs < MINUTE_MS) return resetsAtMs - (Math.ceil(remainingMs / 1_000) - 1) * 1_000;
    const unitMs = remainingMs >= DAY_MS ? HOUR_MS : MINUTE_MS;
    return nowMs + remainingMs % unitMs + 1;
}

export type ResetCountdownDaysFormatter = Readonly<{
    now: () => string;
    inDays: (params: Readonly<{ days: number }>) => string;
}>;

/**
 * Day-granular "in Nd" variant used by the QUOTA RESETS rows. Rounds UP so a
 * reset less than a day away never reads as "in 0d".
 */
export function formatResetCountdownDays(
    nowMs: number,
    resetsAtMs: number | null,
    formatter: ResetCountdownDaysFormatter,
): string | null {
    if (!resetsAtMs) return null;
    const delta = resetsAtMs - nowMs;
    if (!Number.isFinite(delta) || delta <= 0) return formatter.now();
    const days = Math.max(1, Math.ceil(delta / DAY_MS));
    return formatter.inDays({ days });
}

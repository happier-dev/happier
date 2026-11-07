/**
 * Reset countdown formatting with optional second precision.
 *
 * Single owner for the countdown algorithm previously duplicated in
 * `connectedServiceQuotaGauge.ts` and `ConnectedServiceQuotaMeterRow.tsx`.
 * Pure + formatter-injected so the domain layer stays free of `@/text`; the
 * gauge's `ConnectedServiceQuotaGaugeLabelFormatter` structurally satisfies
 * `ResetCountdownFormatter`, and UI callers build the formatter from `t(...)`.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type ResetCountdownFormatter = Readonly<{
    durationNow: () => string;
    durationOutdated: () => string;
    durationDaysHours: (params: Readonly<{ days: number; hours: number }>) => string;
    durationHoursMinutes: (params: Readonly<{ hours: number; minutes: number }>) => string;
    durationMinutes: (params: Readonly<{ minutes: number }>) => string;
    durationHoursMinutesSeconds: (params: Readonly<{ hours: number; minutes: number; seconds: number }>) => string;
    durationMinutesSeconds: (params: Readonly<{ minutes: number; seconds: number }>) => string;
}>;

/**
 * True when a reset timestamp exists but already elapsed (or is malformed): the usage snapshot
 * predates its own reset boundary, so "resets in …" phrasing must not be composed around it
 * (observed live as the nonsense label "resets in outdated").
 */
export function isResetCountdownOutdated(nowMs: number, resetsAtMs: number | null): boolean {
    if (!resetsAtMs) return false;
    const delta = resetsAtMs - nowMs;
    return !Number.isFinite(delta) || delta < 0;
}

export function formatResetCountdown(
    nowMs: number,
    resetsAtMs: number | null,
    formatter: ResetCountdownFormatter,
    showSeconds = true,
): string | null {
    if (!resetsAtMs) return null;
    const delta = resetsAtMs - nowMs;
    if (!Number.isFinite(delta)) return formatter.durationOutdated();
    if (delta < 0) return formatter.durationOutdated();
    if (delta === 0) return formatter.durationNow();

    const days = Math.floor(delta / DAY_MS);
    const hours = Math.floor((delta % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((delta % HOUR_MS) / MINUTE_MS);
    const seconds = Math.floor((delta % MINUTE_MS) / SECOND_MS);

    if (days > 0) return formatter.durationDaysHours({ days, hours });
    if (!showSeconds) return hours > 0
        ? formatter.durationHoursMinutes({ hours, minutes })
        : formatter.durationMinutes({ minutes });
    if (hours > 0) return formatter.durationHoursMinutesSeconds({ hours, minutes, seconds });
    return formatter.durationMinutesSeconds({ minutes, seconds });
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

/**
 * Day/hour/minute-granular reset countdown formatting.
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

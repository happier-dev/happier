import { t } from '@/text';

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/**
 * The one elapsed-duration formatter for agent activity (C9).
 *
 * Four incompatible formatters render the same idea today — `formatDurationMs` in the subagent fact
 * pills, `formatDuration` in `WorkflowAgentRow`, the duration branch of `WorkflowActivityView`'s
 * footer, and `tools.common.elapsedSeconds` — so 95 seconds reads as `1m 35s`, `1m 35s`, `1m 35s`
 * and `95.0s` depending on which surface you are looking at. This replaces them; it does not join
 * them.
 *
 * Two deliberate choices:
 *
 * - **A clock face under an hour.** `m:ss` has no unit noise and, in tabular numerals, occupies the
 *   same width at `0:42` and `9:07`, so a column of rows does not shuffle sideways every second.
 *   Unit-suffixed forms (`1m 35s`) change width as they tick and cannot be right-aligned honestly.
 * - **Truncation, not rounding.** An agent that started 999 ms ago has not been running for a
 *   second. Rounding up would make a just-launched row claim `0:01` before its first tick.
 *
 * Above an hour the clock face stops being readable at a glance, so it hands over to localised
 * hour/minute units. Minutes stay zero-padded there for the same width reason.
 */
export function formatElapsedDuration(elapsedMs: number): string {
    const totalSeconds = Number.isFinite(elapsedMs) && elapsedMs > 0
        ? Math.floor(elapsedMs / MS_PER_SECOND)
        : 0;

    if (totalSeconds < SECONDS_PER_HOUR) {
        const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
        const seconds = totalSeconds % SECONDS_PER_MINUTE;
        return `${minutes}:${padTwo(seconds)}`;
    }

    const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return t('session.agentActivity.time.hoursMinutes', { hours, minutes: padTwo(minutes) });
}

function padTwo(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

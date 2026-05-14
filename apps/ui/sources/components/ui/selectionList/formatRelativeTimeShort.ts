import { t } from '@/text';

/**
 * Compact relative-time formatter for SelectionList accessories (e.g. worktree
 * "last activity" age).
 *
 * Boundaries:
 *   - < 60s              → 'now'
 *   - 1m–59m             → 'Nm ago'
 *   - 1h–23h             → 'Nh ago'
 *   - 1d–13d             → 'Nd ago'
 *   - ≥ 14d              → 'Nd ago' (no special long-range bucket — the surface
 *                                    cares about "stale" via a separate threshold)
 *   - future timestamp    → 'now'   (defensive against clock skew)
 *
 * Localised via `time.nowShort`, `time.minutesAgoShort`, `time.hoursAgoShort`,
 * `time.daysAgoShort` — each translation file ships compact suffixes so the
 * tabular-nums layout in `RelativeTimeText` stays tight in every locale.
 */
export function formatRelativeTimeShort(atMs: number, nowMs: number): string {
    const deltaMs = nowMs - atMs;
    if (deltaMs < 60_000) return t('time.nowShort');
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 60) return t('time.minutesAgoShort', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgoShort', { count: hours });
    const days = Math.floor(hours / 24);
    return t('time.daysAgoShort', { count: days });
}

import { t } from '@/text';

const DAY_MS = 86_400_000;

function resolveDayStartMs(atMs: number): number {
    const date = new Date(atMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/** "10:18" in the reader's locale: the turn stamp, the "Back to" target. */
export function formatTranscriptNavigationClockTime(atMs: number): string {
    return new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** A day header: the relative name when there is one ("Today"), and always the date ("Tue 30 Sep"). */
export function formatTranscriptNavigationDay(dayStartMs: number, nowMs: number): Readonly<{
    name: string | null;
    date: string;
}> {
    const todayStartMs = resolveDayStartMs(nowMs);
    const name = dayStartMs === todayStartMs
        ? t('sessionHistory.today')
        : dayStartMs === todayStartMs - DAY_MS
            ? t('sessionHistory.yesterday')
            : null;
    const date = new Date(dayStartMs).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: todayStartMs - dayStartMs > 300 * DAY_MS ? 'numeric' : undefined,
    });
    return { name, date };
}

/** A turn's length: "24s", "1m 02s", "1h 05m". Null for nothing measurable. */
export function formatTranscriptNavigationDuration(durationMs: number): string | null {
    if (!Number.isFinite(durationMs) || durationMs < 1_000) return null;
    const totalSeconds = Math.round(durationMs / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return t('session.transcriptNavigation.durationHours', { hours, minutes: String(minutes).padStart(2, '0') });
    if (minutes > 0) return t('session.transcriptNavigation.durationMinutes', { minutes, seconds: String(seconds).padStart(2, '0') });
    return t('session.transcriptNavigation.durationSeconds', { seconds });
}

/** A live elapsed counter: "2:14", "1:02:09". */
export function formatTranscriptNavigationElapsed(elapsedSeconds: number): string {
    const safe = Math.max(0, Math.floor(elapsedSeconds));
    const hours = Math.floor(safe / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    const seconds = String(safe % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

import type { ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';

/**
 * A CI duration to the second ("48s", "7m 31s", "1h 04m"): CI readers compare jobs by seconds, so this keeps the
 * precision a usage summary drops. Narrow Intl units keep the locale's own unit letters.
 */
export function formatForgeCiDurationV1(ms: number, locale?: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const unit = (value: number, name: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: name,
      unitDisplay: 'narrow',
    }).format(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
  if (minutes > 0)
    return `${unit(minutes, 'minute')} ${unit(seconds, 'second')}`;
  return unit(seconds, 'second');
}

type Timed = Readonly<{ startedAtMs?: number | undefined; completedAtMs?: number | undefined; updatedAtMs?: number | undefined; state: ForgeCiStepV1['state'] }>;

/**
 * How long a run, job or step took, or has been running. Unknown start means no duration (never zero); a
 * completed run may use its native update time when no explicit completion exists, as GitHub CLI does.
 * Jobs and steps retain their native completion endpoint; unfinished items never use a run update.
 */
export function readForgeCiElapsedMsV1(
  item: Timed,
  nowMs: number,
): number | null {
  if (item.startedAtMs === undefined) return null;
  if (item.state.phase === 'completed') {
    const endAtMs = item.completedAtMs ?? item.updatedAtMs;
    return endAtMs === undefined ||
      endAtMs < item.startedAtMs
      ? null
      : endAtMs - item.startedAtMs;
  }
  if (item.state.phase === 'running')
    return Math.max(0, nowMs - item.startedAtMs);
  return null;
}

/** A short commit id for display; the full id stays in links and copies. */
export function shortForgeCiShaV1(sha: string | undefined): string | null {
  return sha === undefined ? null : sha.slice(0, 7);
}

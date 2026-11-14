import type { ConfiguredHealthResultsState } from '@/components/store/inventory/configuredHealthResults';

type Checks = Extract<
  ConfiguredHealthResultsState,
  { kind: 'available' }
>['checks'];
type History = NonNullable<Checks[number]['history']>;

export type ServiceCheckStatus =
  | 'up'
  | 'down'
  | 'degraded'
  | 'unknown'
  | 'notChecked'
  | 'loading';
export type ServiceCheckFacts = Readonly<{
  status: ServiceCheckStatus;
  uptimePercent: number | null;
  checks: Checks;
}>;

const DAY_MS = 86_400_000;
/** UPTIME-HISTORY-1113's product window: today and the preceding 29 UTC calendar days. */
const HISTORY_DAYS = 30;
const WORST: readonly ServiceCheckStatus[] = [
  'down',
  'degraded',
  'unknown',
  'up',
];
const NO_CHECKS: Checks = Object.freeze([]);

/**
 * One saved Check's state as its owner reported it (configured health results): the worst current result across its
 * targets and the lowest 30-day uptime any of them reports. Nothing is recomputed from samples here.
 */
export function readServiceCheckFacts(
  state: ConfiguredHealthResultsState,
): ServiceCheckFacts {
  if (state.kind === 'loading')
    return { status: 'loading', uptimePercent: null, checks: NO_CHECKS };
  if (state.kind === 'neverObserved' || state.kind === 'notLoaded')
    return { status: 'notChecked', uptimePercent: null, checks: NO_CHECKS };
  if (state.kind === 'unavailable')
    return { status: 'unknown', uptimePercent: null, checks: NO_CHECKS };
  const statuses = new Set(state.checks.map((check) => check.result.status));
  const status =
    state.checks.length === 0
      ? 'notChecked'
      : (WORST.find((candidate) => statuses.has(candidate as never)) ??
        'unknown');
  const reported = state.checks.flatMap(
    (check) => check.history?.uptimePercent ?? [],
  );
  return {
    status,
    uptimePercent: reported.length === 0 ? null : Math.min(...reported),
    checks: state.checks,
  };
}

export type ServiceCheckDay = Readonly<{
  dayStartAt: number;
  tone: 'up' | 'down' | 'degraded' | 'unknownOnly' | 'unobserved';
  uptimePercent: number | null;
}>;

/** The 30 UTC days ending today, oldest first. A day without samples is unobserved: it never reads as up or down. */
export function serviceCheckHistoryStrip(
  history: History,
  nowMs: number,
): readonly ServiceCheckDay[] {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const byDay = new Map(history.days.map((day) => [day.dayStartAt, day]));
  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const dayStartAt = todayStart - (HISTORY_DAYS - 1 - index) * DAY_MS;
    const day = byDay.get(dayStartAt);
    if (!day || day.up + day.down + day.degraded + day.unknown === 0)
      return { dayStartAt, tone: 'unobserved', uptimePercent: null };
    const tone =
      day.down > 0
        ? 'down'
        : day.degraded > 0
          ? 'degraded'
          : day.up > 0
            ? 'up'
            : 'unknownOnly';
    return { dayStartAt, tone, uptimePercent: day.uptimePercent };
  });
}

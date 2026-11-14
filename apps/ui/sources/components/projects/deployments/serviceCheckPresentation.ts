import {
  HealthCheckServiceHttpConfigV1Schema,
  HealthCheckSourceConfigV1Schema,
  HealthCheckTcpConfigV1Schema,
} from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1, type HealthCheckKindV1 } from '@happier-dev/protocol/deployments/healthCheckV1';

import type { ConfiguredHealthResultsState } from '@/components/store/inventory/configuredHealthResults';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';

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

export type ServiceCheckSettings = Readonly<{
  kind: HealthCheckKindV1 | null;
  /** The URL, or host:port, the check reaches; null for kinds whose target is not an address. */
  address: string | null;
  expectStatus: number | null;
  keyword: string | null;
  periodMs: number;
  failuresBeforeAlert: number;
  alertChannels: number;
  /** The Machine that runs the check; null when results arrive by webhook. */
  observerMachineId: string | null;
  /** The Machine whose service is checked, when the subject is a Machine service. */
  subjectMachineId: string | null;
  label: string;
}>;

/**
 * One saved Check's settings as its saved source holds them (the automation edit seed). The shown check is the one
 * whose results the detail shows, else the source's first. Nothing is inferred: an unreadable source gives null.
 */
export function readServiceCheckSettings(
  seed: PluginEventAutomationEditSeed | null,
  checkId: string | null,
): ServiceCheckSettings | null {
  if (!seed) return null;
  const parsed = HealthCheckSourceConfigV1Schema.safeParse(seed.source.sourceConfig);
  if (!parsed.success) return null;
  const source = parsed.data;
  const check = source.checks.find((candidate) => candidate.checkId === checkId) ?? source.checks[0];
  if (!check) return null;
  const builtin = check.kind.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1;
  const kind = builtin && (HEALTH_CHECK_KINDS_V1 as readonly string[]).includes(check.kind.localId)
    ? (check.kind.localId as HealthCheckKindV1) : null;
  const http = kind === 'http' ? HealthCheckServiceHttpConfigV1Schema.safeParse(check.config) : null;
  const tcp = kind === 'tcp' ? HealthCheckTcpConfigV1Schema.safeParse(check.config) : null;
  return {
    kind,
    address: http?.success ? http.data.endpoint : tcp?.success ? `${tcp.data.host}:${tcp.data.port}` : null,
    expectStatus: http?.success ? http.data.expectStatus : null,
    keyword: http?.success ? (http.data.keyword ?? null) : null,
    periodMs: check.periodMs,
    failuresBeforeAlert: check.consecutiveFailuresBeforeAlerting,
    alertChannels: source.alerts?.channels.length ?? 0,
    observerMachineId: seed.observation.kind === 'durablePush' ? null : seed.observation.watcherMaterializationRef.machineId,
    subjectMachineId: source.subject.kind === 'machineService' ? source.subject.machineId : null,
    label: seed.source.displayLabel,
  };
}

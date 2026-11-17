import {
  HealthCheckServiceHttpConfigV1Schema,
  HealthCheckSourceConfigV1Schema,
  HealthCheckTcpConfigV1Schema,
  HealthCheckDnsConfigV1Schema,
  type HealthCheckDefinitionV1,
  readHealthCheckHttpTargetV1,
} from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readDeploymentDomainHostnameV1, type DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1, type HealthCheckKindV1 } from '@happier-dev/protocol/deployments/healthCheckV1';

import type { HealthCheckSubjectV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import {
  TELEMETRY_KEY_FLOW_HEALTH_KIND_V1,
  TelemetryKeyFlowConfigV1Schema,
  type TelemetryKeyFlowConfigV1,
} from '@happier-dev/database-protocol';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';

import type { ConfiguredHealthResultsState } from '@/components/store/inventory/configuredHealthResults';
import type { ConfiguredCheckDefinitionFacts } from '@/components/store/inventory/useConfiguredCheckDefinitions';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { getPreferredLanguage, t } from '@/text';
import { formatDeploymentLiveAddress } from './deploymentLiveAddressFacts';

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
  /** A Key flow check's saved flow (its routes, window and threshold); null for every other kind. */
  keyFlow: TelemetryKeyFlowConfigV1 | null;
  periodMs: number;
  failuresBeforeAlert: number;
  alertChannels: number;
  /** The Machine that runs the check; null when results arrive by webhook. */
  observerMachineId: string | null;
  /** The Machine whose service is checked, when the subject is a Machine service. */
  subjectMachineId: string | null;
  label: string;
  /** What Check now runs: the saved subject and the shown check's kind (the saved kind's public Action). */
  run: Readonly<{
    subject: HealthCheckSubjectV1;
    check: Readonly<{ checkId: string; kind: Readonly<{ pluginId: string; localId: string }> }>;
  }>;
}>;

export type ServiceCheckDefinitionFacts = Readonly<{
  checkId: string;
  name: string;
  targetLabel: string | null;
  periodMs: number;
  domainId: string | null;
  address: string | null;
  expectStatus: number | null;
  keyword: string | null;
  /** A Key flow check's saved flow; its trend is read from the collector that runs it (D33). */
  keyFlow: TelemetryKeyFlowConfigV1 | null;
}>;
export type ServiceCheckDefinitionReadOptions = Readonly<{
  kindName?: (kind: HealthCheckDefinitionV1['kind']) => string | null;
  domains?: readonly Readonly<{
    domain: Readonly<{ id: string; environmentId: string; targetLinkId: string }>;
    content: DeploymentDomainContentV1;
  }>[];
}>;
const storedHealthSource = createStoredReadSchema(HealthCheckSourceConfigV1Schema);
const storedHttpConfig = createStoredReadSchema(HealthCheckServiceHttpConfigV1Schema);
const storedTcpConfig = createStoredReadSchema(HealthCheckTcpConfigV1Schema);
const storedDnsConfig = createStoredReadSchema(HealthCheckDnsConfigV1Schema);

/** What a Key flow checks, in its own words: its routes ("POST /checkout, GET /api/cart"), else its metric. */
function keyFlowTargetLabel(config: TelemetryKeyFlowConfigV1): string | null {
  const measure = config.measure;
  return measure.kind === 'route' ? measure.routes.map((route) => `${route.method} ${route.route}`).join(', ')
    : measure.kind === 'runtime' ? measure.metricName : null;
}

/** Saved definition facts are independent of results. Domain targets come from the current Domain projection. */
export function readServiceCheckDefinitions(
  saved: Readonly<{ sourceConfig: unknown; displayLabel: string }>,
  options: ServiceCheckDefinitionReadOptions = {},
): readonly ServiceCheckDefinitionFacts[] | null {
  const parsed = storedHealthSource.safeParse(saved.sourceConfig);
  if (!parsed.success) return null;
  const source = parsed.data;
  const environmentId = source.subject.kind === 'environment' ? source.subject.environmentId : null;
  return source.checks.map(check => {
    const builtin = check.kind.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1;
    const http = builtin && (check.kind.localId === 'http' || check.kind.localId === 'certificate')
      ? storedHttpConfig.safeParse(check.config) : null;
    const tcp = builtin && check.kind.localId === 'tcp' ? storedTcpConfig.safeParse(check.config) : null;
    const dns = builtin && check.kind.localId === 'dns' ? storedDnsConfig.safeParse(check.config) : null;
    const keyFlow = check.kind.pluginId === TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.pluginId
      && check.kind.localId === TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.localId ? TelemetryKeyFlowConfigV1Schema.safeParse(check.config) : null;
    const binding = check.binding;
    const domainId = binding.kind === 'healthCheck' ? null : binding.domainId;
    const domain = binding.kind !== 'healthCheck' && source.subject.kind === 'environment'
      ? options.domains?.find(item => item.domain.id === binding.domainId && item.domain.targetLinkId === binding.targetLinkId
        && item.domain.environmentId === environmentId) : undefined;
    const hostname = domain ? readDeploymentDomainHostnameV1(domain.content.hostname) : null;
    const target = domain && hostname ? readHealthCheckHttpTargetV1({ hostname, healthCheck: domain.content.healthCheck })
      : http?.success ? readHealthCheckHttpTargetV1(http.data) : null;
    const address = domain ? target?.url ?? null : http?.success ? http.data.endpoint : tcp?.success ? `${tcp.data.host}:${tcp.data.port}` : null;
    const labelUrl = target ? new URL(target.url) : null;
    if (labelUrl) { labelUrl.search = ''; labelUrl.hash = ''; }
    return {
      checkId: check.checkId, name: options.kindName?.(check.kind) ?? saved.displayLabel,
      targetLabel: labelUrl ? formatDeploymentLiveAddress(labelUrl.href) : address ?? (dns?.success ? `${dns.data.recordType} ${dns.data.hostname}`
        : keyFlow?.success ? keyFlowTargetLabel(keyFlow.data) : null),
      periodMs: check.periodMs, domainId, address,
      expectStatus: target?.expectStatus ?? null,
      keyword: http?.success ? http.data.keyword ?? null : null,
      keyFlow: keyFlow?.success ? keyFlow.data : null,
    };
  });
}

/**
 * One saved Check's settings as its saved source holds them (the automation edit seed). The shown check is the one
 * whose results the detail shows, else the source's first. Nothing is inferred: an unreadable source gives null.
 */
export function readServiceCheckSettings(
  seed: PluginEventAutomationEditSeed | null,
  checkId: string | null,
  options: ServiceCheckDefinitionReadOptions = {},
): ServiceCheckSettings | null {
  if (!seed) return null;
  const parsed = storedHealthSource.safeParse(seed.source.sourceConfig);
  if (!parsed.success) return null;
  const source = parsed.data;
  const check = source.checks.find((candidate) => candidate.checkId === checkId) ?? source.checks[0];
  if (!check) return null;
  const builtin = check.kind.pluginId === HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1;
  const kind = builtin && (HEALTH_CHECK_KINDS_V1 as readonly string[]).includes(check.kind.localId)
    ? (check.kind.localId as HealthCheckKindV1) : null;
  const facts = readServiceCheckDefinitions(seed.source, options)?.find(candidate => candidate.checkId === check.checkId);
  return {
    kind,
    address: facts?.address ?? null,
    expectStatus: facts?.expectStatus ?? null,
    keyword: facts?.keyword ?? null,
    keyFlow: facts?.keyFlow ?? null,
    periodMs: check.periodMs,
    failuresBeforeAlert: check.consecutiveFailuresBeforeAlerting,
    alertChannels: source.alerts?.channels.length ?? 0,
    observerMachineId: seed.observation.kind === 'durablePush' ? null : seed.observation.watcherMaterializationRef.machineId,
    subjectMachineId: source.subject.kind === 'machineService' ? source.subject.machineId : null,
    label: seed.source.displayLabel,
    run: { subject: source.subject, check: { checkId: check.checkId, kind: check.kind } },
  };
}

/**
 * The subject Investigate hands to the one failure-investigation owner: the Domain a Domain-bound check watches, else
 * the Environment it watches. A Machine-service check needs the service's identity (not on the saved source): none.
 */
export function serviceCheckInvestigationSubject(
  seed: PluginEventAutomationEditSeed | null,
  checkId: string | null,
  serverId: string,
): TriageFailureSubjectV1 | null {
  if (!seed) return null;
  const parsed = HealthCheckSourceConfigV1Schema.safeParse(seed.source.sourceConfig);
  if (!parsed.success || parsed.data.subject.kind !== 'environment') return null;
  const environmentId = parsed.data.subject.environmentId;
  const check = parsed.data.checks.find((candidate) => candidate.checkId === checkId) ?? parsed.data.checks[0];
  return check?.binding.kind === 'domain'
    ? { kind: 'domain', serverId, environmentId, domainId: check.binding.domainId }
    : { kind: 'deploymentEnvironment', serverId, environmentId };
}

/** A Check's state in words, as every Check surface says it (list row, detail facts, latest results). */
export function serviceCheckStatusWord(status: ServiceCheckStatus): string {
  switch (status) {
    case 'up':
      return t('projects.deployments.healthUp');
    case 'down':
      return t('projects.deployments.healthDown');
    case 'degraded':
      return t('projects.deployments.healthDegraded');
    case 'notChecked':
      return t('projects.deployments.healthNotChecked');
    case 'loading':
      return t('common.loading');
    default:
      return t('projects.deployments.healthUnknown');
  }
}

/**
 * A single result as a fact cell says it: up, down or degraded. An unknown, unchecked or still-loading state is said
 * once by the detail's meta line, so the cell keeps its dash instead of repeating it (null).
 */
export function serviceCheckResultWord(status: ServiceCheckStatus): string | null {
  return status === 'up' || status === 'down' || status === 'degraded' ? serviceCheckStatusWord(status) : null;
}

/** Whether a Check's state needs the person: down is danger, degraded a warning; anything else stays quiet (null). */
export function serviceCheckStatusTone(status: ServiceCheckStatus): 'danger' | 'warning' | null {
  return status === 'down' ? 'danger' : status === 'degraded' ? 'warning' : null;
}

type RetainedCheck = Checks[number];
export type ServiceCheckRecent = Readonly<{
  /** Retained results, newest first; a check from before retention has only its latest. */
  results: readonly RetainedCheck['result'][];
  /** Older results were trimmed inside the window: say the list is incomplete. */
  partial: boolean;
  failingSince: number | null;
  failureStreak: number | null;
}>;

/** One check's retained results and failing streak as the health owner keeps them; nothing is recomputed here. */
export function readServiceCheckRecent(check: RetainedCheck): ServiceCheckRecent {
  const results = check.recentResults ? [...check.recentResults].reverse() : [check.result];
  const failing = check.failingSince !== undefined && check.failingSince !== null;
  return {
    results,
    partial: check.recentResultsCoverage === 'partial',
    failingSince: failing ? check.failingSince! : null,
    failureStreak: failing && check.failureStreak !== undefined ? check.failureStreak : null,
  };
}

export type ServiceCheckBar = Readonly<{
  /** The result's observedAt, or the empty slot's position. */
  key: string;
  tone: ServiceCheckDay['tone'];
  observedAt: number | null;
  status: ServiceCheckStatus | null;
}>;
export type ServiceCheckBars = Readonly<{
  bars: readonly ServiceCheckBar[];
  /** Older results were trimmed and the kept ones do not fill the bars: the row says so with its lead mark. */
  partialLead: boolean;
}>;

const RESULT_TONE = { up: 'up', down: 'down', degraded: 'degraded', unknown: 'unknownOnly' } as const;

/**
 * The last `slots` retained results as bars (lab CheckHistoryBars), oldest first, each in its own result's tone. Slots
 * before the first kept result stay empty, so a new check reserves its bars and nothing moves when results arrive.
 */
export function serviceCheckRecentBars(recent: ServiceCheckRecent | null, slots: number): ServiceCheckBars {
  const kept = recent ? recent.results.slice(0, slots).reverse() : [];
  const empty = slots - kept.length;
  return {
    bars: [
      ...Array.from({ length: empty }, (_, index): ServiceCheckBar => ({ key: `empty:${index}`, tone: 'unobserved', observedAt: null, status: null })),
      ...kept.map((result): ServiceCheckBar => ({ key: String(result.observedAt), tone: RESULT_TONE[result.status], observedAt: result.observedAt,
        status: result.status })),
    ],
    partialLead: recent?.partial === true && empty > 0,
  };
}

/** The response trend's window: the Monitoring column and card say "24 h" (D36). */
export const SERVICE_CHECK_RESPONSE_WINDOW_MS = 86_400_000;

/**
 * Retained response observations within `windowMs` before the newest result, oldest first.
 * An observation without timing remains a chart gap; a trimmed history draws a shorter line.
 */
export function serviceCheckResponseSeries(recent: ServiceCheckRecent, windowMs: number): readonly Readonly<{ observedAt: number; latencyMs: number | null }>[] {
  const newest = recent.results[0]?.observedAt;
  if (newest === undefined) return [];
  return recent.results
    .filter((result) => result.observedAt >= newest - windowMs)
    .map((result) => ({ observedAt: result.observedAt, latencyMs: result.latencyMs ?? null }))
    .reverse();
}

/** The average response over the last `count` retained results that carry one ("last N checks"); null when none do. */
export function serviceCheckAverageLatency(recent: ServiceCheckRecent, count: number): Readonly<{ averageMs: number; count: number }> | null {
  const latencies = recent.results.slice(0, count).flatMap((result) => (result.latencyMs === undefined ? [] : [result.latencyMs]));
  return latencies.length === 0 ? null
    : { averageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length, count: latencies.length };
}

/** Today's uptime from today's UTC bucket as the owner keeps it (not a rolling 24 h); null before today's first sample. */
export function serviceCheckTodayUptime(history: History, nowMs: number): number | null {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return history.days.find((day) => day.dayStartAt === todayStart)?.uptimePercent ?? null;
}

type MonitoredCheck = Readonly<{ key: string; native: Readonly<{ enabled: boolean }>; lastResults: ConfiguredHealthResultsState;
  definitionFacts: ListedCheck['definitionFacts'] }>;

export const NO_OFFLINE_OBSERVERS: ReadonlySet<string> = new Set();

/**
 * Whether a running check has stopped being checked: the Machine that observes it is offline by its presence owner
 * (`offlineObservers`, from useMachinePresenceSummaries). Its last results are kept, dimmed, and never count as
 * passing. The one decision for the row, its bars, the glance line and Needs you.
 */
export function serviceCheckStale(
  row: Pick<MonitoredCheck, 'native' | 'definitionFacts'>,
  offlineObservers: ReadonlySet<string>,
): boolean {
  if (!row.native.enabled || row.definitionFacts.kind !== 'available') return false;
  const machineId = row.definitionFacts.observerMachineId;
  return machineId !== null && offlineObservers.has(machineId);
}
export type ServiceCheckMonitorSummary = Readonly<{
  down: number;
  degraded: number;
  passing: number;
  /** Running checks whose observing Machine is offline: their last result is not today's answer (serviceCheckStale). */
  notChecked: number;
  /** Running checks whose state needs the person (down, degraded), in list order. */
  needsYou: ReadonlySet<string>;
}>;

/**
 * Monitoring's glance line and its Needs-you section, from each check's reported state (readServiceCheckFacts). Only
 * running checks count: a paused check, one not read yet or one whose state is unknown counts in none.
 */
export function serviceCheckMonitorSummary(
  rows: readonly MonitoredCheck[],
  offlineObservers: ReadonlySet<string> = NO_OFFLINE_OBSERVERS,
): ServiceCheckMonitorSummary {
  let down = 0;
  let degraded = 0;
  let passing = 0;
  let notChecked = 0;
  const needsYou = new Set<string>();
  for (const row of rows) {
    if (!row.native.enabled) continue;
    if (serviceCheckStale(row, offlineObservers)) {
      notChecked += 1;
      continue;
    }
    const status = readServiceCheckFacts(row.lastResults).status;
    if (status === 'down') down += 1;
    else if (status === 'degraded') degraded += 1;
    else if (status === 'up') passing += 1;
    if (serviceCheckStatusTone(status) !== null) needsYou.add(row.key);
  }
  return { down, degraded, passing, notChecked, needsYou };
}

/**
 * Why a result failed, in the words every Check surface uses (detail banner, list row): the answered status against
 * the expected one, a missing keyword, the observer's own reason, and where it was checked from.
 */
export function serviceCheckCauseText(cause: RetainedCheck['result']['cause'] | null | undefined): string | null {
  if (!cause) return null;
  const k = 'projects.deployments.services' as const;
  return [
    cause.httpStatus !== undefined && cause.expectStatus !== undefined && cause.httpStatus !== cause.expectStatus
      ? t(`${k}.causeAnswered`, { status: String(cause.httpStatus), expected: String(cause.expectStatus) })
      : null,
    cause.keywordMatched === false ? t(`${k}.causeKeywordMissing`) : null,
    cause.reason ?? null,
    t(cause.vantage === 'outside' ? `${k}.causeFromOutside` : `${k}.causeFromSameMachine`),
  ].filter((part): part is string => Boolean(part)).join(' · ');
}

type ShownDefinition = Extract<ConfiguredCheckDefinitionFacts, { kind: 'available' }>['checks'][number];

/**
 * The definition the detail names (kind, target, cadence): the shown check's, else the source's first, from the
 * inventory's definition facts. Loading and unavailable stay as the owner reports them.
 */
export function serviceCheckShownDefinition(
  facts: ConfiguredCheckDefinitionFacts,
  checkId: string | null,
): Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'unavailable' }> | Readonly<{ kind: 'available'; definition: ShownDefinition }> {
  if (facts.kind !== 'available') return { kind: facts.kind };
  const definition = facts.checks.find((check) => check.checkId === checkId) ?? facts.checks[0];
  return definition ? { kind: 'available', definition } : { kind: 'unavailable' };
}

/** An uptime figure alone ("99.98%"), to two decimals, under a heading or detail that already names its span. */
export function serviceCheckUptimeText(percent: number | null): string | null {
  return percent === null ? null : `${Math.round(percent * 100) / 100}%`;
}

/** A Check figure in the reader's units ("5 min", "1.2 s"), shared by the Check detail and the Checks list. */
export function formatServiceCheckUnit(value: number, name: 'millisecond' | 'second' | 'minute' | 'hour'): string {
  return new Intl.NumberFormat(getPreferredLanguage(), { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 1 })
    .format(value);
}
export function formatServiceCheckLatency(ms: number): string {
  return ms < 1000 ? formatServiceCheckUnit(Math.round(ms), 'millisecond') : formatServiceCheckUnit(ms / 1000, 'second');
}
export function formatServiceCheckPeriod(ms: number): string {
  return ms % 3_600_000 === 0 ? formatServiceCheckUnit(ms / 3_600_000, 'hour')
    : ms % 60_000 === 0 ? formatServiceCheckUnit(ms / 60_000, 'minute') : formatServiceCheckUnit(ms / 1000, 'second');
}

type ListedCheck = Readonly<{
  native: Readonly<{ name: string }>;
  definitionFacts: ConfiguredCheckDefinitionFacts;
  lastResults: ConfiguredHealthResultsState;
}>;

/** A row's recent results: the lab's "Last 30 checks" (MONITOR-LAB-1115 Q1, row size). */
export const SERVICE_CHECK_ROW_BARS = 30;

export type ServiceCheckCollectorTrend = Readonly<{
  collectorMachineId: string;
  config: TelemetryKeyFlowConfigV1;
  until: number;
}>;

export type ServiceCheckListFacts = Readonly<{
  title: string;
  kind: string | null;
  every: string | null;
  lastResult: string | null;
  lastTone: 'danger' | 'warning' | null;
  /** The worst current state across the row's targets (readServiceCheckFacts). */
  status: ServiceCheckStatus;
  /** The shown target's last results as bars. */
  recent: ServiceCheckBars;
  latencyMs: number | null;
  /** The shown target's retained responses over the 24 hours before its newest result, oldest first (D36 2A/2B). */
  response24h: readonly Readonly<{ observedAt: number; latencyMs: number | null }>[];
  /**
   * A Key flow's response trend is the collector's selected history, not its retained check timings (D33, R2-B): the
   * collector that runs it, its saved flow, and the newest result as the window's end. Null for every other kind.
   */
  collectorTrend: ServiceCheckCollectorTrend | null;
  /** The shown target's usual response: the average over its passing results in the bars' window. */
  usualMs: number | null;
  uptimePercent: number | null;
  failingSince: number | null;
  causeText: string | null;
  observerMachineId: string | null;
}>;

/**
 * One Checks row (lab svcChk, MONITOR-LAB-1115 A1): named by what it checks (its definition's target, else the saved
 * name), its kind, how often it runs, and the shown target's results: a failing target first, else the definition's,
 * else the first. Its bars, response, cause and failing time are that target's; the uptime is the row's lowest.
 */
export function serviceCheckListFacts(row: ListedCheck, slots: number = SERVICE_CHECK_ROW_BARS): ServiceCheckListFacts {
  const head = serviceCheckShownDefinition(row.definitionFacts, null);
  const definition = head.kind === 'available' ? head.definition : null;
  const facts = readServiceCheckFacts(row.lastResults);
  const shown = facts.checks.find((check) => serviceCheckStatusTone(check.result.status) !== null)
    ?? facts.checks.find((check) => check.checkId === definition?.checkId) ?? facts.checks[0] ?? null;
  const word = shown ? serviceCheckResultWord(shown.result.status) : null;
  const recent = shown ? readServiceCheckRecent(shown) : null;
  const window = recent?.results.slice(0, slots) ?? [];
  const usual = window.flatMap((result) => (result.status === 'up' && result.latencyMs !== undefined ? [result.latencyMs] : []));
  const observerMachineId = row.definitionFacts.kind === 'available' ? row.definitionFacts.observerMachineId : null;
  const keyFlow = row.definitionFacts.kind === 'available'
    ? (row.definitionFacts.checks.find((check) => check.checkId === shown?.checkId) ?? definition)?.keyFlow ?? null : null;
  const newest = recent?.results[0]?.observedAt;
  const collectorTrend = keyFlow && observerMachineId !== null && newest !== undefined
    ? { collectorMachineId: observerMachineId, config: keyFlow, until: newest } : null;
  return {
    title: definition?.targetLabel ?? row.native.name,
    kind: definition?.name ?? null,
    every: definition ? formatServiceCheckPeriod(definition.periodMs) : null,
    lastResult: word ? [word, shown?.result.latencyMs === undefined ? null : formatServiceCheckLatency(shown.result.latencyMs)]
      .filter(Boolean).join(' · ') : null,
    lastTone: shown ? serviceCheckStatusTone(shown.result.status) : null,
    status: facts.status,
    recent: serviceCheckRecentBars(recent, slots),
    latencyMs: shown?.result.latencyMs ?? null,
    response24h: recent && !keyFlow ? serviceCheckResponseSeries(recent, SERVICE_CHECK_RESPONSE_WINDOW_MS) : [],
    collectorTrend,
    usualMs: usual.length === 0 ? null : usual.reduce((sum, value) => sum + value, 0) / usual.length,
    uptimePercent: facts.uptimePercent,
    failingSince: recent?.failingSince ?? null,
    causeText: shown && serviceCheckStatusTone(shown.result.status) !== null ? serviceCheckCauseText(shown.result.cause) : null,
    observerMachineId,
  };
}

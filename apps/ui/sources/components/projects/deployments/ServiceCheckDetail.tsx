import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  InvestigationAgentActionButtons,
  type InvestigationAgentActionButtonModel,
} from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { checkNowConfiguredHealthCheck } from '@/components/store/inventory/configuredHealthResults';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Switch } from '@/components/ui/forms/Switch';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { configuredHealthCheckAutomationSubject } from '@/components/store/inventory/configuredHealthResults';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { updateWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';

import {
  readServiceCheckFacts,
  readServiceCheckRecent,
  readServiceCheckSettings,
  serviceCheckShownDefinition,
  serviceCheckCauseText,
  serviceCheckKeyFlowCauseText,
  formatServiceCheckKeyFlowValue,
  formatServiceCheckShare,
  serviceCheckInvestigationSubject,
  serviceCheckSavedAutomationSubject,
  serviceCheckHistoryStrip,
  serviceCheckListFacts,
  serviceCheckRecentBars,
  serviceCheckAverageLatency,
  serviceCheckTodayUptime,
  serviceCheckUptimeText,
  serviceCheckResultWord,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  type ServiceCheckSettings,
  formatServiceCheckLatency,
  formatServiceCheckPeriod,
  formatServiceCheckUnit,
} from './serviceCheckPresentation';
import { ServiceCheckBars, type ServiceCheckBarCell } from './ServiceCheckBars';
import { ServiceCheckKeyFlowSection } from './ServiceCheckKeyFlowSection';
import { useEnvironmentName } from './useEnvironmentName';

const k = 'projects.deployments.services' as const;
const m = 'projects.deployments.monitoring' as const;

const unit = formatServiceCheckUnit;
const formatLatency = formatServiceCheckLatency;
const formatClock = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), {
    hour: 'numeric',
    minute: '2-digit',
  });
const formatSpan = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${unit(hours, 'hour')} ${unit(minutes % 60, 'minute')}` : unit(minutes, 'minute');
};
/** One page of retained results at a time; Older shows the next. */
const RESULTS_PAGE = 10;
/** The page's recent checks (MONITOR-LAB-1115 A3): its bars, the response chart and the average read the last 60. */
const PAGE_RESULTS = 60;
/** The narrowest column a fact reads in at title size on one line ("34 hr 22 min", "99.98%"). */
const FACT_MIN_WIDTH_PX = 128;
const percentText = (percent: number | null) => serviceCheckUptimeText(percent) ?? '—';
const formatDay = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), { month: 'short', day: 'numeric', timeZone: 'UTC' });

type SeedRead = Readonly<{
  key: string;
  seed: PluginEventAutomationEditSeed | null;
}>;

/**
 * The saved source behind this Check, read once while its detail is open, through the automation edit-seed owner.
 * A read that settles without a source says so (`unavailable`) and can be read again; it never reads as no settings.
 */
function useCheckSeed(row: ManagedConfiguredCheckRow) {
  const key = `${row.automationId}\n${row.triggerId}`;
  const [read, setRead] = React.useState<SeedRead | null>(null);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    let alive = true;
    void sync
      .getAutomationPluginEventEditSeed(row.automationId, row.triggerId)
      .then((seed) => {
        if (alive && lifetime?.isCurrent()) setRead({ key, seed });
      })
      .catch(() => {
        if (alive && lifetime?.isCurrent()) setRead({ key, seed: null });
      });
    return () => {
      alive = false;
    };
  }, [generation, key, row.automationId, row.triggerId]);
  const retry = React.useCallback(() => {
    setRead(null);
    setGeneration((value) => value + 1);
  }, []);
  const settled = read?.key === key ? read : null;
  return { seed: settled?.seed ?? null, unavailable: settled !== null && settled.seed === null, retry };
}

/**
 * What a Check is, under its name (lab A3): its kind, how often and from which Machine, the list row's own facts.
 * The target is the name and its state stands in the banner and under the bars, so neither repeats here. A named Key
 * flow also says its routes, the service it checks and the Environment it runs in (lab p7Flows detail).
 */
export function useServiceCheckMeta(row: ManagedConfiguredCheckRow): string | null {
  const facts = serviceCheckListFacts(row);
  const observer = useServerScopedMachineLabel(row.scope.serverId, facts.observerMachineId);
  const head = serviceCheckShownDefinition(row.definitionFacts, null);
  const definition = head.kind === 'available' ? head.definition : null;
  const keyFlow = definition?.keyFlow ?? null;
  const environment = useEnvironmentName(row.scope.serverId, keyFlow?.environmentId ?? null).name;
  if (row.definitionFacts.kind === 'loading') return null;
  const every = facts.every
    ? observer
      ? t(`${k}.checkEvery`, { period: facts.every, machine: observer })
      : t(`${k}.checkEveryAnywhere`, { period: facts.every })
    : null;
  const flow = keyFlow ? [
    definition?.targetLabel !== facts.title ? definition?.targetLabel ?? null : null,
    every,
    t(`${m}.keyFlowChecksService`, { service: keyFlow.serviceName }),
    environment,
  ] : [every];
  return [facts.kind, ...flow].filter(Boolean).join(' · ') || t('automations.form.trigger.sourceUnavailable');
}

/**
 * One Check's detail (pfc-redesign rdDet-chk), the same body in the details pane and as its page: who checks what
 * and how often, whether it is failing first, the last result, response and 30-day uptime, each target's latest result,
 * then its settings. Every fact is the owner's: configured health results (with UPTIME-HISTORY's 30 days) and the
 * saved source; settings open the Check's editor.
 */
export function ServiceCheckDetail(
  props: Readonly<{
    row: ManagedConfiguredCheckRow;
    nowMs?: number;
    /** The Check page says what the Check is in its header's description; the pane says it at the top of the body. */
    metaInHeader?: boolean;
  }>,
) {
  const { row } = props;
  const { theme } = useUnistyles();
  const router = useRouter();
  const facts = readServiceCheckFacts(row.lastResults);
  const nowMs = props.nowMs ?? Date.now();
  const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const { seed, unavailable: seedUnavailable, retry: retrySeed } = useCheckSeed(row);
  const shown =
    facts.checks.find(
      (check) =>
        serviceCheckStatusTone(check.result.status) !== null,
    ) ??
    facts.checks[0] ??
    null;
  const settings = readServiceCheckSettings(seed, shown?.checkId ?? null);
  const serverIdForSubject = row.scope.serverId;
  const investigateSubject = React.useMemo(
    () => serviceCheckInvestigationSubject(seed, shown?.checkId ?? null, serverIdForSubject),
    [seed, shown?.checkId, serverIdForSubject],
  );
  const serverId = row.scope.serverId;
  // The retained health source owns this Check's identity; a saved Check with no result yet reads it from its saved
  // source, so its Automations are there before the first result.
  const automationSubject = React.useMemo(
    () => shown ? configuredHealthCheckAutomationSubject(row.lastResults, shown.checkId, serverId)
      : serviceCheckSavedAutomationSubject(seed, null, serverId),
    [row.lastResults, shown, serverId, seed],
  );
  const observer = useServerScopedMachineLabel(
    serverId,
    settings?.observerMachineId ?? null,
  );
  const collectorLabel = useServerScopedMachineLabel(serverId, serviceCheckListFacts(row).collectorTrend?.collectorMachineId ?? null);
  const [pausing, setPausing] = React.useState(false);
  const openEditor = React.useCallback(
    () =>
      router.push(
        `/automations/${encodeURIComponent(row.automationId)}` as never,
      ),
    [router, row.automationId],
  );
  const setPaused = React.useCallback(
    async (paused: boolean) => {
      setPausing(true);
      try {
        await updateWorkflowTrigger({
          automationId: row.automationId,
          expectedRevision: row.native.templateVersion,
          patch: { enabled: !paused },
        }, { context: { serverId: row.scope.serverId, expectedAccountId: row.scope.accountId } });
      } finally {
        setPausing(false);
      }
    },
    [row.automationId, row.native.templateVersion, row.scope.accountId, row.scope.serverId],
  );
  const failing =
    row.native.enabled &&
    serviceCheckStatusTone(facts.status) !== null;
  const statusText = row.native.enabled
    ? serviceCheckStatusWord(facts.status)
    : t(`${k}.paused`);
  // The target comes from the inventory's definition facts; the page never reads a target itself.
  const head = serviceCheckShownDefinition(row.definitionFacts, shown?.checkId ?? null);
  const definition = head.kind === 'available' ? head.definition : null;
  const meta = useServiceCheckMeta(row);
  const lastTone = shown ? serviceCheckStatusTone(shown.result.status) : null;
  const recent = shown ? readServiceCheckRecent(shown) : null;
  const shownKeyFlow = definition?.keyFlow ?? null;
  const causeText = shownKeyFlow && shown ? serviceCheckKeyFlowCauseText(shownKeyFlow, shown.result) : serviceCheckCauseText(shown?.result.cause);
  const latencies = recent
    ? recent.results.slice(0, PAGE_RESULTS).flatMap((result) => (result.latencyMs === undefined ? [] : [result])).reverse()
    : [];
  const average = recent ? serviceCheckAverageLatency(recent, PAGE_RESULTS) : null;
  const today = shown?.history ? serviceCheckTodayUptime(shown.history, nowMs) : null;
  const heroBars = serviceCheckRecentBars(recent, PAGE_RESULTS);
  const heroCells = heroBars.bars.map((bar): ServiceCheckBarCell => ({
    key: bar.key, tone: bar.tone,
    label: bar.observedAt === null ? t('projects.deployments.healthNotChecked') : formatClock(bar.observedAt),
    ...(bar.status ? { valueLabel: serviceCheckStatusWord(bar.status) } : {}),
  }));
  const heroKept = heroBars.bars.filter((bar) => bar.observedAt !== null).length;
  const [resultsShown, setResultsShown] = React.useState(RESULTS_PAGE);
  // The facts go two to a row where their columns would squeeze a value onto two lines (a details pane, a phone).
  const [factsWidth, setFactsWidth] = React.useState<number | null>(null);
  // Response, its average, today's and the 30-day uptime (lab A3); the state and when it was checked stand under the bars.
  const stripFacts: FactStripFact[] = [
    ...(recent?.failingSince !== null && recent?.failingSince !== undefined
      ? [
          {
            key: 'failingFor',
            label: t(`${k}.failingFor`),
            value: formatSpan(nowMs - recent.failingSince),
            tone: lastTone === 'danger' ? 'danger' as const : 'attention' as const,
            ...(recent.failureStreak !== null ? { detail: t(`${k}.failureStreak`, { count: recent.failureStreak }) } : {}),
          },
        ]
      : []),
    ...(shownKeyFlow ? keyFlowFacts(shownKeyFlow, shown?.result ?? null) : [
      {
        key: 'response',
        label: t(`${k}.response`),
        value: shown?.result.latencyMs === undefined || !shown ? '—' : formatLatency(shown.result.latencyMs),
        ...(shown?.result.latencyMs === undefined ? {} : { detail: t(`${m}.latest`) }),
      },
      {
        key: 'average',
        label: t(`${m}.average`),
        value: average ? formatLatency(average.averageMs) : '—',
        ...(average ? { detail: t(`${m}.averageDetail`, { count: average.count }) } : {}),
      },
    ]),
    {
      key: 'today',
      label: t(`${m}.uptimeToday`),
      value: percentText(today),
      detail: t(`${m}.uptimeTodayDetail`),
    },
    {
      key: 'uptime',
      label: t(`${m}.uptime`),
      value: percentText(facts.uptimePercent),
      detail: t(`${m}.uptimeDays`),
    },
  ];
  const keyFlow = definition?.keyFlow ?? settings?.keyFlow ?? null;
  // A Key flow's trend and routes come from the collector that runs it (D33); its bars and uptime stay the persisted results.
  const collectorTrend = serviceCheckListFacts(row).collectorTrend;
  const expect = settings?.expectStatus
    ? settings.keyword
      ? t(`${k}.expectStatusKeyword`, {
          status: String(settings.expectStatus),
          keyword: settings.keyword,
        })
      : t(`${k}.expectStatus`, { status: String(settings.expectStatus) })
    : null;
  return (
    <View testID={`services.check.${row.automationId}.${row.triggerId}`}>
      {/* The head holds the meta line (beside the pane's title) and the check's actions; on the page with neither, it
          draws nothing, so the bars stand right under the header (lab A3). */}
      {(props.metaInHeader || meta === null) && !settings && !(failing && investigateSubject) ? null : (
      <ItemGroup surface="none" testID="services.check.head">
        {props.metaInHeader || meta === null ? null : (
          <Text
            variant="meta"
            style={styles.metaText}
            testID="services.check.meta"
          >
            {meta}
          </Text>
        )}
        <View style={styles.actions}>
          {settings ? <CheckNow run={settings.run} scope={row.scope} /> : null}
          {failing && investigateSubject ? (
            <CheckInvestigate subject={investigateSubject} serverId={serverIdForSubject} />
          ) : null}
        </View>
      </ItemGroup>
      )}
      {failing ? (
        <AttentionBanner
          testID="services.check.failing"
          tone={serviceCheckStatusTone(facts.status) ?? 'warning'}
          // Down is a target that cannot answer; a check that answers and breaks its rule is failing (D33).
          title={t(facts.status === 'down' ? `${m}.checkDownTitle` : `${k}.checkFailingTitle`)}
          {...(causeText ? { description: causeText } : {})}
        />
      ) : null}
      {shown ? (
        <ItemGroup surface="none" testID="services.check.recent">
          <View style={styles.hero}>
            <ServiceCheckBars cells={heroCells} slots={PAGE_RESULTS} size="full" label={t(`${m}.columnRecent`, { count: PAGE_RESULTS })}
              partialLead={heroBars.partialLead} decorative={false} testID="services.check.recent.bars" />
            <View style={styles.caption}>
              <Text variant="meta" style={styles.captionText}>{heroKept > 0 ? t(`${m}.heroOldest`, { count: heroKept }) : ''}</Text>
              <Text variant="meta" style={styles.captionText}>
                {[statusText, t(`${m}.checkedAt`, { time: formatClock(shown.result.observedAt) })].join(' · ')}
              </Text>
            </View>
          </View>
        </ItemGroup>
      ) : null}
      <ItemGroup surface="none" testID="services.check.facts">
        <View onLayout={(event) => setFactsWidth(Math.round(event.nativeEvent.layout.width))}>
          <FactStrip facts={stripFacts} layout="columns" scale="headline"
            narrow={factsWidth !== null && factsWidth < stripFacts.length * FACT_MIN_WIDTH_PX} />
        </View>
      </ItemGroup>
      {collectorTrend ? (
        <ServiceCheckKeyFlowSection scope={row.scope} trend={collectorTrend} collectorLabel={collectorLabel}
          limitTone={failing && facts.status === 'down' ? 'error' : 'warning'} />
      ) : null}
      {latencies.length >= 2 && !keyFlow ? (
        <ItemGroup title={t(`${m}.responseTime`)} action={<Text variant="meta" style={styles.captionText}>
          {t(`${m}.responseSpan`, { count: latencies.length })}</Text>} surface="none" testID="services.check.response">
          <StackedSeriesChart
            theme={pluginTheme}
            label={t(`${m}.responseTime`)}
            series={[{
              id: 'latency',
              label: t(`${k}.response`),
              color: theme.colors.text.secondary,
              points: latencies.map((result) => ({ id: String(result.observedAt), x: result.observedAt, y: result.latencyMs ?? null,
                label: formatClock(result.observedAt) })),
            }]}
            variant="line"
            size="full"
            showLegend={false}
            showReadout={false}
            {...(average ? { reference: { value: average.averageMs, label: t(`${m}.average`) } } : {})}
          />
        </ItemGroup>
      ) : null}
      {facts.checks.map((check) => {
        const strip = check.history ? serviceCheckHistoryStrip(check.history, nowMs) : null;
        if (!strip) return null;
        // The strip's left edge is its oldest day; a check younger than the window says when its checks began (lab A3).
        const firstObserved = strip.findIndex((day) => day.tone !== 'unobserved');
        const began = firstObserved > 0 ? t(`${m}.noChecksBefore`, { day: formatDay(strip[firstObserved]!.dayStartAt) }) : null;
        return (
          <ItemGroup key={check.checkId} title={t(`${k}.lastDays`)} surface="none" testID={`services.check.history.${check.checkId}`}
            {...(began ? { action: <Text variant="meta" style={styles.captionText}>{began}</Text> } : {})}>
            <View style={styles.hero}>
              <ServiceCheckBars
                size="tile"
                slots={strip.length}
                label={t(`${k}.lastDays`)}
                decorative={false}
                cells={strip.map((day): ServiceCheckBarCell => ({
                  key: String(day.dayStartAt),
                  tone: day.tone,
                  label: formatDay(day.dayStartAt),
                  valueLabel: day.uptimePercent === null ? t('projects.deployments.healthNotChecked') : `${day.uptimePercent}%`,
                }))}
              />
              <View style={styles.caption}>
                <Text variant="meta" style={styles.captionText}>{formatDay(strip[0]!.dayStartAt)}</Text>
                <Text variant="meta" style={styles.captionText}>{t(`${m}.today`)}</Text>
              </View>
            </View>
          </ItemGroup>
        );
      })}
      {recent ? (
        <ItemGroup
          // Results are records the person reads down: a flat list with its section title, no card (lab A3; owner 11-15).
          surface="none"
          title={t(`${k}.recentResults`)}
          description={t(recent.partial ? `${k}.recentResultsPartial` : `${k}.recentResultsBody`)}
          testID="services.check.results"
        >
          {recent.results.slice(0, resultsShown).map((result) => (
            <Item
              key={result.observedAt}
              testID={`services.check.result.${result.observedAt}`}
              // The result's word in its tone through the shared Status (as Checks list rows draw it; FIDELITY G6b).
              title={serviceCheckResultWord(result.status)
                ? <InlineStatus tone={serviceCheckStatusTone(result.status) ?? 'secondary'} label={serviceCheckResultWord(result.status)!} />
                : '—'}
              // When, what it answered and from where on line 2; the response alone on the right, the same short value
              // on every row so a phone never switches one row to stacked facts (lab A3 recent results).
              subtitle={[
                formatClock(result.observedAt),
                result.cause?.httpStatus === undefined ? null : String(result.cause.httpStatus),
                // A measured check (a Key flow) says its error share beside its time (lab p7Flows detail).
                result.measurements?.errorRate === undefined ? null
                  : t(`${m}.keyFlowErrorShare`, { percent: formatServiceCheckShare(result.measurements.errorRate) }),
                observer ? t(`${k}.resultFrom`, { machine: observer }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              detail={result.latencyMs === undefined ? undefined : formatLatency(result.latencyMs)}
              mode="info"
            />
          ))}
        </ItemGroup>
      ) : null}
      {recent && recent.results.length > resultsShown ? (
        <ItemGroup surface="none" header="none">
          <SectionActionButton
            testID="services.check.results.older"
            title={t('projects.deployments.pageOlder')}
            icon="caret-right"
            onPress={() => setResultsShown((count) => count + RESULTS_PAGE)}
          />
        </ItemGroup>
      ) : null}
      {automationSubject ? (
        <SubjectTriggersSection subject={automationSubject} subjectName={definition?.name ?? shown?.checkId ?? row.automationId} />
      ) : null}
      <ItemGroup
        title={t('projects.deployments.tabSettings')}
        testID="services.check.settings"
      >
        {definition?.targetLabel ? (
          <Item
            testID="services.check.settings.address"
            title={keyFlow ? t(`${m}.keyFlowRoutes`) : t(`${k}.address`)}
            subtitle={
              <Text variant="meta" style={styles.mono}>
                {definition.targetLabel}
              </Text>
            }
            onPress={openEditor}
          />
        ) : null}
        {keyFlow ? (
          <Item
            testID="services.check.settings.failsWhen"
            title={t(`${m}.keyFlowFailsWhen`)}
            subtitle={keyFlowRuleText(keyFlow)}
            onPress={openEditor}
          />
        ) : null}
        {expect ? (
          <Item
            testID="services.check.settings.expect"
            title={t(`${k}.expect`)}
            subtitle={expect}
            onPress={openEditor}
          />
        ) : null}
        {settings ? (
          <Item
            testID="services.check.settings.from"
            title={t(`${k}.checkFrom`)}
            subtitle={
              settings.observerMachineId === null
                ? t(`${k}.checkFromWebhook`)
                : (observer ?? undefined)
            }
            onPress={openEditor}
          />
        ) : null}
        {settings ? (
          <Item
            testID="services.check.settings.alert"
            title={t(`${k}.alertAfter`)}
            subtitle={[
              t(`${k}.alertFailures`, { count: settings.failuresBeforeAlert }),
              settings.alertChannels > 0
                ? t(`${k}.alertChannels`, { count: settings.alertChannels })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            onPress={openEditor}
          />
        ) : null}
        {seedUnavailable ? (
          <Item
            testID="services.check.settings.unavailable"
            title={t('automations.form.trigger.sourceUnavailable')}
            detail={t('common.retry')}
            onPress={retrySeed}
            showChevron={false}
          />
        ) : null}
        <Item
          testID="services.check.settings.paused"
          title={t(`${k}.paused`)}
          rightElement={
            <Switch
              testID="services.check.settings.paused.switch"
              value={!row.native.enabled}
              disabled={pausing}
              onValueChange={(value) => void setPaused(value)}
            />
          }
        />
      </ItemGroup>
    </View>
  );
}

/**
 * A Key flow's latest measurement beside its limit, then its latest error share (lab p7Flows detail): both from the
 * persisted result's measurements. Unknown keeps the slot with an em dash and says why, never a zero.
 */
function keyFlowFacts(config: NonNullable<ServiceCheckSettings['keyFlow']>, result: Readonly<{ measurements?: Readonly<{
  value?: number; errorRate?: number; requestCount?: number }> }> | null): FactStripFact[] {
  const measured = result?.measurements;
  const errorsMeasured = config.measure.kind === 'route' && config.measure.statistic === 'errorRate';
  const limit = formatServiceCheckKeyFlowValue(config, config.threshold.value);
  const noTraffic = t(`${m}.keyFlowNoTraffic`, { window: formatServiceCheckPeriod(config.windowMs) });
  const latest = measured?.value === undefined ? null : formatServiceCheckKeyFlowValue(config, measured.value);
  const facts: FactStripFact[] = [{
    key: 'response',
    label: config.measure.kind === 'route' ? (errorsMeasured ? t(`${m}.keyFlowErrors`) : config.measure.statistic)
      : config.measure.kind === 'runtime' ? config.measure.metricName : t(`${m}.keyFlowSpend`),
    value: latest ?? '—',
    detail: latest === null ? noTraffic : t(`${m}.keyFlowLatestLimit`, { limit }),
  }];
  if (config.measure.kind === 'route' && !errorsMeasured) {
    facts.push({ key: 'errors', label: t(`${m}.keyFlowErrors`),
      value: measured?.errorRate === undefined ? '—' : formatServiceCheckShare(measured.errorRate),
      detail: measured?.errorRate === undefined ? t(`${m}.keyFlowNoRequests`) : t(`${m}.latest`) });
  }
  return facts;
}

/** A Key flow's saved rule in words: "p95 above 800 ms, over 10 min". */
function keyFlowRuleText(config: NonNullable<ServiceCheckSettings['keyFlow']>): string {
  const measure = config.measure;
  const errors = measure.kind === 'route' && measure.statistic === 'errorRate';
  const value = formatServiceCheckKeyFlowValue(config, config.threshold.value);
  return t(`${m}.keyFlowRule`, {
    measure: measure.kind === 'route' ? (errors ? t(`${m}.keyFlowErrors`) : measure.statistic)
      : measure.kind === 'runtime' ? measure.metricName : t(`${m}.keyFlowSpend`),
    operator: t(config.threshold.operator === 'above' ? `${m}.keyFlowAbove` : `${m}.keyFlowBelow`),
    value,
    window: formatServiceCheckPeriod(config.windowMs),
  });
}

/** Check now runs the saved kind's public Action through the ordinary front door (policy, approval, Machine). */
function CheckNow(props: Readonly<{ run: ServiceCheckSettings['run']; scope: ManagedConfiguredCheckRow['scope'] }>) {
  const [state, setState] = React.useState<'idle' | 'running' | 'failed'>('idle');
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  const run = React.useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState('running');
    try {
      await checkNowConfiguredHealthCheck({
        subject: props.run.subject,
        check: props.run.check,
        signal: current.signal,
        serverId: props.scope.serverId,
        expectedAccountId: props.scope.accountId,
      });
      if (!current.signal.aborted) setState('idle');
    } catch {
      if (!current.signal.aborted) setState('failed');
    }
  }, [props.run, props.scope.accountId, props.scope.serverId]);
  // The person can stop waiting: the Action's own signal is aborted; a result its Machine still sends arrives as usual.
  const cancel = React.useCallback(() => {
    controller.current?.abort();
    setState('idle');
  }, []);
  return (
    <View style={styles.checkNow}>
      <RoundButton
        testID="services.check.checkNow"
        display="secondary"
        title={t(`${k}.checkNow`)}
        loading={state === 'running'}
        onPress={() => void run()}
      />
      {state === 'running' ? (
        // While it waits it says so, and after a few seconds how long (the loading state's own "Still waiting" clock).
        <SurfaceStateCard testID="services.check.checkNow.pending" kind="loading" size="line"
          title={t(`${k}.checkNowRunning`)}
          action={{ label: t('common.cancel'), onPress: cancel, testID: 'services.check.checkNow.cancel' }} />
      ) : null}
      {state === 'failed' ? (
        <Text variant="meta" style={styles.metaText} testID="services.check.checkNow.failed">
          {t(`${k}.checkNowFailed`)}
        </Text>
      ) : null}
    </View>
  );
}

// A failing Check is a failure page like a receipt, an Inbox notice or a run: the task default (investigate) leads,
// then the subject's own records. 'subjectOnly' is the Environment page's mode, whose records set things up.
const CHECK_AGENT_ACTIONS = { agentActions: 'withDefault' } as const;

/** Investigate a failing Check through the one failure-investigation owner, on the subject its source watches. */
function CheckInvestigate(props: Readonly<{ subject: NonNullable<ReturnType<typeof serviceCheckInvestigationSubject>>; serverId: string }>) {
  const investigation = useInvestigateFailure(props.subject, CHECK_AGENT_ACTIONS);
  // Until the catalog answers, the one Investigate the failure pages show (MachineServicePage's fallback).
  const fallback = React.useMemo((): readonly InvestigationAgentActionButtonModel[] => [
    { label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: true },
  ], []);
  const actions = investigation.actions ?? fallback;
  return (
    <View style={styles.investigate} testID="services.check.investigate">
      <InvestigationAgentActionButtons
        actions={actions}
        pending={investigation.pending}
        compact={false}
        onLaunch={(mode, actionId) => {
          void investigation.launch(mode, actionId);
        }}
      />
      {investigation.showOutcome && investigation.outcome ? (
        <InvestigationOutcomeBanner
          outcome={investigation.outcome}
          serverId={props.serverId}
          testID="services.check.investigate.outcome"
          onChoosePlacement={investigation.investigateWithPlacement}
          pending={investigation.pending}
          placement="inline"
        />
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create((theme) => ({
  metaText: { color: theme.colors.text.secondary },
  // The button keeps its own width; the waiting line under it takes the room it needs.
  checkNow: { gap: theme.space.s4, alignItems: 'flex-start' },
  investigate: { gap: theme.space.s8, alignItems: 'flex-start' },
  actions: { paddingTop: theme.space.s12, flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'flex-start' },
  hero: { gap: theme.space.s8 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.s12 },
  captionText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  mono: { ...Typography.mono(), color: theme.colors.text.secondary },
}));

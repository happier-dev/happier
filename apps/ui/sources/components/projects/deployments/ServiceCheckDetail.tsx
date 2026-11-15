import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Heatmap, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';

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
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Switch } from '@/components/ui/forms/Switch';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { updateWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';

import {
  readServiceCheckFacts,
  readServiceCheckRecent,
  readServiceCheckSettings,
  serviceCheckShownDefinition,
  serviceCheckInvestigationSubject,
  serviceCheckHistoryStrip,
  serviceCheckResultWord,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  type ServiceCheckDay,
  type ServiceCheckSettings,
  formatServiceCheckLatency,
  formatServiceCheckPeriod,
  formatServiceCheckUnit,
} from './serviceCheckPresentation';

const k = 'projects.deployments.services' as const;
const STRIP_ROWS = [{ id: 'days', label: '' }] as const;

const unit = formatServiceCheckUnit;
const formatLatency = formatServiceCheckLatency;
const formatPeriod = formatServiceCheckPeriod;
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
/** The Response sparkline reads the last results the lab names ("last 20 results"). */
const SPARK_RESULTS = 20;
const percentText = (percent: number | null) =>
  percent === null ? '—' : `${Math.round(percent * 10) / 10}%`;

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

function dayColor(
  day: ServiceCheckDay,
  colors: Readonly<{
    up: string;
    down: string;
    degraded: string;
    empty: string;
  }>,
) {
  return day.tone === 'down'
    ? colors.down
    : day.tone === 'degraded'
      ? colors.degraded
      : day.tone === 'up'
        ? colors.up
        : colors.empty;
}

/**
 * One Check's detail (pfc-redesign rdDet-chk), the same body in the details pane and as its page: who checks what
 * and how often, whether it is failing first, the last result, response and 30-day uptime, each target's latest result,
 * then its settings. Every fact is the owner's: configured health results (with UPTIME-HISTORY's 30 days) and the
 * saved source; settings open the Check's editor.
 */
export function ServiceCheckDetail(
  props: Readonly<{ row: ManagedConfiguredCheckRow; nowMs?: number }>,
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
  const observer = useServerScopedMachineLabel(
    serverId,
    settings?.observerMachineId ?? null,
  );
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
  const colors = {
    up: theme.colors.state.success.foreground,
    down: theme.colors.state.danger.foreground,
    degraded: theme.colors.state.warning.foreground,
    empty: theme.colors.surface.inset,
  };
  const statusText = row.native.enabled
    ? serviceCheckStatusWord(facts.status)
    : t(`${k}.paused`);
  // Kind, target and cadence come from the inventory's definition facts; the page never reads a target itself.
  const head = serviceCheckShownDefinition(row.definitionFacts, shown?.checkId ?? null);
  const definition = head.kind === 'available' ? head.definition : null;
  const meta = [
    ...(definition
      ? [
          definition.name,
          definition.targetLabel,
          observer
            ? t(`${k}.checkEvery`, { period: formatPeriod(definition.periodMs), machine: observer })
            : t(`${k}.checkEveryAnywhere`, { period: formatPeriod(definition.periodMs) }),
        ]
      : [head.kind === 'loading' ? t('common.loading') : t('automations.form.trigger.sourceUnavailable')]),
    statusText,
  ].filter((part): part is string => Boolean(part));
  const lastTone = shown ? serviceCheckStatusTone(shown.result.status) : null;
  const recent = shown ? readServiceCheckRecent(shown) : null;
  const cause = shown?.result.cause ?? null;
  const causeText = cause
    ? [
        cause.httpStatus !== undefined && cause.expectStatus !== undefined && cause.httpStatus !== cause.expectStatus
          ? t(`${k}.causeAnswered`, { status: String(cause.httpStatus), expected: String(cause.expectStatus) })
          : null,
        cause.keywordMatched === false ? t(`${k}.causeKeywordMissing`) : null,
        cause.reason ?? null,
        t(cause.vantage === 'outside' ? `${k}.causeFromOutside` : `${k}.causeFromSameMachine`),
      ].filter((part): part is string => Boolean(part)).join(' · ')
    : null;
  const latencies = recent
    ? recent.results.slice(0, SPARK_RESULTS).flatMap((result) => (result.latencyMs === undefined ? [] : [result])).reverse()
    : [];
  const [resultsShown, setResultsShown] = React.useState(RESULTS_PAGE);
  const stripFacts: FactStripFact[] = [
    {
      key: 'last',
      label: t(`${k}.lastResult`),
      value: (shown ? serviceCheckResultWord(shown.result.status) : null) ?? '—',
      ...(lastTone === 'danger' ? { tone: 'danger' as const } : lastTone === 'warning' ? { tone: 'attention' as const } : {}),
      ...(shown
        ? {
            detail: [
              shown.result.latencyMs === undefined
                ? null
                : formatLatency(shown.result.latencyMs),
              formatClock(shown.result.observedAt),
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : {}),
    },
    ...(recent?.failingSince !== null && recent?.failingSince !== undefined
      ? [
          {
            key: 'failingFor',
            label: t(`${k}.failingFor`),
            value: formatSpan(nowMs - recent.failingSince),
            ...(recent.failureStreak !== null ? { detail: t(`${k}.failureStreak`, { count: recent.failureStreak }) } : {}),
          },
        ]
      : []),
    {
      key: 'response',
      label: t(`${k}.response`),
      value:
        shown?.result.latencyMs === undefined || !shown
          ? '—'
          : formatLatency(shown.result.latencyMs),
      ...(latencies.length >= 2
        ? {
            detail: (
          <StackedSeriesChart
            theme={pluginTheme}
            label=""
            series={[
              {
                id: 'latency',
                label: t(`${k}.response`),
                color: theme.colors.text.secondary,
                points: latencies.map((result) => ({ id: String(result.observedAt), x: result.observedAt, y: result.latencyMs ?? null })),
              },
            ]}
            variant="line"
            size="inline"
            fitLine
            showAxis={false}
            showLegend={false}
            showGrid={false}
            showReadout={false}
            decorative
          />
        ),
          }
        : {}),
    },
    {
      key: 'uptime',
      label: t(`${k}.lastDays`),
      value: percentText(facts.uptimePercent),
    },
  ];
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
      <ItemGroup surface="none" testID="services.check.head">
        <Text
          variant="meta"
          style={styles.metaText}
          testID="services.check.meta"
        >
          {meta.join(' · ')}
        </Text>
        <View style={styles.actions}>
          {settings ? <CheckNow run={settings.run} scope={row.scope} /> : null}
          {failing && investigateSubject ? (
            <CheckInvestigate subject={investigateSubject} serverId={serverIdForSubject} />
          ) : null}
        </View>
      </ItemGroup>
      {failing ? (
        <AttentionBanner
          testID="services.check.failing"
          tone={serviceCheckStatusTone(facts.status) ?? 'warning'}
          title={t(
            facts.status === 'down'
              ? `${k}.checkFailingTitle`
              : `${k}.checkDegradedTitle`,
          )}
          {...(causeText ? { description: causeText } : {})}
        />
      ) : null}
      <ItemGroup surface="none" testID="services.check.facts">
        <FactStrip facts={stripFacts} layout="columns" divided />
      </ItemGroup>
      {facts.checks.map((check) => {
        const strip = check.history
          ? serviceCheckHistoryStrip(check.history, nowMs)
          : null;
        return strip ? (
          <ItemGroup
            key={check.checkId}
            testID={`services.check.history.${check.checkId}`}
            surface="none"
          >
            <View style={styles.strip}>
              <Heatmap
                theme={pluginTheme}
                label={t(`${k}.lastDays`)}
                layout="strip"
                size="full"
                rows={STRIP_ROWS}
                columns={strip.map((day) => ({
                  id: String(day.dayStartAt),
                  label: '',
                }))}
                cells={strip.map((day) => ({
                  id: String(day.dayStartAt),
                  row: 'days',
                  column: String(day.dayStartAt),
                  label: new Date(day.dayStartAt).toLocaleDateString(
                    undefined,
                    { month: 'short', day: 'numeric', timeZone: 'UTC' },
                  ),
                  value: day.uptimePercent,
                  valueLabel:
                    day.uptimePercent === null
                      ? t('projects.deployments.healthNotChecked')
                      : `${day.uptimePercent}%`,
                  color: dayColor(day, colors),
                }))}
              />
            </View>
          </ItemGroup>
        ) : null;
      })}
      {recent ? (
        <ItemGroup
          title={t(`${k}.recentResults`)}
          description={t(recent.partial ? `${k}.recentResultsPartial` : `${k}.recentResultsBody`)}
          testID="services.check.results"
        >
          {recent.results.slice(0, resultsShown).map((result) => (
            <Item
              key={result.observedAt}
              testID={`services.check.result.${result.observedAt}`}
              title={serviceCheckResultWord(result.status) ?? '—'}
              subtitle={observer ? t(`${k}.resultFrom`, { machine: observer }) : undefined}
              detail={[
                result.cause?.httpStatus === undefined ? null : String(result.cause.httpStatus),
                result.latencyMs === undefined ? null : formatLatency(result.latencyMs),
                formatClock(result.observedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
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
      <ItemGroup
        title={t('projects.deployments.tabSettings')}
        testID="services.check.settings"
      >
        {definition?.targetLabel ? (
          <Item
            testID="services.check.settings.address"
            title={t(`${k}.address`)}
            subtitle={
              <Text variant="meta" style={styles.mono}>
                {definition.targetLabel}
              </Text>
            }
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
  return (
    <View style={styles.checkNow}>
      <RoundButton
        testID="services.check.checkNow"
        display="secondary"
        title={t(`${k}.checkNow`)}
        loading={state === 'running'}
        onPress={() => void run()}
      />
      {state === 'failed' ? (
        <Text variant="meta" style={styles.metaText} testID="services.check.checkNow.failed">
          {t(`${k}.checkNowFailed`)}
        </Text>
      ) : null}
    </View>
  );
}

const CHECK_AGENT_ACTIONS = { agentActions: 'subjectOnly' } as const;

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
  checkNow: { gap: theme.space.s4 },
  investigate: { gap: theme.space.s8, alignItems: 'flex-start' },
  actions: { paddingTop: theme.space.s12, flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'flex-start' },
  strip: { paddingHorizontal: theme.space.s16 },
  mono: { ...Typography.mono(), color: theme.colors.text.secondary },
}));

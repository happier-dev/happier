import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import {
  InvestigationAgentActionButtons,
  type InvestigationAgentActionButtonModel,
} from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { checkNowConfiguredHealthCheck } from '@/components/store/inventory/configuredHealthResults';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
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
  serviceCheckAutomationExecutionContext,
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
  serviceCheckStale,
  type ServiceCheckSettings,
  formatServiceCheckLatency,
  formatServiceCheckPeriod,
  formatServiceCheckUnit,
} from './serviceCheckPresentation';
import { ServiceCheckBars, type ServiceCheckBarCell } from './ServiceCheckBars';
import { ServiceCheckKeyFlowSection } from './ServiceCheckKeyFlowSection';
import { useEnvironmentName } from './useEnvironmentName';
import { formatServiceCheckMoment } from './formatServiceCheckMoment';
import { useServiceCheckOfflineObservers } from './useServiceCheckOfflineObservers';

const k = 'projects.deployments.services' as const;
const m = 'projects.deployments.monitoring' as const;

const unit = formatServiceCheckUnit;
const formatLatency = formatServiceCheckLatency;
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

type CheckSetting = 'address' | 'expect' | 'from' | 'alert' | 'failsWhen';

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
export function useServiceCheckMeta(row: ManagedConfiguredCheckRow | null): string | null {
  const facts = row ? serviceCheckListFacts(row) : null;
  const observer = useServerScopedMachineLabel(row?.scope.serverId ?? null, facts?.observerMachineId ?? null);
  const head = row ? serviceCheckShownDefinition(row.definitionFacts, null) : null;
  const definition = head?.kind === 'available' ? head.definition : null;
  const keyFlow = definition?.keyFlow ?? null;
  const environment = useEnvironmentName(row?.scope.serverId ?? null, keyFlow?.environmentId ?? null).name;
  if (!row || !facts || row.definitionFacts.kind === 'loading') return null;
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
  return [facts.kind, ...flow].filter(Boolean).join(' · ') || null;
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
    /** Its header (the page's, or the details pane's band) says what the Check is, under the name (lab A3). */
    metaInHeader?: boolean;
    /**
     * The Check page draws its header through this, with the check's actions at its end (lab A3: Check now and ⋯); the
     * pane keeps them at the top of the body under its own title.
     */
    renderHeader?: (actions: React.ReactNode) => React.ReactNode;
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
  const checkNow = useCheckNow(settings?.run ?? null, row.scope);
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
  const addressRowKey = `${row.automationId}\n${row.triggerId}`;
  const [addressEditState, setAddressEdit] = React.useState<Readonly<{
    rowKey: string;
    checkId: string;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
    field: CheckSetting;
    submission?: Readonly<{
      trigger: NonNullable<Parameters<typeof updateWorkflowTrigger>[0]['patch']['trigger']>;
      error?: ReturnType<typeof resolveWorkflowProblemPresentation>;
    }>;
  }> | null>(null);
  const addressEdit = addressEditState?.rowKey === addressRowKey ? addressEditState : null;
  const addressLifetime = addressEdit?.lifetime;
  const canEditAddress = Boolean(addressLifetime?.isCurrent() && areServerAccountScopesEqual(addressLifetime.scope, row.scope));
  const openEditor = (field: CheckSetting = 'address') => {
    if (addressEdit?.submission && !addressEdit.submission.error) return;
    const checkId = settings?.run.check.checkId ?? definition?.checkId;
    if (!checkId) return;
    setAddressEdit({ rowKey: addressRowKey, checkId, field, lifetime: captureActiveServerAccountScopeLifetime() });
  };
  const [savedRevision, setSavedRevision] = React.useState<Readonly<{ rowKey: string; revision: number }> | null>(null);
  const saveSource = (trigger: NonNullable<Parameters<typeof updateWorkflowTrigger>[0]['patch']['trigger']>) => {
    if (!seed || !addressEdit || !addressLifetime || !canEditAddress) return;
    const saving = { ...addressEdit, submission: { trigger } };
    setAddressEdit(saving);
    const expectedRevision = savedRevision?.rowKey === addressRowKey
      ? Math.max(row.native.templateVersion, savedRevision.revision) : row.native.templateVersion;
    void updateWorkflowTrigger({ automationId: seed.automationId, triggerId: seed.triggerId,
      expectedRevision, patch: { trigger } }, { accountLifetime: addressLifetime })
      .then(({ set }) => {
        if (!addressLifetime.isCurrent()) return;
        setSavedRevision({ rowKey: addressRowKey, revision: set.revision });
        setAddressEdit(current => current === saving ? null : current);
        retrySeed();
      }, error => {
        if (addressLifetime.isCurrent()) setAddressEdit(current => current === saving
          ? { ...saving, submission: { trigger, error: resolveWorkflowProblemPresentation(error) } } : current);
      });
  };
  const finishAddressSetup: NonNullable<React.ComponentProps<typeof PluginEventAutomationEditor>['savedSourceSetup']>['onSettled'] = result => {
    if (result.kind === 'cancelled') { setAddressEdit(null); return; }
    const { enabled: _enabled, ...trigger } = result.trigger;
    saveSource(trigger);
  };
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
  const rowForPresence = React.useMemo(() => [row], [row]);
  // The pane says its Machine is offline at rest, not only once an editor opens (PAGE-ACCEPT-176 R10-D4).
  const offlineObservers = useServiceCheckOfflineObservers(rowForPresence, row.scope, true);
  const stale = serviceCheckStale(row, offlineObservers);
  const failing =
    row.native.enabled &&
    !stale &&
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
    label: bar.observedAt === null ? t('projects.deployments.healthNotChecked') : formatServiceCheckMoment(bar.observedAt),
    ...(bar.status ? { valueLabel: serviceCheckStatusWord(bar.status) } : {}),
  }));
  const heroKept = heroBars.bars.filter((bar) => bar.observedAt !== null).length;
  const [resultsShown, setResultsShown] = React.useState(RESULTS_PAGE);
  // The facts go two to a row where their columns would squeeze a value onto two lines (a details pane, a phone).
  const [factsWidth, setFactsWidth] = React.useState<number | null>(null);
  // Response, its average, today's and the 30-day uptime (lab A3); the state and when it was checked stand under the bars.
  const stripFacts: FactStripFact[] = [
    ...(!stale && recent?.failingSince !== null && recent?.failingSince !== undefined
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
  const from = settings?.observerMachineId === null ? t(`${k}.checkFromWebhook`) : observer;
  const alert = settings ? [
    t(`${k}.alertFailures`, { count: settings.failuresBeforeAlert }),
    settings.alertChannels ? t(`${k}.alertChannels`, { count: settings.alertChannels }) : null,
  ].filter(Boolean).join(' · ') : null;
  const editField = addressEdit?.field;
  const settingInteraction = (field: CheckSetting, editable = true) => !editable || editField === field
    ? { mode: 'info' as const }
    : { onPress: () => openEditor(field) };
  const observerId = settings?.observerMachineId ?? (row.definitionFacts.kind === 'available' ? row.definitionFacts.observerMachineId : null);
  const offlineObserver = observerId !== null && offlineObservers.has(observerId) ? observerId : null;
  const showRecovery = (title: string, action: NonNullable<React.ComponentProps<typeof SurfaceStateCard>['action']>) => (
    <SurfaceStateCard testID="services.check.settings.recovery" size="line" kind="unavailable" title={title} action={action} />
  );
  const submitted = addressEdit?.submission;
  const checkEditor = addressEdit ? <View testID="services.check.settings.editor">
    {submitted?.error ? showRecovery(submitted.error.message, {
      label: t('common.retry'), onPress: () => saveSource(submitted.trigger),
    }) : submitted ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
      // Name the Machine and the way out, not the mechanism (PAGE-ACCEPT-176 R9-D3).
      : offlineObserver && editField !== 'from' ? showRecovery(t(`${k}.checkMachineOffline`, { machine: observer ?? t('approvals.machineNotKnown') }), {
        label: t('runs.openMachine'),
        onPress: () => router.push(machinePageHref({ door: 'rail', target: { machineId: offlineObserver, serverId } })),
      })
        : seed && canEditAddress ? (
          <PluginEventAutomationEditor key={`${addressEdit.checkId}/${addressEdit.field}`}
            automationId={seed.automationId} clientId={seed.triggerId}
            seed={seed} value={null} serverId={serverId}
            authoringMachineId={seed.observation.kind === 'durablePush' ? null : seed.observation.watcherMaterializationRef.machineId}
            savedSourceSetup={{
              input: { selectedCheckId: addressEdit.checkId },
              chooseWatcher: addressEdit.field === 'from' && seed.observation.kind !== 'durablePush',
              onSettled: finishAddressSetup,
              renderUnavailable: (retry, machineName) => showRecovery(
                t(`${k}.checkEditUnavailableOnMachine`, { machine: machineName ?? t('machine.unnamedMachine') }),
                { label: t('common.retry'), onPress: retry }),
            }}
            onComplete={() => {}}
            onCancel={() => setAddressEdit(null)} />
        ) : seedUnavailable || !canEditAddress ? showRecovery(t('projects.deployments.services.checkEditSourceUnreachable'), {
          label: t('common.retry'), onPress: retrySeed,
        }) : <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />}
  </View> : null;

  return (
    <View testID={`services.check.${row.automationId}.${row.triggerId}`}>
      {props.renderHeader ? props.renderHeader(
        <View style={styles.headerActions}>
          {settings ? <CheckNowButton checkNow={checkNow} disabled={offlineObserver !== null} /> : null}
          <CheckMenu onEdit={() => openEditor()} />
        </View>,
      ) : null}
      {offlineObserver && !addressEdit ? <ItemGroup surface="none" header="none">
        <SurfaceStateCard testID="services.check.offline" size="line" kind="unavailable"
          title={t(`${k}.checkMachineOffline`, { machine: observer ?? t('approvals.machineNotKnown') })}
          action={{ label: t('runs.openMachine'), onPress: () => router.push(machinePageHref({ door: 'rail',
            target: { machineId: offlineObserver, serverId } })) }} />
      </ItemGroup> : null}
      {/* The head holds the meta line (beside the pane's title) and the check's actions; on the page (whose header holds
          the actions) it holds only what Check now says while it waits and Investigate, else nothing, so the bars stand
          right under the header (lab A3). */}
      {(props.metaInHeader || meta === null)
        && (props.renderHeader ? checkNow.state === 'idle' : !settings) && !(failing && investigateSubject) ? null : (
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
          {settings ? (
            <View style={styles.checkNow}>
              {props.renderHeader ? null : (
                <View style={styles.headerActions}>
                  <CheckNowButton checkNow={checkNow} disabled={offlineObserver !== null} />
                  <CheckMenu onEdit={() => openEditor()} />
                </View>
              )}
              <CheckNowStatus checkNow={checkNow} />
            </View>
          ) : null}
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
                {stale
                  ? t(`${m}.staleState`, { time: formatServiceCheckMoment(shown.result.observedAt, nowMs) })
                  : [statusText, t(`${m}.checkedAt`, { time: formatServiceCheckMoment(shown.result.observedAt) })].join(' · ')}
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
                label: formatServiceCheckMoment(result.observedAt) })),
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
                formatServiceCheckMoment(result.observedAt),
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
        <SubjectTriggersSection
          subject={automationSubject}
          subjectName={definition?.name ?? shown?.checkId ?? row.automationId}
          executionContext={serviceCheckAutomationExecutionContext(settings)}
        />
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
            {...settingInteraction('address', definition.domainId === null || Boolean(keyFlow))}
          />
        ) : null}
        {editField === 'address' ? checkEditor : null}
        {keyFlow ? (
          <Item
            testID="services.check.settings.failsWhen"
            title={t(`${m}.keyFlowFailsWhen`)}
            subtitle={keyFlowRuleText(keyFlow)}
            {...settingInteraction('failsWhen')}
          />
        ) : null}
        {editField === 'failsWhen' ? checkEditor : null}
        {expect ? (
          <Item
            testID="services.check.settings.expect"
            title={t(`${k}.expect`)}
            subtitle={expect}
            {...settingInteraction('expect')}
          />
        ) : null}
        {editField === 'expect' ? checkEditor : null}
        {settings ? (
          <Item
            testID="services.check.settings.from"
            title={t(`${k}.checkFrom`)}
            subtitle={from ?? undefined}
            {...settingInteraction('from')}
          />
        ) : null}
        {editField === 'from' ? checkEditor : null}
        {settings ? (
          <Item
            testID="services.check.settings.alert"
            title={t(`${k}.alertAfter`)}
            subtitle={alert ?? undefined}
            {...settingInteraction('alert')}
          />
        ) : null}
        {editField === 'alert' ? checkEditor : null}
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
type CheckNowControl = Readonly<{ state: 'idle' | 'running' | 'failed'; run: () => void; cancel: () => void }>;

/** One Check now per page: the button (header or body) and what it says while it waits share this state. */
function useCheckNow(run: ServiceCheckSettings['run'] | null, scope: ManagedConfiguredCheckRow['scope']): CheckNowControl {
  const [state, setState] = React.useState<'idle' | 'running' | 'failed'>('idle');
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  const start = React.useCallback(async () => {
    if (!run) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState('running');
    try {
      await checkNowConfiguredHealthCheck({
        subject: run.subject,
        check: run.check,
        signal: current.signal,
        serverId: scope.serverId,
        expectedAccountId: scope.accountId,
      });
      if (!current.signal.aborted) setState('idle');
    } catch {
      if (!current.signal.aborted) setState('failed');
    }
  }, [run, scope.accountId, scope.serverId]);
  // The person can stop waiting: the Action's own signal is aborted; a result its Machine still sends arrives as usual.
  const cancel = React.useCallback(() => {
    controller.current?.abort();
    setState('idle');
  }, []);
  return React.useMemo(() => ({ state, run: () => void start(), cancel }), [cancel, start, state]);
}

function CheckNowButton(props: Readonly<{ checkNow: CheckNowControl; disabled?: boolean }>) {
  return (
    <RoundButton
      testID="services.check.checkNow"
      display="secondary"
      title={t(`${k}.checkNow`)}
      disabled={props.disabled}
      loading={props.checkNow.state === 'running'}
      onPress={props.checkNow.run}
    />
  );
}

function CheckNowStatus(props: Readonly<{ checkNow: CheckNowControl }>) {
  const { state, cancel } = props.checkNow;
  // While it waits it says so, and after a few seconds how long (the loading state's own "Still waiting" clock).
  if (state === 'running') {
    return (
      <SurfaceStateCard testID="services.check.checkNow.pending" kind="loading" size="line"
        title={t(`${k}.checkNowRunning`)}
        action={{ label: t('common.cancel'), onPress: cancel, testID: 'services.check.checkNow.cancel' }} />
    );
  }
  return state === 'failed' ? (
    <Text variant="meta" style={styles.metaText} testID="services.check.checkNow.failed">
      {t(`${k}.checkNowFailed`)}
    </Text>
  ) : null;
}

/** The Check page's ⋯ (lab A3): the check's own editor, where its target, cadence and alerts change. */
function CheckMenu(props: Readonly<{ onEdit: () => void }>) {
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(() => [{ id: 'edit', testID: 'services.check.menu.edit', title: t(`${k}.editCheck`) }], []);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('common.more')}
      onSelect={(id) => { if (id === 'edit') props.onEdit(); }}
      trigger={({ toggle }) => (
        <IconButton testID="services.check.menu" iconName="dots-three" variant="plain"
          accessibilityLabel={t('common.more')} onPress={toggle} />
      )}
    />
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  investigate: { gap: theme.space.s8, alignItems: 'flex-start' },
  actions: { paddingTop: theme.space.s12, flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, alignItems: 'flex-start' },
  hero: { gap: theme.space.s8 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.s12 },
  captionText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  mono: { ...Typography.mono(), color: theme.colors.text.secondary },
}));

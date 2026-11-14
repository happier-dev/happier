import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  InvestigationAgentActionButtons,
  type InvestigationAgentActionButtonModel,
} from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { Switch } from '@/components/ui/forms/Switch';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';

import {
  readServiceCheckFacts,
  readServiceCheckSettings,
  serviceCheckInvestigationSubject,
  serviceCheckHistoryStrip,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
  type ServiceCheckDay,
  type ServiceCheckSettings,
} from './serviceCheckPresentation';

const k = 'projects.deployments.services' as const;
const STRIP_ROWS = [{ id: 'days', label: '' }] as const;

const unit = (
  value: number,
  name: 'millisecond' | 'second' | 'minute' | 'hour',
) =>
  new Intl.NumberFormat(getPreferredLanguage(), {
    style: 'unit',
    unit: name,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
const formatLatency = (ms: number) =>
  ms < 1000 ? unit(Math.round(ms), 'millisecond') : unit(ms / 1000, 'second');
const formatPeriod = (ms: number) =>
  ms % 3_600_000 === 0
    ? unit(ms / 3_600_000, 'hour')
    : ms % 60_000 === 0
      ? unit(ms / 60_000, 'minute')
      : unit(ms / 1000, 'second');
const formatClock = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), {
    hour: 'numeric',
    minute: '2-digit',
  });
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
        await (paused
          ? sync.pauseAutomation(row.automationId)
          : sync.resumeAutomation(row.automationId));
      } finally {
        setPausing(false);
      }
    },
    [row.automationId],
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
  const meta = [
    settings?.kind ? kindWord(settings.kind) : null,
    settings?.label ?? row.native.description ?? null,
    settings
      ? observer
        ? t(`${k}.checkEvery`, {
            period: formatPeriod(settings.periodMs),
            machine: observer,
          })
        : t(`${k}.checkEveryAnywhere`, {
            period: formatPeriod(settings.periodMs),
          })
      : null,
    statusText,
  ].filter((part): part is string => Boolean(part));
  const lastTone = shown ? serviceCheckStatusTone(shown.result.status) : null;
  const stripFacts: FactStripFact[] = [
    {
      key: 'last',
      label: t(`${k}.lastResult`),
      value: shown
        ? serviceCheckStatusWord(shown.result.status)
        : serviceCheckStatusWord(facts.status),
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
    {
      key: 'response',
      label: t(`${k}.response`),
      value:
        shown?.result.latencyMs === undefined || !shown
          ? '—'
          : formatLatency(shown.result.latencyMs),
      detail: t(`${k}.lastResult`),
    },
    {
      key: 'uptime',
      label: t(`${k}.lastDays`),
      value: percentText(facts.uptimePercent),
      detail: t(`${k}.uptimeWord`),
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
        {failing && investigateSubject ? (
          <CheckInvestigate subject={investigateSubject} serverId={serverIdForSubject} />
        ) : null}
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
      {facts.checks.length > 0 ? (
        <ItemGroup
          title={t(`${k}.latestResults`)}
          description={t(`${k}.latestResultsBody`)}
          testID="services.check.results"
        >
          {facts.checks.map((check) => (
            <Item
              key={check.checkId}
              testID={`services.check.result.${check.checkId}`}
              title={serviceCheckStatusWord(check.result.status)}
              subtitle={
                observer
                  ? t(`${k}.resultFrom`, { machine: observer })
                  : undefined
              }
              detail={[
                check.result.latencyMs === undefined
                  ? null
                  : formatLatency(check.result.latencyMs),
                formatClock(check.result.observedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
              mode="info"
            />
          ))}
        </ItemGroup>
      ) : null}
      <ItemGroup
        title={t('projects.deployments.tabSettings')}
        testID="services.check.settings"
      >
        {settings?.address ? (
          <Item
            testID="services.check.settings.address"
            title={t(`${k}.address`)}
            subtitle={
              <Text variant="meta" style={styles.mono}>
                {settings.address}
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
    <View style={styles.actions} testID="services.check.investigate">
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

function kindWord(kind: NonNullable<ServiceCheckSettings['kind']>): string {
  switch (kind) {
    case 'http':
      return t(`${k}.checkHttp`);
    case 'certificate':
      return t(`${k}.checkCertificate`);
    case 'tcp':
      return t(`${k}.checkTcp`);
    case 'dns':
      return t(`${k}.checkDns`);
    case 'heartbeat':
      return t(`${k}.checkHeartbeat`);
  }
}

const styles = StyleSheet.create((theme) => ({
  metaText: { color: theme.colors.text.secondary },
  actions: { paddingTop: theme.space.s12, gap: theme.space.s8, alignItems: 'flex-start' },
  strip: { paddingHorizontal: theme.space.s16 },
  mono: { ...Typography.mono(), color: theme.colors.text.secondary },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
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

import {
  readServiceCheckFacts,
  readServiceCheckSettings,
  serviceCheckHistoryStrip,
  type ServiceCheckDay,
  type ServiceCheckSettings,
  type ServiceCheckStatus,
} from './serviceCheckPresentation';

const k = 'projects.deployments.services' as const;
const STRIP_ROWS = [{ id: 'days', label: '' }] as const;

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

/** The saved source behind this Check, read once while its detail is open, through the automation edit-seed owner. */
function useCheckSeed(
  row: ManagedConfiguredCheckRow,
): PluginEventAutomationEditSeed | null {
  const key = `${row.automationId}\n${row.triggerId}`;
  const [read, setRead] = React.useState<SeedRead | null>(null);
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
  }, [key, row.automationId, row.triggerId]);
  return read?.key === key ? read.seed : null;
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
  const seed = useCheckSeed(row);
  const shown =
    facts.checks.find(
      (check) =>
        check.result.status === 'down' || check.result.status === 'degraded',
    ) ??
    facts.checks[0] ??
    null;
  const settings = readServiceCheckSettings(seed, shown?.checkId ?? null);
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
    (facts.status === 'down' || facts.status === 'degraded');
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
  const stripFacts: FactStripFact[] = [
    {
      key: 'last',
      label: t(`${k}.lastResult`),
      value: shown
        ? serviceCheckStatusWord(shown.result.status)
        : serviceCheckStatusWord(facts.status),
      ...(shown?.result.status === 'down'
        ? { tone: 'danger' as const }
        : shown?.result.status === 'degraded'
          ? { tone: 'attention' as const }
          : {}),
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
      <View style={styles.meta}>
        <Text
          variant="meta"
          style={styles.metaText}
          testID="services.check.meta"
        >
          {meta.join(' · ')}
        </Text>
      </View>
      {failing ? (
        <AttentionBanner
          testID="services.check.failing"
          tone={facts.status === 'down' ? 'danger' : 'warning'}
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
  meta: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4 },
  metaText: { color: theme.colors.text.secondary },
  strip: { paddingHorizontal: theme.space.s16 },
  mono: { ...Typography.mono(), color: theme.colors.text.secondary },
}));

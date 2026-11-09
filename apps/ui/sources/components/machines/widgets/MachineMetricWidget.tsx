import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import * as React from 'react';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import type { MachineSummaryMetric } from '@/components/machines/summary/machineSummaryStripModel';
import { CpuTile } from '@/components/machines/vitals/CpuTile';
import { VitalsTileOpenContext, VitalsTileRoomContext, type VitalsTileRoom } from '@/components/machines/vitals/VitalsSheet';
import { DiskTile } from '@/components/machines/vitals/DiskTile';
import { MemoryTile } from '@/components/machines/vitals/MemoryTile';
import { NetworkTile } from '@/components/machines/vitals/NetworkTile';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { MachineVitalsRange } from '@/sync/domains/machines/resources/machineRpc';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { EMPTY_MACHINE_RESOURCE_STATE, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { resolveMetricWarningTone } from '@/components/machines/vitals/machineVitalsPresentation';
import { useWidgetFrameBodyIdentity, type WidgetFrameBodyIdentity } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import {
  MachineWidgetColumn,
  MachineWidgetState,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetFreshness,
  type MachineWidgetMachineFacts,
  type MachineWidgetTarget,
} from './machineWidgetKit';
import { useMachineWidgetVitalsView } from './machineWidgetVitalsView';

export type MachineMetricWidgetMetric =
  | 'cpu'
  | 'memory'
  | 'disk_free'
  | 'network';
export type MachineMetricWidgetConfig = Readonly<{
  metric: MachineMetricWidgetMetric;
  range: MachineVitalsRange;
  volume: string | null;
  warnAbove: number | null;
}>;

/** The widget's own choices, with the descriptor's defaults (CPU over the last hour). */
export function readMachineMetricWidgetConfig(
  input: Readonly<Record<string, JsonValue>>,
): MachineMetricWidgetConfig {
  const metric =
    input.metric === 'memory' ||
    input.metric === 'disk_free' ||
    input.metric === 'network'
      ? input.metric
      : 'cpu';
  const range =
    input.range === '24h' || input.range === '7d' ? input.range : '1h';
  const volume =
    typeof input.volume === 'string' && input.volume.length > 0
      ? input.volume
      : null;
  const warnAbove =
    typeof input.warnAbove === 'number' && Number.isFinite(input.warnAbove)
      ? input.warnAbove
      : null;
  return { metric, range, volume, warnAbove };
}

const STRIP_METRIC: Readonly<
  Record<MachineMetricWidgetMetric, MachineSummaryMetric>
> = {
  cpu: 'cpu',
  memory: 'memory',
  disk_free: 'disk',
  network: 'network',
};

/** Where the number opens: CPU and memory to Processes sorted by them, disk to Storage on its volume. */
function metricTab(config: MachineMetricWidgetConfig): MachinePageTabParams {
  if (config.metric === 'cpu' || config.metric === 'memory')
    return { id: 'processes', sort: config.metric };
  if (config.metric === 'disk_free')
    return config.volume
      ? { id: 'storage', volumeId: config.volume }
      : { id: 'storage' };
  return { id: 'overview' };
}

/** What a Metric is called in its frame (lab `rw` M: "CPU" with the CPU mark), instead of the generic "Metric". */
const METRIC_FRAME_MARK = {
  cpu: 'cpu',
  memory: 'stack',
  disk_free: 'hard-drives',
  network: 'arrows-down-up',
} as const satisfies Record<MachineMetricWidgetMetric, WidgetFrameBodyIdentity['mark']>;
const METRIC_FRAME_TITLE = {
  cpu: 'machines.widgets.inputs.cpu',
  memory: 'machines.widgets.inputs.memory',
  disk_free: 'machines.widgets.inputs.diskFree',
  network: 'machines.widgets.inputs.network',
} as const satisfies Record<MachineMetricWidgetMetric, string>;

function useMetricFrameIdentity(metric: MachineMetricWidgetMetric): void {
  const language = usePreferredLanguage();
  const identity = React.useMemo(
    (): WidgetFrameBodyIdentity => ({ title: t(METRIC_FRAME_TITLE[metric]), mark: METRIC_FRAME_MARK[metric] }),
    // The name is a word in the reader's language: re-lend it when that changes.
    [metric, language],
  );
  useWidgetFrameBodyIdentity(identity);
}

/**
 * Metric (lab `rw` M, MM, MD, MN): one number with its history. Small is the Machine summary strip's own tile
 * for that metric — the figure beside its five-minute line. From Wide up the body is the Overview's own tile
 * for the metric, over the widget's range: the same chart, figures and detail as the Overview tab (one chart
 * system). Disk free narrows the Overview's disk tile to the chosen volume.
 */
export function MachineMetricWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  const config = readMachineMetricWidgetConfig(props.input);
  useMetricFrameIdentity(config.metric);
  if (!target)
    return (
      <MachineWidgetState
        kind="empty"
        title={t('machines.widgets.body.metric.chooseMachine')}
        testID={props.testID}
      />
    );
  return <MetricBody target={target} config={config} testID={props.testID} />;
}

function MetricBody(
  props: Readonly<{
    target: MachineWidgetTarget;
    config: MachineMetricWidgetConfig;
    testID: string;
  }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const open = useOpenMachinePage(props.target);
  const onOpen = React.useCallback(
    () => open(metricTab(props.config)),
    [open, props.config],
  );
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (!facts.machine)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.common.machineGone')}
        testID={props.testID}
      />
    );
  return size === 'small' ? (
    <MetricSmall
      target={props.target}
      facts={facts}
      config={props.config}
      onOpen={onOpen}
      testID={props.testID}
    />
  ) : (
    <MetricTile
      target={props.target}
      facts={facts}
      config={props.config}
      onOpen={onOpen}
      testID={props.testID}
    />
  );
}

/** Small's one button takes the body's room, so the line under the figure can fill it. */
const filledPressable = { flexGrow: 1, alignSelf: 'stretch' } as const;

function MetricSmall(
  props: Readonly<{
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    config: MachineMetricWidgetConfig;
    onOpen: () => void;
    testID: string;
  }>,
) {
  const demand = React.useMemo(
    () => [
      { ...props.target, daemonStateVersion: props.facts.daemonStateVersion },
    ],
    [props.facts.daemonStateVersion, props.target],
  );
  useMachineResourceLiveDemand(demand, {
    detail: 'summary',
    enabled: props.facts.online === true,
  });
  const machineAvailability = useMachineResourceSummary(props.target);
  // The summary transport already retains the full sample. Selection is a passive projection of
  // those same bytes, not a second live demand or an overview/history read for a Small widget.
  const readTarget = useMachineDaemonReadTarget(props.target);
  const key = React.useMemo(() => ({ ...readTarget.key, view: 'summary' as const }), [readTarget.key]);
  const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
  const getSnapshot = React.useCallback(() => readTarget.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, readTarget.accountMatches]);
  const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const availability = React.useMemo(() => {
    if (machineAvailability?.kind !== 'reporting' || !machineAvailability.summary) return machineAvailability;
    let summary = machineAvailability.summary;
    if (props.config.metric === 'disk_free' && props.config.volume && state.snapshot?.sample) {
      const volumeId = props.config.volume;
      const attention = machineAvailability.attention ?? state.snapshot.attention;
      summary = projectMachineResourceSummaryV1({ ...state.snapshot,
        sample: narrowToVolume(state.snapshot.sample, volumeId),
        ...(attention ? { attention: { ...attention, reasons: attention.reasons.filter(reason =>
          (reason.kind !== 'disk_full' && reason.kind !== 'disk_nearly_full') || reason.volumeId === volumeId) } } : {}),
      }) ?? summary;
    }
    const warnAbove = props.config.warnAbove;
    if (warnAbove !== null) {
      if (props.config.metric === 'cpu') summary = { ...summary, cpu: { ...summary.cpu,
        tone: resolveMetricWarningTone(summary.cpu.tone, summary.cpu.busyPct, warnAbove) } };
      if (props.config.metric === 'memory' || props.config.metric === 'disk_free') {
        const metric = props.config.metric === 'memory' ? 'memory' : 'disk';
        const value = summary[metric];
        const usedPct = value.totalBytes !== null && value.totalBytes > 0 && value.availableBytes !== null
          ? (value.totalBytes - value.availableBytes) / value.totalBytes * 100 : null;
        summary = { ...summary, [metric]: { ...value, tone: resolveMetricWarningTone(value.tone, usedPct, warnAbove) } };
      }
    }
    return { ...machineAvailability, summary };
  }, [machineAvailability, props.config.metric, props.config.volume, props.config.warnAbove, state.snapshot]);
  const freshness: MachineWidgetFreshness = props.facts.online === false
    ? { kind: 'offline' }
    : availability?.kind === 'reporting' &&
        availability.freshness === 'stale' &&
        availability.summary
      ? { kind: 'stale', at: availability.summary.sampledAt }
      : { kind: 'live' };
  useMachineWidgetFreshness(freshness, props.testID);
  if (availability?.kind === 'not_reported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={props.facts.name}
        testID={props.testID}
      />
    );
  if (
    props.facts.online === false &&
    !(availability?.kind === 'reporting' && availability.summary)
  ) {
    return (
      <MachineWidgetState
        kind="offline"
        machineName={props.facts.name}
        lastSeenAt={props.facts.lastSeenAt}
        testID={props.testID}
      />
    );
  }
  if (availability?.kind === 'unavailable') return <MachineWidgetState kind="error" diagnosticCode={availability.errorCode} onRetry={() => machineResourceStore.retry(key)} testID={props.testID} />;
  return (
    <MachineWidgetColumn testID={props.testID}>
      <HappierPressable
        testID={`${props.testID}.open`}
        onPress={props.onOpen}
        accessibilityRole="button"
        style={filledPressable}
      >
        <MachineSummaryStrip
          availability={availability ?? { kind: 'never_sampled' }}
          style="sparklines"
          metrics={[STRIP_METRIC[props.config.metric]]}
          layout="tiles"
          fill
          testID={`${props.testID}.strip`}
        />
      </HappierPressable>
    </MachineWidgetColumn>
  );
}

function MetricTile(
  props: Readonly<{
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    config: MachineMetricWidgetConfig;
    onOpen: () => void;
    testID: string;
  }>,
) {
  const { config } = props;
  const size = useMachineWidgetSize();
  const vitals = useMachineWidgetVitalsView({
    target: props.target,
    facts: props.facts,
    range: config.range,
  });
  const view = vitals.view;
  const openTarget = React.useMemo(() => ({ onOpen: props.onOpen,
    accessibilityLabel: t('machines.widgets.body.fleet.openMachine', { machine: props.facts.name }) }), [props.facts.name, props.onOpen]);
  const freshness: MachineWidgetFreshness =
    view.kind === 'ready' && view.freshness === 'offline'
      ? { kind: 'offline' }
      : view.kind === 'ready' && view.freshness === 'stale'
        ? { kind: 'stale', at: view.sample.sampledAt }
        : props.facts.online === false
          ? { kind: 'offline' }
          : { kind: 'live' };
  useMachineWidgetFreshness(freshness, props.testID);
  const sample = React.useMemo(
    () =>
      view.kind === 'ready'
        ? narrowToVolume(
            view.sample,
            config.metric === 'disk_free' ? config.volume : null,
          )
        : null,
    [config.metric, config.volume, view],
  );
  if (view.kind === 'loading')
    return <MachineWidgetState kind="loading" rows={3} testID={props.testID} />;
  if (view.kind === 'monitoring_off')
    return <MachineWidgetState kind="empty" title={t('machineVitals.monitoring.offTitle', { machine: props.facts.name })}
      reason={t('machineVitals.monitoring.offReason')} testID={props.testID} />;
  if (view.kind === 'older_happier')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={props.facts.name}
        testID={props.testID}
      />
    );
  if (view.kind === 'offline_empty')
    return (
      <MachineWidgetState
        kind="offline"
        machineName={props.facts.name}
        lastSeenAt={props.facts.lastSeenAt}
        testID={props.testID}
      />
    );
  if (view.kind === 'unavailable' && view.reason === 'request_failed' && props.facts.online === false)
    return (
      <MachineWidgetState
        kind="offline"
        machineName={props.facts.name}
        lastSeenAt={props.facts.lastSeenAt}
        testID={props.testID}
      />
    );
  if (view.kind === 'unavailable') {
    return view.reason === 'request_failed' ? (
      <MachineWidgetState
        kind="error"
        onRetry={vitals.retry}
        diagnosticCode={view.errorCode}
        testID={props.testID}
      />
    ) : (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.metric.samplerUnavailable', {
          machine: props.facts.name,
        })}
        testID={props.testID}
      />
    );
  }
  if (!sample || view.kind !== 'ready') return null;
  const live = config.range === '1h';
  const tile =
    config.metric === 'cpu' ? (
      <CpuTile
        sample={sample}
        host={vitals.published?.host ?? null}
        timeline={vitals.timeline}
        axis={vitals.axis}
        freshness={view.freshness}
        live={live}
        {...(config.warnAbove !== null
          ? { warnAbovePct: config.warnAbove }
          : {})}
      />
    ) : config.metric === 'memory' ? (
      <MemoryTile
        sample={sample}
        attention={vitals.published?.attention ?? null}
        timeline={vitals.timeline}
        axis={vitals.axis}
        freshness={view.freshness}
        live={live}
        nowMs={Date.now()} {...(config.warnAbove !== null ? { warnAbovePct: config.warnAbove } : {})}
      />
    ) : config.metric === 'disk_free' ? (
      <DiskTile
        sample={sample}
        attention={vitals.published?.attention ?? null} {...(config.warnAbove !== null ? { warnAbovePct: config.warnAbove } : {})}
      />
    ) : (
      <NetworkTile
        sample={sample}
        today={vitals.today}
        timeline={vitals.timeline}
        axis={vitals.axis}
        freshness={view.freshness}
        live={live}
      />
    );
  // The tile's chart and per-core disclosure are controls of their own: it opens from its title.
  return (
    <MachineWidgetColumn testID={props.testID}>
      <VitalsTileRoomContext.Provider value={METRIC_TILE_ROOM[size]}>
        <VitalsTileOpenContext.Provider value={openTarget}>{tile}</VitalsTileOpenContext.Provider>
      </VitalsTileRoomContext.Provider>
    </MachineWidgetColumn>
  );
}

/**
 * What each size holds of the Overview's tile (lab `rw` M, MM, MD, MN): Wide sets the figure beside its chart,
 * Wide and Medium keep the chart alone, Full adds per-core or the composition, and only Tall and Large have
 * the height for swap and the minute maximum's second line. The widget body already holds the frame's inset.
 */
const METRIC_TILE_ROOM: Readonly<Record<WidgetSizeV1, VitalsTileRoom>> = Object.freeze({
  small: { layout: 'stack', instruments: 'primary', chartMaximum: false, inset: false, chart: 'spark', fill: true, title: false },
  medium: { layout: 'stack', instruments: 'primary', chartMaximum: false, inset: false, chart: 'plot', fill: true, title: false },
  wide: { layout: 'side', instruments: 'primary', chartMaximum: false, inset: false, chart: 'plot', fill: true, title: false },
  full: { layout: 'stack', instruments: 'secondary', chartMaximum: false, inset: false, chart: 'plot', fill: true, title: false },
  tall: { layout: 'stack', instruments: 'all', chartMaximum: true, inset: false, chart: 'plot', fill: true, title: false },
  large: { layout: 'stack', instruments: 'all', chartMaximum: true, inset: false, chart: 'plot', fill: true, title: false },
});

/** Disk free on one chosen volume; a missing selection stays unmeasured, never another disk. */
export function narrowToVolume(
  sample: MachineVitalsSampleV1,
  volumeId: string | null,
): MachineVitalsSampleV1 {
  if (!volumeId || !sample.disk.reported) return sample;
  const volumes = sample.disk.volumes.filter(
    (volume) => volume.id === volumeId,
  );
  return { ...sample, disk: { ...sample.disk, homeVolumeId: volumeId, volumes } };
}

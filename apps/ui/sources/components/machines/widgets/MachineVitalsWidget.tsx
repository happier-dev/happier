import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  MachinePublishedResourceSummaryV1,
  MachineResourceSummaryV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import { buildMachineSummaryInstruments, resolveMachineResourceToneColor, type MachineSummaryInstrument, type MachineSummaryMetric, resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import {
  describeMachineAttentionWord,
  describeMachineReasonDetail,
  readMachinePublishedResources,
  resolveMachineReasonAction,
  selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { CpuTile } from '@/components/machines/vitals/CpuTile';
import { MachineUsingTheMost } from '@/components/machines/vitals/MachineUsingTheMost';
import {
  formatMachinePartOfWhole,
  machineBytesParts,
  resolveMachineCpuCapacityCores,
  resolveMachineCoreCount,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { NetworkTile } from '@/components/machines/vitals/NetworkTile';
import { VitalsSubLine, VitalsValue } from '@/components/machines/vitals/VitalsSheet';
import { describeMachineUptime } from '@/components/machines/vitals/vitalsFormat';
import {
  MachineWorkingCountsProvider,
  useMachineWorkingCount,
} from '@/components/machines/work/machineWorkingCounts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineVitalsAttribution } from '@/sync/domains/machines/resources/useMachineVitalsAttribution';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { retryMachineResourceSummaries } from '@/sync/domains/machines/resources/retryMachineResourceSummaries';
import {
  useMachineResourceSummary,
  type MachineResourceAvailability,
} from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { t } from '@/text';

import {
  isWideWidgetSize,
  MachineWidgetColumn,
  MachineWidgetState,
  MachineWidgetTwoColumns,
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
import { useMachineAttentionStatedAbove } from './machineAttentionStatedAbove';
import { useMachineWidgetVitalsView } from './machineWidgetVitalsView';
import { machineDiskName } from '@/components/machines/storage/storageViewModel';

const RING_METRICS: readonly MachineSummaryMetric[] = ['cpu', 'memory', 'disk'];
const LARGE_METRICS: readonly MachineSummaryMetric[] = [
  'cpu',
  'memory',
  'disk',
  'network',
];

/**
 * Vitals (lab `rw` V, VC option B, VS): one machine's CPU, memory and disk as three capacity rings — the
 * Machine summary strip's own rings, so the widget and the popover never disagree. Healthy is ink; the ring
 * and figure that need the person take the tone, and from Wide up the phrase names it with its one next step.
 * Full and up add who is using the most (the Overview's rows) and the Overview's own charts.
 */
export function MachineVitalsWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="empty"
        title={t('machines.widgets.body.vitals.chooseMachine')}
        testID={props.testID}
      />
    );
  return (
    <MachineWorkingCountsProvider>
      <VitalsBody target={target} testID={props.testID} />
    </MachineWorkingCountsProvider>
  );
}

function VitalsBody(
  props: Readonly<{ target: MachineWidgetTarget; testID: string }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const demand = React.useMemo(
    () => [{ ...props.target, daemonStateVersion: facts.daemonStateVersion }],
    [facts.daemonStateVersion, props.target],
  );
  // A mounted widget is demand on the summary transport; offscreen or unmounted, it releases it.
  useMachineResourceLiveDemand(demand, {
    detail: 'summary',
    enabled: facts.online === true,
  });
  const availability = useMachineResourceSummary(props.target);
  const retry = React.useCallback(() => retryMachineResourceSummaries([props.target]), [props.target]);
  const freshness = resolveSummaryFreshness(availability, facts);
  useMachineWidgetFreshness(freshness, props.testID);
  const open = useOpenMachinePage(props.target);

  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;

  if (!facts.machine)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.common.machineGone')}
        testID={props.testID}
      />
    );
  if (availability?.kind === 'monitoring_off' && facts.online !== false)
    return <MachineWidgetState kind="empty" title={t('machineVitals.monitoring.offTitle', { machine: facts.name })}
      testID={props.testID} />;
  if (availability?.kind === 'not_reported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={facts.name}
        testID={props.testID}
      />
    );
  const summary =
    availability?.kind === 'reporting' ? availability.summary : null;
  if (!summary) {
    if (facts.online === false)
      return (
        <MachineWidgetState
          kind="offline"
          machineName={facts.name}
          lastSeenAt={facts.lastSeenAt}
          testID={props.testID}
        />
      );
    if (availability?.kind === 'unavailable') return <MachineWidgetState kind="error" diagnosticCode={availability.errorCode} onRetry={retry} testID={props.testID} />;
    return <VitalsLoading size={size} testID={props.testID} />;
  }
  return (
    <VitalsContent
      size={size}
      summary={summary}
      availability={availability}
      facts={facts}
      target={props.target}
      open={open}
      testID={props.testID}
    />
  );
}

function resolveSummaryFreshness(
  availability: MachineResourceAvailability | null,
  facts: MachineWidgetMachineFacts,
): MachineWidgetFreshness {
  if (facts.online === false) {
    // Values this app still holds are shown with their age, not as if they were read now.
    const heldAt = availability?.kind === 'reporting' ? availability.summary?.sampledAt : undefined;
    return heldAt === undefined ? { kind: 'offline' } : { kind: 'offline', heldAt };
  }
  if (
    availability?.kind === 'reporting' &&
    availability.freshness === 'stale' &&
    availability.summary
  )
    return { kind: 'stale', at: availability.summary.sampledAt };
  return { kind: 'live' };
}

function VitalsContent(
  props: Readonly<{
    size: WidgetSizeV1;
    summary: MachineResourceSummaryV1;
    availability: MachineResourceAvailability | null;
    facts: MachineWidgetMachineFacts;
    target: MachineWidgetTarget;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const { size, summary, availability, facts, target, open, testID } = props;
  const daemonState: unknown = facts.machine?.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const instruments = React.useMemo(
    () => buildMachineSummaryInstruments(summary),
    [summary],
  );
  const rings = (
    <HappierPressable
      testID={`${testID}.rings`}
      // Small is the rings alone: they spread over the card's whole width (a card on a phone is one full row).
      {...(size === 'small' ? { style: styles.spread } : {})}
      onPress={() => open({ id: 'overview' })}
      accessibilityRole="button"
      accessibilityLabel={t('machines.widgets.body.vitals.openOverview', {
        machine: facts.name,
      })}
    >
      <MachineSummaryStrip
        availability={availability}
        style="rings"
        metrics={size === 'large' ? LARGE_METRICS : RING_METRICS}
        layout="tiles"
        testID={`${testID}.strip`}
      />
    </HappierPressable>
  );
  if (size === 'small')
    // Small is the three instruments alone, centred in the card's room (lab rw V Small).
    return <MachineWidgetColumn testID={testID}><View style={styles.centred}>{rings}</View></MachineWidgetColumn>;
  const phrase = (
    <VitalsPhrase
      published={published}
      target={target}
      facts={facts}
      open={open}
      actions={size !== 'wide'}
      testID={testID}
    />
  );
  if (size === 'wide')
    return (
      <MachineWidgetColumn testID={testID}>
        <MachineWidgetTwoColumns lead={phrase} rest={rings} />
      </MachineWidgetColumn>
    );
  const rows = (
    <View style={styles.rows}>
      {RING_METRICS.map((metric) => (
        <VitalsRingRow
          key={metric}
          metric={metric}
          instrument={instruments[metric]}
          summary={summary}
          published={published}
          onPress={() => open(metricTab(metric, summary))}
          testID={`${testID}.${metric}`}
        />
      ))}
    </View>
  );
  if (size === 'medium')
    return (
      <MachineWidgetColumn testID={testID}>
        {phrase}
        {rows}
      </MachineWidgetColumn>
    );
  const detail = (
    <VitalsDetail
      size={size}
      target={target}
      facts={facts}
      open={open}
      testID={testID}
    />
  );
  if (size === 'full')
    return (
      <MachineWidgetColumn testID={testID}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {phrase}
              {rows}
            </>
          }
          rest={detail}
        />
      </MachineWidgetColumn>
    );
  if (size === 'tall')
    return (
      <MachineWidgetColumn testID={testID}>
        {phrase}
        {rows}
        {detail}
      </MachineWidgetColumn>
    );
  return (
    <MachineWidgetColumn testID={testID}>
      {phrase}
      {rings}
      {detail}
    </MachineWidgetColumn>
  );
}

/** Where a metric's tap leads: memory and CPU to Processes sorted by them, disk to Storage on its volume. */
function metricTab(
  metric: MachineSummaryMetric,
  summary: MachineResourceSummaryV1,
): MachinePageTabParams {
  if (metric === 'disk')
    return summary.disk.volumeId
      ? { id: 'storage', volumeId: summary.disk.volumeId }
      : { id: 'storage' };
  if (metric === 'memory' || metric === 'cpu')
    return { id: 'processes', sort: metric };
  return { id: 'overview' };
}

/**
 * The phrase (lab `vsay`): calm says what the machine is doing and its uptime and size; a machine that
 * needs a look names the reason in tone, its detail, and from Medium up its one next step.
 */
function VitalsPhrase(
  props: Readonly<{
    published: MachinePublishedResourceSummaryV1 | null;
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    open: (tab?: MachinePageTabParams) => void;
    actions: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const working = useMachineWorkingCount(props.target);
  // The attention sentences end in a full stop; the widget's headline and its sub-line are phrases (lab rw V).
  const work = (
    working > 0
      ? t('machineAttention.machine.working', { count: working })
      : t('machineAttention.machine.idle')
  ).replace(/[.。]$/u, '');
  // Where the page above already names this machine's attention (and offers its one action), the widget keeps
  // the state on its Memory/CPU rows and says what the machine is doing instead of repeating the sentence.
  const statedAbove = useMachineAttentionStatedAbove(props.target);
  const reason = props.published && !statedAbove
    ? selectHeadlineReason(props.published.attention)
    : null;
  const host =
    props.published && 'host' in props.published
      ? (props.published.host ?? null)
      : null;
  const nowMs = Date.now();
  // An offline machine's phrase is not a live claim: no "Nothing running", no uptime, no held attention
  // sentence. What stays is what does not change (cores, memory); the header says "Offline · As of …".
  if (!props.facts.online) {
    const fixed = host
      ? t('machineVitals.header.coresMemory', {
          cores: resolveMachineCoreCount(host),
          memory: machineBytesFigure(host.memoryTotalBytes, 'memory'),
        })
      : null;
    return fixed ? (
      <View testID={`${props.testID}.phrase`} style={styles.phrase}>
        <VitalsSubLine>{fixed}</VitalsSubLine>
      </View>
    ) : null;
  }
  if (!reason || props.published?.attention.level === 'calm') {
    const facts = [
      host ? describeMachineUptime(host.bootedAt, nowMs) : null,
      host
        ? t('machineVitals.header.coresMemory', {
            cores: resolveMachineCoreCount(host),
            memory: machineBytesFigure(host.memoryTotalBytes, 'memory'),
          })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <View testID={`${props.testID}.phrase`} style={styles.phrase}>
        <Text numberOfLines={1} style={styles.say}>
          {work}
        </Text>
        {facts ? <VitalsSubLine>{facts}</VitalsSubLine> : null}
      </View>
    );
  }
  const tone = resolveMachineAttentionWordColor(theme.colors);
  const step = props.actions ? resolveMachineReasonAction(reason) : null;
  return (
    <View testID={`${props.testID}.phrase`} style={styles.phrase}>
      <Text
        numberOfLines={1}
        style={[styles.say, { color: tone }]}
        accessibilityLiveRegion="polite"
      >
        {describeMachineAttentionWord(reason)}
      </Text>
      <VitalsSubLine>
        {[describeMachineReasonDetail(reason, nowMs), work]
          .filter(Boolean)
          .join(' · ')}
      </VitalsSubLine>
      {step ? (
        <View style={styles.step}>
          <RoundButton
            testID={`${props.testID}.nextStep`}
            size="small"
            display="secondary"
            title={step.label}
            onPress={() => props.open(step.tab)}
          />
        </View>
      ) : null}
    </View>
  );
}

function machineBytesFigure(bytes: number, kind: 'memory' | 'storage'): string {
  const parts = machineBytesParts(bytes, kind);
  return `${parts.value} ${parts.unit}`;
}

/** One vital as a row (lab `rfig(…, 'r')`): the ring, its name and one line of detail, the figure at the right. */
function VitalsRingRow(
  props: Readonly<{
    metric: MachineSummaryMetric;
    instrument: MachineSummaryInstrument;
    summary: MachineResourceSummaryV1;
    published: MachinePublishedResourceSummaryV1 | null;
    onPress: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { instrument, summary, metric } = props;
  const tone = resolveMachineResourceToneColor(instrument.tone, theme.colors);
  const ink = instrument.tone === 'calm' ? theme.colors.text.secondary : tone;
  const value = describeRowValue(metric, summary, instrument);
  return (
    <HappierPressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={
        instrument.exact ??
        t('machineSummary.unmeasured', { metric: t(METRIC_TITLE_KEYS[metric]) })
      }
      style={styles.ringRow}
    >
      <CapacityRing
        ratio={instrument.used ?? 0}
        color={ink}
        trackColor={theme.colors.border.subtle}
        size={36}
        strokeWidth={3}
      />
      <View style={styles.ringText}>
        <Text numberOfLines={1} style={styles.ringLabel}>
          {t(METRIC_TITLE_KEYS[metric])}
        </Text>
        <VitalsSubLine>
          {describeRowDetail(metric, summary, props.published) ?? ' '}
        </VitalsSubLine>
      </View>
      <View style={styles.ringValue}>
        {value ? (
          <VitalsValue
            value={value.value}
            {...(value.unit ? { unit: value.unit } : {})}
            {...(instrument.tone !== 'calm' ? { color: tone } : {})}
          />
        ) : (
          <VitalsValue value={t('machineVitals.unmeasured')} />
        )}
      </View>
    </HappierPressable>
  );
}

const METRIC_TITLE_KEYS = {
  cpu: 'machineVitals.cpu.title',
  memory: 'machineVitals.memory.title',
  disk: 'machineVitals.disk.title',
  network: 'machineVitals.network.title',
} as const;

/** The figure in the convention of the strip (CPU in use; memory and disk free; the pressure word in tone). */
function describeRowValue(
  metric: MachineSummaryMetric,
  summary: MachineResourceSummaryV1,
  instrument: MachineSummaryInstrument,
): Readonly<{ value: string; unit?: string }> | null {
  if (instrument.figure === null) return null;
  if (
    metric === 'memory' &&
    summary.memory.availableBytes !== null &&
    (instrument.tone === 'calm' ||
      summary.memory.pressure === 'calm' ||
      summary.memory.pressure === 'not_reported')
  ) {
    const parts = machineBytesParts(summary.memory.availableBytes, 'memory');
    return {
      value: parts.value,
      unit: t('machines.widgets.body.vitals.unitFree', { unit: parts.unit }),
    };
  }
  if (metric === 'disk' && summary.disk.availableBytes !== null) {
    const parts = machineBytesParts(summary.disk.availableBytes, 'storage');
    return {
      value: parts.value,
      unit: t('machines.widgets.body.vitals.unitFree', { unit: parts.unit }),
    };
  }
  return { value: instrument.figure };
}

/** The row's one line: cores, memory in use of its total, the volume and its size. */
function describeRowDetail(
  metric: MachineSummaryMetric,
  summary: MachineResourceSummaryV1,
  published: MachinePublishedResourceSummaryV1 | null,
): string | null {
  const host =
    published && 'host' in published ? (published.host ?? null) : null;
  if (metric === 'cpu')
    return host
      ? t('machineVitals.cpu.cores', { count: resolveMachineCoreCount(host) })
      : null;
  if (metric === 'memory') {
    const { availableBytes, totalBytes } = summary.memory;
    if (availableBytes === null || totalBytes === null) return null;
    const parts = formatMachinePartOfWhole(
      Math.max(0, totalBytes - availableBytes),
      totalBytes,
      'memory',
      'whole',
    );
    return t('machines.widgets.body.vitals.inUseOf', {
      used: parts.part,
      total: parts.whole,
    });
  }
  if (metric === 'disk') {
    const { totalBytes, volumeLabel } = summary.disk;
    return (
      [
        volumeLabel === null ? null : machineDiskName({ label: volumeLabel }),
        totalBytes !== null ? machineBytesFigure(totalBytes, 'storage') : null,
      ]
        .filter(Boolean)
        .join(' · ') || null
    );
  }
  return null;
}

/**
 * Full, Tall and Large: who is using the most (the Overview's own rows) and, at Large, the Overview's CPU and
 * network tiles. Only these sizes demand the Overview reading.
 */
function VitalsDetail(
  props: Readonly<{
    size: WidgetSizeV1;
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const vitals = useMachineWidgetVitalsView({
    target: props.target,
    facts: props.facts,
    range: '1h',
  });
  const sample = vitals.view.kind === 'ready' ? vitals.view.sample : null;
  const attribution = useMachineVitalsAttribution({
    machineId: props.target.machineId,
    serverId: props.target.serverId,
    online: props.facts.online,
    enabled: props.facts.online === true && sample !== null,
    sample,
  });
  if (vitals.view.kind === 'loading')
    return (
      <MachineWidgetState
        kind="loading"
        rows={4}
        testID={`${props.testID}.detail`}
      />
    );
  if (vitals.view.kind === 'monitoring_off')
    return <MachineWidgetState kind="empty" title={t('machineVitals.monitoring.offTitle', { machine: props.facts.name })}
      reason={t('machineVitals.monitoring.offReason')} testID={`${props.testID}.detail`} />;
  if (!sample || vitals.view.kind !== 'ready') return null;
  const openProcesses = () => props.open({ id: 'processes', sort: 'memory' });
  const using = props.facts.online ? (
    <MachineUsingTheMost
      serverId={props.target.serverId}
      machineId={props.target.machineId}
      machineName={props.facts.name}
      processes={attribution.processes.answer}
      processesStatus={attribution.processes.status}
      offline={false}
      sample={sample}
      cpuCapacityCores={vitals.published?.host ? resolveMachineCpuCapacityCores(vitals.published.host) : null}
      onOpenProcesses={openProcesses}
    />
  ) : null;
  const network = (
    <NetworkTile
      sample={sample}
      today={vitals.today}
      timeline={vitals.timeline}
      axis={vitals.axis}
      freshness={vitals.view.freshness}
      live
    />
  );
  if (props.size === 'full') return <>{using}</>;
  if (props.size === 'tall')
    return (
      <>
        {using}
        {network}
      </>
    );
  return (
    <>
      <CpuTile
        sample={sample}
        host={vitals.published?.host ?? null}
        timeline={vitals.timeline}
        axis={vitals.axis}
        freshness={vitals.view.freshness}
        live
      />
      {isWideWidgetSize(props.size) ? (
        <MachineWidgetTwoColumns lead={using} rest={network} />
      ) : (
        <>
          {using}
          {network}
        </>
      )}
    </>
  );
}

/** The same rings, reserved at their final size (lab `vLoad`). */
/** Loading is skeleton rows alone: empty rings with dashes read as measured nothing, not as waiting. */
function VitalsLoading(
  props: Readonly<{ size: WidgetSizeV1; testID: string }>,
) {
  return (
    <MachineWidgetState
      kind="loading"
      rows={props.size === 'small' || props.size === 'wide' ? 2 : 3}
      testID={props.testID}
    />
  );
}


const styles = StyleSheet.create((theme) => ({
  centred: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  spread: {
    alignSelf: 'stretch',
  },
  phrase: {
    gap: theme.space.s2,
    minWidth: 0,
  },
  say: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
  },
  step: {
    flexDirection: 'row',
    marginTop: theme.space.s10,
  },
  rows: {
    gap: 14,
  },
  ringRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    minHeight: 44,
  },
  ringText: {
    flex: 1,
    minWidth: 0,
  },
  ringLabel: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  ringValue: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
}));

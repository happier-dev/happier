import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_DATA_METRICS,
  HappierSkeletonBlock,
} from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineOfflineNotice } from '@/components/machines/page/MachineOfflineNotice';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineVitalsOverview } from '@/sync/domains/machines/resources/useMachineVitalsOverview';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { useMachineMonitoringMode } from '@/sync/domains/machines/resources/useMachineMonitoringMode';
import { MachineUsingTheMost } from './MachineUsingTheMost';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { CpuTile } from './CpuTile';
import { DiskTile } from './DiskTile';
import { MachineAlertsRow } from './MachineAlertsRow';
import { MachineMoreFrom } from './MachineMoreFrom';
import { MachineMonitoringOffCard, MachineMonitoringRows } from './MachineMonitoringRows';
import {
  useMachineVitalsTimeline,
  resolveMachineCpuCapacityCores,
  selectMachineVitalsExtras,
  selectMachineVitalsOverviewView,
  type MachineVitalsOverviewView,
} from './machineVitalsPresentation';
import {
  MachineVitalsRangeBar,
  resolveVitalsFreshnessChip,
  useMachineVitalsRange,
} from './MachineVitalsRangeBar';
import { MemoryTile } from './MemoryTile';
import { NetworkTile } from './NetworkTile';
import { VitalsSheet, VitalsTile } from './VitalsSheet';
import { resolveVitalsAxis } from './vitalsFormat';

const ARRIVAL_FADE_MS = 160;

/**
 * Plan 20's vitals body on a machine's Overview (VU-6, lab `rv` O / OE / OX / OS): the freshness chip and
 * history range, the four vitals in one sheet, what else the machine reports, and its Alerts row. Live
 * only while shown (the hook's demand); every state keeps the same boxes, so nothing moves when the first
 * sample lands, when it goes stale, or when the machine leaves.
 */
export const MachineVitalsOverview = React.memo(function MachineVitalsOverview(
  props: Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    online: boolean | null;
    /** Opens the Processes tab (VU-7's rows and links); without it "Using the most" is left out. */
    onOpenProcesses?: () => void;
    /**
     * The page's reload, offered by the one offline banner this body opens with (lab `rv` OS 3): the page states
     * offline once, here, above what the machine last reported.
     */
    offlineRetry?: Readonly<{ onPress: () => void; loading: boolean }>;
    /** The page already says why it is offline (a created machine that is stopped); no second banner. */
    offlineExplained?: boolean;
  }>,
) {
  const { machine } = props;
  const language = usePreferredLanguage();
  const daemonState: unknown = machine.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const [range] = useMachineVitalsRange();
  // Off is the person's choice, not a failure: nothing here demands a read while it holds.
  const monitoring = useMachineMonitoringMode({ serverId: props.serverId, machineId: machine.id });
  const overview = useMachineVitalsOverview({
    serverId: props.serverId,
    machineId: machine.id,
    daemonStateVersion: machine.daemonStateVersion ?? null,
    range,
    enabled: props.online === true && monitoring !== 'off',
  });
  const view = selectMachineVitalsOverviewView({
    online: props.online,
    published,
    monitoring,
    state: overview,
  });
  // Only an Overview that opened on reserved boxes cross-fades its first sample in.
  const [startedLoading] = React.useState(view.kind === 'loading');
  const attention =
    published?.attention ?? overview.snapshot?.attention ?? null;
  const timeline = useMachineVitalsTimeline({ range, history: overview.history, samples: overview.samples });
  // One axis for the three history tiles, kept by reference so a render that changes nothing they draw leaves them be.
  const axisLive = view.kind === 'ready' && view.freshness === 'live';
  const axis = React.useMemo(() => resolveVitalsAxis(range, timeline, axisLive), [axisLive, range, timeline, language]);
  const { retry } = overview;
  // Offline is said once, by the page header's presence ("Offline · Oct 13"); this quiet banner above what the machine
  // last reported says only what that means and offers Try again (lab `rv` OS 3, TH D-I). With nothing reported this
  // session the banner says that too, and no body follows.
  const offlineBanner = props.online === false && !props.offlineExplained ? (
    <MachineOfflineNotice
      testID="machine-vitals-offline"
      title={t('machineVitals.states.offlineBackTitle')}
      description={view.kind === 'offline_empty'
        ? t('machineVitals.states.offlineNeverReported')
        : t('machineVitals.states.offlineLastReported', { machine: props.machineName })}
      retry={props.offlineRetry ? { ...props.offlineRetry, testID: 'machine-vitals-offline-retry' } : null}
    />
  ) : null;
  if (props.online === null && view.kind !== 'ready') return <SurfaceStateCard kind="unavailable" title={t('common.unknown')} />;
  if (view.kind === 'offline_empty') return offlineBanner;
  const settings = (
    <>
      <MachineMonitoringRows serverId={props.serverId} machineId={machine.id} />
      <MachineAlertsRow serverId={props.serverId} machineId={machine.id} machineName={props.machineName} />
    </>
  );
  if (view.kind === 'monitoring_off') {
    // What it read before stays, as of its time (the range bar's chip says when); nothing reads, so no range.
    return (
      <>
        <MachineMonitoringOffCard serverId={props.serverId} machineId={machine.id} machineName={props.machineName}
          held={view.sample !== null} />
        {view.sample ? (
          <ItemGroup header="none" surface="none">
            <MachineVitalsRangeBar freshness={resolveVitalsFreshnessChip(view, retry)} showRange={false} />
          </ItemGroup>
        ) : null}
        {view.sample ? (
          <VitalsSheet testID="machine-vitals-sheet">
            <CpuTile sample={view.sample} host={published?.host ?? null} timeline={timeline} axis={axis} freshness="stale" live={false} />
            <MemoryTile sample={view.sample} attention={attention} timeline={timeline} nowMs={Date.now()} axis={axis} freshness="stale" live={false} />
            <DiskTile sample={view.sample} attention={attention} happierBytesByVolume={null} />
            <NetworkTile sample={view.sample} today={null} timeline={timeline} axis={axis} freshness="stale" live={false} />
          </VitalsSheet>
        ) : null}
        {settings}
      </>
    );
  }
  if (
    view.kind === 'older_happier' ||
    view.kind === 'unavailable'
  ) {
    return (
      <MachineVitalsStateCard
        view={view}
        serverId={props.serverId}
        machine={machine}
        machineName={props.machineName}
        onRetry={retry}
      />
    );
  }

  const freshness = props.online === null ? { kind: 'none' as const } : resolveVitalsFreshnessChip(view, retry, overview.refreshing);
  return (
    <>
      {offlineBanner}
      {/* One section: its title, then the freshness and range as the action of the charts they scope, so the range
          never stands apart from them (owner bar 11-16). */}
      <ItemGroup surface="none" title={t('machineVitals.sectionTitle')} testID="machine-vitals-section"
        action={<MachineVitalsRangeBar freshness={freshness} showRange={view.kind === 'ready'} />} />
      {view.kind === 'loading' ? (
        <VitalsLoadingSheet />
      ) : (
        <ArrivalFade enabled={startedLoading}>
          <VitalsSheet testID="machine-vitals-sheet">
            <CpuTile
              sample={view.sample}
              host={published?.host ?? null}
              timeline={timeline}
              axis={axis}
              freshness={view.freshness}
              live={range === '1h'}
            />
            <MemoryTile
              sample={view.sample}
              attention={attention}
              timeline={timeline}
              nowMs={Date.now()}
              axis={axis}
              freshness={view.freshness}
              live={range === '1h'}
            />
            <MachineOverviewDiskTile
              serverId={props.serverId}
              machineId={machine.id}
              online={props.online}
              sample={view.sample}
              attention={attention}
            />
            <NetworkTile
              sample={view.sample}
              today={overview.history?.today ?? null}
              timeline={timeline}
              axis={axis}
              freshness={view.freshness}
              live={range === '1h'}
            />
          </VitalsSheet>
        </ArrivalFade>
      )}
      {view.kind === 'ready' && props.onOpenProcesses ? (
        <MachineOverviewProcesses
          online={props.online}
          serverId={props.serverId}
          machineId={machine.id}
          machineName={props.machineName}
          offline={props.online === false}
          sample={view.sample}
          cpuCapacityCores={published?.host ? resolveMachineCpuCapacityCores(published.host) : null}
          onOpenProcesses={props.onOpenProcesses}
        />
      ) : null}
      {view.kind === 'ready' ? (
        <MachineMoreFrom
          machineName={props.machineName}
          extras={selectMachineVitalsExtras(view.sample, overview.samples)}
          attention={attention}
        />
      ) : null}
      {settings}
    </>
  );
});

/** Storage publications belong to the disk tile, not its CPU, memory and network siblings. */
function MachineOverviewDiskTile(props: Omit<React.ComponentProps<typeof DiskTile>, 'happierBytesByVolume'> & Readonly<{
  serverId: string;
  machineId: string;
  online: boolean | null;
}>) {
  const storage = useMachineStorageSummary({
    serverId: props.serverId,
    machineId: props.machineId,
    online: props.online,
    enabled: props.online === true,
  });
  const summary = storage.summary;
  const happierBytesByVolume = React.useMemo(() => summary
    ? new Map(summary.volumes.map(entry => [entry.volume.volumeId, entry.happierBytes])) : null, [summary]);
  return <DiskTile sample={props.sample} attention={props.attention} happierBytesByVolume={happierBytesByVolume} />;
}

/** Observe the existing owners projection where it is displayed; a process tick never redraws the vitals body. */
function MachineOverviewProcesses(props: Omit<React.ComponentProps<typeof MachineUsingTheMost>, 'processes' | 'processesStatus'> & Readonly<{
  online: boolean | null;
}>) {
  const { online, ...presentation } = props;
  const processes = useMachineProcesses({
    serverId: props.serverId,
    machineId: props.machineId,
    scope: 'happier',
    view: 'owners',
    online,
    enabled: online === true,
  });
  return <MachineUsingTheMost {...presentation} processes={processes.answer} processesStatus={processes.status} />;
}

/** The first sample cross-fades in over its reserved boxes; a retained Overview draws at once. */
function ArrivalFade(props: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
  const reducedMotion = useReducedMotionPreference();
  const fade = props.enabled && !reducedMotion;
  const opacity = useSharedValue(fade ? 0 : 1);
  React.useEffect(() => {
    if (fade) opacity.value = withTiming(1, { duration: ARRIVAL_FADE_MS });
  }, [fade, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{props.children}</Animated.View>;
}

/** Loading (OS 1): the four tiles at their final size with reserved blocks for values and charts. */
function VitalsLoadingSheet() {
  const { theme } = useUnistyles();
  const color = theme.colors.surface.skeleton;
  const block = (width: number | `${number}%`, height: number) => (
    <HappierSkeletonBlock color={color} width={width} height={height} />
  );
  const tile = (key: string, label: string, chart: boolean, meters: number) => (
    <VitalsTile
      key={key}
      label={label}
      value={block(64, 22)}
      sub={block(140, 10)}
    >
      {chart ? block('100%', HAPPIER_DATA_METRICS.plotHeightPx + 20) : null}
      {Array.from({ length: meters }, (_, index) => (
        <View key={index} style={styles.loadingMeter}>
          {block('100%', 4)}
        </View>
      ))}
    </VitalsTile>
  );
  return (
    <View
      aria-busy
      accessibilityLabel={t('machineVitals.loading')}
      testID="machine-vitals-loading"
    >
      <VitalsSheet>
        {tile('cpu', t('machineVitals.cpu.title'), true, 0)}
        {tile('memory', t('machineVitals.memory.title'), true, 1)}
        {tile('disk', t('machineVitals.disk.title'), false, 2)}
        {tile('network', t('machineVitals.network.title'), true, 0)}
      </VitalsSheet>
    </View>
  );
}

/**
 * OS 3, 5 and 6 when there is nothing to draw: one state card that names the cause and the ways forward.
 * Offline with nothing read: a quiet line (the page's offline banner already says what it blocks).
 */
function MachineVitalsStateCard(
  props: Readonly<{
    view: Extract<
      MachineVitalsOverviewView,
      { kind: 'older_happier' | 'unavailable' | 'offline_empty' }
    >;
    serverId: string;
    machine: Machine;
    machineName: string;
    onRetry: () => void;
  }>,
) {
  const router = useRouter();
  const door = useMachinesDoor();
  const writeClipboard = useClipboardWrite(props.serverId);
  const { view, machineName } = props;
  const openDoctor = React.useCallback(() => {
    router.push(
      machinePageHref({
        door,
        target: { machineId: props.machine.id, serverId: props.serverId },
        page: 'doctor',
      }) as never,
    );
  }, [door, props.machine.id, props.serverId, router]);
  if (view.kind === 'offline_empty') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-vitals-offline-empty"
          kind="unavailable"
          size="line"
          title={t('machineVitals.states.offlineEmpty', {
            machine: machineName,
          })}
        />
      </ItemGroup>
    );
  }
  if (view.kind === 'older_happier') {
    const shared = props.machine.isShared === true;
    return (
      <ItemGroup header="none">
        <SurfaceStateCard
          testID="machine-vitals-older"
          size="details"
          kind="empty"
          title={t('machineVitals.states.olderTitle', { machine: machineName })}
          reason={t('machineVitals.states.olderReason', {
            machine: machineName,
          })}
          {...(shared
            ? {
                action: {
                  label: t('machineVitals.states.askOwner', {
                    machine: machineName,
                  }),
                  testID: 'machine-vitals-ask-owner',
                  onPress: () =>
                    writeClipboard(
                      t('machineVitals.states.askOwnerMessage', {
                        machine: machineName,
                      }),
                    ),
                },
              }
            : {})}
        />
      </ItemGroup>
    );
  }
  const title =
    view.reason === 'helper_missing'
      ? t('machineVitals.states.helperMissingTitle', { machine: machineName })
      : view.since !== null
        ? t('machineVitals.states.stoppedAt', {
            machine: machineName,
            time: formatAsOfTime(view.since),
          })
        : view.reason === 'request_failed'
          ? t('machineVitals.states.unreachableTitle', { machine: machineName })
          : t('machineVitals.states.unreadableTitle', { machine: machineName });
  return (
    <ItemGroup header="none">
      <SurfaceStateCard
        testID="machine-vitals-error"
        size="details"
        kind="error"
        title={title}
        reason={
          view.reason === 'helper_missing'
            ? t('machineVitals.states.helperMissingReason')
            : view.reason === 'request_failed'
              ? t('machineVitals.states.unreachableReason')
              : t('machineVitals.states.unreadableReason')
        }
        diagnosticCode={view.errorCode ?? view.reason}
        {...(view.reason === 'helper_missing'
          ? {}
          : {
              action: {
                label: t('machineVitals.states.tryAgain'),
                onPress: props.onRetry,
                testID: 'machine-vitals-try-again',
              },
            })}
        secondaryAction={{
          label: t('machineVitals.states.openDoctor'),
          onPress: openDoctor,
          testID: 'machine-vitals-open-doctor',
        }}
      />
    </ItemGroup>
  );
}

const styles = StyleSheet.create(() => ({
  loadingMeter: {
    paddingTop: 12,
  },
}));

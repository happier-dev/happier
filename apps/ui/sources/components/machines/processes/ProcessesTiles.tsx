import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CapacityBar,
  HappierSkeletonBlock,
} from '@happier-dev/plugin-ui/presentation';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { MachinePressureIndicator } from '@/components/machines/summary/MachinePressureIndicator';
import {
  resolveMachineResourceToneColor,
  type MachineResourceTone,
} from '@/components/machines/summary/machineSummaryStripModel';
import {
  formatMachineBytes,
  machineBytesParts,
  resolveMemoryTone,
  selectMemoryReason,
} from '@/components/machines/vitals/machineVitalsPresentation';
import {
  formatVitalsLoad,
  formatVitalsPercent,
} from '@/components/machines/vitals/vitalsFormat';
import {
  VitalsSheet,
  VitalsSubLine,
  VitalsTile,
  VitalsTileRoomContext,
  VitalsValue,
  type VitalsTileRoom,
} from '@/components/machines/vitals/VitalsSheet';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import type { ProcessesMeterNote } from './useProcessesController';

/** A phone's tiles are meter rows (lab `rp` Hp): the label and figure on one line, the meter beneath. */
const PHONE_TILE_ROOM: VitalsTileRoom = Object.freeze({ layout: 'line', instruments: 'primary', chartMaximum: false, inset: true, chart: 'plot', fill: false, title: true });

export type ProcessesTilesInput = Readonly<{
  sample: MachineVitalsSampleV1 | null;
  /** The machine's CPU busy share as the resource summary retains it (a sample may lack one). */
  cpuBusyPct: number | null;
  attention: MachineResourceAttentionV1 | null;
  happierBytes: number | null;
  happierCount: number;
  leftBehindCount: number;
  /** Memory already given back by a stop the next sample has not measured yet. */
  pendingFreedBytes: number;
  meterNote: ProcessesMeterNote | null;
  onLeftBehind: (() => void) | null;
  loading: boolean;
  compact: boolean;
}>;

function Meter(
  props: Readonly<{
    label: string;
    value: number | null;
    capacity: number | null;
    tone: MachineResourceTone;
    projected?: number | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const pluginTheme = usePluginUiTheme(theme);
  const fill =
    props.tone === 'calm'
      ? theme.colors.text.tertiary
      : resolveMachineResourceToneColor(props.tone, theme.colors);
  return (
    <CapacityBar
      testID={props.testID}
      theme={pluginTheme}
      label={props.label}
      value={props.value}
      capacity={props.capacity}
      color={fill}
      trackColor={theme.colors.border.default}
      size="inline"
      showCaption={false}
      animated
      reducedMotion={reducedMotion}
      {...(props.projected !== undefined && props.projected !== null
        ? { projection: 'remaining' as const, projected: props.projected }
        : {})}
    />
  );
}

/** The reserved line under the memory meter: the preview, then what was freed with the way back. */
function MeterNoteLine(props: Readonly<{ note: ProcessesMeterNote | null }>) {
  const { note } = props;
  if (!note) return <Text style={styles.note}> </Text>;
  if (note.kind === 'preview') {
    return (
      <Text testID="machine-processes-stop-preview" style={styles.note}>
        {t('machineProcesses.tiles.stopFrees', {
          amount: formatMachineBytes(note.bytes, 'memory'),
        })}
      </Text>
    );
  }
  return (
    <View
      style={styles.noteRow}
      accessibilityLiveRegion="polite"
      testID="machine-processes-freed"
    >
      <Text style={[styles.note, styles.noteStrong]}>
        {note.bytes === null
          ? t('machineProcesses.tiles.stopped', { name: note.name })
          : t('machineProcesses.tiles.freed', {
              amount: formatMachineBytes(note.bytes, 'memory'),
            })}
      </Text>
      {note.startAgain ? (
        <>
          <Text style={styles.note} aria-hidden>
            ·
          </Text>
          <TextLinkButton
            testID="machine-processes-start-again"
            label={t('machineProcesses.tiles.startAgain')}
            tone="strong"
            onPress={note.startAgain}
          />
        </>
      ) : null}
    </View>
  );
}

/**
 * The three vitals above the tree (lab `rp` H / K): the machine's memory — the stage the stop moment moves —
 * its CPU, and Happier's part with what was left behind. The machine's figures are plan 20's sample and
 * published attention; Happier's are the process answer's. A stop shows on the meter before the next
 * sample measures it, and the meter eases (CapacityBar `animated`); totals change at once.
 */
export const ProcessesTiles = React.memo(function ProcessesTiles(
  props: ProcessesTilesInput,
) {
  const { theme } = useUnistyles();
  if (props.loading) return <ProcessesTilesLoading compact={props.compact} />;
  const memory = props.sample?.memory.reported ? props.sample.memory : null;
  const cpu = props.sample?.cpu.reported ? props.sample.cpu : null;
  const cpuPercent = props.cpuBusyPct === null ? '—' : formatVitalsPercent(props.cpuBusyPct);
  const reason = selectMemoryReason(props.attention);
  const tone = resolveMemoryTone(props.attention);
  const freed = props.pendingFreedBytes;
  const used = memory ? Math.max(0, memory.usedBytes - freed) : null;
  const free = memory
    ? machineBytesParts(memory.availableBytes + freed, 'memory')
    : null;
  const preview =
    props.meterNote?.kind === 'preview' ? props.meterNote.bytes : null;
  const noPressure = memory?.pressure.level === 'not_reported';
  const happier =
    props.happierBytes === null
      ? null
      : Math.max(0, props.happierBytes - freed);
  const happierParts =
    happier === null ? null : machineBytesParts(happier, 'memory');

  const memoryTile = (
    <VitalsTile
      key="memory"
      testID="machine-processes-tile-memory"
      label={t('machineProcesses.tiles.memory')}
      labelAccessory={
        memory && !noPressure ? (
          <MachinePressureIndicator
            level={reason?.pressure ?? 'calm'}
            tone={tone}
            size="small"
          />
        ) : undefined
      }
      meta={
        memory ? (
          <Text style={styles.meta}>
            {formatMachineBytes(memory.totalBytes, 'memory')}
          </Text>
        ) : null
      }
      value={
        memory && free ? (
          noPressure ? (
            <VitalsValue
              value={formatVitalsPercent(
                memory.totalBytes > 0
                  ? ((used ?? 0) / memory.totalBytes) * 100
                  : 0,
              )}
              unit="%"
              phrase={t('machineProcesses.tiles.inUse')}
            />
          ) : (
            <VitalsValue
              value={free.value}
              unit={free.unit}
              phrase={t('machineProcesses.tiles.free')}
              color={
                tone === 'calm'
                  ? undefined
                  : resolveMachineResourceToneColor(tone, theme.colors)
              }
            />
          )
        ) : (
          <VitalsValue value="—" />
        )
      }
    >
      <Meter
        testID="machine-processes-memory-meter"
        label={
          memory && free
            ? t('machineProcesses.tiles.memoryLabel', {
                free: `${free.value} ${free.unit}`,
                total: formatMachineBytes(memory.totalBytes, 'memory'),
              })
            : t('machineProcesses.tiles.memory')
        }
        value={used}
        capacity={memory?.totalBytes ?? null}
        tone={tone}
        projected={
          preview !== null && used !== null ? Math.max(0, used - preview) : null
        }
      />
      {/* A phone has no pointer to preview a stop with, so it reserves no line; what a stop freed, with its way back, still shows. */}
      {!props.compact || props.meterNote?.kind === 'freed' ? (
        <MeterNoteLine note={props.meterNote} />
      ) : null}
    </VitalsTile>
  );
  const cpuTile = (
    <VitalsTile
      key="cpu"
      testID="machine-processes-tile-cpu"
      label={t('machineProcesses.tiles.cpu')}
      meta={
        cpu?.load1 !== undefined ? (
          <Text style={styles.meta}>
            {t('machineProcesses.tiles.load', {
              load: formatVitalsLoad(cpu.load1),
            })}
          </Text>
        ) : null
      }
      value={
        <VitalsValue
          value={cpuPercent}
          {...(props.cpuBusyPct === null ? {} : { unit: '%' })}
        />
      }
    >
      <Meter
        label={t('machineProcesses.tiles.cpuLabel', {
          percent: cpuPercent,
        })}
        value={props.cpuBusyPct}
        capacity={100}
        tone="calm"
      />
      <Text style={styles.note}> </Text>
    </VitalsTile>
  );
  const happierTile = (
    <VitalsTile
      key="happier"
      testID="machine-processes-tile-happier"
      label={t('machineProcesses.tiles.happier')}
      meta={
        props.leftBehindCount > 0 && props.onLeftBehind ? (
          <TextLinkButton
            testID="machine-processes-tile-left-behind"
            label={t('machineProcesses.tiles.leftBehind', {
              count: props.leftBehindCount,
            })}
            tone="strong"
            onPress={props.onLeftBehind}
          />
        ) : null
      }
      value={
        happierParts ? (
          <VitalsValue
            value={happierParts.value}
            unit={happierParts.unit}
            phrase={t('machineProcesses.tiles.inProcesses', {
              count: props.happierCount,
            })}
          />
        ) : (
          <VitalsValue value="—" />
        )
      }
      sub={undefined}
    >
      <Meter
        label={
          happierParts
            ? t('machineProcesses.tiles.happierLabel', {
                amount: `${happierParts.value} ${happierParts.unit}`,
                count: props.happierCount,
              })
            : t('machineProcesses.tiles.happier')
        }
        value={happier}
        capacity={used}
        tone="calm"
      />
      {props.compact ? null : (
        <VitalsSubLine>{t('machineProcesses.tiles.ofMemoryInUse')}</VitalsSubLine>
      )}
    </VitalsTile>
  );
  // Phone (lab `rp` Hp): memory and Happier's part as two meter rows; CPU sits on each row instead.
  return props.compact ? (
    <VitalsTileRoomContext.Provider value={PHONE_TILE_ROOM}>
      <VitalsSheet testID="machine-processes-tiles" columns={3}>
        {[memoryTile, happierTile]}
      </VitalsSheet>
    </VitalsTileRoomContext.Provider>
  ) : (
    <VitalsSheet testID="machine-processes-tiles" columns={3}>
      {[memoryTile, cpuTile, happierTile]}
    </VitalsSheet>
  );
});

function ProcessesTilesLoading(props: Readonly<{ compact: boolean }>) {
  const { theme } = useUnistyles();
  const color = theme.colors.surface.skeleton;
  const keys = props.compact
    ? (['memory', 'happier'] as const)
    : (['memory', 'cpu', 'happier'] as const);
  const sheet = (
    <VitalsSheet testID="machine-processes-tiles-loading" columns={3}>
      {keys.map((key) => (
        <VitalsTile
          key={key}
          label={t(`machineProcesses.tiles.${key}`)}
          value={<HappierSkeletonBlock color={color} width={64} height={props.compact ? 14 : 18} />}
        >
          <HappierSkeletonBlock color={color} width="100%" height={4} />
          {props.compact ? null : <Text style={styles.note}> </Text>}
        </VitalsTile>
      ))}
    </VitalsSheet>
  );
  return props.compact ? (
    <VitalsTileRoomContext.Provider value={PHONE_TILE_ROOM}>{sheet}</VitalsTileRoomContext.Provider>
  ) : sheet;
}

const styles = StyleSheet.create((theme) => ({
  meta: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
  note: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    minHeight: 18,
  },
  noteStrong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: 18,
  },
}));

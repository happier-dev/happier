import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { machineDiskName } from '@/components/machines/storage/storageViewModel';
import { resolveMachineResourceToneColor } from '@/components/machines/summary/machineSummaryStripModel';
import { t } from '@/text';

import {
  formatMachineBytes,
  formatMachinePartOfWhole,
  machineBytesParts,
  resolveVolumeTone,
  resolveMetricWarningTone,
  selectHeadlineVolume,
} from './machineVitalsPresentation';
import { VitalsMeterRow } from './VitalsMeterRow';
import {
  VitalsMeta,
  VitalsSubLine,
  VitalsTile,
  VitalsValue,
} from './VitalsSheet';

type Volume = Extract<
  MachineVitalsSampleV1['disk'],
  { reported: true }
>['volumes'][number];

const diskName = (volume: Volume) => machineDiskName({ label: volume.label, mountPath: volume.mount });

/**
 * One capacity per row: APFS volumes report their container's free space, so the volumes of one container
 * are one row named by all of them, never a remainder split that would invent per-volume free space.
 */
function groupVolumes(
  volumes: readonly Volume[],
): readonly Readonly<{ volume: Volume; label: string }>[] {
  const containers = new Map<string, Volume[]>();
  const rows: Readonly<{ volume: Volume; label: string }>[] = [];
  for (const volume of volumes) {
    if (!volume.apfsContainerId) {
      rows.push({ volume, label: diskName(volume) });
      continue;
    }
    const members = containers.get(volume.apfsContainerId);
    if (members) members.push(volume);
    else {
      containers.set(volume.apfsContainerId, [volume]);
      rows.push({ volume, label: diskName(volume) });
    }
  }
  return rows.map((row) => {
    const members = row.volume.apfsContainerId
      ? (containers.get(row.volume.apfsContainerId) ?? [])
      : [];
    return members.length > 1
      ? {
          volume: row.volume,
          label: members.map(diskName).join(' · '),
        }
      : row;
  });
}

/**
 * Disk (lab `rv` O / OE): the volume that needs you, else the tightest, as the headline, then every volume
 * as a meter filling by what is used. Only a volume with a reason takes a tone; a volume that cannot take
 * new files although bytes remain says so in place. Decisions never use purgeable space; it is a quiet
 * hatched stretch inside the used part.
 */
export const DiskTile = React.memo(function DiskTile(
  props: Readonly<{
    sample: MachineVitalsSampleV1;
    attention: MachineResourceAttentionV1 | null;
    /** What Happier keeps on each volume (plan 40's storage summary), by volume id; absent until sized. */
    happierBytesByVolume?: ReadonlyMap<string, number> | null;
    /** A Metric widget's "Warn above": a volume used past this percent takes the amber tone (never calms a reason). */
    warnAbovePct?: number;
  }>,
) {
  const { theme } = useUnistyles();
  const toneOf = (volume: Readonly<{ id: string; totalBytes: number; availableBytes: number }>) => {
    const tone = resolveVolumeTone(props.attention, volume.id);
    return resolveMetricWarningTone(tone, volume.totalBytes > 0
      ? ((volume.totalBytes - volume.availableBytes) / volume.totalBytes) * 100 : null, props.warnAbovePct);
  };
  const disk = props.sample.disk.reported ? props.sample.disk : null;
  const rows = React.useMemo(
    () => (disk ? groupVolumes(disk.volumes) : []),
    [disk],
  );
  const headline = disk
    ? selectHeadlineVolume(
        rows.map((row) => row.volume),
        props.attention,
      )
    : null;
  if (!disk || !headline) {
    return (
      <VitalsTile
        testID="machine-vitals-disk"
        label={t('machineVitals.disk.title')}
        value={
          <VitalsValue
            value={t('machineVitals.unmeasured')}
            color={theme.colors.text.tertiary}
          />
        }
        sub={<VitalsSubLine>{t('machineVitals.notReported')}</VitalsSubLine>}
      />
    );
  }
  const headlineTone = toneOf(headline);
  const free = machineBytesParts(headline.availableBytes, 'storage');
  const headlineLabel =
    rows.find((row) => row.volume.id === headline.id)?.label ?? diskName(headline);
  const full = rows.find((row) => row.volume.inodesExhausted);
  const happierOnHeadline = props.happierBytesByVolume?.get(headline.id) ?? null;
  return (
    <VitalsTile
      testID="machine-vitals-disk"
      label={t('machineVitals.disk.title')}
      meta={
        rows.length > 1 ? (
          <VitalsMeta>
            {t('machineVitals.disk.volumes', { count: rows.length })}
          </VitalsMeta>
        ) : null
      }
      value={
        <VitalsValue
          value={free.value}
          unit={free.unit}
          phrase={t('machineVitals.disk.freeOn', { volume: headlineLabel })}
          color={
            headlineTone === 'calm'
              ? undefined
              : resolveMachineResourceToneColor(headlineTone, theme.colors)
          }
        />
      }
      sub={
        full ? (
          <VitalsSubLine>
            {t('machineVitals.disk.noNewFiles', { volume: full.label })}
          </VitalsSubLine>
        ) : happierOnHeadline !== null ? (
          <VitalsSubLine testID="machine-vitals-disk-happier">
            {rows.length > 1
              ? t('machineVitals.disk.happierUsesOn', { amount: formatMachineBytes(happierOnHeadline, 'storage'), volume: headlineLabel })
              : t('machineVitals.disk.happierUses', { amount: formatMachineBytes(happierOnHeadline, 'storage') })}
          </VitalsSubLine>
        ) : null
      }
    >
      {rows.map(({ volume, label }) => {
        const figure = formatMachinePartOfWhole(
          volume.availableBytes,
          volume.totalBytes,
          'storage',
          'part',
        );
        const used = Math.max(0, volume.totalBytes - volume.availableBytes);
        const purgeable =
          volume.availableIncludingPurgeableBytes !== undefined
            ? Math.max(
                0,
                volume.availableIncludingPurgeableBytes - volume.availableBytes,
              )
            : 0;
        return (
          <VitalsMeterRow
            key={volume.id}
            testID={`machine-vitals-volume-${volume.id}`}
            label={label}
            strongLabel
            part={figure.part}
            partWord={t('machineVitals.disk.freeWord')}
            whole={t('machineVitals.ofTotal', { total: figure.whole })}
            used={used}
            capacity={volume.totalBytes}
            tone={toneOf(volume)}
            reclaimable={purgeable}
            note={
              volume.inodesExhausted && volume !== full?.volume
                ? t('machineVitals.disk.noNewFilesShort')
                : null
            }
            accessibilityLabel={[
              t('machineVitals.disk.volumeLabel', {
                volume: label,
                free: formatMachineBytes(volume.availableBytes, 'storage'),
                total: formatMachineBytes(volume.totalBytes, 'storage'),
              }),
              purgeable > 0
                ? t('machineVitals.disk.purgeable', {
                    amount: formatMachineBytes(purgeable, 'storage'),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(', ')}
          />
        );
      })}
    </VitalsTile>
  );
});

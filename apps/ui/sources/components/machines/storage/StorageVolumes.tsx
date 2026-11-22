import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics, type CompositionSegment } from '@happier-dev/plugin-ui/presentation';

import { StorageCapacityRow } from '@/components/storage/StorageCapacityRow';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { formatMachineBytes, formatMachinePartOfWhole } from '@/components/machines/vitals/machineVitalsPresentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { describeStorageVolumeCleanupRefusal, isStorageSystemPartition, resolveStorageVolumeParts, storageVolumeMountHint, storageVolumeName, type StorageSummary, type StorageVolume } from './storageViewModel';

/**
 * The disks (plan 40 STO-1, lab `rs` H / HR): one bar per volume — everything else, Happier, what is
 * in the pile as Happier's hatched ghost, and free — with the exact amounts beneath and, once something
 * is collected, the free space after cleanup. Totals are the machine's volume facts; nothing scans.
 */
export const StorageVolumes = React.memo(function StorageVolumes(props: Readonly<{ summary: StorageSummary; compact: boolean }>) {
    usePreferredLanguage();
    const volumes = props.summary.volumes.filter(volume => !isStorageSystemPartition(volume));
    if (volumes.length === 0) return null;
    return (
        <ItemGroup accessibilityLabel={t('machineStorage.volumes.label')}>
            {volumes.map(volume => <StorageVolumeRow key={volume.volume.volumeId} volume={volume} compact={props.compact} />)}
        </ItemGroup>
    );
});

/** One disk's bar; the review sheet reuses it with the reviewed bytes as the ghost and "after the Trash empties". */
export const StorageVolumeRow = React.memo(function StorageVolumeRow(props: Readonly<{ volume: StorageVolume; compact: boolean; showDivider?: boolean;
    after?: 'cleanup' | 'trashEmpties' }>) {
    const language = usePreferredLanguage();
    const { theme } = useUnistyles();
    const { volume } = props;
    const name = storageVolumeName(volume);
    const hint = storageVolumeMountHint(volume);
    const parts = resolveStorageVolumeParts(volume);
    const refusal = describeStorageVolumeCleanupRefusal(volume);
    const figure = formatMachinePartOfWhole(parts.free, volume.totalBytes, 'storage', 'part');
    const holdsHappier = parts.happier + parts.pile + parts.trash > 0;
    // Happier's share is the one signature accent of the usage chart language (`usageAccent.ts`).
    const happierColor = usageSignatureAccent(theme);
    const segments = React.useMemo((): CompositionSegment[] => [
        { id: 'else', label: t('machineStorage.volumes.everythingElse'), value: parts.everythingElse, color: theme.colors.text.tertiary },
        ...(holdsHappier ? [{ id: 'happier', label: t('machineStorage.volumes.happier'), value: parts.happier + parts.pile + parts.trash, color: happierColor }] : []),
        ...(parts.pile > 0 ? [{ id: 'pile', label: t('machineStorage.volumes.inPile'), value: parts.pile, color: happierColor, pattern: 'hatched' as const }] : []),
        ...(parts.trash > 0 ? [{ id: 'trash', label: t('machineStorage.volumes.inTrash'), value: parts.trash, color: happierColor, pattern: 'hatched' as const }] : []),
        ...((parts.purgeable ?? 0) > 0 ? [{ id: 'purgeable', label: t('machineStorage.volumes.purgeable'), value: parts.purgeable, color: theme.colors.text.tertiary, pattern: 'hatched' as const }] : []),
        { id: 'free', label: t('machineStorage.volumes.free'), value: parts.free, color: theme.colors.border.default },
    ], [language, happierColor, holdsHappier, parts.everythingElse, parts.free, parts.happier, parts.pile, parts.trash, parts.purgeable, theme.colors.border.default, theme.colors.text.tertiary]);
    // The bar draws Happier's part without the pile and the pile as its ghost; the legend names Happier's whole share.
    const barSegments = React.useMemo(() => segments.map(segment => segment.id === 'happier' ? { ...segment, value: parts.happier } : segment), [parts.happier, segments]);
    // Free is already the row's figure; the legend names it beside Happier, or says this disk holds none of it.
    const legendSegments = React.useMemo((): CompositionSegment[] => holdsHappier
        ? [...segments.filter(segment => segment.id !== 'pile' && segment.id !== 'trash'), ...segments.filter(segment => segment.id === 'pile' || segment.id === 'trash')]
        : [segments[0]!, ...segments.filter(segment => segment.id === 'purgeable'), { id: 'none', label: t('machineStorage.volumes.nothingOfHappier'), value: null, color: theme.colors.border.default }],
    [language, holdsHappier, segments, theme.colors.border.default]);
    const format = React.useCallback((value: number) => formatMachineBytes(value, 'storage'), []);
    const label = t('machineStorage.volumes.barLabel', { volume: name, free: formatMachineBytes(parts.free, 'storage'), total: formatMachineBytes(volume.totalBytes, 'storage') });
    return (
        <StorageCapacityRow testID={`machine-storage-volume-${volume.volume.volumeId}`} showDivider={props.showDivider}
            title={name} hint={props.compact ? null : hint}
            figure={{ strong: figure.part, rest: t('machineStorage.volumes.freeOf', { whole: figure.whole }) }}
            label={label} total={volume.totalBytes} barSegments={barSegments} legendSegments={legendSegments} formatValue={format}>
            {refusal ? <Text testID={`machine-storage-volume-${volume.volume.volumeId}-cleanup`} style={styles.after}>{refusal}</Text> : null}
            {parts.afterCleanupFree !== null ? (
                <Text testID={`machine-storage-volume-${volume.volume.volumeId}-after`} style={styles.after}>
                    {`${t(props.after === 'trashEmpties' ? 'machineStorage.volumes.afterTrashEmpties' : 'machineStorage.volumes.afterCleanup')} `}
                    <Text style={styles.afterStrong}>{t('machineStorage.volumes.afterCleanupFree', { free: formatMachineBytes(parts.afterCleanupFree, 'storage') })}</Text>
                    {` ${t('machineStorage.volumes.afterCleanupGain', { amount: formatMachineBytes(parts.afterCleanupFree - parts.free, 'storage') })}`}
                </Text>
            ) : parts.afterTrashFree !== null ? (
                <Text testID={`machine-storage-volume-${volume.volume.volumeId}-after`} style={styles.after}>
                    {`${t('machineStorage.volumes.afterTrashEmpties')} `}
                    <Text style={styles.afterStrong}>{t('machineStorage.volumes.afterCleanupFree', { free: formatMachineBytes(parts.afterTrashFree, 'storage') })}</Text>
                    {` ${t('machineStorage.volumes.afterCleanupGain', { amount: formatMachineBytes(parts.afterTrashFree - parts.free, 'storage') })}`}
                </Text>
            ) : null}
        </StorageCapacityRow>
    );
});

const styles = StyleSheet.create((theme) => ({
    after: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        marginTop: theme.space.s6,
    },
    afterStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));

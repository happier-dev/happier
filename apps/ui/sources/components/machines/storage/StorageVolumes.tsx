import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CompositionStrip, happierPageTextMetrics, type CompositionSegment } from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { formatMachineBytes, formatMachinePartOfWhole } from '@/components/machines/vitals/machineVitalsPresentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { describeStorageVolumeCleanupRefusal, isStorageSystemPartition, resolveStorageVolumeParts, storageVolumeMountHint, storageVolumeName, type StorageSummary, type StorageVolume } from './storageViewModel';

const BAR_HEIGHT = 10;
/** A part the legend names stays visible on the bar: Happier's few GB on a 2 TB disk is still a sliver of its colour. */
const MIN_PART_WIDTH = 4;
/** The legend reads at the row-description size, like the lab's key under each disk. */
const LEGEND_TEXT = happierPageTextMetrics('meta');

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
    const pluginTheme = usePluginUiTheme(theme);
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
        <SectionContentRow testID={`machine-storage-volume-${volume.volume.volumeId}`} showDivider={props.showDivider}>
            <View style={styles.head}>
                <View style={styles.name}>
                    <Text style={styles.nameText} numberOfLines={1}>{name}</Text>
                    {hint && !props.compact ? <Text style={styles.hint} numberOfLines={1}>{hint}</Text> : null}
                </View>
                <Text style={styles.figure} numberOfLines={1}>
                    <Text style={styles.figureStrong}>{figure.part}</Text>
                    {` ${t('machineStorage.volumes.freeOf', { whole: figure.whole })}`}
                </Text>
            </View>
            <View style={styles.bar} accessible accessibilityRole="image" accessibilityLabel={label}>
                <CompositionStrip theme={pluginTheme} label={label} total={volume.totalBytes} segments={barSegments}
                    variant="bar" segmentGap={0} minimumFillWidth={MIN_PART_WIDTH} appearance={{ legend: 'compact', height: BAR_HEIGHT }} />
            </View>
            <View style={styles.legend}>
                <CompositionStrip theme={pluginTheme} label={label} total={volume.totalBytes} segments={legendSegments}
                    variant="legend" unknownLabel="" appearance={{ legend: 'compact', figure: 'value', textStyle: LEGEND_TEXT }} valueFormatter={format} />
            </View>
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
        </SectionContentRow>
    );
});

const styles = StyleSheet.create((theme) => ({
    head: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    name: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s10,
        flexShrink: 1,
        minWidth: 0,
    },
    nameText: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
        flexShrink: 0,
    },
    hint: {
        ...Typography.mono(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    figure: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        flexShrink: 0,
    },
    figureStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    bar: {
        marginTop: theme.space.s10,
    },
    legend: {
        marginTop: theme.space.s8,
    },
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

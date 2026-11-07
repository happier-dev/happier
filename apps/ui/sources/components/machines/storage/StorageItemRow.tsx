import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CapacityBar, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { StorageVerdictChip } from './storageReasonPresentation';
import { StorageCollectToggle } from './StorageCollectToggle';
import type { StorageCollectState } from './storagePileModel';
import { formatStorageSize } from './storageViewModel';

const BAR_WIDTH = 64;

/**
 * The one size bar of Storage rows (lab `rs` `.rss-row > .br`): a thing's size against the largest beside
 * it, in ink (`color` only for Happier's own), hatched once it is in the pile or the Trash. A wide row
 * draws it a step thicker than a phone row, so the hatch reads at a glance.
 */
export function StorageSizeBar(props: Readonly<{ label: string; bytes: number; largest: number; hatched: boolean; compact: boolean; color?: string }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    // Drawn for the eye: the row already says its size in the words it shows, so the bar adds no raw byte counts.
    return (
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <CapacityBar theme={pluginTheme} label={props.label} value={props.bytes} capacity={Math.max(1, props.largest)}
                size="inline" height={props.compact ? undefined : theme.space.s6} showCaption={false}
                color={props.color ?? theme.colors.text.secondary} trackColor={theme.colors.border.default}
                pattern={props.hatched ? 'hatched' : 'solid'} />
        </View>
    );
}

/**
 * One storage item, the same shape on every page behind the breakdown (lab `rs` SUB: "the row never
 * changes shape"): the thing and its evidence, a bar against the largest on its page, its size, and
 * why it stays or can go. A Trash row's bar is hatched because its space is not back yet. On a phone
 * the size rides the title line and the bar and chip sit beneath.
 */
export const StorageItemRow = React.memo(function StorageItemRow(props: Readonly<{
    testID: string;
    title: string;
    evidence: string;
    /** Null when the owner did not measure it: the row draws no bar and no size, never a zero. */
    bytes: number | null;
    /** Part of it could not be read: the size is a floor. */
    atLeast: boolean;
    largest: number;
    hatched?: boolean;
    chip: StorageVerdictChip | null;
    compact: boolean;
    showDivider: boolean;
    /** The row's box, bound to the pile; collected rows draw their bar as the pile's hatch (lab PM). */
    collect?: Readonly<{ state: StorageCollectState; onToggle: (event?: unknown) => void; onKeyDown?: (key: string, event: unknown) => boolean }>;
    /** What clearing it frees, beneath the size, when that is less than it takes ("frees 2.4 GB"). */
    freesBytes?: number;
    /** A row action in place of the chip ("Put back", "Check now"). */
    trailing?: React.ReactNode;
    dim?: boolean;
}>) {
    const sizeText = props.bytes === null ? '' : formatStorageSize(props.bytes, props.atLeast);
    const bar = props.bytes === null ? null : (
        <StorageSizeBar label={props.title} bytes={props.bytes} largest={props.largest} compact={props.compact}
            hatched={props.hatched === true || props.collect?.state === 'collected' || props.collect?.state === 'inside'} />
    );
    const chip = props.trailing ?? (props.chip ? <StorageVerdictPill chip={props.chip} /> : null);
    const frees = props.freesBytes !== undefined && props.bytes !== null && props.freesBytes < props.bytes
        ? t('machineStorage.page.frees', { amount: formatMachineBytes(props.freesBytes, 'storage') }) : null;
    const box = props.collect ? (
        <StorageCollectToggle state={props.collect.state} onPress={props.collect.onToggle} onKeyDown={props.collect.onKeyDown}
            testID={`${props.testID}-collect`} label={t('machineStorage.pile.collectLabel', { title: props.title })} />
    ) : undefined;
    const label = t('machineStorage.page.itemLabel', { title: props.title, size: sizeText, verdict: props.chip?.label ?? '' });
    if (props.compact) {
        return (
            <Item testID={props.testID} title={props.title} subtitle={props.evidence || undefined} subtitleLines={1} mode="info"
                accessibilityLabel={label} showDivider={props.showDivider}
                leftElement={box} style={props.dim ? styles.dim : undefined}
                rightElement={<Text style={styles.size}>{sizeText}</Text>}
                bottomElementInset="text" bottomElement={<View style={styles.compactBottom}>{bar}{chip ? <View style={styles.compactChip}>{chip}</View> : null}</View>} />
        );
    }
    return (
        <Item testID={props.testID} title={props.title} subtitle={props.evidence || undefined} subtitleLines={1} mode="info"
            accessibilityLabel={label} showDivider={props.showDivider}
            leftElement={box} style={props.dim ? styles.dim : undefined}
            // The meta column is facts that are never cut: the title gives way with an ellipsis instead.
            accessoryMaxWidth="row"
            rightElement={
                <View style={styles.figures}>
                    <View style={styles.bar}>{bar}</View>
                    <View style={styles.sizeColumn}>
                        <Text style={styles.size} numberOfLines={1}>{sizeText}</Text>
                        {frees ? <Text style={styles.frees} numberOfLines={1}>{frees}</Text> : null}
                    </View>
                    <View style={styles.chipColumn}>{chip}</View>
                </View>
            } />
    );
});

/**
 * The verdict chip (`StatusPill` + the one storage table), at the row's description size (lab `verdict` /
 * `reason`): the mark carries the tone and the verdict word leads in ink with its reason quieter; a
 * caution says all of it in the attention ink.
 */
export function StorageVerdictPill(props: Readonly<{ chip: StorageVerdictChip }>) {
    const { theme } = useUnistyles();
    const attention = props.chip.variant === 'attention';
    const tint = props.chip.variant === 'success' ? theme.colors.state.success.textForeground
        : attention ? theme.colors.state.attention.textForeground
            : theme.colors.text.secondary;
    const split = props.chip.word !== undefined && props.chip.detail !== undefined;
    return (
        <StatusPill variant={props.chip.variant} chrome={props.chip.chrome}
            label={split ? props.chip.word! : props.chip.label} detail={split ? props.chip.detail : undefined}
            foregroundColor={attention ? tint : theme.colors.text.primary}
            detailColor={attention ? tint : theme.colors.text.secondary}
            labelStyle={styles.chipLabel} labelNumberOfLines={1} accessibilityLabel={props.chip.label} style={styles.pillFit}
            leading={props.chip.icon ? <Icon name={props.chip.icon} size={12} color={tint} /> : undefined} />
    );
}

const styles = StyleSheet.create((theme) => ({
    figures: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s16,
    },
    bar: {
        width: BAR_WIDTH,
    },
    size: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
    },
    // Wide enough for its second line ("frees 410 MB"), as the lab's wide size column.
    sizeColumn: {
        width: 96,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    frees: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
    },
    dim: {
        opacity: 0.6,
    },
    // One meta column on every row; a long verdict truncates its reason inside it, never past the card.
    chipColumn: {
        width: 196,
        alignItems: 'flex-start',
    },
    pillFit: {
        maxWidth: '100%',
    },
    compactBottom: {
        gap: theme.space.s6,
        paddingTop: theme.space.s6,
    },
    compactChip: {
        alignItems: 'flex-start',
    },
    chipLabel: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowDescription'),
    },
}));

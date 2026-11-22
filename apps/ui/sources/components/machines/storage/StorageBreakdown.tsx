import * as React from 'react';
import { View } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { HappierStorageCategoryIdV1 } from '@happier-dev/protocol/storage/storageV1';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';

import { StorageBreakdownRow, StorageBreakdownTrailingText } from '@/components/storage/StorageBreakdownRow';
import { t } from '@/text';

import { describeStorageCategoryFacts, formatStorageDay } from './storageCategoryText';
import { STORAGE_CATEGORY_ICONS, storageCategoryShortTitle, storageCategoryTitle } from './storageReasonPresentation';
import {
    buildStorageRing,
    describeStorageCategoryTrailing,
    formatStorageSize,
    isStorageCategoryPartial,
    orderStorageCategories,
    readHappierStorageBytes,
    type StorageCategory,
    type StorageRingPart,
    type StorageSummary,
} from './storageViewModel';

/**
 * Sheet width the ring and its legend need beside full rows (ring column + glyph, a two-line title and the
 * figures at the joined bar width); narrower, the rows stand alone. Measured on the sheet, not the pane.
 */
const RING_MIN_WIDTH = 780;
const RING_SIZE = 172;
const RING_STROKE = 20;
/** One ink, four steps lighter: the kinds read as parts of one whole, not as competing colours. */
const RING_TONES = [1, 0.62, 0.4, 0.22] as const;
/**
 * Item's right slot is at most half the row, chevron included. Full figures need a row of about
 * `FULL_FIGURES_MIN_ROW`; narrower rows (beside the ring, or a narrow sheet) take the narrow figures.
 */
const FULL_FIGURES_MIN_ROW = 780;

/**
 * What Happier keeps, by kind (plan 40 STO-2/STO-5, lab `rs` H / HR / HRV ★ / Hp): one row per kind
 * with its evidence, a bar against the largest, its size and what can go; on a wide page the ring of
 * the same parts joins the rows, the pile as its hatched arc and what would be left in its centre.
 * Each row opens that kind's page.
 */
export const StorageBreakdown = React.memo(function StorageBreakdown(props: Readonly<{
    serverId: string;
    machineId: string;
    summary: StorageSummary;
    compact: boolean;
    /** Protection awaits the machine's resources policy: sizes only, no "can go" and no "always kept". */
    cleanupHidden?: boolean;
    onOpenCategory: (categoryId: HappierStorageCategoryIdV1) => void;
}>) {
    const [width, setWidth] = React.useState(0);
    const policy = useMachineResourcesPolicy({ serverId: props.serverId, machineId: props.machineId }).policy?.storage ?? null;
    const categories = orderStorageCategories(props.summary);
    const largest = categories.reduce((max, category) => Math.max(max, category.size.allocatedBytes), 0);
    const total = readHappierStorageBytes(props.summary);
    const withRing = !props.compact && width >= RING_MIN_WIDTH && total > 0;
    const rows = categories.map((category, index) => (
        <StorageCategoryRow key={category.categoryId} serverId={props.serverId} machineId={props.machineId} category={category} summary={props.summary} largest={largest}
            facts={describeStorageCategoryFacts(category, policy)} compact={props.compact} cleanupHidden={props.cleanupHidden === true}
            narrowFigures={withRing || width < FULL_FIGURES_MIN_ROW}
            showDivider={index < categories.length - 1} onOpen={props.onOpenCategory} />
    ));
    return (
        <View testID="machine-storage-breakdown">
            <ItemGroup
                title={t('machineStorage.breakdown.title', { amount: formatMachineBytes(total, 'storage') })}
                titleAccessory={<BreakdownAccessory compact={props.compact} />}>
                <View onLayout={event => {
                    const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
                    if (visibleWidth !== null) setWidth(Math.round(visibleWidth));
                }}>
                    {withRing ? (
                        <View style={styles.joined}>
                            <StorageRing summary={props.summary} />
                            <View style={styles.joinedRows}>{rows}</View>
                        </View>
                    ) : rows}
                </View>
            </ItemGroup>
        </View>
    );
});

function BreakdownAccessory(props: Readonly<{ compact: boolean }>) {
    return <Text style={styles.accessory}>{t(props.compact ? 'machineStorage.breakdown.accessoryShort' : 'machineStorage.breakdown.accessory')}</Text>;
}

/**
 * One kind (SUB's row anatomy at the breakdown's scale): glyph, name, evidence; a bar against the
 * largest kind; its size; and what can go, that it is always kept, or when the Trash empties. On a
 * phone the size rides the title line and the bar and "can go" sit beneath (lab `rs` Hp).
 */
export const StorageCategoryRow = React.memo(function StorageCategoryRow(props: Readonly<{
    serverId: string;
    machineId: string;
    category: StorageCategory;
    summary: StorageSummary;
    largest: number;
    facts: string;
    compact: boolean;
    cleanupHidden?: boolean;
    /** The row is too narrow for the full figures (beside the ring, or a narrow sheet). */
    narrowFigures?: boolean;
    showDivider: boolean;
    onOpen: (categoryId: HappierStorageCategoryIdV1) => void;
}>) {
    const { theme } = useUnistyles();
    const { category, onOpen } = props;
    const title = storageCategoryTitle(category.categoryId);
    const size = formatStorageSize(category.size.allocatedBytes, isStorageCategoryPartial(category));
    const described = describeStorageCategoryTrailing(category, props.summary);
    const trailing = props.cleanupHidden && (described.kind === 'can_go' || described.kind === 'always_kept') ? { kind: 'none' as const } : described;
    const trailingNode = trailing.kind === 'can_go' ? (
        <StorageBreakdownTrailingText strong={formatMachineBytes(trailing.bytes, 'storage')} text={t('machineStorage.breakdown.canGo')} />
    ) : trailing.kind === 'always_kept' ? (
        <View style={styles.kept}>
            <Icon name="lock" size={12} color={theme.colors.text.tertiary} />
            <Text style={[styles.trailing, styles.keptText]} numberOfLines={1}>{t('machineStorage.breakdown.alwaysKept')}</Text>
        </View>
    ) : trailing.kind === 'trash' ? (
        <TrashEmptyNow serverId={props.serverId} machineId={props.machineId}
            fallback={trailing.emptiesAt !== null ? <StorageBreakdownTrailingText text={t('machineStorage.breakdown.empties', { date: formatStorageDay(trailing.emptiesAt) })} /> : null} />
    ) : null;
    const open = React.useCallback(() => onOpen(category.categoryId), [category.categoryId, onOpen]);
    const icon = <Icon name={STORAGE_CATEGORY_ICONS[category.categoryId]} size={18} color={theme.colors.text.secondary} />;
    return (
        <StorageBreakdownRow testID={`machine-storage-category-${category.categoryId}`} icon={icon} title={title} facts={props.facts}
            bytes={category.size.allocatedBytes} largest={props.largest} size={size} hatched={category.categoryId === 'trash'}
            trailing={trailingNode} trailingPressable={trailing.kind === 'trash'} compact={props.compact}
            narrowFigures={props.narrowFigures} showDivider={props.showDivider} onPress={open} />
    );
});

/** The Trash row's "Empty now" delegates every entry this person may empty to the Action policy. */
function TrashEmptyNow(props: Readonly<{ serverId: string; machineId: string; fallback: React.ReactNode }>) {
    const cleanup = useMachineStorageCleanup({ machineId: props.machineId, serverId: props.serverId });
    if (!cleanup.enabled) return <>{props.fallback}</>;
    return (
        <TextLinkButton testID="machine-storage-category-trash-empty" tone="strong" label={t('machineStorage.pile.emptyNow')}
            onPress={() => cleanup.empty({})} />
    );
}

/**
 * The ring of Happier's kinds (lab `rs` HRV ★): three named kinds and the rest, one ink in four
 * tones, the pile hatched; the centre says the total and, with a pile, what would be left.
 */
export function StorageRing(props: Readonly<{ summary: StorageSummary }>) {
    const { theme } = useUnistyles();
    const ring = buildStorageRing(props.summary);
    const ink = theme.colors.text.secondary;
    const segments = ring.parts.map(part => part.kind === 'pile'
        ? { fraction: part.fraction, color: theme.colors.text.primary, pattern: 'hatched' as const }
        : { fraction: part.fraction, color: ink, opacity: RING_TONES[part.tone] });
    const total = formatMachineBytes(ring.totalBytes, 'storage');
    return (
        <View testID="machine-storage-ring" style={styles.ringColumn}>
            <CapacityRing size={RING_SIZE} strokeWidth={RING_STROKE} segments={segments} trackColor={theme.colors.border.default}
                accessibilityLabel={t('machineStorage.breakdown.ringLabel', { amount: total })}>
                <Text style={styles.ringTotal}>{total}</Text>
                {ring.pileBytes > 0 ? <Text style={styles.ringAfter}>{t('machineStorage.breakdown.ringAfter', { amount: formatMachineBytes(ring.afterBytes, 'storage') })}</Text> : null}
            </CapacityRing>
            <View style={styles.ringLegend}>
                {ring.parts.map(part => <RingLegendRow key={part.id} part={part} ink={ink} hatch={theme.colors.text.primary} />)}
            </View>
        </View>
    );
}

function RingLegendRow(props: Readonly<{ part: StorageRingPart; ink: string; hatch: string }>) {
    const { part } = props;
    const label = part.kind === 'pile' ? t('machineStorage.volumes.inPile')
        : part.kind === 'rest' ? t('machineStorage.breakdown.theRest') : storageCategoryShortTitle(part.categoryId!);
    return (
        <View style={styles.ringLegendRow} accessible accessibilityLabel={`${label}, ${formatMachineBytes(part.bytes, 'storage')}`}>
            {part.kind === 'pile'
                ? <View style={[styles.swatch, styles.swatchHatched, { borderColor: props.hatch }]} />
                : <View style={[styles.swatch, { backgroundColor: props.ink, opacity: RING_TONES[part.tone] }]} />}
            <Text style={styles.ringLegendLabel} numberOfLines={1}>{label}</Text>
            <Text style={styles.ringLegendValue} numberOfLines={1}>{formatMachineBytes(part.bytes, 'storage')}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    accessory: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
    joined: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    joinedRows: {
        flex: 1,
        minWidth: 0,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
    },
    ringColumn: {
        width: 236,
        paddingHorizontal: theme.space.s24,
        paddingVertical: theme.space.s24,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s24,
    },
    ringTotal: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 28,
        letterSpacing: -0.4,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    ringAfter: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    ringLegend: {
        alignSelf: 'stretch',
        gap: theme.space.s6,
    },
    ringLegendRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    swatch: {
        width: 8,
        height: 8,
        borderRadius: 2,
    },
    swatchHatched: {
        borderWidth: 1.5,
    },
    ringLegendLabel: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        flex: 1,
    },
    ringLegendValue: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    trailing: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    // Stays inside its column in every language: a long "Always kept" truncates rather than running into the size.
    kept: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        maxWidth: '100%',
    },
    keptText: {
        flexShrink: 1,
    },
}));

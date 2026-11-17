import * as React from 'react';
import { Pressable, ScrollView, StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DateTimePickerPopoverProps } from './DateTimePickerPopover';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_MENU_ROW_METRICS, HAPPIER_MENU_ROW_SHAPE, HappierPressable } from '@happier-dev/plugin-ui/presentation';

const DAY_SIZE = 44;
export function isDateTimePickerPopoverAvailable(): boolean { return true; }

const TIME_OPTION_HEIGHT = 44;
/** Hour and minute rows are menu rows: they touch, so the pitch is the row (owner 11-16, popovers are full-bleed). */
export const TIME_OPTION_PITCH = TIME_OPTION_HEIGHT;

/**
 * Scroll offset that brings the selected row into the column, centred when the measured column is
 * tall enough. Derived from the row geometry below rather than a literal, so the last minutes stay
 * reachable instead of scrolling the selection out of view.
 */
export function resolveTimeColumnScrollOffset(params: Readonly<{
    selected: number;
    viewportHeight: number;
}>): number {
    const rowTop = params.selected * TIME_OPTION_PITCH;
    const centringInset = Math.max(0, (params.viewportHeight - TIME_OPTION_HEIGHT) / 2);
    return Math.max(0, rowTop - centringInset);
}
const MONDAY = new Date(2024, 0, 1, 12);

function dayOrdinal(value: Date): number {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

function monthGrid(month: Date): Date[] {
    const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const startOffset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) =>
        new Date(first.getFullYear(), first.getMonth(), 1 - startOffset + index, 12));
}

function withTimePart(value: Date, hour: number, minute: number): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), hour, minute, 0, 0);
}

function PickerHeader(props: Readonly<{ title: string; onPrevious?: () => void; onNext?: () => void }>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    return <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: theme.colors.text.primary }]}>{props.title}</Text>
        {props.onPrevious && props.onNext ? <View style={styles.headerActions}>
            <HappierPressable accessibilityRole="button" accessibilityLabel={`${t('common.previous')}: ${props.title}`} onPress={props.onPrevious} style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? paintColor(theme.colors.surface.pressed) : 'transparent' }]}>
                <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
            </HappierPressable>
            <HappierPressable accessibilityRole="button" accessibilityLabel={`${t('common.next')}: ${props.title}`} onPress={props.onNext} style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? paintColor(theme.colors.surface.pressed) : 'transparent' }]}>
                <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
            </HappierPressable>
        </View> : null}
    </View>;
}

function CalendarPicker(props: DateTimePickerPopoverProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const [visibleMonth, setVisibleMonth] = React.useState(() => new Date(props.value.getFullYear(), props.value.getMonth(), 1, 12));
    const days = React.useMemo(() => monthGrid(visibleMonth), [visibleMonth]);
    const weekdayLabels = React.useMemo(() => Array.from({ length: 7 }, (_, index) =>
        new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2024, 0, MONDAY.getDate() + index, 12))), []);
    const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(visibleMonth);
    const selectedOrdinal = dayOrdinal(props.value);
    const minimumOrdinal = dayOrdinal(props.minimumDate);
    const todayOrdinal = dayOrdinal(new Date());

    return <View testID="date-time-picker-date-picker" style={styles.calendar}>
        <PickerHeader
            title={monthLabel}
            onPrevious={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1, 12))}
            onNext={() => setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1, 12))}
        />
        <View style={styles.weekRow}>
            {weekdayLabels.map((label, index) => <Text key={`${label}-${index}`} style={[styles.weekday, { color: theme.colors.text.tertiary }]}>{label}</Text>)}
        </View>
        <View style={styles.dayGrid}>
            {days.map((day) => {
                const ordinal = dayOrdinal(day);
                const selected = ordinal === selectedOrdinal;
                const disabled = ordinal < minimumOrdinal;
                const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
                return <Pressable
                    key={ordinal}
                    testID={`date-time-picker-calendar-day-${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`}
                    accessibilityRole="button"
                    accessibilityLabel={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day)}
                    accessibilityState={{ selected, disabled }}
                    disabled={disabled}
                    onPress={() => {
                        props.onChange(withTimePart(day, props.value.getHours(), props.value.getMinutes()));
                        props.onDismiss();
                    }}
                    style={({ pressed }) => [
                        styles.day,
                        selected ? { backgroundColor: paintColor(theme.colors.button.primary.background, undefined, 'solidControl') } : null,
                        ordinal === todayOrdinal && !selected ? { borderWidth: 1, borderColor: theme.colors.border.default } : null,
                        pressed && !selected ? { backgroundColor: paintColor(theme.colors.surface.pressed) } : null,
                    ]}
                >
                    <Text style={[
                        styles.dayText,
                        { color: selected ? paintColor(theme.colors.button.primary.tint, theme.colors.text.primary, 'solidControl') : theme.colors.text.primary },
                        outsideMonth ? { opacity: 0.38 } : null,
                        disabled ? { opacity: 0.22 } : null,
                    ]}>{day.getDate()}</Text>
                </Pressable>;
            })}
        </View>
    </View>;
}

function TimeColumn(props: Readonly<{ label: string; values: readonly number[]; selected: number; accentColor: string; divided?: boolean; onSelect: (value: number) => void }>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const scrollRef = React.useRef<React.ElementRef<typeof ScrollView> | null>(null);
    const [viewportHeight, setViewportHeight] = React.useState(0);
    React.useEffect(() => {
        scrollRef.current?.scrollTo?.({
            y: resolveTimeColumnScrollOffset({ selected: props.selected, viewportHeight }),
            animated: false,
        });
    }, [props.selected, viewportHeight]);
    return <View style={[styles.timeColumn, props.divided ? { borderLeftWidth: RNStyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.divider } : null]}>
        <Text style={[styles.timeColumnLabel, { color: theme.colors.text.tertiary }]}>{props.label}</Text>
        <ScrollView
            ref={scrollRef}
            onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
            style={styles.timeScroll} contentContainerStyle={styles.timeScrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {props.values.map((value) => {
                const selected = value === props.selected;
                return <Pressable
                    key={value}
                    testID={`date-time-picker-time-${props.label.toLowerCase()}-${value}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => props.onSelect(value)}
                    style={({ pressed }) => [styles.timeOption, selected ? { backgroundColor: paintColor(theme.colors.surface.elevated) } : null, pressed ? { opacity: motionTokens.press.opacity } : null]}
                >
                    <Text style={[styles.timeOptionText, { color: selected ? theme.colors.text.primary : theme.colors.text.secondary }]}>{String(value).padStart(2, '0')}</Text>
                    {selected ? <View style={[styles.selectionDot, { backgroundColor: props.accentColor }]} /> : null}
                </Pressable>;
            })}
        </ScrollView>
    </View>;
}

function TimePicker(props: DateTimePickerPopoverProps) {
    const selectedHour = props.value.getHours();
    const selectedMinute = props.value.getMinutes();
    return <View testID="date-time-picker-time-picker" style={styles.timePicker}>
        <View style={styles.timeInset}>
            <PickerHeader title={new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(props.value)} />
        </View>
        <View style={styles.timeColumns}>
            <TimeColumn label="HH" values={Array.from({ length: 24 }, (_, value) => value)} selected={selectedHour} accentColor={props.accentColor} onSelect={(hour) => props.onChange(withTimePart(props.value, hour, selectedMinute))} />
            <TimeColumn label="MM" divided values={Array.from({ length: 60 }, (_, value) => value)} selected={selectedMinute} accentColor={props.accentColor} onSelect={(minute) => props.onChange(withTimePart(props.value, selectedHour, minute))} />
        </View>
        <View style={styles.timeFooter}><RoundButton size="small" title={t('common.done')} onPress={props.onDismiss} /></View>
    </View>;
}

export function DateTimePickerPopover(props: DateTimePickerPopoverProps) {
    return <Popover
        open={true}
        anchorRef={props.anchorRef}
        placement="bottom"
        gap={8}
        maxWidthCap={360}
        maxHeightCap={390}
        edgePadding={{ horizontal: 12, vertical: 12 }}
        portal={{ web: true, matchAnchorWidth: false, anchorAlign: props.mode === 'date' ? 'start' : 'end' }}
        onRequestClose={props.onDismiss}
        backdrop={{ enabled: true, blockOutsidePointerEvents: false }}
    >
        {({ maxHeight }) => <FloatingOverlay
            maxHeight={maxHeight}
            scrollEnabled={false}
            surfaceChrome="theme"
            containerStyle={{ width: props.mode === 'date' ? 344 : 280 }}
        >
            {props.mode === 'date' ? <CalendarPicker {...props} /> : <TimePicker {...props} />}
        </FloatingOverlay>}
    </Popover>;
}

const styles = StyleSheet.create(() => ({
    calendar: { padding: 12 },
    header: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 6 },
    headerTitle: {  ...Typography.variant('heading'),  },
    headerActions: { flexDirection: 'row', gap: 2 },
    iconButton: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    weekRow: { width: DAY_SIZE * 7, alignSelf: 'center', flexDirection: 'row', marginBottom: 4 },
    weekday: { width: DAY_SIZE, textAlign: 'center', ...Typography.variant('micro', 'semiBold'),  },
    dayGrid: { width: DAY_SIZE * 7, alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap' },
    day: { width: DAY_SIZE, height: DAY_SIZE, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
    dayText: {  ...Typography.variant('body'), fontVariant: ['tabular-nums'] },
    // The columns run to the popover's edges like every menu; the header and Done keep the inset.
    timePicker: { paddingVertical: 12 },
    timeInset: { paddingHorizontal: 12 },
    timeColumns: { height: 230, flexDirection: 'row' },
    timeColumn: { flex: 1, minWidth: 0 },
    timeColumnLabel: { paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx, paddingBottom: 6, ...Typography.variant('micro', 'semiBold') },
    timeScroll: { flex: 1 },
    timeScrollContent: { paddingBottom: 8 },
    timeOption: { ...HAPPIER_MENU_ROW_SHAPE, height: TIME_OPTION_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    timeOptionText: { ...Typography.variant('label', 'regular'), fontVariant: ['tabular-nums'] },
    selectionDot: { width: 5, height: 5, borderRadius: 3 },
    timeFooter: { alignItems: 'flex-end', paddingTop: 10, paddingHorizontal: 12 },
}));

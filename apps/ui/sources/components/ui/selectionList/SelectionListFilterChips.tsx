import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageRowFieldLayoutContext, HappierPressable, resolveHappierFocusRingVisible, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SELECTION_LIST_LARGE_POPOVER_SIZE } from './_constants';
import type { SelectionListFilter, SelectionListStep } from './_types';
import { SelectionList } from './SelectionList';

/**
 * The filter chip: what a filter is set to, as one compact bordered chip that opens a small popover
 * to change it. The one control for what a page or toolbar shows: a project, machine or catalog scope, a filter, a
 * sort. A form's own value is a field instead (`ValueFieldSelect`).
 */
export const SelectionListFilterChip = React.memo(function SelectionListFilterChip(props: Readonly<{
    filter: SelectionListFilter;
    /** Where the chip is drawn: the chip row beneath the field draws `rowValueLabel` when the filter has one. */
    placement?: 'inline' | 'row';
}>) {
    const { filter } = props;
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    // A chip keeps its own width when a narrow row moves it beneath its label; only fields span the row.
    const stackedInRow = React.useContext(HappierPageRowFieldLayoutContext)?.stacked === true;
    const styles = stylesheet;
    const anchorRef = React.useRef<View>(null);
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const open = filter.open ?? uncontrolledOpen;
    const { onOpenChange } = filter;
    const controlled = filter.open !== undefined;
    const setOpen = React.useCallback((next: boolean) => {
        if (!controlled) setUncontrolledOpen(next);
        onOpenChange?.(next);
    }, [controlled, onOpenChange]);
    const close = React.useCallback(() => setOpen(false), [setOpen]);

    const selected = filter.options?.find((option) => option.id === filter.selectedId) ?? null;
    const valueLabel = filter.valueLabel ?? selected?.label ?? '';
    const leading = filter.icon ?? selected?.icon
        ?? (filter.onToggle && filter.selected ? <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.primary} /> : null);
    const iconOnly = filter.iconOnly === true && leading !== null;
    const hasChooser = filter.renderPopoverContent !== undefined
        || (filter.options !== undefined && filter.options.length > 0 && filter.onChange !== undefined);
    const canOpen = hasChooser && filter.disabled !== true;
    const phoneSheet = filter.renderPopoverContent !== undefined || filter.selectedIds !== undefined;
    const clearable = !hasChooser && filter.onClear !== undefined && filter.disabled !== true;
    const toggleable = !hasChooser && !clearable && filter.onToggle !== undefined && filter.disabled !== true;
    // An on/off chip that is on takes the selection fill (lab dk-checks); off, it reads quieter.
    const toggledOn = toggleable && filter.selected === true;
    const testID = filter.testID ?? `selection-list-filter:${filter.id}`;

    const optionsStep = React.useMemo<SelectionListStep | null>(() => filter.options ? {
        id: `filter:${filter.id}`,
        sections: [{
            kind: 'static',
            id: `filter:${filter.id}:options`,
            options: filter.options.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.subtitle ? { subtitle: option.subtitle } : {}),
                ...(option.icon ? { icon: option.icon } : {}),
                ...(option.accessory ? { rightAccessory: option.accessory } : {}),
                ...(option.disabled ? { disabled: true } : {}),
                testID: `${testID}:${option.id}`,
            })),
        }],
    } : null, [filter.id, filter.options, testID]);
    const { onChange } = filter;
    const multiple = filter.selectedIds !== undefined;
    const handleSelect = React.useCallback((id: string) => {
        // Several choices stay open: each row toggles until the viewer is done.
        if (!multiple) setOpen(false);
        onChange?.(id);
    }, [multiple, onChange, setOpen]);

    return (
        <>
            {/* The anchor is a plain view: the popover measures it, the pressable owns interaction. */}
            <View ref={anchorRef} style={[styles.anchor, stackedInRow ? styles.anchorStacked : null, iconOnly ? styles.anchorIconOnly : null]}>
                <HappierPressable
                    testID={testID}
                    accessibilityRole={toggleable ? 'checkbox' : 'button'}
                    {...(toggleable ? { checked: filter.selected === true } : {})}
                    accessibilityLabel={clearable
                        ? [valueLabel, filter.count, filter.clearAccessibilityLabel].filter(Boolean).join(', ')
                        : [`${filter.label}: ${[valueLabel, filter.valueQualifier].filter(Boolean).join(' · ')}`, filter.note].filter(Boolean).join(', ')}
                    {...(filter.accessibilityHint === undefined ? {} : { accessibilityHint: filter.accessibilityHint })}
                    expanded={canOpen ? open : undefined}
                    hasPopup={canOpen ? 'dialog' : undefined}
                    disabled={!canOpen && !clearable && !toggleable}
                    onPress={() => (clearable ? filter.onClear?.() : toggleable ? filter.onToggle?.() : setOpen(!open))}
                    style={(state) => [
                        styles.chip,
                        filter.active ? { borderColor: theme.colors.text.link } : null,
                        state.pressed ? styles.chipPressed : null,
                        { backgroundColor: paintColor(state.pressed ? theme.colors.surface.pressed : toggledOn ? theme.colors.surface.selected : theme.colors.surface.base) },
                        toggledOn ? styles.chipToggledOn : null,
                        focusRingStyle({
                            focused: resolveHappierFocusRingVisible(state.focused),
                            color: theme.colors.border.focus,
                        }),
                    ]}
                >
                    {leading}
                    {iconOnly ? null : <>
                    {filter.showLabel ? <Text style={[styles.label, styles.labelMuted, styles.name]} numberOfLines={1}>{filter.label}</Text> : null}
                    <Text style={[styles.label, filter.muted || (toggleable && !toggledOn) ? styles.labelMuted : null, filter.active ? { color: theme.colors.text.link } : null]} numberOfLines={1}>{props.placement === 'row' ? filter.rowValueLabel ?? valueLabel : valueLabel}</Text>
                    {filter.valueQualifier ? <Text style={[styles.label, filter.muted ? styles.labelMuted : null, filter.active ? { color: theme.colors.text.link } : null, styles.qualifier]} numberOfLines={1}>{`· ${filter.valueQualifier}`}</Text> : null}
                    {filter.note ? <Text style={[styles.label, styles.labelMuted, styles.note]} numberOfLines={1}>{filter.note}</Text> : null}
                    {filter.count !== undefined || filter.reserveCount
                        ? <Text style={[styles.label, styles.labelMuted, styles.count]}>{filter.reserveCount ? reserveCountSlot(filter.count ?? '') : filter.count}</Text> : null}
                    </>}
                    {filter.presence || filter.reservePresence ? (
                        <View
                            style={[styles.dot, !filter.presence ? styles.dotReserved : null, filter.presence ? {
                                backgroundColor: filter.presence === 'online'
                                    ? theme.colors.status.connected
                                    : filter.presence === 'attention'
                                        ? theme.colors.state.warning.foreground
                                        : theme.colors.status.disconnected,
                            } : null]}
                        />
                    ) : null}
                    {canOpen && !iconOnly ? <Icon name={open ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
                    {clearable ? <Icon name="x" size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
                </HappierPressable>
            </View>
            <Popover
                open={open && canOpen}
                anchorRef={anchorRef}
                placement="bottom"
                gap={6}
                maxHeightCap={SELECTION_LIST_LARGE_POPOVER_SIZE.maxHeightCap}
                // A compact chooser: as wide as its rows need, opening from the chip's leading edge like
                // every anchored menu. The portal clamps it inside the window, so a chip on the trailing
                // edge still opens in view and a chip beside the navigation never covers it.
                portal={{ ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, sizeToContent: true }}
                containerStyle={{ paddingHorizontal: 0 }}
                onRequestClose={close}
                // A chooser that lays out its own content, or keeps several choices open, is the app's bottom
                // sheet on a phone; a plain one-tap list stays the anchored menu beside its chip.
                {...(phoneSheet ? { phonePresentation: 'sheet' as const, accessibilityLabel: filter.label } : {})}
            >
                {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        {filter.renderPopoverContent
                            ? filter.renderPopoverContent({ close, maxHeight })
                            : optionsStep ? (
                                <SelectionList
                                    testID={`${testID}.list`}
                                    rootStep={optionsStep}
                                    {...(filter.selectedIds
                                        ? { selection: { kind: 'multiple' as const, selectedIds: filter.selectedIds } }
                                        : { selectedOptionId: filter.selectedId ?? null })}
                                    onSelect={handleSelect}
                                    onRequestClose={close}
                                    listAccessibilityLabel={filter.label}
                                    maxHeight={maxHeight}
                                    disableTransitions
                                />
                            ) : null}
                    </FloatingOverlay>
                )}
            </Popover>
        </>
    );
});

/**
 * A list's filter chips, beside the field (`placement="inline"`) or on a row of their own beneath it
 * that scrolls sideways when the chips outgrow a narrow list (`placement="row"`).
 */
export function SelectionListFilterChips(props: Readonly<{
    filters: ReadonlyArray<SelectionListFilter>;
    placement: 'inline' | 'row';
    testID?: string;
}>): React.ReactElement | null {
    const styles = stylesheet;
    if (props.filters.length === 0) return null;
    const chips = props.filters.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} placement={props.placement} />);
    if (props.placement === 'inline') {
        return <View style={styles.inline}>{chips}</View>;
    }
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            testID={props.testID}
            style={styles.row}
            contentContainerStyle={styles.rowContent}
        >
            {chips}
        </ScrollView>
    );
}

/** A figure space is as wide as a tabular digit, so the slot keeps two digits' width whatever the count. */
const COUNT_SLOT_DIGITS = 2;
function reserveCountSlot(count: string): string {
    return count + '\u2007'.repeat(Math.max(0, COUNT_SLOT_DIGITS - count.length));
}

const stylesheet = StyleSheet.create((theme) => ({
    // A chip is as wide as what it says, up to the room its row offers: a value is never cut to a
    // fixed width (a long machine name keeps its whole name), it ellipsizes only when the row itself is narrower.
    anchor: {
        maxWidth: '100%',
        flexShrink: 1,
    },
    anchorStacked: {
        alignSelf: 'flex-start',
    },
    // A glyph is as wide as it is: a squeezed row never shrinks it into the control beside it.
    anchorIconOnly: {
        flexShrink: 0,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minHeight: 32,
        maxWidth: '100%',
        flexShrink: 1,
        paddingHorizontal: theme.space.s10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    chipToggledOn: {
        borderColor: 'transparent',
    },
    chipPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    label: {

        flexShrink: 1,
        ...Typography.variant('body', 'medium'),

        color: theme.colors.text.primary,
    },
    labelMuted: {
        color: theme.colors.text.secondary,
    },
    name: {
        flexShrink: 0,
        ...Typography.default(),
    },
    // Quieter than the value it follows: secondary ink at the regular weight, like the filter's name.
    note: {
        flexShrink: 0,
        ...Typography.default(),
    },
    // The telling suffix never shortens: the value before it gives way instead. It reads as the value's own
    // second word, so it closes the chip's gap to one word space.
    qualifier: {
        flexShrink: 0,
        marginLeft: -theme.space.s2,
    },
    count: {
        flexShrink: 0,
        fontVariant: ['tabular-nums'],
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    dotReserved: {
        opacity: 0,
    },
    inline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 1,
    },
    row: {
        flexGrow: 0,
    },
    // Level with the search field's edge (the field sits 8 in from the list).
    rowContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s2,
        paddingBottom: theme.space.s8,
    },
}));

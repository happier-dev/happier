import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, resolveHappierFocusRingVisible, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
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
 * to change it. The one chip for scopes and filters (the machine scope in page headers uses it too),
 * so every filter looks and behaves the same.
 */
export const SelectionListFilterChip = React.memo(function SelectionListFilterChip(props: Readonly<{
    filter: SelectionListFilter;
}>) {
    const { filter } = props;
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
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
    const leading = filter.icon ?? selected?.icon ?? null;
    const hasChooser = filter.renderPopoverContent !== undefined
        || (filter.options !== undefined && filter.options.length > 0 && filter.onChange !== undefined);
    const canOpen = hasChooser && filter.disabled !== true;
    const clearable = !hasChooser && filter.onClear !== undefined && filter.disabled !== true;
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
            <View ref={anchorRef} style={styles.anchor}>
                <HappierPressable
                    testID={testID}
                    accessibilityRole="button"
                    accessibilityLabel={clearable
                        ? [valueLabel, filter.count, filter.clearAccessibilityLabel].filter(Boolean).join(', ')
                        : `${filter.label}: ${valueLabel}`}
                    {...(filter.accessibilityHint === undefined ? {} : { accessibilityHint: filter.accessibilityHint })}
                    expanded={canOpen ? open : undefined}
                    hasPopup={canOpen ? 'dialog' : undefined}
                    disabled={!canOpen && !clearable}
                    onPress={() => (clearable ? filter.onClear?.() : setOpen(!open))}
                    style={(state) => [
                        styles.chip,
                        filter.active ? { borderColor: theme.colors.text.link } : null,
                        state.pressed ? styles.chipPressed : null,
                        { backgroundColor: paintColor(state.pressed ? theme.colors.surface.pressed : theme.colors.surface.base) },
                        focusRingStyle({
                            focused: resolveHappierFocusRingVisible(state.focused),
                            color: theme.colors.border.focus,
                        }),
                    ]}
                >
                    {leading}
                    {filter.showLabel ? <Text style={[styles.label, styles.labelMuted, styles.name]} numberOfLines={1}>{filter.label}</Text> : null}
                    <Text style={[styles.label, filter.muted ? styles.labelMuted : null, filter.active ? { color: theme.colors.text.link } : null]} numberOfLines={1}>{valueLabel}</Text>
                    {filter.count !== undefined ? <Text style={[styles.label, styles.labelMuted, styles.count]}>{filter.count}</Text> : null}
                    {filter.presence ? (
                        <View
                            style={[styles.dot, {
                                backgroundColor: filter.presence === 'online'
                                    ? theme.colors.status.connected
                                    : filter.presence === 'attention'
                                        ? theme.colors.state.warning.foreground
                                        : theme.colors.status.disconnected,
                            }]}
                        />
                    ) : null}
                    {canOpen ? <Icon name={open ? 'caret-up' : 'caret-down'} size={12} color={theme.colors.text.secondary} /> : null}
                    {clearable ? <Icon name="x" size={12} color={theme.colors.text.secondary} /> : null}
                </HappierPressable>
            </View>
            <Popover
                open={open && canOpen}
                anchorRef={anchorRef}
                placement="bottom"
                gap={6}
                maxHeightCap={SELECTION_LIST_LARGE_POPOVER_SIZE.maxHeightCap}
                // A compact chooser: as wide as its rows need, hanging from the chip's right edge.
                portal={{ ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, anchorAlign: 'end', sizeToContent: true }}
                containerStyle={{ paddingHorizontal: 0 }}
                onRequestClose={close}
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
    const chips = props.filters.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />);
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

const stylesheet = StyleSheet.create((theme) => ({
    anchor: {
        maxWidth: 260,
        flexShrink: 1,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 32,
        maxWidth: 260,
        flexShrink: 1,
        paddingHorizontal: 11,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    chipPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    label: {
        ...Typography.default('medium'),
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    labelMuted: {
        color: theme.colors.text.secondary,
    },
    name: {
        flexShrink: 0,
        ...Typography.default(),
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
    inline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    row: {
        flexGrow: 0,
    },
    // Level with the search field's edge (the field sits 8 in from the list).
    rowContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingTop: 2,
        paddingBottom: 8,
    },
}));

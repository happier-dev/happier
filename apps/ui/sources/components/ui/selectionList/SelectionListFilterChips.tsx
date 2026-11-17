import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation, CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HappierFilterChip, HappierPageRowFieldLayoutContext, resolveHappierFocusRingVisible, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useHorizontalScrollEdgeMask } from '@/components/ui/scroll/useHorizontalScrollEdgeMask';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SELECTION_LIST_LARGE_POPOVER_SIZE } from './_constants';
import type { SelectionListFilter, SelectionListOption, SelectionListStep } from './_types';
import { SelectionList } from './SelectionList';
import { SelectionListCommandHost, type SelectionListCommandInvoke } from './SelectionListCommandHost';

/**
 * The filter chip: what a filter is set to, as one compact bordered chip that opens a small popover
 * to change it. The one control for what a page or toolbar shows: a project, machine or catalog scope, a filter, a
 * sort. A form's own value is a field instead (`ValueFieldSelect`).
 */
export const SelectionListFilterChip = React.memo(function SelectionListFilterChip(props: Readonly<{
    filter: SelectionListFilter;
    currentUiContextCommandScope?: string;
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
    const commandScope = props.currentUiContextCommandScope;
    const commandInvokeRef = React.useRef<SelectionListCommandInvoke | null>(null);

    const selected = filter.options?.find((option) => option.id === filter.selectedId) ?? null;
    // A chip always says something: with no value yet it names its own field, never an icon and a chevron alone.
    const valueLabel = filter.valueLabel ?? selected?.label ?? filter.label;
    // A search's scope chip is compact: until it has a value it names the filter, not a placeholder sentence.
    const shownValueLabel = filter.pairsWithSearch && filter.muted ? filter.label
        : props.placement === 'row' ? filter.rowValueLabel ?? valueLabel : valueLabel;
    // A chip that names its own field (nothing chosen yet) is announced once, not "Profile: Profile".
    const announcedValue = [valueLabel, filter.valueQualifier].filter(Boolean).join(' · ');
    const leading = filter.icon ?? selected?.icon ?? null;
    const iconOnly = filter.iconOnly === true && leading !== null;
    const hasChooser = filter.renderPopoverContent !== undefined
        || (filter.options !== undefined && filter.options.length > 0 && filter.onChange !== undefined);
    const canOpen = hasChooser && filter.disabled !== true;
    const phoneSheet = filter.renderPopoverContent !== undefined || filter.selectedIds !== undefined;
    const clearable = !hasChooser && filter.onClear !== undefined && filter.disabled !== true;
    const toggleable = !hasChooser && !clearable && filter.onToggle !== undefined && filter.disabled !== true;
    // A destination, not a filter: one press opens its page.
    const navigates = !hasChooser && !clearable && !toggleable && filter.onPress !== undefined && filter.disabled !== true;
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
    const handleSelect = React.useCallback((id: string, _option: SelectionListOption, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => {
        // Several choices stay open: each row toggles until the viewer is done.
        if (!multiple) setOpen(false);
        if (context || invocation) onChange?.(id, context, invocation);
        else onChange?.(id);
    }, [multiple, onChange, setOpen]);

    const localCommands = React.useMemo<readonly CurrentUiContextLocalCommand[]>(() => {
        if (!commandScope) return [];
        if (clearable) return [{ key: 'clear', title: filter.clearAccessibilityLabel ?? filter.label,
            description: `${commandScope}.clear`, invoke: (_input, context, invocation) => filter.onClear?.(context, invocation) }];
        if (toggleable) return [{ key: 'toggle', title: filter.label,
            description: `${commandScope}.toggle`, invoke: (_input, context, invocation) => filter.onToggle?.(context, invocation) }];
        if (navigates) return [{ key: 'open', title: filter.label,
            description: `${commandScope}.open`, invoke: () => filter.onPress?.() }];
        if (!canOpen) return [];
        return [{ key: open ? 'close' : 'open', title: filter.label,
            description: `${commandScope}.${open ? 'close' : 'open'}`, invoke: () => setOpen(!open) }];
    }, [commandScope, canOpen, clearable, toggleable, navigates, filter.clearAccessibilityLabel, filter.label, filter.onClear, filter.onToggle, filter.onPress, open, setOpen]);
    const closeFromUi = React.useCallback((context?: ActionExecutorContext) => {
        if (commandScope) { void commandInvokeRef.current?.('close', undefined, context); return; }
        close();
    }, [commandScope, close]);
    const pressFromUi = React.useCallback(() => {
        if (commandScope) {
            void commandInvokeRef.current?.(clearable ? 'clear' : toggleable ? 'toggle' : open ? 'close' : 'open');
            return;
        }
        if (clearable) filter.onClear?.();
        else if (toggleable) filter.onToggle?.();
        else if (navigates) filter.onPress?.();
        else setOpen(!open);
    }, [commandScope, clearable, toggleable, navigates, open, filter.onClear, filter.onToggle, filter.onPress, setOpen]);

    return (
        <>
            {commandScope ? <SelectionListCommandHost commands={localCommands} contextKey={commandScope}
                foregroundOverlay={open && canOpen} invokeRef={commandInvokeRef} /> : null}
            {/* The anchor is a plain view: the popover measures it, the pressable owns interaction. */}
            <View ref={anchorRef} style={[styles.anchor, stackedInRow ? styles.anchorStacked : null, iconOnly ? styles.anchorIconOnly : null]}>
                <HappierFilterChip
                    gap={theme.space.s6}
                    testID={testID}
                    accessibilityRole={toggleable ? 'checkbox' : 'button'}
                    {...(toggleable ? { checked: filter.selected === true } : {})}
                    accessibilityLabel={clearable
                        ? [valueLabel, filter.count, filter.clearAccessibilityLabel].filter(Boolean).join(', ')
                        : navigates ? [filter.label, filter.count].filter(Boolean).join(', ')
                        : [announcedValue && announcedValue !== filter.label ? `${filter.label}: ${announcedValue}` : filter.label, filter.note].filter(Boolean).join(', ')}
                    {...(filter.accessibilityHint === undefined ? {} : { accessibilityHint: filter.accessibilityHint })}
                    expanded={canOpen ? open : undefined}
                    hasPopup={canOpen ? filter.renderPopoverContent ? 'dialog' : 'listbox' : undefined}
                    disabled={!canOpen && !clearable && !toggleable && !navigates}
                    // The row of chips scrolls sideways, so its viewport clips: a chip's reach stops at the row's own top padding.
                    hitReach={props.placement === 'row' ? { top: theme.space.s2 } : undefined}
                    onPress={pressFromUi}
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
                    <Text style={[styles.label, filter.muted || (toggleable && !toggledOn) ? styles.labelMuted : null, filter.active ? { color: theme.colors.text.link } : null]} numberOfLines={1}>{shownValueLabel}</Text>
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
                </HappierFilterChip>
            </View>
            <Popover
                open={open && canOpen}
                autoFocusOnOpen
                anchorRef={anchorRef}
                placement="bottom"
                gap={6}
                maxHeightCap={SELECTION_LIST_LARGE_POPOVER_SIZE.maxHeightCap}
                // A compact chooser: as wide as its rows need, opening from the chip's leading edge like
                // every anchored menu. The portal clamps it inside the window, so a chip on the trailing
                // edge still opens in view and a chip beside the navigation never covers it.
                portal={{ ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, sizeToContent: true }}
                containerStyle={{ paddingHorizontal: 0 }}
                onRequestClose={closeFromUi}
                // A chooser that lays out its own content, or keeps several choices open, is the app's bottom
                // sheet on a phone; a plain one-tap list stays the anchored menu beside its chip.
                {...(phoneSheet ? { phonePresentation: 'sheet' as const, accessibilityLabel: filter.label } : {})}
            >
                {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        {filter.renderPopoverContent
                            ? filter.renderPopoverContent({ close: closeFromUi, maxHeight })
                            : optionsStep ? (
                                <SelectionList
                                    currentUiContextCommandScope={commandScope ? `${commandScope}.list` : undefined}
                                    currentUiContextForegroundOverlay
                                    testID={`${testID}.list`}
                                    rootStep={optionsStep}
                                    {...(filter.selectedIds
                                        ? { selection: { kind: 'multiple' as const, selectedIds: filter.selectedIds } }
                                        : { selectedOptionId: filter.selectedId ?? null })}
                                    onSelect={handleSelect}
                                    onRequestClose={closeFromUi}
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
export const SelectionListFilterChips = React.memo(function SelectionListFilterChips(props: Readonly<{
    filters: ReadonlyArray<SelectionListFilter>;
    placement: 'inline' | 'row';
    /**
     * Where a row's first chip stands: level with the search field above it (`field`, the default), or on the
     * page's own edge when the row is a page header's band (`page`).
     */
    edge?: 'field' | 'page';
    testID?: string;
}>): React.ReactElement | null {
    const styles = stylesheet;
    if (props.filters.length === 0) return null;
    const chips = props.filters.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} placement={props.placement} />);
    if (props.placement === 'inline') {
        return <View style={styles.inline}>{chips}</View>;
    }
    return <SelectionListFilterChipRow testID={props.testID} edge={props.edge ?? 'field'}>{chips}</SelectionListFilterChipRow>;
});

/** The row scrolls sideways; a chip cut at an edge that hides more fades out, so it reads as more, not as the end. */
function SelectionListFilterChipRow(props: Readonly<{ children: React.ReactNode; edge: 'field' | 'page'; testID?: string }>) {
    const styles = stylesheet;
    const mask = useHorizontalScrollEdgeMask({ fadePx: CHIP_ROW_FADE_PX, style: styles.row });
    return mask.wrapScroller(
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            testID={props.testID}
            style={mask.scrollerStyle}
            contentContainerStyle={[styles.rowContent, props.edge === 'page' ? styles.rowContentPageEdge : null]}
            onScroll={mask.onScroll}
            onLayout={mask.onViewportLayout}
            onContentSizeChange={mask.onContentSizeChange}
            scrollEventThrottle={16}
        >
            {props.children}
        </ScrollView>,
    );
}

/** The composer chip rail's fade. */
const CHIP_ROW_FADE_PX = 24;

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
    // A header's band stands on the sheets' edge; its first chip stands on the page text's edge, under the title.
    rowContentPageEdge: {
        paddingHorizontal: Math.max(0, HAPPIER_PAGE_METRICS.pageTextInsetPx - resolveItemGroupContentHorizontalInsetPx()),
    },
}));

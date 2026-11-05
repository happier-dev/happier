import * as React from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import {
    SELECTION_LIST_CARD_COLUMN_GAP_PX,
    SelectionList,
    type SelectionListColumnsLayout,
    type SelectionListHeightBehavior,
    type SelectionListOption,
} from '@/components/ui/selectionList';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { OptionPickerPaneRow, OptionPickerPaneRowContent, optionPickerPaneRowStyles } from './OptionPickerPaneRow';
import { OptionPickerPaneSlotsContext } from './optionPickerPaneSlots';
import { useOptionPickerSections } from './optionPickerSections';
import { OptionPickerSelectedControls } from './OptionPickerSelectedControls';
import { OPTION_PICKER_LIST_TEXT_INSET_PX, OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

const CUSTOM_EDITOR_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.modal + 1;

const SELECTED_OPTION_CONTROLS = <OptionPickerSelectedControls />;

/**
 * Glyph square for the favourite star, in list rows and in a card's corner
 * overlay alike. Matches the selection mark it sits beside, so the two read as
 * one piece of corner art; the physical target stays at the platform minimum
 * through the press frame, not through the drawn box.
 */
const OPTION_CARD_GLYPH_BOX_PX = 20;

/**
 * Drawn glyph inside that square — the same size as the selection check above it,
 * so the pair reads as one piece of corner art instead of a mark and a heavier
 * twin. A larger star only crowds the 20px box it shares.
 */
const OPTION_CARD_GLYPH_SIZE_PX = 14;

/** Gap between the trailing indicator glyphs, and so the star's horizontal budget. */
const OPTION_INDICATOR_GAP_PX = 6;

/**
 * The header's catalog-refresh control: an icon and nothing else. The drawn box
 * only sets the hover/press capsule around a glyph the same weight as the
 * header's own text; the real press target comes from the frame.
 */
const HEADER_GLYPH_BOX_PX = 24;
const HEADER_GLYPH_SIZE_PX = 16;

/** Gap inside `titleRowActions`, and so the refresh control's horizontal budget. */
const TITLE_ROW_ACTION_GAP_PX = 4;

/**
 * The two-up card grid of the engine detail pane (0.2's model grid), opted into per caller.
 *
 * The pane's width is MEASURED, not assumed: in the /new engine popover at 1440 the list gets
 * 479px (720px popover, the rail as it actually renders at 215px, the pane insets). The former
 * 240px minimum was derived from an assumed 506px pane and resolved that real pane to one column,
 * which is why 0.3 showed the models as a list.
 *
 * 200px is the narrowest card that still holds a model name and a two-line description; two need
 * `2 * 200 + 4 = 404px`, which the rail-side pane and the rail-less 570px popover both clear, while
 * a phone's stacked pane (~350px) stays one column, as 0.2 did below its 560px phone width. The
 * gutter is the card gutter the grid paints, so the resolver budgets the same gap it draws.
 *
 * Module-level so the identity is stable: the prop feeds a memo that decides the column count.
 */
const ENGINE_PANE_COLUMNS: SelectionListColumnsLayout = {
    max: 2,
    minColumnWidthPx: 200,
    columnGapPx: SELECTION_LIST_CARD_COLUMN_GAP_PX,
};

export type OptionPickerOption<TValue = string> = Readonly<{
    value: TValue;
    label: string;
    /** Quiet text after the label ("· via DeepSeek") that tells apart rows with the same name; searchable. */
    labelSuffix?: string;
    /** Search aliases that need not be displayed, such as a model's exact native id. */
    searchText?: string;
    icon?: React.ReactNode;
    /** Informational content beside the title, through SelectionList's measured title slot. */
    titleAccessory?: React.ReactNode;
    trailingStatusIcon?: React.ReactNode;
    description?: string;
    /** Item's existing text allowance; 0 shows the complete description. */
    descriptionLines?: number;
    /**
     * A richer rendering of `description` (a purpose line over an engine line with its mark).
     * `description` stays the searchable plain text.
     */
    descriptionContent?: React.ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    /** Runs a row-owned recovery/navigation action instead of selecting its value. */
    onActivate?: () => void;
}>;

export type OptionPickerSection<TValue = string> = Readonly<{
    id: string;
    title?: string;
    options: ReadonlyArray<OptionPickerOption<TValue>>;
}>;

export type OptionPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    failed?: boolean;
    refreshErrorMessage?: string;
    onRefresh?: () => void;
    refreshAccessibilityLabel?: string;
    loadingAccessibilityLabel?: string;
    refreshingAccessibilityLabel?: string;
}>;

export type OptionPickerFavoriteOptions<TValue = string> = Readonly<{
    /** Stable value keys, never display labels. */
    values: ReadonlySet<string>;
    isFavoritable?: (option: OptionPickerOption<TValue>) => boolean;
    onToggle: (option: OptionPickerOption<TValue>) => void;
    getAccessibilityLabel?: (option: OptionPickerOption<TValue>, isFavorite: boolean) => string;
}>;

type CustomValueEnabled<TValue> = Readonly<{
    canEnterCustomValue: true;
    onSubmitCustomValue?: (value: string) => void | Promise<void>;
    /**
     * Converts a typed selection into its editable model id. The stable
     * typed value/key remains the selection identity; this string is only
     * presentation input for an unlisted current value.
     */
    getCustomValue?: (value: TValue) => string | null;
}>;

type CustomValueCompatibility<TValue> = TValue extends string
    ? Readonly<{
        canEnterCustomValue: boolean;
        onSubmitCustomValue?: (value: string) => void | Promise<void>;
        getCustomValue?: (value: TValue) => string | null;
      }>
    : Readonly<{ canEnterCustomValue: false; onSubmitCustomValue?: never; getCustomValue?: never }>
        | CustomValueEnabled<TValue>;

export type OptionPickerOverlayProps<TValue = string> = Readonly<{
    title: string;
    /** Before the title (the way back while one source is browsed). */
    titleLeading?: React.ReactNode;
    effectiveLabel?: string;
    notes?: ReadonlyArray<string>;
    summary?: React.ReactNode;
    summaryTestID?: string;
    headerAccessory?: React.ReactNode;
    /** One quiet line below the options (with a grid, inside its reserved status footer), e.g. hidden sources. */
    footerContent?: React.ReactNode;
    options: ReadonlyArray<OptionPickerOption<TValue>>;
    sections?: ReadonlyArray<OptionPickerSection<TValue>>;
    selectedValue: TValue;
    /**
     * Controlled multi-selection for policy/catalog surfaces. The incumbent
     * `selectedValue` remains the single-selection/custom-value owner; callers
     * that supply this list opt into SelectionList's canonical multiple mode.
     */
    selectedValues?: ReadonlyArray<TValue>;
    getValueKey?: (value: TValue) => string;
    /** Says there is nothing to choose (shown only with no options); a search that matches none says "No matches". */
    emptyText: string;
    customLabel?: string;
    customDescription?: string;
    searchPlaceholder?: string;
    optionTestIDPrefix?: string;
    refreshTestID?: string;
    favoriteOptions?: OptionPickerFavoriteOptions<TValue>;
    selectedOptionControls?: ReadonlyArray<SessionConfigOptionControl>;
    onSelectOptionControlValue?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    onSelect: (value: TValue) => void;
    probe?: OptionPickerProbeState;
    fillAvailableSpace?: boolean;
    showTitle?: boolean;
    maxHeight?: number;
    heightBehavior?: SelectionListHeightBehavior;
    autoFocusInputOnWeb?: boolean;
    onRequestClose?: () => void;
    favoriteActionVisibility?: 'selected-or-favorite' | 'all';
    /**
     * Lay the options out as a two-up card grid when the surface is wide enough.
     * Opt-in per caller — a keyboard-first list or an ordered set of branches
     * reads worse as a grid, so this is never a global width rule.
     */
    multiColumn?: boolean;
}> & CustomValueCompatibility<TValue>;

function defaultValueKey<TValue>(value: TValue): string {
    if (typeof value !== 'string') {
        throw new Error('OptionPickerOverlay requires getValueKey for non-string values');
    }
    return value;
}

function OptionTrailingAccessory<TValue>(props: Readonly<{
    option: OptionPickerOption<TValue>;
    valueKey: string;
    selected: boolean;
    /**
     * Whether this accessory draws the current-choice check itself. A single-choice LIST row gets
     * its check from `SelectionList` (one owner for every picker, single or multiple choice), so only
     * card presentation draws it here.
     */
    drawsSelectionMark: boolean;
    favorite: boolean;
    canToggleFavorite: boolean;
    optionTestIDPrefix: string;
    favoriteOptions?: OptionPickerFavoriteOptions<TValue>;
    /**
     * Card presentation. The list lifts this node out of the row's flow into
     * an absolute corner overlay, which is what makes a VERTICAL stack free:
     * in flow the same stack grew every row by ~20px. The glyph square shrinks
     * to corner-art size and keeps its full physical target through hit slop.
     */
    card: boolean;
}>) {
    const { theme } = useUnistyles();
    const actionLabel = props.favorite
        ? t('profiles.actions.removeFromFavorites')
        : t('profiles.actions.addToFavorites');
    const accessibilityLabel = props.favoriteOptions?.getAccessibilityLabel?.(props.option, props.favorite)
        ?? `${props.option.accessibilityLabel ?? props.option.label}, ${actionLabel}`;
    return (
        <View
            testID={props.selected ? `model-picker-overlay-option-selected-indicator:${props.valueKey}` : undefined}
            pointerEvents="box-none"
            style={props.card ? styles.optionCardIndicatorStacked : styles.optionCardIndicator}
        >
            {(props.selected && props.drawsSelectionMark) || props.option.trailingStatusIcon ? (
                <View
                    testID={`model-picker-overlay-option-selection-status:${props.valueKey}`}
                    pointerEvents="none"
                    style={styles.optionSelectionStatus}
                >
                    {props.selected && props.drawsSelectionMark ? (
                        <View style={styles.optionSelectionMark}>
                            <Icon name="check" size={14} color={theme.colors.text.primary} />
                        </View>
                    ) : null}
                    {props.option.trailingStatusIcon ? (
                        <View
                            testID={`${props.optionTestIDPrefix}-status-icon:${props.valueKey}`}
                            style={styles.optionCardStatusIcon}
                        >
                            {normalizeNodeForView(props.option.trailingStatusIcon)}
                        </View>
                    ) : null}
                </View>
            ) : null}
            {props.canToggleFavorite ? (
                <IconButton
                    testID={`${props.optionTestIDPrefix}-favorite:${props.valueKey}`}
                    // Favorite is a STATE, so it is the glyph weight that carries it — a tone
                    // cannot: `default` and `primary` resolve to the same ink in the dark theme,
                    // which left a favorited star indistinguishable from a favoritable one.
                    icon={(
                        <Icon
                            name="star"
                            size={OPTION_CARD_GLYPH_SIZE_PX}
                            weight={props.favorite ? 'fill' : 'regular'}
                            color={props.favorite ? theme.colors.text.primary : theme.colors.text.secondary}
                        />
                    )}
                    accessibilityLabel={accessibilityLabel}
                    tooltip={actionLabel}
                    // One drawn size in both presentations: the list row was carrying a
                    // 44px box only to buy a target that `hitSlop` never delivered on web.
                    // The frame buys it now, so the star can be corner art everywhere.
                    size={OPTION_CARD_GLYPH_BOX_PX}
                    iconSize={OPTION_CARD_GLYPH_SIZE_PX}
                    interactiveTargetGapPx={OPTION_INDICATOR_GAP_PX}
                    variant="plain"
                    onPress={() => props.favoriteOptions?.onToggle(props.option)}
                />
            ) : null}
        </View>
    );
}

export function OptionPickerOverlay<TValue = string>(props: OptionPickerOverlayProps<TValue>) {
    if (props.selectedValues !== undefined && (props.selectedOptionControls?.length ?? 0) > 0) {
        throw new Error('SelectionList multiple selection cannot be combined with expandedContent');
    }
    const { theme } = useUnistyles();
    // Phones recompose: a two-up grid on a phone sheet cuts the descriptions that tell models apart,
    // so the grid is a wide-surface layout only, whatever a phone's measured pane would fit.
    const { width: windowWidth } = useWindowDimensions();
    const multiColumn = props.multiColumn === true && !isMobileLayoutWidth(windowWidth);
    const getValueKey = props.getValueKey ?? defaultValueKey<TValue>;
    const selectedValueKey = getValueKey(props.selectedValue);
    const selectedValueKeys = React.useMemo(
        () => props.selectedValues === undefined
            ? null
            : new Set(props.selectedValues.map((value) => getValueKey(value))),
        [getValueKey, props.selectedValues],
    );
    // A filling picker scrolls as one pane: its title, search, options and status all travel together.
    const wholePaneScrolls = props.fillAvailableSpace === true;
    const paneSlots = React.useContext(OptionPickerPaneSlotsContext);
    const probeFailureMessage = props.probe?.failed
        ? props.probe.refreshErrorMessage ?? t('agentInput.model.unavailable')
        : null;
    // The state line is the failure's one voice in a whole pane: it has the retry a note cannot carry.
    const notes = probeFailureMessage !== null && !wholePaneScrolls
        ? [...(props.notes ?? []), probeFailureMessage]
        : props.notes ?? [];
    const headerNotes = multiColumn ? [] : notes;
    const optionTestIDPrefix = props.optionTestIDPrefix ?? 'model-picker-overlay-option';
    const refreshTestID = props.refreshTestID ?? 'model-picker-overlay-refresh';
    // SelectionList treats root identity changes as scope replacement. Keep
    // non-structural parent rerenders from dispatching a replacement.
    const defaultSections = React.useMemo<ReadonlyArray<OptionPickerSection<TValue>>>(() => [
        { id: 'options', options: props.options },
    ], [props.options]);
    const sourceSections = props.sections ?? defaultSections;
    const totalOptionCount = sourceSections.reduce((sum, section) => sum + section.options.length, 0);
    const optionKeys = React.useMemo(() => new Set(
        sourceSections.flatMap((section) => section.options.map((option) => getValueKey(option.value))),
    ), [getValueKey, sourceSections]);

    const selectedString = (
        props.canEnterCustomValue && props.getCustomValue
            ? props.getCustomValue(props.selectedValue) ?? ''
            : typeof props.selectedValue === 'string'
                ? props.selectedValue
                : ''
    ).trim();
    const selectedCustomValue = props.canEnterCustomValue
        && selectedString.length > 0
        && !optionKeys.has(selectedValueKey)
        ? selectedString
        : '';
    const customValueScopeKey = `${selectedValueKey}\u0000${selectedCustomValue.length > 0 ? 'custom' : 'listed'}`;
    const [customDraft, setCustomDraft] = React.useState<Readonly<{
        scopeKey: string;
        value: string;
    }>>({ scopeKey: customValueScopeKey, value: selectedCustomValue });
    const [customEditorIntent, setCustomEditorIntent] = React.useState<Readonly<{
        scopeKey: string;
        kind: 'manual' | 'dismissed';
    }> | null>(null);
    const customValue = customDraft.scopeKey === customValueScopeKey
        ? customDraft.value
        : selectedCustomValue;
    const customEditorVisible = selectedCustomValue.length > 0
        ? !(customEditorIntent?.scopeKey === customValueScopeKey && customEditorIntent.kind === 'dismissed')
        : customEditorIntent?.scopeKey === customValueScopeKey && customEditorIntent.kind === 'manual';
    const customTriggerRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
    const customInputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const focusCustomInputOnOpenRef = React.useRef(false);
    const returnFocusToCustomTriggerRef = React.useRef(false);
    const lastCommittedCustomValueRef = React.useRef({
        scopeKey: customValueScopeKey,
        value: selectedCustomValue,
    });
    const selectionPressPendingRef = React.useRef(false);
    // A focused TextInput does not emit blur when its enclosing picker unmounts,
    // so cleanup needs the latest local draft and commit callback.
    const pendingCustomCommitRef = React.useRef<{
        visible: boolean;
        value: string;
        commit: (raw: string) => void;
    }>({ visible: false, value: '', commit: () => {} });

    const abandonCustomDraft = React.useCallback(() => {
        selectionPressPendingRef.current = false;
        pendingCustomCommitRef.current = {
            ...pendingCustomCommitRef.current,
            visible: false,
            value: '',
        };
        lastCommittedCustomValueRef.current = { scopeKey: customValueScopeKey, value: '' };
        setCustomDraft({ scopeKey: customValueScopeKey, value: '' });
    }, [customValueScopeKey]);

    React.useEffect(() => {
        if (customEditorVisible && focusCustomInputOnOpenRef.current) {
            focusCustomInputOnOpenRef.current = false;
            customInputRef.current?.focus?.();
            return;
        }
        if (!customEditorVisible && returnFocusToCustomTriggerRef.current) {
            returnFocusToCustomTriggerRef.current = false;
            customTriggerRef.current?.focus?.();
        }
    }, [customEditorVisible]);

    const dismissCustomEditor = React.useCallback(() => {
        returnFocusToCustomTriggerRef.current = true;
        pendingCustomCommitRef.current = {
            ...pendingCustomCommitRef.current,
            visible: false,
            value: '',
        };
        setCustomDraft({ scopeKey: customValueScopeKey, value: selectedCustomValue });
        setCustomEditorIntent(selectedCustomValue.length > 0
            ? { scopeKey: customValueScopeKey, kind: 'dismissed' }
            : null);
    }, [customValueScopeKey, selectedCustomValue]);
    useEscapeLayer({
        enabled: Platform.OS === 'web' && customEditorVisible,
        // The input editor is nested inside popovers and can also appear inside
        // modal surfaces. Its first Escape closes only this editor; the next
        // Escape remains available to the enclosing layer.
        priority: CUSTOM_EDITOR_ESCAPE_PRIORITY,
        allowEditableTarget: true,
        onEscape: () => {
            dismissCustomEditor();
            return true;
        },
    });
    const handleCustomEditorKeyDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        const key = event?.nativeEvent?.key ?? event?.key;
        if (key !== 'Escape') return;
        event?.preventDefault?.();
        dismissCustomEditor();
    }, [dismissCustomEditor]);
    const customEditorWebKeyProps = Platform.OS === 'web'
        ? ({ onKeyDown: handleCustomEditorKeyDown } as Record<string, unknown>)
        : {};

    // The controls configure the SELECTED model, so they live inside that row's card rather
    // than in a detached panel below the list — the same at every width, so narrow surfaces
    // get it without a second layout. Built lazily: `SelectionList` only resolves
    // `expandedContent` for the selected row, so the other rows never construct it.
    const selectedControlsExpandedContent = props.selectedValues === undefined ? SELECTED_OPTION_CONTROLS : undefined;

    const renderOptionVisuals = React.useCallback((option: OptionPickerOption<TValue>, valueKey: string) => {
        const favorite = props.favoriteOptions?.values.has(valueKey) === true;
        const favoritable = Boolean(props.favoriteOptions)
            && (props.favoriteOptions?.isFavoritable?.(option) ?? true);
        const canToggleFavorite = (selected: boolean) => favoritable && (props.favoriteActionVisibility === 'all' || selected || favorite);
        const rightAccessory: SelectionListOption['rightAccessory'] = row => {
            const selected = row?.selected === true;
            const canToggle = canToggleFavorite(selected);
            if (!selected && !option.trailingStatusIcon && !canToggle) return null;
            return <OptionTrailingAccessory option={option} valueKey={valueKey} selected={selected}
                drawsSelectionMark={multiColumn} favorite={favorite} canToggleFavorite={canToggle}
                optionTestIDPrefix={optionTestIDPrefix} favoriteOptions={props.favoriteOptions} card={multiColumn} />;
        };
        const rightAccessoryOutsidePressable: SelectionListOption['rightAccessoryOutsidePressable'] = row => canToggleFavorite(row?.selected === true);
        return {
            icon: option.icon ? (
                <View testID={`${optionTestIDPrefix}-icon:${valueKey}`} style={styles.optionCardIconSlot}>
                    {normalizeNodeForView(option.icon)}
                </View>
            ) : undefined,
            rightAccessory,
            rightAccessoryOutsidePressable,
        };
    }, [
        optionTestIDPrefix,
        props.favoriteActionVisibility,
        props.favoriteOptions,
        multiColumn,
    ]);
    const onOptionPressIn = React.useCallback(() => { selectionPressPendingRef.current = true; }, []);
    const selectionSections = useOptionPickerSections({ sourceSections, getValueKey,
        optionTestIDPrefix, selectedControlsExpandedContent,
        renderVisuals: renderOptionVisuals, onPressIn: onOptionPressIn });
    const optionByKey = React.useMemo(() => new Map(
        sourceSections.flatMap((section) => section.options.map((option) => [getValueKey(option.value), option] as const)),
    ), [getValueKey, sourceSections]);
    const selectionRootStep = React.useMemo(() => ({
        id: 'options',
        inputPlaceholder: totalOptionCount >= 10
            ? (props.searchPlaceholder ?? t('modelPickerOverlay.searchPlaceholder'))
            : undefined,
        // The list only renders with options, so its empty state is a search that matched none: the
        // list's own "No matches", never `emptyText`, which describes an empty catalog (DESIGN-9 N50).
        sections: selectionSections,
    }), [props.searchPlaceholder, selectionSections, totalOptionCount]);

    // Clear synchronously before the callback: the owner may unmount
    // this picker inside onSelect, before passive effects can refresh.
    const settleCustomEditorBeforeSelect = useEventCallback(() => {
        abandonCustomDraft();
        setCustomEditorIntent(selectedCustomValue.length > 0
            ? { scopeKey: customValueScopeKey, kind: 'dismissed' }
            : null);
    });
    const controlsContextValue = React.useMemo(() => ({
        controls: props.selectedOptionControls,
        onSelect: props.onSelectOptionControlValue,
        multiColumn,
    }), [multiColumn, props.onSelectOptionControlValue, props.selectedOptionControls]);

    const probe = props.probe;
    const shouldRenderProbeControl = probe ? typeof probe.onRefresh === 'function' || probe.phase !== 'idle' : false;
    const refreshAccessibilityLabel = probe?.refreshAccessibilityLabel ?? t('modelPickerOverlay.refreshModelsA11y');
    const probeInFlightLabel = probe?.phase === 'loading'
        ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
        : probe?.phase === 'refreshing'
            ? (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))
            : null;
    const refreshControlLabel = probeInFlightLabel ?? refreshAccessibilityLabel;
    const probeHintText = probeInFlightLabel && totalOptionCount <= 1 && !props.canEnterCustomValue
        ? probeInFlightLabel
        : null;

    const commitCustomValue = React.useCallback((raw: string) => {
        const normalized = raw.trim();
        if (!normalized || normalized === selectedCustomValue) return;
        if (lastCommittedCustomValueRef.current.scopeKey === customValueScopeKey
            && lastCommittedCustomValueRef.current.value === normalized) return;
        lastCommittedCustomValueRef.current = { scopeKey: customValueScopeKey, value: normalized };
        props.onSubmitCustomValue?.(normalized);
    }, [customValueScopeKey, props.onSubmitCustomValue, selectedCustomValue]);
    React.useEffect(() => {
        pendingCustomCommitRef.current = {
            visible: customEditorVisible,
            value: customValue,
            commit: commitCustomValue,
        };
    });
    React.useEffect(() => () => {
        const pending = pendingCustomCommitRef.current;
        if (!pending.visible) return;
        pending.commit(pending.value);
    }, []);
    // In a filling pane the title, status and search scroll with the options (0.2's engine pane):
    // no band of the pane is fixed. A content-sized list keeps them pinned above its own scroll.
    const headerNode = (
        props.showTitle !== false
                || props.summary
                || props.effectiveLabel
                || headerNotes.length > 0
                || probeHintText
                || props.headerAccessory
                || shouldRenderProbeControl ? (
            <View testID="model-picker-overlay-title-row" style={[styles.titleRowContainer, multiColumn ? null : styles.listTextEdge]}>
                <View style={styles.titleRow}>
                    {props.showTitle !== false ? (
                        <View style={styles.titleLine}>
                            {props.titleLeading}
                            <Text numberOfLines={1} style={styles.title}>{props.title}</Text>
                        </View>
                    ) : null}
                    {props.summary ? (
                        <View testID={props.summaryTestID ?? 'model-picker-overlay-summary'} style={styles.effectiveBlock}>
                            {typeof props.summary === 'string' ? <Text style={styles.noteText}>{props.summary}</Text> : props.summary}
                            {headerNotes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>)}
                            {probeHintText ? <Text style={styles.noteText}>{probeHintText}</Text> : null}
                        </View>
                    ) : (props.effectiveLabel || headerNotes.length > 0 || probeHintText) ? (
                        <View testID="model-picker-overlay-summary" style={styles.effectiveBlock}>
                            {props.effectiveLabel ? <Text style={styles.noteText}>{t('modelPickerOverlay.effectiveLabel', { label: props.effectiveLabel })}</Text> : null}
                            {headerNotes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>)}
                            {probeHintText ? <Text style={styles.noteText}>{probeHintText}</Text> : null}
                        </View>
                    ) : null}
                </View>
                {props.headerAccessory || shouldRenderProbeControl ? (
                    <View style={styles.titleRowActions}>
                        {props.headerAccessory ? <View style={styles.headerAccessory}>{props.headerAccessory}</View> : null}
                        {shouldRenderProbeControl && probe ? (
                            <IconButton
                                testID={refreshTestID}
                                iconName="arrow-clockwise"
                                accessibilityLabel={refreshControlLabel}
                                tooltip={refreshControlLabel}
                                // Icon only: no border, no fill. The header already
                                // carries the surface this control sits on, so a
                                // second bordered circle only added weight.
                                variant="plain"
                                size={HEADER_GLYPH_BOX_PX}
                                iconSize={HEADER_GLYPH_SIZE_PX}
                                interactiveTargetGapPx={TITLE_ROW_ACTION_GAP_PX}
                                // Press, the loader takes the glyph's place, and it settles back.
                                busy={probe.phase !== 'idle'}
                                onPress={() => probe.onRefresh?.()}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
            ) : null
    );
    const customLabel = props.customLabel ?? t('modelPickerOverlay.customTitle');
    const customNode = (
        props.canEnterCustomValue ? (
                customEditorVisible ? (
                    <View
                        testID="model-picker-overlay-custom"
                        style={[optionPickerPaneRowStyles.row, multiColumn ? null : optionPickerPaneRowStyles.rowInList, optionPickerPaneRowStyles.selected]}
                    >
                        <OptionPickerPaneRowContent
                            title={customLabel}
                            titleSelected
                            description={props.customDescription}
                            trailing={<Icon name="check" size={14} color={theme.colors.text.primary} />}
                        />
                        <View style={styles.customEditor}>
                            <TextInput
                                ref={customInputRef}
                                testID="model-picker-overlay-custom-input"
                                accessibilityLabel={t('modelPickerOverlay.customInputA11y')}
                                value={customValue}
                                onChangeText={(value) => setCustomDraft({ scopeKey: customValueScopeKey, value })}
                                placeholder={t('agentInput.model.customPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCorrect={false}
                                autoCapitalize="none"
                                onSubmitEditing={() => commitCustomValue(customValue)}
                                onBlur={() => {
                                    if (selectionPressPendingRef.current) {
                                        selectionPressPendingRef.current = false;
                                        return;
                                    }
                                    commitCustomValue(customValue);
                                }}
                                {...customEditorWebKeyProps}
                                style={styles.customEditorInput}
                            />
                        </View>
                    </View>
                ) : (
                    <OptionPickerPaneRow
                        ref={customTriggerRef}
                        testID="model-picker-overlay-custom"
                        accessibilityLabel={customLabel}
                        title={customLabel}
                        description={props.customDescription}
                        onPress={() => {
                            selectionPressPendingRef.current = false;
                            focusCustomInputOnOpenRef.current = true;
                            setCustomDraft({ scopeKey: customValueScopeKey, value: selectedCustomValue });
                            setCustomEditorIntent({ scopeKey: customValueScopeKey, kind: 'manual' });
                        }}
                    />
                )
            ) : null
    );
    // A grid shows its status line after the options only while it has something to say. In a content-sized
    // grid it sits below the scroll area, so notices can wrap without moving the cards' starting position.
    const hasFooterStatus = (multiColumn && notes.length > 0) || Boolean(props.footerContent) || probeFailureMessage !== null;
    const noteLines = wholePaneScrolls && (probeFailureMessage !== null || (multiColumn && notes.length > 0)) ? (
        <HappierBodyEdgeContext.Provider value>
            <View style={[styles.paneLines, multiColumn ? null : styles.listTextEdge]}>
                {probeFailureMessage !== null ? (
                    <SurfaceStateCard
                        testID="model-picker-overlay-probe-failure"
                        size="line"
                        kind="error"
                        title={probeFailureMessage}
                        action={probe?.onRefresh ? { label: t('common.retry'), onPress: probe.onRefresh } : undefined}
                    />
                ) : null}
                {multiColumn ? notes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>) : null}
            </View>
        </HappierBodyEdgeContext.Provider>
    ) : null;
    const notesBody = hasFooterStatus ? (
        <>
            {wholePaneScrolls ? noteLines : multiColumn ? notes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>) : null}
            {props.footerContent}
        </>
    ) : null;
    const notesNode = notesBody === null ? null : (
        <View
            testID="model-picker-overlay-notes"
            style={wholePaneScrolls ? styles.notesInPane : styles.notesFooter}
            accessibilityLiveRegion="polite"
        >
            {wholePaneScrolls ? notesBody : <View style={styles.notesFooterBody}>{notesBody}</View>}
        </View>
    );
    // Empty is a settled verdict: while the catalog loads, the header's loading line is the only status,
    // and a failure says itself in its own state line rather than as an empty catalog.
    const emptyStateNode = !props.canEnterCustomValue && probeInFlightLabel === null && probeFailureMessage === null ? (
        <SurfaceStateCard testID="model-picker-overlay-empty" size="line" kind="empty" title={props.emptyText} />
    ) : null;
    const paneLeading = wholePaneScrolls ? paneSlots?.leading : null;
    const paneTrailing = wholePaneScrolls ? paneSlots?.trailing : null;
    const paneHeader = wholePaneScrolls ? <View style={styles.paneHeader}>{paneLeading}{headerNode}</View> : undefined;
    const paneFooter = wholePaneScrolls ? <View style={styles.paneFooter}>{customNode}{paneTrailing}{notesNode}</View> : undefined;

    return (
        <OptionPickerSelectedControlsContext.Provider value={controlsContextValue}>
        <View
            testID="model-picker-overlay"
            style={[styles.section, props.fillAvailableSpace ? styles.sectionFill : null]}
        >
            {totalOptionCount > 0 && !wholePaneScrolls ? headerNode : null}
            {totalOptionCount > 0 ? (
                <SelectionList
                    testID="model-picker-overlay-selection-list"
                    bodyHeader={paneHeader}
                    bodyFooter={wholePaneScrolls
                        ? paneFooter
                        : customNode === null ? null : <View style={styles.bodyFooter}>{customNode}</View>}
                    inputPlacement={wholePaneScrolls ? 'body' : undefined}
                    inputTestID="model-picker-overlay-search"
                    rootStep={selectionRootStep}
                    listAccessibilityLabel={props.title}
                    selectedOptionId={customEditorVisible ? null : selectedValueKey}
                    selection={selectedValueKeys === null
                        ? undefined
                        : { kind: 'multiple', selectedIds: selectedValueKeys }}
                    onSelect={(id) => {
                        const option = optionByKey.get(id);
                        if (!option || option.disabled) return;
                        settleCustomEditorBeforeSelect();
                        if (option.onActivate) {
                            option.onActivate();
                            return;
                        }
                        props.onSelect(option.value);
                    }}
                    onRequestClose={props.onRequestClose ?? (() => {})}
                    keyboardHintsEnabled={false}
                    autoFocusInputOnWeb={props.autoFocusInputOnWeb ?? false}
                    disableTransitions
                    fillAvailableSpace={props.fillAvailableSpace}
                    maxHeight={props.maxHeight}
                    heightBehavior={props.heightBehavior}
                    columns={multiColumn ? ENGINE_PANE_COLUMNS : undefined}
                    // The card and the grid arrive together: a card is what
                    // gives a grid cell an edge, and the grid is the only
                    // layout where a per-option surface reads as a card rather
                    // than as a full-width band.
                    optionPresentation={multiColumn ? 'card' : undefined}
                    // A picker WIRED for inline option controls puts interactive
                    // segmented bars and switches inside the selected row, which
                    // makes the popup a grid rather than a listbox.
                    //
                    // Keyed on the HANDLER, which is how the surface is
                    // configured, and not on `selectedOptionControls`, which is
                    // rebuilt from the current selection: a picker that swapped
                    // pattern each time the user picked a model with a different
                    // control set would re-announce the whole widget mid-use.
                    // A branch picker, which wires neither, keeps the plain
                    // listbox markup it has always emitted.
                    //
                    // WHAT THIS ACTUALLY GUARANTEES, precisely: the pattern is
                    // as static as the caller's handler prop. That is not a
                    // property the resolver can enforce — it is a CONTRACT this
                    // prop places on callers, and one caller has already broken
                    // it (`SessionModelPicker` nulled the handler for provider-
                    // connection selections, which flipped a live single-column
                    // popup; it now passes the handler unconditionally and
                    // suppresses the CONTROL SET instead). So: pass a handler
                    // whose presence is a fact about the surface, never about
                    // the selection, the filter, the plan, or a measurement.
                    // `SessionModelPicker.a11yPattern.test.tsx` probes that with
                    // `multiColumn` off, where nothing else can force the grid.
                    optionsHostInlineControls={props.onSelectOptionControlValue !== undefined}
                />
            ) : wholePaneScrolls ? (
                <ScrollView style={styles.sectionFill} keyboardShouldPersistTaps="handled">
                    {paneHeader}
                    {emptyStateNode}
                    {paneFooter}
                </ScrollView>
            ) : (
                <>
                    {headerNode}
                    {emptyStateNode}
                    {customNode}
                </>
            )}
            {wholePaneScrolls ? null : notesNode}
        </View>
        </OptionPickerSelectedControlsContext.Provider>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: { gap: theme.space.s6 },
    /** The pane's own top and bottom inset travel with its content, so nothing stands fixed at either edge. */
    paneHeader: { gap: theme.space.s6, paddingTop: theme.space.s16, paddingBottom: theme.space.s8 },
    paneFooter: { gap: theme.space.s12, paddingTop: theme.space.s12, paddingBottom: theme.space.s16 },
    /** The "Custom…" entry keeps the pane's gap from the last row when it scrolls with them. */
    bodyFooter: { marginTop: theme.space.s6 },
    sectionFill: {
        flex: 1,
        minHeight: 0,
    },
    /** Title and status start on the cards' text edge; the refresh glyph ends on their trailing one. */
    titleRowContainer: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX },
    /** A list's rows (a phone sheet) keep their text further in than a card's. */
    listTextEdge: { paddingHorizontal: OPTION_PICKER_LIST_TEXT_INSET_PX },
    titleRow: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    titleLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minHeight: HEADER_GLYPH_BOX_PX },
    titleRowActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, gap: TITLE_ROW_ACTION_GAP_PX, marginLeft: theme.space.s8 },
    headerAccessory: { flexShrink: 0 },
    /**
     * The pane's own name ("Model"), in sentence case: it heads the pane beside its favourite and
     * refresh controls, so it reads as a title (primary ink, semibold), not as an eyebrow.
     */
    title: { flex: 1, minWidth: 0, ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary },
    effectiveBlock: { gap: 0 },
    /**
     * The status footer closes the pane the way the search header opens it: a divider, then the line
     * on the header's own text edge. It exists only while there is something to say.
     */
    notesFooter: {
        flexShrink: 0,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s8,
        paddingLeft: theme.space.s6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    notesFooterBody: { minHeight: Typography.variant('meta').lineHeight },
    notesInPane: { gap: theme.space.s10 },
    /** Status lines stand on the cards' text edge. */
    paneLines: { gap: theme.space.s4, paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX },
    noteText: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    optionCardIconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    optionSelectionStatus: { alignItems: 'center', justifyContent: 'flex-start', gap: theme.space.s2 },
    optionSelectionMark: { width: 20, height: 14, alignItems: 'center', justifyContent: 'center' },
    optionCardStatusIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    optionCardIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s6, zIndex: 2, elevation: 2 },
    /**
     * Card presentation: the selection mark sits ABOVE the favourite star.
     * Free vertically because the list hosts this node as an absolute corner
     * overlay rather than in the row's flow.
     */
    optionCardIndicatorStacked: { alignItems: 'flex-end', justifyContent: 'flex-start', gap: theme.space.s6 },
    customEditor: { paddingTop: theme.space.s4 },
    customEditorInput: { minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border.default, paddingHorizontal: theme.space.s10, paddingVertical: theme.space.s6, fontSize: 12, color: theme.colors.text.primary },
}));

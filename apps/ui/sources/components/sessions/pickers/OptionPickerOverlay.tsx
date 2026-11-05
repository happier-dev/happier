import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import {
    SELECTION_LIST_CARD_COLUMN_GAP_PX,
    SelectionList,
    type SelectionListColumnsLayout,
    type SelectionListHeightBehavior,
    type SelectionListOption,
} from '@/components/ui/selectionList';
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
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useOptionPickerSections } from './optionPickerSections';
import { OptionPickerSelectedControls } from './OptionPickerSelectedControls';
import { OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

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
    const notes = props.probe?.failed
        ? [...(props.notes ?? []), t('agentInput.model.unavailable')]
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
    const customEntryHeader = (
        <View style={styles.customEntryHeader}>
            <View style={styles.customEntryTextBlock}>
                <Text style={[styles.optionCardTitle, customEditorVisible ? styles.optionCardTitleSelected : null]}>
                    {props.customLabel ?? t('modelPickerOverlay.customTitle')}
                </Text>
                {props.customDescription ? <Text style={styles.optionCardDescription}>{props.customDescription}</Text> : null}
            </View>
            {customEditorVisible ? <Icon name="check" size={14} color={theme.colors.text.primary} /> : null}
        </View>
    );

    // The title, status and search stay pinned above the one scroll owner that
    // carries the options and custom entry (D13 engine pane): scrolling to the
    // selected card never scrolls away what the pane is or how to search it.
    // Grid status has a reserved footer so arriving notices cannot move the
    // cards' origin; ordinary lists retain their header notices.
    const headerNode = (
        props.showTitle !== false
                || props.summary
                || props.effectiveLabel
                || headerNotes.length > 0
                || probeHintText
                || props.headerAccessory
                || shouldRenderProbeControl ? (
            <View testID="model-picker-overlay-title-row" style={styles.titleRowContainer}>
                <View style={styles.titleRow}>
                    {props.showTitle !== false ? <Text style={styles.title}>{props.title}</Text> : null}
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
                                // While the catalog loads the same glyph stays put, held still:
                                // the user's loading-style spinner (a dot grid) read as a
                                // different control on the phone sheet.
                                disabled={probe.phase !== 'idle'}
                                onPress={() => probe.onRefresh?.()}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
            ) : null
    );
    const customNode = (
        props.canEnterCustomValue ? (
                customEditorVisible ? (
                    <View
                        testID="model-picker-overlay-custom"
                        style={[styles.customEntryRow, styles.customEntrySelected]}
                    >
                        {customEntryHeader}
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
                    <Pressable
                        ref={customTriggerRef}
                        testID="model-picker-overlay-custom"
                        accessibilityRole="button"
                        accessibilityLabel={props.customLabel ?? t('modelPickerOverlay.customTitle')}
                        onPress={() => {
                            selectionPressPendingRef.current = false;
                            focusCustomInputOnOpenRef.current = true;
                            setCustomDraft({ scopeKey: customValueScopeKey, value: selectedCustomValue });
                            setCustomEditorIntent({ scopeKey: customValueScopeKey, kind: 'manual' });
                        }}
                        style={(state) => [
                            styles.customEntryRow,
                            (state as WebHoverablePressableState).hovered === true ? styles.customEntryHovered : null,
                            state.pressed ? styles.customEntryPressed : null,
                        ]}
                    >
                        {customEntryHeader}
                    </Pressable>
                )
            ) : null
    );
    // A grid shows its status line below the scroll area only while it has something to say. Notices can
    // wrap without moving the cards' starting position or clipping the message; with none, the rows
    // fill the pane down to its edge instead of stopping above an empty reserved band.
    const hasFooterStatus = (multiColumn && notes.length > 0) || Boolean(props.footerContent);
    const notesNode = hasFooterStatus ? (
        <View
            testID="model-picker-overlay-notes"
            style={styles.notesFooter}
            accessibilityLiveRegion="polite"
        >
            <View style={styles.notesFooterBody}>
                {multiColumn ? notes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>) : null}
                {props.footerContent}
            </View>
        </View>
    ) : null;

    return (
        <OptionPickerSelectedControlsContext.Provider value={controlsContextValue}>
        <View
            testID="model-picker-overlay"
            style={[styles.section, props.fillAvailableSpace ? styles.sectionFill : null]}
        >
            {totalOptionCount > 0 ? headerNode : null}
            {totalOptionCount > 0 ? (
                <SelectionList
                    testID="model-picker-overlay-selection-list"
                    bodyFooter={customNode === null ? null : <View style={styles.bodyFooter}>{customNode}</View>}
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
                        // Clear synchronously before the callback: the owner may unmount
                        // this picker inside onSelect, before passive effects can refresh.
                        abandonCustomDraft();
                        setCustomEditorIntent(selectedCustomValue.length > 0
                            ? { scopeKey: customValueScopeKey, kind: 'dismissed' }
                            : null);
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
            ) : (
                <>
                    {headerNode}
                    {!props.canEnterCustomValue ? <Text style={styles.emptyText}>{props.emptyText}</Text> : null}
                    {customNode}
                </>
            )}
            {notesNode}
        </View>
        </OptionPickerSelectedControlsContext.Provider>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: { gap: theme.space.s6 },
    /** The "Custom…" entry keeps the pane's gap from the last row when it scrolls with them. */
    bodyFooter: { marginTop: theme.space.s6 },
    sectionFill: {
        flex: 1,
        minHeight: 0,
    },
    titleRowContainer: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: theme.space.s6 },
    titleRow: { flex: 1, minWidth: 0 },
    titleRowActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, gap: TITLE_ROW_ACTION_GAP_PX, marginLeft: theme.space.s8 },
    headerAccessory: { flexShrink: 0 },
    /**
     * The pane's own name ("Model"), in sentence case: it heads the pane beside its favourite and
     * refresh controls, so it reads as a title (primary ink, semibold), not as an eyebrow.
     */
    title: { flex: 1, ...Typography.variant('body', 'semiBold'),   color: theme.colors.text.primary },
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
    noteText: { fontSize: 11, color: theme.colors.text.tertiary },
    optionCardIconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    optionSelectionStatus: { alignItems: 'center', justifyContent: 'flex-start', gap: theme.space.s2 },
    optionSelectionMark: { width: 20, height: 14, alignItems: 'center', justifyContent: 'center' },
    optionCardStatusIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    optionCardTitle: { fontSize: 14, color: theme.colors.text.primary },
    optionCardTitleSelected: { ...Typography.default('semiBold') },
    optionCardDescription: { fontSize: 12, color: theme.colors.text.secondary },
    optionCardIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s6, zIndex: 2, elevation: 2 },
    /**
     * Card presentation: the selection mark sits ABOVE the favourite star.
     * Free vertically because the list hosts this node as an absolute corner
     * overlay rather than in the row's flow.
     */
    optionCardIndicatorStacked: { alignItems: 'flex-end', justifyContent: 'flex-start', gap: theme.space.s6 },
    customEntryRow: { borderRadius: 12, paddingHorizontal: theme.space.s6, paddingVertical: theme.space.s6, backgroundColor: theme.colors.surface.base },
    customEntrySelected: { backgroundColor: theme.colors.surface.selected },
    customEntryHovered: { backgroundColor: theme.colors.surface.pressed },
    customEntryPressed: { opacity: motionTokens.press.opacitySubtle },
    customEntryHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space.s12 },
    customEntryTextBlock: { flex: 1, minWidth: 0 },
    customEditor: { paddingTop: theme.space.s4 },
    customEditorInput: { minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border.default, paddingHorizontal: theme.space.s10, paddingVertical: theme.space.s6, fontSize: 12, color: theme.colors.text.primary },
    emptyText: { fontSize: 11, color: theme.colors.text.secondary, paddingHorizontal: theme.space.s6, paddingVertical: theme.space.s8 },
}));

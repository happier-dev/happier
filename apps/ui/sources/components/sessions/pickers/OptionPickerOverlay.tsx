import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    SelectionList,
    type SelectionListColumnsLayout,
    type SelectionListHeightBehavior,
    type SelectionListOption,
    type SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import {
    isBooleanConfigOptionType,
    resolveBooleanConfigOptionNextValue,
    resolveBooleanConfigOptionValue,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

const CUSTOM_EDITOR_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.modal + 1;

/**
 * No config option value normalizes to the empty string, so this highlights nothing — used when
 * an override forces a value this option has no segment for.
 */
const NO_SEGMENT_HIGHLIGHTED = '';

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
 * The two-up grid used by the engine detail panes, opted into per caller.
 *
 * The minimum is deliberately far below the shared list-column default (320px,
 * tuned for FULL-WIDTH settings lists and needing 652px for two columns). This
 * picker never sees anything close: its widest home is the engine popover's
 * detail pane, which is the 720px popover cap minus the 190px agent rail minus
 * the pane's 12px horizontal insets — 506px — or 550px when the rail is hidden
 * and the popover caps at 570px instead. At the shared gutter of 12px, two
 * columns need `2 * min + 12`, so anything above 247 collapses the pane beside
 * the rail back to one column forever. 240 clears both widths (492 <= 506) with
 * enough headroom for popover chrome and a web scrollbar.
 *
 * Module-level so the identity is stable: the prop feeds a memo that decides
 * the column count from the measured width.
 */
const ENGINE_PANE_COLUMNS: SelectionListColumnsLayout = { max: 2, minColumnWidthPx: 240 };

export type OptionPickerOption<TValue = string> = Readonly<{
    value: TValue;
    label: string;
    icon?: React.ReactNode;
    trailingStatusIcon?: React.ReactNode;
    description?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
}>;

export type OptionPickerSection<TValue = string> = Readonly<{
    id: string;
    title?: string;
    options: ReadonlyArray<OptionPickerOption<TValue>>;
}>;

export type OptionPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
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
    options: ReadonlyArray<OptionPickerOption<TValue>>;
    sections?: ReadonlyArray<OptionPickerSection<TValue>>;
    selectedValue: TValue;
    getValueKey?: (value: TValue) => string;
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

function SelectedOptionControls(props: Readonly<{
    controls: ReadonlyArray<SessionConfigOptionControl>;
    onSelect?: (configId: string, valueId: SessionConfigOptionValueId) => void;
}>) {
    if (props.controls.length === 0) return null;
    return (
        <View style={styles.inlineSelectedControls}>
            {props.controls.map((control) => {
                const option = control.option;
                const controlAccessibilityLabel = t('modelPickerOverlay.optionControlA11y', {
                    name: option.name,
                });
                const overriddenBy = control.disabled === true ? control.disabledByOptionName : undefined;
                // The override note REPLACES the description: it is the operative fact about the
                // control right now, and stacking both in a 9pt block just buries it.
                const secondaryText = overriddenBy
                    ? t('agentInput.acp.optionOverriddenBy', { name: overriddenBy })
                    : option.description;
                const secondaryTestID = overriddenBy
                    ? `model-picker-overlay-selected-option-control-overridden:${option.id}`
                    : undefined;
                const secondary = secondaryText ? (
                    <Text testID={secondaryTestID} style={styles.selectedControlDescription}>{secondaryText}</Text>
                ) : null;

                if (isBooleanConfigOptionType(option.type)) {
                    const boolValue = resolveBooleanConfigOptionValue(
                        option,
                        String(control.effectiveValue) as SessionConfigOptionValueId,
                    );
                    return (
                        <View
                            key={option.id}
                            testID={`model-picker-overlay-selected-option-control:${option.id}`}
                            style={styles.selectedControlRow}
                        >
                            <View style={styles.selectedControlTextBlock}>
                                <Text style={styles.selectedControlTitle}>{option.name}</Text>
                                {secondary}
                            </View>
                            <Switch
                                testID={`model-picker-overlay-selected-option-control-switch:${option.id}`}
                                accessibilityLabel={controlAccessibilityLabel}
                                value={boolValue}
                                disabled={control.disabled === true}
                                onValueChange={(next) => {
                                    if (control.disabled === true) return;
                                    props.onSelect?.(
                                        option.id,
                                        resolveBooleanConfigOptionNextValue(option, next),
                                    );
                                }}
                                compact
                            />
                        </View>
                    );
                }

                // While overridden, show what the agent is ACTUALLY running — not the stored
                // value, which is the lie. When the forced value is not one of this option's
                // choices the control dims with nothing highlighted rather than pointing at a
                // segment that does not exist.
                const highlightedValue = control.disabled === true
                    ? control.overriddenEffectiveValue ?? NO_SEGMENT_HIGHLIGHTED
                    : control.effectiveValue;
                return (
                    <View
                        key={option.id}
                        testID={`model-picker-overlay-selected-option-control:${option.id}`}
                        style={styles.selectedControlGroup}
                    >
                        <Text style={styles.selectedControlTitle}>{option.name}</Text>
                        {secondary}
                        <SegmentedTabBar
                            tabs={(option.options ?? []).map((choice) => ({ id: choice.value, label: choice.name }))}
                            activeTabId={highlightedValue}
                            disabled={control.disabled === true}
                            onSelectTab={(tabId) => {
                                if (control.disabled === true) return;
                                props.onSelect?.(option.id, tabId as SessionConfigOptionValueId);
                            }}
                            testIDPrefix={`model-picker-overlay-selected-option-control-option:${option.id}`}
                            accessibilityLabel={controlAccessibilityLabel}
                            compact
                            activeLabelStyle={Typography.default('semiBold')}
                        />
                    </View>
                );
            })}
        </View>
    );
}

function OptionTrailingAccessory<TValue>(props: Readonly<{
    option: OptionPickerOption<TValue>;
    valueKey: string;
    selected: boolean;
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
            {props.selected || props.option.trailingStatusIcon ? (
                <View
                    testID={`model-picker-overlay-option-selection-status:${props.valueKey}`}
                    pointerEvents="none"
                    style={styles.optionSelectionStatus}
                >
                    {props.selected ? (
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
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    interactiveTargetGapPx={OPTION_INDICATOR_GAP_PX}
                    variant="plain"
                    onPress={() => props.favoriteOptions?.onToggle(props.option)}
                />
            ) : null}
        </View>
    );
}

export function OptionPickerOverlay<TValue = string>(props: OptionPickerOverlayProps<TValue>) {
    const { theme } = useUnistyles();
    const getValueKey = props.getValueKey ?? defaultValueKey<TValue>;
    const selectedValueKey = getValueKey(props.selectedValue);
    const notes = props.notes ?? [];
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
    const [customValue, setCustomValue] = React.useState(selectedCustomValue);
    const [customEditorVisible, setCustomEditorVisible] = React.useState(selectedCustomValue.length > 0);
    const customTriggerRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
    const customInputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const focusCustomInputOnOpenRef = React.useRef(false);
    const returnFocusToCustomTriggerRef = React.useRef(false);
    const customEditorOpenReasonRef = React.useRef<'selected-custom' | 'manual' | null>(
        selectedCustomValue.length > 0 ? 'selected-custom' : null,
    );
    const dismissedSelectedCustomValueKeyRef = React.useRef<string | null>(null);
    const lastCommittedCustomValueRef = React.useRef(selectedCustomValue);
    const previousSelectedValueKeyRef = React.useRef(selectedValueKey);
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
        lastCommittedCustomValueRef.current = '';
        setCustomValue('');
    }, []);

    React.useEffect(() => {
        const previousSelectedValueKey = previousSelectedValueKeyRef.current;
        previousSelectedValueKeyRef.current = selectedValueKey;
        if (selectedCustomValue.length > 0) {
            setCustomValue(selectedCustomValue);
            if (dismissedSelectedCustomValueKeyRef.current === selectedValueKey) {
                customEditorOpenReasonRef.current = null;
                lastCommittedCustomValueRef.current = selectedCustomValue;
                return;
            }
            dismissedSelectedCustomValueKeyRef.current = null;
            setCustomEditorVisible(true);
            customEditorOpenReasonRef.current = 'selected-custom';
            lastCommittedCustomValueRef.current = selectedCustomValue;
            return;
        }
        if (!optionKeys.has(selectedValueKey)) return;
        dismissedSelectedCustomValueKeyRef.current = null;
        if (customEditorOpenReasonRef.current === 'selected-custom') {
            customEditorOpenReasonRef.current = null;
            setCustomEditorVisible(false);
            abandonCustomDraft();
            return;
        }
        if (customEditorVisible && previousSelectedValueKey === selectedValueKey) return;
        customEditorOpenReasonRef.current = null;
        setCustomEditorVisible(false);
        abandonCustomDraft();
    }, [abandonCustomDraft, customEditorVisible, optionKeys, selectedCustomValue, selectedValueKey]);

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
        customEditorOpenReasonRef.current = null;
        dismissedSelectedCustomValueKeyRef.current = selectedCustomValue.length > 0
            ? selectedValueKey
            : null;
        returnFocusToCustomTriggerRef.current = true;
        setCustomEditorVisible(false);
    }, [selectedCustomValue, selectedValueKey]);
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
    const selectedControlsExpandedContent = React.useMemo(() => {
        const controls = props.selectedOptionControls ?? [];
        if (controls.length === 0) return undefined;
        return () => (
            <View
                testID="model-picker-overlay-selected-controls"
                style={[
                    styles.selectedControlsPanel,
                    // In card mode the card is the single owner of the selected
                    // fill and clips this panel to its own corners, so the panel
                    // contributes padding only. Continuing the fill here as well
                    // would be a second decision-maker for one surface.
                    props.multiColumn ? null : styles.selectedControlsPanelFill,
                ]}
            >
                <SelectedOptionControls
                    controls={controls}
                    onSelect={props.onSelectOptionControlValue}
                />
            </View>
        );
    }, [props.multiColumn, props.onSelectOptionControlValue, props.selectedOptionControls]);

    const selectionSections = React.useMemo<ReadonlyArray<SelectionListSectionDescriptor>>(() => {
        const seen = new Set<string>();
        return sourceSections.map((section) => ({
            kind: 'static' as const,
            id: section.id,
            title: section.title,
            virtualization: 'auto' as const,
            options: section.options.flatMap((option): SelectionListOption[] => {
                const valueKey = getValueKey(option.value);
                if (seen.has(valueKey)) return [];
                seen.add(valueKey);
                const selected = valueKey === selectedValueKey;
                const favorite = props.favoriteOptions?.values.has(valueKey) === true;
                const canToggleFavorite = (
                    props.favoriteActionVisibility === 'all'
                    || selected
                    || favorite
                )
                    && Boolean(props.favoriteOptions)
                    && (props.favoriteOptions?.isFavoritable?.(option) ?? true);
                return [{
                    id: valueKey,
                    testID: `${optionTestIDPrefix}:${valueKey}`,
                    label: option.label,
                    onPressIn: () => {
                        selectionPressPendingRef.current = true;
                    },
                    subtitle: option.description,
                    accessibilityLabel: option.accessibilityLabel,
                    disabled: option.disabled,
                    icon: option.icon ? (
                        <View
                            testID={`${optionTestIDPrefix}-icon:${valueKey}`}
                            style={styles.optionCardIconSlot}
                        >
                            {normalizeNodeForView(option.icon)}
                        </View>
                    ) : undefined,
                    rightAccessory: selected || option.trailingStatusIcon || canToggleFavorite ? (
                        <OptionTrailingAccessory
                            option={option}
                            valueKey={valueKey}
                            selected={selected}
                            favorite={favorite}
                            canToggleFavorite={canToggleFavorite}
                            optionTestIDPrefix={optionTestIDPrefix}
                            favoriteOptions={props.favoriteOptions}
                            card={props.multiColumn === true}
                        />
                    ) : undefined,
                    rightAccessoryOutsidePressable: canToggleFavorite,
                    expandedContent: selected ? selectedControlsExpandedContent : undefined,
                }];
            }),
        }));
    }, [
        getValueKey,
        optionTestIDPrefix,
        props.favoriteActionVisibility,
        props.favoriteOptions,
        props.multiColumn,
        selectedControlsExpandedContent,
        selectedValueKey,
        sourceSections,
    ]);
    const optionByKey = React.useMemo(() => new Map(
        sourceSections.flatMap((section) => section.options.map((option) => [getValueKey(option.value), option] as const)),
    ), [getValueKey, sourceSections]);
    const selectionRootStep = React.useMemo(() => ({
        id: 'options',
        inputPlaceholder: totalOptionCount >= 10
            ? (props.searchPlaceholder ?? t('modelPickerOverlay.searchPlaceholder'))
            : undefined,
        emptyStateLabel: props.emptyText,
        sections: selectionSections,
    }), [props.emptyText, props.searchPlaceholder, selectionSections, totalOptionCount]);

    const probe = props.probe;
    const shouldRenderProbeControl = probe ? typeof probe.onRefresh === 'function' || probe.phase !== 'idle' : false;
    const refreshAccessibilityLabel = probe?.refreshAccessibilityLabel ?? t('modelPickerOverlay.refreshModelsA11y');
    const probeHintText = probe && probe.phase !== 'idle' && totalOptionCount <= 1 && !props.canEnterCustomValue
        ? (probe.phase === 'loading'
            ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
            : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y')))
        : null;

    const commitCustomValue = React.useCallback((raw: string) => {
        const normalized = raw.trim();
        if (!normalized || lastCommittedCustomValueRef.current === normalized) return;
        lastCommittedCustomValueRef.current = normalized;
        props.onSubmitCustomValue?.(normalized);
    }, [props.onSubmitCustomValue]);
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

    return (
        <View
            testID="model-picker-overlay"
            style={[styles.section, props.fillAvailableSpace ? styles.sectionFill : null]}
        >
            {props.showTitle !== false
                || props.summary
                || props.effectiveLabel
                || notes.length > 0
                || probeHintText
                || props.headerAccessory
                || shouldRenderProbeControl ? (
            <View style={styles.titleRowContainer}>
                <View style={styles.titleRow}>
                    {props.showTitle !== false ? <Text style={styles.title}>{props.title}</Text> : null}
                    {props.summary ? (
                        <View testID={props.summaryTestID ?? 'model-picker-overlay-summary'} style={styles.effectiveBlock}>
                            {typeof props.summary === 'string' ? <Text style={styles.noteText}>{props.summary}</Text> : props.summary}
                            {notes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>)}
                            {probeHintText ? <Text style={styles.noteText}>{probeHintText}</Text> : null}
                        </View>
                    ) : (props.effectiveLabel || notes.length > 0 || probeHintText) ? (
                        <View testID="model-picker-overlay-summary" style={styles.effectiveBlock}>
                            {props.effectiveLabel ? <Text style={styles.noteText}>{t('modelPickerOverlay.effectiveLabel', { label: props.effectiveLabel })}</Text> : null}
                            {notes.map((note, index) => <Text key={`${index}:${note}`} style={styles.noteText}>{note}</Text>)}
                            {probeHintText ? <Text style={styles.noteText}>{probeHintText}</Text> : null}
                        </View>
                    ) : null}
                </View>
                {props.headerAccessory || shouldRenderProbeControl ? (
                    <View style={styles.titleRowActions}>
                        {props.headerAccessory ? <View style={styles.headerAccessory}>{props.headerAccessory}</View> : null}
                        {shouldRenderProbeControl && probe ? (
                            probe.phase === 'idle' && typeof probe.onRefresh === 'function' ? (
                                <IconButton
                                    testID={refreshTestID}
                                    iconName="arrow-clockwise"
                                    accessibilityLabel={refreshAccessibilityLabel}
                                    tooltip={refreshAccessibilityLabel}
                                    // Icon only: no border, no fill. The header already
                                    // carries the surface this control sits on, so a
                                    // second bordered circle only added weight.
                                    variant="plain"
                                    size={HEADER_GLYPH_BOX_PX}
                                    iconSize={HEADER_GLYPH_SIZE_PX}
                                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                                    interactiveTargetGapPx={TITLE_ROW_ACTION_GAP_PX}
                                    onPress={probe.onRefresh}
                                />
                            ) : probe.phase !== 'idle' ? (
                                <View testID={`${refreshTestID}-progress`} style={styles.refreshProgressSlot}>
                                    <ActivitySpinner
                                        // Without a border to sit in, the spinner reads as
                                        // legible only if it matches the glyph it replaces:
                                        // same box, same ink, same optical weight.
                                        size={iconMatchedSpinnerSize(HEADER_GLYPH_SIZE_PX)}
                                        color={theme.colors.text.secondary}
                                        accessibilityLabel={probe.phase === 'loading'
                                            ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                            : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))}
                                    />
                                </View>
                            ) : null
                        ) : null}
                    </View>
                ) : null}
            </View>
            ) : null}

            {totalOptionCount > 0 ? (
                <SelectionList
                    testID="model-picker-overlay-selection-list"
                    inputTestID="model-picker-overlay-search"
                    rootStep={selectionRootStep}
                    listAccessibilityLabel={props.title}
                    selectedOptionId={customEditorVisible ? null : selectedValueKey}
                    onSelect={(id) => {
                        const option = optionByKey.get(id);
                        if (!option || option.disabled) return;
                        customEditorOpenReasonRef.current = null;
                        dismissedSelectedCustomValueKeyRef.current = null;
                        // Clear synchronously before the callback: the owner may unmount
                        // this picker inside onSelect, before passive effects can refresh.
                        abandonCustomDraft();
                        setCustomEditorVisible(false);
                        props.onSelect(option.value);
                    }}
                    onRequestClose={props.onRequestClose ?? (() => {})}
                    keyboardHintsEnabled={false}
                    autoFocusInputOnWeb={props.autoFocusInputOnWeb ?? false}
                    disableTransitions
                    fillAvailableSpace={props.fillAvailableSpace}
                    maxHeight={props.maxHeight}
                    heightBehavior={props.heightBehavior}
                    columns={props.multiColumn ? ENGINE_PANE_COLUMNS : undefined}
                    // The card and the grid arrive together: a card is what
                    // gives a grid cell an edge, and the grid is the only
                    // layout where a per-option surface reads as a card rather
                    // than as a full-width band.
                    optionPresentation={props.multiColumn ? 'card' : undefined}
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
            ) : !props.canEnterCustomValue ? (
                <Text style={styles.emptyText}>{props.emptyText}</Text>
            ) : null}

            {props.canEnterCustomValue ? (
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
                                onChangeText={setCustomValue}
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
                            dismissedSelectedCustomValueKeyRef.current = null;
                            customEditorOpenReasonRef.current = selectedCustomValue.length > 0 ? 'selected-custom' : 'manual';
                            focusCustomInputOnOpenRef.current = true;
                            setCustomEditorVisible(true);
                            if (selectedCustomValue.length > 0) setCustomValue(selectedCustomValue);
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
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: { gap: 6 },
    sectionFill: {
        flex: 1,
        minHeight: 0,
    },
    titleRowContainer: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 7 },
    titleRow: { flex: 1, minWidth: 0 },
    titleRowActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, gap: TITLE_ROW_ACTION_GAP_PX, marginLeft: 8 },
    headerAccessory: { flexShrink: 0 },
    title: { flex: 1, fontSize: 12, color: theme.colors.text.secondary, textTransform: 'uppercase' },
    effectiveBlock: { gap: 0 },
    noteText: { fontSize: 11, color: theme.colors.text.tertiary },
    /**
     * The loading twin of the refresh control's drawn box. Same square, so the
     * header never reflows between idle and in-flight; no chrome, because the
     * control it replaces has none either.
     */
    refreshProgressSlot: { width: HEADER_GLYPH_BOX_PX, height: HEADER_GLYPH_BOX_PX, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    optionCardIconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    optionSelectionStatus: { alignItems: 'center', justifyContent: 'flex-start', gap: 2 },
    optionSelectionMark: { width: 20, height: 14, alignItems: 'center', justifyContent: 'center' },
    optionCardStatusIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    optionCardTitle: { fontSize: 14, color: theme.colors.text.primary },
    optionCardTitleSelected: { ...Typography.default('semiBold') },
    optionCardDescription: { fontSize: 12, color: theme.colors.text.secondary },
    optionCardIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, zIndex: 2, elevation: 2 },
    /**
     * Card presentation: the selection mark sits ABOVE the favourite star.
     * Free vertically because the list hosts this node as an absolute corner
     * overlay rather than in the row's flow.
     */
    optionCardIndicatorStacked: { alignItems: 'flex-end', justifyContent: 'flex-start', gap: 6 },
    /**
     * Continues the selected row's fill downward so the row and its controls read as one
     * card. `Item` keeps its per-density horizontal inset private; the three selectable
     * densities span 12–16px, so this matches the shipped default (`cozy`, 14) and is at
     * worst 2px off the row text. No top padding — the row's own bottom inset is the gap.
     */
    selectedControlsPanel: { paddingHorizontal: 14, paddingBottom: 10 },
    selectedControlsPanelFill: { backgroundColor: theme.colors.surface.selected },
    inlineSelectedControls: { gap: 10 },
    selectedControlGroup: { gap: 3 },
    selectedControlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    selectedControlTextBlock: { flex: 1, gap: 1 },
    selectedControlTitle: { fontSize: 9, ...Typography.default('semiBold'), textTransform: 'uppercase', color: theme.colors.text.secondary },
    selectedControlDescription: { fontSize: 9, color: theme.colors.text.secondary },
    customEntryRow: { borderRadius: 12, paddingHorizontal: 7, paddingVertical: 7, backgroundColor: theme.colors.surface.base, minHeight: 44 },
    customEntrySelected: { backgroundColor: theme.colors.surface.selected },
    customEntryHovered: { backgroundColor: theme.colors.surface.pressed },
    customEntryPressed: { opacity: 0.86 },
    customEntryHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
    customEntryTextBlock: { flex: 1, minWidth: 0 },
    customEditor: { paddingTop: 4 },
    customEditorInput: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border.default, paddingHorizontal: 10, paddingVertical: 7, fontSize: 12, color: theme.colors.text.primary },
    emptyText: { fontSize: 11, color: theme.colors.text.secondary, paddingHorizontal: 7, paddingVertical: 8 },
}));

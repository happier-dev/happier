import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import {
    SelectionList,
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

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

const CUSTOM_EDITOR_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.modal + 1;

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
                                {option.description ? <Text style={styles.selectedControlDescription}>{option.description}</Text> : null}
                            </View>
                            <Switch
                                testID={`model-picker-overlay-selected-option-control-switch:${option.id}`}
                                accessibilityLabel={controlAccessibilityLabel}
                                value={boolValue}
                                onValueChange={(next) => props.onSelect?.(
                                    option.id,
                                    resolveBooleanConfigOptionNextValue(option, next),
                                )}
                                compact
                            />
                        </View>
                    );
                }

                return (
                    <View
                        key={option.id}
                        testID={`model-picker-overlay-selected-option-control:${option.id}`}
                        style={styles.selectedControlGroup}
                    >
                        <Text style={styles.selectedControlTitle}>{option.name}</Text>
                        {option.description ? <Text style={styles.selectedControlDescription}>{option.description}</Text> : null}
                        <SegmentedTabBar
                            tabs={(option.options ?? []).map((choice) => ({ id: choice.value, label: choice.name }))}
                            activeTabId={control.effectiveValue}
                            onSelectTab={(tabId) => props.onSelect?.(option.id, tabId as SessionConfigOptionValueId)}
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
            style={styles.optionCardIndicator}
        >
            {props.selected || props.option.trailingStatusIcon ? (
                <View
                    testID={`model-picker-overlay-option-selection-status:${props.valueKey}`}
                    pointerEvents="none"
                    style={styles.optionSelectionStatus}
                >
                    {props.selected ? (
                        <View style={styles.optionSelectionMark}>
                            <Ionicons name="checkmark-outline" size={14} color={theme.colors.text.primary} />
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
                    iconName={props.favorite ? 'star' : 'star-outline'}
                    accessibilityLabel={accessibilityLabel}
                    tooltip={actionLabel}
                    size={44}
                    iconSize={18}
                    tone={props.favorite ? 'primary' : 'default'}
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
                        />
                    ) : undefined,
                    rightAccessoryOutsidePressable: canToggleFavorite,
                }];
            }),
        }));
    }, [
        getValueKey,
        optionTestIDPrefix,
        props.favoriteActionVisibility,
        props.favoriteOptions,
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
            {customEditorVisible ? <Ionicons name="checkmark-outline" size={14} color={theme.colors.text.primary} /> : null}
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
                                    iconName="refresh-outline"
                                    accessibilityLabel={refreshAccessibilityLabel}
                                    tooltip={refreshAccessibilityLabel}
                                    size={44}
                                    iconSize={18}
                                    onPress={probe.onRefresh}
                                />
                            ) : probe.phase !== 'idle' ? (
                                <View style={styles.refreshIconButton}>
                                    <ActivitySpinner
                                        size="small"
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
                />
            ) : !props.canEnterCustomValue ? (
                <Text style={styles.emptyText}>{props.emptyText}</Text>
            ) : null}

            {!customEditorVisible
                && optionKeys.has(selectedValueKey)
                && (props.selectedOptionControls?.length ?? 0) > 0 ? (
                    <View testID="model-picker-overlay-selected-controls" style={styles.selectedControlsPanel}>
                        <SelectedOptionControls
                            controls={props.selectedOptionControls ?? []}
                            onSelect={props.onSelectOptionControlValue}
                        />
                    </View>
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
    titleRowActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, gap: 4, marginLeft: 8 },
    headerAccessory: { flexShrink: 0 },
    title: { flex: 1, fontSize: 12, color: theme.colors.text.secondary, textTransform: 'uppercase' },
    effectiveBlock: { gap: 0 },
    noteText: { fontSize: 11, color: theme.colors.text.tertiary },
    refreshIconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border.default },
    optionCardIconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    optionSelectionStatus: { alignItems: 'center', justifyContent: 'flex-start', gap: 2 },
    optionSelectionMark: { width: 20, height: 14, alignItems: 'center', justifyContent: 'center' },
    optionCardStatusIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    optionCardTitle: { fontSize: 14, color: theme.colors.text.primary },
    optionCardTitleSelected: { ...Typography.default('semiBold') },
    optionCardDescription: { fontSize: 12, color: theme.colors.text.secondary },
    optionCardIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, zIndex: 2, elevation: 2 },
    selectedControlsPanel: { borderRadius: 12, paddingHorizontal: 7, paddingVertical: 7, backgroundColor: theme.colors.surface.selected },
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

import React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import type {
    SessionConfigOptionControl,
    SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';
import {
    resolveBooleanConfigOptionNextValue,
    resolveBooleanConfigOptionValue,
    shouldRenderConfigOptionAsBooleanSwitch,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

export type OptionPickerOption = Readonly<{
    value: string;
    label: string;
    icon?: React.ReactNode;
    trailingStatusIcon?: React.ReactNode;
    accessibilityLabel?: string;
    description?: string;
}>;

export type OptionPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
    refreshAccessibilityLabel?: string;
    loadingAccessibilityLabel?: string;
    refreshingAccessibilityLabel?: string;
}>;

export type OptionPickerFavoriteOptions = Readonly<{
    values: ReadonlySet<string>;
    isFavoritable?: (option: OptionPickerOption) => boolean;
    onToggle: (option: OptionPickerOption) => void;
    getAccessibilityLabel?: (option: OptionPickerOption, isFavorite: boolean) => string;
}>;

export type OptionPickerOverlayProps = Readonly<{
    title: string;
    effectiveLabel?: string;
    notes?: ReadonlyArray<string>;
    summary?: React.ReactNode;
    summaryTestID?: string;
    headerAccessory?: React.ReactNode;
    options: ReadonlyArray<OptionPickerOption>;
    selectedValue: string;
    emptyText: string;
    canEnterCustomValue: boolean;
    customLabel?: string;
    customDescription?: string;
    searchPlaceholder?: string;
    optionTestIDPrefix?: string;
    refreshTestID?: string;
    favoriteOptions?: OptionPickerFavoriteOptions;
    selectedOptionControls?: ReadonlyArray<SessionConfigOptionControl>;
    onSelectOptionControlValue?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    onSelect: (value: string) => void;
    onSubmitCustomValue?: (value: string) => void | Promise<void>;
    probe?: OptionPickerProbeState;
}>;

const MOBILE_SINGLE_COLUMN_WIDTH = 560;

export function OptionPickerOverlay(props: OptionPickerOverlayProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: windowWidth } = useWindowDimensions();
    const transientStyles = React.useMemo(() => ({
        optionCardSelected: { backgroundColor: theme.colors.surface.selected },
        optionCardHovered: { backgroundColor: theme.colors.surface.pressed },
        optionCardPressed: { opacity: 0.86 },
        refreshIconButtonPressed: { backgroundColor: theme.colors.surface.pressed },
        refreshIconButtonDisabled: { opacity: 0.6 },
    }), [
        theme.colors.surface.pressed,
        theme.colors.surface.selected,
    ]);
    const [query, setQuery] = React.useState('');
    const optionValues = React.useMemo(() => {
        return new Set(props.options.map((option) => option.value));
    }, [props.options]);

    const probe = props.probe;
    const shouldRenderProbeControl = probe ? typeof probe.onRefresh === 'function' || probe.phase !== 'idle' : false;
    const showSearch = props.options.length >= 10;
    const normalizedQuery = query.trim().toLowerCase();
    const notes = props.notes ?? [];
    const optionTestIDPrefix = props.optionTestIDPrefix ?? 'model-picker-overlay-option';
    const refreshTestID = props.refreshTestID ?? 'model-picker-overlay-refresh';
    const selectedIndicatorColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
    const selectedValue = readNonBlankSessionControlIdentifier(props.selectedValue) ?? '';
    const selectedCustomValue = props.canEnterCustomValue && selectedValue.length > 0 && !optionValues.has(selectedValue)
        ? selectedValue
        : '';
    const [customValue, setCustomValue] = React.useState(selectedCustomValue);
    const [customEditorVisible, setCustomEditorVisible] = React.useState(selectedCustomValue.length > 0);
    const customEditorOpenReasonRef = React.useRef<'selected-custom' | 'manual' | null>(
        selectedCustomValue.length > 0 ? 'selected-custom' : null,
    );
    const lastCommittedCustomValueRef = React.useRef<string>(selectedCustomValue);
    const previousSelectedValueRef = React.useRef(selectedValue);
    // Dismissing the picker unmounts a still-focused input without firing `onBlur` on either
    // React Native or React Native Web, so the unmount path has to flush the pending value.
    // `commitCustomValue` is idempotent, so a blur followed by unmount commits once. Seeded
    // neutral and refreshed on every render below, so it can live above the code that resets it.
    const pendingCustomCommitRef = React.useRef<{
        visible: boolean;
        value: string;
        commit: (raw: string) => void;
    }>({ visible: false, value: '', commit: () => {} });

    /**
     * Forget an in-progress custom model draft.
     *
     * Called wherever a listed option supersedes the custom selection — through this picker or
     * from outside it. Hiding the editor is not enough: a surviving draft is revived when the
     * editor reopens and a later dismiss commits it over the real selection. Clearing the
     * last-committed marker matters too, or re-choosing that same custom id afterwards is
     * swallowed as a duplicate.
     */
    // Pressing another control blurs the focused input BEFORE that control's press handler runs.
    // Without this, tapping a listed option commits the half-typed draft first and publishes an
    // unintended intermediate model change before the option the user actually chose.
    const selectionPressPendingRef = React.useRef(false);

    const abandonCustomDraft = React.useCallback(() => {
        selectionPressPendingRef.current = false;
        pendingCustomCommitRef.current = { ...pendingCustomCommitRef.current, visible: false, value: '' };
        lastCommittedCustomValueRef.current = '';
        setCustomValue('');
    }, []);
    const probeHintText = React.useMemo(() => {
        if (!probe || probe.phase === 'idle') return null;
        if (props.options.length > 1 || props.canEnterCustomValue) return null;
        return probe.phase === 'loading'
            ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
            : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'));
    }, [
        probe,
        props.canEnterCustomValue,
        props.options.length,
    ]);

    React.useEffect(() => {
        const previousSelectedValue = previousSelectedValueRef.current;
        previousSelectedValueRef.current = selectedValue;

        if (selectedCustomValue.length > 0) {
            setCustomValue(selectedCustomValue);
            setCustomEditorVisible(true);
            customEditorOpenReasonRef.current = 'selected-custom';
            lastCommittedCustomValueRef.current = selectedCustomValue;
            return;
        }
        if (optionValues.has(selectedValue)) {
            if (customEditorOpenReasonRef.current === 'selected-custom') {
                customEditorOpenReasonRef.current = null;
                setCustomEditorVisible(false);
                return;
            }
            if (customEditorVisible && previousSelectedValue === selectedValue) {
                return;
            }
            customEditorOpenReasonRef.current = null;
            setCustomEditorVisible(false);
            abandonCustomDraft();
        }
    }, [abandonCustomDraft, customEditorVisible, optionValues, selectedCustomValue, selectedValue]);

    const filteredOptions = React.useMemo(() => {
        if (!showSearch || !normalizedQuery) return props.options;
        return props.options.filter((opt) => {
            const haystack = `${opt.label} ${opt.value} ${opt.description ?? ''}`.toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [normalizedQuery, props.options, showSearch]);
    const optionColumnCount = filteredOptions.length <= 1 || windowWidth < MOBILE_SINGLE_COLUMN_WIDTH ? 1 : 2;

    const renderSelectedOptionControls = React.useCallback(() => {
        if ((props.selectedOptionControls?.length ?? 0) === 0) {
            return null;
        }

        return (
            <View style={styles.inlineSelectedControls}>
                {props.selectedOptionControls?.map((control) => {
                const option = control.option;
                const effectiveValue = control.effectiveValue;

                if (shouldRenderConfigOptionAsBooleanSwitch(option)) {
                    const boolValue = resolveBooleanConfigOptionValue(option, String(effectiveValue) as SessionConfigOptionValueId);
                    return (
                        <View
                            key={option.id}
                            testID={`model-picker-overlay-selected-option-control:${option.id}`}
                            style={styles.selectedControlRow}
                        >
                            <View style={styles.selectedControlTextBlock}>
                                <Text style={styles.selectedControlTitle}>{option.name}</Text>
                                {option.description ? (
                                    <Text style={styles.selectedControlDescription}>{option.description}</Text>
                                ) : null}
                            </View>
                            <Switch
                                testID={`model-picker-overlay-selected-option-control-switch:${option.id}`}
                                value={boolValue}
                                onValueChange={(next) => props.onSelectOptionControlValue?.(
                                    option.id,
                                    resolveBooleanConfigOptionNextValue(option, next),
                                )}
                                compact
                            />
                        </View>
                    );
                }

                const tabs = option.options?.map((choice) => ({
                    id: choice.value,
                    label: choice.name,
                })) ?? [];
                const isDisabled = control.disabled === true;

                return (
                    <View
                        key={option.id}
                        testID={`model-picker-overlay-selected-option-control:${option.id}`}
                        style={styles.selectedControlGroup}
                    >
                        <Text style={styles.selectedControlTitle}>{option.name}</Text>
                        {isDisabled ? (
                            <Text
                                testID={`model-picker-overlay-selected-option-control-overridden:${option.id}`}
                                style={styles.selectedControlDescription}
                            >
                                {t('agentInput.acp.optionOverriddenBy', { name: control.disabledByOptionName ?? '' })}
                            </Text>
                        ) : option.description ? (
                            <Text style={styles.selectedControlDescription}>{option.description}</Text>
                        ) : null}
                        <View
                            style={isDisabled ? styles.selectedControlDimmed : null}
                            pointerEvents={isDisabled ? 'none' : 'auto'}
                        >
                            <SegmentedTabBar
                                tabs={tabs}
                                activeTabId={effectiveValue}
                                onSelectTab={(tabId) => {
                                    if (isDisabled) return;
                                    props.onSelectOptionControlValue?.(option.id, tabId as SessionConfigOptionValueId);
                                }}
                                testIDPrefix={`model-picker-overlay-selected-option-control-option:${option.id}`}
                                compact
                            />
                        </View>
                    </View>
                );
                })}
            </View>
        );
    }, [
        props.onSelectOptionControlValue,
        props.selectedOptionControls,
        styles.inlineSelectedControls,
        styles.selectedControlDescription,
        styles.selectedControlDimmed,
        styles.selectedControlGroup,
        styles.selectedControlRow,
        styles.selectedControlTextBlock,
        styles.selectedControlTitle,
    ]);

    const handleSelectOption = React.useCallback((nextValue: string) => {
        customEditorOpenReasonRef.current = null;
        // Synchronously, before `onSelect`: a host that unmounts inside it never runs the passive
        // effect that refreshes the pending-commit ref.
        abandonCustomDraft();
        setCustomEditorVisible(false);
        props.onSelect(nextValue);
    }, [abandonCustomDraft, props]);

    const commitCustomValue = React.useCallback((raw: string) => {
        const normalized = readNonBlankSessionControlIdentifier(raw);
        if (!normalized) return;
        if (lastCommittedCustomValueRef.current === normalized) return;
        lastCommittedCustomValueRef.current = normalized;
        if (props.onSubmitCustomValue) {
            void props.onSubmitCustomValue(normalized);
            return;
        }
        props.onSelect(normalized);
    }, [props]);

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

    const handleCustomValueChange = React.useCallback((next: string) => {
        // Only update local editor state while typing. Committing on every keystroke
        // pushes the value up to the parent, which regenerates the picker option list
        // (with a fresh detail-content closure) and remounts this input — dropping the
        // keyboard after each character. Commit happens on submit/blur instead.
        setCustomValue(next);
    }, []);

    const selectedTileValue = customEditorVisible ? null : props.selectedValue;
    return (
        <View testID="model-picker-overlay" style={styles.section}>
            <View style={[styles.row, styles.titleRowContainer]}>
                <View style={styles.titleRow}>
                    <Text style={styles.title}>{props.title}</Text>
                    {props.summary ? (
                        <View
                            testID={props.summaryTestID ?? 'model-picker-overlay-summary'}
                            style={styles.effectiveBlock}
                        >
                            {typeof props.summary === 'string'
                                ? <Text style={styles.noteText}>{props.summary}</Text>
                                : props.summary}
                            {notes.map((note, idx) => (
                                <Text key={idx} style={styles.noteText}>{note}</Text>
                            ))}
                        </View>
                    ) : (props.effectiveLabel || notes.length > 0) ? (
                        <View testID="model-picker-overlay-summary" style={styles.effectiveBlock}>
                            {props.effectiveLabel ? (
                                <Text style={styles.noteText}>{t('modelPickerOverlay.effectiveLabel', { label: props.effectiveLabel })}</Text>
                            ) : null}
                            {notes.map((note, idx) => (
                                <Text key={idx} style={styles.noteText}>{note}</Text>
                            ))}
                            {probeHintText ? (
                                <Text style={styles.noteText}>{probeHintText}</Text>
                            ) : null}
                        </View>
                    ) : null}
                </View>
                {props.headerAccessory || shouldRenderProbeControl ? (
                    <View style={styles.titleRowActions}>
                        {props.headerAccessory ? (
                            <View style={styles.headerAccessory}>
                                {props.headerAccessory}
                            </View>
                        ) : null}
                        {shouldRenderProbeControl && probe ? (
                            typeof probe.onRefresh === 'function' ? (
                                <Pressable
                                    testID={refreshTestID}
                                    onPress={probe.phase === 'idle' ? probe.onRefresh : undefined}
                                    style={({ pressed }) => [
                                        styles.refreshIconButton,
                                        pressed && probe.phase === 'idle' ? transientStyles.refreshIconButtonPressed : null,
                                        probe.phase !== 'idle' ? transientStyles.refreshIconButtonDisabled : null,
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={probe.refreshAccessibilityLabel ?? t('modelPickerOverlay.refreshModelsA11y')}
                                    hitSlop={6}
                                >
                                    {probe.phase === 'idle' ? (
                                        <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />
                                    ) : (
                                        <ActivitySpinner
                                            size="small"
                                            color={theme.colors.text.secondary}
                                            accessibilityLabel={probe.phase === 'loading'
                                                ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                                : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))}
                                            />
                                    )}
                                </Pressable>
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
            {(filteredOptions.length > 0 || props.canEnterCustomValue) ? (
                <>
                        {showSearch ? (
                            <View style={[styles.searchContainer, styles.row]}>
                                <TextInput
                                    testID="model-picker-overlay-search"
                                    value={query}
                                    onChangeText={setQuery}
                                    placeholder={props.searchPlaceholder ?? t('modelPickerOverlay.searchPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    autoCorrect={false}
                                    autoCapitalize="none"
                                    style={styles.searchInput as any}
                                />
                        </View>
                    ) : null}

                    {filteredOptions.length > 0 ? (
                        <View testID="model-picker-overlay-grid" style={styles.cardsGrid}>
                            {Array.from({ length: optionColumnCount }, (_, colIdx) => (
                                <View
                                    key={colIdx}
                                    testID={`model-picker-overlay-column:${colIdx}`}
                                    style={styles.cardsColumn}
                                >
                                    {filteredOptions
                                        .filter((_, i) => i % optionColumnCount === colIdx)
                                        .map((option) => {
                                            const isSelected = selectedTileValue === option.value;
                                            const isFavorite = props.favoriteOptions?.values.has(option.value) === true;
                                            const canToggleFavorite = (isSelected || isFavorite)
                                                && Boolean(props.favoriteOptions)
                                                && (props.favoriteOptions?.isFavoritable?.(option) ?? true);
                                            return (
                                                <View
                                                    key={option.value}
                                                    testID={`${optionTestIDPrefix}-container:${option.value}`}
                                                    style={[
                                                        styles.optionCardContainer,
                                                        isSelected ? transientStyles.optionCardSelected : null,
                                                    ]}
                                                >
                                                    <Pressable
                                                        testID={`${optionTestIDPrefix}:${option.value}`}
                                                        onPressIn={() => { selectionPressPendingRef.current = true; }}
                                                        onPress={() => handleSelectOption(option.value)}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={option.accessibilityLabel}
                                                        accessibilityState={{ selected: isSelected }}
                                                        style={(state) => {
                                                            const { pressed } = state;
                                                            // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                                                            const hovered = (state as WebHoverablePressableState).hovered === true;
                                                            return [
                                                                styles.optionCard,
                                                                isSelected ? transientStyles.optionCardSelected : null,
                                                                !isSelected && hovered ? transientStyles.optionCardHovered : null,
                                                                pressed ? transientStyles.optionCardPressed : null,
                                                            ];
                                                        }}
                                                    >
                                                        <View
                                                            testID={isSelected ? `model-picker-overlay-option-selected-indicator:${option.value}` : undefined}
                                                            pointerEvents="box-none"
                                                            style={styles.optionCardIndicator}
                                                        >
                                                            {isSelected ? (
                                                                <View style={styles.optionCardSelectionMark}>
                                                                    <Icon
                                                                        name="check"
                                                                        size={14}
                                                                        color={theme.colors.text.primary}
                                                                        style={styles.optionCardIndicatorIcon}
                                                                    />
                                                                </View>
                                                            ) : null}
                                                            {option.trailingStatusIcon ? (
                                                                <View
                                                                    testID={`${optionTestIDPrefix}-status-icon:${option.value}`}
                                                                    pointerEvents="none"
                                                                    style={styles.optionCardStatusIcon}
                                                                >
                                                                    {normalizeNodeForView(option.trailingStatusIcon)}
                                                                </View>
                                                            ) : null}
                                                            {canToggleFavorite ? (
                                                                <Pressable
                                                                    testID={`${optionTestIDPrefix}-favorite:${option.value}`}
                                                                    accessibilityRole="button"
                                                                    accessibilityLabel={
                                                                        props.favoriteOptions?.getAccessibilityLabel?.(option, isFavorite)
                                                                        ?? (isFavorite
                                                                            ? t('profiles.actions.removeFromFavorites')
                                                                            : t('profiles.actions.addToFavorites'))
                                                                    }
                                                                    hitSlop={8}
                                                                    onPress={(event) => {
                                                                        event?.stopPropagation?.();
                                                                        props.favoriteOptions?.onToggle(option);
                                                                    }}
                                                                    style={styles.optionFavoriteButton}
                                                                >
                                                                    <Icon
                                                                        name="star"
                                                                        size={14}
                                                                        color={isFavorite ? selectedIndicatorColor : theme.colors.text.secondary}
                                                                        weight={isFavorite ? 'fill' : 'regular'}
                                                                    />
                                                                </Pressable>
                                                            ) : null}
                                                        </View>
                                                        <View style={styles.optionCardContentRow}>
                                                            {option.icon ? (
                                                                <View
                                                                    testID={`${optionTestIDPrefix}-icon:${option.value}`}
                                                                    style={styles.optionCardIconSlot}
                                                                >
                                                                    {normalizeNodeForView(option.icon)}
                                                                </View>
                                                            ) : null}
                                                            <View style={styles.optionCardTextBlock}>
                                                                <Text style={[styles.optionCardTitle, isSelected ? styles.optionCardTitleSelected : null]}>
                                                                    {option.label}
                                                                </Text>
                                                                {option.description ? (
                                                                    <Text style={styles.optionCardDescription}>
                                                                        {option.description}
                                                                    </Text>
                                                                ) : null}
                                                            </View>
                                                        </View>
                                                    </Pressable>
                                                    {isSelected ? (
                                                        <View
                                                            testID={`model-picker-overlay-option-controls:${option.value}`}
                                                            style={styles.optionCardControls}
                                                        >
                                                            {renderSelectedOptionControls()}
                                                        </View>
                                                    ) : null}
                                                </View>
                                            );
                                        })}
                                </View>
                            ))}
                        </View>
                    ) : null}
                    {props.canEnterCustomValue ? (
                        <Pressable
                            testID="model-picker-overlay-custom"
                            onPress={() => {
                                if (customEditorVisible) return;
                                customEditorOpenReasonRef.current = selectedCustomValue.length > 0 ? 'selected-custom' : 'manual';
                                setCustomEditorVisible(true);
                                if (selectedCustomValue.length > 0) {
                                    setCustomValue(selectedCustomValue);
                                }
                            }}
                            style={(state) => {
                                const { pressed } = state;
                                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                                const hovered = (state as WebHoverablePressableState).hovered === true;
                                return [
                                    styles.customEntryRow,
                                    customEditorVisible ? transientStyles.optionCardSelected : null,
                                    !customEditorVisible && hovered ? transientStyles.optionCardHovered : null,
                                    pressed && !customEditorVisible ? transientStyles.optionCardPressed : null,
                                ];
                            }}
                        >
                            <View style={styles.optionCardHeader}>
                                <View style={styles.customEntryTextBlock}>
                                    <Text style={[styles.optionCardTitle, customEditorVisible ? styles.optionCardTitleSelected : null]}>
                                        {props.customLabel ?? t('modelPickerOverlay.customTitle')}
                                    </Text>
                                    {props.customDescription ? (
                                        <Text style={styles.optionCardDescription}>
                                            {props.customDescription}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={styles.customEntryIconSlot}>
                                    {customEditorVisible ? (
                                        <Icon
                                            name="check"
                                            size={14}
                                            color={theme.colors.text.primary}
                                            style={styles.optionCardIndicatorIcon}
                                        />
                                    ) : null}
                                </View>
                            </View>
                            {customEditorVisible ? (
                                <View style={styles.customEditor}>
                                    <TextInput
                                        testID="model-picker-overlay-custom-input"
                                        value={customValue}
                                        onChangeText={handleCustomValueChange}
                                        placeholder={t('agentInput.model.customPlaceholder')}
                                        placeholderTextColor={theme.colors.input?.placeholder ?? theme.colors.text.secondary}
                                        autoCorrect={false}
                                        autoCapitalize="none"
                                        onSubmitEditing={() => commitCustomValue(customValue)}
                                        onBlur={() => {
                                            if (selectionPressPendingRef.current) {
                                                // Consume the flag: this blur belongs to a listed-option press,
                                                // whose handler discards the draft moments later.
                                                selectionPressPendingRef.current = false;
                                                return;
                                            }
                                            commitCustomValue(customValue);
                                        }}
                                        style={[styles.searchInput, styles.customEditorInput] as any}
                                    />
                                </View>
                            ) : null}
                        </Pressable>
                    ) : null}
                </>
            ) : (
                <Text style={styles.emptyText}>{props.emptyText}</Text>
            )}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingVertical: 0,
        gap: 6,
    },
    row: {
        gap: 0,
        paddingLeft: 7,
    },
    titleRowContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    titleRow: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: 0,
        paddingBottom: 0,
    },
    titleRowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
        gap: 4,
        marginLeft: 8,
    },
    headerAccessory: {
        flexShrink: 0,
    },
    title: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        textTransform: 'uppercase',
        position: 'relative',
    },
    effectiveBlock: {
        paddingTop: 0,
        paddingHorizontal: 0,
        paddingBottom: 0,
        gap: 0,
    },
    refreshIconButton: {
        minWidth: 28,
        height: 28,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: 'transparent',
        flexShrink: 0,
    },
    noteText: {
        fontSize: 11,
        color: theme.colors.text.tertiary,
    },
    searchContainer: {
        paddingHorizontal: 0,
        paddingTop: 2,
        paddingBottom: 2,
    },
    cardsGrid: {
        flexDirection: 'row',
        gap: 4,
    },
    cardsColumn: {
        flex: 1,
        gap: 8,
    },
    optionCard: {
        position: 'relative',
        borderRadius: 12,
        paddingHorizontal: 7,
        paddingVertical: 7,
        backgroundColor: theme.colors.surface.base,
    },
    optionCardContainer: {
        alignSelf: 'stretch',
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    optionCardControls: {
        paddingHorizontal: 7,
        paddingBottom: 7,
    },
    optionCardHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 6,
        paddingRight: 32,
    },
    optionCardContentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingRight: 32,
    },
    optionCardIconSlot: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    optionCardTextBlock: {
        flex: 1,
        minWidth: 0,
        gap: 0,
    },
    optionCardTitle: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    optionCardTitleSelected: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    optionCardIndicator: {
        position: 'absolute',
        top: 7,
        right: 7,
        zIndex: 2,
        elevation: 2,
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
        gap: 6,
    },
    optionCardIndicatorIcon: {
        height: 12,
    },
    optionCardSelectionMark: {
        width: 20,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionCardStatusIcon: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionFavoriteButton: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionCardDescription: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    inlineSelectedControls: {
        marginTop: 10,
        gap: 10,
        paddingTop: 0,
    },
    selectedControlGroup: {
        gap: 3,
    },
    selectedControlRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    selectedControlTextBlock: {
        flex: 1,
        gap: 1,
    },
    selectedControlTitle: {
        fontSize: 9,
        ...Typography.default('semiBold'),
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
    },
    selectedControlDescription: {
        fontSize: 9,
        color: theme.colors.text.secondary,
    },
    selectedControlDimmed: {
        opacity: 0.4,
    },
    searchInput: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: 10,
        paddingVertical: 7,
        fontSize: 12,
        color: theme.colors.text.primary,
    },
    customEditor: {
        paddingHorizontal: 0,
        paddingTop: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    customEditorInput: {
        flex: 1,
    },
    customEntryRow: {
        position: 'relative',
        borderRadius: 12,
        paddingHorizontal: 7,
        paddingVertical: 7,
        backgroundColor: theme.colors.surface.base,
        marginTop: 4,
        marginHorizontal: 0
    },
    customEntryHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    customEntryIconSlot: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'flex-start',
        marginTop: 2,
    },
    customEntryTextBlock: {
        flex: 1,
    },
    customEntryTitle: {
        fontSize: 12,
        lineHeight: 15,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    customEntryDescription: {
        fontSize: 10,
        lineHeight: 13,
        color: theme.colors.text.secondary,
    },
    rowPressed: {
        opacity: 0.85,
    },
    emptyText: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        paddingHorizontal: 0,
        paddingVertical: 8,
    },
}));

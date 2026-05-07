import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import type {
    AcpConfigOptionControl,
    AcpConfigOptionValueId,
} from '@/sync/acp/configOptionsControl';
import {
    isBooleanConfigOptionType,
    resolveBooleanConfigOptionNextValue,
    resolveBooleanConfigOptionValue,
} from '@/sync/acp/configOptionsControl';
import { t } from '@/text';


export type ModelPickerOption = Readonly<{
    value: string;
    label: string;
    description?: string;
}>;

export type ModelPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
    refreshAccessibilityLabel?: string;
    loadingAccessibilityLabel?: string;
    refreshingAccessibilityLabel?: string;
}>;

export function ModelPickerOverlay(props: {
    title: string;
    effectiveLabel: string;
    notes: ReadonlyArray<string>;
    options: ReadonlyArray<ModelPickerOption>;
    selectedValue: string;
    emptyText: string;
    canEnterCustomModel: boolean;
    customLabel?: string;
    customDescription?: string;
    searchPlaceholder?: string;
    selectedOptionControls?: ReadonlyArray<AcpConfigOptionControl>;
    onSelectOptionControlValue?: (configId: string, valueId: AcpConfigOptionValueId) => void;
    onSelect: (value: string) => void;
    onSubmitCustomModel?: (value: string) => void | Promise<void>;
    probe?: ModelPickerProbeState;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const selectedIndicatorColor = theme.dark ? theme.colors.text : theme.colors.button.primary.background;
    const [query, setQuery] = React.useState('');
    const lastCommittedCustomModelRef = React.useRef<string | null>(null);
    const optionValues = React.useMemo(() => {
        return new Set(props.options.map((option) => option.value));
    }, [props.options]);

    const probe = props.probe;
    const showSearch = props.options.length >= 10;
    const normalizedQuery = query.trim().toLowerCase();
    const selectedValue = props.selectedValue.trim();
    const selectedCustomValue = props.canEnterCustomModel && selectedValue.length > 0 && !optionValues.has(selectedValue)
        ? selectedValue
        : '';
    const [customValue, setCustomValue] = React.useState(selectedCustomValue);
    const [customEditorVisible, setCustomEditorVisible] = React.useState(selectedCustomValue.length > 0);
    const previousSelectedValueRef = React.useRef(selectedValue);

    React.useEffect(() => {
        const previousSelectedValue = previousSelectedValueRef.current;
        previousSelectedValueRef.current = selectedValue;

        if (selectedCustomValue.length > 0) {
            setCustomValue(selectedCustomValue);
            setCustomEditorVisible(true);
            return;
        }
        if (customEditorVisible && previousSelectedValue === selectedValue) {
            return;
        }
        if (optionValues.has(selectedValue)) {
            setCustomEditorVisible(false);
        }
    }, [customEditorVisible, optionValues, selectedCustomValue, selectedValue]);

    const filteredOptions = React.useMemo(() => {
        if (!showSearch || !normalizedQuery) return props.options;
        return props.options.filter((opt) => {
            const haystack = `${opt.label} ${opt.value} ${opt.description ?? ''}`.toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [normalizedQuery, props.options, showSearch]);

    const renderSelectedOptionControls = React.useCallback(() => {
        if ((props.selectedOptionControls?.length ?? 0) === 0) {
            return null;
        }

        return props.selectedOptionControls?.map((control) => {
            const option = control.option;
            const effectiveValue = control.effectiveValue;

            if (isBooleanConfigOptionType(option.type)) {
                const boolValue = resolveBooleanConfigOptionValue(option, String(effectiveValue) as AcpConfigOptionValueId);
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
                    {option.description ? (
                        <Text style={styles.selectedControlDescription}>{option.description}</Text>
                    ) : null}
                    <View style={styles.selectedControlChoices}>
                        {option.options?.map((choice) => {
                            const isChoiceSelected = choice.value === effectiveValue;
                            return (
                                <Pressable
                                    key={`${option.id}:${String(choice.value)}`}
                                    testID={`model-picker-overlay-selected-option-control-option:${option.id}:${String(choice.value)}`}
                                    onPress={() => props.onSelectOptionControlValue?.(option.id, String(choice.value) as AcpConfigOptionValueId)}
                                    style={({ pressed }) => [
                                        styles.selectedControlChoice,
                                        isChoiceSelected ? styles.selectedControlChoiceSelected : null,
                                        pressed ? styles.optionCardPressed : null,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.selectedControlChoiceLabel,
                                            isChoiceSelected ? styles.selectedControlChoiceLabelSelected : null,
                                        ]}
                                    >
                                        {choice.name}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
            );
        }) ?? null;
    }, [props.onSelectOptionControlValue, props.selectedOptionControls, styles.optionCardPressed, styles.selectedControlChoice, styles.selectedControlChoiceLabel, styles.selectedControlChoiceLabelSelected, styles.selectedControlChoiceSelected, styles.selectedControlChoices, styles.selectedControlDescription, styles.selectedControlGroup, styles.selectedControlRow, styles.selectedControlTextBlock, styles.selectedControlTitle]);

    const handleSelectOption = React.useCallback((nextValue: string) => {
        setCustomEditorVisible(false);
        props.onSelect(nextValue);
    }, [props]);

    const commitCustomModel = React.useCallback((raw: string) => {
        const normalized = raw.trim();
        if (!normalized) return;
        if (lastCommittedCustomModelRef.current === normalized) return;
        lastCommittedCustomModelRef.current = normalized;
        void props.onSubmitCustomModel?.(normalized);
    }, [props.onSubmitCustomModel]);

    const handleSubmitCustomModel = React.useCallback(() => {
        commitCustomModel(customValue);
    }, [commitCustomModel, customValue]);

    const handleCustomValueChange = React.useCallback((next: string) => {
        setCustomValue(next);
        commitCustomModel(next);
    }, [commitCustomModel]);

    const selectedTileValue = customEditorVisible ? null : props.selectedValue;

    return (
        <View testID="model-picker-overlay" style={styles.section}>
            <View style={styles.titleRow}>
                <Text style={styles.title}>{props.title}</Text>
                    {probe ? (
                        typeof probe.onRefresh === 'function' ? (
                            <Pressable
                                testID="model-picker-overlay-refresh"
                                onPress={probe.phase === 'idle' ? probe.onRefresh : undefined}
                            style={({ pressed }) => [
                                styles.refreshIconButton,
                                pressed && probe.phase === 'idle' ? styles.refreshIconButtonPressed : null,
                                probe.phase !== 'idle' ? styles.refreshIconButtonDisabled : null,
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={probe.refreshAccessibilityLabel ?? t('modelPickerOverlay.refreshModelsA11y')}
                                hitSlop={6}
                            >
                                {probe.phase === 'idle' ? (
                                    <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />
                                ) : (
                                    <ActivityIndicator
                                        size="small"
                                        color={theme.colors.textSecondary}
                                        accessibilityLabel={probe.phase === 'loading'
                                            ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                            : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))}
                                    />
                                )}
                            </Pressable>
                        ) : probe.phase !== 'idle' ? (
                            <View style={styles.refreshIconButton}>
                                <ActivityIndicator
                                    size="small"
                                    color={theme.colors.textSecondary}
                                    accessibilityLabel={probe.phase === 'loading'
                                        ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                        : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))}
                                />
                            </View>
                        ) : null
                    ) : null}
                </View>
                <View testID="model-picker-overlay-summary" style={styles.effectiveBlock}>
                    <Text style={styles.noteText}>{t('modelPickerOverlay.effectiveLabel', { label: props.effectiveLabel })}</Text>
                    {props.notes.map((note, idx) => (
                        <Text key={idx} style={styles.noteText}>{note}</Text>
                    ))}
                </View>

            {(filteredOptions.length > 0 || props.canEnterCustomModel) ? (
                <>
                        {showSearch ? (
                            <View style={styles.searchContainer}>
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
                        <View style={styles.cardsGrid}>
                            {filteredOptions.map((option) => {
                                const isSelected = selectedTileValue === option.value;
                                return (
                                    <Pressable
                                        key={option.value}
                                        testID={`model-picker-overlay-option:${option.value}`}
                                        onPress={() => handleSelectOption(option.value)}
                                        style={({ pressed }) => [
                                            styles.optionCard,
                                            isSelected ? styles.optionCardSelected : null,
                                            pressed ? styles.optionCardPressed : null,
                                        ]}
                                    >
                                        <View style={styles.optionCardHeader}>
                                            <Text style={styles.optionCardTitle}>
                                                {option.label}
                                            </Text>
                                            <View
                                                testID={isSelected ? `model-picker-overlay-option-selected-indicator:${option.value}` : undefined}
                                                style={styles.optionCardIndicator}
                                            >
                                                {isSelected ? (
                                                    <Ionicons
                                                        name="checkmark-circle"
                                                        size={18}
                                                        color={selectedIndicatorColor}
                                                    />
                                                ) : null}
                                            </View>
                                        </View>
                                        {option.description ? (
                                            <Text style={styles.optionCardDescription}>
                                                {option.description}
                                            </Text>
                                        ) : null}
                                    </Pressable>
                                );
                            })}
                        </View>
                    ) : null}
                    {!customEditorVisible && (props.selectedOptionControls?.length ?? 0) > 0 ? (
                        <View testID="model-picker-overlay-selected-controls" style={styles.selectedControlsPanel}>
                            {renderSelectedOptionControls()}
                        </View>
                    ) : null}
                    {props.canEnterCustomModel ? (
                        <Pressable
                            testID="model-picker-overlay-custom"
                            onPress={() => {
                                setCustomEditorVisible(true);
                                if (selectedCustomValue.length > 0) {
                                    setCustomValue(selectedCustomValue);
                                }
                            }}
                            style={({ pressed }) => [
                                styles.customEntryRow,
                                customEditorVisible ? styles.customEntryRowSelected : null,
                                pressed ? styles.rowPressed : null,
                            ]}
                        >
                            <View style={styles.customEntryHeader}>
                                <View style={styles.customEntryTextBlock}>
                                    <Text style={styles.customEntryTitle}>
                                        {props.customLabel ?? t('modelPickerOverlay.customTitle')}
                                    </Text>
                                    {props.customDescription ? (
                                        <Text style={styles.customEntryDescription}>
                                            {props.customDescription}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={styles.customEntryIconSlot}>
                                    {customEditorVisible ? (
                                        <Ionicons
                                            name="checkmark-circle"
                                            size={18}
                                            color={selectedIndicatorColor}
                                        />
                                    ) : null}
                                </View>
                            </View>
                        </Pressable>
                    ) : null}
                    {props.canEnterCustomModel && customEditorVisible ? (
                        <View style={styles.customEditor}>
                            <TextInput
                                testID="model-picker-overlay-custom-input"
                                value={customValue}
                                onChangeText={handleCustomValueChange}
                                placeholder={t('agentInput.model.customPlaceholder')}
                                placeholderTextColor={theme.colors.input?.placeholder ?? theme.colors.textSecondary}
                                autoCorrect={false}
                                autoCapitalize="none"
                                onSubmitEditing={handleSubmitCustomModel}
                                style={styles.searchInput as any}
                            />
                        </View>
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
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
        paddingBottom: 0,
        gap: 8,
    },
    title: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.textSecondary,
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
        borderColor: theme.colors.divider,
        backgroundColor: 'transparent',
        flexShrink: 0,
    },
    refreshIconButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    refreshIconButtonDisabled: {
        opacity: 0.6,
    },
    noteText: {
        fontSize: 10,
        lineHeight: 13,
        color: theme.colors.textSecondary,
    },
    searchContainer: {
        paddingHorizontal: 0,
        paddingTop: 2,
        paddingBottom: 2,
    },
    cardsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    optionCard: {
        width: '48.5%',
        minHeight: 68,
        borderRadius: 13,
        paddingHorizontal: 9,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        gap: 3,
    },
    optionCardSelected: {
        backgroundColor: theme.colors.surfacePressed,
    },
    optionCardPressed: {
        opacity: 0.86,
    },
    optionCardHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 6,
    },
    optionCardTitle: {
        flex: 1,
        fontSize: 12,
        lineHeight: 15,
        fontWeight: '700',
        color: theme.colors.text,
    },
    optionCardIndicator: {
        minWidth: 18,
        minHeight: 18,
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
    },
    optionCardDescription: {
        fontSize: 10,
        lineHeight: 13,
        color: theme.colors.textSecondary,
    },
    selectedControlsPanel: {
        marginTop: 8,
        gap: 5,
        padding: 10,
        borderRadius: 13,
        backgroundColor: theme.colors.surface,
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
        fontWeight: '700',
        letterSpacing: 0.35,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    selectedControlDescription: {
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.textSecondary,
    },
    selectedControlChoices: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
    },
    selectedControlChoice: {
        minHeight: 24,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectedControlChoiceSelected: {
        backgroundColor: theme.colors.button.primary.background,
    },
    selectedControlChoiceLabel: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    selectedControlChoiceLabelSelected: {
        color: theme.colors.button.primary.tint,
    },
    searchInput: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
        paddingVertical: 7,
        fontSize: 12,
        color: theme.colors.text,
    },
    customEditor: {
        paddingHorizontal: 0,
        paddingTop: 4,
        gap: 8,
    },
    customEntryRow: {
        minHeight: 54,
        marginTop: 4,
        marginHorizontal: 0,
        borderRadius: 13,
        paddingHorizontal: 10,
        paddingVertical: 9,
        backgroundColor: theme.colors.surface,
    },
    customEntryRowSelected: {
        backgroundColor: theme.colors.surfacePressed,
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
        gap: 2,
    },
    customEntryTitle: {
        fontSize: 12,
        lineHeight: 15,
        fontWeight: '700',
        color: theme.colors.text,
    },
    customEntryDescription: {
        fontSize: 10,
        lineHeight: 13,
        color: theme.colors.textSecondary,
    },
    rowPressed: {
        opacity: 0.85,
    },
    emptyText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        paddingHorizontal: 0,
        paddingVertical: 8,
    },
}));

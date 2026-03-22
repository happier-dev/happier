import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Typography } from '@/constants/Typography';
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


export type OptionPickerOption = Readonly<{
    value: string;
    label: string;
    description?: string;
}>;

export type OptionPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
    refreshAccessibilityLabel?: string;
    loadingAccessibilityLabel?: string;
    refreshingAccessibilityLabel?: string;
}>;

export type OptionPickerOverlayProps = Readonly<{
    testIDBase?: string;
    density?: 'regular' | 'tight';
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
    selectedOptionControls?: ReadonlyArray<SessionConfigOptionControl>;
    onSelectOptionControlValue?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    onSelect: (value: string) => void;
    onSubmitCustomValue?: (value: string) => void | Promise<void>;
    probe?: OptionPickerProbeState;
}>;

export function OptionPickerOverlay(props: OptionPickerOverlayProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');
    const density = props.density ?? 'regular';
    const optionValues = React.useMemo(() => {
        return new Set(props.options.map((option) => option.value));
    }, [props.options]);

    const probe = props.probe;
    const showSearch = props.options.length >= 10;
    const normalizedQuery = query.trim().toLowerCase();
    const notes = props.notes ?? [];
    const testIDBase = props.testIDBase ?? 'model-picker-overlay';
    const optionTestIDPrefix = props.optionTestIDPrefix ?? `${testIDBase}-option`;
    const refreshTestID = props.refreshTestID ?? `${testIDBase}-refresh`;
    const summaryTestID = props.summaryTestID ?? `${testIDBase}-summary`;
    const selectedIndicatorTestIDPrefix = `${testIDBase}-option-selected-indicator`;
    const selectedOptionControlTestIDPrefix = `${testIDBase}-selected-option-control`;
    const customEntryTestID = `${testIDBase}-custom`;
    const customInputTestID = `${testIDBase}-custom-input`;
    const customSaveTestID = `${testIDBase}-custom-save`;
    const customSelectedIndicatorTestIDPrefix = `${testIDBase}-custom-entry-option-selected-indicator`;
    const selectedValue = props.selectedValue.trim();
    const selectedCustomValue = props.canEnterCustomValue && selectedValue.length > 0 && !optionValues.has(selectedValue)
        ? selectedValue
        : '';
    const [customValue, setCustomValue] = React.useState(selectedCustomValue);
    const [customEditorVisible, setCustomEditorVisible] = React.useState(selectedCustomValue.length > 0);

    React.useEffect(() => {
        if (selectedCustomValue.length > 0) {
            setCustomValue(selectedCustomValue);
            setCustomEditorVisible(true);
            return;
        }
        if (optionValues.has(selectedValue)) {
            setCustomEditorVisible(false);
        }
    }, [optionValues, selectedCustomValue, selectedValue]);

    const filteredOptions = React.useMemo(() => {
        if (!showSearch || !normalizedQuery) return props.options;
        return props.options.filter((opt) => {
            const haystack = `${opt.label} ${opt.value} ${opt.description ?? ''}`.toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [normalizedQuery, props.options, showSearch]);
    const optionColumnCount = filteredOptions.length <= 1 ? 1 : 2;

    const renderSelectedOptionControls = React.useCallback(() => {
        if ((props.selectedOptionControls?.length ?? 0) === 0) {
            return null;
        }

        return (
            <View style={[
                styles.inlineSelectedControls,
                density === 'tight' ? styles.inlineSelectedControlsTight : null,
            ]}>
                {props.selectedOptionControls?.map((control) => {
                const option = control.option;
                const effectiveValue = control.effectiveValue;

                if (isBooleanConfigOptionType(option.type)) {
                    const boolValue = resolveBooleanConfigOptionValue(option, String(effectiveValue) as SessionConfigOptionValueId);
                    return (
                        <View
                            key={option.id}
                            testID={`${selectedOptionControlTestIDPrefix}:${option.id}`}
                            style={styles.selectedControlRow}
                        >
                            <View style={styles.selectedControlTextBlock}>
                                <Text style={styles.selectedControlTitle}>{option.name}</Text>
                                {option.description ? (
                                    <Text style={styles.selectedControlDescription}>{option.description}</Text>
                                ) : null}
                            </View>
                            <Switch
                                testID={`${selectedOptionControlTestIDPrefix}-switch:${option.id}`}
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

                return (
                    <View
                        key={option.id}
                        testID={`${selectedOptionControlTestIDPrefix}:${option.id}`}
                        style={styles.selectedControlGroup}
                    >
                        <Text style={styles.selectedControlTitle}>{option.name}</Text>
                        {option.description ? (
                            <Text style={styles.selectedControlDescription}>{option.description}</Text>
                        ) : null}
                        <SegmentedTabBar
                            tabs={tabs}
                            activeTabId={effectiveValue}
                            onSelectTab={(tabId) => props.onSelectOptionControlValue?.(option.id, tabId as SessionConfigOptionValueId)}
                            testIDPrefix={`${selectedOptionControlTestIDPrefix}-option:${option.id}`}
                        />
                    </View>
                );
                })}
            </View>
        );
    }, [
        density,
        props.onSelectOptionControlValue,
        props.selectedOptionControls,
        styles.inlineSelectedControls,
        styles.inlineSelectedControlsTight,
        styles.selectedControlDescription,
        styles.selectedControlGroup,
        styles.selectedControlRow,
        styles.selectedControlTextBlock,
        styles.selectedControlTitle,
    ]);

    const handleSelectOption = React.useCallback((nextValue: string) => {
        setCustomEditorVisible(false);
        props.onSelect(nextValue);
    }, [props]);

    const handleSubmitCustomValue = React.useCallback(() => {
        const normalized = customValue.trim();
        if (!normalized) {
            return;
        }
        void props.onSubmitCustomValue?.(normalized);
    }, [customValue, props]);

    const selectedTileValue = customEditorVisible ? null : props.selectedValue;
    const optionCardDensityStyle =
        density === 'tight' ? styles.optionCardTight : null;
    const optionCardTitleDensityStyle =
        density === 'tight' ? styles.optionCardTitleTight : null;
    const optionCardDescriptionDensityStyle =
        density === 'tight' ? styles.optionCardDescriptionTight : null;
    return (
        <View testID={testIDBase} style={styles.section}>
            <View style={styles.header}>
                <View style={styles.titleRow}>
                    <Text style={styles.title}>{props.title}</Text>
                    {props.headerAccessory ? (
                        <View style={styles.headerAccessory}>
                            {props.headerAccessory}
                        </View>
                    ) : null}
                    {probe ? (
                        typeof probe.onRefresh === 'function' ? (
                            <Pressable
                                testID={refreshTestID}
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
                                    <Ionicons name="refresh-outline" size={18} style={styles.refreshIcon as any} />
                                ) : (
                                    <ActivityIndicator
                                        size="small"
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
                                    accessibilityLabel={probe.phase === 'loading'
                                        ? (probe.loadingAccessibilityLabel ?? t('modelPickerOverlay.loadingModelsA11y'))
                                        : (probe.refreshingAccessibilityLabel ?? t('modelPickerOverlay.refreshingModelsA11y'))}
                                />
                            </View>
                        ) : null
                    ) : null}
                </View>
                {props.summary ? (
                    <View
                        testID={summaryTestID}
                        style={styles.effectiveBlock}
                    >
                        {typeof props.summary === 'string'
                            ? <Text style={styles.noteText}>{props.summary}</Text>
                            : props.summary}
                    </View>
                ) : (props.effectiveLabel || notes.length > 0) ? (
                    <View testID={summaryTestID} style={styles.effectiveBlock}>
                        {props.effectiveLabel ? (
                            <Text style={styles.noteText}>{t('modelPickerOverlay.effectiveLabel', { label: props.effectiveLabel })}</Text>
                        ) : null}
                        {notes.map((note, idx) => (
                            <Text key={idx} style={styles.noteText}>{note}</Text>
                        ))}
                    </View>
                ) : null}
            </View>
            {(filteredOptions.length > 0 || props.canEnterCustomValue) ? (
                <>
                        {showSearch ? (
                            <View style={styles.searchContainer}>
                                <TextInput
                                    testID={`${testIDBase}-search`}
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
                            {Array.from({ length: optionColumnCount }, (_, colIdx) => (
                                <View key={colIdx} style={styles.cardsColumn}>
                                    {filteredOptions
                                        .filter((_, i) => i % optionColumnCount === colIdx)
                                        .map((option) => {
                                            const isSelected = selectedTileValue === option.value;
                                            return (
                                                <Pressable
                                                    key={option.value}
                                                    testID={`${optionTestIDPrefix}:${option.value}`}
                                                    onPress={() => handleSelectOption(option.value)}
                                                    style={({ pressed }) => [
                                                        styles.optionCard,
                                                        optionCardDensityStyle,
                                                        isSelected ? styles.optionCardSelected : null,
                                                        pressed ? styles.optionCardPressed : null,
                                                    ]}
                                                >
                                                    <View style={styles.optionCardHeader}>
                                                        <Text style={[
                                                            styles.optionCardTitle,
                                                            optionCardTitleDensityStyle,
                                                            isSelected ? styles.optionCardTitleSelected : null,
                                                        ]}>
                                                            {option.label}
                                                        </Text>
                                                        <View
                                                            testID={isSelected ? `${selectedIndicatorTestIDPrefix}:${option.value}` : undefined}
                                                            style={styles.optionCardIndicator}
                                                        >
                                                            {isSelected ? (
                                                                <Ionicons
                                                                    name="checkmark-outline"
                                                                    size={16}
                                                                    style={styles.optionCardIndicatorIcon}
                                                                />
                                                            ) : null}
                                                        </View>
                                                    </View>
                                                    {option.description ? (
                                                        <Text style={[styles.optionCardDescription, optionCardDescriptionDensityStyle]}>
                                                            {option.description}
                                                        </Text>
                                                    ) : null}
                                                    {isSelected ? renderSelectedOptionControls() : null}
                                                </Pressable>
                                            );
                                        })}
                                </View>
                            ))}
                        </View>
                    ) : null}
                    {props.canEnterCustomValue ? (
                        <View style={[
                            styles.optionCard,
                            optionCardDensityStyle,
                            customEditorVisible ? styles.optionCardSelected : null,
                        ]}>
                            <Pressable
                                testID={customEntryTestID}
                                onPress={() => {
                                    setCustomEditorVisible(true);
                                    if (selectedCustomValue.length > 0) {
                                        setCustomValue(selectedCustomValue);
                                    }
                                }}
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
                                    <View
                                        testID={customEditorVisible ? `${customSelectedIndicatorTestIDPrefix}:${customValue}` : undefined}
                                        style={styles.optionCardIndicator}
                                    >
                                        {customEditorVisible ? (
                                            <Ionicons
                                                name="checkmark-outline"
                                                size={14}
                                                style={styles.optionCardIndicatorIcon}
                                            />
                                        ) : null}
                                    </View>
                                </View>
                            </Pressable>
                            {customEditorVisible ? (
                                <View style={styles.customEditor}>
                                    <TextInput
                                        testID={customInputTestID}
                                        value={customValue}
                                        onChangeText={setCustomValue}
                                        placeholder={t('agentInput.model.customPlaceholder')}
                                        placeholderTextColor={theme.colors.input?.placeholder ?? theme.colors.textSecondary}
                                        autoCorrect={false}
                                        autoCapitalize="none"
                                        onSubmitEditing={handleSubmitCustomValue}
                                        style={[styles.searchInput, styles.customEditorInput] as any}
                                    />
                                    <Pressable
                                        testID={customSaveTestID}
                                        onPress={handleSubmitCustomValue}
                                        style={({ pressed }) => [
                                            styles.customSaveButton,
                                            pressed ? styles.customSaveButtonPressed : null,
                                        ]}
                                    >
                                        <Text style={styles.customSaveButtonText}>{t('common.save')}</Text>
                                    </Pressable>
                                </View>
                            ) : null}
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
        gap: 8,
    },
    header: {
        gap: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
        paddingBottom: 0,
    },
    headerAccessory: {
        flexShrink: 0,
    },
    title: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    effectiveBlock: {
        paddingTop: 0,
        paddingHorizontal: 0,
        paddingBottom: 0,
        gap: 0,
    },
    refreshIcon: {
        color: theme.colors.textSecondary,
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
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.textSecondary,
    },
    searchContainer: {
        paddingHorizontal: 0,
        paddingTop: 1,
        paddingBottom: 1,
    },
    cardsGrid: {
        flexDirection: 'row',
        gap: 4,
    },
    cardsColumn: {
        flex: 1,
        gap: 4,
    },
    optionCard: {
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 7,
        backgroundColor: theme.colors.surface,
    },
    optionCardTight: {
        paddingHorizontal: 7,
        paddingVertical: 6,
    },
    optionCardSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity * 0.3,
        shadowRadius: 1,
        elevation: 1,
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
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text,
    },
    optionCardTitleTight: {
        fontSize: 10,
        lineHeight: 13,
    },
    optionCardTitleSelected: {
        ...Typography.default('semiBold'),
    },
    optionCardIndicator: {
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
        height: 12,
    },
    optionCardIndicatorIcon: {
        color: theme.colors.text,
        height: 12,
        marginTop: -4
    },
    optionCardDescription: {
        marginTop: 1,
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.textTertiary,
    },
    optionCardDescriptionTight: {
        fontSize: 8,
        lineHeight: 11,
    },
    inlineSelectedControls: {
        marginTop: 8,
        gap: 8,
        paddingTop: 0,
    },
    inlineSelectedControlsTight: {
        marginTop: 6,
        gap: 6,
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
        fontSize: 8,
        fontWeight: '700',
        letterSpacing: 0.35,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    selectedControlDescription: {
        fontSize: 9,
        lineHeight: 11,
        color: theme.colors.textSecondary,
    },
    searchInput: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 8,
        paddingVertical: 6,
        fontSize: 11,
        color: theme.colors.text,
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
        marginTop: 4,
        marginHorizontal: 0,
        borderRadius: 12,
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
        fontSize: 11,
        lineHeight: 14,
        fontWeight: '700',
        color: theme.colors.text,
    },
    customEntryDescription: {
        fontSize: 9,
        lineHeight: 12,
        color: theme.colors.textSecondary,
    },
    rowPressed: {
        opacity: 0.85,
    },
    customSaveButton: {
        alignSelf: 'flex-start',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: theme.colors.button.primary.background,
    },
    customSaveButtonPressed: {
        opacity: 0.85,
    },
    customSaveButtonText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
    },
    emptyText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        paddingHorizontal: 0,
        paddingVertical: 8,
    },
}));

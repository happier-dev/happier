import React from 'react';
import { ActivityIndicator, Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
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

const MOBILE_SINGLE_COLUMN_WIDTH = 560;

export function OptionPickerOverlay(props: OptionPickerOverlayProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: windowWidth } = useWindowDimensions();
    const [query, setQuery] = React.useState('');
    const optionValues = React.useMemo(() => {
        return new Set(props.options.map((option) => option.value));
    }, [props.options]);

    const probe = props.probe;
    const showSearch = props.options.length >= 10;
    const normalizedQuery = query.trim().toLowerCase();
    const notes = props.notes ?? [];
    const optionTestIDPrefix = props.optionTestIDPrefix ?? 'model-picker-overlay-option';
    const refreshTestID = props.refreshTestID ?? 'model-picker-overlay-refresh';
    const selectedValue = props.selectedValue.trim();
    const selectedCustomValue = props.canEnterCustomValue && selectedValue.length > 0 && !optionValues.has(selectedValue)
        ? selectedValue
        : '';
    const [customValue, setCustomValue] = React.useState(selectedCustomValue);
    const [customEditorVisible, setCustomEditorVisible] = React.useState(selectedCustomValue.length > 0);
    const lastCommittedCustomValueRef = React.useRef<string>(selectedCustomValue.trim());
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
        if (selectedCustomValue.length > 0) {
            setCustomValue(selectedCustomValue);
            setCustomEditorVisible(true);
            lastCommittedCustomValueRef.current = selectedCustomValue.trim();
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

                if (isBooleanConfigOptionType(option.type)) {
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
                        <SegmentedTabBar
                            tabs={tabs}
                            activeTabId={effectiveValue}
                            onSelectTab={(tabId) => props.onSelectOptionControlValue?.(option.id, tabId as SessionConfigOptionValueId)}
                            testIDPrefix={`model-picker-overlay-selected-option-control-option:${option.id}`}
                            compact
                        />
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
        styles.selectedControlGroup,
        styles.selectedControlRow,
        styles.selectedControlTextBlock,
        styles.selectedControlTitle,
    ]);

    const handleSelectOption = React.useCallback((nextValue: string) => {
        setCustomEditorVisible(false);
        props.onSelect(nextValue);
    }, [props]);

    const commitCustomValue = React.useCallback((raw: string) => {
        const normalized = raw.trim();
        if (!normalized) return;
        if (lastCommittedCustomValueRef.current === normalized) return;
        lastCommittedCustomValueRef.current = normalized;
        if (props.onSubmitCustomValue) {
            void props.onSubmitCustomValue(normalized);
            return;
        }
        props.onSelect(normalized);
    }, [props]);

    const handleCustomValueChange = React.useCallback((next: string) => {
        setCustomValue(next);
        commitCustomValue(next);
    }, [commitCustomValue]);

    const selectedTileValue = customEditorVisible ? null : props.selectedValue;
    return (
        <View testID="model-picker-overlay" style={styles.section}>
            <View style={styles.row}>
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
                        testID={props.summaryTestID ?? 'model-picker-overlay-summary'}
                        style={styles.effectiveBlock}
                    >
                        {typeof props.summary === 'string'
                            ? <Text style={styles.noteText}>{props.summary}</Text>
                            : props.summary}
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
                                            return (
                                                <Pressable
                                                    key={option.value}
                                                    testID={`${optionTestIDPrefix}:${option.value}`}
                                                    onPress={() => handleSelectOption(option.value)}
                                                    style={({ pressed }) => [
                                                        styles.optionCard,
                                                        isSelected ? styles.optionCardSelected : null,
                                                        pressed ? styles.optionCardPressed : null,
                                                    ]}
                                                >
                                                    <View style={styles.optionCardHeader}>
                                                        <Text style={[styles.optionCardTitle, isSelected ? styles.optionCardTitleSelected : null]}>
                                                            {option.label}
                                                        </Text>
                                                        <View
                                                            testID={isSelected ? `model-picker-overlay-option-selected-indicator:${option.value}` : undefined}
                                                            style={styles.optionCardIndicator}
                                                        >
                                                            {isSelected ? (
                                                                <Ionicons
                                                                    name="checkmark-outline"
                                                                    size={14}
                                                                    style={styles.optionCardIndicatorIcon}
                                                                />
                                                            ) : null}
                                                        </View>
                                                    </View>
                                                    {option.description ? (
                                                        <Text style={styles.optionCardDescription}>
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
                            styles.customEntryRow,
                            styles.optionCard,
                            customEditorVisible ? styles.optionCardSelected : null,
                        ]}>
                            <Pressable
                                testID="model-picker-overlay-custom"
                                onPress={() => {
                                    setCustomEditorVisible(true);
                                    if (selectedCustomValue.length > 0) {
                                        setCustomValue(selectedCustomValue);
                                    }
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
                                    <View
                                        style={styles.customEntryIconSlot}
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
                                        testID="model-picker-overlay-custom-input"
                                        value={customValue}
                                        onChangeText={handleCustomValueChange}
                                        placeholder={t('agentInput.model.customPlaceholder')}
                                        placeholderTextColor={theme.colors.input?.placeholder ?? theme.colors.textSecondary}
                                        autoCorrect={false}
                                        autoCapitalize="none"
                                        onSubmitEditing={() => commitCustomValue(customValue)}
                                        style={[styles.searchInput, styles.customEditorInput] as any}
                                    />
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
        gap: 6,
    },
    row: {
        gap: 0,
        paddingLeft: 7,
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
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        position: 'relative',
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
        position: 'absolute',
        top: 0,
        right: 0,
        // Keep the refresh affordance above the effective summary block on web.
        zIndex: 10,
        elevation: 10,
    },
    refreshIconButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    refreshIconButtonDisabled: {
        opacity: 0.6,
    },
    noteText: {
        fontSize: 11,
        color: theme.colors.textTertiary,
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
        gap: 4,
    },
    optionCard: {
        borderRadius: 12,
        paddingHorizontal: 7,
        paddingVertical: 7,
        backgroundColor: theme.colors.surface,
    },
    optionCardSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        shadowColor: theme.colors.shadow?.color ?? '#000000',
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow?.opacity ?? 0.1,
        shadowRadius: 0,
        elevation: 1
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
        color: theme.colors.textSecondary,
    },
    optionCardTitleSelected: {
        fontWeight: '600',
        color: theme.colors.text,
    },
    optionCardIndicator: {
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
    },
    optionCardIndicatorIcon: {
        color: theme.colors.text,
        height: 12,
    },
    optionCardDescription: {
        fontSize: 11,
        color: theme.colors.textTertiary,
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
        fontWeight: '700',
        letterSpacing: 0.35,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    selectedControlDescription: {
        fontSize: 9,
        color: theme.colors.textSecondary,
    },
    searchInput: {
        borderRadius: 12,
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
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    customEditorInput: {
        flex: 1,
    },
    customEntryRow: {
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

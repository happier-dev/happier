import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/ui/text/Text';


export type ModelPickerOption = Readonly<{
    value: string;
    label: string;
    description?: string;
}>;

export type ModelPickerProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
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
    onSelect: (value: string) => void;
    onRequestCustomModel?: () => void | Promise<void>;
    probe?: ModelPickerProbeState;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');

    const probe = props.probe;
    const showSearch = props.options.length >= 12;
    const normalizedQuery = query.trim().toLowerCase();

    const filteredOptions = React.useMemo(() => {
        if (!showSearch || !normalizedQuery) return props.options;
        return props.options.filter((opt) => {
            const haystack = `${opt.label} ${opt.value} ${opt.description ?? ''}`.toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [normalizedQuery, props.options, showSearch]);

    return (
        <View style={styles.section}>
            <View style={styles.titleRow}>
                <Text style={styles.title}>{props.title}</Text>
                {probe ? (
                    typeof probe.onRefresh === 'function' ? (
                        <Pressable
                            onPress={probe.phase === 'idle' ? probe.onRefresh : undefined}
                            style={({ pressed }) => [
                                styles.refreshIconButton,
                                pressed && probe.phase === 'idle' ? styles.refreshIconButtonPressed : null,
                                probe.phase !== 'idle' ? styles.refreshIconButtonDisabled : null,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Refresh models"
                            hitSlop={6}
                        >
                            {probe.phase === 'idle' ? (
                                <Ionicons name="refresh-outline" size={18} style={styles.refreshIcon as any} />
                            ) : (
                                <ActivityIndicator
                                    size="small"
                                    accessibilityLabel={probe.phase === 'loading' ? 'Loading models…' : 'Refreshing models…'}
                                />
                            )}
                        </Pressable>
                    ) : probe.phase !== 'idle' ? (
                        <View style={styles.refreshIconButton}>
                            <ActivityIndicator
                                size="small"
                                accessibilityLabel={probe.phase === 'loading' ? 'Loading models…' : 'Refreshing models…'}
                            />
                        </View>
                    ) : null
                ) : null}
            </View>
            <View style={styles.effectiveBlock}>
                <Text style={styles.noteText}>Effective: {props.effectiveLabel}</Text>
                {props.notes.map((note, idx) => (
                    <Text key={idx} style={styles.noteText}>{note}</Text>
                ))}
            </View>

            {props.options.length > 0 ? (
                <>
                    {showSearch ? (
                        <View style={styles.searchContainer}>
                            <TextInput
                                value={query}
                                onChangeText={setQuery}
                                placeholder="Search models…"
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCorrect={false}
                                autoCapitalize="none"
                                style={styles.searchInput as any}
                            />
                        </View>
                    ) : null}

                    {filteredOptions.map((option) => {
                        const isSelected = option.value === props.selectedValue;
                        return (
                            <Pressable
                                key={option.value}
                                onPress={() => props.onSelect(option.value)}
                                style={({ pressed }) => [
                                    styles.row,
                                    pressed ? styles.rowPressed : null,
                                ]}
                            >
                                <View style={[styles.radioOuter, isSelected ? styles.radioOuterSelected : styles.radioOuterUnselected]}>
                                    {isSelected ? <View style={styles.radioInner} /> : null}
                                </View>
                                <View style={{ flexShrink: 1 }}>
                                    <Text style={[styles.optionLabel, isSelected ? styles.optionLabelSelected : styles.optionLabelUnselected]}>
                                        {option.label}
                                    </Text>
                                    {option.description ? (
                                        <Text style={styles.optionDescription}>{option.description}</Text>
                                    ) : null}
                                </View>
                            </Pressable>
                        );
                    })}
                    {props.canEnterCustomModel && props.onRequestCustomModel ? (
                        <Pressable
                            onPress={props.onRequestCustomModel}
                            style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                        >
                            <View style={[styles.radioOuter, styles.radioOuterUnselected]} />
                            <View style={{ flexShrink: 1 }}>
                                <Text style={[styles.optionLabel, styles.optionLabelUnselected]}>
                                    {props.customLabel ?? 'Custom…'}
                                </Text>
                                {props.customDescription ? (
                                    <Text style={styles.optionDescription}>{props.customDescription}</Text>
                                ) : null}
                            </View>
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
        paddingVertical: 16,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
        gap: 10,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    effectiveBlock: {
        paddingTop: 2,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    refreshIcon: {
        color: theme.colors.textSecondary,
    },
    refreshIconButton: {
        minWidth: 30,
        height: 30,
        borderRadius: 10,
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
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 2,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    searchContainer: {
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 8,
    },
    searchInput: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
        color: theme.colors.text,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioOuter: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioOuterUnselected: {
        borderColor: theme.colors.divider,
    },
    radioInner: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.radio.active,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
    },
    optionLabelSelected: {
        color: theme.colors.text,
    },
    optionLabelUnselected: {
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        maxWidth: 280,
    },
    emptyText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
}));

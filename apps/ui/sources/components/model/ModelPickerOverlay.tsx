import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export type ModelPickerOption = Readonly<{
    value: string;
    label: string;
    description?: string;
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
}) {
    const styles = stylesheet;
    const [query, setQuery] = React.useState('');

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
            <Text style={styles.title}>{props.title}</Text>
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
                                placeholderTextColor="#999"
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
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    effectiveBlock: {
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 8,
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
        borderColor: theme.colors.button.primary.background,
    },
    radioOuterUnselected: {
        borderColor: theme.colors.divider,
    },
    radioInner: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.button.primary.background,
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

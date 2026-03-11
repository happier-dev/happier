import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type AgentInputChipPickerOption = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    sectionId?: string;
    sectionLabel?: string;
    detailTitle?: string;
    detailDescription?: string;
    detailBullets?: ReadonlyArray<string>;
    detailActionLabel?: string;
    onDetailAction?: () => void;
    disabled?: boolean;
}>;

export type AgentInputChipPickerPanelProps = Readonly<{
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    onRequestClose: () => void;
    applyLabel?: string;
    showCloseButton?: boolean;
}>;

type OptionSection = Readonly<{
    id: string;
    label?: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
}>;

function buildSections(
    options: ReadonlyArray<AgentInputChipPickerOption>,
): ReadonlyArray<OptionSection> {
    const sections: OptionSection[] = [];
    const indexById = new Map<string, number>();

    for (const option of options) {
        const sectionId = option.sectionId ?? '__default__';
        const existingIndex = indexById.get(sectionId);
        if (existingIndex === undefined) {
            indexById.set(sectionId, sections.length);
            sections.push({
                id: sectionId,
                label: option.sectionLabel,
                options: [option],
            });
            continue;
        }

        const existing = sections[existingIndex];
        sections[existingIndex] = {
            ...existing,
            label: existing.label ?? option.sectionLabel,
            options: [...existing.options, option],
        };
    }

    return sections;
}

function hasDetailPane(
    options: ReadonlyArray<AgentInputChipPickerOption>,
): boolean {
    return options.some((option) =>
        Boolean(
            option.sectionLabel
            || option.detailTitle
            || option.detailDescription
            || (option.detailBullets?.length ?? 0) > 0,
        )
    );
}

export function AgentInputChipPickerPanel(props: AgentInputChipPickerPanelProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const sections = React.useMemo(() => buildSections(props.options), [props.options]);
    const detailed = React.useMemo(() => hasDetailPane(props.options), [props.options]);
    const [focusedOptionId, setFocusedOptionId] = React.useState<string | null>(
        props.selectedOptionId ?? props.options[0]?.id ?? null,
    );

    React.useEffect(() => {
        setFocusedOptionId(props.selectedOptionId ?? props.options[0]?.id ?? null);
    }, [props.options, props.selectedOptionId]);

    const focusedOption = React.useMemo(
        () => props.options.find((option) => option.id === focusedOptionId) ?? props.options[0] ?? null,
        [focusedOptionId, props.options],
    );

    const DetailPane = React.useCallback((detailProps: Readonly<{
        option: AgentInputChipPickerOption;
        onApply: () => void;
        applyLabel: string;
    }>) => (
        <View style={styles.detailPane}>
            <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>
                    {detailProps.option.detailTitle ?? detailProps.option.label}
                </Text>
                {detailProps.option.subtitle ? (
                    <Text style={styles.detailSubtitle}>{detailProps.option.subtitle}</Text>
                ) : null}
            </View>

            {detailProps.option.detailDescription ? (
                <Text style={styles.detailDescription}>
                    {detailProps.option.detailDescription}
                </Text>
            ) : null}

            {(detailProps.option.detailBullets?.length ?? 0) > 0 ? (
                <View style={styles.detailBullets}>
                    {detailProps.option.detailBullets?.map((bullet) => (
                        <View key={bullet} style={styles.detailBulletRow}>
                            <View style={styles.detailBulletDot} />
                            <Text style={styles.detailBulletText}>{bullet}</Text>
                        </View>
                    ))}
                </View>
            ) : null}

            {detailProps.option.detailActionLabel && detailProps.option.onDetailAction ? (
                <Pressable
                    testID="agent-input-chip-picker.detail-action"
                    accessibilityRole="button"
                    onPress={detailProps.option.onDetailAction}
                    disabled={detailProps.option.disabled}
                    style={({ pressed }) => [
                        styles.detailActionButton,
                        pressed ? styles.detailActionButtonPressed : null,
                        detailProps.option.disabled ? styles.applyButtonDisabled : null,
                    ]}
                >
                    <Text style={styles.detailActionButtonText}>{detailProps.option.detailActionLabel}</Text>
                </Pressable>
            ) : null}

            <Pressable
                testID="agent-input-chip-picker.apply"
                accessibilityRole="button"
                onPress={detailProps.onApply}
                disabled={detailProps.option.disabled}
                style={({ pressed }) => [
                    styles.applyButton,
                    pressed ? styles.applyButtonPressed : null,
                    detailProps.option.disabled ? styles.applyButtonDisabled : null,
                ]}
            >
                <Text style={styles.applyButtonText}>{detailProps.applyLabel}</Text>
            </Pressable>
        </View>
    ), [styles]);

    return (
        <View testID="agent-input-chip-picker" style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{props.title}</Text>
                {props.showCloseButton !== false ? (
                    <Pressable
                        onPress={props.onRequestClose}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                ) : null}
            </View>

            {!detailed ? (
                <View style={styles.body}>
                    <ItemListStatic style={{ backgroundColor: 'transparent' }}>
                        {sections.map((section) => (
                            <ItemGroup key={section.id} title={section.label ?? ''}>
                                {section.options.map((option, index) => (
                                    <Item
                                        key={option.id}
                                        testID={`agent-input-chip-picker.option:${option.id}`}
                                        title={option.label}
                                        subtitle={option.subtitle}
                                        selected={props.selectedOptionId === option.id}
                                        disabled={option.disabled}
                                        showChevron={false}
                                        showDivider={index < section.options.length - 1}
                                        onPress={() => {
                                            if (option.disabled) return;
                                            props.onSelect(option.id);
                                            props.onRequestClose();
                                        }}
                                    />
                                ))}
                            </ItemGroup>
                        ))}
                    </ItemListStatic>
                </View>
            ) : (
                <View style={[styles.body, styles.bodyDetailed]}>
                    <View style={styles.listPane}>
                        {sections.map((section) => (
                            <View key={section.id} style={styles.sectionBlock}>
                                {section.label ? (
                                    <Text style={styles.sectionTitle}>{section.label}</Text>
                                ) : null}
                                {section.options.map((option) => {
                                    const isFocused = focusedOption?.id === option.id;
                                    const isSelected = props.selectedOptionId === option.id;
                                    return (
                                        <Pressable
                                            key={option.id}
                                            testID={`agent-input-chip-picker.option:${option.id}`}
                                            accessibilityRole="button"
                                            onPress={() => setFocusedOptionId(option.id)}
                                            style={({ pressed }) => [
                                                styles.optionRow,
                                                isFocused ? styles.optionRowFocused : null,
                                                pressed ? styles.optionRowPressed : null,
                                                option.disabled ? styles.optionRowDisabled : null,
                                            ]}
                                        >
                                            <View style={styles.optionTextBlock}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.subtitle ? (
                                                    <Text style={styles.optionSubtitle}>{option.subtitle}</Text>
                                                ) : null}
                                            </View>
                                            {isSelected ? (
                                                <Ionicons name="checkmark" size={18} color={theme.colors.status.connected} />
                                            ) : null}
                                        </Pressable>
                                    );
                                })}
                            </View>
                        ))}
                    </View>
                    {focusedOption ? (
                        <DetailPane
                            option={focusedOption}
                            onApply={() => {
                                if (focusedOption.disabled) return;
                                props.onSelect(focusedOption.id);
                                props.onRequestClose();
                            }}
                            applyLabel={props.applyLabel ?? t('common.use')}
                        />
                    ) : null}
                </View>
            )}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 720,
        borderRadius: 24,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 18,
        ...Typography.header(),
        color: theme.colors.text,
    },
    body: {
        padding: 16,
    },
    bodyDetailed: {
        flexDirection: 'row',
        gap: 16,
        alignItems: 'stretch',
    },
    listPane: {
        width: 260,
        maxWidth: '42%',
        paddingRight: 4,
    },
    detailPane: {
        flex: 1,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 18,
        padding: 18,
        gap: 12,
        backgroundColor: theme.colors.surface,
    },
    detailHeader: {
        gap: 4,
    },
    detailTitle: {
        fontSize: 18,
        ...Typography.header(),
        color: theme.colors.text,
    },
    detailSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    detailDescription: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
    },
    detailBullets: {
        gap: 8,
    },
    detailBulletRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    detailBulletDot: {
        width: 6,
        height: 6,
        marginTop: 7,
        borderRadius: 999,
        backgroundColor: theme.colors.textSecondary,
    },
    detailBulletText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
    detailActionButton: {
        minHeight: 42,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
    },
    detailActionButtonPressed: {
        opacity: 0.82,
    },
    detailActionButtonText: {
        color: theme.colors.text,
        ...Typography.header(),
        fontSize: 14,
    },
    applyButton: {
        marginTop: 'auto',
        minHeight: 42,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 14,
    },
    applyButtonPressed: {
        opacity: 0.82,
    },
    applyButtonDisabled: {
        opacity: 0.5,
    },
    applyButtonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.header(),
        fontSize: 14,
    },
    sectionBlock: {
        gap: 8,
        marginBottom: 16,
    },
    sectionTitle: {
        paddingHorizontal: 6,
        fontSize: 12,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        ...Typography.header(),
    },
    optionRow: {
        minHeight: 52,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    optionRowFocused: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.groupped.background,
    },
    optionRowPressed: {
        opacity: 0.82,
    },
    optionRowDisabled: {
        opacity: 0.45,
    },
    optionTextBlock: {
        flex: 1,
        gap: 2,
    },
    optionLabel: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    optionSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));

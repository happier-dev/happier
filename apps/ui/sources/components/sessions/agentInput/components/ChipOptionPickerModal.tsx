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
import type { CustomModalInjectedProps } from '@/modal';

export type ChipOptionPickerModalOption = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
}>;

export type ChipOptionPickerModalProps = Readonly<CustomModalInjectedProps & {
    title: string;
    options: ReadonlyArray<ChipOptionPickerModalOption>;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
}>;

export function ChipOptionPickerModal(props: ChipOptionPickerModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{props.title}</Text>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <ItemListStatic style={{ backgroundColor: 'transparent' }}>
                    <ItemGroup title="">
                        {props.options.map((option, index) => (
                            <Item
                                key={option.id}
                                title={option.label}
                                subtitle={option.subtitle}
                                selected={props.selectedOptionId === option.id}
                                showChevron={false}
                                showDivider={index < props.options.length - 1}
                                onPress={() => {
                                    props.onSelect(option.id);
                                    props.onClose();
                                }}
                            />
                        ))}
                    </ItemGroup>
                </ItemListStatic>

                <View style={styles.footer}>
                    <Pressable
                        onPress={props.onClose}
                        style={({ pressed }) => ({
                            backgroundColor: theme.colors.surface,
                            borderRadius: 10,
                            paddingVertical: 12,
                            alignItems: 'center',
                            opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    footer: {
        marginTop: 8,
    },
    cancelText: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

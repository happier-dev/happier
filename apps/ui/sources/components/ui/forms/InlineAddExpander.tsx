import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { StyleProp, ViewStyle } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { SplitActionButtons } from '@/components/ui/forms/SplitActionButtons';


export interface InlineAddExpanderProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    triggerTestID?: string;

    title: string;
    subtitle?: string;
    icon?: React.ReactNode;

    helpText?: string;
    children: React.ReactNode;

    onCancel: () => void;
    onSave: () => void;
    saveDisabled?: boolean;

    cancelLabel: string;
    saveLabel: string;

    autoFocusRef?: React.RefObject<React.ElementRef<typeof TextInput> | null>;
    expandedContainerStyle?: StyleProp<ViewStyle>;
}

export function InlineAddExpander({
    isOpen,
    onOpenChange,
    triggerTestID,
    title,
    subtitle,
    icon,
    helpText,
    children,
    onCancel,
    onSave,
    saveDisabled = false,
    cancelLabel,
    saveLabel,
    autoFocusRef,
    expandedContainerStyle,
}: InlineAddExpanderProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    React.useEffect(() => {
        if (!isOpen) return;
        if (!autoFocusRef?.current) return;
        const id = setTimeout(() => autoFocusRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, [autoFocusRef, isOpen]);

    return (
        <>
            <Item
                testID={triggerTestID}
                title={title}
                subtitle={subtitle}
                icon={icon}
                onPress={() => onOpenChange(!isOpen)}
                showChevron={false}
                showDivider={Boolean(isOpen)}
            />

            {isOpen ? (
                <View style={[styles.expandedContainer, expandedContainerStyle]}>
                    {helpText ? (
                        <Text style={styles.helpText}>
                            {helpText}
                        </Text>
                    ) : null}

                    {children}

                    <View style={{ height: 16 }} />

                    <SplitActionButtons
                        secondaryLabel={cancelLabel}
                        onSecondaryPress={onCancel}
                        primaryLabel={saveLabel}
                        onPrimaryPress={onSave}
                        primaryDisabled={saveDisabled}
                    />
                </View>
            ) : null}
        </>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    expandedContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    helpText: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 12,
        ...Typography.default(),
    },
}));

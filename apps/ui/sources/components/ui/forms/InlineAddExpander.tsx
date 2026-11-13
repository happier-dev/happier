import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { StyleProp, ViewStyle } from 'react-native';

import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';


export interface InlineAddExpanderProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    triggerTestID?: string;

    title: string;
    /** A section can host the trigger itself; null leaves just the inline form. */
    trigger?: React.ReactNode;
    subtitle?: string;

    helpText?: string;
    children: React.ReactNode;

    onCancel: () => void;
    onSave: () => void;
    saveDisabled?: boolean;
    /** The save is in flight: the save button shows it working until the owner settles. */
    saving?: boolean;

    cancelLabel: string;
    saveLabel: string;
    cancelTestID?: string;
    saveTestID?: string;
    /** Further secondary operations on the form's value (Clear), between Save and Cancel. */
    extraActions?: React.ReactNode;

    autoFocusRef?: React.RefObject<React.ElementRef<typeof TextInput> | null>;
    expandedContainerStyle?: StyleProp<ViewStyle>;
}

export function InlineAddExpander({
    isOpen,
    onOpenChange,
    triggerTestID,
    title,
    trigger,
    subtitle,
    helpText,
    children,
    onCancel,
    onSave,
    saveDisabled = false,
    saving = false,
    cancelLabel,
    saveLabel,
    cancelTestID,
    saveTestID,
    extraActions,
    autoFocusRef,
    expandedContainerStyle,
}: InlineAddExpanderProps) {
    const styles = stylesheet;

    React.useEffect(() => {
        if (!isOpen) return;
        if (!autoFocusRef?.current) return;
        const id = setTimeout(() => autoFocusRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, [autoFocusRef, isOpen]);

    return (
        <>
            {trigger !== undefined ? trigger : <ItemAddRow
                testID={triggerTestID}
                title={title}
                subtitle={subtitle}
                expanded={isOpen}
                onPress={() => onOpenChange(!isOpen)}
                showDivider={Boolean(isOpen)}
            />}

            {isOpen ? (
                <View style={[styles.expandedContainer, expandedContainerStyle]}>
                    {helpText ? (
                        <Text accessibilityLiveRegion="polite" style={styles.helpText}>
                            {helpText}
                        </Text>
                    ) : null}

                    {children}

                    {/* A form's one primary, then a quiet Cancel: the shared action row and button family. */}
                    <View style={styles.actions}>
                        <RoundButtonSizeScope size="normal" presentation="uniform">
                            <SectionButtonRow>
                                <RoundButton testID={saveTestID} title={saveLabel} accessibilityLabel={saveLabel} onPress={onSave} disabled={saveDisabled} loading={saving} />
                                {extraActions}
                                <RoundButton testID={cancelTestID} display="secondary" title={cancelLabel} accessibilityLabel={cancelLabel} onPress={onCancel} />
                            </SectionButtonRow>
                        </RoundButtonSizeScope>
                    </View>
                </View>
            ) : null}
        </>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    expandedContainer: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    actions: {
        marginTop: theme.space.s16,
    },
    helpText: {
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s12,
        ...Typography.variant('body'),
    },
}));

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
                        <InlineFormActions saveLabel={saveLabel} cancelLabel={cancelLabel} onSave={onSave} onCancel={onCancel}
                            saveDisabled={saveDisabled} saving={saving} saveTestID={saveTestID} cancelTestID={cancelTestID}
                            extraActions={extraActions} />
                    </View>
                </View>
            ) : null}
        </>
    );
}


/**
 * A form's one primary, then a quiet Cancel, on the section's start edge (patterns "Forms inside pages"): the inline
 * add form's own row, and the row a form of sheet rows ends with after its sheet (Settings › Migrations, registries).
 */
export function InlineFormActions(props: Readonly<{
    saveLabel: string;
    cancelLabel: string;
    onSave: () => void;
    onCancel: () => void;
    saveDisabled?: boolean;
    saving?: boolean;
    saveTestID?: string;
    cancelTestID?: string;
    extraActions?: React.ReactNode;
}>) {
    return (
        <RoundButtonSizeScope size="normal" presentation="uniform">
            <SectionButtonRow>
                <RoundButton testID={props.saveTestID} title={props.saveLabel} accessibilityLabel={props.saveLabel} onPress={props.onSave}
                    disabled={props.saveDisabled === true} loading={props.saving === true} />
                {props.extraActions}
                <RoundButton testID={props.cancelTestID} display="secondary" title={props.cancelLabel} accessibilityLabel={props.cancelLabel}
                    onPress={props.onCancel} />
            </SectionButtonRow>
        </RoundButtonSizeScope>
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

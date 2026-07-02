import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { TranscriptSelectableMessageRole } from './_types';
import { formatMessageSelectionRowAccessibilityLabel } from './messageSelectionAccessibility';
import { useOptionalTranscriptSelectionRow } from './TranscriptMessageSelectionContext';

export function MessageSelectionCheckbox(props: Readonly<{
    messageId: string;
    role: TranscriptSelectableMessageRole;
    previewText: string;
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const row = useOptionalTranscriptSelectionRow(props.messageId);
    if (!row.isSelectionMode) return null;

    const accessibilityLabel = formatMessageSelectionRowAccessibilityLabel({
        role: props.role,
        previewText: props.previewText,
    });

    return (
        <Pressable
            testID={props.testID}
            onPress={row.toggle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: row.isSelected }}
            accessibilityLabel={accessibilityLabel}
            hitSlop={10}
            style={({ pressed }) => [
                styles.checkbox,
                row.isSelected ? styles.checkboxSelected : null,
                pressed ? styles.checkboxPressed : null,
            ]}
        >
            <Ionicons
                name={row.isSelected ? 'checkbox-outline' : 'square-outline'}
                size={18}
                color={row.isSelected ? theme.colors.state.active.foreground : theme.colors.text.secondary}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    checkbox: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 32,
        minWidth: 32,
        borderRadius: 16,
        marginRight: 6,
        backgroundColor: theme.colors.surface.base,
    },
    checkboxSelected: {
        backgroundColor: theme.colors.state.active.background,
    },
    checkboxPressed: {
        backgroundColor: theme.colors.state.neutral.background,
    },
}));

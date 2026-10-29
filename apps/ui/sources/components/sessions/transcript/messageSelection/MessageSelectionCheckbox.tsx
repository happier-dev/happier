import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { TranscriptSelectableMessageRole } from './_types';
import { formatMessageSelectionRowAccessibilityLabel } from './messageSelectionAccessibility';
import { useOptionalTranscriptSelectionRow } from './TranscriptMessageSelectionContext';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
        <HappierPressable
            testID={props.testID}
            onPress={row.toggle}
            accessibilityRole="checkbox"
            checked={row.isSelected}
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [
                styles.checkbox,
                row.isSelected ? styles.checkboxSelected : null,
                pressed ? styles.checkboxPressed : null,
            ]}
        >
            <Icon
                name={row.isSelected ? 'check-square' : 'square'}
                size={16}
                color={row.isSelected ? theme.colors.state.active.foreground : theme.colors.text.secondary}
            />
        </HappierPressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    checkbox: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 32,
        minWidth: 32,
        borderRadius: 16,
        marginRight: theme.space.s6,
        backgroundColor: theme.colors.surface.base,
    },
    checkboxSelected: {
        backgroundColor: theme.colors.state.active.background,
    },
    checkboxPressed: {
        backgroundColor: theme.colors.state.neutral.background,
    },
}));

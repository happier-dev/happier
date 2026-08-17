import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';

import type { TranscriptSelectableMessageRole } from './_types';
import { formatMessageSelectionRowAccessibilityLabel } from './messageSelectionAccessibility';
import { useOptionalTranscriptSelectionActions, useOptionalTranscriptSelectionRow } from './TranscriptMessageSelectionContext';
import { Icon } from '@/components/ui/icons/Icon';

const TRANSCRIPT_SELECT_ACTION_ICON_SIZE = 12;
const TRANSCRIPT_SELECT_MODE_ICON_SIZE = 18;

export function SelectMessageButton(props: Readonly<{
    messageId: string;
    enabled: boolean;
    visible: boolean;
    role?: TranscriptSelectableMessageRole;
    previewText?: string;
    testID?: string;
    invertedActionsLayout?: boolean;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const actions = useOptionalTranscriptSelectionActions();
    const row = useOptionalTranscriptSelectionRow(props.messageId);
    const visible = props.visible || row.isSelectionMode;

    if (!actions || !props.enabled || !visible) return null;

    const isSelectionToggle = row.isSelectionMode;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const iconName = isSelectionToggle
        ? (row.isSelected ? 'check-square' : 'square')
        : 'check-circle';
    const iconColor = row.isSelected ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const accessibilityLabel = isSelectionToggle && props.role && props.previewText != null
        ? formatMessageSelectionRowAccessibilityLabel({ role: props.role, previewText: props.previewText })
        : t('transcript.selection.enterA11y');

    return (
        <Pressable
            testID={props.testID}
            onPress={isSelectionToggle ? row.toggle : () => actions.enter(props.messageId)}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            accessibilityRole={isSelectionToggle ? 'checkbox' : 'button'}
            accessibilityState={isSelectionToggle ? { checked: row.isSelected } : undefined}
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [
                styles.button,
                Platform.OS === 'web' ? styles.webActionButton : null,
                props.invertedActionsLayout ? styles.webActionButtonInverted : null,
                isSelectionToggle ? styles.selectionToggleButton : null,
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: minimumInteractiveTargetSize,
                    minWidth: minimumInteractiveTargetSize,
                },
                row.isSelected ? styles.buttonSelected : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            <Icon
                name={iconName}
                size={isSelectionToggle ? TRANSCRIPT_SELECT_MODE_ICON_SIZE : TRANSCRIPT_SELECT_ACTION_ICON_SIZE}
                color={iconColor}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    button: {
        padding: 2,
        borderRadius: 6,
        opacity: 0.6,
        cursor: 'pointer',
        marginRight: 6,
    },
    webActionButton: {
        padding: 6,
    },
    webActionButtonInverted: {
        paddingHorizontal: 4,
        marginRight: 2,
    },
    selectionToggleButton: {
        padding: 6,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.base,
    },
    buttonSelected: {
        opacity: 1,
        backgroundColor: theme.colors.state.active.background,
    },
    buttonPressed: {
        opacity: 1,
        backgroundColor: theme.colors.state.neutral.background,
    },
}));

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

import type { TranscriptSelectableMessageRole } from './_types';
import { formatMessageSelectionRowAccessibilityLabel } from './messageSelectionAccessibility';
import { useOptionalTranscriptSelectionActions, useOptionalTranscriptSelectionRow } from './TranscriptMessageSelectionContext';
import { MessageActionIconButton } from '../messageActions/MessageActionIconButton';

/**
 * Select, in a message's action row: it enters selection with this message chosen, and while selecting it
 * toggles the message. It is the row's one glyph control (`MessageActionIconButton`), at the row's size in
 * both states; selection shows in the glyph and its ink, never in a bigger box.
 */
export function SelectMessageButton(props: Readonly<{
    messageId: string;
    enabled: boolean;
    visible: boolean;
    role?: TranscriptSelectableMessageRole;
    previewText?: string;
    /** Whose message this is, where every message repeats the action (a Discussion thread): "…, Mei". */
    ownerLabel?: string;
    testID: string;
    invertedActionsLayout?: boolean;
    onFocusChange?: (focused: boolean) => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const actions = useOptionalTranscriptSelectionActions();
    const row = useOptionalTranscriptSelectionRow(props.messageId);
    const visible = props.visible || row.isSelectionMode;

    if (!actions || !props.enabled || !visible) return null;

    const isSelectionToggle = row.isSelectionMode;
    const accessibilityLabel = isSelectionToggle && props.role && props.previewText != null
        ? formatMessageSelectionRowAccessibilityLabel({ role: props.role, previewText: props.previewText })
        : props.ownerLabel ? `${t('transcript.selection.enterA11y')}, ${props.ownerLabel}` : t('transcript.selection.enterA11y');

    return (
        <MessageActionIconButton
            testID={props.testID}
            icon={isSelectionToggle ? (row.isSelected ? 'check-square' : 'square') : 'check-circle'}
            stateColor={row.isSelected ? theme.colors.state.active.foreground : undefined}
            selected={row.isSelected}
            accessibilityRole={isSelectionToggle ? 'checkbox' : 'button'}
            checked={isSelectionToggle ? row.isSelected : undefined}
            accessibilityLabel={accessibilityLabel}
            invertedActionsLayout={props.invertedActionsLayout === true}
            onFocusChange={props.onFocusChange}
            onPress={isSelectionToggle ? row.toggle : () => actions.enter(props.messageId)}
        />
    );
}

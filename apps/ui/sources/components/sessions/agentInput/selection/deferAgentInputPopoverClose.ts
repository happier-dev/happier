import { Platform } from 'react-native';

export function deferAgentInputPopoverClose(onRequestClose: () => void) {
    if (Platform.OS === 'web') {
        // On web, closing a portaled popover synchronously from an option click can allow the
        // click event to "fall through" to underlying chip triggers after the popover unmounts.
        // Defer the close to the next task so the click fully resolves against the option row.
        setTimeout(() => onRequestClose(), 0);
        return;
    }

    onRequestClose();
}


import * as React from 'react';

import type { KeyboardCommandId } from './types';

export type KeyboardShortcutLabels = Partial<Record<KeyboardCommandId, string>>;

export const NO_KEYBOARD_SHORTCUT_LABELS: KeyboardShortcutLabels = {};

/** Provided by `KeyboardShortcutProvider`: each available command's key combination, as bound. */
export const KeyboardShortcutLabelsContext = React.createContext<KeyboardShortcutLabels>(NO_KEYBOARD_SHORTCUT_LABELS);

/**
 * The key combination that runs a command here, as the person has bound it (for a tooltip beside
 * the control that does the same thing), or undefined when nothing runs it.
 */
export function useKeyboardShortcutLabel(commandId: KeyboardCommandId | undefined): string | undefined {
    const labels = React.useContext(KeyboardShortcutLabelsContext);
    return commandId === undefined ? undefined : labels[commandId];
}

/** "Cmd+Shift+Enter" → ["Cmd", "Shift", "Enter"]; a literal "+" key stays one keycap. */
export function splitKeybindingLabel(label: string): readonly string[] {
    const parts = label.split('+');
    const keys: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === '' && index === parts.length - 1 && keys.length > 0) {
            keys[keys.length - 1] = '+';
            continue;
        }
        if (part !== '') keys.push(part);
    }
    return keys.length > 0 ? keys : [label];
}

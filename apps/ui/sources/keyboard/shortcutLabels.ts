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
    if (commandId === undefined) return undefined;
    return React.use(KeyboardShortcutLabelsContext)[commandId];
}

/** Mac modifier glyphs, written without separators ("⇧⌘2"). */
const MODIFIER_GLYPHS = new Set(['⌃', '⌥', '⇧', '⌘']);

/**
 * "Ctrl+Shift+Enter" → ["Ctrl", "Shift", "Enter"]; "Cmd+Shift+Enter" and "⇧⌘↵" → ["⇧", "⌘", …]: one keycap per key.
 * A literal "+" key stays one keycap.
 */
export function splitKeybindingLabel(label: string): readonly string[] {
    const parts = label.split('+');
    const keys: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === '') {
            if (index === parts.length - 1 && keys.length > 0) keys.push('+');
            continue;
        }
        let rest = part;
        while (rest.length > 1 && MODIFIER_GLYPHS.has(rest[0])) {
            keys.push(rest[0]);
            rest = rest.slice(1);
        }
        keys.push(rest);
    }
    return keys.length > 0 ? macModifierGlyphs(keys) : [label];
}

/** A Mac combination, written in words ("Cmd+Shift+Enter"), as the Mac keyboard prints it: ⇧ ⌘ Enter. */
const MAC_MODIFIER_WORDS: Readonly<Record<string, string>> = { Ctrl: '⌃', Option: '⌥', Shift: '⇧', Cmd: '⌘' };
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘'];

function macModifierGlyphs(keys: string[]): string[] {
    // Only a Mac label names Cmd or Option, so their presence is the platform; elsewhere the words stay.
    if (!keys.includes('Cmd') && !keys.includes('Option')) return keys;
    const modifiers = keys.filter((key) => key in MAC_MODIFIER_WORDS).map((key) => MAC_MODIFIER_WORDS[key]!);
    modifiers.sort((left, right) => MAC_MODIFIER_ORDER.indexOf(left) - MAC_MODIFIER_ORDER.indexOf(right));
    return [...modifiers, ...keys.filter((key) => !(key in MAC_MODIFIER_WORDS))];
}

const KEYCAP_GLYPHS: Readonly<Record<string, string>> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: '↵',
    Escape: 'Esc',
};

/** One keycap's face for a quiet hint row: arrows and Return as their glyphs ("ArrowDown" → "↓"). */
export function formatKeycapLabel(key: string): string {
    return KEYCAP_GLYPHS[key] ?? key;
}

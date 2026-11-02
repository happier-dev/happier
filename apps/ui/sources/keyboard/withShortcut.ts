/** Tooltip copy uses the effective binding supplied by the keyboard label owner. */
export function withShortcut(label: string, shortcut: string | undefined): string {
    return shortcut ? `${label} (${shortcut})` : label;
}

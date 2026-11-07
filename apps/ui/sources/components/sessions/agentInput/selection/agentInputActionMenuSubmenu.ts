import * as React from 'react';

/**
 * Set around a picker that a + menu row opened. The picker is that row's submenu: it opens beside the
 * row (the + menu stays open), a dismissal (Escape, Left, an outside press, the pointer leaving) returns
 * to the menu, and its surface reports the pointer to the menu's shared hover intent.
 */
export type AgentInputActionMenuSubmenu = Readonly<{
    /** The row that opened the picker: the picker's name (a phone sheet's band names the pushed view). */
    title?: string;
    returnToMenu: () => void;
    onSurfacePointerChange: (inside: boolean, event: unknown) => void;
}>;

export const AgentInputActionMenuSubmenuContext = React.createContext<AgentInputActionMenuSubmenu | null>(null);

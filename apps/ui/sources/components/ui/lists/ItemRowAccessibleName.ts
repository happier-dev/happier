import * as React from 'react';

/**
 * The accessible name the surrounding row already carries, lent to an accessory
 * control that has none of its own.
 *
 * A settings row is a title plus a control, and the title is the only thing that
 * names that control — but the control is its own accessibility element on every
 * platform, so the row's own label never reaches it. On web an `aria-label` on an
 * unroled container does not name a nested `role="switch"`; on native the row
 * `View` is not an accessibility element at all. Rather than make each call site
 * repeat its title as `accessibilityLabel`, the row publishes its name here and
 * the control falls back to it.
 *
 * An explicit name on the control always wins — this is a fallback, not an
 * override, so a control that needs to say something other than the row title
 * still can.
 */
const ItemRowAccessibleNameContext = React.createContext<string | undefined>(undefined);

export const ItemRowAccessibleNameProvider = ItemRowAccessibleNameContext.Provider;

export function useItemRowAccessibleName(): string | undefined {
    return React.useContext(ItemRowAccessibleNameContext);
}

/**
 * A switch row (owner ruling 2026-10-12): tapping anywhere on a row whose accessory is a switch toggles
 * that switch. The row becomes the one `switch` control (named by its title, checked by the value,
 * Space/Enter, focus ring on the row); the switch inside draws only, so a press is never counted twice.
 * Switch components opt in with {@link ITEM_ROW_SWITCH}; a row that navigates keeps its own press.
 */
export const ITEM_ROW_SWITCH = Symbol.for('happier.ui.itemRowSwitch');

export type ItemRowSwitch = Readonly<{ value: boolean; disabled: boolean; label?: string; onValueChange?: (value: boolean) => unknown }>;

export function readItemRowSwitch(node: React.ReactNode): ItemRowSwitch | null {
    if (!React.isValidElement(node)) return null;
    const type = node.type as unknown as Record<symbol, unknown> | null;
    if (!type || type[ITEM_ROW_SWITCH] !== true) return null;
    const props = node.props as Readonly<{ value?: boolean; disabled?: boolean | null; onValueChange?: ((value: boolean) => unknown) | null; accessibilityLabel?: string; 'aria-label'?: string }>;
    return {
        value: props.value === true,
        disabled: props.disabled === true,
        // An explicit name on the switch still names the control (now the row).
        label: props.accessibilityLabel ?? props['aria-label'],
        onValueChange: props.onValueChange ?? undefined,
    };
}

const ItemRowOwnsSwitchContext = React.createContext(false);

export const ItemRowOwnsSwitchProvider = ItemRowOwnsSwitchContext.Provider;

/** True inside a switch row: the switch draws its state but is not a control of its own. */
export function useItemRowOwnsSwitch(): boolean {
    return React.useContext(ItemRowOwnsSwitchContext);
}

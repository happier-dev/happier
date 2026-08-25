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

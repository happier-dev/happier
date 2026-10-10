import * as React from 'react';

import type { ItemAction } from '@/components/ui/lists/itemActions';

/**
 * Menu projection only: a mounted body lends the entries that act on what it shows ("Ask an agent
 * about this", "Copy query") to its nearest shared frame's ⋯, in the surface's own group. The frame
 * still owns the menu and its order; a body never renders a second menu.
 */
export const WidgetFrameBodyActionsContext = React.createContext<
  ((actions: readonly ItemAction[] | null) => void) | null
>(null);

/** Pass an identity-stable list: a new array re-lends it. */
export function useWidgetFrameBodyActions(actions: readonly ItemAction[] | null): void {
  const lend = React.useContext(WidgetFrameBodyActionsContext);
  React.useEffect(() => {
    lend?.(actions);
    return () => lend?.(null);
  }, [actions, lend]);
}

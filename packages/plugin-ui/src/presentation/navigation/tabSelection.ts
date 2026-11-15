import { startTransition, useCallback, useRef, useState } from 'react';

import { isHappierTabSelected } from './Tabs.js';

/**
 * The selection a tab bar shows, and the press that changes it.
 *
 * A tab bar is controlled: its owner (a route, a pane, the workspace, a setting) decides what is selected, and showing
 * the new tab can mount or re-render that owner's whole surface. On the web that work ran in the same task as the press,
 * so the browser could not paint the chosen tab until the new surface had rendered (0.5–1.8 s measured on a busy
 * Account): the tap looked ignored and people tapped again (P03-TAB-SWITCH).
 *
 * The press commits at once: the owner's `onValueChange` runs synchronously, so a value choice is current for whatever
 * the person does next (Save, Send) and a guard or Action sees the same press (UI refinements ruling 2026-11-15 08:53Z).
 * Only the work it causes defers: the owner runs inside a transition, so React paints the pressed tab first and builds
 * the owner's new surface after, and a later press supersedes a surface still being built. The owner stays the
 * authority: the shown choice gives way as soon as the owner's value reaches it, and returns to the owner's value when
 * the owner settles without taking it (an unsaved-changes guard, a refused Action).
 */
export function useHappierTabSelection<T extends string>(
  value: T,
  onValueChange: (value: T) => unknown,
): readonly [selected: T, select: (value: T) => void] {
  const [pending, setPending] = useState<Readonly<{ value: T; token: number }> | null>(null);
  // The owner caught up: its value is now the selection, so the pending choice has nothing left to show.
  if (pending !== null && isHappierTabSelected(value, pending.value)) setPending(null);
  const latest = useRef(onValueChange);
  latest.current = onValueChange;
  const tokens = useRef(0);

  const select = useCallback((next: T) => {
    const token = ++tokens.current;
    const settle = () => setPending((current) => (current?.token === token ? null : current));
    setPending({ value: next, token });
    try {
      startTransition(() => {
        const result: unknown = latest.current(next);
        if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
          (result as PromiseLike<unknown>).then(settle, settle);
          return;
        }
        // Settles with the owner's own update, so the pressed tab stays shown until the owner's choice is drawn.
        settle();
      });
    } catch (error) {
      settle();
      throw error;
    }
  }, []);

  return [pending?.value ?? value, select] as const;
}

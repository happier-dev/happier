import { useCallback, useRef, useState } from 'react';

/** What closing the field hands focus back to: the magnifier that opened it. */
export type HappierSearchDisclosureToggle = Readonly<{ focus?: () => void }>;

export type HappierSearchDisclosure = Readonly<{
  open: boolean;
  /** The field was opened by a press and is still empty: it takes focus. A restored query never steals it. */
  focusOnOpen: boolean;
  toggle: () => void;
  close: () => void;
  /** Escape in the field closes it, as the magnifier does. */
  onKeyPress: (
    event: Readonly<{ nativeEvent?: Readonly<{ key?: string }> }>,
  ) => void;
  toggleRef: (instance: HappierSearchDisclosureToggle | null) => void;
}>;

/**
 * A search behind a magnifier, the one rule for every main screen's head (core's `MainScreenHeader`, a phone
 * collection page's large title, a collapsible collection list): closed until pressed; a query keeps it open. The
 * magnifier again, the field's close or Escape clears the query (`clear`), folds the field away and hands focus back
 * to the magnifier. Without `clear` (a caller that never collapses) the query is left as it is.
 */
export function useHappierSearchDisclosure(
  value: string,
  clear: (() => void) | undefined,
): HappierSearchDisclosure {
  const [opened, setOpened] = useState(false);
  const open = opened || value.length > 0;
  const toggleInstance = useRef<HappierSearchDisclosureToggle | null>(null);
  const toggleRef = useCallback(
    (instance: HappierSearchDisclosureToggle | null) => {
      toggleInstance.current = instance;
    },
    [],
  );
  const close = useCallback(() => {
    clear?.();
    setOpened(false);
    // The field that held focus is gone: hand focus back to the control that opened it.
    toggleInstance.current?.focus?.();
  }, [clear]);
  const toggle = useCallback(() => {
    if (open) close();
    else setOpened(true);
  }, [close, open]);
  const onKeyPress = useCallback(
    (event: Readonly<{ nativeEvent?: Readonly<{ key?: string }> }>) => {
      if (event.nativeEvent?.key === 'Escape') close();
    },
    [close],
  );
  return {
    open,
    focusOnOpen: opened && value.length === 0,
    toggle,
    close,
    onKeyPress,
    toggleRef,
  };
}

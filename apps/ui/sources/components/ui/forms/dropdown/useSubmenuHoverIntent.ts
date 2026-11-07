import * as React from 'react';

/**
 * Submenu hover intent (pointer only; touch opens on tap). A row must hold the pointer this long before
 * its submenu opens, so passing over it toward another item opens nothing.
 */
const SUBMENU_HOVER_OPEN_DELAY_MS = 150;
/**
 * How long an open submenu survives the pointer leaving it or crossing a sibling row: long enough for
 * diagonal travel from the parent row into the submenu, short enough to read as a response.
 */
const SUBMENU_HOVER_CLOSE_GRACE_MS = 300;

/** The space between a menu and the submenu that opens beside it. */
export const SUBMENU_POPOVER_GAP_PX = 4;

export function isTouchPointerEvent(event: unknown): boolean {
  const value = event as {
    nativeEvent?: { pointerType?: unknown };
    pointerType?: unknown;
  } | null;
  return (value?.nativeEvent?.pointerType ?? value?.pointerType) === 'touch';
}

export type SubmenuHoverIntent = Readonly<{
  /**
   * The pointer rests on a row: `open` opens that row's submenu after a dwell; a row without one
   * (`null`) closes another open submenu after the grace period.
   */
  hoverItem: (itemId: string, open: (() => void) | null) => void;
  /** The pointer left a menu for anywhere but its open submenu: that submenu closes after the grace. */
  scheduleClose: (event?: unknown) => void;
  /** Pointer presence on the open submenu's own surface: entering cancels a pending close or switch. */
  surfacePointerChange: (inside: boolean, event: unknown) => void;
  clear: () => void;
}>;

/**
 * The one owner of submenu hover intent, for every menu that opens a submenu beside its row (the
 * shared dropdown and the composer's + menu). Entering the open submenu cancels a pending close or
 * switch, which lets diagonal travel from the parent row reach it.
 */
export function useSubmenuHoverIntent(
  params: Readonly<{
    /** The row whose submenu is open now, if any. */
    activeItemId: string | null;
    /** The parent menu is open; closing it drops any pending intent. */
    enabled: boolean;
    closeSubmenu: () => void;
  }>,
): SubmenuHoverIntent {
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingHoverIdRef = React.useRef<string | null>(null);
  const activeItemIdRef = React.useRef<string | null>(null);
  activeItemIdRef.current = params.activeItemId;
  const closeSubmenuRef = React.useRef(params.closeSubmenu);
  closeSubmenuRef.current = params.closeSubmenu;

  const clear = React.useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    pendingHoverIdRef.current = null;
  }, []);
  React.useEffect(() => clear, [clear]);
  React.useEffect(() => {
    if (!params.enabled) clear();
  }, [clear, params.enabled]);

  const scheduleClose = React.useCallback(
    (event?: unknown) => {
      if (event !== undefined && isTouchPointerEvent(event)) return;
      clear();
      if (!activeItemIdRef.current) return;
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        closeSubmenuRef.current();
      }, SUBMENU_HOVER_CLOSE_GRACE_MS);
    },
    [clear],
  );

  const hoverItem = React.useCallback(
    (itemId: string, open: (() => void) | null) => {
      if (pendingHoverIdRef.current === itemId) return;
      if (activeItemIdRef.current === itemId) {
        clear();
        return;
      }
      clear();
      pendingHoverIdRef.current = itemId;
      if (!open && !activeItemIdRef.current) {
        pendingHoverIdRef.current = null;
        return;
      }
      // Switching from an open submenu waits the grace period, so crossing a row on the way in is harmless.
      const delay = activeItemIdRef.current
        ? SUBMENU_HOVER_CLOSE_GRACE_MS
        : SUBMENU_HOVER_OPEN_DELAY_MS;
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        pendingHoverIdRef.current = null;
        if (open) open();
        else closeSubmenuRef.current();
      }, delay);
    },
    [clear],
  );

  const surfacePointerChange = React.useCallback(
    (inside: boolean, event: unknown) => {
      if (isTouchPointerEvent(event)) return;
      if (inside) clear();
      else scheduleClose();
    },
    [clear, scheduleClose],
  );

  return React.useMemo(
    () => ({ hoverItem, scheduleClose, surfacePointerChange, clear }),
    [clear, hoverItem, scheduleClose, surfacePointerChange],
  );
}

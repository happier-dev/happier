import { createContext, useContext } from 'react';

/**
 * Content on a floating surface (a popover, a menu or its phone sheet). A page section drawn there is not a page's:
 * it takes no section gap above it and no page sheet inset beside it, so its rows sit on the surface like a menu's
 * (the app's `FloatingListSurfaceContext` rule; DBW Console History band, 2026-11-18).
 */
export const HappierFloatingSurfaceContext = createContext(false);

export function useHappierFloatingSurface(): boolean {
  return useContext(HappierFloatingSurfaceContext);
}

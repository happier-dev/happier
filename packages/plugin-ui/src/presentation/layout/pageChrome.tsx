import { createContext, useContext, type ReactNode } from 'react';

import type { HappierPageHeaderBackRender } from './PageHeader.js';

/**
 * The navigation chrome a page is mounted in, as page-anatomy facts: whether
 * the chrome already shows the page title (a native stack header on phones),
 * the back control it hands the page header, and the content column the page
 * is laid out in.
 *
 * Happier core's own pages read these from their navigation owners directly;
 * a same-realm host installs them around a mounted plugin page so the public
 * `PageHeader` and page sections behave exactly as core's do. Absent (a
 * hosted-web frame, the author fixture), the page shows its title, has no back
 * control and fills its pane.
 */
export type HappierPageChrome = Readonly<{
  showsTitle: boolean;
  renderBack?: HappierPageHeaderBackRender | null;
  columnMaxWidthPx?: number;
}>;

/** Same-realm host binding only; not part of the public page-chrome contract. */
export type HappierPageChromeInternal = HappierPageChrome & Readonly<{
  renderNavigationActions?: (actions: ReactNode) => ReactNode;
}>;

const HappierPageChromeContext = createContext<HappierPageChromeInternal | null>(null);

/** @internal The surface bridge re-provides this across the host's details pane (`components/surfaceBridge.tsx`). */
export const HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL = HappierPageChromeContext;

export function HappierPageChromeProvider(props: Readonly<{ chrome: HappierPageChrome; children?: ReactNode }>) {
  return <HappierPageChromeContext.Provider value={props.chrome}>{props.children}</HappierPageChromeContext.Provider>;
}

export function useHappierPageChrome(): HappierPageChrome | null {
  return useContext(HappierPageChromeContext);
}

/** @internal Public adapters delegate navigation placement to the incumbent host owner. */
export function useHappierPageChromeInternal(): HappierPageChromeInternal | null {
  return useContext(HappierPageChromeContext);
}

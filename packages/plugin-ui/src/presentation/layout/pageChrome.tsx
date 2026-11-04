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

/** Where a page header's actions live under navigation chrome that shows the title. */
export type HappierPageActionsPlacement = 'navigation' | 'page';

/** Same-realm host binding only; not part of the public page-chrome contract. */
export type HappierPageChromeInternal = HappierPageChrome & Readonly<{
  /**
   * The host's controls for this page's header row (its route controls, its pane's Hide) joined to the page's
   * own actions. `navigation` (the default) lets the host hoist them into navigation chrome that shows the title;
   * `page` keeps them in the page header row, as an entity header keeps its actions by its identity.
   */
  renderNavigationActions?: (actions: ReactNode, placement?: HappierPageActionsPlacement) => ReactNode;
  /**
   * The navigation's own Back is showing and would return the page to a step it declared rather than leave it,
   * so a pushed detail draws no Back of its own beside it.
   */
  navigationBackSpendsStep?: boolean;
  /**
   * Hands the page title to navigation chrome that shows it (a phone's stack header), as Happier's own
   * `PageHeader` does; the page header then omits its title. `undefined` withdraws it.
   */
  publishTitle?: (title: string | undefined) => void;
  /**
   * The navigation chrome leaves the page's name to the page, drawn as its large title under the navigation row:
   * a phone's top-level collection page, as core's Inbox tab (lab `phone-P4`). A `Collection` that is the page
   * (it carries `title`) leads with it above its toolbar.
   */
  largeTitle?: boolean;
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

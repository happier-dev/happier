import { createContext, type ReactNode } from 'react';

/**
 * @internal What leads a page above its tabs, and its tab row, offered by `HappierTabs` to the selected panel's
 * primary scroll area: drawn there they scroll as one page, the lead away under the band and the tab row pinned
 * at the top. `claim` reports that a scroll area draws them, so the Tabs do not draw them above the panel too;
 * a panel with no scroll area of its own (a bounded chat) leaves them to the Tabs.
 */
export type HappierScrollHeadInternal = Readonly<{
  lead: ReactNode;
  strip: ReactNode;
  /** The selected tab: a switch while the row is pinned brings the new panel in at its top, under the row. */
  selection: string;
  claim: () => () => void;
}>;

export const HappierScrollHeadContextInternal =
  createContext<HappierScrollHeadInternal | null>(null);

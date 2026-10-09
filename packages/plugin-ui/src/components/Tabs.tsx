import type { ReactElement, ReactNode } from 'react';

import {
  HappierTabs,
  useHappierTabPanelActivity,
  type HappierTabPanelActivity,
  type HappierTabRetention,
} from '../presentation/navigation/Tabs.js';
import { usePluginTheme } from './PluginUiProvider.js';
import type { TextTone } from './Text.js';

/** The enclosing panel's current active interval. See {@link useTabPanelActivity}. */
export type TabPanelActivity = HappierTabPanelActivity;

/**
 * Read the enclosing tab panel's active interval.
 *
 * `activeSignal` ends when the panel is left — including a retained panel whose
 * subtree stays mounted — so a live read, reveal or completion delivery stops
 * without the panel discarding its parsed state. Returning opens the next
 * interval with a new signal.
 */
export function useTabPanelActivity(): TabPanelActivity {
  return useHappierTabPanelActivity();
}

export type TabsItemProps = Readonly<{
  value: string;
  title: string;
  /** Decorative or independently-labelled leading content for the tab trigger. */
  icon?: ReactNode;
  badge?: string;
  /** The badge's tone: quiet by default; a count that is itself a state ("2 failing") takes that state's tone. */
  badgeTone?: TextTone;
  disabled?: boolean;
  /**
   * Whether leaving this tab keeps its panel mounted.
   *
   * Omission and `discard` both unmount the panel and end its active interval;
   * `retain` keeps a visited panel's subtree and parsed state while its
   * interval ends. A retained panel must consume {@link useTabPanelActivity}.
   */
  retention?: HappierTabRetention;
  children?: ReactNode;
}>;

function TabsItem(_props: TabsItemProps): null {
  return null;
}

export type TabsProps = Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  testID?: string;
  /**
   * `host` when an enclosing frame already draws the tab strip for this
   * surface: only the selected panel is visible, with the same retention and
   * active-interval rules as a shown strip.
   */
  tabList?: 'shown' | 'host';
  /**
   * `fill` gives the tab root and the active panel the parent's remaining
   * height, for panels that host a bounded view such as `SessionChat` or a
   * self-scrolling panel. The default `content` sizes to the panel, which is
   * right inside a scroll area.
   */
  layout?: 'content' | 'fill';
  /**
   * One stateful renderer shared by the tabs, instead of per-item children.
   * The caller supplies the selected panel to that renderer; changing tabs
   * updates its label without remounting it. Nested Tabs own panel activity.
   */
  sharedPanel?: ReactNode;
  children?: ReactNode;
}>;

function TabsRoot(props: TabsProps): ReactElement {
  return <HappierTabs {...props} theme={usePluginTheme()} />;
}

export const Tabs = Object.assign(TabsRoot, { Item: TabsItem });

import { createContext, type MutableRefObject, type ReactNode } from 'react';

import type { HappierStyleProp } from '../presentation/portableTypes.js';

/**
 * @internal What the Collection (`Collection.tsx`) asks of the virtualized List engine it presents through. The
 * List owns virtualization, physical focus and row/menu/selection semantics. Collection supplies its logical
 * cursor, navigation and viewport; a standalone List retains its own cursor. Package-private, not author API.
 */
export type ListCollectionControl = Readonly<{
  /**
   * A key pressed on the focused row, offered before collection navigation. Returning `true` claims it (the
   * table's Space peek), so the row's own activation never sees it.
   */
  onRowKey?: (key: string, itemKey: string) => boolean;
  /** Collection owns logical focus; List still reveals and binds physical virtualized rows. */
  focus?: Readonly<{
    key: string | null;
    tabStopKey: string | null;
    request: Readonly<{ key: string }> | null;
    onRequestHandled?: (request: Readonly<{ key: string }>) => void;
    onKey?(key: string, itemKey: string, event: unknown): boolean;
  }>;
  /** A column must not narrow the shared selection inventory to its own mounted rows. */
  ownsSelectionRows?: boolean;
  hideChrome?: boolean;
  /** Board columns are groups inside the Collection's one radio group. */
  collectionRole?: 'group';
  /** The scroll offset as the scroller reports it, and one scroll request (a new object is a new request). */
  scroll?: Readonly<{
    offsetRef: MutableRefObject<number>;
    request: Readonly<{ offset: number }> | null;
  }>;
  /** Group headers at the presentation's exact height, and the type role their words take. */
  sectionHeaderStyle?: HappierStyleProp;
  sectionHeaderTitleRole?: 'label' | 'caption' | 'section';
  /** Wraps a group header cell (the shared-element travel moves headers with their rows). */
  wrapSectionHeader?: (sectionKey: string, header: ReactNode) => ReactNode;
  /** One control at the end of a group header ("See all"), by the group's author key; `null` for none. */
  sectionHeaderAction?: (sectionKey: string) => ReactNode;
  /**
   * The rows scroll with the page around them: the List does not scroll itself, sizes to its rows and renders every
   * row (a page-sized collection), so a page header above it and its footer below share one scroller and one focus
   * order with the rows.
   */
  pageScroll?: boolean;
  /** Collection's existing row/header geometry, windowed in the containing physical page. */
  pageVirtualization?: Readonly<{
    rowHeight(key: string): number;
    headerHeight: number;
    width: number | null;
    defaultRowHeight: number;
  }>;
  /**
   * A page-scrolling list's groups are page sections: each group's rows sit on one page sheet under its header
   * (the page anatomy every other section of the page uses), in these colours.
   */
  pageSheet?: Readonly<{ colors: Readonly<{ sheet: string; sheetBorder: string; rowDivider: string; groupDivider: string }> }>;
}>;

export const ListCollectionControlContext = createContext<ListCollectionControl | null>(null);

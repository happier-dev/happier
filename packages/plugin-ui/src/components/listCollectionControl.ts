import { createContext, type MutableRefObject, type ReactNode } from 'react';

import type { HappierPageSheetColors } from '../presentation/layout/PageSection.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import type { PageCollectionGeometry } from '../presentation/collection/pageCollectionVirtualizer.js';

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
  /** Board columns are groups inside the Collection's one radio group; a nested table is a treegrid. */
  collectionRole?: 'group' | 'treegrid';
  /** The scroll offset as the scroller reports it, and one scroll request (a new object is a new request). */
  scroll?: Readonly<{
    offsetRef: MutableRefObject<number>;
    request: Readonly<{ offset: number }> | null;
  }>;
  /** Group headers at the presentation's exact height, and the type role their words take. */
  sectionHeaderStyle?: HappierStyleProp;
  sectionHeaderTitleRole?: 'label' | 'micro' | 'group' | 'section';
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
  /** Rows a live interaction anchors to; a windowed page keeps them mounted wherever the viewport is. */
  retainedRowKeys?: readonly string[];
  pageVirtualization?: PageCollectionGeometry;
  /**
   * A page-scrolling list's groups are page sections: each group's rows sit on one page sheet under its header
   * (the page anatomy every other section of the page uses), in these colours.
   */
  pageSheet?: Readonly<{
    colors: HappierPageSheetColors;
    /**
     * An ungrouped list is one page section: its rows, then its footer (totals), sit on one sheet, led by this bar
     * (the table's column header recomposed: what the rows are, and the order they are in).
     */
    header?: ReactNode;
    /**
     * `false`: the rows lie on the page with no sheet of their own — inside a sheet that already encloses the collection
     * (a page section's sheet), or a browse list on a phone (owner 2026-11-15: browse flat, no card per list).
     */
    flatSheet?: boolean;
    /** With no sheet of its own, from the page column to the rows' content (a phone's browse list: the page text edge). */
    rowInsetPx?: number;
    /** A grouped list that is one table (it has totals): the bar, every group's band and rows, then the footer on one sheet. */
    oneSheet?: boolean;
    /**
     * The rows are narrow (a phone): a band sharing a sheet keeps its name on line 1 and puts what its rows share
     * and its action on line 2, rather than truncating both beside each other (DESIGN "Phones recompose").
     */
    stackedHeadings?: boolean;
  }>;
  /**
   * A page's catalog directory (S10: the Store, Installed): its groups are page sections of catalog rows standing on
   * the page with no sheet or hairlines, laid out row-major in `columns` so reading and keyboard order agree.
   */
  catalogDirectory?: Readonly<{ columns: number; columnGapPx: number; lineTestID?: string }>;
}>;

export const ListCollectionControlContext = createContext<ListCollectionControl | null>(null);

/**
 * @internal True inside the body a List row discloses (`List.Item` `expandedContent`): the row above already names
 * what the body shows, so content that would caption itself (a diff's file label) keeps that name for assistive
 * technology and does not draw it a second time.
 */
export const ListItemDisclosedBodyContext = createContext(false);

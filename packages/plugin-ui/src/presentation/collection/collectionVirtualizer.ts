import { createContext, type ReactNode } from 'react';

import type { HappierStyleProp } from '../portableTypes.js';

/** Positioning only; logical focus, selection and viewport memory remain with List/Collection. */
export type CollectionVirtualizerHandle = Readonly<{
  reveal(location: Readonly<{ index: number; sectionIndex?: number }>): void;
  scrollToOffset(offset: number): void;
  scrollToEnd(): void;
}>;

type CollectionVirtualizerBase<Item> = Readonly<{
  keyForItem(item: Item, index: number): string;
  /** Section-local index for grouped rows; null for a flat window. */
  renderItem(item: Item, index: number, sectionIndex: number | null): ReactNode;
  /** Publish after mount, withdraw on unmount; no DOM or native ref crosses the seam. */
  onHandle(handle: CollectionVirtualizerHandle | null): void;
  role: 'list' | 'listbox' | 'grid' | 'treegrid' | 'radiogroup' | 'group';
  accessibilityRole?: 'list' | 'radiogroup';
  accessibilityLabel?: string;
  rowCount?: number;
  multiSelectable?: boolean;
  nativeCollection?: Readonly<{ rowCount: number; columnCount: number }>;
  style?: HappierStyleProp;
  contentContainerStyle?: HappierStyleProp;
  testID?: string;
  /** Re-evaluate mounted cells when List's selection/focus projection changes. */
  extraData?: unknown;
  endContent?: ReactNode;
  preserveVisibleContentPositionOnPrepend?: boolean;
  /** Actual platform scroll offset and content size, for the incumbent viewport owner. */
  onScroll?(offset: number): void;
  onContentSizeChange?(width: number, height: number): void;
}>;

/** The already-filtered List window, its semantic cells and platform presentation facts. */
export type CollectionVirtualizerRequest<Item> = CollectionVirtualizerBase<Item> & (
  | Readonly<{
      kind: 'flat';
      items: readonly Item[];
      /**
       * A page list draws its rows on one sheet; windowed rows and their spacers stand inside it. The sheet's own rows
       * element then carries the collection's role and name (its totals close the sheet beside it), not the root.
       */
      renderRows?(rows: ReactNode): ReactNode;
    }>
  | Readonly<{
      kind: 'sections';
      /**
       * `section`: consecutive sections naming one page section (a part) share one sheet under its heading when the
       * list draws sheets (`renderSectionRows`). Each section's header then stands inside that sheet, before its rows.
       */
      sections: readonly Readonly<{ key: string; title?: string; data: readonly Item[]; section?: Readonly<{ key: string; title: string }> }>[];
      /** Section headers share the rows' scroller and stay pinned where they can paint their ground (not inside a translucent material). */
      renderSectionHeader(sectionIndex: number): ReactNode;
      /**
       * A page list draws each section's rows on its own sheet, or a part's groups on their one sheet (`sectionIndex`
       * is the part's first section); windowed rows and their spacers stand inside it.
       */
      renderSectionRows?(sectionIndex: number, rows: ReactNode): ReactNode;
      /** A part's heading, above its sheet (`sectionIndex` is the part's first section). */
      renderPartHeading?(sectionIndex: number): ReactNode;
    }>
);

/** A host-injectable renderer; the host keeps its virtualizer implementation/dependency private. */
export type CollectionVirtualizer = Readonly<{
  render<Item>(request: CollectionVirtualizerRequest<Item>): ReactNode;
}>;

/** @internal A Collection prop applies to every List in its card or row composition. */
export const CollectionVirtualizerContext = createContext<CollectionVirtualizer | undefined>(undefined);

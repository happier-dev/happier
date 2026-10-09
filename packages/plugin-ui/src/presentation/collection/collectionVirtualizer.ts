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
  role: 'list' | 'listbox' | 'grid' | 'radiogroup' | 'group';
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
  | Readonly<{ kind: 'flat'; items: readonly Item[] }>
  | Readonly<{
      kind: 'sections';
      sections: readonly Readonly<{ key: string; data: readonly Item[] }>[];
      /** Section headers share the rows' scroller and remain sticky. */
      renderSectionHeader(sectionIndex: number): ReactNode;
    }>
);

/** A host-injectable renderer; the host keeps its virtualizer implementation/dependency private. */
export type CollectionVirtualizer = Readonly<{
  render<Item>(request: CollectionVirtualizerRequest<Item>): ReactNode;
}>;

/** @internal A Collection prop applies to every List in its card or row composition. */
export const CollectionVirtualizerContext = createContext<CollectionVirtualizer | undefined>(undefined);

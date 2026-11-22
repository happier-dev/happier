import { createContext, createElement, useContext, type Context, type ReactNode } from 'react';
import type { HappierLayoutChangeEvent, HappierScrollEvent } from '../presentation/portableTypes.js';

/** Host-owned admission shared by physical scrollers and their widget bodies; no author policy. */
export type PluginUiScrollActivityTracker = Readonly<{
  onScroll(event: HappierScrollEvent): void;
  onLayout(event: HappierLayoutChangeEvent): void;
  onContentSizeChange(width: number, height: number): void;
  subscribe(listener: () => void): () => void;
  getWindow(): Readonly<{ top: number; bottom: number }> | null;
  /** Exact physical viewport for running presentation; `getWindow` retains prebuild overscan. */
  getVisibleWindow?(): Readonly<{ top: number; bottom: number }> | null;
  subscribeVisibleWindow?(listener: () => void): () => void;
  measureSpan(node: unknown): Promise<Readonly<{ top: number; height?: number }> | null>;
  invalidateLayout(): void;
  getLayoutRevision(): number;
  /** Position the same physical page; Collection/List retain choice and focus ownership. */
  scrollToOffset?(offset: number): void;
}>;

/** The enclosing physical scroller owns offset reads and restoration. A retained panel owns the saved value. */
export type HappierRetainedScrollInternal = Readonly<{
  tracker?: PluginUiScrollActivityTracker | null;
  readOffset(): number;
  scrollToOffset?(offset: number): void;
  restoreOffset(offset: number, waitForLayout?: boolean): () => void;
}>;

/** A positioned block resolves its own key against the layout on the panel's next presentation. */
export type HappierRetainedScrollAnchorReaderInternal = (offset: number) => (() => number | undefined) | undefined;

type HappierRetainedScrollAnchorsInternal = Readonly<{
  scroll: HappierRetainedScrollInternal;
  readers: Set<HappierRetainedScrollAnchorReaderInternal>;
}>;

// A targeted source and its frame share React, but each bundles its own Plugin UI modules.
const scrollActivityKey = Symbol.for('happier.pluginUi.scrollActivityContext.v1');
const retainedScrollKey = Symbol.for('happier.pluginUi.retainedScrollContext.v1');
const retainedScrollAnchorsKey = Symbol.for('happier.pluginUi.retainedScrollAnchorsContext.v1');
const privateContexts = globalThis as typeof globalThis & {
  [scrollActivityKey]?: Context<PluginUiScrollActivityTracker | null>;
  [retainedScrollKey]?: Context<HappierRetainedScrollInternal | null>;
  [retainedScrollAnchorsKey]?: Context<HappierRetainedScrollAnchorsInternal | null>;
};
const ScrollActivityContext =
  (privateContexts[scrollActivityKey] ??= createContext<PluginUiScrollActivityTracker | null>(null));
export const HappierRetainedScrollContextInternal =
  (privateContexts[retainedScrollKey] ??= createContext<HappierRetainedScrollInternal | null>(null));
export const HappierRetainedScrollAnchorContextInternal =
  (privateContexts[retainedScrollAnchorsKey] ??= createContext<HappierRetainedScrollAnchorsInternal | null>(null));

export function PluginUiScrollActivityProvider(props: Readonly<{
  tracker: PluginUiScrollActivityTracker | null;
  children?: ReactNode;
}>) {
  return createElement(ScrollActivityContext.Provider, { value: props.tracker }, props.children);
}

export function useOptionalPluginUiScrollActivityTracker(): PluginUiScrollActivityTracker | null {
  return useContext(ScrollActivityContext);
}

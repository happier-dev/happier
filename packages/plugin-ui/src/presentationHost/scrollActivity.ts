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

const ScrollActivityContext = createContext<PluginUiScrollActivityTracker | null>(null);

/** The enclosing physical scroller owns offset reads and restoration. A retained panel owns the saved value. */
export type HappierRetainedScrollInternal = Readonly<{
  readOffset(): number;
  restoreOffset(offset: number): () => void;
}>;

// A targeted source and its frame share React, but each bundles its own Plugin UI modules.
const retainedScrollKey = Symbol.for('happier.pluginUi.retainedScrollContext.v1');
const privateContexts = globalThis as typeof globalThis & {
  [retainedScrollKey]?: Context<HappierRetainedScrollInternal | null>;
};
export const HappierRetainedScrollContextInternal =
  (privateContexts[retainedScrollKey] ??= createContext<HappierRetainedScrollInternal | null>(null));

export function PluginUiScrollActivityProvider(props: Readonly<{
  tracker: PluginUiScrollActivityTracker | null;
  children?: ReactNode;
}>) {
  return createElement(ScrollActivityContext.Provider, { value: props.tracker }, props.children);
}

export function useOptionalPluginUiScrollActivityTracker(): PluginUiScrollActivityTracker | null {
  return useContext(ScrollActivityContext);
}

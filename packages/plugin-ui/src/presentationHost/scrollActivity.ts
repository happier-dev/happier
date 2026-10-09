import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { HappierLayoutChangeEvent, HappierScrollEvent } from '../presentation/portableTypes.js';

/** Host-owned admission shared by physical scrollers and their widget bodies; no author policy. */
export type PluginUiScrollActivityTracker = Readonly<{
  onScroll(event: HappierScrollEvent): void;
  onLayout(event: HappierLayoutChangeEvent): void;
  onContentSizeChange(width: number, height: number): void;
  subscribe(listener: () => void): () => void;
  getWindow(): Readonly<{ top: number; bottom: number }> | null;
  measureSpan(node: unknown): Promise<Readonly<{ top: number; height?: number }> | null>;
  invalidateLayout(): void;
  getLayoutRevision(): number;
  /** Position the same physical page; Collection/List retain choice and focus ownership. */
  scrollToOffset?(offset: number): void;
}>;

const ScrollActivityContext = createContext<PluginUiScrollActivityTracker | null>(null);

export function PluginUiScrollActivityProvider(props: Readonly<{
  tracker: PluginUiScrollActivityTracker | null;
  children?: ReactNode;
}>) {
  return createElement(ScrollActivityContext.Provider, { value: props.tracker }, props.children);
}

export function useOptionalPluginUiScrollActivityTracker(): PluginUiScrollActivityTracker | null {
  return useContext(ScrollActivityContext);
}

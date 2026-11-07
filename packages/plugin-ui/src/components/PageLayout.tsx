import type { ReactElement, ReactNode } from 'react';

import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type PageAsideColumnsProps = Readonly<{
  children: ReactNode | ((layout: Readonly<{ sideBySide: boolean }>) => ReactNode);
  aside: ReactNode | null;
  compact: boolean;
  closing?: ReactNode;
  compactAside?: 'first' | 'last' | 'none';
  /** Alternative content for hosts without the same-realm page layout bridge. */
  fallback?: ReactNode;
}>;

/** The app's page body and aside columns; width, reading order and sticky placement stay host-owned. */
export function PageAsideColumns({ fallback, ...input }: PageAsideColumnsProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderPageAsideColumns?.(input) ?? fallback}</>;
}

export type PagePinnedBarProps = Readonly<{
  children?: ReactNode;
  testID?: string;
  style?: HappierStyleProp;
  /** Alternative content for hosts without the same-realm chrome-clearance bridge. */
  fallback?: ReactNode;
}>;

/** Place below the page's scroll owner. The host clears floating chrome and the safe area. */
export function PagePinnedBar({ fallback, ...input }: PagePinnedBarProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderPagePinnedBar?.(input) ?? fallback}</>;
}

export type KeyboardStickyFooterProps = Readonly<{
  children?: ReactNode;
  /** Footer padding that may tuck beneath the open keyboard; the host resolves its geometry. */
  offset?: number;
  enabled?: boolean;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** Uses the app's native keyboard owner; hosts without it retain ordinary-flow children. */
export function KeyboardStickyFooter(props: KeyboardStickyFooterProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderKeyboardStickyFooter ? host.renderKeyboardStickyFooter(props) : props.children}</>;
}

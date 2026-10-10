import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { useWidgetAreaPort } from '../hostApi/widgetArea.public.js';

export type WidgetSurfaceProps = Readonly<{
  /** One of the areas this page declares (`widgetAreas` on its `appPage` View). */
  area: string;
  /**
   * What this page provides to the widgets that follow it ("This page"): readable values keyed by the
   * area's declared context, such as the repository the page is filtered by. The host admits it
   * against that schema; it never names a Home, Account, machine or layout.
   */
  context?: Readonly<Record<string, JsonValue>>;
  /** The area's heading; the host's own ("Pinned") when omitted. */
  title?: string;
  /** One quiet line beside the heading; the host's own when omitted. */
  description?: string;
  /** Rendered when no native area presentation host is installed, such as an isolated test. */
  fallback?: ReactNode;
  testID?: string;
}>;

const NO_CONTEXT: Readonly<Record<string, JsonValue>> = Object.freeze({});

/**
 * A personal widget area on a plugin page: `<WidgetSurface area="pinned" context={{ repository }} />`.
 *
 * The plugin declares the area and supplies its page context; everything inside belongs to the host —
 * catalog, gallery, Set up, frames, named-layout tabs, layout storage and access. The host's tabs
 * and the page-local area port reach the same layout Actions, including the mounted selection. This
 * component holds no state of its own: it lends the mounted Host API area port and the context to the
 * host's presentation bridge. Declarative documents use the `widgetArea` node against the same
 * port. Hosted HTML owns its whole iframe and manages widgets through ordinary `widgets.*` Actions;
 * it cannot embed host widget areas.
 */
export function WidgetSurface({ area, context, title, description, fallback, testID }: WidgetSurfaceProps): ReactElement | null {
  const port = useWidgetAreaPort(area);
  const renderWidgetArea = useOptionalPluginUiPresentationHost()?.renderWidgetArea;
  const request = useMemo(() => Object.freeze({
    area,
    context: context ?? NO_CONTEXT,
    port,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(testID === undefined ? {} : { testID }),
  }), [area, context, description, port, testID, title]);
  if (!renderWidgetArea) return <>{fallback}</>;
  return <>{renderWidgetArea(request)}</>;
}

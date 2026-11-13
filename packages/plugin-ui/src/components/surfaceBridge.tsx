import { createElement, useCallback, useContext, useMemo, type Context, type ReactNode } from 'react';

import { PLUGIN_UI_DATA_CONTEXT_INTERNAL } from '../data/context.js';
import { HAPPIER_UI_ENVIRONMENT_CONTEXTS_INTERNAL } from '../environment/context.js';
import { PLUGIN_HOST_API_CONTEXT_INTERNAL } from '../hostApi/context.js';
import { PLUGIN_UI_HOST_READINESS_CONTEXT_INTERNAL } from '../hostApi/readiness.public.js';
import { HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL, type HappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { PLUGIN_UI_PRESENTATION_HOST_CONTEXT_INTERNAL } from '../presentationHost/context.js';
import { PLUGIN_SURFACE_CONTEXT_INTERNAL } from './PluginUiProvider.js';

/**
 * Everything `PluginUiProvider` installs at a surface's root: the Host API (with its resource store,
 * composer and shared scope), the surface context, the presentation environment, the data client,
 * the host's presentation facts and the page chrome. Structural contexts (a page section, a list's
 * selection, a Collection's stage) are deliberately absent: where the content goes is a new root.
 */
const SURFACE_ROOT_CONTEXTS: readonly Context<unknown>[] = [
  PLUGIN_HOST_API_CONTEXT_INTERNAL,
  PLUGIN_UI_HOST_READINESS_CONTEXT_INTERNAL,
  PLUGIN_SURFACE_CONTEXT_INTERNAL,
  ...HAPPIER_UI_ENVIRONMENT_CONTEXTS_INTERNAL,
  PLUGIN_UI_DATA_CONTEXT_INTERNAL,
  PLUGIN_UI_PRESENTATION_HOST_CONTEXT_INTERNAL,
  HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL,
] as readonly Context<unknown>[];

/**
 * Carries this surface's root context to content the host renders elsewhere (the page's details
 * pane). The host's pane is outside the plugin's React tree on every platform, so the surface's own
 * values are captured here and provided again around the content — the same values, never a second
 * provider instance with its own stores.
 */
export function usePluginUiSurfaceBridge(): (node: ReactNode) => ReactNode {
  // A fixed list, read in a fixed order on every render.
  const values = SURFACE_ROOT_CONTEXTS.map((context) => useContext(context));
  const chromeIndex = SURFACE_ROOT_CONTEXTS.findIndex((context) => context === HAPPIER_PAGE_CHROME_CONTEXT_INTERNAL);
  const pageChrome = values[chromeIndex];
  // The host's destination is its own column; keep that projection stable while the source facts are unchanged.
  const paneChrome = useMemo(() => {
    if (pageChrome === null || typeof pageChrome !== 'object') return pageChrome;
    const { columnMaxWidthPx: _pageColumn, ...chrome } = pageChrome as HappierPageChromeInternal;
    return chrome;
  }, [pageChrome]);
  values[chromeIndex] = paneChrome;
  return useCallback(
    (node: ReactNode) => SURFACE_ROOT_CONTEXTS.reduceRight<ReactNode>(
      (child, context, index) => createElement(context.Provider, { value: values[index] }, child),
      node,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    values,
  );
}

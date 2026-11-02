import { useMemo, type ReactElement, type ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost, type PluginUiPaneHeaderLineSegment } from '../presentationHost/context.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';

export type PaneHeaderContentProps = Readonly<{
  /**
   * The pane's one live line under its title, as facts the host joins with " · " ("1 needs you",
   * "2 live"). An attention fact is `{ text, attention: true }`; the host owns its emphasis.
   * Omit it, or pass an empty list, when there is nothing to say; healthy stays quiet.
   */
  line?: readonly PaneHeaderContentLineSegment[];
  /**
   * The header's trailing actions, before the host's own controls: the tab's "+" (with its menu or
   * picker) and at most one more. Icon buttons, not text.
   */
  actions?: ReactNode;
  /**
   * Inside a widget frame, the quiet source the frame says beside the widget's title, in place of the
   * plugin's name: the part of the plugin this widget comes from ("Tasks" for a plugin that also has
   * "PRs & Issues"). Tab headers have no such slot and ignore it.
   */
  caption?: string;
  /**
   * Inside a widget frame, opens the page `caption` names: the frame draws it as its one footer link, "Open
   * Tasks", the way to everything the glance leaves out (a list capped to the rows its card has room for). Give it
   * with `caption`. Tab headers have no footer and ignore it.
   */
  onOpen?: () => void;
}>;

export type PaneHeaderContentLineSegment = PluginUiPaneHeaderLineSegment;

/**
 * What this tab puts in the pane header the host already draws for it — the session sidebar's band on
 * desktop, the large title on a phone, a widget's frame header on Home or a Board — exactly where
 * Happier's own tabs and widgets put their "+" and their live line. The surface never draws a header of
 * its own; the host keeps the title (the tab's or widget's name), the layout and what fits.
 *
 * The actions render in the header, outside this surface's own React tree, yet keep this plugin's
 * context (theme, translation, the surface context, the Host API and every public component). React
 * context your own components provide above `PaneHeaderContent` does not reach them.
 *
 * Where the host placed the surface under no such header (a page) it renders nothing, so a surface
 * that is also mounted elsewhere keeps its add path in its body (an empty state's action).
 *
 * ```tsx
 * <PaneHeaderContent line={needsYou > 0 ? [{ text: `${needsYou} needs you`, attention: true }] : []} actions={<LinkMenu />} />
 * ```
 */
export function PaneHeaderContent(props: PaneHeaderContentProps): ReactElement | null {
  const binding = useOptionalPluginUiPresentationHost()?.paneHeader ?? null;
  const bridge = usePluginUiSurfaceBridge();
  const lineKey = JSON.stringify(props.line?.map((part) => typeof part === 'string' ? part : [part.text, part.attention]) ?? []);
  // The line is compared by value, so a tab that re-renders with the same facts does not republish.
  const line = useMemo(
    () => (props.line === undefined || props.line.length === 0 ? null : Object.freeze([...props.line])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineKey],
  );
  const actions = useMemo(
    () => (props.actions === undefined || props.actions === null ? null : bridge(props.actions)),
    [bridge, props.actions],
  );
  if (binding === null) return null;
  return <>{binding.renderPaneHeader({ line, actions, caption: props.caption ?? null, open: props.onOpen ?? null })}</>;
}

import * as React from 'react';
import { useAtmosphereBackdrop } from './atmosphereBackdrop';
import { View } from 'react-native';
import {
  useDestinationFocus,
  useDestinationVisibility,
} from '@/components/appShell/workspace/DestinationInstanceHost';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useAtmosphere } from './useAtmosphere';
import {
  useAtmosphereStage,
  type AtmosphereStageGeometry,
} from './atmosphereStage';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import {
  useAtmosphereRouteSurface,
  type AtmosphereRouteContext,
} from './useAtmosphereRouteSurface';

/**
 * Which atmosphere place a workspace destination is (plan A3), or null when the destination owns its
 * own atmosphere frame: Home (`/`), a Session (`/session/<id>`) and a Project (`/projects/<ref>…`).
 * Every other destination is one of the "other pages"; a Session's own pages carry that Session, so
 * they resolve its Project's background.
 */
export function pageAtmosphereContext(
  pathname: string,
  params: Readonly<Record<string, string | undefined>>,
): AtmosphereRouteContext | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === 'projects' && parts.length > 1 && parts[1] !== 'open' && parts[1] !== 'sources') return null;
  if (parts[0] === 'session' && parts[1]) {
    if (parts.length === 2) return null;
    const session = normalizeSessionAddress(
      params.serverId,
      params.id ?? parts[1],
    );
    return session ? { place: 'pages', session } : { place: 'pages' };
  }
  return { place: 'pages' };
}

const PAGE_CONTEXT: AtmosphereRouteContext = { place: 'pages' };

function measure(
  node: View | null,
): Promise<AtmosphereStageGeometry['rect'] | null> {
  return new Promise((resolve) =>
    node
      ? node.measureInWindow((x, y, width, height) =>
          resolve({ x, y, width, height }),
        )
      : resolve(null),
  );
}

/**
 * A page's place on the shell's one atmosphere stage. It draws no picture: the shell's layer paints the still
 * picture behind the page and the glass owner clears or coats the planes, so a page never adds a renderer.
 * The wrapper is the same plane whether the place shows or not, so changing the setting never remounts the page.
 */
export function PageAtmosphereStage(
  props: Readonly<{
    pathname: string;
    params: Readonly<Record<string, string | undefined>>;
    children: React.ReactNode;
  }>,
) {
  const focused = useDestinationFocus();
  const visible = useDestinationVisibility();
  const context = React.useMemo(
    () => pageAtmosphereContext(props.pathname, props.params),
    // The context is a function of the route's identity, not of the params object's allocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.pathname, props.params.serverId, props.params.id],
  );
  const surface = useAtmosphereRouteSurface(context ?? PAGE_CONTEXT);
  const owned = context !== null && visible;
  const atmosphere = useAtmosphere(surface, owned);
  const backdrop = useAtmosphereBackdrop(atmosphere);
  const ref = React.useRef<View>(null);
  const [geometry, setGeometry] =
    React.useState<AtmosphereStageGeometry | null>(null);
  const request = React.useRef(0);
  const onLayout = React.useCallback(() => {
    const id = ++request.current;
    void measure(ref.current).then((pane) => {
      if (!pane || id !== request.current) return;
      setGeometry((previous) =>
        previous &&
        previous.rect.x === pane.x &&
        previous.rect.y === pane.y &&
        previous.rect.width === pane.width &&
        previous.rect.height === pane.height
          ? previous
          : {
              rect: pane,
              band: pageAtmosphereBand(pane.height),
              horizonAt: 0.86,
              focus: { x: pane.width / 2, y: pane.height / 2 },
            },
      );
    });
  }, []);
  React.useEffect(() => {
    if (owned) onLayout();
    return () => {
      request.current++;
    };
  }, [owned, onLayout]);
  useAtmosphereStage(
    owned ? surface : null,
    geometry,
    focused,
    atmosphere.shown,
    backdrop,
  );
  return (
    <GlassSurface
      ref={ref}
      plane
      noCoat
      surfaceGroup="content"
      finishRole={null}
      onLayout={owned ? onLayout : undefined}
      style={{ flex: 1, minWidth: 0, minHeight: 0 }}
      testID="page-atmosphere-coat"
    >
      {props.children}
    </GlassSurface>
  );
}

/**
 * A Horizon picture on an ordinary page is a band behind its header, as tall as a Project's band over a
 * picture (lab `at2-project-pageH`), never more than a quarter of a short pane.
 */
export function pageAtmosphereBand(paneHeight: number): number {
  return Math.round(Math.min(PAGE_HORIZON_BAND_PX, paneHeight / 4));
}
const PAGE_HORIZON_BAND_PX = 216;

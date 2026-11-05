import * as React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { WallpaperHaze } from './WallpaperHaze';
import { resolveWallpaperHaze, WALLPAPER_HAZE_LAYERS, type WallpaperHaze as WallpaperHazeComposition } from './wallpaperHaze';
import { useSetGlassAtmosphereBehind, useSetGlassAtmosphereTone } from '@/components/ui/glass/glassRuntimeEnvironment';
import type { AtmospherePixels } from '@happier-dev/brand/atmosphere';
import { measurePictureColor, measurePictureTone, samePictureTone, type PictureToneRegion } from './pictureTone';
import type { GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { BackdropCanvas } from './BackdropCanvas';
import {
  atmosphereStageStore,
  useAtmosphereScrollY,
  useAtmosphereStageSnapshot,
  useAtmosphereResettlePaused,
  type AtmosphereRect,
  type AtmosphereStage,
} from './atmosphereStage';
import { effectivePictureLook, pictureHazeIsAdaptive } from './look/atmosphereEdits';
import { pictureBackdropProps } from './pictureBackdrop';
import { useAtmosphere } from './useAtmosphere';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { useSetting } from '@/sync/store/hooks';
import { atmospherePageRgb } from './atmospherePage';
import { atmosphereBandSpan, atmospherePaneSpan, atmospherePictureFrame, atmosphereSceneRect } from './atmosphereGeometry';

/**
 * The atmosphere's page backing, mounted once at the bottom of the shell, under every plane (plan §4.4).
 * It draws the picture for the surface on screen: Horizon as a band in that surface's pane (scrolling
 * with it, the page colour below), Wallpaper behind the whole window. While it covers an area it tells
 * the glass owner (`atmosphereBehind`), so the content coat clears there and nothing else changes,
 * and the measured tone of the picture where content sits (`atmosphereTone`), from which default glass
 * and ink stay legible. The planet is not drawn here: it is an object on Home's page. Decorative, never a target.
 */
export const AtmosphereLayer = React.memo(function AtmosphereLayer(
  props: Readonly<{ sheetRadius: number; chrome: boolean }>,
) {
  const snapshot = useAtmosphereStageSnapshot();
  const { theme } = useUnistyles();
  const window = useWindowDimensions();
  const stage = snapshot.stage;
  // The send dissolve is one of Home's moments (moments are always Home's); off, the page simply hands over.
  const sendMoment = useSetting('homeAtmosphere').moments.send !== false;
  const sending = snapshot.sending && sendMoment;
  // A send keeps the last surface on screen until its dissolve has played, even as the session opens.
  const [held, setHeld] = React.useState<AtmosphereStage | null>(null);
  const [left, setLeft] = React.useState(false);
  const current = stage ?? held;
  const leaving = sending || stage === null;
  React.useEffect(() => {
    if (stage) setHeld(sending ? stage : null);
  }, [sending, stage]);
  React.useEffect(() => {
    if (!leaving) setLeft(false);
    else if (left && stage === null) setHeld(null);
  }, [leaving, left, stage]);
  const onLeft = React.useCallback(() => setLeft(true), []);
  const ref = React.useRef<View>(null);
  const [origin, setOrigin] = React.useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const measure = React.useCallback(() => {
    ref.current?.measureInWindow((x, y, width, height) =>
      setOrigin((previous) =>
        previous &&
        previous.x === x &&
        previous.y === y &&
        previous.width === width &&
        previous.height === height
          ? previous
          : { x, y, width, height },
      ),
    );
  }, []);
  React.useEffect(() => {
    if (current?.geometry) measure();
  }, [current?.geometry, measure]);
  return (
    <View
      ref={ref}
      testID="atmosphere-window-layer"
      onLayout={measure}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, styles.window]}
    >
      {current?.geometry && origin ? (
        <>
        <AtmospherePicture
          stage={current}
          panes={snapshot.panes}
          origin={origin}
          windowFrame={{ x: 0, y: 0, width: window.width, height: window.height }}
          leaving={leaving}
          sheetRadius={props.sheetRadius}
          chrome={props.chrome}
          onLeft={onLeft}
        />
        {/* Exclusion belongs to the shell backing, beneath the shared reading material.
            Page bodies remain clear, and focus never re-decides the admitted pane's inclusion. */}
        {snapshot.excludedPanes.map(pane => pane.geometry ? (
          <View key={pane.id} testID="atmosphere-excluded-pane" style={{
            position: 'absolute', left: pane.geometry.rect.x - origin.x, top: pane.geometry.rect.y - origin.y,
            width: pane.geometry.rect.width, height: pane.geometry.rect.height,
            backgroundColor: `rgb(${atmospherePageRgb(theme.colors.surface.base).join(', ')})`,
          }} />
        ) : null)}
        </>
      ) : null}
    </View>
  );
});

const AtmospherePicture = React.memo(function AtmospherePicture(
  props: Readonly<{
    stage: AtmosphereStage;
    panes: readonly AtmosphereStage[];
    origin: AtmosphereRect;
    windowFrame: AtmosphereRect;
    leaving: boolean;
    sheetRadius: number;
    chrome: boolean;
    onLeft?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const atmosphere = useAtmosphere(props.stage.surface);
  const resettlePaused = useAtmosphereResettlePaused();
  const pictures = useAtmospherePictureCatalog();
  const setBehind = useSetGlassAtmosphereBehind();
  const setTone = useSetGlassAtmosphereTone();
  const pageFill = useGlassSurfaceColor(
    theme.colors.surface.base,
    'content',
    false,
    undefined,
    false,
  );
  const record =
    atmosphere.source === 'picture' ? atmosphere.pictureRecord : null;
  const layout = atmosphere.picture.layout;
  const geometry = props.stage.geometry!;
  const panes = props.panes.flatMap(pane => pane.geometry ? [{ id: pane.id, ...pane.geometry }] : []);
  const projections = panes.length ? panes : [{ id: props.stage.id, ...geometry }];
  const scene = atmosphereSceneRect(panes.map(pane => pane.rect)) ?? geometry.rect;
  const bands = projections.map(pane => ({ ...pane.rect, height: pane.band || geometry.band }));
  const bandScene = atmosphereSceneRect(bands)!;
  const bandSpan = atmosphereBandSpan(bandScene, props.windowFrame);
  const renderGroup = React.useMemo(() => ({}), []);
  const frame = atmospherePictureFrame(layout, props.windowFrame, scene);
  const [ready, setReady] = React.useState(false);
  const [shownKey, setShownKey] = React.useState<string | null>(null);
  // A new layout is a new canvas and starts unready. A new picture keeps the current frame until its
  // own render lands in the same canvas, so a change never flashes the page.
  const key = record ? layout : null;
  if (key !== shownKey) {
    setShownKey(key);
    setReady(false);
  }
  const covers = atmosphere.source === 'planet' || (record ? (layout === 'wallpaper' ? ready : true) : false);
  const behind = covers ? (record && layout === 'wallpaper' ? 'wallpaper' : 'band') : 'none';
  React.useEffect(() => {
    if (behind === 'none') return;
    setBehind(behind);
    return () => setBehind('none');
  }, [behind, setBehind]);
  React.useEffect(() => {
    atmosphereStageStore.setPictureShown(ready);
    return () => atmosphereStageStore.setPictureShown(false);
  }, [ready]);
  const onReady = React.useCallback(() => setReady(true), []);
  // Wallpaper: content sits in its pane's column of the window-sized picture, at every scroll position, and
  // head lines stand around the column's centre, inside the haze. Horizon: the band scrolls with the page,
  // so the whole band is where content meets it.
  const toneRegions = React.useRef<WallpaperToneRegions>(WHOLE_REGIONS);
  toneRegions.current = layout === 'wallpaper' && frame.width > 0 && frame.height > 0
    ? wallpaperToneRegions(frame, geometry)
    : WHOLE_REGIONS;
  const page = atmospherePageRgb(theme.colors.surface.base);
  const pageRef = React.useRef(page); pageRef.current = page;
  const published = React.useRef<ReturnType<typeof measurePictureTone>>(undefined);
  // Content stands on the picture and, around the column's centre, on the Wallpaper haze drawn over it
  // (a softer render of the same picture). Both renders are kept and measured where content sits now, so
  // the tone follows the content as its layout settles, not only when the picture renders again; the tone
  // spans both, and head lines read the haze, which covers them.
  const rendered = React.useRef<{ picture?: AtmospherePixels; haze?: AtmospherePixels }>({});
  // The Wallpaper haze and the plane's ink are decided together from the head-line bands (the column across the
  // haze core's height, on the picture itself, before the haze softens and veils it). With the default look (a
  // built-in picture as released) the haze keeps the head lines legible; a person's own picture or look applies
  // exactly as set.
  const hazeInput = React.useRef({ adaptive: false, page: '', primary: '' });
  hazeInput.current = {
    adaptive: pictureHazeIsAdaptive(atmosphere, atmosphere.builtinPicture),
    page: theme.colors.surface.base,
    primary: theme.colors.text.primary,
  };
  const [haze, setHaze] = React.useState<WallpaperHazeComposition>(AS_COMPOSED_HAZE);
  const publish = React.useCallback(() => {
    const regions = toneRegions.current;
    const { picture: pictureRender, haze: hazeRender } = rendered.current;
    const base = pictureRender && measurePictureTone(pictureRender, pageRef.current, regions.column, regions.focus);
    const soft = hazeRender && measurePictureTone(hazeRender, pageRef.current, regions.column, regions.focus);
    // This surface's head lines and the window's middle, where Home stands them: one veil for every surface.
    const heads = pictureRender && mergeTones(measurePictureTone(pictureRender, pageRef.current, regions.heads),
      measurePictureTone(pictureRender, pageRef.current, regions.look));
    const measuredTone = base && soft
      ? { dark: Math.min(base.dark, soft.dark), light: Math.max(base.light, soft.light), focus: soft.focus }
      : base;
    const next = soft && heads && measuredTone
      ? resolveWallpaperHaze({ heads: { ...heads, focus: measuredTone.focus }, ...hazeInput.current, column: regions.reach, at: regions.at,
        bandColor: measurePictureColor(pictureRender!, pageRef.current, regions.look) })
      : AS_COMPOSED_HAZE;
    setHaze(previous => sameHaze(previous, next) ? previous : next);
    const tone = measuredTone && soft ? { ...measuredTone, ink: next.ink } : measuredTone;
    if (samePictureTone(tone, published.current)) return;
    published.current = tone;
    setTone(tone);
  }, [setTone]);
  // A changed look or theme decides again from the same renders, and so does content settling elsewhere.
  const { adaptive, page: pageInk, primary } = hazeInput.current;
  const regionsKey = JSON.stringify(toneRegions.current);
  React.useEffect(() => { publish(); }, [adaptive, pageInk, primary, regionsKey, publish]);
  const onRendered = React.useCallback((pixels: AtmospherePixels) => {
    rendered.current.picture = pixels;
    publish();
  }, [publish]);
  const onHazeRendered = React.useCallback((pixels: AtmospherePixels) => {
    rendered.current.haze = pixels;
    publish();
  }, [publish]);
  // No picture (the planet, or none) has no tone; a new picture publishes its own once rendered.
  React.useEffect(() => {
    if (record) return;
    rendered.current = {};
    published.current = undefined;
    setTone(undefined);
    setHaze(AS_COMPOSED_HAZE);
  }, [record, setTone]);
  React.useEffect(() => () => { rendered.current = {}; published.current = undefined; setTone(undefined); }, [setTone]);
  // Only Wallpaper has a haze; Horizon publishes the band alone.
  React.useEffect(() => { if (layout !== 'wallpaper') rendered.current.haze = undefined; }, [layout]);
  const { leaving, onLeft } = props;
  // Nothing on screen yet, nothing to dissolve: a send leaves at once.
  React.useEffect(() => {
    if (leaving && (!record || !ready)) onLeft?.();
  }, [leaving, onLeft, ready, record]);
  const rect = {
    x: scene.x - props.origin.x,
    y: scene.y - props.origin.y,
    width: scene.width,
    height: scene.height,
  };
  // The page backing shares the glass owner's material outside the artwork. The planet itself
  // remains inside the content, whose coat now clears through the same input as a picture.
  const rounded = props.chrome
    ? { borderTopRightRadius: props.sheetRadius, borderBottomRightRadius: props.sheetRadius }
    : null;
  if (!record) return atmosphere.source === 'planet'
    ? <View testID="atmosphere-planet-page" style={[styles.pane, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, rounded, { backgroundColor: pageFill }]} />
    : null;
  const picture = atmosphere.builtinPicture;
  const look = effectivePictureLook(atmosphere, pictures);
  const job = pictureBackdropProps({
    picture,
    look,
    theme: theme.dark ? 'dark' : 'light',
    page,
    layout,
    horizonAt: geometry.horizonAt,
  });
  const visible = ready && !props.leaving;
  if (layout === 'wallpaper') {
    const size = { width: frame.width, height: frame.height };
    const span = atmospherePaneSpan(frame, frame);
    const paneSpan = atmospherePaneSpan(frame, geometry.rect);
    const focus = {
      x: paneSpan.x + geometry.focus.x,
      y: paneSpan.y + geometry.focus.y,
    };
    return (
      <AtmosphereDissolve
        visible={visible}
        leave="climb"
        height={size.height}
        reducedMotion={atmosphere.reducedMotion}
        onHidden={props.onLeft}
        style={{ position: 'absolute', left: frame.x - props.origin.x, top: frame.y - props.origin.y,
          width: frame.width, height: frame.height }}
      >
        <BackdropCanvas
          resettlePaused={resettlePaused}
          source={record}
          size={size}
          span={span}
          {...job}
          onReady={onReady}
          onRendered={onRendered}
          testID="atmosphere-wallpaper"
        />
        <WallpaperHaze source={record} size={size} job={job} focus={focus} haze={haze} onRendered={onHazeRendered} />
      </AtmosphereDissolve>
    );
  }
  // The pane keeps the sheet's rounded right edge, so no square corner shows through clear chrome.
  return (
    <View style={[styles.pane, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, rounded, { backgroundColor: pageFill }]}>
      {projections.map((pane, index) => (
        <View key={pane.id}
          style={{ position: 'absolute', left: pane.rect.x - scene.x, top: pane.rect.y - scene.y,
            width: pane.rect.width, height: pane.rect.height, overflow: 'hidden' }}>
          <BandScroll stageId={pane.id}>
            <AtmosphereDissolve
              visible={visible}
              leave="climb"
              height={bands[index].height}
              reducedMotion={atmosphere.reducedMotion}
              onHidden={props.onLeft}
            >
              <View style={{ width: pane.rect.width, height: bands[index].height, overflow: 'hidden' }}>
                <BackdropCanvas
                  resettlePaused={resettlePaused}
                  source={record}
                  size={{ width: bandScene.width, height: bandScene.height }}
                  span={bandSpan}
                  style={{ marginTop: bandScene.y - pane.rect.y, marginLeft: bandScene.x - pane.rect.x }}
                  renderGroup={renderGroup}
                  {...job}
                  onReady={onReady}
                  onRendered={index === 0 ? onRendered : undefined}
                  testID="atmosphere-band"
                />
              </View>
            </AtmosphereDissolve>
          </BandScroll>
        </View>
      ))}
    </View>
  );
});

const WHOLE: PictureToneRegion = { x0: 0, x1: 1, y0: 0, y1: 1 };
type WallpaperToneRegions = Readonly<{
  column: PictureToneRegion; focus: PictureToneRegion; heads: PictureToneRegion; look: PictureToneRegion;
  /** The veil's centre, and the half-extents of both head-line bands around it (fractions of the picture). */
  at: Readonly<{ x: number; y: number }>; reach: Readonly<{ x: number; y: number }>;
}>;
const WHOLE_REGIONS: WallpaperToneRegions = { column: WHOLE, focus: WHOLE, heads: WHOLE, look: WHOLE, at: { x: 0.5, y: 0.5 }, reach: { x: 0.5, y: 0.5 } };
/** Both bands' extremes: the veil answers to whichever runs harder against the ink. */
function mergeTones(a: GlassAtmosphereTone | undefined, b: GlassAtmosphereTone | undefined): GlassAtmosphereTone | undefined {
  return a && b ? { dark: Math.min(a.dark, b.dark), light: Math.max(a.light, b.light), focus: a.focus } : a ?? b;
}
const AS_COMPOSED_HAZE: WallpaperHazeComposition = { layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' };
const sameHaze = (a: WallpaperHazeComposition, b: WallpaperHazeComposition) =>
  a === b || (a.ink === b.ink && a.layers === b.layers && a.veil?.color === b.veil?.color && a.veil?.alpha === b.veil?.alpha
    && a.veil?.rx === b.veil?.rx && a.veil?.ry === b.veil?.ry && a.veil?.at.x === b.veil?.at.x && a.veil?.at.y === b.veil?.at.y);

/**
 * The pane's column of the Wallpaper, the haze's solid core around the column's centre, the head-line band across
 * the column, the same band at the window's middle, where Home stands its head lines, and the veil's reach: both
 * bands and the whole column, where cards come to rest as the page scrolls over the stationary picture.
 */
export function wallpaperToneRegions(frame: AtmosphereRect, geometry: NonNullable<AtmosphereStage['geometry']>): WallpaperToneRegions {
  const x = geometry.rect.x - frame.x;
  const focusX = (x + geometry.focus.x) / frame.width;
  const focusY = (geometry.rect.y - frame.y + geometry.focus.y) / frame.height;
  const core = WALLPAPER_HAZE_LAYERS[0]!;
  const half = core.ry * core.solid;
  const column = { x0: x / frame.width, x1: (x + geometry.rect.width) / frame.width };
  const band = { y0: focusY - half, y1: focusY + half };
  // The Wallpaper stays put while the page scrolls, so cards come to rest anywhere in the pane's column.
  const pane = { y0: (geometry.rect.y - frame.y) / frame.height, y1: (geometry.rect.y + geometry.rect.height - frame.y) / frame.height };
  const middle = 0.5;
  return {
    column: { ...column, y0: 0, y1: 1 },
    focus: { x0: focusX - core.rx * core.solid, x1: focusX + core.rx * core.solid, ...band },
    // Head lines stand across the whole column, edges included, at the haze core's height.
    heads: { ...column, ...band },
    look: { ...column, y0: middle - half, y1: middle + half },
    at: { x: (column.x0 + column.x1) / 2, y: middle },
    // The veil holds the head lines and the whole column the cards rest over, not only the band around the head lines.
    reach: { x: (column.x1 - column.x0) / 2, y: Math.max(Math.abs(focusY - middle) + half, middle - pane.y0, pane.y1 - middle) },
  };
}

/** The band belongs to the page: it scrolls with it. Only this leaf follows the scroll. */
function BandScroll(props: Readonly<{ stageId: number; children: React.ReactNode }>) {
  const y = useAtmosphereScrollY(props.stageId);
  return (
    <View style={{ transform: [{ translateY: -y }] }}>{props.children}</View>
  );
}


const styles = StyleSheet.create({
  window: { overflow: 'hidden' },
  pane: { position: 'absolute', overflow: 'hidden' },
});

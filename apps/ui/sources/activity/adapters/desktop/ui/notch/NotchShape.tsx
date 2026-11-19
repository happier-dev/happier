import * as React from 'react';
import {
  Pressable,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { happierSurfaceGradientWebStyle, happierSvgGradientStop } from '@happier-dev/plugin-ui/presentation';

import { resolveGlassNotchPaint } from '@/components/ui/glass/glassMaterial';
import { useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import { nonScrollingClipStyle } from '@/components/ui/surfaces/nonScrollingClip';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { buildGlassCastShadow, resolveBoxShadowPaintInsets } from '@/shadowElevation';

import type { DesktopActivityOverlayFrame } from '../../runtime/desktopActivityOverlayBridge';
import {
  buildNotchShoulderPath,
  resolveNotchCameraSeamStops,
  resolveNotchFootFinish,
  resolveNotchMaterialRect,
  resolveNotchPaintInsets,
  isNotchEdgeDock,
  isNotchVerticalDock,
  resolveNotchBodySize,
  resolveNotchCameraOffset,
  resolveNotchCorner,
  resolveNotchCornerMask,
  resolveNotchExtent,
  resolveNotchMetrics,
  resolveNotchShoulder,
  resolveNotchStatusRowShift,
  type NotchCameraBlock,
  type NotchDock,
  type NotchForm,
  type NotchGrowth,
  type NotchSize,
} from './notchShapeGeometry';
import { useNotchMotion, type NotchMotionTarget } from './useNotchMotion';

export type NotchPresentFrame = Readonly<{
  extent: NotchSize;
  cameraOffset: number;
  settled: boolean;
  /** Where the native material stands while the island rests. */
  material: ReturnType<typeof resolveNotchMaterialRect>;
  /** How far the island's cast shadow paints past it; native frames the window to hold it, input stays the island. */
  paintInsets: ReturnType<typeof resolveBoxShadowPaintInsets>;
}>;

export type NotchStandardLayout = Readonly<{
  /** The standard content's natural size, oriented for the dock. */
  size: NotchSize;
  /** Camera notch only: the content-sized wings either side of the camera block. */
  leadingWing: number;
  trailingWing: number;
}>;

const EMPTY_LAYOUT: NotchStandardLayout = {
  size: { width: 0, height: 0 },
  leadingWing: 0,
  trailingWing: 0,
};

/** Shoulder placement per dock: which side of the body it hangs off and how the base fillet mirrors. */
const SHOULDER_PLACEMENTS: Readonly<
  Record<
    'top' | 'left' | 'right',
    readonly [ShoulderPlacement, ShoulderPlacement]
  >
> = {
  top: [
    { side: { left: 'outside', top: 0 }, flipX: false, flipY: false },
    { side: { right: 'outside', top: 0 }, flipX: true, flipY: false },
  ],
  left: [
    { side: { top: 'outside', left: 0 }, flipX: true, flipY: true },
    { side: { bottom: 'outside', left: 0 }, flipX: true, flipY: false },
  ],
  right: [
    { side: { top: 'outside', right: 0 }, flipX: false, flipY: true },
    { side: { bottom: 'outside', right: 0 }, flipX: false, flipY: false },
  ],
};

type ShoulderPlacement = Readonly<{
  side: Readonly<
    Partial<Record<'left' | 'right' | 'top' | 'bottom', 'outside' | 0>>
  >;
  flipX: boolean;
  flipY: boolean;
}>;

const SHOULDER_UNIT_PATH = buildNotchShoulderPath(1);

/** The body casts `glass.castShadow`; its reach is read from that same recipe (it is one geometry in both themes). */
const CAST_SHADOW_PAINT_INSETS = resolveBoxShadowPaintInsets(buildGlassCastShadow(true));

function centredBodyOffset(size: number, centreOffset: number): ViewStyle['top'] {
  'worklet';
  // Resolve against the live containing block before React receives the resized WebView.
  // The desktop WebView supports calc(), which React Native's dimension type does not model.
  return `clamp(0px, calc(50% + ${centreOffset - size / 2}px), calc(100% - ${size}px))` as ViewStyle['top'];
}

/**
 * The island's plane paint (lab R6): the body fills with it, and every mark standing on the plane cuts its
 * needs-you dot's ring from it, so no ring reads as a darker halo on the plane.
 */
export function useNotchPlanePaint(): string {
  const { theme } = useUnistyles();
  const glassSettings = useGlassMaterialSettings();
  const glassEnvironment = useGlassRuntimeEnvironment();
  return React.useMemo(
    () => resolveGlassNotchPaint(theme.colors.overlay.stageImmersive, glassSettings, glassEnvironment),
    [theme.colors.overlay.stageImmersive, glassSettings, glassEnvironment],
  );
}

/**
 * The desktop notch: one island on every dock. Docked, it sits flush on its edge, square on that side,
 * with concave shoulders flowing into the edge and rounded free corners; Floating rounds every corner
 * and carries the floating cast shadow. It rests as a tip, stands at the standard size around its
 * content, and opens into the panel, growing away from its edge toward the display centre.
 *
 * The presentation reducer picks the form; native frames the window from the extent reported through
 * `onPresent` and says where the island sits in that window. Everything that
 * moves is a shared value: a transition renders nothing per frame.
 */
export function NotchShape(
  props: Readonly<{
    dock: NotchDock;
    form: NotchForm;
    growth: NotchGrowth;
    anchorOffset: Readonly<{ x: number; y: number }>;
    islandRect?: DesktopActivityOverlayFrame['islandRect'];
    camera: NotchCameraBlock | null;
    /**
     * The standard island's content, laid out at its natural size: the status row on Top and Floating,
     * the vertical strip on the sides. `onStandardLayout` must be wired to its measurement.
     */
    renderStandard: (
      onLayout: (layout: NotchStandardLayout) => void,
    ) => React.ReactNode;
    /** The open panel's content at the panel width; reports its natural height. */
    renderOpen: (
      params: Readonly<{
        includeStatusRow: boolean;
        maxHeight: number;
        onNaturalHeight: (height: number) => void;
      }>,
    ) => React.ReactNode;
    /** A direct click on the tip opens the island without the hover dwell. */
    onTipPress: () => void;
    tipAccessibilityLabel: string | undefined;
    /** The shape's own hit target reports pointer entry (Windows' WebView2 entry signal). */
    onPointerEnter?: () => void;
    onPresent: (frame: NotchPresentFrame) => Promise<void> | void;
    testID?: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const reduceMotion = useReducedMotionPreference();
  const windowSize = useWindowDimensions();
  const metrics = resolveNotchMetrics(theme);
  const paint = useNotchPlanePaint();
  const foot = resolveNotchFootFinish(resolveThemeSurfaceFinish(theme, 'floating'));
  const seam = resolveNotchCameraSeamStops(metrics.thickness);
  const seamId = `notch-seam-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const vertical = isNotchVerticalDock(props.dock);
  // On Top, and on Floating while it opens downward, the status row is the panel's first row and never
  // moves: the black grows around it (lab ntdock-G). Elsewhere the standard content gives way to the panel.
  const statusRowStays = !vertical && props.growth.y === 'down';

  const [standardLayout, setStandardLayout] =
    React.useState<NotchStandardLayout>(EMPTY_LAYOUT);
  const [panelNaturalHeight, setPanelNaturalHeight] = React.useState(0);
  const onStandardLayout = React.useCallback((layout: NotchStandardLayout) => {
    setStandardLayout((previous) =>
      previous.size.width === layout.size.width &&
      previous.size.height === layout.size.height &&
      previous.leadingWing === layout.leadingWing &&
      previous.trailingWing === layout.trailingWing
        ? previous
        : layout,
    );
  }, []);

  // A side dock is one thickness wide around its column of marks.
  const standardContent: NotchSize = vertical
    ? { width: Math.max(metrics.thickness, standardLayout.size.width), height: standardLayout.size.height }
    : { width: standardLayout.size.width, height: metrics.thickness };
  const statusRowOffset = statusRowStays ? metrics.thickness : 0;
  const panelHeight = panelNaturalHeight + statusRowOffset;
  const body = resolveNotchBodySize({
    form: props.form,
    dock: props.dock,
    metrics,
    camera: props.camera,
    content: standardContent,
    panelHeight,
    maxPanelHeight: null,
  });
  const shoulder = resolveNotchShoulder(props.form, props.dock, metrics, body);
  const corner = resolveNotchCorner(props.form, metrics, body);
  const cameraOffset = resolveNotchCameraOffset({
    form: props.form,
    camera: props.camera,
    leadingWing: standardLayout.leadingWing,
    trailingWing: standardLayout.trailingWing,
  });
  const extent = resolveNotchExtent(props.dock, body, shoulder);

  const target: NotchMotionTarget = {
    form: props.form,
    body,
    corner,
    shoulder,
    centre: {
      x:
        props.growth.x === null && props.form !== 'open'
          ? props.anchorOffset.x
          : 0,
      y:
        props.growth.y === null && props.form !== 'open'
          ? props.anchorOffset.y
          : 0,
    },
    standardShown: statusRowStays
      ? props.form !== 'tip'
      : props.form === 'standard',
    openShown: props.form === 'open',
  };

  const { onPresent } = props;
  const castsShadow = !isNotchEdgeDock(props.dock) || props.form === 'open';
  const paintInsets = resolveNotchPaintInsets(props.dock, castsShadow ? CAST_SHADOW_PAINT_INSETS : null);
  const present = React.useCallback(
    // Nothing is framed until the content has been measured: native needs a real extent.
    (settled: boolean) =>
      body.width > 0 && body.height > 0
        ? onPresent({ extent, cameraOffset, settled, material: resolveNotchMaterialRect(props.dock, body, extent, shoulder, corner, paintInsets), paintInsets })
        : undefined,
    // The frame is read when motion asks for it, never on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onPresent, extent.width, extent.height, body.width, body.height, cameraOffset, props.dock, shoulder, corner,
      paintInsets.top, paintInsets.right, paintInsets.bottom, paintInsets.left],
  );

  const motion = useNotchMotion({
    target,
    placementKey: props.dock,
    reduceMotion,
    present,
  });

  // A retained window can cover a previous frame or Extract flight. Lay out open
  // controls in the island that native accepts input for, even in a larger window.
  const openIsland = props.form === 'open' ? props.islandRect : undefined;
  const windowWidth = openIsland?.width ?? windowSize.width;
  const windowHeight = openIsland?.height ?? windowSize.height;
  const openShoulder = openIsland ? shoulder : 0;
  const growthX = props.growth.x;
  const growthY = props.growth.y;
  const padX = props.dock === 'top' ? 1 : 0;
  const padY = vertical ? 1 : 0;
  const floating = !isNotchEdgeDock(props.dock);
  const dock = props.dock;
  const anchorX = openIsland
    ? props.anchorOffset.x + (windowSize.width - openIsland.width) / 2 - openIsland.x
    : props.anchorOffset.x;
  const restWidth = standardLayout.size.width;
  const restCameraOffset = resolveNotchCameraOffset({
    form: 'standard',
    camera: props.camera,
    leadingWing: standardLayout.leadingWing,
    trailingWing: standardLayout.trailingWing,
  });
  const rowOpen = props.form === 'open';
  const openWidth = metrics.openWidth;

  // Native clamps the island to the display. Leave room for the edge shoulders.
  const bodyWidth = useDerivedValue(() =>
    openIsland
      ? Math.min(motion.width.value, Math.max(0, windowWidth - 2 * padX * openShoulder))
      : motion.width.value,
  );
  const bodyHeight = useDerivedValue(() =>
    windowHeight > 0
      ? Math.min(motion.height.value, Math.max(0, windowHeight - 2 * padY * openShoulder))
      : motion.height.value,
  );
  const shapeStyle = useAnimatedStyle(() => {
    const width = bodyWidth.value;
    const height = bodyHeight.value;
    const insetX = padX * motion.shoulder.value;
    const insetY = padY * motion.shoulder.value;
    return {
      width,
      height,
      left: growthX === 'right' ? insetX : growthX === 'left' ? 'auto' : centredBodyOffset(width, motion.centreX.value),
      right: growthX === 'left' ? insetX : 'auto',
      top: growthY === 'down' ? insetY : growthY === 'up' ? 'auto' : centredBodyOffset(height, motion.centreY.value),
      bottom: growthY === 'up' ? insetY : 'auto',
    } satisfies ViewStyle;
  });

  const mask = resolveNotchCornerMask(props.dock);
  const bodyStyle = useAnimatedStyle(() => {
    const radius = motion.corner.value;
    return {
      opacity: motion.islandOpacity.value,
      borderTopLeftRadius: mask.topLeft ? radius : 0,
      borderTopRightRadius: mask.topRight ? radius : 0,
      borderBottomLeftRadius: mask.bottomLeft ? radius : 0,
      borderBottomRightRadius: mask.bottomRight ? radius : 0,
    };
  });
  const shoulderStyle = useAnimatedStyle(() => ({
    width: motion.shoulder.value,
    height: motion.shoulder.value,
    opacity: motion.islandOpacity.value,
  }));
  function shoulderPosition(index: 0 | 1) {
    'worklet';
    const size = motion.shoulder.value;
    if (dock === 'top') {
      return { left: index === 0 ? -size : bodyWidth.value, top: 0 };
    }
    const top = index === 0 ? -size : bodyHeight.value;
    return { left: dock === 'left' ? 0 : bodyWidth.value - size, top };
  }
  const shoulderLeadingStyle = useAnimatedStyle(() => shoulderPosition(0));
  const shoulderTrailingStyle = useAnimatedStyle(() => shoulderPosition(1));

  // The status row stays put while the body grows around it; the strip/row fades on the other docks.
  const standardLayerStyle = useAnimatedStyle(() => {
    const width = bodyWidth.value;
    const translateX = statusRowStays
      ? resolveNotchStatusRowShift({
          growthX,
          width,
          openWidth,
          restWidth,
          anchorX,
          centreX: motion.centreX.value,
          restCameraOffset,
          open: rowOpen,
        })
      : 0;
    return {
      opacity: motion.standardOpacity.value,
      transform: [{ translateX }],
    };
  });
  const openLayerStyle = useAnimatedStyle(() => ({
    opacity: motion.openOpacity.value,
  }));
  const castShadow = castsShadow;
  const openMaxHeight = Math.max(0, windowHeight - statusRowOffset - 2 * padY * openShoulder);

  return (
    <View
      testID={props.testID}
      pointerEvents="box-none"
      style={openIsland ? {
        position: 'absolute',
        left: openIsland.x,
        top: openIsland.y,
        width: openIsland.width,
        height: openIsland.height,
      } : StyleSheet.absoluteFill}
    >
      <Animated.View pointerEvents="box-none" style={[styles.shape, shapeStyle]}>
        {SHOULDERS_FOR(props.dock).map((placement, index) => (
          <Animated.View
            key={index}
            pointerEvents="none"
            style={[
              styles.shoulder,
              shoulderStyle,
              index === 0 ? shoulderLeadingStyle : shoulderTrailingStyle,
            ]}
          >
            <Svg
              width="100%"
              height="100%"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              style={{
                transform: [
                  { scaleX: placement.flipX ? -1 : 1 },
                  { scaleY: placement.flipY ? -1 : 1 },
                ],
              }}
            >
              <Path d={SHOULDER_UNIT_PATH} fill={props.camera ? theme.colors.overlay.notch : paint} />
            </Svg>
          </Animated.View>
        ))}
        <Animated.View
          testID={props.testID ? `${props.testID}-body` : undefined}
          data-notch-dock={props.dock}
          data-notch-form={props.form}
          {...({ onPointerEnter: props.onPointerEnter } as Record<string, unknown>)}
          style={[
            StyleSheet.absoluteFill,
            styles.body,
            { backgroundColor: paint },
            castShadow ? styles.bodyCastShadow : null,
            bodyStyle,
          ]}
        >
          {props.form === 'open' && foot ? (
            <View
              testID={props.testID ? `${props.testID}-foot` : undefined}
              pointerEvents="none"
              style={[styles.foot, { height: foot.band.height }, happierSurfaceGradientWebStyle(foot) as object]}
            />
          ) : null}
          {floating || props.form === 'open' ? (
            // The app's rim, its light in the corner free of the screen edge. A side against the edge runs
            // past the window, so it carries no line.
            <View
              testID={props.testID ? `${props.testID}-rim` : undefined}
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, props.dock === 'top' ? { top: -corner } : props.dock === 'left' ? { left: -corner } : props.dock === 'right' ? { right: -corner } : null]}
            >
              <SurfaceRim role="floating" radius={corner} border="default" anchor="bottom-left" />
            </View>
          ) : null}
          {props.camera ? (
            // Over the hairline, which so fades in below the black row.
            <View
              testID={props.testID ? `${props.testID}-seam` : undefined}
              pointerEvents="none"
              style={[styles.seam, { height: seam.height }]}
            >
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={seamId} x1={0} y1={0} x2={0} y2={1}>
                    {seam.stops.map((stop) => (
                      <Stop key={stop.offset} offset={stop.offset} {...happierSvgGradientStop(theme.colors.overlay.notch, stop.alpha)} />
                    ))}
                  </LinearGradient>
                </Defs>
                <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${seamId})`} />
              </Svg>
            </View>
          ) : null}
          <Animated.View
            pointerEvents={props.form === 'open' ? 'auto' : 'none'}
            style={[
              styles.openLayer,
              growthY === 'up'
                ? styles.openLayerFromBottom
                : styles.openLayerFromTop,
              { paddingTop: statusRowOffset, width: metrics.openWidth },
              openLayerStyle,
            ]}
          >
            {props.renderOpen({
              includeStatusRow: !statusRowStays,
              maxHeight: openMaxHeight,
              onNaturalHeight: setPanelNaturalHeight,
            })}
          </Animated.View>
          <Animated.View
            pointerEvents={props.form === 'tip' ? 'none' : 'box-none'}
            style={[
              styles.standardLayer,
              vertical ? styles.standardLayerVertical : null,
              props.dock === 'right' ? styles.standardLayerRight : null,
              growthY === 'up' && !statusRowStays
                ? styles.standardLayerFromBottom
                : null,
              standardLayerStyle,
            ]}
          >
            {props.renderStandard(onStandardLayout)}
          </Animated.View>
        </Animated.View>
      </Animated.View>
      {props.form === 'tip' ? (
        <Pressable
          testID={props.testID ? `${props.testID}-tip` : undefined}
          accessibilityRole="button"
          accessibilityLabel={props.tipAccessibilityLabel}
          onPress={props.onTipPress}
          {...({ onPointerEnter: props.onPointerEnter } as Record<string, unknown>)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

function SHOULDERS_FOR(dock: NotchDock): readonly ShoulderPlacement[] {
  return isNotchEdgeDock(dock) ? SHOULDER_PLACEMENTS[dock] : [];
}

/** Reads a measured layout from a layout event; one helper so the row and strip report the same way. */
export function readNotchLayoutSize(event: LayoutChangeEvent): NotchSize {
  return {
    width: event.nativeEvent.layout.width,
    height: event.nativeEvent.layout.height,
  };
}

const styles = StyleSheet.create((theme) => ({
  shape: {
    position: 'absolute',
  },
  shoulder: {
    position: 'absolute',
  },
  // The island clips without scrolling: a scrolled island would draw its panel off the planner's rect.
  body: {
    ...nonScrollingClipStyle(),
  },
  foot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  seam: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
  },
  bodyCastShadow: {
    boxShadow: theme.colors.glass.castShadow,
  },
  openLayer: {
    position: 'absolute',
    left: 0,
  },
  openLayerFromTop: {
    top: 0,
  },
  openLayerFromBottom: {
    bottom: 0,
  },
  standardLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  standardLayerVertical: {
    top: 0,
  },
  standardLayerRight: {
    left: undefined,
    right: 0,
  },
  standardLayerFromBottom: {
    top: undefined,
    bottom: 0,
  },
}));

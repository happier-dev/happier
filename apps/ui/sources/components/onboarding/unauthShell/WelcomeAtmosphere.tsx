import {
  glyphFieldDurationS,
  homeFieldStrength,
  planetGlyphLayer,
  type GlyphLayer,
} from '@happier-dev/brand/glyph-scene';
import {
  interpolateWelcomePlanetPose,
  welcomePlanetPose,
  type WelcomePlanetGeometry,
  type WelcomePlanetState,
} from '@happier-dev/brand/planet-placement';
import * as React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  GlyphSurface,
  type GlyphMotion,
  type GlyphSurfaceReadiness,
} from '@/components/atmosphere/glyph/GlyphSurface';
import { useHomeGlyphField } from '@/components/atmosphere/glyph/useHomeGlyphField';
import { easeInOutCubic } from '@/components/ui/motion/stepMotion/stepMotionChoreography';
import { stepMotionTiming } from '@/components/ui/motion/stepMotion/stepMotionTiming';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { FirstOpenOwnsWelcomePaint, FirstOpenWelcomeEpoch } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';

type WelcomePoseMove = Readonly<{ from: WelcomePlanetGeometry; startS: number }>;

function sampleWelcomePose(move: WelcomePoseMove, target: WelcomePlanetGeometry, seconds: number) {
  const progress = easeInOutCubic((seconds - move.startS) / stepMotionTiming.forwardS);
  return interpolateWelcomePlanetPose(move.from, target, progress);
}

/**
 * Direction A's background (owner 2026-11-19): the one glyph planet in the step's welcome pose (`welcomePlanetPose`)
 * under the website's living dot field, behind the centred column on every signed-out step. Both draw through plan
 * 01's renderer and share the field's calm clock. The step pose moves with that clock and holds when settled.
 */
export const WelcomeAtmosphere = React.memo(function WelcomeAtmosphere(
  props: Readonly<{
    state: WelcomePlanetState;
    stepId: string;
    phone: boolean;
    host: React.RefObject<View | null>;
    nativeTap: React.RefObject<((x: number, y: number) => void) | null>;
    quietColumn: Readonly<{ x: number; width: number }> | null;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const viewed = useHostActivelyViewed();
  const arrivalEpoch = React.useContext(FirstOpenWelcomeEpoch);
  const openingPaints = React.useContext(FirstOpenOwnsWelcomePaint);
  const [pane, setPane] = React.useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPane((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);
  const geometry = React.useMemo(
    () =>
      pane
        ? welcomePlanetPose(props.state, pane, { phone: props.phone })
        : null,
    [pane, props.phone, props.state],
  );
  const quiet = React.useMemo(() => pane && props.quietColumn ? [{
    ...props.quietColumn,
    y: 0,
    height: pane.height,
    ...(props.phone && { level: 0.55 }),
  }] : undefined, [pane, props.phone, props.quietColumn]);
  // The hidden native destination keeps a painted Still frame ready for the swap.
  const mode = !pane || openingPaints ? 'off' : reducedMotion || !viewed || arrivalEpoch !== null ? 'still' : 'animated';
  const { layer: fieldLayer, epoch, readDurationS, settle, stir } = useHomeGlyphField({
    mode,
    arriving: false,
    host: props.host,
    nativeTap: props.nativeTap,
    quiet,
    // The website's quiet stipple: the Quiet planet's field strength.
    strength: homeFieldStrength('quiet', { phone: props.phone }),
    planet: geometry ?? undefined,
  });
  const lastStep = React.useRef<Readonly<{
    geometry: typeof geometry;
    stepId: string;
    state: WelcomePlanetState;
    pane: typeof pane;
    phone: boolean;
  }> | null>(null);
  const poseMove = React.useRef<WelcomePoseMove | null>(null);
  React.useLayoutEffect(() => {
    const previous = lastStep.current;
    lastStep.current = { geometry, stepId: props.stepId, state: props.state, pane, phone: props.phone };
    const samePane = previous !== null && previous.pane === pane && previous.phone === props.phone;
    if (!samePane || mode !== 'animated' || arrivalEpoch !== null) poseMove.current = null;
    if (!geometry || !previous?.geometry || mode !== 'animated' || arrivalEpoch !== null) return;

    const poseChanged = previous.state !== props.state;
    if (previous.stepId === props.stepId && !poseChanged) return;
    const startS = stir();
    if (startS === null || !poseChanged || !samePane) return;
    const from = poseMove.current ? sampleWelcomePose(poseMove.current, previous.geometry, startS) : previous.geometry;
    poseMove.current = { from, startS };
  }, [arrivalEpoch, geometry, mode, pane, props.phone, props.state, props.stepId, stir]);
  const settlePoseAndField = React.useCallback(() => {
    poseMove.current = null;
    settle();
  }, [settle]);
  const scene = React.useMemo(() => {
    if (!geometry) return [];
    const planet = planetGlyphLayer({
      geometry,
      digits: true,
      soft: props.phone,
    });
    return (seconds: number, readiness?: GlyphSurfaceReadiness) => {
      const pose = poseMove.current && readiness !== 'still' ? sampleWelcomePose(poseMove.current, geometry, seconds) : geometry;
      const layers: GlyphLayer[] = [];
      const dots = fieldLayer(seconds, pose);
      if (dots) layers.push(dots);
      layers.push(pose === geometry ? planet : planetGlyphLayer({ ...planet, geometry: pose }));
      return layers;
    };
  }, [fieldLayer, geometry, props.phone]);
  const motion = React.useMemo<GlyphMotion>(
    () =>
      epoch === null || mode !== 'animated'
        ? null
        : {
            kind: 'field-calm',
            epoch,
            durationS: glyphFieldDurationS,
            readDurationS,
            onSettled: settlePoseAndField,
          },
    [epoch, mode, readDurationS, settlePoseAndField],
  );
  return (
    <View
      testID="welcome-atmosphere"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={onLayout}
    >
      {!openingPaints && pane && geometry ? (
        <GlyphSurface
          width={pane.width}
          height={pane.height}
          scene={scene}
          theme={theme.dark ? 'dark' : 'light'}
          motion={motion}
          warmWhenHidden={arrivalEpoch !== null}
          testID="welcome-planet"
        />
      ) : null}
    </View>
  );
});

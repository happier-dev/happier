import {
  glyphFieldDurationS,
  homeFieldStrength,
  planetGlyphLayer,
  type GlyphLayer,
} from '@happier-dev/brand/glyph-scene';
import {
  welcomePlanetPose,
  type WelcomePlanetState,
} from '@happier-dev/brand/planet-placement';
import * as React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  GlyphSurface,
  type GlyphMotion,
} from '@/components/atmosphere/glyph/GlyphSurface';
import { useHomeGlyphField } from '@/components/atmosphere/glyph/useHomeGlyphField';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { FirstOpenWelcomeEpoch } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';

/**
 * Direction A's background (owner 2026-11-19): the one glyph planet in the step's welcome pose (`welcomePlanetPose`)
 * under the website's living dot field, behind the centred column on every signed-out step. Both draw through plan
 * 01's renderer; the field calms on its own clock and the planet holds still, so a settled welcome schedules no frames.
 * Hidden or reduced motion keeps the still field.
 */
export const WelcomeAtmosphere = React.memo(function WelcomeAtmosphere(
  props: Readonly<{
    state: WelcomePlanetState;
    phone: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const viewed = useHostActivelyViewed();
  const arrivalEpoch = React.useContext(FirstOpenWelcomeEpoch);
  const host = React.useRef<View | null>(null);
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
  const field = useHomeGlyphField({
    mode: !pane ? 'off' : reducedMotion || (!viewed && arrivalEpoch === null) ? 'still' : 'animated',
    arriving: arrivalEpoch !== null,
    arrivalEpoch: arrivalEpoch ?? undefined,
    host,
    // The website's quiet stipple: the Quiet planet's field strength.
    strength: homeFieldStrength('quiet', { phone: props.phone }),
    planet: geometry ?? undefined,
  });
  const { layer: fieldLayer, epoch, readDurationS, settle } = field;
  const scene = React.useMemo(() => {
    if (!geometry) return [];
    const planet = planetGlyphLayer({
      geometry,
      intensity: 'quiet',
      digits: true,
      soft: props.phone,
    });
    return (seconds: number) => {
      const layers: GlyphLayer[] = [];
      const dots = fieldLayer(seconds);
      if (dots) layers.push(dots);
      layers.push(planet);
      return layers;
    };
  }, [fieldLayer, geometry, props.phone]);
  const motion = React.useMemo<GlyphMotion>(
    () =>
      epoch === null
        ? null
        : {
            kind: 'field-calm',
            epoch,
            durationS: glyphFieldDurationS,
            readDurationS,
            onSettled: settle,
          },
    [epoch, readDurationS, settle],
  );
  return (
    <View
      ref={host}
      testID="welcome-atmosphere"
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      onLayout={onLayout}
    >
      {pane && geometry ? (
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

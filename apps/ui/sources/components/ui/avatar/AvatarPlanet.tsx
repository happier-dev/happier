import * as React from 'react';
import { PixelRatio } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  createPlanetScene,
  planetLightForProgress,
} from '@happier-dev/brand/planet';

import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { botFaceHash } from '@/components/sessions/bots/face/botFaceGeometry';
import { botFaceSeedNumber } from '@/components/sessions/bots/face/botFaceIdentity';

/** The planet's share of its box: a whole moon with the Brand lattice's own edge, as the Usage moons draw it. */
const PLANET_RADIUS_RATIO = 0.46;

/**
 * The generic Planet avatar (Account `avatarStyle: planet`): the app's flat Brand planet, still, seeded by the id
 * for its band tilt and light, drawn by the canonical PlanetCanvas. No face, notch or motion: those are a Bot's.
 */
export const AvatarPlanet = React.memo(function AvatarPlanet(
  props: Readonly<{
    id: string;
    size?: number;
    monochrome?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const size = props.size ?? 48;
  const dpr = PixelRatio.get();
  const dots = React.useMemo(() => {
    // One seed reading for every seeded identity picture (the Bot faces use the same).
    const seed = botFaceSeedNumber(props.id);
    const { body, haze } = createPlanetScene({
      theme: theme.dark ? 'dark' : 'light',
      R: size * PLANET_RADIUS_RATIO,
      cx: size / 2,
      cy: size / 2,
      view: { w: size, h: size },
      dpr,
      rotate: (botFaceHash(seed, 3) - 0.5) * 0.9,
      mirror: false,
      fullness: 0.85,
      halo: 0,
      tail: 0,
      style: 'balanced',
      field: { around: 0, over: 0 },
      light: planetLightForProgress(0.84 + 0.16 * botFaceHash(seed, 5)),
    });
    return [...body, ...haze];
  }, [dpr, props.id, size, theme.dark]);
  return (
    <PlanetCanvas
      width={size}
      height={size}
      dots={dots}
      {...(props.monochrome ? { ink: theme.colors.text.tertiary } : {})}
    />
  );
});

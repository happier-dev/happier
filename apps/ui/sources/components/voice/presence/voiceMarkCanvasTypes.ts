import type { SharedValue } from 'react-native-reanimated';

import type { PlanetMarkGeometry } from '@happier-dev/brand/planet';

/** What both platform renderers draw from: two poses of one lattice and four live values. */
export type VoiceMarkCanvasProps = Readonly<{
    to: PlanetMarkGeometry;
    /** The pose being left; equal to `to` once a pose change has settled. */
    from: PlanetMarkGeometry;
    /** 0 rest microphone … 1 planet. */
    morph: SharedValue<number>;
    /** 0 `from` pose … 1 `to` pose. */
    pose: SharedValue<number>;
    /** Real audio level 0..1 from the energy owner; held at 0 when reduced motion is on. */
    energy: SharedValue<number>;
    /** < 0 the person is heard, > 0 Voice speaks. */
    flow: SharedValue<number>;
}>;

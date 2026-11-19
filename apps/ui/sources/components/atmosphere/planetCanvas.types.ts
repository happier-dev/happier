import type { StyleProp, ViewStyle } from 'react-native';
import type { PlanetDotOptions, PlanetScene, PlanetSceneOptions } from '@happier-dev/brand/planet';

/** CSS/logical pixels on both platforms. Scene data is never shaded by a drawing layer. */
export type PlanetCanvasProps = Readonly<{
    width: number;
    height: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    onReady?: () => void;
    onError?: (error: Error) => void;
    /** One ink for every dot (a planet drawn in an Agent's identity colour); absent keeps the Brand palette. */
    ink?: string;
}> & (
    | Readonly<{ options: PlanetSceneOptions; scene?: never; mark?: never }>
    | Readonly<{ scene: PlanetScene; options?: never; mark?: never }>
    // Existing SceneArt/stat cards retain the released mark lattice and art calibration.
    | Readonly<{ mark: PlanetDotOptions & { radiusScale?: number; ink?: string; opacityScale?: number }; options?: never; scene?: never }>
);

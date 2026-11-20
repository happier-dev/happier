import type { StyleProp, ViewStyle } from 'react-native';
import type { PlanetCanvasMark, PlanetMarkDot } from './planetCanvasDots';

/** Draws a Brand mark or prepared artwork dots in CSS/logical pixels. */
export type PlanetCanvasProps = Readonly<{
    width: number;
    height: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** One ink for every dot (a planet drawn in an Agent's identity colour); absent keeps the Brand palette. */
    ink?: string;
}> & (
    | Readonly<{ dots: readonly PlanetMarkDot[]; mark?: never }>
    | Readonly<{ mark: PlanetCanvasMark; dots?: never }>
);

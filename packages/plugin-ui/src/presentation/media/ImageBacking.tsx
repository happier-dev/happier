import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { Svg, Defs, Pattern, Rect } from 'react-native-svg';

/** One checker square of the transparency board (lab files FV4a: 8 px ink squares). */
const CHECKER_PX = 8;

/** The transparency board of every picture well: ink squares at two faint steps, drawn behind the picture. */
export function HappierImageCheckerboard(props: Readonly<{ color: string; testID?: string }>): ReactElement {
  return (
    <Svg
      {...(props.testID ? { testID: props.testID } : {})}
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Defs>
        <Pattern
          id="image-well-checker"
          width={CHECKER_PX * 2}
          height={CHECKER_PX * 2}
          patternUnits="userSpaceOnUse"
        >
          <Rect width={CHECKER_PX * 2} height={CHECKER_PX * 2} fill={props.color} fillOpacity={0.04} />
          <Rect width={CHECKER_PX} height={CHECKER_PX} fill={props.color} fillOpacity={0.08} />
          <Rect x={CHECKER_PX} y={CHECKER_PX} width={CHECKER_PX} height={CHECKER_PX} fill={props.color} fillOpacity={0.08} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#image-well-checker)" />
    </Svg>
  );
}

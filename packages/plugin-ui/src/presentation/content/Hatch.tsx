import { Path, Pattern, Defs, Rect, Svg } from 'react-native-svg';
import { useId } from 'react';
import type { HappierUiTheme } from '../../environment/types.js';

/** A neutral source texture; the caller supplies its meaning in visible/exact text. */
export function HappierDataHatch(props: Readonly<{ theme: HappierUiTheme; color?: string }>) {
  const id = `hatch-${useId().replace(/[^a-z0-9]/giu, '')}`;
  const step = props.theme.spacing.small;
  return <Svg width="100%" height="100%" aria-hidden accessible={false}>
    <Defs><Pattern id={id} width={step} height={step} patternUnits="userSpaceOnUse">
      <Path d={`M-${step / 2},${step / 2} L${step / 2},-${step / 2} M0,${step} L${step},0 M${step / 2},${step * 1.5} L${step * 1.5},${step / 2}`}
        stroke={props.color ?? props.theme.colors.secondaryText} strokeWidth={1} />
    </Pattern></Defs>
    <Rect width="100%" height="100%" fill={`url(#${id})`} />
  </Svg>;
}

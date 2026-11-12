import { Path, Pattern, Defs, Rect } from 'react-native-svg';
import { useId } from 'react';
import { HappierDecorativeSvg as Svg } from './DecorativeSvg.js';
import type { HappierUiTheme } from '../../environment/types.js';

/**
 * A neutral source texture; the caller supplies its meaning in visible/exact text.
 * `density="fine"` is for marks too thin for the regular pitch (an inline bar): the same hatch at a closer
 * pitch (between the two smallest spacing steps), so several lines always cross the mark and it reads as hatched instead of as an outline.
 */
export function HappierDataHatch(props: Readonly<{ theme: HappierUiTheme; color?: string; density?: 'regular' | 'fine' }>) {
  const id = `hatch-${useId().replace(/[^a-z0-9]/giu, '')}`;
  const step = props.density === 'fine'
    ? (props.theme.spacing.xsmall + props.theme.spacing.small) / 2
    : props.theme.spacing.small;
  return <Svg width="100%" height="100%">
    <Defs><Pattern id={id} width={step} height={step} patternUnits="userSpaceOnUse">
      <Path d={`M-${step / 2},${step / 2} L${step / 2},-${step / 2} M0,${step} L${step},0 M${step / 2},${step * 1.5} L${step * 1.5},${step / 2}`}
        stroke={props.color ?? props.theme.colors.secondaryText} strokeWidth={1} />
    </Pattern></Defs>
    <Rect width="100%" height="100%" fill={`url(#${id})`} />
  </Svg>;
}

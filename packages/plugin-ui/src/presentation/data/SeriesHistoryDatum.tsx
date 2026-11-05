import { useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { resolvePointerClientPoint } from '../layout/resize/resolvePointerClientPoint.js';
import { ChartDatum, type HappierChartDatum, type HappierChartDatumInteraction } from './ChartDatum.js';
import type { HappierSeriesBucket } from './dataModel.js';

/** Pointer movement updates only the inspected datum, never the history's ink or full projections. */
export function SeriesHistoryDatum(props: Readonly<{
  enabled: boolean;
  buckets: readonly HappierSeriesBucket[];
  selectedIndex: number;
  indexAt: (x: number) => number | null;
  datumOf: (bucket: HappierSeriesBucket) => HappierChartDatum;
  renderControl: (interaction?: HappierChartDatumInteraction, onKeyboardUse?: () => void) => ReactNode;
  width: number;
  height: number;
  testID?: string;
}>) {
  const surface = useRef<View>(null);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const style = { position: 'absolute' as const, left: 0, top: 0, width: props.width, height: props.height };
  if (!props.enabled) return <View style={style}>{props.renderControl()}</View>;
  const index = pointerX === null ? props.selectedIndex : props.indexAt(pointerX) ?? props.selectedIndex;
  const bucket = props.buckets[index];
  if (!bucket) return null;
  const move = (event: unknown) => {
    const client = resolvePointerClientPoint(event);
    // RNW supplies a DOM View; native selection retains the existing press/accessibility control.
    const element = surface.current as (View & { getBoundingClientRect?: () => { left: number } }) | null;
    const left = element?.getBoundingClientRect?.().left;
    if (client.x !== null && left !== undefined) setPointerX(client.x - left);
  };
  return <View ref={surface} style={style} onPointerMove={move} onPointerEnter={move}>
    <ChartDatum datum={props.datumOf(bucket)} testID={props.testID} renderTrigger={interaction => props.renderControl({
      onHoverChange: hovered => { if (!hovered) setPointerX(null); interaction.onHoverChange(hovered); },
      onFocusChange: focused => { if (focused) setPointerX(null); interaction.onFocusChange(focused); },
      onPress: () => { setPointerX(null); interaction.onPress(); },
    }, () => setPointerX(null))}><View /></ChartDatum>
  </View>;
}

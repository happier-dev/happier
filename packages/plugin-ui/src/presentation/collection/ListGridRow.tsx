import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';

/** One primary cell at one depth, whether a row's independent accessory is beside it, inside it or absent. */
export function ListGridRow(props: Readonly<{
  children: ReactNode;
  primaryStyle: HappierStyleProp;
  accessory: ReactNode;
}>): ReactElement {
  return (
    <>
      {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
      <View role="gridcell" style={props.primaryStyle}>{props.children}</View>
      {props.accessory}
    </>
  );
}

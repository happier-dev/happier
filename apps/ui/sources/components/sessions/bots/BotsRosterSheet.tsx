import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import type { CustomModalInjectedProps } from '@/modal/types';

import { BotsPopoverContent } from './BotsPopoverContent';

/** The same roster as the rail's popover, as a bottom sheet where there is no rail (phones, narrow windows). */
export function BotsRosterSheet(props: CustomModalInjectedProps) {
  const { height } = useWindowDimensions();
  return (
    <BotsPopoverContent
      close={props.onClose}
      maxHeight={Math.round(height * 0.8)}
      presentation="sheet"
    />
  );
}

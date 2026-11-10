import * as React from 'react';
import { View } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';

/**
 * The one place a floating banner stands at the top of a transcript (the older-page continuation and its
 * failure): on the page's box edge, as every card and sheet does, at a readable width.
 */
export function TranscriptTopBannerSlot(
  props: Readonly<{ testID: string; children: React.ReactNode }>,
) {
  return (
    <View
      testID={props.testID}
      // `box-none` so the banner stays pressable while the surrounding overlay area
      // keeps passing scroll gestures through to the list underneath.
      pointerEvents="box-none"
      style={SLOT_STYLE}
    >
      <View style={BANNER_STYLE}>{props.children}</View>
    </View>
  );
}

const SLOT_STYLE = {
  alignItems: 'center',
  left: 0,
  paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
  position: 'absolute',
  right: 0,
  top: TRANSCRIPT_TOP_GUTTER_PX,
  zIndex: 2,
} as const;

const BANNER_STYLE = { width: '100%', maxWidth: 560 } as const;

import * as React from 'react';

import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';

import { WidgetFrameBodyRowsContext } from './widgetFrameBody';

/** A tall card keeps its room with space, not with a wall of placeholder rows. */
const WIDGET_FRAME_LOADING_MAX_ROWS = 3;

/**
 * The frame's one first-load body (lab `dagent` ST "Loading · first time only"): the header shows at
 * once and quiet rows keep the card's room. Used by the frame's own `loading` body and by content that
 * is still arriving inside a frame (an installed widget's plugin view on its first load), so a card never
 * has two loading looks and never stands empty.
 */
export function WidgetFrameLoadingBody(
  props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    rows?: number;
  }>,
) {
  const frameRows = React.useContext(WidgetFrameBodyRowsContext);
  return (
    <ItemLoadStateRows
      testID={props.testID}
      state={{ kind: 'loading' }}
      rows={Math.max(
        1,
        Math.min(
          props.rows ?? frameRows ?? WIDGET_FRAME_LOADING_MAX_ROWS,
          WIDGET_FRAME_LOADING_MAX_ROWS,
        ),
      )}
      lines={2}
      shape="list"
      accessibilityLabel={props.accessibilityLabel}
    />
  );
}

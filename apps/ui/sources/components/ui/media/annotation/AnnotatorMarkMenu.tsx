import * as React from 'react';

import { Popover, type PopoverAnchor } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { t } from '@/text';

import { AnnotatorColorRow } from './AnnotatorColorPopover';
import type { ImageAnnotator } from './annotatorStore';
import { useImageAnnotatorState } from './useImageAnnotator';

/**
 * Long-press on a mark (MIS §3.2): Delete, Duplicate, and its colour, by the finger. One menu for the phone's
 * Skia canvas and the web canvas on a touch screen. `at` is where the finger is, in window coordinates (the
 * popover's point anchor), and null closes it; it stays mounted so it opens from closed.
 */
export function AnnotatorMarkMenu(props: Readonly<{
  annotator: ImageAnnotator;
  at: Readonly<{ x: number; y: number }> | null;
  onClose: () => void;
}>) {
  const { annotator } = props;
  const style = useImageAnnotatorState(annotator, (state) => state.style);
  const last = React.useRef(props.at);
  if (props.at) last.current = props.at;
  const point = last.current ?? { x: 0, y: 0 };
  const anchor = React.useMemo<PopoverAnchor>(
    () => ({ kind: 'rect', rect: { left: point.x, top: point.y, height: 1 }, coordinateSpace: 'window' }),
    [point.x, point.y],
  );
  return (
    <Popover open={props.at !== null} anchor={anchor} onRequestClose={props.onClose} placement="top" portal={{ native: true, web: true, matchAnchorWidth: false, anchorAlign: 'center', sizeToContent: true }}>
      {({ maxHeight }) => (
        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
          <SelectableRow presentation="menu" title={t('common.duplicate')} onPress={() => { annotator.duplicateSelection(); props.onClose(); }} testID="annotator-menu-duplicate" />
          <SelectableRow presentation="menu" title={t('common.delete')} onPress={() => { annotator.deleteSelection(); props.onClose(); }} testID="annotator-menu-delete" />
          <AnnotatorColorRow color={style.color} size={style.size} onColor={(color) => annotator.setStyle({ color })} onSize={(size) => annotator.setStyle({ size })} />
        </FloatingOverlay>
      )}
    </Popover>
  );
}

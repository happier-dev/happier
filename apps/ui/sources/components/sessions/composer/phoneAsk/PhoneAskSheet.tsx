import * as React from 'react';
import { Animated, type LayoutChangeEvent } from 'react-native';

import type { SessionComposerModel } from '@/components/sessions/composer/sessionComposerModel';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import {
  SheetGrabber,
  useSheetDrag,
} from '@/modal/components/card/sheetDragDismiss';

import { usePhoneAskSheetFrameReport } from './PhoneAskSheetFrame';
import { usePhoneAskSheet } from './phoneAskSheetState';

/**
 * The phone Ask sheet (P5 §3.9, lab ask Ap): the Session screen's one composer, in place. Open, the phone cockpit
 * raises the whole Chat scene over the File page and shows it through the sheet window (`PhoneAskSheetFrame`);
 * this slot adds the grabber, reports the sheet's height and follows a downward drag. The composer, already
 * holding the quote chip the Ask saved, never moves or remounts: Send is its own, and the sheet collapses to the
 * working capsule when that submission starts.
 */
export function PhoneAskSheet(
  props: Readonly<{ composer: SessionComposerModel }>,
): React.ReactElement {
  const sheet = usePhoneAskSheet();
  const report = usePhoneAskSheetFrameReport();
  const keyboard = useComposerKeyboardLayout();
  const { composer } = props;
  const open = sheet?.phase === 'open';
  const close = open ? sheet.close : null;
  const drag = useSheetDrag(close);

  // The person asked; put the caret in the composer once per opening (not on every composer refresh).
  const focusRef = React.useRef(composer.focus);
  focusRef.current = composer.focus;
  React.useEffect(() => {
    if (open) focusRef.current();
  }, [open]);

  // Send started from the sheet: hand the turn to the working capsule.
  const sending = composer.sending;
  const sentRef = React.useRef(sending);
  React.useEffect(() => {
    const started = sending && !sentRef.current;
    sentRef.current = sending;
    if (started && open) sheet?.sent();
  }, [open, sending, sheet]);

  // The window is as tall as this slot plus the composer's keyboard lift (the composer's own geometry owner).
  const lift = keyboard?.bottomInset ?? null;
  const onDragLayout = drag.onLayout;
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      onDragLayout(event);
      report?.({ height: event.nativeEvent.layout.height, lift });
    },
    [lift, onDragLayout, report],
  );

  // One parent in every phase, so the composer keeps its node (and its draft, focus and handlers).
  return (
    <Animated.View
      testID={open ? 'phone-ask-sheet.slot' : undefined}
      onLayout={open ? onLayout : undefined}
      style={open ? { transform: [{ translateY: drag.offset }] } : null}
    >
      {close ? (
        <SheetGrabber
          panHandlers={drag.panHandlers}
          testID="phone-ask-sheet.grabber"
        />
      ) : null}
      {composer.content}
    </Animated.View>
  );
}

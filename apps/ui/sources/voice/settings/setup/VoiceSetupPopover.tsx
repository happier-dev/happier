import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import type { VoiceAttemptIdleTarget } from '@/components/voice/attempt/useVoiceAttemptControl';
import { setVoiceSetupOpen } from '@/components/voice/presence/voiceCompanionSectionReveal';
import { t } from '@/text';

import { useVoiceSetupBlock } from './VoiceSetupItem';

/** Lab T1's card width; it narrows to the window, and a phone gets the sheet instead. */
const VOICE_SETUP_POPOVER_WIDTH = 440;
const EDGE = 12;
const VOICE_SETUP_POPOVER_MAX_HEIGHT = 640;

/**
 * "Set up voice" unfolded in place from the composer mark (lab `voice-moments` T1): the same setup
 * steps Home and Settings → Voice grow into, anchored above the composer so the first tap never leaves
 * the session. On a phone it is the app's bottom sheet. Its panel mounts only while it is open.
 */
export const VoiceSetupPopover = React.memo(function VoiceSetupPopover(
  props: Readonly<{
    open: boolean;
    /** The composer's idle target: setup's Try starts this conversation (lab T1). */
    target: VoiceAttemptIdleTarget;
    /** What the popover sits above: the composer card, so it never covers the text being written. */
    anchorRef: React.RefObject<View | null>;
    /** The mark that opened it; focus returns there on close. */
    focusReturnRef: React.RefObject<View | null>;
    onRequestClose: () => void;
  }>,
): React.ReactElement | null {
  if (!props.open) return null;
  return (
    <OpenVoiceSetupPopover
      target={props.target}
      anchorRef={props.anchorRef}
      focusReturnRef={props.focusReturnRef}
      onRequestClose={props.onRequestClose}
    />
  );
});

function OpenVoiceSetupPopover(
  props: Readonly<{
    target: VoiceAttemptIdleTarget;
    anchorRef: React.RefObject<View | null>;
    focusReturnRef: React.RefObject<View | null>;
    onRequestClose: () => void;
  }>,
): React.ReactElement | null {
  const item = useVoiceSetupBlock({ layout: 'wide', inPlace: true, attemptTarget: props.target });
  const register = React.useRef(item?.registerPresentation);
  register.current = item?.registerPresentation;
  const requestClose = React.useRef(props.onRequestClose);
  requestClose.current = props.onRequestClose;
  const present = item?.renderPanel !== undefined;

  // Borrow setup's open/close for this popover while it is open, so the panel's own close, Done and
  // the setup Actions act on it; opening marks the panel open (every service, a live machine check).
  React.useLayoutEffect(() => {
    if (!present) return undefined;
    const dispose = register.current?.({
      open: () => true,
      close: () => {
        requestClose.current();
        return true;
      },
    });
    setVoiceSetupOpen(true);
    return dispose;
  }, [present]);

  if (!item?.renderPanel) return null;
  const panel = item.renderPanel({ close: props.onRequestClose });
  return (
    <Popover
      open
      phonePresentation="sheet"
      sheetHeader="none"
      sheetMaterial="solid"
      accessibilityLabel={t('voiceMoments.setupTitle')}
      autoFocusOnOpen
      anchorRef={props.anchorRef}
      focusReturnRef={props.focusReturnRef}
      boundaryRef={null}
      placement="top"
      gap={8}
      edgePadding={{ horizontal: EDGE, vertical: EDGE }}
      portal={{
        web: { target: 'body' },
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
      maxWidthCap={VOICE_SETUP_POPOVER_WIDTH + 2 * EDGE}
      maxHeightCap={VOICE_SETUP_POPOVER_MAX_HEIGHT}
      backdrop={false}
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight, maxWidth, presentation }) =>
        presentation === 'sheet' ? (
          <ScrollView
            testID="voice-setup-in-place"
            style={{ maxHeight }}
            keyboardShouldPersistTaps="always"
          >
            {panel}
          </ScrollView>
        ) : (
          <FloatingOverlay
            maxHeight={maxHeight}
            surfaceChrome="theme"
            containerStyle={{
              width: Math.min(maxWidth, VOICE_SETUP_POPOVER_WIDTH),
            }}
            keyboardShouldPersistTaps="always"
          >
            <View testID="voice-setup-in-place">
              {panel}
            </View>
          </FloatingOverlay>
        )
      }
    </Popover>
  );
}

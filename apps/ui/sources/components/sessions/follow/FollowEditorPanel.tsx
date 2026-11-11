import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { ModalCardHeader } from '@/modal/components/card';

/** The Follow panel's width (lab P2-A); a narrower window gets the room the Popover found. */
const FOLLOW_PANEL_WIDTH_PX = 420;
const FOLLOW_PANEL_EDGE_PADDING = { vertical: 12, horizontal: 12 } as const;

/**
 * The one anchored Follow panel (lab P2-A, P2-S): a header naming who hears about what, the level editor
 * scrolling between, and the actions fixed at the foot. Personal Follow and a Session's sources open the
 * same panel. It sizes to its content up to the room the Popover finds, then only the body scrolls, on
 * the panels' opaque coat so no text sits over the page.
 */
export function FollowEditorPanel(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    focusReturnRef?: React.ComponentProps<typeof Popover>['focusReturnRef'];
    onRequestClose: () => void;
    title: string;
    subtitle: string;
    mark?: React.ReactNode;
    footer: React.ReactNode;
    children: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }>,
) {
  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      placement="bottom"
      maxWidthCap={FOLLOW_PANEL_WIDTH_PX}
      // The window bounds the panel, not a side pane it opens from: a pane-sized panel cramps the four
      // levels into ellipses ("Everyt… | Impor…"); like the filter panel, it floats over the transcript.
      boundaryRef={null}
      autoFocusOnOpen
      // Clear of the window's edges, so the panel reads as floating even when it fills the room.
      edgePadding={FOLLOW_PANEL_EDGE_PADDING}
      focusReturnRef={props.focusReturnRef}
      onRequestClose={props.onRequestClose}
      // Right-aligned under its trigger, growing toward the transcript.
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
    >
      {({ maxHeight, maxWidth }) => (
        <View
          testID={props.testID}
          accessibilityLabel={props.accessibilityLabel}
          style={{ width: Math.min(FOLLOW_PANEL_WIDTH_PX, maxWidth) }}
        >
          <FloatingOverlay
            maxHeight={maxHeight}
            edgeFades={{ top: true, bottom: true }}
            header={
              <ModalCardHeader
                leading={props.mark}
                title={props.title}
                subtitle={props.subtitle}
                subtitleLines={2}
              />
            }
            footer={
              props.footer ? (
                <View style={styles.footer}>
                  <RoundButtonSizeScope size="normal" presentation="uniform">
                    {props.footer}
                  </RoundButtonSizeScope>
                </View>
              ) : null
            }
          >
            <View style={styles.body}>{props.children}</View>
          </FloatingOverlay>
        </View>
      )}
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.s8 },
  // The dialogs' footer inset (`ModalCardFrame`), so the actions sit where a dialog's do.
  footer: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
}));

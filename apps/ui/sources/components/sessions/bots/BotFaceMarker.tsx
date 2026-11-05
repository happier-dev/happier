import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AppRailBadge } from '@/components/navigation/shell/appRail/AppRailBadge';

import type { BotActivity } from './botActivity';
import { SessionBotFace } from './face/SessionBotFace';
import type { SessionBotFaceFacts } from './face/sessionBotFaceFacts';

/**
 * A Bot's face with its state marker, wherever Bots stand in a row of faces: the rail pins, the notch's
 * faces wing, the notch's Bot rows and the window rail. The face's own mouth says working (R9's "…",
 * muttering in Lively); needs-you adds the rail's attention dot on the face's bottom-right corner, so
 * colour never carries the state alone. There is no working ring (owner 2026-11-04, R10 A). The face
 * itself is the living-bots `SessionBotFace`, and its mouth reads the same activity.
 *
 * The marker occupies exactly the face's box, so a row of faces keeps the face's pitch.
 */
export const BotFaceMarker = React.memo(function BotFaceMarker(
  props: Readonly<{
    facts: SessionBotFaceFacts;
    size: number;
    activity: BotActivity;
    motion?: boolean;
    monochrome?: boolean;
    /** The plane the face stands on, for the dot's cut-out ring (the island's black, the rail's canvas). */
    planeColor?: string;
    testID?: string;
    dotTestID?: string;
  }>,
) {
  const dot = props.activity === 'needsYou' ? (
        <AppRailBadge
          testID={props.dotTestID}
          signal={{ kind: 'dot', tone: 'attention' }}
          glyphSizePx={props.size}
          corner="bottomRight"
          ringColor={props.planeColor}
        />
      ) : null;

  return (
    <View
      testID={props.testID}
      style={[styles.box, { width: props.size, height: props.size }]}
    >
      <SessionBotFace
        facts={props.facts}
        size={props.size}
        mood={props.activity}
        monochrome={props.monochrome}
        motion={props.motion}
        marker={props.motion ? dot : undefined}
      />
      {!props.motion ? dot : null}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

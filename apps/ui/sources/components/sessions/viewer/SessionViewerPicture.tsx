import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { FloatingFramePicture } from '@happier-dev/plugin-ui/presentation';

import { shadowLevelStyle } from '@/shadowElevation';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * The live picture as the viewer presents it (lab `b-watch` `.fa-pic`): the shared frame picture
 * material (`FloatingFramePicture`) with the app's floating elevation, and its accent ring while the
 * person, not the Agent, drives it. In a pane the same element tree is drawn flush, so moving a body
 * between its pane and the viewer never remounts the player under it.
 */
export function SessionViewerPicture(
  props: React.PropsWithChildren<
    Readonly<{ framed: boolean; source: SessionViewerSource; testID?: string }>
  >,
): React.ReactElement {
  const { theme } = useUnistyles();
  const controlling =
    useOptionalSessionViewerController()?.facts[props.source]?.personInControl ===
    true;
  const elevationStyle = React.useMemo(
    () => shadowLevelStyle(theme.colors.shadowLevels[5]),
    [theme],
  );
  return (
    <FloatingFramePicture
      framed={props.framed}
      elevationStyle={elevationStyle}
      drivenRingColor={controlling ? theme.colors.accent.blue : null}
      testID={props.testID}
    >
      {props.children}
    </FloatingFramePicture>
  );
}

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { FloatingFramePicture, HAPPIER_FLOATING_FRAME_METRICS } from '@happier-dev/plugin-ui/presentation';

import { shadowLevelStyle } from '@/shadowElevation';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { SurfaceStateSizeProvider, useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * The live picture as the viewer presents it (lab `b-watch` `.fa-pic`): the shared frame picture
 * material (`FloatingFramePicture`) with the app's floating elevation and rim, and its accent ring while the
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
  // The viewer's frame is a small window, whichever source it shows: its states take the pane step, not
  // the unsized page-width column. A pane keeps its own.
  const enclosingStateSize = useSurfaceStateCardSize();
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
      <SurfaceStateSizeProvider size={props.framed ? 'pane' : enclosingStateSize}>{props.children}</SurfaceStateSizeProvider>
      {/* A floating picture keeps its edge at rest, when the frame's controls are hidden: the floating rim, not
          a bare picture lying on the transcript (DESIGN Materials). */}
      {props.framed ? <SurfaceRim role="floating" radius={HAPPIER_FLOATING_FRAME_METRICS.bodyRadius} border="modal" /> : null}
    </FloatingFramePicture>
  );
}

import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import {
  FloatingFrame,
  resolveFloatingFrameChromeHeight,
  type FloatingFrameMode,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import {
  useSessionCockpitComposerChromeHeight,
  useSessionCockpitComposerChromeTop,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import {
  useOptionalSessionViewerController,
  useSessionViewerHasPresence,
} from './SessionViewerController';
import { SessionViewerControls } from './SessionViewerControls';
import { SessionViewerBody } from './SessionViewerHost';
import { SessionViewerPresenceFooter } from './SessionViewerPresenceFooter';
import { resolveSessionViewerBodyAspect } from './sessionViewerGeometry';
import {
  resolveSessionViewerWatchingLabel,
  useSessionViewerMachine,
} from './useSessionViewerMachine';

const NO_RECT: FrameRect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
const SLOT_PADDING_TOP = 8;
const SLOT_PADDING_BOTTOM = 12;

/**
 * Phone Watch (63s3): the same frame docked at the top of the reading flow, its controls always
 * visible, the transcript beneath. Expand hands the same retained body to the overlay host; Close
 * stays reachable in the controls.
 */
export function SessionViewerStickySlot(
  props: Readonly<{ sessionId: string; serverId: string | null }>,
): React.ReactElement | null {
  const controller = useOptionalSessionViewerController();
  const source = controller?.state.source ?? null;
  const requestSemantic = controller?.requestSemantic;
  const onModeChange = React.useCallback(
    (mode: FloatingFrameMode) => {
      if (mode === 'expanded') void requestSemantic?.({ kind: 'viewer.expand' });
      else if (mode === 'closed') void requestSemantic?.({ kind: 'viewer.close' });
    },
    [requestSemantic],
  );
  // The docked frame spans the window between the reading flow's gutters.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const footer = useSessionViewerHasPresence(source ?? 'computer');
  // Where the dock starts in the window, so a short phone can keep it above the composer.
  const slotRef = React.useRef<View | null>(null);
  const [slotTop, setSlotTop] = React.useState<number | null>(null);
  const measureTop = React.useCallback(() => {
    slotRef.current?.measureInWindow?.((_x, y) => {
      if (Number.isFinite(y)) setSlotTop((current) => (current === y ? current : y));
    });
  }, []);
  const composerHeight = useSessionCockpitComposerChromeHeight();
  const composerTop = useSessionCockpitComposerChromeTop();
  React.useEffect(measureTop, [measureTop, composerTop, windowHeight]);
  const serverId = controller?.serverId ?? props.serverId;
  const machine = useSessionViewerMachine(
    props.sessionId,
    serverId,
    source ?? 'computer',
  );
  if (!controller?.phone || controller.state.mode !== 'docked' || !source)
    return null;
  const frameWidth = windowWidth - COMPOSER_CONTENT_HORIZONTAL_INSET * 2;
  const pictureAspect = resolveSessionViewerBodyAspect(
    controller.facts[source]?.aspectRatio,
    frameWidth,
    controller.facts[source]?.stateMinBody ?? undefined,
  );
  // A short phone leaves the dock less height above the composer than the picture's shape asks: the
  // body yields (the picture fits inside it) so the controls and who-acts footer stay above the
  // composer instead of under it. Expand still shows the picture at its size.
  const composerStart = windowHeight - (composerTop > 0 ? composerTop : composerHeight);
  const bodyRoom = slotTop === null
    ? null
    : composerStart - slotTop - SLOT_PADDING_TOP - SLOT_PADDING_BOTTOM - resolveFloatingFrameChromeHeight({ footer });
  const aspectRatio = bodyRoom !== null && bodyRoom > 0 && frameWidth / pictureAspect > bodyRoom
    ? frameWidth / bodyRoom
    : pictureAspect;
  return (
    <View
      ref={slotRef}
      onLayout={measureTop}
      style={{
        paddingHorizontal: COMPOSER_CONTENT_HORIZONTAL_INSET,
        paddingTop: SLOT_PADDING_TOP,
        paddingBottom: SLOT_PADDING_BOTTOM,
      }}
      testID="session-viewer-sticky"
    >
      <FloatingFrame
        testID="session-viewer-frame"
        mode="docked"
        rect={NO_RECT}
        availableRect={NO_RECT}
        aspectRatio={aspectRatio}
        moveInput="chrome"
        onRectChange={() => {}}
        onModeChange={onModeChange}
        controlsAlwaysVisible
        accessibilityLabel={resolveSessionViewerWatchingLabel(source, machine.name, machine.targetTitle)}
        controls={
          <SessionViewerControls
            sessionId={props.sessionId}
            serverId={serverId}
            source={source}
          />
        }
        footer={
          footer ? (
            <SessionViewerPresenceFooter
              sessionId={props.sessionId}
              serverId={serverId}
              source={source}
              compact
            />
          ) : undefined
        }
      >
        <SessionViewerBody
          sessionId={props.sessionId}
          serverId={serverId}
          source={source}
        />
      </FloatingFrame>
    </View>
  );
}

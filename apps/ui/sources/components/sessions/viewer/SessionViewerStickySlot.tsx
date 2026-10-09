import * as React from 'react';
import { View } from 'react-native';
import {
  FloatingFrame,
  type FloatingFrameMode,
  type FrameRect,
} from '@happier-dev/plugin-ui/presentation';

import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import { SessionViewerControls } from './SessionViewerControls';
import { SessionViewerBody } from './SessionViewerHost';
import { SESSION_VIEWER_DEFAULT_ASPECT } from './sessionViewerGeometry';

const NO_RECT: FrameRect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

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
  const apply = controller?.apply;
  const onModeChange = React.useCallback(
    (mode: FloatingFrameMode) => {
      if (mode === 'expanded') apply?.({ kind: 'viewer.expand' });
      else if (mode === 'closed') apply?.({ kind: 'viewer.close' });
    },
    [apply],
  );
  if (!controller?.phone || controller.state.mode !== 'docked' || !source)
    return null;
  const serverId = controller.serverId ?? props.serverId;
  return (
    <View
      style={{
        paddingHorizontal: COMPOSER_CONTENT_HORIZONTAL_INSET,
        paddingTop: 8,
        paddingBottom: 12,
      }}
      testID="session-viewer-sticky"
    >
      <FloatingFrame
        testID="session-viewer-frame"
        mode="docked"
        rect={NO_RECT}
        availableRect={NO_RECT}
        aspectRatio={SESSION_VIEWER_DEFAULT_ASPECT}
        moveInput="chrome"
        onRectChange={() => {}}
        onModeChange={onModeChange}
        controlsAlwaysVisible
        accessibilityLabel={t('computerUse.viewer.watchingA11y', {
          source: t(
            source === 'computer'
              ? 'computerUse.viewer.sourceComputer'
              : 'computerUse.viewer.sourceBrowser',
          ),
          machine: controller.facts[source]?.machineName ?? '',
        })}
        controls={
          <SessionViewerControls
            sessionId={props.sessionId}
            serverId={serverId}
            source={source}
          />
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

import * as React from 'react';
import { useDeviceType } from '@/utils/platform/responsive';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { RetainedSessionViewerSource } from '@/components/sessions/viewer/RetainedSessionViewerSource';
import { SessionViewerPresentedElsewhere } from '@/components/sessions/viewer/SessionViewerPresentedElsewhere';
import {
  isSessionViewerPresenting,
  useOptionalSessionViewerController,
  usePublishSessionViewerPresence,
  usePublishSessionViewerSourceFacts,
  type SessionViewerPresence,
} from '@/components/sessions/viewer/SessionViewerController';
import { SessionViewerPicture } from '@/components/sessions/viewer/SessionViewerPicture';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import {
  useRetainedPresentationSlotVisible,
  type RetainedPresentationGeometryTransition,
  type RetainedPresentationRect,
} from '@/components/ui/presentation/retainedPresentationSlots';

import {
  ComputerScreenViewer,
  computerCaptureNeedsPermission,
  resolveComputerPresenceCapsule,
  type ComputerScreenPicture,
} from './ComputerScreenViewer';
import { useSessionComputerScreen } from './useSessionComputerScreen';

/**
 * The Session's shared window: the computer owner's selection and control status, the live
 * `screen` stream for that exact source, and the person's controls. The Details pane and the
 * floating viewer present this one retained body; whichever presents it, the other does not bind.
 */
type SessionComputerScreenPaneProps = Readonly<{
  sessionId: string;
  serverId?: string | null;
  machineId: string;
  testID?: string;
  /** Alternate shells bind this same source rather than creating another controller. */
  presentationSlotId?: string;
  /** `viewer`: the floating/sticky viewer frame owns the identity chrome around the picture. */
  presentation?: 'pane' | 'viewer';
  windowGeometry?: RetainedPresentationRect | null;
  transition?: RetainedPresentationGeometryTransition | null;
  /** The watched picture lets the pointer through to its presentation's frame. */
  inputPassthrough?: boolean;
}>;

export function useSessionComputerScreenSlotId(
  sessionId: string,
  serverId: string | null,
): string {
  const scopeId = useDestinationPaneScopeId(
    createSessionPaneScopeId(sessionId, serverId),
  );
  return `${scopeId}:viewer:computer`;
}

export function SessionComputerScreenPane(
  props: SessionComputerScreenPaneProps,
): React.ReactElement {
  const accountLifetime = useSessionViewerSourceAccountLifetime();
  const viewer = useOptionalSessionViewerController();
  const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
  const defaultSlotId = useSessionComputerScreenSlotId(
    props.sessionId,
    serverId,
  );
  const slotId = props.presentationSlotId ?? defaultSlotId;
  const presentation = props.presentation ?? 'pane';
  // The body element is identity-stable across frame geometry, so a moving viewer re-renders only
  // the slot binder, never the stream and control owners.
  const { sessionId, machineId, testID } = props;
  const body = React.useMemo(
    () => (
      <SessionComputerScreenBody
        sessionId={sessionId}
        machineId={machineId}
        testID={testID}
        serverId={serverId}
        presentation={presentation}
      />
    ),
    [machineId, presentation, serverId, sessionId, testID],
  );
  if (
    presentation === 'pane' &&
    isSessionViewerPresenting(viewer, 'computer')
  ) {
    return (
      <SessionViewerPresentedElsewhere
        source="computer"
        testID={props.testID}
      />
    );
  }
  return (
    <RetainedSessionViewerSource
      slotId={slotId}
      serverId={serverId}
      accountLifetime={accountLifetime}
      windowGeometry={props.windowGeometry}
      transition={props.transition}
      inputPassthrough={props.inputPassthrough}
    >
      {body}
    </RetainedSessionViewerSource>
  );
}

function SessionComputerScreenBody(
  props: SessionComputerScreenPaneProps,
): React.ReactElement {
  const enabled = useRetainedPresentationSlotVisible();
  const model = useSessionComputerScreen({ ...props, enabled });
  const compact = useDeviceType() === 'phone';
  const viewer = props.presentation === 'viewer';
  const [picture, setPicture] = React.useState<ComputerScreenPicture | null>(
    null,
  );
  const onPictureChange = React.useCallback(
    (next: ComputerScreenPicture) =>
      setPicture((current) =>
        current &&
        current.up === next.up &&
        current.size?.width === next.size?.width &&
        current.size?.height === next.size?.height
          ? current
          : next,
      ),
    [],
  );
  const personInControl = model.presence.kind === 'human';
  // Watching: the live picture is only being looked at (the Agent drives it, or the person may not
  // use it), so the viewer moves by the picture. A state card's choices keep their presses.
  const watching =
    model.shared &&
    picture?.up === true &&
    (model.inputDenied === true ||
      model.presence.kind === 'agent' ||
      model.presence.kind === 'stopping' ||
      model.presence.kind === 'unconfirmed');
  usePublishSessionViewerSourceFacts('computer', {
    machineName: model.machineName,
    personInControl,
    watching,
    aspectRatio: picture?.size
      ? picture.size.width / picture.size.height
      : null,
    chooseTarget: model.onChooseWindow,
    resolveTargetPicker: model.resolveChooseWindow,
    stopSharing: model.shared ? model.onStopSharing : undefined,
  });
  // The one capsule projection the pane draws too: no Take control while the machine denies input,
  // and nobody to name while the screen cannot be seen at all (its picture is the permission card).
  const needsPermission = computerCaptureNeedsPermission(model);
  const presence = React.useMemo<SessionViewerPresence | null>(
    () =>
      viewer && model.shared && !needsPermission
        ? resolveComputerPresenceCapsule({
            presence: model.presence,
            agent: model.agent,
            agentActing: model.agentActing,
            access: model.access,
            appName: model.appName,
            targetTitle: model.targetTitle,
            checking: model.checking,
            inputDenied: model.inputDenied,
            onTakeControl: model.onTakeControl,
            onHandBack: model.onHandBack,
            onCheckAgain: model.onCheckAgain,
          })
        : null,
    [
      model.access,
      model.agent,
      model.agentActing,
      model.appName,
      model.checking,
      model.inputDenied,
      model.onCheckAgain,
      model.onHandBack,
      model.onTakeControl,
      model.presence,
      model.shared,
      model.targetTitle,
      needsPermission,
      viewer,
    ],
  );
  usePublishSessionViewerPresence('computer', presence);

  const { resolveChooseWindow: _anchoredPicker, ...viewerModel } = model;
  const screen = (
    <ComputerScreenViewer
      testID={props.testID}
      {...viewerModel}
      chrome={viewer ? 'none' : 'bar'}
      compact={compact}
      onPictureChange={viewer ? onPictureChange : undefined}
    />
  );
  // One element tree in every presentation, so moving between pane and viewer never remounts the player.
  return (
    <SessionViewerPicture framed={viewer} source="computer">
      {screen}
    </SessionViewerPicture>
  );
}

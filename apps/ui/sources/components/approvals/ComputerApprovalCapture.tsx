import * as React from 'react';

import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { type ComputerActionApproval } from './computerApprovalModel';
import { readComputerTargetLabel } from './ComputerActionApprovalCard';

/**
 * The shared window as the computer owner last stored it, for the approval card's `media` slot (lab
 * `computer` CS). The chat card and the approval page both render this; with no capture yet there is
 * nothing to show.
 */
export function ComputerApprovalCapture(
  props: Readonly<{
    presentation: ComputerActionApproval;
    serverId: string | null;
    testID: string;
  }>,
): React.ReactElement | null {
  const capture = props.presentation.captureMedia;
  // The picture is named for what it shows ("The whole screen", a window's title), never the display id.
  const target = props.presentation.target;
  const title = target ? readComputerTargetLabel(target) : '';
  const media = React.useMemo(
    () =>
      capture
        ? [
            {
              id: capture.mediaId,
              name: title,
              path: capture.file.path,
              mimeType: capture.file.mimeType,
              sizeBytes: capture.sizeBytes,
              sha256: capture.file.sha256,
              width: capture.width,
              height: capture.height,
              category: 'tool-artifact' as const,
              role: 'output' as const,
            },
          ]
        : [],
    [capture, title],
  );
  if (!capture) return null;
  return (
    <SessionStoredImageThumbnail
      sessionId={capture.file.sessionId}
      serverId={props.serverId}
      machineId={props.presentation.machineId}
      storage={capture.file.storage}
      media={media}
      mediaPreviewEnabled
      testID={props.testID}
    />
  );
}

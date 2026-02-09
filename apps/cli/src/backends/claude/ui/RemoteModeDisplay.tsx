/**
 * RemoteModeDisplay
 *
 * Claude remote-mode terminal display built on the shared remote control shell.
 */

import React from 'react';

import {
  RemoteControlDisplay,
  type RemoteModeActionInProgress,
  type RemoteModeConfirmation,
  type RemoteModeKeypressAction,
  interpretRemoteModeKeypress as interpretRemoteModeKeypressShared,
} from '@/ui/ink/RemoteControlDisplay';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type { RemoteModeActionInProgress, RemoteModeConfirmation, RemoteModeKeypressAction };

export function interpretRemoteModeKeypress(
  state: { confirmationMode: RemoteModeConfirmation; actionInProgress: RemoteModeActionInProgress },
  input: string,
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
  opts?: { allowSwitchToLocal?: boolean },
): { action: RemoteModeKeypressAction } {
  return interpretRemoteModeKeypressShared(state, input, key, {
    allowSwitchToLocal: opts?.allowSwitchToLocal ?? true,
  });
}

export type RemoteModeDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void;
  onSwitchToLocal?: () => void;
};

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToLocal }) => {
  return (
    <RemoteControlDisplay
      providerName="Claude"
      messageBuffer={messageBuffer}
      logPath={logPath}
      allowSwitchToLocal={true}
      onExit={onExit}
      onSwitchToLocal={onSwitchToLocal}
    />
  );
};

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
  opts?: { allowSwitchToTerminal?: boolean },
): { action: RemoteModeKeypressAction } {
  return interpretRemoteModeKeypressShared(state, input, key, {
    allowSwitchToTerminal: opts?.allowSwitchToTerminal ?? true,
  });
}

export type RemoteModeDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void;
  onSwitchToTerminal?: () => void;
};

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToTerminal }) => {
  return (
    <RemoteControlDisplay
      providerName="Claude"
      messageBuffer={messageBuffer}
      logPath={logPath}
      allowSwitchToTerminal={true}
      onExit={onExit}
      onSwitchToTerminal={onSwitchToTerminal}
    />
  );
};

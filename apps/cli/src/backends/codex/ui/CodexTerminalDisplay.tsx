/**
 * CodexTerminalDisplay
 *
 * Codex remote-mode terminal display built on the shared remote control shell.
 */

import React from 'react';

import { RemoteControlDisplay } from '@/ui/ink/RemoteControlDisplay';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type CodexTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  allowSwitchToLocal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToLocal?: () => void | Promise<void>;
};

export const CodexTerminalDisplay: React.FC<CodexTerminalDisplayProps> = ({
  messageBuffer,
  logPath,
  allowSwitchToLocal,
  onExit,
  onSwitchToLocal,
}) => {
  return (
    <RemoteControlDisplay
      providerName="Codex"
      messageBuffer={messageBuffer}
      logPath={logPath}
      allowSwitchToLocal={allowSwitchToLocal === true}
      onExit={onExit}
      onSwitchToLocal={onSwitchToLocal}
    />
  );
};

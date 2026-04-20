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
  allowSwitchToTerminal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToTerminal?: () => void | Promise<void>;
};

export const CodexTerminalDisplay: React.FC<CodexTerminalDisplayProps> = ({
  messageBuffer,
  logPath,
  allowSwitchToTerminal,
  onExit,
  onSwitchToTerminal,
}) => {
  return (
    <RemoteControlDisplay
      providerName="Codex"
      messageBuffer={messageBuffer}
      logPath={logPath}
      allowSwitchToTerminal={allowSwitchToTerminal === true}
      onExit={onExit}
      onSwitchToTerminal={onSwitchToTerminal}
    />
  );
};

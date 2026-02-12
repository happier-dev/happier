import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export type PiTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const PiTerminalDisplay: React.FC<PiTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="Pi"
      accentColor="cyan"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Pi')}
      onExit={onExit}
    />
  );
};

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type BuiltInAcpTerminalDisplayProps = Readonly<{
  title: string;
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
}>;

export const BuiltInAcpTerminalDisplay: React.FC<BuiltInAcpTerminalDisplayProps> = ({
  title,
  messageBuffer,
  logPath,
  onExit,
}) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title={`🤖 ${title}`}
      accentColor="cyan"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines(title)}
      onExit={onExit}
    />
  );
};

/**
 * CopilotTerminalDisplay
 *
 * Read-only terminal UI for Copilot sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type CopilotTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const CopilotTerminalDisplay: React.FC<CopilotTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="Copilot"
      accentColor="green"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Copilot')}
      onExit={onExit}
    />
  );
};

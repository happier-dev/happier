/**
 * KimiTerminalDisplay
 *
 * Read-only terminal UI for Kimi sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type KimiTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const KimiTerminalDisplay: React.FC<KimiTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="🤖 Kimi"
      accentColor="magenta"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Kimi')}
      onExit={onExit}
    />
  );
};


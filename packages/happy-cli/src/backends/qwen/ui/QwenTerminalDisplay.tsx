/**
 * QwenTerminalDisplay
 *
 * Read-only terminal UI for Qwen Code sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type QwenTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const QwenTerminalDisplay: React.FC<QwenTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="🤖 Qwen Code"
      accentColor="cyan"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Qwen Code')}
      onExit={onExit}
    />
  );
};


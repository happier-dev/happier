/**
 * createProviderTerminalDisplay
 *
 * Factory that produces a read-only terminal display component for a provider.
 * Each generated component renders `<AgentLogShell>` with provider-specific
 * `title` and `accentColor`, eliminating boilerplate across backends.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type ProviderTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

type ProviderTerminalDisplayConfig = {
  /** Display title shown in the shell header (may include emoji). */
  title: string;
  /** Ink color used for header and footer accents. */
  accentColor: string;
  /** Plain provider name passed to `buildReadOnlyFooterLines`. Defaults to `title`. */
  footerName?: string;
};

export function createProviderTerminalDisplay(
  config: ProviderTerminalDisplayConfig,
): React.FC<ProviderTerminalDisplayProps> {
  const { title, accentColor, footerName = title } = config;

  const ProviderTerminalDisplay: React.FC<ProviderTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
    return (
      <AgentLogShell
        messageBuffer={messageBuffer}
        title={title}
        accentColor={accentColor}
        logPath={logPath}
        footerLines={buildReadOnlyFooterLines(footerName)}
        onExit={onExit}
      />
    );
  };

  ProviderTerminalDisplay.displayName = `${footerName}TerminalDisplay`;

  return ProviderTerminalDisplay;
}

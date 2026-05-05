import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import type { TerminalRemoteSessionMode } from '../runTerminalRemoteSessionModeLoop';

export type RemoteOnlyTerminalDisplayProps = Readonly<{
  messageBuffer: MessageBuffer;
  backendDisplayName: string;
  requestedMode: TerminalRemoteSessionMode;
  logPath?: string;
  onExit: () => void | Promise<void>;
}>;

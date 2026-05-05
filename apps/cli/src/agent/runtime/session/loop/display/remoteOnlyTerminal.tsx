import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';

import {
  buildRemoteOnlyTerminalFooterLines,
  buildRemoteOnlyTerminalTitle,
} from './buildRemoteOnlyTerminalLines';
import type { RemoteOnlyTerminalDisplayProps } from './types';

export function RemoteOnlyTerminalDisplay(props: RemoteOnlyTerminalDisplayProps): React.ReactElement {
  return (
    <AgentLogShell
      messageBuffer={props.messageBuffer}
      title={buildRemoteOnlyTerminalTitle({ backendDisplayName: props.backendDisplayName })}
      accentColor="yellow"
      logPath={props.logPath}
      footerLines={buildRemoteOnlyTerminalFooterLines({
        backendDisplayName: props.backendDisplayName,
        requestedMode: props.requestedMode,
      })}
      onExit={props.onExit}
    />
  );
}

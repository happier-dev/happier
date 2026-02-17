import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';

export type ExecutionRunBackendController = {
  kind: 'backend';
  backend: AgentBackend;
  childSessionId: SessionId | null;
  buffer: string;
  sidechainStreamBuffer: string;
  sidechainStreamKey: string;
  cancelled: boolean;
  turnCount: number;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

export type ExecutionRunVoiceAgentController = {
  kind: 'voice_agent';
  voiceAgentId: string;
  cancelled: boolean;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  externalStreamIdByInternal: Map<string, string>;
  internalStreamIdByExternal: Map<string, string>;
  persistedDoneByExternalStreamId: Set<string>;
};

export type ExecutionRunController = ExecutionRunBackendController | ExecutionRunVoiceAgentController;

export function readBackendChildSessionId(ctrl: ExecutionRunController | null): SessionId | null {
  if (!ctrl) return null;
  return ctrl.kind === 'backend' ? ctrl.childSessionId : null;
}


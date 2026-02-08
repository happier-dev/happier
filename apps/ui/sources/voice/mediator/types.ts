export type VoiceMediatorPermissionPolicy = 'no_tools' | 'read_only';
export type VoiceMediatorAgentSource = 'session' | 'agent';
export type VoiceMediatorVerbosity = 'short' | 'balanced';

export type VoiceMediatorStartParams = Readonly<{
  sessionId: string;
  agentSource?: VoiceMediatorAgentSource;
  agentId?: string;
  verbosity?: VoiceMediatorVerbosity;
  chatModelId: string;
  commitModelId: string;
  permissionPolicy: VoiceMediatorPermissionPolicy;
  idleTtlSeconds: number;
  initialContext: string;
}>;

export type VoiceMediatorStartResult = Readonly<{
  mediatorId: string;
  effective?: {
    chatModelId: string;
    commitModelId: string;
    permissionPolicy: VoiceMediatorPermissionPolicy;
  };
}>;

export interface VoiceMediatorClient {
  start(params: VoiceMediatorStartParams): Promise<VoiceMediatorStartResult>;
  sendTurn(params: Readonly<{ sessionId: string; mediatorId: string; userText: string }>): Promise<{ assistantText: string }>;
  commit(params: Readonly<{ sessionId: string; mediatorId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }>;
  stop(params: Readonly<{ sessionId: string; mediatorId: string }>): Promise<{ ok: true }>;
  getModels(params: Readonly<{ sessionId: string }>): Promise<{ availableModels: Array<{ id: string; name: string; description?: string }>; supportsFreeform: boolean }>;
}

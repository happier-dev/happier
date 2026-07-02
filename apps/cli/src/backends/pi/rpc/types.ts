export type PiRpcCommand =
  | { id: string; type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { id: string; type: 'compact'; customInstructions?: string }
  | { id: string; type: 'steer'; message: string }
  | { id: string; type: 'follow_up'; message: string }
  | { id: string; type: 'abort' }
  | { id: string; type: 'new_session' }
  | { id: string; type: 'get_state' }
  | { id: string; type: 'get_session_stats' }
  | { id: string; type: 'get_available_models' }
  | { id: string; type: 'set_model'; provider: string; modelId: string }
  | { id: string; type: 'set_thinking_level'; level: string }
  | { id: string; type: 'get_commands' };

export type PiRpcCommandWithoutId =
  PiRpcCommand extends infer TCommand
    ? TCommand extends { id: string }
      ? Omit<TCommand, 'id'>
      : never
    : never;

export type PiRpcResponse = Readonly<{
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}>;

export type PiRpcStateData = Readonly<{
  sessionId?: string;
  sessionFile?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  thinkingLevel?: string;
  model?: Readonly<{ id?: string; provider?: string; name?: string }> | null;
}>;

export type PiRpcSessionStatsData = Readonly<{
  sessionId?: string;
  assistantMessages?: number;
  tokens?: Readonly<{
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  }> | null;
  cost?: number;
}>;

export type PiRpcModel = Readonly<{
  id?: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
}>;

export type PiRpcModelsData = Readonly<{
  models?: readonly PiRpcModel[];
}>;

export type PiRpcCommandEntry = Readonly<{
  name?: string;
  description?: string;
}>;

export type PiRpcCommandsData = Readonly<{
  commands?: readonly PiRpcCommandEntry[];
}>;

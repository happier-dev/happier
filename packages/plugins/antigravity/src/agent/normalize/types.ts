export type AntigravityStep =
  | Readonly<{ kind: 'user_message'; id?: string; text: string }>
  | Readonly<{ kind: 'assistant_message'; id?: string; text: string }>
  | Readonly<{ kind: 'tool_call'; id?: string; toolName: string; input: unknown }>
  | Readonly<{ kind: 'tool_result'; id?: string; toolCallId: string; output: unknown; isError?: boolean }>
  | Readonly<{ kind: 'checkpoint'; id?: string; checkpointId?: string }>
  | Readonly<{ kind: 'system_message'; id?: string; text: string }>
  | Readonly<{ kind: 'error'; id?: string; message: string }>;

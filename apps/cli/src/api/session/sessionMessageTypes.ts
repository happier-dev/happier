import type { CatalogAgentId } from '@/backends/types';

type AcpSidechainMeta = { sidechainId?: string };

export type ACPMessageData = AcpSidechainMeta & (
  | { type: 'message'; message: string }
  | { type: 'reasoning'; message: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
  | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
  | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
  | { type: 'terminal-output'; data: string; callId: string }
  | { type: 'task_started'; id: string }
  | { type: 'task_complete'; id: string }
  | { type: 'turn_aborted'; id: string }
  | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
  | { type: 'token_count'; [key: string]: unknown }
);

export type ACPProvider = CatalogAgentId;

export type SessionEventMessage =
  | { type: 'switch'; mode: 'local' | 'remote' }
  | { type: 'message'; message: string }
  | { type: 'permission-mode-changed'; mode: import('../types').PermissionMode }
  | { type: 'ready' };


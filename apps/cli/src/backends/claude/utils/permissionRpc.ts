import type { PermissionMode } from '@/api/types';

export type PermissionRpcPayload = {
  id: string;
  approved: boolean;
  reason?: string;
  mode?: PermissionMode;
  allowedTools?: string[];
  allowTools?: string[]; // legacy alias
  /**
   * AskUserQuestion: structured answers keyed by question text.
   * Claude Code may use this to complete the interaction without a TUI.
   */
  answers?: Record<string, string>;
  /**
   * Optional client-provided timestamp for telemetry/debugging.
   */
  receivedAt?: number;
};


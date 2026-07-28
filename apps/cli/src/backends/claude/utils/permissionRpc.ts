import type { PermissionMode } from '@/api/types';
import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';

export type PermissionRpcPayload = {
  id: string;
  approved: boolean;
  reason?: string;
  mode?: PermissionMode;
  allowedTools?: string[];
  allowTools?: string[]; // legacy alias
  /**
   * Optional permission updates to apply inside the agent runtime (provider-specific).
   * For Claude Agent SDK / Claude Code hooks, this matches `updatedPermissions` / `PermissionUpdate[]`.
   */
  updatedPermissions?: unknown;
  /**
   * AskUserQuestion: structured answers keyed by question text.
   * Claude Code may use this to complete the interaction without a TUI.
   */
  answers?: Record<string, string>;
  structuredAnswersV1?: StructuredQuestionAnswersV1;
  /**
   * Optional client-provided timestamp for telemetry/debugging.
   */
  receivedAt?: number;
};

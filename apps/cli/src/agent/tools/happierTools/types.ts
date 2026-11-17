import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

export type HappierBuiltInToolDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  toolId?: string;
  actionId?: string;
  inputSchema: unknown;
  contextualDefaults?: import('@happier-dev/protocol').ActionContextualDefaults;
  outputSchema?: unknown;
  safety?: 'safe' | 'danger';
  inputHints?: unknown;
  examples?: unknown;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  availability?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Readonly<Record<string, unknown>>;
}>;

export type HappierBuiltInToolDispatchResult =
  | Extract<ActionExecuteResult, { ok: true }>
  | (ActionExecuteFailure & Readonly<{ candidates?: string[] }>);

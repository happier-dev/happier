import { z } from 'zod';

export const KNOWN_CANONICAL_TOOL_NAMES_V2 = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Delete',
  'Patch',
  'Diff',
  'Glob',
  'Grep',
  'LS',
  'CodeSearch',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TodoRead',
  'SubAgent',
  'Task',
  // Background-task control tools. These act on a headless background task (a `Bash`
  // `run_in_background` command or a backgrounded agent), never on a subagent roster entry, so they
  // are deliberately distinct from `Task`/`SubAgent`. Verified against the Claude Agent SDK's
  // `ToolInputSchemas` union (`TaskOutputInput`, `TaskStopInput`).
  'TaskOutput',
  'TaskStop',
  // Dynamic Workflow run (provider-agnostic). Distinct from `Task`/`SubAgent`: a `Workflow`
  // tool call starts an orchestrated multi-agent run rendered by a dedicated workflow card.
  'Workflow',
  'Reasoning',
  // Structured tool-ish events.
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'AcpHistoryImport',
  'WorkspaceIndexingPermission',
  'change_title',
  'SubAgentRun',
  // Agent teams / swarm orchestration events (provider-agnostic).
  'AgentTeamCreate',
  'AgentTeamDelete',
  'AgentTeamSendMessage',
] as const;

export const KnownCanonicalToolNameV2Schema = z.enum(KNOWN_CANONICAL_TOOL_NAMES_V2);
export type KnownCanonicalToolNameV2 = z.infer<typeof KnownCanonicalToolNameV2Schema>;

export type CanonicalToolNameV2 =
  | KnownCanonicalToolNameV2
  | `mcp__${string}`;

export const CanonicalToolNameV2Schema = z.union([
  KnownCanonicalToolNameV2Schema,
  z.string().regex(/^mcp__/),
]);

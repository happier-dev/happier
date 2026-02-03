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
  'Task',
  'Reasoning',
  // Structured tool-ish events.
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'AcpHistoryImport',
  'WorkspaceIndexingPermission',
  'change_title',
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


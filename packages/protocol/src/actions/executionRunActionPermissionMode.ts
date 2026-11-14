import { z } from '../zodRuntimePolicy.js';

import {
  SESSION_PERMISSION_INTENT_INPUTS,
  parseSessionPermissionModeAlias,
} from '../sessions/metadata/sessionPermissionModes.js';
import { parseAgentPermissionIntentV1Alias, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import type { ExecutionRunIntent } from '../execution/runs/runPrimitives.js';

/** Retained execution-run wire values for mixed-version daemon compatibility. */
export const EXECUTION_RUN_ACTION_PERMISSION_MODES = [
  'read_only',
  'default',
  'workspace_write',
  'yolo',
  'no_tools',
] as const;
export type ExecutionRunActionPermissionMode = (typeof EXECUTION_RUN_ACTION_PERMISSION_MODES)[number];

/** Preferred values exposed by Action, MCP, and CLI discovery. */
export const EXECUTION_RUN_ACTION_PERMISSION_INPUTS = SESSION_PERMISSION_INTENT_INPUTS;

export const EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION =
  `Permission intent. Preferred values: ${EXECUTION_RUN_ACTION_PERMISSION_INPUTS.join(' | ')}. Compatible aliases are accepted.`;

function normalizeExecutionRunActionPermissionMode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Runs distinguish no tools from read-only tools; Session aliases do not.
  if (value === 'no_tools') return value;

  const mode = parseSessionPermissionModeAlias(value);
  switch (mode) {
    case 'read-only':
      return 'read_only';
    case 'safe-yolo':
    case 'acceptEdits':
      return 'workspace_write';
    case 'bypassPermissions':
      return 'yolo';
    case 'default':
    case 'yolo':
      return mode;
    default:
      return value;
  }
}

export const ExecutionRunActionPermissionModeSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeExecutionRunActionPermissionMode), z.enum(EXECUTION_RUN_ACTION_PERMISSION_MODES)).check(z.describe(EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION));

/**
 * The reverse direction of the schema above: a retained run token as the Agent
 * permission intent a runtime understands. `no_tools` and `read_only` both run
 * read-only (tool removal is the run policy's job); `workspace_write` is the
 * closest intent, `safe-yolo`. Unknown values run with the Agent's default.
 */
export function executionRunPermissionIntentV1(raw: string): AgentPermissionIntentV1 {
  const mode = String(raw ?? '').trim().toLowerCase();
  if (!mode) return 'default';
  if (mode === 'read_only' || mode === 'no_tools') return 'read-only';
  if (mode === 'workspace_write') return 'safe-yolo';
  return parseAgentPermissionIntentV1Alias(mode) ?? 'default';
}

/** Voice uses ordinary approval; delegates may edit the workspace; other intents read. */
export function defaultExecutionRunPermissionMode(
  intent: ExecutionRunIntent,
): ExecutionRunActionPermissionMode {
  return intent === 'voice_agent' ? 'default' : intent === 'delegate' ? 'workspace_write' : 'read_only';
}

/**
 * A Session permission mode (what a launcher's permission picker lists) as the run token a start
 * sends. Plan mode narrows to `read_only`; unknown modes keep the Agent default.
 */
export function executionRunPermissionModeFromSessionModeV1(mode: string): ExecutionRunActionPermissionMode {
  if (mode === 'read-only' || mode === 'plan') return 'read_only';
  if (mode === 'safe-yolo' || mode === 'acceptEdits') return 'workspace_write';
  if (mode === 'yolo' || mode === 'bypassPermissions') return 'yolo';
  return 'default';
}

const READ_ONLY_START_ACTIONS: ReadonlySet<string> = new Set(['review.start', 'subagents.plan.start']);

/**
 * Which permission levels a start action's launch surface may offer (`null`: any), and the level a
 * draft starts with (`null`: leave it unset; admission applies `defaultExecutionRunPermissionMode`).
 */
export function executionRunActionPermissionPolicyV1(actionId: string): Readonly<{
  allowed: readonly ExecutionRunActionPermissionMode[] | null;
  defaultMode: ExecutionRunActionPermissionMode | null;
}> {
  if (READ_ONLY_START_ACTIONS.has(actionId)) return { allowed: ['read_only'], defaultMode: 'read_only' };
  if (actionId === 'subagents.delegate.start') return { allowed: null, defaultMode: defaultExecutionRunPermissionMode('delegate') };
  return { allowed: null, defaultMode: null };
}

import { z } from 'zod/mini';

import {
  SESSION_PERMISSION_INTENT_INPUTS,
  parseSessionPermissionModeAlias,
} from '../sessions/metadata/sessionPermissionModes.js';

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

import { z } from 'zod';

import {
  SESSION_PERMISSION_INTENT_INPUTS,
  parseSessionPermissionModeAlias,
} from '../sessionMetadata/sessionPermissionModes.js';
import { lazySchema } from '../lazySchema.js';

/** Retained execution-run wire values for mixed-version daemon compatibility. */
export const EXECUTION_RUN_ACTION_PERMISSION_MODES = [
  'read_only',
  'default',
  'workspace_write',
  'yolo',
] as const;

/** Preferred values exposed by action/MCP/CLI discovery. */
export const EXECUTION_RUN_ACTION_PERMISSION_INPUTS = SESSION_PERMISSION_INTENT_INPUTS;

export const EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION =
  `Permission intent. Preferred values: ${EXECUTION_RUN_ACTION_PERMISSION_INPUTS.join(' | ')}. Compatible aliases are accepted.`;

function normalizeExecutionRunActionPermissionMode(value: unknown): unknown {
  if (typeof value !== 'string') return value;

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

export const ExecutionRunActionPermissionModeSchema = lazySchema(() => z.preprocess(
  normalizeExecutionRunActionPermissionMode,
  z.enum(EXECUTION_RUN_ACTION_PERMISSION_MODES),
)
  .describe(EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION));

export type ExecutionRunActionPermissionMode = z.infer<typeof ExecutionRunActionPermissionModeSchema>;

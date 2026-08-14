import { z } from 'zod';

export const EXECUTION_RUN_ACTION_PERMISSION_MODES = [
  'read_only',
  'default',
  'workspace_write',
  'yolo',
] as const;

export const EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION =
  `Permission mode. Allowed values: ${EXECUTION_RUN_ACTION_PERMISSION_MODES.join(' | ')}.`;

export const ExecutionRunActionPermissionModeSchema = z
  .enum(EXECUTION_RUN_ACTION_PERMISSION_MODES)
  .describe(EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION);

export type ExecutionRunActionPermissionMode = z.infer<typeof ExecutionRunActionPermissionModeSchema>;

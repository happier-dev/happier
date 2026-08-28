import { z } from 'zod';

import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';

/**
 * Creation-time Session authoring fields live in this dependency-light leaf.
 *
 * Session creation and Automation execution recipes both consume these
 * schemas. Keeping their runtime owner outside the full authoring field
 * catalog prevents that catalog's Automation definitions from forming a
 * reciprocal initialization cycle with Session spawn.
 */
export const SessionAuthoringCheckoutCreationDraftV1Schema = z.object({
  kind: z.literal('git_worktree'),
  displayName: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']).optional(),
}).strict();

export type SessionAuthoringCheckoutCreationDraftV1 = z.infer<
  typeof SessionAuthoringCheckoutCreationDraftV1Schema
>;

const SessionAuthoringWindowsTerminalV1Schema = z.object({
  launchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
  console: z.enum(['hidden', 'visible']).optional(),
  windowName: WindowsTerminalWindowNameSchema.optional(),
}).strict();

export const SessionAuthoringTerminalV1Schema = z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  }).strict().optional(),
  windows: SessionAuthoringWindowsTerminalV1Schema.optional(),
}).strict();

export type SessionAuthoringTerminalV1 = z.infer<typeof SessionAuthoringTerminalV1Schema>;
